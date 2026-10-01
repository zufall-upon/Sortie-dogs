import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import type { OperatorState } from "../core/operator-runtime.js";
import { TOOL_ENVIRONMENT } from "../runtime-mission-assets.js";
import { MISSION_REVIEW_REFERENCE, missionReviewScope, type MissionEvidenceExcerpt, type MissionReviewScope, type OperatorMission } from "../core/operator-mission.js";
import { canonicalAgent, type RuntimeProfile } from "../core/runtime-profile.js";
import { taskChildSessionID } from "./task-result-repair.js";
import { normalizeManifestScope } from "../core/path.js";
import { declaredArtifacts } from "./declared-artifacts.js";
import { canonicalDeclaredValidationMembers, normalizeCommand } from "./gate.js";
import { currentSnapshotProtection, refreshProtectedSnapshot, snapshotScratchExclusion, validationInputSnapshot } from "./protected-snapshot.js";
import type { ReviewerCorrectionCheck } from "./runtime-bridge.js";

const exec = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Reviewer-facing evidence preserves execution/coverage; the host retains the full snapshot recipe. */
export function missionReviewValidation(run: OperatorState, statePath: string) {
  return run.units.map(unit => ({
    unit_id: unit.unit.id,
    command: unit.unit.validation,
    evidence: unit.evidence.map(({ protected_binding, ...evidence }) => ({
      ...evidence,
      ...(protected_binding ? { protected_binding_ref: {
        manifest_path: protected_binding.manifest_path,
        manifest_hash: protected_binding.manifest_hash,
        source_policy: protected_binding.source_policy,
      } } : {}),
    })),
    ...(unit.reviewerCorrection ? { correction_checks: (unit.reviewerCorrection.checks ?? []).map(check => ({
      call_id: check.callID, dispatch_call_id: check.dispatchCallID, child_session_id: check.childSessionID,
      command: check.command, exit_code: check.exitCode, started_at: check.startedAt, ended_at: check.endedAt,
      source: check.source, candidate: check.candidate, fresh_when_observed: check.fresh,
      details_ref: { path: statePath, run_id: run.runID, unit_id: unit.unit.id, field: "units[].reviewerCorrection.checks" },
    })) } : {}),
    details_ref: { path: statePath, run_id: run.runID, unit_id: unit.unit.id,
      field: "units[].evidence", omitted: "host snapshot recipe: source/candidate paths and freshness environment" },
  }));
}

/** Show native command outcomes to the Reviewer without turning non-criterion checks into acceptance evidence. */
export function observedMissionValidation(validation: readonly string[], childSessionID: string | null,
  history: readonly Record<string, unknown>[], notBefore?: number): {
    attempts: readonly { command: string; observed_members?: readonly string[]; exit_code: number | null; started_ms: number | null; completed_ms: number | null }[];
    not_observed: readonly string[]; omitted_attempts: number;
  } {
  const declared = validation.map(normalizeCommand);
  const time = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const rawAttempts = childSessionID === null ? [] : history.flatMap(message => {
    if (!record(message.info) || message.info.role !== "assistant" || message.info.sessionID !== childSessionID ||
        !Array.isArray(message.parts)) return [];
    return message.parts.flatMap(part => {
      if (!record(part) || part.type !== "tool" || !["bash", "shell", "powershell", "pwsh"].includes(String(part.tool)) ||
           !record(part.state) || !["completed", "error"].includes(String(part.state.status)) || !record(part.state.input) ||
          typeof part.state.input.command !== "string") return [];
      const command = normalizeCommand(part.state.input.command);
      const exit = record(part.state.metadata) ? part.state.metadata.exit : undefined;
      const started = record(part.time) ? time(part.time.ran) : record(part.state.time) ? time(part.state.time.start) : null;
      const completed = record(part.time) ? time(part.time.completed) : record(part.state.time) ? time(part.state.time.end) : null;
      if (notBefore !== undefined && (started === null || completed === null || started < notBefore || completed < started)) return [];
      return [{ command, exit_code: typeof exit === "number" && Number.isSafeInteger(exit) ? exit : null,
        started_ms: started, completed_ms: completed }];
    });
  });
  let occurrence = 0;
  const attempts = rawAttempts.sort((a, b) => (a.started_ms ?? 0) - (b.started_ms ?? 0) || (a.completed_ms ?? 0) - (b.completed_ms ?? 0)).flatMap(attempt => {
    const members = canonicalDeclaredValidationMembers(attempt.command, declared, occurrence);
    if (!members) return [];
    if (attempt.exit_code !== 0) occurrence = 0;
    else for (const command of members) {
      if (command !== declared[occurrence]) occurrence = 0;
      if (command === declared[occurrence]) occurrence = (occurrence + 1) % declared.length;
    }
    return [{ ...attempt, ...(members.length > 1 ? { observed_members: members } : {}) }];
  });
  // Retain early attempts and the latest checks if a Worker retried many times.
  const shown = attempts.length > 32 ? [...attempts.slice(0, 8), ...attempts.slice(-24)] : attempts;
  return { attempts: shown, not_observed: declared.filter(command => !attempts.some(item => item.command === command || item.observed_members?.includes(command))),
    omitted_attempts: attempts.length - shown.length };
}

