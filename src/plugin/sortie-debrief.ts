import { createHash } from "node:crypto";
import type { GoalAcceptanceContract, GoalTerminalReceipt, GoalFlightEventRecord } from "../core/goal-bound.js";
import { DEDICATED_WORKER_ROLES, LUNA_FABRIC_WORKER_ROLE } from "./model-routing.ts";

type Span = { start: number; end: number };
type Check = Span & { command: string; passed: boolean };
export interface DebriefSession {
  readonly id: string;
  readonly root: boolean;
  readonly spans: Span[];
  readonly checks: Check[];
  readonly mutations: Span[];
  readonly models: Record<string, number | null>;
  readonly reviews: Array<{ at: number; status: "PASS" | "FAIL" | "WAIVED" }>;
  readonly tasks: string[];
  complete: boolean;
  timingComplete: boolean;
  failed: boolean;
}
export interface DebriefObservation {
  readonly complete: boolean;
  readonly sessions: readonly DebriefSession[];
  readonly window: Span | undefined;
}
export interface Debrief {
  readonly pack: readonly { readonly model: string; readonly count: number }[] | null;
  readonly mix: readonly { readonly model: string; readonly tokens: number; readonly percent: number }[] | null;
  readonly validation: "PASS" | "FAIL" | "未確認";
  readonly review: "PASS" | "FAIL" | "WAIVED" | "未確認";
  readonly traits: readonly ("連携作戦" | "修正から復帰" | "一発完遂")[];
  readonly firstPassEligible?: boolean;
  readonly overlap?: { readonly workerMilliseconds: number; readonly wallMilliseconds: number };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const timeValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");
const workerRoles = new Set<string>([...DEDICATED_WORKER_ROLES, LUNA_FABRIC_WORKER_ROLE]);
function unionDuration(spans: readonly Span[]): number {
  let end = -1, total = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    total += Math.max(0, span.end - Math.max(span.start, end));
    end = Math.max(end, span.end);
  }
  return total;
}
const within = (span: Span, window: Span | undefined): boolean =>
  span.start <= span.end && (window === undefined || span.start >= window.start && span.end <= window.end);
const spanOf = (value: unknown): Span | undefined => {
  const time = object(value);
  const start = timeValue(time?.start ?? time?.created), end = timeValue(time?.end ?? time?.completed);
  return start === undefined || end === undefined || end < start ? undefined : { start, end };
};

/** Extract only bounded typed metadata during the existing host history traversal. No conversation text survives. */
export function observeDebriefSession(id: string, root: boolean, messages: readonly Record<string, unknown>[], window?: Span): DebriefSession {
  const session: DebriefSession = { id, root, spans: [], checks: [], mutations: [], models: {}, reviews: [], tasks: [], complete: true, timingComplete: true, failed: false };
  const calls = new Set<string>();
  for (const message of messages) {
    const info = object(message.info) ?? message;
    const time = info.time ?? message.time;
    // The root's in-flight terminal answer is intentionally outside pre-terminal accounting.
    if (root && object(time) !== undefined && timeValue(object(time)?.completed) === undefined) continue;
    const span = spanOf(time);
    if (span === undefined) { session.complete = false; session.timingComplete = false; continue; }
    if (!within(span, window)) {
      if (window !== undefined && span.start < window.end && span.end > window.start) {
        session.complete = false; session.timingComplete = false;
      }
      continue;
    }
    session.spans.push(span);
    if (info.error !== undefined) session.failed = true;
    for (const raw of Array.isArray(message.parts) ? message.parts : []) {
      const part = object(raw);
      if (part?.type !== "tool") continue;
      const call = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : undefined;
      if (call === undefined) { session.complete = false; continue; }
      if (calls.has(call)) continue;
      calls.add(call);
      const state = object(part.state);
      const interval = spanOf(state?.time);
      if (state?.status !== "completed" || interval === undefined) { session.failed = true; session.complete = false; continue; }
      if (!within(interval, window)) { session.complete = false; continue; }
      const tool = typeof part.tool === "string" ? part.tool.toLowerCase() : "";
      const args = object(state.input);
      if (tool.startsWith("sortie_") && typeof state.output === "string" && state.output.length <= 32768) {
        try { if (object(JSON.parse(state.output))?.status === "denied") session.failed = true; }
        catch { /* Non-JSON output cannot prove a clean controller operation. */ session.complete = false; }
      }
      if (tool === "task") {
        const metadata = object(state.metadata);
        const child = metadata?.sessionId ?? metadata?.sessionID;
        if (typeof args?.subagent_type !== "string") session.complete = false;
        else if (workerRoles.has(args.subagent_type)) {
          if (typeof child === "string") session.tasks.push(child);
          else session.complete = false;
        }
      }
      if (["edit", "write", "apply_patch"].includes(tool)) {
        const metadata = object(state.metadata);
        const changed = typeof metadata?.diff === "string" && /^[+-](?![+-])/mu.test(metadata.diff) ||
          Array.isArray(metadata?.files) && metadata.files.some((file: unknown) => {
            const entry = object(file);
            return typeof entry?.diff === "string" && /^[+-](?![+-])/mu.test(entry.diff);
          });
        if (changed) session.mutations.push(interval);
        else session.complete = false;
      }
      if (tool === "bash" && typeof args?.command === "string") {
        const metadata = object(state.metadata);
        const exit = metadata?.exit ?? metadata?.exitCode;
        if (typeof exit === "number" && Number.isInteger(exit)) {
          session.checks.push({ ...interval, command: fingerprint(args.command), passed: exit === 0 });
          if (exit !== 0) session.failed = true;
        } else session.complete = false;
      }
      // Only accepted controller outputs prove a review. Reviewer prose and tool input cannot do so.
      if (tool === "sortie_accept_luna_fabric_candidate" && typeof state.output === "string" && state.output.length <= 32768) {
        try {
          const output = object(JSON.parse(state.output));
          const fabric = object(output?.fabric);
          const review = object(fabric?.review);
          if (output?.status === "accepted" && review?.status === "pass") session.reviews.push({ at: interval.end, status: "PASS" });
          else if (output?.status === "accepted" && review?.status === "skip") session.reviews.push({ at: interval.end, status: "WAIVED" });
          else if (output?.status === "rejected" && review?.status === "fail") session.reviews.push({ at: interval.end, status: "FAIL" });
        } catch { /* Unknown evidence stays unknown. */ }
      }
    }
    if (session.spans.length > 4096 || calls.size > 4096) { session.complete = false; session.timingComplete = false; break; }
  }
  return session;
}

