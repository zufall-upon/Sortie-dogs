import { createHash } from "node:crypto";

type ModelObject = Record<string, unknown>;
const object = (value: unknown): value is ModelObject => value !== null && typeof value === "object" && !Array.isArray(value);

// Only Sortie's own generated elements are classified here, not the native system
// prompt or retrieved/user/tool text. Keep policy and role instructions in front;
// counters, findings and lifecycle changes should not invalidate all prior reads.
const headings = new Set([
  "SORTIE_GOAL_BOUND_STATE", "SORTIE_ACCEPTANCE_CONTINUITY_STATE", "SORTIE_PARALLEL_DISPATCH_STATE",
  "SORTIE_REVIEWER_CONTINUOUS_CONTEXT", "SORTIE_WORKER_CONTEXT", "SORTIE_FAST_LANE_TERMINAL",
]);
const prefixes = ["Native tools actually available in this request: ",
  "Confirmed launch conditions (fixed caps, not remaining Worker/campaign budget): "];
const blockName = (text: string): string | undefined => {
  const heading = text.split("\n", 1)[0]!;
  return headings.has(heading) ? heading : prefixes.find(prefix => text.startsWith(prefix));
};
const projected = new WeakSet<object>();

export interface ModelLiveStateHistory {
  version: 1;
  native: string[];
  blocks: Record<string, string[]>;
  updates: { after: number; text: string[] }[];
}

function retained(value: unknown): value is ModelLiveStateHistory {
  return object(value) && value.version === 1 && Array.isArray(value.native) && value.native.every(hash => typeof hash === "string") &&
    object(value.blocks) && Object.values(value.blocks).every(texts => Array.isArray(texts) && texts.every(text => typeof text === "string")) &&
    Array.isArray(value.updates) && value.updates.every((update, index, updates) => object(update) &&
      Number.isSafeInteger(update.after) && Number(update.after) >= 0 && Number(update.after) <= (value.native as unknown[]).length &&
      (index === 0 || Number(update.after) >= Number(updates[index - 1].after)) &&
      Array.isArray(update.text) && update.text.every(text => typeof text === "string"));
}

/** Reinsert already sent state at native boundaries; append changed blocks, never persist fake native messages. */
export function modelLiveState(system: readonly string[], messages?: readonly unknown[], saved?: unknown): {
  system: string[]; messages?: unknown[]; history?: ModelLiveStateHistory;
} {
  // Compatibility callers with no transcript still receive every state field.
  if (messages === undefined) return { system: [...system] };
  const stable: string[] = [], blocks: Record<string, string[]> = {};
  for (const text of system) {
    const name = blockName(text);
    if (name === undefined) stable.push(text); else (blocks[name] ??= []).push(text);
  }
  const native = messages.filter(message => !object(message) || !projected.has(message));
  const hashes = native.map(message => createHash("sha256").update(JSON.stringify(message) ?? "undefined").digest("hex"));
  // Compaction, edited native history or a missing/malformed ledger starts from
  // complete CURRENT durable host state. Old projection is not review/test proof.
  const prior: ModelLiveStateHistory = retained(saved) && saved.native.length <= hashes.length &&
    saved.native.every((hash, index) => hashes[index] === hash) ? saved : { version: 1, native: [], blocks: {}, updates: [] };
  const changed = Object.entries(blocks).filter(([name, text]) => JSON.stringify(prior.blocks[name]) !== JSON.stringify(text)).flatMap(([, text]) => text);
  const withdrawn = Object.keys(prior.blocks).filter(name => !Object.hasOwn(blocks, name));
  if (withdrawn.length) changed.push(`SORTIE_LIVE_STATE_WITHDRAWN\n${JSON.stringify(withdrawn)}`);
  const history: ModelLiveStateHistory = { version: 1, native: hashes, blocks,
    updates: [...prior.updates, ...(changed.length ? [{ after: native.length, text: changed }] : [])] };
  const output: unknown[] = [];
  let cursor = 0;
  for (let index = 0; index <= native.length; index++) {
    while (history.updates[cursor]?.after === index) {
      // V2 lowers role=system to chronological developer input, not absolute instructions.
      const update = { role: "system", content: history.updates[cursor++]!.text.map(text => ({ type: "text", text })),
        metadata: { "sortie-dogs/live-state": "request-only" } };
      projected.add(update);
      output.push(update);
    }
    if (index < native.length) output.push(native[index]);
  }
  return { system: stable, messages: output, history };
}