/** All inherited checks must have fresh real successful outcomes in this correction admission. */
export function reviewerCorrectionValidation(validation: readonly string[], child: string,
  history: readonly Record<string, unknown>[], notBefore: number, checks?: readonly ReviewerCorrectionCheck[]): {
    ready: boolean; reason?: string; failure?: { command: readonly string[]; outcome: "fail"; exitCode: number | null };
    matched?: readonly { callID: string; member: number; occurrence: number }[];
    nextOccurrence?: number;
  } {
  const declared = validation.map(normalizeCommand);
  if (!Number.isFinite(notBefore)) return { ready: false, reason: "mission-review-correction-validation-admission-unavailable" };
  const attempts: { callID: string; command: string; exit: number | null; started: number; completed: number }[] = [];
  const seen = new Set<string>();
  let editedAt = notBefore;
  // Unlike the display excerpt, this acceptance comparison scans ALL native attempts.
  for (const message of history) {
    if (!record(message.info) || message.info.role !== "assistant" || message.info.sessionID !== child || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (record(part) && part.type === "tool" && ["edit", "write", "patch", "apply_patch"].includes(String(part.tool)) &&
          record(part.state) && part.state.status === "completed") {
        const end = record(part.time) ? part.time.completed : record(part.state.time) ? part.state.time.end : undefined;
        if (typeof end === "number" && Number.isFinite(end) && end >= notBefore) editedAt = Math.max(editedAt, end);
        continue;
      }
      if (!record(part) || part.type !== "tool" || !["bash", "shell", "powershell", "pwsh"].includes(String(part.tool)) ||
          !record(part.state) || !["completed", "error"].includes(String(part.state.status)) ||
          !record(part.state.input) || typeof part.state.input.command !== "string") continue;
      const callID = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : undefined;
      if (!callID || seen.has(callID)) continue;
      const timing = record(part.time) ? { started: part.time.ran, completed: part.time.completed }
        : record(part.state.time) ? { started: part.state.time.start, completed: part.state.time.end } : undefined;
      if (!timing || typeof timing.started !== "number" || typeof timing.completed !== "number" ||
          !Number.isFinite(timing.started) || !Number.isFinite(timing.completed) ||
          timing.started < notBefore || timing.completed < timing.started) continue;
      const rawExit = record(part.state.metadata) ? part.state.metadata.exit : undefined;
      const exit = part.state.status === "completed" && Number.isSafeInteger(rawExit) ? rawExit as number : null;
      seen.add(callID);
      attempts.push({ callID, command: part.state.input.command, exit, started: timing.started, completed: timing.completed });
    }
  }
  const matched: { callID: string; member: number; occurrence: number }[] = [];
  let complete: typeof matched | undefined;
  let previousEnd = notBefore, failed: { command: readonly string[]; outcome: "fail"; exitCode: number | null } | undefined;
  for (const attempt of attempts.sort((a, b) => a.started - b.started || a.completed - b.completed)) {
    if (attempt.started < editedAt) continue;
    const commands = canonicalDeclaredValidationMembers(attempt.command, declared, matched.length % declared.length);
    if (!commands) continue; // Focused diagnostics are not formal proof.
    if (attempt.started < previousEnd) return { ready: false, reason: "mission-review-correction-validation-order:overlap" };
    previousEnd = attempt.completed;
    if (commands[0] !== declared[matched.length] || matched.length === declared.length) matched.length = 0;
    failed = undefined;
    // A failed && chain cannot infer any member success (including commands before its failure).
    if (attempt.exit !== 0) {
      complete = undefined;
      matched.length = 0;
      failed = { command: commands, outcome: "fail", exitCode: attempt.exit };
      continue;
    }
    for (const [member, command] of commands.entries()) {
      if (command !== declared[matched.length]) {
        matched.length = 0;
        if (command !== declared[0]) continue;
      }
      matched.push({ callID: attempt.callID, member, occurrence: matched.length });
      if (matched.length === declared.length) complete = [...matched];
    }
  }
  if (failed) return { ready: false, reason: `mission-review-correction-validation-failed:${failed.command.join(" && ")}`, failure: failed, nextOccurrence: 0 };
  if (!complete) return { ready: false, reason: `mission-review-correction-validation-missing:${declared[matched.length]}`, nextOccurrence: matched.length };
  for (const item of complete) {
    const command = declared[item.occurrence]!;
    const check = checks?.find(check => check.callID === item.callID && check.childSessionID === child);
    if (checks && (!check || !check.fresh || check.exitCode !== 0 || check.command[item.member] !== command ||
        !Number.isFinite(Date.parse(check.startedAt)) || !Number.isFinite(Date.parse(check.endedAt)) ||
        Date.parse(check.startedAt) < notBefore || Date.parse(check.endedAt) < Date.parse(check.startedAt))) {
      return { ready: false, reason: `mission-review-correction-validation-binding-unavailable:${command}` };
    }
  }
  return { ready: true, matched: complete, nextOccurrence: matched.length % declared.length };
}

