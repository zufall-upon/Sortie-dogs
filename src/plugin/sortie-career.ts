import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { goalFingerprint, type GoalFlightEventRecord, type GoalTerminalReceipt } from "../core/goal-bound.ts";
import { validGoalReport, type GoalReport } from "../core/goal-report.ts";

export interface CareerCoverage {
  readonly files: number;
  readonly included: number;
  readonly unavailable: number;
  readonly truncated: boolean;
}
export interface SortieCareer {
  readonly scope: "retained-project-goals";
  readonly since: string | null;
  readonly coverage: CareerCoverage;
  readonly goals: number;
  readonly completed: number;
  readonly interrupted: number;
  readonly external: number;
  readonly decision: number;
  readonly active: number;
  readonly telemetryCovered: number;
  readonly firstPass: { readonly count: number; readonly eligible: number };
  readonly recoveries: number;
  readonly tokens: { readonly sum: number; readonly covered: number };
  readonly models: readonly { readonly model: string; readonly tokens: number }[];
  readonly modelCovered: number;
  readonly workerTime: { readonly sum: number; readonly covered: number };
  readonly goalWall: { readonly sum: number; readonly covered: number };
  readonly overlap: { readonly worker: number; readonly wall: number; readonly covered: number; readonly ratio: number | null };
  readonly titles: readonly string[];
}

/** Rebuild from retained source records; no cache survives deletion, retention, or reset. */
export function summarizeCareer(histories: readonly (readonly GoalFlightEventRecord[])[], coverage: CareerCoverage): SortieCareer {
  const unique = new Map<string, GoalFlightEventRecord>();
  for (const history of histories) for (const record of history) unique.set(record.event_hash, record);
  const events = [...unique.values()].sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at) || a.sequence - b.sequence);
  const goals = new Map<string, { since: string | null; receipt: GoalTerminalReceipt | null;
    reports: Map<string, GoalReport>; units: Map<string, number | null> }>();
  for (const { event } of events) {
    if (!goals.has(event.goal_id) && event.kind !== "goal.accepted") continue;
    const goal = goals.get(event.goal_id) ?? { since: null, receipt: null, reports: new Map(), units: new Map() };
    goals.set(event.goal_id, goal);
    if (event.kind === "goal.accepted") goal.since ??= event.at;
    if (event.kind === "goal.terminal") goal.receipt = event.receipt;
    if (event.kind === "goal.user-continued" || event.kind === "goal.revised") goal.receipt = null;
    if (event.kind === "unit.settled") goal.units.set(event.reservation_id, event.elapsed_ms);
    if (event.kind === "goal.reported" && validGoalReport(event.report)) goal.reports.set(event.report.terminal_key, event.report);
  }
  let completed = 0, interrupted = 0, external = 0, decision = 0, active = 0, telemetryCovered = 0, recoveries = 0;
  const firstPass = { count: 0, eligible: 0 }, tokens = { sum: 0, covered: 0 }, workerTime = { sum: 0, covered: 0 }, goalWall = { sum: 0, covered: 0 };
  const models = new Map<string, number>();
  const overlap = { worker: 0, wall: 0, covered: 0, ratio: null as number | null };
  let modelCovered = 0, packTactics = false;
  for (const goal of goals.values()) {
    const receipt = goal.receipt;
    if (receipt === null) { active++; continue; }
    if (receipt.status === "succeeded") completed++;
    else if (receipt.stop_reason === "external_dependency" || receipt.stop_reason === "persistence_unavailable") external++;
    else if (receipt.stop_reason === "awaiting_user") decision++;
    else interrupted++;
    const elapsed = Date.parse(receipt.ended_at) - Date.parse(receipt.started_at);
    if (Number.isFinite(elapsed) && elapsed >= 0) { goalWall.sum += elapsed; goalWall.covered++; }
    if ([...goal.units.values()].every((value) => value !== null && Number.isFinite(value) && value >= 0)) {
      workerTime.sum += [...goal.units.values()].reduce<number>((sum, value) => sum + (value ?? 0), 0); workerTime.covered++;
    }
    const report = goal.reports.get(goalFingerprint(receipt));
    if (report === undefined) continue;
    telemetryCovered++;
    if (report.overlap !== undefined) { overlap.worker += report.overlap.worker_ms; overlap.wall += report.overlap.wall_ms; overlap.covered++; }
    if (report.first_pass_eligible && receipt.status === "succeeded") {
      firstPass.eligible++;
      if (report.traits.includes("clean-sweep")) firstPass.count++;
    }
    if (report.traits.includes("recovery") && receipt.status === "succeeded") recoveries++;
    if (report.traits.includes("pack-tactics")) packTactics = true;
    if (report.tokens !== null) { tokens.sum += report.tokens; tokens.covered++; }
    if (report.models !== null) {
      modelCovered++;
      for (const entry of report.models) models.set(entry.model, (models.get(entry.model) ?? 0) + entry.tokens);
    }
  }
  const dates = [...goals.values()].flatMap((goal) => goal.since === null ? [] : [goal.since]).sort((a, b) => Date.parse(a) - Date.parse(b));
  if (overlap.wall > 0) overlap.ratio = overlap.worker / overlap.wall;
  return { scope: "retained-project-goals", since: dates[0] ?? null, coverage, goals: goals.size,
    completed, interrupted, external, decision, active, telemetryCovered, firstPass, recoveries, tokens,
    models: [...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, tokens]) => ({ model, tokens })), modelCovered,
    workerTime, goalWall, overlap, titles: [
      ...(completed > 0 ? ["任務完遂の隊"] : []), ...(packTactics ? ["連携の隊"] : []),
      ...(recoveries > 0 ? ["復帰の隊"] : []), ...(firstPass.count > 0 ? ["一発完遂の隊"] : []),
    ] };
}

