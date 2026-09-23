/** Host observations, not model-authored completion claims. */
export interface WorkActivity {
  id: string; tool: string; detail: string; startedAt: number;
}
export interface WorkProgress {
  startedAt: number; lastActionAt: number; inspections: number; tools: number;
  commands: number; edits: number; active: WorkActivity[];
  last?: WorkActivity & { status: string; exit: number | null };
  stopped?: { at: number; reason: string };
}
export const WORK_PROGRESS_LIMITS = { idleMs: 180_000, inspections: 12, intervalMs: 5_000 } as const;
export const isWorkAction = (tool: string) => ["shell", "patch", "sortie_v011_check"].includes(tool);
export function newWorkProgress(now = Date.now()): WorkProgress {
  return { startedAt: now, lastActionAt: now, inspections: 0, tools: 0, commands: 0, edits: 0, active: [] };
}
export function progressLimit(progress: WorkProgress, now: number, idleMs: number, inspections: number): string | null {
  // A running command/test has its native deadline; it is not model planning time.
  if (progress.active.some(item => isWorkAction(item.tool))) return null;
  if (progress.inspections >= inspections) return `discovery-limit: ${progress.inspections} inspection calls without an executable step`;
  if (now - progress.lastActionAt >= idleMs) return `planning-timeout: no executable step for ${Math.floor((now - progress.lastActionAt) / 1000)}s`;
  return null;
}
export function progressView(progress: WorkProgress, now = Date.now()) {
  const active = progress.active.at(-1);
  const phase = progress.stopped ? "blocked" : active ? isWorkAction(active.tool) ? "executing" : "inspecting" : "thinking";
  return { ...progress, phase, elapsed_ms: Math.max(0, now - progress.startedAt),
    idle_ms: Math.max(0, now - progress.lastActionAt),
    summary: progress.stopped?.reason ?? (active ? `${active.tool}: ${active.detail}` :
      progress.last ? `Last ${progress.last.tool}: ${progress.last.status}${progress.last.exit === null ? "" : ` (exit ${progress.last.exit})`}; awaiting next action` : "Waiting for first executable step"),
    note: "Tool activity is not task completion. Command starts, edits and checks are observed separately; no benchmark score is inferred." };
}

type RecordValue = Record<string, any>;
/** Repair only the outgoing context, including the trailing interrupted turn that native normalization misses.
 * Persisted history/check receipts are never edited and a missing result is always an error, never success.
 */
export function repairWorkToolHistory(messages: RecordValue[]): { messages: RecordValue[]; repaired: string[] } {
  const result: RecordValue[] = [], pending = new Map<string, RecordValue>(), repaired: string[] = [];
  const flush = () => {
    if (!pending.size) return;
    result.push({ role: "tool", content: [...pending.values()].map(call => {
      repaired.push(call.id);
      return { type: "tool-result", id: call.id, name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}),
        result: { type: "error", value: "Native tool result unavailable after interruption. Execution/success is unverified. Inspect existing files and owned processes before retrying; do not duplicate a running job." } };
    }) });
    pending.clear();
  };
  for (const message of messages) {
    if (["assistant", "user"].includes(message.role)) flush();
    result.push(message);
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.providerExecuted === true) continue;
      if (message.role === "assistant" && part.type === "tool-call" && typeof part.id === "string") pending.set(part.id, part);
      if (message.role === "tool" && part.type === "tool-result") pending.delete(part.id);
    }
  }
  flush();
  return { messages: repaired.length ? result : messages, repaired };
}