export function buildDebrief(receipt: GoalTerminalReceipt, contract: GoalAcceptanceContract | null,
  observation: DebriefObservation | undefined, records?: readonly GoalFlightEventRecord[]): Debrief {
  const empty: Debrief = { pack: null, mix: null, validation: "未確認", review: "未確認", traits: [] };
  if (observation === undefined) return empty;
  const sessions = observation.sessions;
  const complete = observation.complete && sessions.every((session) => session.complete);
  const timingComplete = observation.complete && sessions.every((session) => session.timingComplete);
  const children = sessions.filter((session) => !session.root && session.spans.length > 0);
  const counts = new Map<string, number>(), totals = new Map<string, number>();
  let usageComplete = timingComplete;
  for (const session of sessions) {
    for (const [model, tokens] of Object.entries(session.models)) {
      if (tokens === null || model === "未分類") usageComplete = false;
      else totals.set(model, (totals.get(model) ?? 0) + tokens);
    }
  }
  for (const session of children) {
    const models = Object.keys(session.models);
    const label = models.length === 0 ? "未分類" : models.length === 1 ? models[0]! : "混成";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = [...totals.values()].reduce((sum, tokens) => sum + tokens, 0);
  const commands = new Set(contract?.criteria.flatMap((criterion) => criterion.validation_command === undefined ? [] : [fingerprint(criterion.validation_command)]));
  const checks = sessions.flatMap((session) => session.checks.filter((check) => commands.has(check.command))).sort((a, b) => a.end - b.end);
  const latest = new Map<string, Check>();
  for (const check of checks) latest.set(check.command, check);
  const validation = [...latest.values()].some((check) => !check.passed) ? "FAIL"
    : complete && commands.size > 0 && latest.size === commands.size ? "PASS" : "未確認";
  const reviews = sessions.flatMap((session) => session.reviews).sort((a, b) => a.at - b.at);
  const traits: Debrief["traits"][number][] = [];
  const spans = children.flatMap((session) => session.spans.filter((span) => span.end > span.start)
    .map((span) => ({ ...span, session: session.id }))).sort((a, b) => a.start - b.start);
  let furthest: typeof spans[number] | undefined;
  for (const span of spans) {
    if (furthest !== undefined && span.session !== furthest.session && span.start < furthest.end) {
      traits.push("連携作戦"); break;
    }
    if (furthest === undefined || span.end > furthest.end) furthest = span;
  }
  // Same child and exact declared validator: never combine a sibling's failure with another candidate's success.
  const recovered = children.some((session) => {
    const failures = new Map<string, number>();
    const mutations = [...session.mutations].sort((a, b) => a.end - b.end);
    let index = 0, lastEditStart = -1;
    for (const check of [...session.checks].sort((a, b) => a.start - b.start)) {
      while (index < mutations.length && mutations[index]!.end <= check.start) {
        lastEditStart = Math.max(lastEditStart, mutations[index++]!.start);
      }
      if (!commands.has(check.command)) continue;
      if (!check.passed) failures.set(check.command, check.end);
      else if (failures.has(check.command) && lastEditStart >= failures.get(check.command)!) return true;
    }
    return false;
  });
  if (complete && receipt.status === "succeeded" && validation === "PASS" && recovered) traits.push("修正から復帰");
  // Only the complete, terminal-matched goal ledger can prove absence of retries; old/missing ledgers cannot.
  const events = records?.filter(({ event }) => event.goal_id === receipt.goal_id && event.kind !== "goal.reported").map(({ event }) => event);
  const reserved = events?.filter((event) => event.kind === "dispatch.reserved") ?? [];
  const settled = events?.filter((event) => event.kind === "unit.settled") ?? [];
  const tasks = sessions.flatMap((session) => session.tasks);
  const terminal = events?.at(-1);
  const fullLedger = events?.[0]?.kind === "goal.accepted" && terminal?.kind === "goal.terminal" &&
    terminal.receipt.terminal_revision === receipt.terminal_revision && terminal.receipt.status === receipt.status;
  const firstPassEligible = complete && fullLedger && receipt.status === "succeeded" && commands.size > 0 &&
    validation === "PASS" && reserved.length > 0 && reserved.length === settled.length && tasks.length === reserved.length;
  if (firstPassEligible &&
    reserved.length === settled.length && tasks.length === reserved.length && new Set(tasks).size === tasks.length &&
    settled.every((event) => event.disposition === "succeeded" && event.result_class === "acceptance") &&
    !events?.some((event) => event.kind === "goal.replanned" || event.kind === "goal.user-continued" || event.kind === "goal.revised" ||
      (event.kind === "validation.admission" && event.decision === "DENY") || (event.kind === "validation.settled" && event.outcome !== "passed")) &&
    sessions.every((session) => !session.failed && new Set(session.checks.map((check) => check.command)).size === session.checks.length)) traits.push("一発完遂");
  return { pack: timingComplete ? [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([model, count]) => ({ model, count })) : null,
    mix: usageComplete && total > 0 ? [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([model, tokens]) => ({ model, tokens, percent: tokens / total * 100 })) : null,
    validation, review: complete ? reviews.filter((review) => !sessions.some((session) => session.mutations.some((edit) => edit.end > review.at))).at(-1)?.status ?? "未確認" : "未確認", traits, firstPassEligible,
    ...(timingComplete ? { overlap: { workerMilliseconds: children.reduce((sum, child) => sum + unionDuration(child.spans), 0),
      wallMilliseconds: unionDuration(spans) } } : {}) };
}

const label = (text: string): string => text.replace(/[\r\n\t]/gu, " ").replace(/[\\`*_{}\[\]()<>!|]/gu, "").slice(0, 120);
export function renderDebrief(debrief: Debrief | undefined): string[] {
  const pack = debrief?.pack == null ? null : [...debrief.pack].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  const packVisible = pack?.slice(0, 4) ?? [];
  if (pack !== null && pack.length > 4) packVisible.push({ model: "その他", count: pack.slice(4).reduce((sum, entry) => sum + entry.count, 0) });
  const mix = debrief?.mix == null ? null : [...debrief.mix].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  const visible = mix?.slice(0, 4) ?? [];
  if (mix !== null && mix.length > 4) visible.push({ model: "その他", tokens: mix.slice(4).reduce((sum, entry) => sum + entry.tokens, 0),
    percent: mix.slice(4).reduce((sum, entry) => sum + entry.percent, 0) });
  const bars = (percent: number) => {
    const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };
  return [
    `**🐕 出撃隊:** ${pack === null ? "計測不可" : pack.length === 0 ? "出撃なし" : packVisible.map((entry) => `${label(entry.model)} ×${entry.count}`).join(" · ")}`,
    `**モデル別token内訳:** ${mix === null ? "計測不可" : ""}`,
    ...visible.map((entry) => `**↳** ${label(entry.model)} \`${bars(entry.percent)}\` ${entry.percent.toFixed(1)}%`),
    `**実行重複率:** ${debrief?.overlap !== undefined && debrief.overlap.wallMilliseconds > 0
      ? `${(debrief.overlap.workerMilliseconds / debrief.overlap.wallMilliseconds).toFixed(2)}×（worker区間・速度倍率ではありません）` : "計測不可"}`,
    `**確認:** 対象検証 ${debrief?.validation ?? "未確認"} · 直近Review ${debrief?.review === "WAIVED" ? "免除" : debrief?.review ?? "未確認"}`,
    ...(debrief?.traits.length ? [`**🏅 今回の戦績:** ${debrief.traits.join(" · ")}`] : []),
  ];
}
