import { createHash } from "node:crypto";
import type { GoalAcceptanceContract, GoalTerminalReceipt, GoalFlightEventRecord } from "../core/goal-bound.js";
import { validationDurationGuidance } from "../core/validation-budget.js";
import { DEDICATED_WORKER_ROLES, LUNA_FABRIC_WORKER_ROLE } from "./model-routing.ts";
import { normalizeCommand } from "./gate.ts";
import { evaluateRareAwards, rareEvaluation, RARE_RULES, type RareAwards, type ConditionState } from "../core/rare-awards.ts";
import { reportText, resolveReportLocale, type ReportLocale } from "./report-locale.ts";

export function rareDisplay(id: string, locale: ReportLocale): { title: string; reason: string } {
  const t = reportText(locale);
  return id === "rare.clean-sweep" ? {
    title: t("静かな一撃", "Quiet Strike"),
    reason: t("厳密な一発完遂（既存実績の特別区分・別加算なし）", "Strict Clean Sweep (reclassified existing achievement; no extra count)"),
  } : {
    title: t("不屈の連携", "Unbroken Formation"),
    reason: t("修正復帰 × 異なる子の並行稼働（因果的協働成果の証明ではありません）", "Recovery × overlapping child activity (not proof of causally successful collaboration)"),
  };
}

