import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { OperatorState } from "../core/operator-runtime.js";
import { TOOL_ENVIRONMENT } from "../runtime-mission-assets.js";
import { MISSION_REVIEW_REFERENCE, type OperatorMission } from "../core/operator-mission.js";
import { canonicalAgent, type RuntimeProfile } from "../core/runtime-profile.js";
import { taskChildSessionID } from "./task-result-repair.js";

const exec = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Recover from native completion records, never from the pending review's inherited child ID. */
export async function completedMissionReviewPrompts(mission: OperatorMission | undefined, profile: RuntimeProfile,
  root: string, requestedPrompt: string,
  host: { get(id: string): Promise<unknown>; messages(id: string): Promise<readonly Record<string, unknown>[]> },
): Promise<string[]> {
  if (!mission || mission.root !== root || !mission.coordinator || ["completed", "cancelled"].includes(mission.phase) ||
      mission.review?.task?.prompt !== requestedPrompt) return [];
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
export async function missionReviewSource(directory: string, run: OperatorState): Promise<{ fingerprint: string; excerpt: string }> {
  // The shared dependency environment is local tooling, never reviewed or pinned source.
  const scopes = [...new Set(run.units.flatMap(unit => unit.unit.write)), `:(exclude)${TOOL_ENVIRONMENT}`];
  const git = async (args: string[]) => (await exec("git", args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const names = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes]);
  const untracked = new Set((await git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...scopes])).split("\0").filter(Boolean));
  const hash = createHash("sha256").update(JSON.stringify(run.units.map(unit => ({ unit: unit.unit, hashes: unit.hashes }))));
  let excerpt = await git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...scopes]).catch(() => git(["diff", "--no-ext-diff", "--no-textconv", "--", ...scopes]));
  for (const path of [...new Set(names.split("\0").filter(Boolean))].sort()) {
    hash.update(JSON.stringify(path));
    try {
      const absolute = resolve(directory, path), stat = await lstat(absolute);
      hash.update(String(stat.mode));
      const content = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
      hash.update(String(content.length)).update(content);
      if (untracked.has(path) && Buffer.byteLength(excerpt) < 24_000) excerpt += `\n--- new file: ${path} ---\n${content.toString("utf8")}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("deleted"); }
  }
  const bytes = Buffer.from(excerpt);
  return { fingerprint: `sha256:${hash.digest("hex")}`, excerpt: bytes.length > 24_000
    ? `${bytes.subarray(0, 24_000).toString("utf8")}\n[EXCERPT TRUNCATED: report missing evidence; do not infer PASS]` : excerpt };
}
