type ModelObject = Record<string, unknown>;
const object = (value: unknown): value is ModelObject => value !== null && typeof value === "object" && !Array.isArray(value);

// Only Sortie's own generated elements are classified here, not the native system
// prompt or retrieved/user/tool text. Keep policy and role instructions in front;
// counters, findings and lifecycle changes should not invalidate all prior reads.
const headings = new Set([
  "SORTIE_GOAL_BOUND_STATE", "SORTIE_ACCEPTANCE_CONTINUITY_STATE", "SORTIE_PARALLEL_DISPATCH_STATE",
  "SORTIE_REVIEWER_CONTINUOUS_CONTEXT", "SORTIE_WORKER_CONTEXT", "SORTIE_FAST_LANE_TERMINAL",
]);
const volatile = (text: string) => headings.has(text.split("\n", 1)[0]!) ||
  text.startsWith("Native tools actually available in this request: ") ||
  text.startsWith("Confirmed launch conditions (fixed caps, not remaining Worker/campaign budget): ");
const projected = new WeakSet<object>();

/** Request-only chronological system update; never persists a new prompt or edits native history. */
export function modelLiveState(system: readonly string[], messages?: readonly unknown[]): {
  system: string[]; messages?: unknown[];
} {
  // Compatibility callers with no transcript still receive every state field.
  if (messages === undefined) return { system: [...system] };
  const stable: string[] = [], live: string[] = [];
  for (const text of system) (volatile(text) ? live : stable).push(text);
  const history = messages.filter(message => !object(message) || !projected.has(message));
  if (live.length > 0) {
    // V2's LLM.Message role=system preserves this chronological position. OpenAI
    // Responses lowers it to a developer input item, not absolute `instructions`.
    const update = { role: "system", content: live.map(text => ({ type: "text", text })),
      metadata: { "sortie-dogs/live-state": "request-only" } };
    projected.add(update);
    history.push(update);
  }
  return { system: stable, messages: history };
}
