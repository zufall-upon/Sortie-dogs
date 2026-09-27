import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import type { OperatorState } from "../core/operator-runtime.js";
import { TOOL_ENVIRONMENT } from "../runtime-mission-assets.js";
import { MISSION_REVIEW_REFERENCE, missionReviewScope, type MissionEvidenceExcerpt, type MissionReviewScope, type OperatorMission } from "../core/operator-mission.js";
import { canonicalAgent, type RuntimeProfile } from "../core/runtime-profile.js";
import { taskChildSessionID } from "./task-result-repair.js";
import { normalizeManifestScope } from "../core/path.js";
import { declaredArtifacts } from "./declared-artifacts.js";

const exec = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Use the space left by short references for longer requested branches, without starving later references. */
function focusedAllowances(sizes: readonly number[], budget: number): number[] {
  const allowances = sizes.map(() => 0);
  let remaining = budget;
  let pending = sizes.map((_, index) => index);
  while (pending.length && remaining > 0) {
    const share = Math.floor(remaining / pending.length);
    const complete = pending.filter(index => sizes[index]! <= share);
    if (!complete.length) {
      for (const index of pending) allowances[index] = share;
      for (const index of pending.slice(0, remaining - share * pending.length)) allowances[index]!++;
      break;
    }
    for (const index of complete) { allowances[index] = sizes[index]!; remaining -= sizes[index]!; }
    pending = pending.filter(index => !complete.includes(index));
  }
  return allowances;
}

function visibleLineCount(lines: readonly string[], allowance: number): number {
  let bytes = 0, count = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line);
    if (bytes + size > allowance) break;
    bytes += size;
    count++;
  }
  return count;
}

export async function missionReviewBaseline(directory: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: directory });
    const oid = stdout.trim();
    return /^[a-f0-9]{40,64}$/u.test(oid) ? oid : undefined;
  } catch { return undefined; } // A mission can start before Git is initialized.
}

/** A child ID alone cannot establish the initial phase after a restart or failed dispatch. */
export function initialMissionReviewPrompt(mission: OperatorMission, prompts: readonly string[]): string | undefined {
  return [mission.review?.initialPrompt, ...prompts].find(prompt => typeof prompt === "string" &&
    prompt.startsWith(`candidate_id: ${mission.id}\n`) && /^review_phase: initial$/mu.test(prompt) &&
    /^canonical_validation_exit: 0$/mu.test(prompt));
}

/** Recover from native completion records, never from the pending review's inherited child ID. */
export async function completedMissionReviewPrompts(mission: OperatorMission | undefined, profile: RuntimeProfile,
  root: string, requestedPrompt: string,
  host: { get(id: string): Promise<unknown>; messages(id: string): Promise<readonly Record<string, unknown>[]> },
): Promise<string[]> {
  if (!mission || mission.root !== root || !mission.coordinator || ["completed", "cancelled"].includes(mission.phase) ||
      mission.review?.task?.prompt !== requestedPrompt) return [];
  // The completion hook has already bound this prompt to a real independent Reviewer child.
  // Avoid a second V2 history read when its page/list API is temporarily unavailable.
  if (initialMissionReviewPrompt(mission, [])) return [mission.review!.initialPrompt!];
  const coordinator = await host.get(mission.coordinator);
  if (!record(coordinator) || coordinator.parentID !== root || canonicalAgent(profile, coordinator.agent as string) !== "dog-operator") return [];
  const prompts: string[] = [];
  for (const message of (await host.messages(mission.coordinator)).slice(-1000)) {
    if (!record(message.info) || message.info.role !== "assistant" || message.info.sessionID !== mission.coordinator ||
        !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!record(part) || part.type !== "tool" || part.tool !== "task" || !record(part.state) || part.state.status !== "completed" ||
          !record(part.state.input) || canonicalAgent(profile, part.state.input.subagent_type as string) !== "dog-reviewer" ||
          typeof part.state.input.prompt !== "string" || part.state.input.task_id) continue;
      const childID = taskChildSessionID(part.state);
      if (!childID) continue;
      const child = await host.get(childID);
      if (!record(child) || child.parentID !== mission.coordinator || canonicalAgent(profile, child.agent as string) !== "dog-reviewer") continue;
      let prompt = part.state.input.prompt;
      if (prompt.startsWith(MISSION_REVIEW_REFERENCE)) {
        let ref: unknown;
        try { ref = JSON.parse(prompt.slice(MISSION_REVIEW_REFERENCE.length)); } catch { continue; }
        if (!record(ref) || ref.r !== root || ref.m !== mission.id || typeof ref.n !== "string" ||
            typeof ref.h !== "string" || !/^[a-f0-9]{64}$/u.test(ref.h)) continue;
        // Some hosts retain the opaque Task input. Resolve only its exact hash-bound child prompt;
        // a native subagent preamble may precede the host-generated candidate header.
        const matches = (await host.messages(childID)).flatMap(message => {
          if (!record(message.info) || message.info.role !== "user" || message.info.sessionID !== childID || !Array.isArray(message.parts)) return [];
          return message.parts.filter(record).flatMap(part => {
            if (part.type !== "text" || part.synthetic === true || typeof part.text !== "string") return [];
            const start = part.text.indexOf(`candidate_id: ${mission.id}\n`);
            if (start < 0 || (start > 0 && part.text[start - 1] !== "\n")) return [];
            const text = part.text.slice(start);
            return createHash("sha256").update(text).digest("hex") === ref.h ? [text] : [];
          });
        });
        if (new Set(matches).size !== 1) continue;
        prompt = matches[0]!;
      }
      const candidates = [...prompt.matchAll(/^candidate_id: (.+)$/gmu)];
      if (candidates.length === 1 && candidates[0]![1] === mission.id) prompts.push(prompt);
    }
  }
  return prompts;
}

