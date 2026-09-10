import type { GoalFlightState, GoalTerminalReceipt, GoalFlightEventRecord } from "../core/goal-bound.js";
import { buildDebrief, renderDebrief, observeDebriefSession, type Debrief, type DebriefObservation } from "./sortie-debrief.ts";
import { goalFingerprint } from "../core/goal-bound.ts";
import type { GoalReport } from "../core/goal-report.ts";
import { renderCareer, type SortieCareer } from "./sortie-career.ts";

export interface RunMetricsClient {
  readonly session?: {
    readonly get?: (request: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>;
    readonly children?: (request: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>;
    readonly messages?: (request: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>;
  };
}

export interface RunMetricsWindow {
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface RunMetrics {
  readonly durationMilliseconds: number | undefined;
  readonly tokens: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly cost: number | undefined;
  readonly steps: number | undefined;
  readonly sessions: number | undefined;
  readonly cacheRatio: number | undefined;
  readonly roles: Readonly<Record<string, RunRoleMetrics>> | undefined;
  /** Optional for compatibility with older host snapshots. Collected in the existing history pass. */
  readonly debrief?: DebriefObservation;
}

export interface RunRoleMetrics {
  readonly tokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number | undefined;
  readonly steps: number;
  readonly cacheRatio: number | undefined;
}

export type SortieResultUnavailableReason =
  | "acceptance-contract-unavailable"
  | "goal-clock-invalid"
  | "goal-usage-unavailable"
  | "host-metrics-unavailable"
  | "incomplete-host-coverage"
  | "matched-baseline-unavailable"
  | "milestone-unavailable"
  | "usable-milestone-unavailable"
  | "worker-overlap-unavailable";

export type SortieResultMetric<T> =
  | { readonly availability: "available"; readonly value: T; readonly provenance: "goal-receipt" | "goal-ledger" | "host-reported" }
  | { readonly availability: "unavailable"; readonly value: null; readonly reason: SortieResultUnavailableReason };

export type SortieProofStatus = "PASS" | "FAIL" | "UNPROVEN" | "NOT_REQUIRED" | "WAIVED";

export interface SortieResult {
  readonly schema_version: "0.1";
  readonly result_id: readonly [goalID: string, terminalRevision: number];
  readonly accounting_phase: "pre-terminal";
  readonly as_of: string;
  readonly debrief?: Debrief;
  readonly career?: SortieCareer;
  readonly mission: {
    readonly status: "COMPLETED" | "INTERRUPTED" | "EXTERNAL_BLOCKER" | "USER_DECISION";
    readonly stop_reason: GoalTerminalReceipt["stop_reason"];
  };
  readonly speed: {
    readonly goal_wall_ms: SortieResultMetric<number>;
    readonly worker_execution_ms: SortieResultMetric<number>;
    readonly execution_compression: SortieResultMetric<number>;
    readonly first_verifiable_ms: SortieResultMetric<number>;
    readonly first_usable_ms: SortieResultMetric<number>;
    readonly bare_comparison: SortieResultMetric<number>;
  };
  readonly cost: {
    readonly total_tokens: SortieResultMetric<number>;
    readonly cost_usd: SortieResultMetric<number>;
    readonly model_steps: SortieResultMetric<number>;
    readonly sessions: SortieResultMetric<number>;
  };
  readonly proof: {
    readonly overall: SortieProofStatus;
    readonly acceptance_fingerprint: string;
    readonly criteria: SortieResultMetric<readonly { readonly criterion_id: string; readonly status: SortieProofStatus }[]>;
    readonly evidence_refs: readonly string[];
  };
}

type SortieGoalSnapshot = Pick<GoalFlightState,
  "acceptance_contract" | "consumed_time_ms" | "satisfied_criteria">;

const unavailable = <T>(reason: SortieResultUnavailableReason): SortieResultMetric<T> =>
  ({ availability: "unavailable", value: null, reason });

const available = <T>(value: T, provenance: "goal-receipt" | "goal-ledger" | "host-reported"): SortieResultMetric<T> =>
  ({ availability: "available", value, provenance });

function elapsedBetween(start: string, end: string): number | undefined {
  const started = Date.parse(start);
  const ended = Date.parse(end);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : undefined;
}

/** Builds a pure terminal snapshot from the durable goal receipt and already-observed host metrics. */
export function createSortieResult(
  receipt: GoalTerminalReceipt,
  goal: SortieGoalSnapshot,
  metrics: RunMetrics | undefined,
  asOf = receipt.ended_at,
  records?: readonly GoalFlightEventRecord[],
): SortieResult {
  const goalWall = elapsedBetween(receipt.started_at, receipt.ended_at);
  const firstVerifiable = receipt.milestone_at === null
    ? undefined
    : elapsedBetween(receipt.started_at, receipt.milestone_at);
  const criteria = goal.acceptance_contract?.criteria.map(({ criterion_id }) => ({
    criterion_id,
    status: goal.satisfied_criteria.includes(criterion_id) ? "PASS" as const : "UNPROVEN" as const,
  }));
  const hostMetric = (value: number | undefined): SortieResultMetric<number> => value === undefined
    ? unavailable(metrics === undefined ? "host-metrics-unavailable" : "incomplete-host-coverage")
    : available(value, "host-reported");
  const missionStatus: SortieResult["mission"]["status"] = receipt.status === "succeeded"
    ? "COMPLETED"
    : receipt.stop_reason === "awaiting_user"
      ? "USER_DECISION"
      : receipt.stop_reason === "external_dependency" || receipt.stop_reason === "persistence_unavailable"
        ? "EXTERNAL_BLOCKER"
        : "INTERRUPTED";
  const debrief = buildDebrief(receipt, goal.acceptance_contract, metrics?.debrief, records);
  return {
    schema_version: "0.1",
    result_id: [receipt.goal_id, receipt.terminal_revision],
    accounting_phase: "pre-terminal",
    as_of: asOf,
    debrief,
    mission: {
      status: missionStatus,
      stop_reason: receipt.stop_reason,
    },
    speed: {
      goal_wall_ms: goalWall === undefined ? unavailable("goal-clock-invalid") : available(goalWall, "goal-receipt"),
      worker_execution_ms: goal.consumed_time_ms === null
        ? unavailable("goal-usage-unavailable")
        : available(goal.consumed_time_ms, "goal-ledger"),
      execution_compression: debrief.overlap !== undefined && debrief.overlap.wallMilliseconds > 0
        ? available(debrief.overlap.workerMilliseconds / debrief.overlap.wallMilliseconds, "host-reported")
        : unavailable("worker-overlap-unavailable"),
      first_verifiable_ms: firstVerifiable === undefined
        ? unavailable("milestone-unavailable")
        : available(firstVerifiable, "goal-receipt"),
      first_usable_ms: unavailable("usable-milestone-unavailable"),
      bare_comparison: unavailable("matched-baseline-unavailable"),
    },
    cost: {
      total_tokens: hostMetric(metrics?.tokens),
      cost_usd: hostMetric(metrics?.cost),
      model_steps: hostMetric(metrics?.steps),
      sessions: hostMetric(metrics?.sessions),
    },
    proof: {
      overall: receipt.status === "succeeded" ? "PASS" : "UNPROVEN",
      acceptance_fingerprint: receipt.acceptance_fingerprint,
      criteria: criteria === undefined
        ? unavailable("acceptance-contract-unavailable")
        : available(criteria, "goal-ledger"),
      evidence_refs: receipt.evidence_refs,
    },
  };
}

export type RunTerminalOutcome = "DONE" | "INTERRUPTED" | "BLOCKED" | "NEED_DECISION";

const MAX_SESSIONS = 128;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function unwrap(value: unknown): unknown {
  const object = record(value);
  return object !== undefined && "data" in object ? object.data : value;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface MessageTokens {
  readonly total: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

interface MutableRoleMetrics {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  costAvailable: boolean;
  steps: number;
}

function messageTokens(message: Record<string, unknown>): MessageTokens | undefined {
  const info = record(message.info) ?? message;
  const tokens = record(info.tokens) ?? record(message.tokens);
  if (tokens === undefined) return undefined;
  const input = number(tokens.input);
  const output = number(tokens.output);
  const reasoning = number(tokens.reasoning);
  const cache = record(tokens.cache);
  const cacheRead = number(cache?.read) ?? number(tokens.cacheRead) ?? number(tokens.cache_read);
  const cacheWrite = number(cache?.write) ?? number(tokens.cacheWrite) ?? number(tokens.cache_write);
  if (input === undefined || output === undefined || reasoning === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return {
    total: input + output + reasoning + cacheRead + cacheWrite,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
  };
}

function usageRecords(message: Record<string, unknown>): Array<{ id: string; value: Record<string, unknown> }> | undefined {
  const info = record(message.info) ?? message;
  const messageID = typeof info.id === "string" ? info.id : typeof message.id === "string" ? message.id : undefined;
  if (messageTokens(message) !== undefined) {
    return messageID === undefined ? undefined : [{ id: `message:${messageID}`, value: message }];
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const records = new Map<string, Record<string, unknown>>();
  for (const entry of parts) {
    const part = record(entry);
    if (part?.type !== "step-finish") continue;
    const id = typeof part.id === "string" ? part.id : undefined;
    if (id === undefined) return undefined;
    records.set(`part:${id}`, part);
  }
  if (records.size > 0) return [...records].map(([id, value]) => ({ id, value }));
  return messageID === undefined ? undefined : [{ id: `message:${messageID}`, value: message }];
}

function messageAgent(message: Record<string, unknown>): string {
  const info = record(message.info) ?? message;
  const agent = info.agent ?? message.agent;
  return typeof agent === "string" && agent.trim().length > 0 ? agent.slice(0, 128) : "unknown";
}

function assistantMessages(value: unknown): Record<string, unknown>[] | undefined {
  const payload = unwrap(value);
  if (!Array.isArray(payload)) return undefined;
  return payload.filter((entry): entry is Record<string, unknown> => {
    const item = record(entry);
    const info = item === undefined ? undefined : record(item.info);
    return item !== undefined && (info?.role ?? item.role) === "assistant";
  });
}

function conclusionStatusAlias(line: string): RunTerminalOutcome | undefined {
  const match = /^(✅|⚠️|⛔|❓)[ \t]+conclusion:\s*status:\s*(DONE|INTERRUPTED|BLOCKED|NEED_DECISION)\b/iu.exec(line);
  const outcome = match?.[2]?.toUpperCase();
  if (outcome !== "DONE" && outcome !== "INTERRUPTED" && outcome !== "BLOCKED" && outcome !== "NEED_DECISION") return undefined;
  const expectedIcon = outcome === "DONE" ? "✅" : outcome === "INTERRUPTED" ? "⚠️" : outcome === "BLOCKED" ? "⛔" : "❓";
  return match?.[1] === expectedIcon ? outcome : undefined;
}

export async function collectRunMetrics(
  client: RunMetricsClient | undefined,
  rootSessionID: string,
  directory?: string,
  now = Date.now(),
  window?: RunMetricsWindow,
): Promise<RunMetrics | undefined> {
  const session = client?.session;
  if (session?.messages === undefined) return undefined;
  const windowStart = window === undefined ? undefined : Date.parse(window.startedAt);
  const windowEnd = window === undefined ? undefined : Date.parse(window.endedAt);
  if (window !== undefined && (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd! < windowStart!)) return undefined;
  const ids = [rootSessionID];
  const visited = new Set(ids);
  let hierarchyComplete = session.children !== undefined;
  for (let index = 0; index < ids.length && ids.length < MAX_SESSIONS; index += 1) {
    if (session.children === undefined) break;
    try {
      const children = unwrap(await session.children.call(session, { path: { id: ids[index]! }, query: { directory } }));
      if (!Array.isArray(children)) { hierarchyComplete = false; break; }
      for (const child of children) {
        const item = record(child);
        const id = typeof item?.id === "string" ? item.id : typeof item?.sessionID === "string" ? item.sessionID : undefined;
        if (id === undefined) { hierarchyComplete = false; continue; }
        if (!visited.has(id) && ids.length < MAX_SESSIONS) { visited.add(id); ids.push(id); }
        else if (!visited.has(id)) hierarchyComplete = false;
      }
    } catch { hierarchyComplete = false; break; }
  }
  if (ids.length >= MAX_SESSIONS) hierarchyComplete = false;
  const uniqueUsage = new Set<string>();
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let tokensAvailable = true;
  let messagesComplete = true;
  let steps = 0;
  let cost = 0;
  let costAvailable = true;
  const roleMetrics = new Map<string, MutableRoleMetrics>();
  const observedSessions: DebriefObservation["sessions"][number][] = [];
  for (const id of ids) {
    try {
      const messages = assistantMessages(await session.messages.call(session, { path: { id }, query: { directory } }));
      if (messages === undefined) return undefined;
      const observed = observeDebriefSession(id, id === rootSessionID, messages,
        window === undefined ? undefined : { start: windowStart!, end: windowEnd! });
      observedSessions.push(observed);
      for (const message of messages) {
        const info = record(message.info) ?? message;
        const time = record(info.time) ?? record(message.time);
        if (time !== undefined && number(time.completed) === undefined) continue;
        const completed = number(time?.completed);
        if (window !== undefined) {
          if (completed === undefined) { messagesComplete = false; continue; }
          if (completed < windowStart! || completed > windowEnd!) continue;
        }
        const records = usageRecords(message);
        if (records === undefined) { messagesComplete = false; continue; }
        const fresh = records.filter(({ id }) => !uniqueUsage.has(id));
        if (fresh.length === 0) continue;
        for (const { id } of fresh) uniqueUsage.add(id);
        steps += 1;
        const agent = messageAgent(message);
        const role = roleMetrics.get(agent) ?? {
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          costAvailable: true,
          steps: 0,
        };
        role.steps += 1;
        roleMetrics.set(agent, role);
        for (const usage of fresh) {
          const tokens = messageTokens(usage.value);
          const modelInfo = record(usage.value.info) ?? usage.value;
          const provider = modelInfo.providerID ?? info.providerID;
          const model = modelInfo.modelID ?? info.modelID;
          const modelKey = typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : "未分類";
          observed.models[modelKey] = tokens === undefined || observed.models[modelKey] === null ? null
            : (observed.models[modelKey] ?? 0) + tokens.total;
          if (tokens !== undefined) {
            totalTokens += tokens.total;
            inputTokens += tokens.input;
            outputTokens += tokens.output;
            reasoningTokens += tokens.reasoning;
            cacheRead += tokens.cacheRead;
            cacheWrite += tokens.cacheWrite;
            role.tokens += tokens.total;
            role.inputTokens += tokens.input;
            role.outputTokens += tokens.output;
            role.reasoningTokens += tokens.reasoning;
            role.cacheReadTokens += tokens.cacheRead;
            role.cacheWriteTokens += tokens.cacheWrite;
          } else tokensAvailable = false;
          const usageInfo = record(usage.value.info) ?? usage.value;
          const reportedCost = number(usageInfo.cost) ?? number(usage.value.cost);
          if (reportedCost === undefined) {
            costAvailable = false;
            role.costAvailable = false;
          } else {
            cost += reportedCost;
            role.cost += reportedCost;
          }
        }
      }
    } catch { return undefined; }
  }
  let created: number | undefined;
  if (session.get !== undefined) {
    try {
      const root = record(unwrap(await session.get.call(session, { path: { id: rootSessionID }, query: { directory } })));
      const time = record(root?.time);
      created = number(time?.created);
    } catch { /* fallback below */ }
  }
  return {
    durationMilliseconds: window === undefined
      ? created === undefined ? undefined : Math.max(0, now - created)
      : windowEnd! - windowStart!,
    tokens: hierarchyComplete && messagesComplete && tokensAvailable ? totalTokens : undefined,
    inputTokens: hierarchyComplete && messagesComplete && tokensAvailable ? inputTokens : undefined,
    outputTokens: hierarchyComplete && messagesComplete && tokensAvailable ? outputTokens : undefined,
    reasoningTokens: hierarchyComplete && messagesComplete && tokensAvailable ? reasoningTokens : undefined,
    cacheReadTokens: hierarchyComplete && messagesComplete && tokensAvailable ? cacheRead : undefined,
    cacheWriteTokens: hierarchyComplete && messagesComplete && tokensAvailable ? cacheWrite : undefined,
    cost: hierarchyComplete && messagesComplete && costAvailable ? cost : undefined,
    steps: hierarchyComplete && messagesComplete ? steps : undefined,
    sessions: hierarchyComplete ? ids.length : undefined,
    cacheRatio: hierarchyComplete && messagesComplete && tokensAvailable && totalTokens > 0 ? cacheRead / totalTokens : undefined,
    roles: hierarchyComplete && messagesComplete && tokensAvailable
      ? Object.fromEntries([...roleMetrics].map(([agent, role]) => [agent, {
        tokens: role.tokens,
        inputTokens: role.inputTokens,
        outputTokens: role.outputTokens,
        reasoningTokens: role.reasoningTokens,
        cacheReadTokens: role.cacheReadTokens,
        cacheWriteTokens: role.cacheWriteTokens,
        cost: role.costAvailable ? role.cost : undefined,
        steps: role.steps,
        cacheRatio: role.tokens > 0 ? role.cacheReadTokens / role.tokens : undefined,
      }]))
      : undefined,
    debrief: { complete: hierarchyComplete && messagesComplete, sessions: observedSessions,
      window: window === undefined ? undefined : { start: windowStart!, end: windowEnd! } },
  };
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function metricText<T>(metric: SortieResultMetric<T>, render: (value: T) => string): string {
  return metric.availability === "available" ? render(metric.value) : "計測不可";
}

export function formatSortieResult(result: SortieResult): string {
  const criteria = metricText(result.proof.criteria, (entries) => {
    const passing = entries.filter(({ status }) => status === "PASS").length;
    return `${passing}/${entries.length}`;
  });
  const achievement = result.mission.status === "COMPLETED" ? "完了"
    : result.mission.status === "INTERRUPTED" ? "中断（未完了）"
      : result.mission.status === "EXTERNAL_BLOCKER" ? "外部要因で未完了"
        : "ユーザー判断待ち（未完了）";
  return [
    "**🐾 SORTIE DOGS — 帰還報告**",
    `**⚡ 時間:** ${metricText(result.speed.goal_wall_ms, duration)}`,
    `**🪙 使用量:** ${metricText(result.cost.total_tokens, (value) => `${value.toLocaleString("ja-JP")} tokens`)} · host推定額 ${metricText(result.cost.cost_usd, (value) => `$${value.toFixed(4)}`)}（実課金換算なし）`,
    ...renderDebrief(result.debrief),
    `**🛡 達成:** ${achievement} · 達成条件 ${criteria}`,
    "*最終応答生成前の計測*",
    ...renderCareer(result.career),
  ].join("\n\n");
}

export function formatRunMetrics(metrics: RunMetrics): string {
  const elapsed = metrics.durationMilliseconds === undefined ? "duration unavailable" : `${duration(metrics.durationMilliseconds)} wall-clock`;
  const cost = metrics.cost === undefined ? "cost unavailable" : `$${metrics.cost.toFixed(4)}`;
  const tokens = metrics.tokens === undefined ? "tokens unavailable" : `${metrics.tokens.toLocaleString("en-US")} tokens`;
  const steps = metrics.steps === undefined ? "steps unavailable" : `${metrics.steps} completed assistant model step${metrics.steps === 1 ? "" : "s"}`;
  const sessions = metrics.sessions === undefined ? "sessions unavailable" : `${metrics.sessions} session${metrics.sessions === 1 ? "" : "s"}`;
  const cache = metrics.cacheRatio === undefined ? "cache ratio unavailable" : `${(metrics.cacheRatio * 100).toFixed(1)}% cache ratio`;
  return `**Run:** pre-terminal host snapshot · ${elapsed} · ${tokens} · ${cost} · ${steps} · ${sessions} · ${cache}`;
}

function topLevelLines(text: string): Array<{ index: number; line: string }> {
  const lines: Array<{ index: number; line: string }> = [];
  let fence: { character: string; length: number } | undefined;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (fence === undefined) {
      const opener = /^[ \t]*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (opener === undefined) {
        if (!/^[ \t]*>/u.test(line)) lines.push({ index, line });
        continue;
      }
      fence = { character: opener[0]!, length: opener.length };
      continue;
    }
    const closer = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
    if (closer?.[0] === fence.character && closer.length >= fence.length) fence = undefined;
  }
  return lines;
}

function terminalCheckpoint(text: string): { index: number; outcome: RunTerminalOutcome } | undefined {
  const lines = topLevelLines(text);
  const first = lines.find(({ line }) => line.trim().length > 0);
  if (first === undefined) return undefined;
  const checkpoint = (() => {
    const { index, line } = first;
    const normalized = /^status:\s*(DONE|INTERRUPTED|BLOCKED|NEED_DECISION)\b/iu.exec(line)?.[1]?.toUpperCase();
    const explicit: RunTerminalOutcome | undefined = normalized === "DONE" || normalized === "INTERRUPTED" || normalized === "BLOCKED" || normalized === "NEED_DECISION"
      ? normalized
      : undefined;
    const outcome = explicit ?? conclusionStatusAlias(line) ??
      (/^✅[ \t]+\*\*DONE\*\*/u.test(line) ? "DONE" :
        /^⚠️[ \t]+\*\*INTERRUPTED\*\*/u.test(line) ? "INTERRUPTED" :
        /^⛔[ \t]+\*\*BLOCKED\*\*/u.test(line) ? "BLOCKED" :
        /^❓[ \t]+\*\*NEED_DECISION\*\*/u.test(line) ? "NEED_DECISION" : undefined);
    return outcome === "DONE" || outcome === "INTERRUPTED" || outcome === "BLOCKED" || outcome === "NEED_DECISION"
      ? { index, outcome }
      : undefined;
  })();
  return checkpoint;
}

export function isDoneTerminalText(text: string): boolean {
  return terminalCheckpoint(text)?.outcome === "DONE";
}

export function terminalRunOutcome(text: string): RunTerminalOutcome | undefined {
  const checkpoint = terminalCheckpoint(text);
  if (checkpoint === undefined) return undefined;
  if (checkpoint.outcome !== "BLOCKED") return checkpoint.outcome;
  return topLevelLines(text).some(({ index, line }) => index > checkpoint.index &&
    /^TRUE_BLOCKER\s*:\s*(?:external|user-decision)\s*:\s*\S.*$/u.test(line))
    ? "BLOCKED"
    : undefined;
}

export function replaceTerminalStatus(text: string, replacement: string): string {
  const checkpoint = terminalCheckpoint(text);
  if (checkpoint === undefined) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  lines.splice(checkpoint.index, 1, ...replacement.split(/\r?\n/u));
  return lines.join(newline);
}

export function replaceDoneTerminalStatus(text: string, replacement: string): string {
  return terminalCheckpoint(text)?.outcome === "DONE" ? replaceTerminalStatus(text, replacement) : text;
}

export function sanitizeTerminalReport(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const internal = /\b(?:evidence_refs?|manifest|raw|raw_status|reason_code|goal_control|TRUE_BLOCKER)\s*:|\bEvidence\b/iu;
  return text.replace(/^[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gimu,
    (block, _fence: string, body: string) => internal.test(body) ? "" : block)
    .replace(/<details\b[^>]*>[\s\S]*?<\/details>/giu, "")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:(?:#{1,6}\s*)?\**Evidence\**\s*:|(?:TRUE_BLOCKER|goal_control|evidence_refs?|reason_code|raw|raw_status|manifest)\s*:)/iu.test(line))
    .join(newline)
    .trimEnd();
}

export function insertRunMetrics(text: string, metrics: RunMetrics): string {
  const visible = sanitizeTerminalReport(text);
  const checkpoint = terminalCheckpoint(visible);
  if (checkpoint?.outcome !== "DONE") return visible;
  if (topLevelLines(visible).some(({ index, line }) => index > checkpoint.index && /^\*\*Run:\*\*/u.test(line))) return visible;
  const newline = visible.includes("\r\n") ? "\r\n" : "\n";
  const lines = visible.split(/\r?\n/u);
  lines.splice(checkpoint.index + 1, 0, "", formatRunMetrics(metrics));
  return lines.join(newline);
}

export function insertSortieResult(text: string, result: SortieResult): string {
  const visible = sanitizeTerminalReport(text);
  const checkpoint = terminalCheckpoint(visible);
  if (checkpoint === undefined) return visible;
  // A title in model text is not trusted evidence. Replace existing cards, including legacy cards.
  const newline = visible.includes("\r\n") ? "\r\n" : "\n";
  const lines = visible.split(/\r?\n/u);
  const cardLines = new Set(topLevelLines(visible).filter(({ index, line }) => index > checkpoint.index &&
    /^(?:\*\*(?:Sortie Result|🐾 SORTIE DOGS — 帰還報告|📜 PACK RECORD|↳\*\*|(?:Speed|Cost|達成|⚡ 時間|🪙 使用量|🐕 出撃隊|モデル別token内訳|実行重複率|🛡 達成|確認|🏅 今回の戦績|戦績|初回完遂|累積使用量|累積モデル|累積時間|累積実行重複率|保存範囲|🎖 隊の称号):)|\*最終応答生成前の計測\*)/u.test(line)).map(({ index }) => index));
  const cleaned = lines.filter((_, index) => !cardLines.has(index));
  while (cleaned[checkpoint.index + 1] === "") cleaned.splice(checkpoint.index + 1, 1);
  let card: string;
  try { card = formatSortieResult(result); }
  catch { card = "**🐾 SORTIE DOGS — 帰還報告**\n**確認:** 表示集計を取得できません。任務結果は先頭の状態を参照。"; }
  cleaned.splice(checkpoint.index + 1, 0, "", card, "");
  return cleaned.join(newline).trimEnd();
}

export function createGoalReport(result: SortieResult, receipt: GoalTerminalReceipt): GoalReport {
  const tokens = result.cost.total_tokens.availability === "available" && Number.isSafeInteger(result.cost.total_tokens.value)
    ? result.cost.total_tokens.value : null;
  const mix = result.debrief?.mix;
  const traits: GoalReport["traits"][number][] = [];
  if (result.debrief?.traits.includes("連携作戦")) traits.push("pack-tactics");
  if (result.debrief?.traits.includes("修正から復帰")) traits.push("recovery");
  if (result.debrief?.traits.includes("一発完遂")) traits.push("clean-sweep");
  return { definition: "pre-terminal-host-tokens/v1", terminal_key: goalFingerprint(receipt), tokens,
    models: mix != null && mix.length <= 128 && mix.every((entry) => entry.model.length <= 512) &&
      mix.reduce((sum, entry) => sum + entry.tokens, 0) === tokens ? mix.map(({ model, tokens }) => ({ model, tokens })) : null,
    first_pass_eligible: result.debrief?.firstPassEligible === true, traits,
    ...(result.debrief?.overlap === undefined ? {} : { overlap: { definition: "worker-span-union/v1" as const,
      worker_ms: result.debrief.overlap.workerMilliseconds, wall_ms: result.debrief.overlap.wallMilliseconds } }) };
}
