import type { WorkState } from "../core/work-loop.js";
import { formatSortieResult, type SortieResult, type SortieResultMetric } from "./run-metrics.js";
import type { SortieCareer } from "./sortie-career.js";
import { workOverview } from "../core/work-overview.js";

export interface WorkUsage {
  rows: Array<{ role: string; models: string[]; requests: number; tokens: number | null;
    estimated_usd: number | null; unpriced_requests: number; model_usage?: Array<{ model: string; tokens: number; requests: number }> }>;
  note: string;
}
const available = <T>(value: T): SortieResultMetric<T> => ({ availability: "available", value, provenance: "host-reported" });
const unknown = <T>(): SortieResultMetric<T> => ({ availability: "unavailable", value: null, reason: "incomplete-host-coverage" });

/** Adapt v0.11 receipts to the existing game-like renderer without constructing an execution contract. */
export function workReturnReport(work: WorkState, changed: string[], usage: WorkUsage | undefined, retained: WorkState[]) {
  const completed = work.phase === "completed", terminal = ["completed", "blocked", "interrupted", "cancelled"].includes(work.phase);
  if (!terminal) return undefined;
  const works = [...new Map([...retained, work].map(item => [item.id, item])).values()];
  const missing = { sum: 0, covered: 0 };
  const cumulativeModels = new Map<string, number>();
  for (const item of works) for (const model of item.usage?.models ?? []) {
    cumulativeModels.set(model.model, (cumulativeModels.get(model.model) ?? 0) + model.tokens);
  }
  const career: SortieCareer = {
    scope: "retained-project-goals", since: new Date(Math.min(...works.map(item => item.startedAt))).toISOString(),
    coverage: { files: works.length, included: works.length, unavailable: 0, truncated: works.length >= 1000 }, goals: works.length,
    completed: works.filter(item => item.phase === "completed").length,
    interrupted: works.filter(item => ["interrupted", "cancelled"].includes(item.phase)).length,
    external: works.filter(item => item.phase === "blocked").length, decision: 0,
    active: works.filter(item => ["ready", "running", "waiting", "review", "yielded"].includes(item.phase)).length,
    telemetryCovered: 0, firstPass: { count: 0, eligible: 0 },
    recoveries: works.filter(item => item.phase === "completed" && item.attempts > 1).length,
    tokens: { sum: works.reduce((sum, item) => sum + (item.usage?.tokens ?? 0), 0), covered: works.filter(item => item.usage?.tokens != null).length },
    models: [...cumulativeModels].map(([model, tokens]) => ({ model, tokens })), modelCovered: works.filter(item => item.usage?.tokens != null).length, workerTime: missing,
    goalWall: { sum: works.filter(item => ["completed", "blocked", "interrupted", "cancelled"].includes(item.phase))
      .reduce((sum, item) => sum + Math.max(0, item.updatedAt - item.startedAt), 0),
      covered: works.filter(item => ["completed", "blocked", "interrupted", "cancelled"].includes(item.phase)).length },
    overlap: { worker: 0, wall: 0, covered: 0, ratio: null }, titles: [],
  };
  const rows = usage?.rows ?? [], requests = rows.reduce((sum, item) => sum + item.requests, 0);
  const tokensKnown = !!usage && rows.every(item => item.tokens !== null);
  const tokens = rows.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  const mix = new Map<string, { model: string; tokens: number; requests: number }>();
  for (const row of rows) for (const usage of row.model_usage ?? []) {
    const previous = mix.get(usage.model) ?? { model: usage.model, tokens: 0, requests: 0 };
    previous.tokens += usage.tokens; previous.requests += usage.requests; mix.set(usage.model, previous);
  }
  const result: SortieResult = {
    schema_version: "0.1", result_id: [work.id, work.generation], accounting_phase: "pre-terminal",
    as_of: new Date(work.updatedAt).toISOString(), career,
    mission: { status: completed ? "COMPLETED" : work.phase === "blocked" ? "EXTERNAL_BLOCKER" : "INTERRUPTED",
      stop_reason: completed ? "completed" : work.phase === "blocked" ? "external_dependency" : "stopped" },
    speed: { goal_wall_ms: available(Math.max(0, work.updatedAt - work.startedAt)), worker_execution_ms: unknown(),
      execution_compression: unknown(), first_verifiable_ms: unknown(), first_usable_ms: unknown(), bare_comparison: unknown() },
    cost: { total_tokens: tokensKnown ? available(tokens) : unknown(), cost_usd: unknown(),
      model_steps: usage ? available(requests) : unknown(), sessions: available(new Set([work.root, ...(work.child ? [work.child] : []), ...(work.supportSessions ?? []).map(session => session.id)]).size) },
    proof: { overall: completed ? "PASS" : "UNPROVEN", acceptance_fingerprint: work.acceptedSource ?? "unaccepted",
      criteria: completed ? available(work.requests.map(item => ({ criterion_id: item.id, status: "PASS" as const }))) : unknown(),
      evidence_refs: work.acceptedChecks },
    debrief: {
      pack: usage ? [...mix.values()].map(row => ({ model: row.model, count: row.requests })) : null,
      mix: tokensKnown ? [...mix.values()].map(row => ({ model: row.model, tokens: row.tokens, percent: tokens ? row.tokens / tokens * 100 : 0 })) : null,
      ...(usage ? { estimatedCost: { usd: rows.reduce((sum, row) => sum + (row.estimated_usd ?? 0), 0),
        pricedRequests: rows.reduce((sum, row) => sum + row.requests - row.unpriced_requests, 0),
        unpricedRequests: rows.reduce((sum, row) => sum + row.unpriced_requests, 0) } } : {}),
      validation: completed && work.acceptedChecks.length ? "PASS" : "未確認", review: completed ? "PASS" : "未確認", reviewSource: "controller",
      traits: [], notes: ["v0.11保存作業。過去profileの戦績は別記録", usage?.note ?? "usage取得不可"],
      validationEfficiency: { completed: work.checks.length, skipped: 0, rejected: work.checks.filter(c => c.exit !== 0).length,
        redundantMilliseconds: 0, medianMilliseconds: null, p90Milliseconds: null },
    },
  };
  const overview = workOverview(work);
  const artifacts = completed ? work.sourceView?.changed ?? changed : changed;
  const summary = [`**🐾 任務一覧**`, `- **いま:** ${overview.current}`, `- **確認済み:** ${overview.done}`,
    `- **未解決:** ${overview.blocked}`, `- **推定費用:** ${overview.cost}（この報告は最終返答前の集計）`, `- **持ち帰り:** ${overview.returned}`].join("\n");
  return summary + "\n\n" + formatSortieResult(result, { statusSummary: work.assessment ?? work.phase,
    implementation: artifacts.length ? artifacts.join(", ") : "ソース変更なし。実行結果を確認",
    pending: completed ? "なし（受理済みの依頼範囲）" : work.assessment ?? "未完了",
    next: completed ? "なし" : "同じ作業・検証記録から継続", commit: "コミット操作の記録なし" });
}