/** Pin all scoped tracked/untracked source bytes, including deletions; display a bounded excerpt only. */
export async function missionReviewSource(directory: string, run: OperatorState,
  evidence: readonly MissionEvidenceExcerpt[] = [], baseline?: string, priorScope?: MissionReviewScope): Promise<{ fingerprint: string; excerpt: string }> {
  const scope = missionReviewScope(priorScope, run);
  const hash = createHash("sha256").update(JSON.stringify({ baseline, scope, units: run.units.map(unit => ({ unit: unit.unit, hashes: unit.hashes })) }));
  const writes = [...new Set(scope.write.map(path => path === "." ? path : normalizeManifestScope(path).path))];
  const focused: { entry: MissionEvidenceExcerpt; lines: string[]; bytes: number }[] = [];
  for (const entry of evidence) {
    const absolute = resolve(directory, entry.path);
    const local = relative(resolve(directory), absolute);
    // Review references are read-only context, not new execution/validation inputs.
    // Keep the declared external-artifact route across narrower replans as well.
    const allowed = (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)) ||
      [...scope.read, ...scope.write].some(path => {
        const root = resolve(directory, path === "." ? path : normalizeManifestScope(path).path), rest = relative(root, absolute);
        return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
      });
    const fail = (reason: string) => new Error(`mission-review-evidence: ${entry.path}: ${reason}`);
    if (!allowed) throw fail("outside the project and declared inputs/outputs; select a project file or an existing declared input/output");
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 1 || !Number.isSafeInteger(entry.limit) || entry.limit < 1 || entry.limit > 200) {
      throw fail("use a positive line offset and a limit between 1 and 200");
    }
    try {
      const info = await lstat(absolute);
      if (!info.isFile()) throw new Error("select a regular file");
      hash.update(JSON.stringify(entry)).update(String(info.size));
      const stream = createReadStream(absolute);
      stream.on("data", chunk => hash.update(chunk));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      stream.on("error", error => lines.emit("error", error));
      const excerpt: string[] = [];
      let number = 0, bytes = 0;
      try {
        for await (const line of lines) {
          number++;
          if (number >= entry.offset && number < entry.offset + entry.limit) {
            const text = `${number}: ${line.slice(0, 2_000)}\n`;
            excerpt.push(text);
            bytes += Buffer.byteLength(text);
          }
        }
      } finally { lines.close(); stream.destroy(); }
      if (entry.offset > number) throw new Error(`offset ${entry.offset} exceeds ${number} lines; select existing lines`);
      focused.push({ entry, lines: excerpt, bytes });
    } catch (error) {
      throw fail(error instanceof Error ? error.message : String(error));
    }
  }
  // Keep room for the baseline diff. Reserve notices only after the allocated whole lines show
  // truncation; pre-reserving every possible notice can hide all six otherwise fitting references.
  const heading = (entry: MissionEvidenceExcerpt) => `\n--- evidence: ${entry.path}:${entry.offset} ---\n`;
  const truncated = (entry: MissionEvidenceExcerpt) => `[FOCUSED EXCERPT TRUNCATED: ${entry.path}:${entry.offset}; request a smaller range]\n`;
  // Read-only reviews retain their smaller existing envelope; code reviews may use the space
  // previously reserved for automatic diff prefixes, while leaving room for changed-file context.
  const limit = writes.length ? 18_000 : 11_000;
  const headings = focused.reduce((size, { entry }) => size + Buffer.byteLength(heading(entry)), 0);
  const needsNotice = focused.map(() => false);
  let allowances: number[];
  while (true) {
    const notices = focused.reduce((size, { entry }, index) =>
      size + (needsNotice[index] ? Buffer.byteLength(truncated(entry)) : 0), 0);
    allowances = focusedAllowances(focused.map(item => item.bytes), Math.max(0, limit - headings - notices));
    let changed = false;
    for (const [index, item] of focused.entries()) {
      if (!needsNotice[index] && visibleLineCount(item.lines, allowances[index]!) < item.lines.length) {
        needsNotice[index] = true;
        changed = true;
      }
    }
    if (!changed) break;
  }
  let selected = "";
  for (const [index, item] of focused.entries()) {
    selected += heading(item.entry);
    selected += item.lines.slice(0, visibleLineCount(item.lines, allowances[index]!)).join("");
    if (needsNotice[index]) selected += truncated(item.entry);
  }
  if (writes.length === 0) return { fingerprint: `sha256:${hash.digest("hex")}`,
    excerpt: selected + "[Read-only units: no declared output files. Review the supplied observations, traces and validation evidence.]" };
  // The shared dependency environment is local tooling, never reviewed or pinned source.
  const external: string[] = [], local: string[] = [];
  for (const path of writes) {
    const scoped = relative(directory, resolve(directory, path)).replaceAll("\\", "/");
    if (scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) external.push(resolve(path));
    else local.push(scoped || ".");
  }
  const scopes = [...local, `:(exclude)${TOOL_ENVIRONMENT}`];
  const git = async (args: string[]) => (await exec("git", args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const names = local.length ? await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes]) : "";
  const untracked = new Set((local.length ? await git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...scopes]) : "").split("\0").filter(Boolean));
  // Explicitly declared outputs are review evidence even when gitignored (for example a probe
  // JSON in _testenv). Their bytes must participate in staleness checks as well as the excerpt.
  const ignored = local.length ? await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...scopes]) : "";
  for (const path of ignored.split("\0").filter(Boolean)) untracked.add(path);
  const omitted: string[] = [];
  let diff = "";
  if (local.length && baseline) {
    // HEAD-only diffs are empty once the Worker commits. Show bounded changes from the
    // mission's original HEAD across all replans, not arbitrary alphabetical repository files.
    const changed = (await git(["diff", "--name-only", "-z", "--no-ext-diff", baseline, "--", ...scopes]))
      .split("\0").filter(Boolean);
    const shown = changed.slice(0, 16);
    const heading = changed.length ? `Changed since mission baseline (${baseline}; ${changed.length} paths):\n` : "";
    const headers = shown.map(path => `\n--- changed: ${path} ---\n`);
    const available = Math.max(0, 24_000 - Buffer.byteLength(selected + heading) -
      headers.reduce((size, title) => size + Buffer.byteLength(title), 0) - 500);
    const allowance = shown.length ? Math.min(3_000, Math.floor(available / shown.length)) : 0;
    diff = heading;
    for (const [index, path] of shown.entries()) {
      const patch = await git(["diff", "--no-ext-diff", "--no-textconv", baseline, "--", path]);
      const bytes = Buffer.from(patch);
      if (allowance <= 0) { omitted.push(path); continue; }
      diff += `${headers[index]}${bytes.subarray(0, allowance).toString("utf8")}`;
      if (bytes.length > allowance) omitted.push(path);
    }
    omitted.push(...changed.slice(shown.length));
  } else if (local.length) {
    diff = await git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...scopes])
      .catch(() => git(["diff", "--no-ext-diff", "--no-textconv", "--", ...scopes]));
  }
  const unchanged = diff.length === 0;
  let excerpt = selected + diff;
  const paths = [...new Set([...names.split("\0"), ...ignored.split("\0")].filter(Boolean))].sort();
  for (const path of paths) {
    hash.update(JSON.stringify(path));
    try {
      const absolute = resolve(directory, path), stat = await lstat(absolute);
      hash.update(String(stat.mode));
      const include = untracked.has(path) || unchanged;
      const room = include ? Math.max(0, 24_000 - Buffer.byteLength(excerpt)) : 0;
      let preview = Buffer.alloc(0);
      if (stat.isSymbolicLink()) {
        const content = Buffer.from(await readlink(absolute));
        hash.update(String(content.length)).update(content);
        preview = content.subarray(0, room);
      } else {
        hash.update(String(stat.size));
        for await (const part of createReadStream(absolute)) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
          hash.update(bytes);
          if (preview.length < room) preview = Buffer.concat([preview, bytes.subarray(0, room - preview.length)]);
        }
      }
      if (include) {
        if (room) excerpt += `\n--- ${untracked.has(path) ? "new file" : "current file"}: ${path} ---\n${preview.includes(0) ? "[binary artifact: bytes fingerprinted]" : preview.toString("utf8")}`;
        if (stat.size > room) omitted.push(path);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("deleted"); }
  }
  if (external.length) {
    const artifacts = await declaredArtifacts(external, Math.max(1, 24_000 - Buffer.byteLength(excerpt)));
    hash.update(JSON.stringify(artifacts.entries));
    excerpt += artifacts.excerpt;
    if (artifacts.truncated) omitted.push("external artifacts");
  }
  const bytes = Buffer.from(excerpt);
  return { fingerprint: `sha256:${hash.digest("hex")}`, excerpt: (bytes.length > 24_000 ? bytes.subarray(0, 24_000).toString("utf8") : excerpt) +
    (bytes.length > 24_000 || omitted.length ? `\n[EXCERPT TRUNCATED: ${omitted.slice(0, 20).join(", ")}; supply focused traces for missing sections, not another implementation unit]` : "") };
}