type Span = { start: number; end: number };
type Check = Span & { command: string; passed: boolean };
export interface DebriefSession {
  readonly id: string;
  readonly root: boolean;
  readonly spans: Span[];
  readonly checks: Check[];
  readonly mutations: Span[];
  readonly models: Record<string, number | null>;
  /** Optional per-model input/cache/cost observations for compatibility with older snapshots. */
  readonly modelUsage?: Record<string, {
    tokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    costAvailable: boolean;
    estimatedCost?: number;
    pricedRequests?: number;
    unpricedRequests?: number;
  }>;
  readonly reviews: Array<{ at: number; status: "PASS" | "FAIL" | "WAIVED"; source?: "reviewer" | "controller" }>;
  readonly tasks: string[];
  complete: boolean;
  timingComplete: boolean;
  failed: boolean;
  lastPossibleMutation?: number;
}
export interface DebriefObservation {
  readonly complete: boolean;
  readonly sessions: readonly DebriefSession[];
  readonly window: Span | undefined;
}
export interface Debrief {
  readonly pack: readonly { readonly model: string; readonly count: number }[] | null;
  readonly mix: readonly {
    readonly model: string;
    readonly tokens: number;
    readonly percent: number;
    readonly inputCache?: {
      readonly uncachedInputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
    };
    readonly estimatedCost?: {
      readonly usd: number;
      readonly pricedRequests: number;
      readonly unpricedRequests: number;
      readonly complete: boolean;
    };
    readonly hostCostZero?: boolean;
  }[] | null;
  /** Shares use observed tokens; incomplete history must not erase known model usage. */
  readonly mixCoverage?: { readonly complete: boolean; readonly observedTokens: number };
  readonly estimatedCost?: {
    readonly usd: number;
    readonly pricedRequests: number;
    readonly unpricedRequests: number;
  };
  readonly validation: "PASS" | "FAIL" | "未確認";
  readonly review: "PASS" | "FAIL" | "WAIVED" | "未確認";
  readonly reviewSource?: "reviewer" | "controller";
  readonly notes?: readonly string[];
  readonly traits: readonly ("連携作戦" | "修正から復帰" | "一発完遂")[];
  readonly firstPassEligible?: boolean;
  readonly rare?: RareAwards;
  /** Only persisted, receipt-matched evaluations are displayed as awarded records. */
  readonly rareRecord?: "saved" | "legacy" | "unavailable";
  readonly overlap?: { readonly workerMilliseconds: number; readonly wallMilliseconds: number };
  readonly validationEfficiency: {
    readonly completed: number;
    readonly skipped: number;
    readonly rejected: number;
    readonly redundantMilliseconds: number;
    readonly medianMilliseconds: number | null;
    readonly p90Milliseconds: number | null;
  };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const timeValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const fingerprint = (value: string): string => createHash("sha256").update(normalizeCommand(value)).digest("hex");
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
  const session: DebriefSession = { id, root, spans: [], checks: [], mutations: [], models: {}, modelUsage: {}, reviews: [], tasks: [], complete: true, timingComplete: true, failed: false };
  const calls = new Set<string>();
  for (const message of messages) {
    const info = object(message.info) ?? message;
    // Transport control receipts have no command interval; the native turn covers their elapsed time.
    if (info.codexControlReceipt === true) continue;
    const time = info.time ?? message.time;
    // The root's in-flight terminal answer is intentionally outside pre-terminal accounting.
    if (root && object(time) !== undefined && timeValue(object(time)?.completed) === undefined) continue;
    const span = spanOf(time);
    if (span === undefined) { session.complete = false; session.timingComplete = false; continue; }
    // Match the token collector's completed-message window. A message can start just before
    // goal.accepted; clip its timing rather than invalidating every independent metric.
    if (window !== undefined && (span.end < window.start || span.end > window.end)) continue;
    session.spans.push(window === undefined ? span : { start: Math.max(span.start, window.start), end: span.end });
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
        if (args?.subagent_type === "dog-reviewer" && typeof state.output === "string") {
          const body = /<task_result>([\s\S]*?)<\/task_result>/u.exec(state.output)?.[1] ?? state.output;
          const lines = body.replace(/^[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^[ \t]*\1[ \t]*$/gmu, "")
            .trim().split(/\r?\n/u);
          const verdicts = [lines[0], lines.at(-1)].map(line => line?.trim().match(
            /^(?:\*\*)?(?:(?:verdict|結論|判定)\s*:\s*)?(PASS|FAIL|MUST_FIX)(?:\*\*)?$/iu)?.[1]?.toUpperCase());
          const verdict = verdicts.some(value => value === "FAIL" || value === "MUST_FIX") || /^FINDING\b/iu.test(lines[0] ?? "")
            ? "FAIL" : verdicts.includes("PASS") ? "PASS" : undefined;
          if (verdict !== undefined) session.reviews.push({ at: interval.end,
            status: verdict === "PASS" ? "PASS" : "FAIL", source: "reviewer" });
        }
      }
      if (["edit", "write", "apply_patch"].includes(tool)) {
        session.lastPossibleMutation = Math.max(session.lastPossibleMutation ?? 0, interval.end);
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
  observation ??= { complete: false, sessions: [], window: undefined };
  const sessions = observation.sessions;
  const complete = observation.complete && sessions.every((session) => session.complete);
  const timingComplete = observation.complete && sessions.every((session) => session.timingComplete);
  const children = sessions.filter((session) => !session.root &&
    (session.spans.length > 0 || Object.keys(session.models).length > 0));
  const counts = new Map<string, number>(), totals = new Map<string, number>();
  const modelUsage = new Map<string, { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    cost: number; costAvailable: boolean; estimatedCost: number; pricedRequests: number; unpricedRequests: number;
    pricingComplete: boolean; complete: boolean }>();
  let usageComplete = true;
  for (const session of sessions) {
    for (const [model, tokens] of Object.entries(session.models)) {
      if (tokens === null || model === "未分類") usageComplete = false;
      const observed = session.modelUsage?.[model];
      // A missing request leaves models[model] null. The independent accumulator still
      // contains real usage from this model's other requests, including older snapshots.
      const measured = tokens ?? observed?.tokens;
      if (measured !== undefined) {
        if (measured > 0) totals.set(model, (totals.get(model) ?? 0) + measured);
        const aggregate = modelUsage.get(model) ?? { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          cost: 0, costAvailable: true, estimatedCost: 0, pricedRequests: 0, unpricedRequests: 0,
          pricingComplete: true, complete: true };
        if (observed === undefined || observed.tokens !== measured) aggregate.complete = false;
        else {
          aggregate.uncachedInputTokens += observed.uncachedInputTokens;
          aggregate.cacheReadTokens += observed.cacheReadTokens;
          aggregate.cacheWriteTokens += observed.cacheWriteTokens;
          aggregate.cost += observed.cost;
          aggregate.costAvailable &&= observed.costAvailable;
          aggregate.pricingComplete &&= observed.estimatedCost !== undefined && observed.pricedRequests !== undefined &&
            observed.unpricedRequests !== undefined;
          aggregate.estimatedCost += observed.estimatedCost ?? 0;
          aggregate.pricedRequests += observed.pricedRequests ?? 0;
          aggregate.unpricedRequests += observed.unpricedRequests ?? 0;
        }
        modelUsage.set(model, aggregate);
      }
    }
  }
  for (const session of children) {
    const models = Object.keys(session.models);
    const label = models.length === 0 ? "未分類" : models.length === 1 ? models[0]! : "混成";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = [...totals.values()].reduce((sum, tokens) => sum + tokens, 0);
  const pricing = [...modelUsage.values()].reduce((sum, usage) => ({ usd: sum.usd + usage.estimatedCost,
    pricedRequests: sum.pricedRequests + usage.pricedRequests, unpricedRequests: sum.unpricedRequests + usage.unpricedRequests,
    complete: sum.complete && usage.pricingComplete }), { usd: 0, pricedRequests: 0, unpricedRequests: 0, complete: true });
  const commands = new Set(contract?.criteria.flatMap((criterion) => criterion.validation_command === undefined ? [] : [fingerprint(criterion.validation_command)]));
  const checks = sessions.flatMap((session) => session.checks.filter((check) => commands.has(check.command))).sort((a, b) => a.end - b.end);
  // Retain canonical proof even when an unrelated host tool lacks timing/metadata.
  for (const { event } of records ?? []) {
    if ((event.kind !== "unit.settled" && event.kind !== "unit.evidence-reconciled") || event.goal_id !== receipt.goal_id) continue;
    for (const evidence of event.evidence ?? []) {
      const command = fingerprint(evidence.execution.command.join(" "));
      const start = Date.parse(evidence.execution.started_at), end = Date.parse(evidence.execution.ended_at);
      if (receipt.evidence_refs.includes(evidence.evidence_id) && commands.has(command) &&
        Number.isFinite(start) && Number.isFinite(end)) checks.push({ start, end, command,
          passed: evidence.execution.exit_code === 0 && evidence.execution.outcome === "pass" });
    }
  }
  checks.sort((a, b) => a.end - b.end);
  const latest = new Map<string, Check>();
  for (const check of checks) latest.set(check.command, check);
  const validation = [...latest.values()].some((check) => !check.passed) ? "FAIL"
    : commands.size > 0 && latest.size === commands.size ? "PASS" : "未確認";
  const reviews = sessions.flatMap((session) => session.reviews).sort((a, b) => a.at - b.at);
  const validationEvents = records?.filter(({ event }) => event.goal_id === receipt.goal_id &&
    (event.kind === "validation.admission" || event.kind === "validation.settled")).map(({ event }) => event) ?? [];
  const validationDurations = validationEvents.flatMap(event => event.kind === "validation.settled" &&
    event.outcome === "passed" && event.exit_code === 0 && event.duration_ms !== undefined ? [event.duration_ms] : []);
  const durationGuidance = validationDurationGuidance(validationDurations);
  const validationEfficiency: Debrief["validationEfficiency"] = {
    completed: validationEvents.filter(event => event.kind === "validation.settled").length,
    skipped: validationEvents.filter(event => event.kind === "validation.admission" && event.decision === "SKIP").length,
    rejected: validationEvents.filter(event => event.kind === "validation.admission" && event.decision === "DENY").length,
    redundantMilliseconds: validationEvents.reduce((total, event) => total +
      (event.kind === "validation.admission" && event.decision === "SKIP" ? event.saved_ms ?? 0 : 0), 0),
    medianMilliseconds: durationGuidance.median_ms,
    p90Milliseconds: durationGuidance.p90_ms,
  };
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
      (event.kind === "validation.admission" && event.decision !== "ALLOW") || (event.kind === "validation.settled" && event.outcome !== "passed")) &&
     sessions.every((session) => !session.failed && new Set(session.checks.map((check) => check.command)).size === session.checks.length)) traits.push("一発完遂");
  const cleanDisqualified = validation === "FAIL" || recovered || sessions.some(session => session.failed ||
    new Set(session.checks.map(check => check.command)).size !== session.checks.length) ||
    new Set(tasks).size !== tasks.length || settled.some(event => event.disposition !== "succeeded" || event.result_class !== "acceptance") ||
    events?.some(event => event.kind === "goal.replanned" || event.kind === "goal.user-continued" || event.kind === "goal.revised" ||
      event.kind === "validation.admission" && event.decision !== "ALLOW" ||
      event.kind === "validation.settled" && event.outcome !== "passed");
  const clean: ConditionState = traits.includes("一発完遂") ? "true" : cleanDisqualified ? "false" : "unknown";
  const recovery: ConditionState = traits.includes("修正から復帰") ? "true"
    : complete && commands.size > 0 && validation === "PASS" ? "false" : "unknown";
  const coordination: ConditionState = traits.includes("連携作戦") ? "true" : timingComplete ? "false" : "unknown";
  const rare = evaluateRareAwards(receipt.status === "succeeded", clean, recovery, coordination);
  const review = reviews.filter((entry) => !sessions.some((session) => (session.lastPossibleMutation ?? 0) > entry.at ||
    session.mutations.some((edit) => edit.end > entry.at))).at(-1);
  const packComplete = observation.complete && sessions.every(session => session.root || session.timingComplete || Object.keys(session.models).length > 0);
  return { pack: packComplete ? [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([model, count]) => ({ model, count })) : null,
    mix: total > 0 ? [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([model, tokens]) => {
      const usage = modelUsage.get(model);
      return { model, tokens, percent: tokens / total * 100,
        ...(usage?.complete ? { inputCache: { uncachedInputTokens: usage.uncachedInputTokens,
          cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens } } : {}),
        ...(usage ? { estimatedCost: { usd: usage.estimatedCost, pricedRequests: usage.pricedRequests,
          unpricedRequests: usage.unpricedRequests,
          complete: usage.complete && usage.pricingComplete && usage.unpricedRequests === 0 && usage.pricedRequests > 0 } } : {}),
        ...(usage?.complete && usage.costAvailable && tokens > 0 && usage.cost === 0 ? { hostCostZero: true } : {}) };
    }) : null,
    mixCoverage: { complete: observation.complete && usageComplete, observedTokens: total },
    ...(pricing.complete && pricing.pricedRequests + pricing.unpricedRequests > 0 ? { estimatedCost: {
      usd: pricing.usd, pricedRequests: pricing.pricedRequests, unpricedRequests: pricing.unpricedRequests } } : {}),
    validation, review: review?.status ?? "未確認", reviewSource: review?.source ?? "controller", traits, firstPassEligible,
    rare, rareRecord: "unavailable",
    validationEfficiency,
    notes: [...(!observation.complete ? ["host履歴の取得が一部不足"] : []),
      ...(!usageComplete ? ["モデルIDまたはusageの記録が不足"] : []),
      ...(!timingComplete ? ["稼働区間の時刻が不足（token集計とは独立）"] : [])],
    ...(timingComplete ? { overlap: { workerMilliseconds: children.reduce((sum, child) => sum + unionDuration(child.spans), 0),
      wallMilliseconds: unionDuration(spans) } } : {}) };
}

const label = (text: string): string => text.replace(/[\r\n\t]/gu, " ");
const milliseconds = (value: number | null, locale: ReportLocale = "ja"): string => value === null ? reportText(locale)("未記録", "Unrecorded")
  : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(2)}s`;
const dollars = (usd: number): string => `$${usd.toFixed(usd > 0 && usd < 0.00005 ? 6 : 4)}`;
const gauge = (percent: number): string => {
  const eighths = Math.max(0, Math.min(80, Math.round(percent * 0.8)));
  const whole = Math.floor(eighths / 8), remainder = eighths % 8;
  const partial = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][remainder]!;
  return `${"█".repeat(whole)}${partial}${" ".repeat(10 - whole - (remainder === 0 ? 0 : 1))}`;
};

/** Display existing observations only; titles never select an execution policy. */
export function debriefOperationTitle(debrief: Debrief | undefined, completed: boolean): string | undefined {
  if (!completed) return undefined;
  const traits = debrief?.traits ?? [];
  if (traits.includes("修正から復帰")) return "立て直し屋";
  if (traits.includes("一発完遂")) return undefined; // Reclassified, never a second achievement under an alias.
  if (traits.includes("連携作戦")) return "連携上手";
  return undefined;
}

export function renderDebriefTraits(debrief: Debrief | undefined, completed: boolean, locale = resolveReportLocale()): string[] {
  const t = reportText(locale);
  const traits = debrief?.traits ?? [];
  const title = debriefOperationTitle(debrief, completed);
  const earned = completed && debrief?.rareRecord === "saved" ? RARE_RULES.filter(rule =>
    rareEvaluation(debrief.rare, rule.id)?.status === "earned") : [];
  return [
    `${t("作戦称号", "Operation title")}      ${title === "立て直し屋" ? t(title, "Recovery Specialist") : title === "連携上手" ? t(title, "Formation Specialist") : earned.some(rule => rule.id === "rare.clean-sweep") ? t("特別記章へ集約", "Listed under special insignia") : completed ? t("判定保留（根拠未確認）", "Pending (evidence unconfirmed)") : t("未授与（未完了）", "Not awarded (unfinished)")}`,
    ...earned.map(rule => `${t("特別記章", "Special insignia")}      ${rareDisplay(rule.id, locale).title} — ${t("獲得記録あり", "Award recorded")}`),
  ];
}

/** Evidence belongs after the main result, without awarding the same fact twice. */
export function renderDebriefTraitEvidence(debrief: Debrief | undefined, completed: boolean, locale = resolveReportLocale()): string[] {
  const t = reportText(locale);
  const traits = debrief?.traits ?? [];
  return [
    t("✎ 称号・観測の根拠", "✎ Title and observation evidence"),
    ...(!completed ? [t("特別記章 — 未授与（正式成功なし）", "Special insignia — not awarded (no formal success)")] : debrief?.rareRecord !== "saved"
      ? [debrief?.rareRecord === "legacy" ? t("特別記章 — 旧記録のため未判定", "Special insignia — legacy record, not evaluated") : t("特別記章 — 保存判定未取得（授与未確認）", "Special insignia — saved evaluation unavailable (award unconfirmed)")]
      : RARE_RULES.map(rule => {
        const evaluation = rareEvaluation(debrief.rare, rule.id);
        const display = rareDisplay(rule.id, locale);
        const evidence = evaluation?.evidence.map(code => {
          if (code === "receipt.succeeded") return t("正式成功", "Formal success");
          if (code === "receipt.not-succeeded") return t("正式成功なし", "No formal success");
          const [condition, state] = code.split(".");
          const name = condition === "clean-sweep" ? t("一発完遂", "Clean Sweep") : condition === "recovery" ? t("修正復帰", "Recovery") : t("並行稼働", "Overlap");
          return `${name}: ${state === "true" ? t("確認", "confirmed") : state === "false" ? t("不成立確認", "confirmed false") : t("根拠不足", "insufficient evidence")}`;
        }).join(" · ");
        return `${display.title}${t("の条件", " conditions")} — ${display.reason} / ${evaluation?.status === "earned" ? t("成立", "Confirmed") : evaluation?.status === "not-earned" ? t("非該当", "Not applicable") : t("判定不能（根拠不足・未対応ルール含む）", "Unknown (insufficient evidence or unsupported rule)")}${evidence ? ` / ${evidence}` : ""}`;
      })),
    ...(traits.includes("連携作戦") ? [t("🐾 連携作戦 — 異なる子セッションの稼働区間が重複（成果成功の判定ではありません）", "🐾 Pack Tactics — activity spans of different child sessions overlap (not a success judgment)")] : []),
    ...(completed && traits.includes("修正から復帰") ? [t("↩️ 修正から復帰 — 同じ子セッションで対象検証失敗→変更→同じ検証成功、任務完了", "↩️ Recovery — same child session: target check failed → edit → same check passed; mission completed")] : []),
    ...(completed && traits.includes("一発完遂") ? [t("一発完遂の条件 — 完全な対象履歴で再試行・再計画・検証失敗なし、対象検証PASS・任務完了", "Clean Sweep conditions — complete target history, no retries, replans or failed checks; target checks PASS and mission completed")] : []),
    ...(!traits.includes("連携作戦") && !(completed && traits.some(trait => trait === "修正から復帰" || trait === "一発完遂"))
      ? [t("特性の根拠未確認（未観測と該当なしは区別できません）", "Trait evidence unconfirmed (unobserved cannot be distinguished from absent)")] : []),
    t("※今回の観測のみ。別名・組合せの二重加算なし。称号は実行方針・検証・Review・Acceptanceを変更しません", "※This observation only. No duplicate counts for aliases or combinations. Titles do not change execution policy, validation, Review or Acceptance."),
    t("※レアは厳密条件・組合せの特別認定。出現率は未計測。再表示は再授与ではありません", "※Special recognition for strict conditions or combinations; frequency unmeasured. Redisplay is not a new award."),
    t("※記章目的の失敗作り・追加派遣・検証省略・再実行・支出は行いません", "※Do not manufacture failures, dispatch extra tasks, skip checks, rerun work or spend money for insignia."),
  ];
}
export function renderDebrief(debrief: Debrief | undefined, locale = resolveReportLocale()): string[] {
  const t = reportText(locale);
  const validationEfficiency = debrief?.validationEfficiency ?? {
    completed: 0, skipped: 0, rejected: 0, redundantMilliseconds: 0, medianMilliseconds: null, p90Milliseconds: null,
  };
  const pack = debrief?.pack == null ? null : [...debrief.pack].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  const packVisible = pack?.slice(0, 4) ?? [];
  if (pack !== null && pack.length > 4) packVisible.push({ model: "その他", count: pack.slice(4).reduce((sum, entry) => sum + entry.count, 0) });
  const mix = debrief?.mix == null ? null : [...debrief.mix].sort((a, b) =>
    (b.estimatedCost?.pricedRequests ? 1 : 0) - (a.estimatedCost?.pricedRequests ? 1 : 0) ||
    (b.estimatedCost?.usd ?? 0) - (a.estimatedCost?.usd ?? 0) || b.tokens - a.tokens || a.model.localeCompare(b.model));
  const pricedUsd = mix?.reduce((sum, entry) => sum + (entry.estimatedCost?.usd ?? 0), 0) ?? 0;
  const hasPriced = mix?.some(entry => (entry.estimatedCost?.pricedRequests ?? 0) > 0);
  const partiallyPriced = debrief?.mixCoverage?.complete === false || mix?.some(entry => !entry.estimatedCost?.complete);
  const visible = mix?.slice(0, 4) ?? [];
  if (mix !== null && mix.length > 4) {
    const tail = mix.slice(4);
    const cacheKnown = tail.every((entry) => entry.inputCache !== undefined);
    visible.push({ model: "その他", tokens: tail.reduce((sum, entry) => sum + entry.tokens, 0),
      percent: tail.reduce((sum, entry) => sum + entry.percent, 0),
      estimatedCost: { usd: tail.reduce((sum, entry) => sum + (entry.estimatedCost?.usd ?? 0), 0),
        pricedRequests: tail.reduce((sum, entry) => sum + (entry.estimatedCost?.pricedRequests ?? 0), 0),
        unpricedRequests: tail.reduce((sum, entry) => sum + (entry.estimatedCost?.unpricedRequests ?? 0), 0),
        complete: tail.every(entry => entry.estimatedCost?.complete) },
      ...(cacheKnown ? { inputCache: {
        uncachedInputTokens: tail.reduce((sum, entry) => sum + entry.inputCache!.uncachedInputTokens, 0),
        cacheReadTokens: tail.reduce((sum, entry) => sum + entry.inputCache!.cacheReadTokens, 0),
        cacheWriteTokens: tail.reduce((sum, entry) => sum + entry.inputCache!.cacheWriteTokens, 0),
      } } : {}),
      ...(tail.some((entry) => entry.hostCostZero) ? { hostCostZero: true } : {}) });
  }
  const counts = new Map(packVisible.map((entry) => [entry.model, entry.count]));
  return [
    `${t("モデル内訳", "Model breakdown")}    ${mix === null ? t("usage未取得", "usage unavailable") : !hasPriced
      ? t("予測費用未換算（モデル別token数）", "Estimate unpriced (tokens by model)") : pricedUsd === 0
        ? t("予測費用比率（合計$0・算出不可）", "Estimated cost shares (total $0; unavailable)") : partiallyPriced
          ? t("換算済み予測費用の比率（一部未換算）", "Priced estimate shares (partly unpriced)") : t("予測費用比率", "Estimated cost shares")}`,
    ...visible.map((entry) => {
      const count = counts.get(entry.model);
      const input = entry.inputCache === undefined ? 0 : entry.inputCache.uncachedInputTokens +
        entry.inputCache.cacheReadTokens + entry.inputCache.cacheWriteTokens;
      const cache = entry.inputCache === undefined || input === 0 ? t("未取得", "unavailable") : `${(entry.inputCache.cacheReadTokens / input * 100).toFixed(0)}%`;
      const cost = entry.estimatedCost;
      const share = cost?.pricedRequests
        ? pricedUsd > 0
          ? `${gauge(cost.usd / pricedUsd * 100)} ${(cost.usd / pricedUsd * 100).toFixed(1)}% · ${dollars(cost.usd)}${cost.complete ? "" : t("（一部未換算）", " (partly unpriced)")}`
          : `${t("比率算出不可", "share unavailable")} · ${dollars(cost.usd)}`
        : t("費用未換算", "unpriced");
      return `🐕 ${entry.model === "その他" ? t("その他", "Other") : entry.model === "未分類" ? t("未分類", "Unclassified") : label(entry.model)} ${share} · ${entry.tokens.toLocaleString(locale)} ${locale === "en" && entry.tokens === 1 ? "token" : "tokens"}${count === undefined ? "" : ` ×${count}`} ↺${cache}${entry.hostCostZero ? "†" : ""}`;
    }),
    ...(visible.some((entry) => entry.hostCostZero) ? [t("   †host費用0計上あり（無料・全体価格の評価ではありません）", "   †Some host costs recorded as zero (not a claim of free use or total price)")] : []),
    `⚡ ${t("実行重複率", "Execution overlap")} ${debrief?.overlap !== undefined && debrief.overlap.wallMilliseconds > 0
      ? `${(debrief.overlap.workerMilliseconds / debrief.overlap.wallMilliseconds).toFixed(2)}×`
      : pack?.length === 0 ? t("対象なし（出撃なし）", "Not applicable (no dispatches)") : t("稼働区間の記録不足", "Activity spans incomplete")}`,
    t("   ※worker区間・速度倍率ではありません", "   ※Worker spans, not a speed multiplier"),
    `${t("検証効率", "Validation efficiency")}      ${t("完了", "completed ")}${validationEfficiency.completed} · skip${validationEfficiency.skipped} · reject${validationEfficiency.rejected} · ${t("重複回避", "redundancy avoided ")}${milliseconds(validationEfficiency.redundantMilliseconds, locale)}`,
    `${t("検証時間", "Validation time")}      median ${milliseconds(validationEfficiency.medianMilliseconds, locale)} · p90 ${milliseconds(validationEfficiency.p90Milliseconds, locale)}`,
    ...(debrief?.notes?.length ? [`${t("計測範囲", "Measurement scope")}      ${debrief.notes.map(note => locale === "ja" ? note : ({
      "host履歴の取得が一部不足": "Partial host history",
      "モデルIDまたはusageの記録が不足": "Model ID or usage records incomplete",
      "稼働区間の時刻が不足（token集計とは独立）": "Activity timestamps incomplete (independent of token aggregation)",
    }[note] ?? "Additional measurement limitation")).join(" · ")}`] : []),
  ];
}

export function renderDebriefProof(debrief: Debrief | undefined, locale = resolveReportLocale()): { validation: string; review: string } {
  const t = reportText(locale);
  const status = (value: string): string => value === "PASS" ? "🟢 PASS" : value === "FAIL" ? "🔴 FAIL"
    : value === "WAIVED" ? t("免除", "Waived") : t("未記録", "Unrecorded");
  const efficiency = debrief?.validationEfficiency;
  return { validation: `${status(debrief?.validation ?? "未確認")}${efficiency === undefined || efficiency.skipped === 0
    ? "" : t(`（再実行skip ${efficiency.skipped} / ${milliseconds(efficiency.redundantMilliseconds)}）`, ` (rerun skipped ${efficiency.skipped} / ${milliseconds(efficiency.redundantMilliseconds)})`)}`,
    review: `${status(debrief?.review ?? "未確認")}${debrief?.reviewSource === "reviewer" ? t("（reviewer報告）", " (reviewer report)") : ""}` };
}