/** One bounded, read-only scan at terminal time. Current records are reused, not fetched again. */
export async function collectCareer(directories: readonly string[], currentPath: string,
  current: readonly GoalFlightEventRecord[], read: (path: string) => Promise<{ readonly records: readonly GoalFlightEventRecord[] }>,
  maxFiles = 64): Promise<SortieCareer> {
  const paths = new Set<string>();
  let unavailable = 0;
  for (const directory of new Set(directories)) {
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)) paths.add(resolve(join(directory, entry.name)));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unavailable++; }
  }
  paths.delete(resolve(currentPath));
  const selected = [...paths].sort().slice(0, Math.max(0, maxFiles - 1));
  const histories = [current];
  for (const path of selected) {
    try { histories.push((await read(path)).records); } catch { unavailable++; }
  }
  return summarizeCareer(histories, { files: paths.size + 1, included: histories.length, unavailable, truncated: selected.length < paths.size });
}

export function renderCareer(career: SortieCareer | undefined): string[] {
  if (career === undefined) return ["**📜 PACK RECORD:** 保存履歴を取得できません"];
  const terminal = career.goals - career.active;
  const firstPass = career.firstPass.eligible === 0 ? "計測不可（対象0件）" : `${career.firstPass.count}/${career.firstPass.eligible}件`;
  const minutes = (metric: { sum: number; covered: number }) => metric.covered === 0 ? "計測不可" : `${(metric.sum / 60000).toFixed(1)}分（${metric.covered}/${terminal}任務）`;
  const models = [...career.models].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  const modelText = models.slice(0, 4).map((entry) => `${entry.model.replace(/[\\`*_{}\[\]()<>!|\r\n]/gu, "").slice(0, 120)} ${entry.tokens.toLocaleString("ja-JP")}`).join(" · ");
  return [
    "**📜 PACK RECORD — 記録済み戦績**",
    `**戦績:** 完了 ${career.completed} · 中断 ${career.interrupted} · 外部待機 ${career.external} · 指示待ち ${career.decision} · 進行中 ${career.active}`,
    `**初回完遂:** ${firstPass} · 復帰 ${career.recoveries}件（計測記録 ${career.telemetryCovered}/${terminal}任務）`,
    `**累積使用量:** ${career.tokens.covered === 0 ? "計測不可" : `${career.tokens.sum.toLocaleString("ja-JP")} tokens`}（計測 ${career.tokens.covered}/${terminal}任務）`,
    `**累積モデル:** ${career.modelCovered === 0 ? "計測不可" : modelText || "出力なし"}${models.length > 4 ? " · ほか" : ""}（token計測 ${career.modelCovered}/${terminal}任務）`,
    `**累積時間:** worker ${minutes(career.workerTime)} · goal期間合計 ${minutes(career.goalWall)}（待機含む・同時刻重複あり）`,
    `**累積実行重複率:** ${career.overlap.ratio === null ? "計測不可" : `${career.overlap.ratio.toFixed(2)}×`}（総和の比・${career.overlap.covered}/${terminal}任務・速度倍率ではありません）`,
    `**保存範囲:** ${career.since?.slice(0, 10) ?? "開始日不明"}以降の現存履歴 · ${career.coverage.included}/${career.coverage.files}ファイル${career.coverage.unavailable || career.coverage.truncated ? " · 部分集計" : ""} · 生涯戦績ではありません`,
    ...(career.titles.length ? [`**🎖 隊の称号:** ${career.titles.join(" · ")}`] : []),
  ];
}