/** Refresh each actual run's saved recipe; never attach today's snapshot to historical native logs. */
export async function reviewerCorrectionValidationFresh(validation: readonly string[], child: string,
  history: readonly Record<string, unknown>[], notBefore: number, checks: readonly ReviewerCorrectionCheck[], projectRoot: string) {
  const checked = reviewerCorrectionValidation(validation, child, history, notBefore, checks);
  if (!checked.ready) return checked;
  for (const callID of new Set(checked.matched?.map(item => item.callID))) {
    const check = checks.find(item => item.callID === callID)!;
    const current = await refreshProtectedSnapshot(projectRoot, check.binding).catch(() => undefined);
    const fresh = check.generatedInputs !== undefined
      ? current && await validationInputSnapshot(projectRoot, check.binding).catch(() => undefined) === check.generatedInputs
      : current?.source === check.source && current?.candidate === check.candidate;
    if (!fresh) return { ready: false, reason: `mission-review-correction-validation-stale:${check.command.join(" && ")}` };
  }
  return checked;
}

/** Summary-only native reader: unavailable API/error is not a successfully observed empty history. */
export async function observedMissionValidationSummary(validation: readonly string[], childSessionID: string,
  read?: () => Promise<unknown>, notBefore?: number): Promise<Record<string, unknown>> {
  if (!read) throw new Error("native-worker-history-api-unavailable");
  const response = await read();
  if (record(response) && response.error !== undefined && response.error !== null) throw new Error("native-worker-history-api-error");
  const data = record(response) && "data" in response ? response.data : response;
  if (!Array.isArray(data)) throw new Error("native-worker-history-response-not-array");
  const observed = observedMissionValidation(validation, childSessionID, data.filter(record), notBefore);
  const grouped = new Map<string, { command: string; exit_code: number | null; observed_attempts: number;
    latest_started_ms: number | null; latest_completed_ms: number | null }>();
  for (const attempt of observed.attempts) {
    const key = JSON.stringify([attempt.command, attempt.exit_code]);
    const previous = grouped.get(key);
    grouped.set(key, { command: attempt.command, exit_code: attempt.exit_code,
      observed_attempts: (previous?.observed_attempts ?? 0) + 1,
      latest_started_ms: attempt.started_ms, latest_completed_ms: attempt.completed_ms });
  }
  return { commands: [...grouped.values()], not_observed: observed.not_observed,
    omitted_attempts: observed.omitted_attempts,
    details_ref: { method: "session.messages", session_id: childSessionID,
      omitted: "full native tool records and repeated attempts; summary contains only declared commands and observed exits" } };
}

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
  if (!mission || mission.root !== root || ["completed", "cancelled"].includes(mission.phase) ||
      mission.review?.task?.prompt !== requestedPrompt) return [];
  // The completion hook has already bound this prompt to a real independent Reviewer child.
  // Avoid a second V2 history read when its page/list API is temporarily unavailable.
  if (initialMissionReviewPrompt(mission, [])) return [mission.review!.initialPrompt!];
  const owner = mission.coordinator ?? root;
  if (mission.coordinator !== null) {
    const coordinator = await host.get(owner);
    if (!record(coordinator) || coordinator.parentID !== root || canonicalAgent(profile, coordinator.agent as string) !== "dog-operator") return [];
  }
  const prompts: string[] = [];
  for (const message of (await host.messages(owner)).slice(-1000)) {
    if (!record(message.info) || message.info.role !== "assistant" || message.info.sessionID !== owner ||
        !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!record(part) || part.type !== "tool" || part.tool !== "task" || !record(part.state) || part.state.status !== "completed" ||
          !record(part.state.input) || canonicalAgent(profile, part.state.input.subagent_type as string) !== "dog-reviewer" ||
          typeof part.state.input.prompt !== "string" || part.state.input.task_id) continue;
      const childID = taskChildSessionID(part.state);
      if (!childID) continue;
      const child = await host.get(childID);
      if (!record(child) || child.parentID !== owner || canonicalAgent(profile, child.agent as string) !== "dog-reviewer") continue;
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
  evidence: readonly MissionEvidenceExcerpt[] = [], baseline?: string, priorScope?: MissionReviewScope, displayBaseline = baseline): Promise<{
    fingerprint: string; candidateFingerprint: string; excerpt: string; truncatedEvidence: string[]; truncatedSource: string[] }> {
  const scope = missionReviewScope(priorScope, run);
  const bindings = scope.validationBindings ?? [];
  const protection = bindings.some(binding => binding.freshness) ? await currentSnapshotProtection(directory, scope) : [];
  const scratch = bindings.map(binding => ({ binding, excludes: snapshotScratchExclusion(binding, protection) }));
  const excluded = (path: string) => {
    const absolute = resolve(directory, path);
    const covers = (binding: typeof bindings[number]) => [...binding.source_paths, ...binding.candidate_paths].some(root => {
      const rest = relative(resolve(directory, root), absolute);
      return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
    });
    return scratch.some(item => item.excludes(absolute)) &&
      !scratch.some(item => covers(item.binding) && !item.excludes(absolute));
  };
  const hash = createHash("sha256").update(JSON.stringify({ baseline,
    scope: bindings.length ? { read: scope.read } : scope,
    units: run.units.map(unit => bindings.length ? { id: unit.unit.id, read: unit.unit.read, validation: unit.unit.validation,
      acceptance: unit.unit.acceptance_indices } : { unit: unit.unit, hashes: unit.hashes }) }));
  const candidateHash = hash.copy(); // Optional excerpt selection is presentation, not candidate bytes.
  const sourceUpdate = (value: string | Buffer) => { hash.update(value); candidateHash.update(value); };
  const writes = [...new Set(scope.write.map(path => path === "." ? path : normalizeManifestScope(path).path))];
  const focused: { entry: MissionEvidenceExcerpt; lines: string[]; bytes: number; lineCapped: boolean }[] = [];
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
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 1 || !Number.isSafeInteger(entry.limit) || entry.limit < 1) {
      throw fail("use a positive safe-integer line offset and limit");
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
          if (number >= entry.offset && number - entry.offset < Math.min(entry.limit, 200)) {
            const text = `${number}: ${line.slice(0, 2_000)}\n`;
            excerpt.push(text);
            bytes += Buffer.byteLength(text);
          }
        }
      } finally { lines.close(); stream.destroy(); }
      if (entry.offset > number) throw new Error(`offset ${entry.offset} exceeds ${number} lines; select existing lines`);
      focused.push({ entry, lines: excerpt, bytes, lineCapped: entry.limit > 200 && number - entry.offset >= 200 });
    } catch (error) {
      throw fail(error instanceof Error ? error.message : String(error));
    }
  }
  // Keep room for the baseline diff. Reserve notices only after the allocated whole lines show
  // truncation; pre-reserving every possible notice can hide all six otherwise fitting references.
  const heading = (entry: MissionEvidenceExcerpt) => `\n--- evidence: ${entry.path}:${entry.offset} ---\n`;
  const truncated = (entry: MissionEvidenceExcerpt) => `[FOCUSED EXCERPT TRUNCATED: ${entry.path}:${entry.offset}; Reviewer can read the remaining lines directly]\n`;
  // Read-only reviews retain their smaller existing envelope; code reviews may use the space
  // previously reserved for automatic diff prefixes, while leaving room for changed-file context.
  const limit = writes.length ? 18_000 : 11_000;
  const headings = focused.reduce((size, { entry }) => size + Buffer.byteLength(heading(entry)), 0);
  const needsNotice = focused.map(({ lineCapped }) => lineCapped);
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
  const truncatedEvidence = focused.flatMap(({ entry }, index) => needsNotice[index] ? [`${entry.path}:${entry.offset}`] : []);
  if (writes.length === 0) return { fingerprint: `sha256:${hash.digest("hex")}`, candidateFingerprint: `sha256:${candidateHash.digest("hex")}`,
    excerpt: selected + "[Read-only units: no declared output files. Review the supplied observations, traces and validation evidence.]",
    truncatedEvidence, truncatedSource: [] };
  // The shared dependency environment is local tooling, never reviewed or pinned source.
  const external: string[] = [], local: string[] = [];
  for (const path of writes) {
    const scoped = relative(directory, resolve(directory, path)).replaceAll("\\", "/");
    if (scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) external.push(resolve(path));
    else local.push(scoped || ".");
  }
  const toolInput = scope.read.some(path => normalizeManifestScope(path).path.startsWith(TOOL_ENVIRONMENT));
  const scopes = [...local, ...(toolInput ? [] : [`:(exclude)${TOOL_ENVIRONMENT}`])];
  const git = async (args: string[]) => (await exec("git", args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const names = local.length ? await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes]) : "";
  const untracked = new Set((local.length ? await git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...scopes]) : "").split("\0").filter(Boolean));
  // Go's ignored in-project caches may be writable during validation but are not candidate
  // output. Keep every other ignored declared output visible and fingerprinted, including
  // directories of generated artifacts; focused references can still pin a cache file.
  const ignored = local.length ? await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...scopes]) : "";
  for (const path of ignored.split("\0").filter(Boolean)) untracked.add(path);
  const omitted: string[] = [];
  const unreadable: string[] = [];
  let diff = "";
  if (local.length && displayBaseline) {
    // HEAD-only diffs are empty once the author commits. Display the original mission delta
    // or the focused correction delta without changing the full fingerprint basis.
    const changed = (await git(["diff", "--name-only", "-z", "--no-ext-diff", displayBaseline, "--", ...scopes]))
      .split("\0").filter(path => path && !excluded(path));
    const shown = changed.slice(0, 16);
    const heading = changed.length ? `Changed since ${displayBaseline === baseline ? "mission" : "correction"} baseline (${displayBaseline}; ${changed.length} paths):\n` : "";
    const headers = shown.map(path => `\n--- changed: ${path} ---\n`);
    const available = Math.max(0, 24_000 - Buffer.byteLength(selected + heading) -
      headers.reduce((size, title) => size + Buffer.byteLength(title), 0) - 500);
    const allowance = shown.length ? Math.min(3_000, Math.floor(available / shown.length)) : 0;
    diff = heading;
    for (const [index, path] of shown.entries()) {
      const patch = await git(["diff", "--no-ext-diff", "--no-textconv", displayBaseline, "--", path]);
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
  const visited = new Set<string>();
  const visit = async (path: string, includedByParent = false): Promise<void> => {
    if (excluded(path)) return;
    if (visited.has(path)) return;
    visited.add(path);
    sourceUpdate(JSON.stringify(path));
    try {
      const absolute = resolve(directory, path), stat = await lstat(absolute);
      sourceUpdate(String(stat.mode));
      const include = includedByParent || untracked.has(path) || unchanged;
      const heading = `\n--- ${includedByParent || untracked.has(path) ? "new file" : "current file"}: ${path} ---\n`;
      const room = include ? Math.max(0, 24_000 - Buffer.byteLength(excerpt) - Buffer.byteLength(heading)) : 0;
      let preview = Buffer.alloc(0);
      if (stat.isSymbolicLink()) {
        const content = Buffer.from(await readlink(absolute));
        sourceUpdate(String(content.length)); sourceUpdate(content);
        preview = content.subarray(0, room);
      } else if (stat.isDirectory()) {
        sourceUpdate("directory");
        if (include) {
          const marker = "[directory; contained artifacts follow]\n";
          const headingFits = Buffer.byteLength(excerpt) + Buffer.byteLength(heading) + Buffer.byteLength(marker) <= 24_000;
          if (headingFits) excerpt += heading + marker;
          else omitted.push(path);
        }
        // Nested repository metadata is not candidate output and can crowd out its actual files.
        const children = (await readdir(absolute, { withFileTypes: true }))
          .filter(child => child.name !== ".git")
          .sort((left, right) => Number(left.isDirectory()) - Number(right.isDirectory()) ||
            (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        for (const child of children) {
          await visit(join(path, child.name).replaceAll("\\", "/"), include);
        }
      } else {
        if (!stat.isFile()) throw new Error("mission-review-source: unsupported artifact type");
        sourceUpdate(String(stat.size));
        for await (const part of createReadStream(absolute)) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
          sourceUpdate(bytes);
          if (preview.length < room) preview = Buffer.concat([preview, bytes.subarray(0, room - preview.length)]);
        }
      }
      if (include && !stat.isDirectory()) {
        const headingFits = Buffer.byteLength(excerpt) + Buffer.byteLength(heading) <= 24_000;
        if (headingFits) {
          const rendered = preview.includes(0) ? "[binary artifact: bytes fingerprinted]" : preview.toString("utf8");
          let shown = rendered;
          if (Buffer.byteLength(rendered) > room) {
            let used = 0;
            const chars: string[] = [];
            for (const char of rendered) {
              const bytes = Buffer.byteLength(char);
              if (used + bytes > room) break;
              chars.push(char);
              used += bytes;
            }
            shown = chars.join("");
          }
          excerpt += heading + shown;
          if (stat.size > room || Buffer.byteLength(rendered) > room) omitted.push(path);
        } else omitted.push(path);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; sourceUpdate("deleted"); }
  };
  for (const path of paths) await visit(path);
  if (external.length) {
    // A declared write scope can also be a host-managed runtime directory (e.g. Docker's data root).
    // Do not make review depend on listing it; record the missing coverage instead. Protected
    // validation still requires readable outputs and does not use this review-only option.
    const artifacts = await declaredArtifacts(external, Math.max(1, 24_000 - Buffer.byteLength(excerpt)),
      { reportUnreadableDirectories: true });
    sourceUpdate(JSON.stringify(artifacts.entries));
    excerpt += artifacts.excerpt;
    if (artifacts.truncated) omitted.push("external artifacts");
    unreadable.push(...artifacts.unreadable);
  }
  const bytes = Buffer.from(excerpt);
  const truncatedSource = [...new Set(omitted)];
  if (bytes.length > 24_000 && truncatedSource.length === 0) truncatedSource.push("(source diff exceeds excerpt budget)");
  return { fingerprint: `sha256:${hash.digest("hex")}`, candidateFingerprint: `sha256:${candidateHash.digest("hex")}`, excerpt: (bytes.length > 24_000 ? bytes.subarray(0, 24_000).toString("utf8") : excerpt) +
    (truncatedSource.length ? `\n[EXCERPT TRUNCATED: ${truncatedSource.slice(0, 20).join(", ")}; Reviewer can read/search the relevant source directly]` : "") +
    (unreadable.length ? `\n[UNINSPECTED EXTERNAL DIRECTORIES: ${unreadable.slice(0, 20).join(", ")}; select specific result files as review evidence]` : ""),
    truncatedEvidence, truncatedSource };
}
