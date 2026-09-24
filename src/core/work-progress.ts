/** Host observations, not model-authored completion claims. */
export interface WorkActivity {
  id: string; tool: string; detail: string; startedAt: number; actor?: string;
}
export interface WorkEvidence {
  id: string; kind: "command" | "check" | "diff"; at: number; tools: number; detail: string;
}
export interface WorkIntervention {
  id: string; at: number; reason: string; resumedAt?: number; resolvedAt?: number; evidence?: string[];
}
export interface WorkProgress {
  startedAt: number; lastActionAt: number; inspections: number; tools: number;
  commands: number; edits: number; active: WorkActivity[];
  last?: WorkActivity & { status: string; exit: number | null };
  stopped?: { at: number; reason: string };
  reviewedAt?: number; reviewedTools?: number; nextInterventionAt?: number;
  operatorNudgedAt?: number;
  evidence?: WorkEvidence[]; interventions?: WorkIntervention[];
  firstActionAt?: number; lastWorkActionAt?: number; nudges?: { at: number; reason: string }[];
}
/** Pacing only nudges. It never interrupts a model response or returns the child to the operator. */
export const WORK_PROGRESS_LIMITS = { idleMs: 60_000, operatorMs: 30_000, inspections: 12, intervalMs: 1_000, nudgesPerWindow: 2 } as const;
export const isWorkAction = (tool: string) => ["shell", "patch", "sortie_v011_check"].includes(tool);
export function newWorkProgress(now = Date.now()): WorkProgress {
  return { startedAt: now, lastActionAt: now, inspections: 0, tools: 0, commands: 0, edits: 0, active: [],
    reviewedAt: now, reviewedTools: 0, evidence: [], interventions: [] };
}
export function progressLimit(progress: WorkProgress, now: number, idleMs: number, inspections: number): string | null {
  // Process protection is not progress certification. Its own finite deadline still applies.
  if (progress.active.some(item => isWorkAction(item.tool))) return null;
  if (now < (progress.nextInterventionAt ?? 0)) return null;
  const calls = progress.tools - (progress.reviewedTools ?? 0);
  if (calls >= inspections) return `discovery-limit: ${calls} calls without an edit or executed command`;
  if (now - (progress.reviewedAt ?? progress.startedAt) >= idleMs) return `planning-timeout: no edit or executed command for ${Math.floor((now - (progress.reviewedAt ?? progress.startedAt)) / 1000)}s`;
  return null;
}
/** Reasoning-free measurements of the pain this pacing targets. */
export function pacingMetrics(progress: WorkProgress) {
  return { first_action_ms: progress.firstActionAt === undefined ? null : Math.max(0, progress.firstActionAt - progress.startedAt),
    nudges: progress.nudges?.length ?? 0 };
}
export function progressView(progress: WorkProgress, now = Date.now()) {
  const active = progress.active.at(-1);
  const phase = progress.stopped ? "correcting" : active ? isWorkAction(active.tool) ? "executing" : "inspecting" : "thinking";
  return { ...progress, phase, ...pacingMetrics(progress), elapsed_ms: Math.max(0, now - progress.startedAt),
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
