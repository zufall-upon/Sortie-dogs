import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { goalFingerprint, type GoalFlightEventRecord, type GoalTerminalReceipt } from "../core/goal-bound.ts";
import { validGoalReport, type GoalReport } from "../core/goal-report.ts";
import { RARE_RULES, rareEvaluation } from "../core/rare-awards.ts";
import { rareDisplay } from "./sortie-debrief.ts";
import { reportText, resolveReportLocale } from "./report-locale.ts";

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
  readonly rare: readonly { readonly id: string; readonly earned: number; readonly notEarned: number;
    readonly unknown: number; readonly legacy: number }[];
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
    if (event.kind === "goal.reported" && validGoalReport(event.report) && !goal.reports.has(event.report.terminal_key)) goal.reports.set(event.report.terminal_key, event.report);
  }
  let completed = 0, interrupted = 0, external = 0, decision = 0, active = 0, telemetryCovered = 0, recoveries = 0;
  const firstPass = { count: 0, eligible: 0 }, tokens = { sum: 0, covered: 0 }, workerTime = { sum: 0, covered: 0 }, goalWall = { sum: 0, covered: 0 };
  const models = new Map<string, number>();
  const overlap = { worker: 0, wall: 0, covered: 0, ratio: null as number | null };
  let modelCovered = 0, packTactics = false;
  const rare = RARE_RULES.map(rule => ({ id: rule.id, earned: 0, notEarned: 0, unknown: 0, legacy: 0 }));
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
    if (receipt.status === "succeeded") for (const item of rare) {
      if (report === undefined) item.unknown++;
      else if (report.rare === undefined) item.legacy++;
      else {
        const evaluation = rareEvaluation(report.rare, item.id);
        if (evaluation?.status === "earned") item.earned++;
        else if (evaluation?.status === "not-earned") item.notEarned++;
        else item.unknown++;
      }
    }
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
    workerTime, goalWall, overlap, rare, titles: [
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

export function renderCareer(career: SortieCareer | undefined, locale = resolveReportLocale()): string[] {
  const t = reportText(locale);
  if (career === undefined) return ["📜 PACK RECORD", t("保存履歴を取得できません", "Saved history unavailable")];
  const terminal = career.goals - career.active;
  const missions = (count: number) => count === 1 ? " mission" : " missions";
  const minutes = (metric: { sum: number; covered: number }) => metric.covered === 0 ? t("計測不可", "Unavailable") : `${(metric.sum / 60000).toFixed(1)}${t("分", " min")} ※${metric.covered}/${terminal}${t("任務", missions(terminal))}`;
  return [
    "📜 PACK RECORD",
    `🏁 ${t("完了", "Completed")} ${career.completed}`,
    `🟡 ${t("中断", "Interrupted")} ${career.interrupted}`,
    `⏳ ${t("外部待機", "External wait")} ${career.external}`,
    `❓ ${t("指示待ち", "Awaiting decision")} ${career.decision}`,
    `🔄 ${t("進行中", "Active")} ${career.active}`,
    `↩️ ${t("復帰", "Recoveries")} ${career.recoveries}`,
    t("※今回ではなく保存履歴の戦績。進行中は終端記録なし（現在の稼働確認ではありません）", "※Saved history, not this mission. Active means no terminal record, not confirmation of current activity."),
    t(`※復帰は成功任務の同一子セッション内の検証失敗→変更→同じ検証成功のみ。報告取得 ${career.telemetryCovered}/${terminal}任務`, `※Recovery requires a successful mission and same-child check failure → edit → same check success. Reports ${career.telemetryCovered}/${terminal}${missions(terminal)}`),
    `🎯 ${t("一発完遂", "Clean Sweep")} ${career.firstPass.count}/${career.firstPass.eligible}${t("判定対象任務", ` eligible${missions(career.firstPass.eligible)}`)}`,
    "",
    t("🎖 PACK獲得称号（保存履歴）", "🎖 PACK titles (saved history)"),
    ...([
      ["任務完遂の隊", t("任務完遂の隊", "Mission Accomplished Pack"), t("保存された正式receiptに任務完了あり", "Formal saved receipt confirms mission completion")],
      ["連携の隊", t("連携の隊", "Formation Pack"), t("報告に異なる子セッションの稼働区間重複あり（成功称号ではありません）", "Report records overlapping child sessions (not a success title)")],
      ["復帰の隊", t("復帰の隊", "Recovery Pack"), t("成功任務に上記の限定された復帰記録あり", "Successful mission with the narrowly defined recovery above")],
      ["一発完遂の隊", t("一発完遂の隊", "Clean Sweep Pack"), t("判定対象の成功任務に再試行・再計画・検証失敗なし", "Eligible successful mission without retries, replans or failed checks")],
    ] as const).filter(([id]) => career.titles.includes(id)).map(([, title, reason]) => `${title} — ${reason}`),
    ...(career.titles.length === 0 ? [t("判定保留 — 保存範囲で確認できた称号なし", "Pending — no titles confirmed in retained scope")] : []),
    "",
    t("特別記章（保存履歴・記章別／合算しません）", "Special insignia (saved history; separate, never summed)"),
    ...(career.rare.filter(item => item.earned > 0).map(item =>
      `${rareDisplay(item.id, locale).title} — ${t(`${item.earned}任務に獲得記録あり`, `Award recorded in ${item.earned}${missions(item.earned)}`)}`)),
    ...(career.rare.every(item => item.earned === 0) ? [t("確認できた獲得記録なし（未獲得の断定ではありません）", "No confirmed award records (not a claim of never earned)")] : []),
    ...career.rare.map(item => `${rareDisplay(item.id, locale).title}${t(`の判定範囲 — 成功${career.completed}任務中 非該当${item.notEarned}・判定不能${item.unknown}・旧未判定${item.legacy}`, ` coverage — ${career.completed} successful${missions(career.completed)}: not applicable ${item.notEarned} · unknown ${item.unknown} · legacy unevaluated ${item.legacy}`)}`),
    t("※同じ任務・現在の正式receiptにつき各記章1件。再開中の旧獲得は除外。通常称号の別名を追加実績にしません", "※One record per insignia per mission's current formal receipt. Old awards excluded while reopened. Title aliases are not extra achievements."),
    "",
    `🪙 ${t("累積使用量", "Cumulative usage")} ${career.tokens.covered === 0 ? t("計測不可", "Unavailable") : `${career.tokens.sum.toLocaleString(locale)} ${locale === "en" && career.tokens.sum === 1 ? "token" : "tokens"}`} ※${career.tokens.covered}/${terminal}${t("任務", missions(terminal))}`,
    `⏱ ${t("累積worker", "Cumulative worker")} ${minutes(career.workerTime)}`,
    `🕰 ${t("累積goal", "Cumulative goal")} ${minutes(career.goalWall)} ${t("※待機・重複含む", "※Includes waiting and overlap")}`,
    `⚡ ${t("累積重複率", "Cumulative overlap")} ${career.overlap.ratio === null ? t("計測不可", "Unavailable") : `${career.overlap.ratio.toFixed(2)}×`} ※${career.overlap.covered}/${terminal}${t("任務・速度倍率ではありません", `${missions(terminal)}; not a speed multiplier`)}`,
    "",
    t("📦 保存範囲", "📦 Retained scope"),
    `${career.since?.slice(0, 10) ?? t("開始日不明", "Unknown start")}${t("以降", " onward")} / ${career.coverage.included} of ${career.coverage.files}${career.coverage.files === 1 ? " file" : " files"}${career.coverage.unavailable || career.coverage.truncated ? t(" ※部分集計", " ※Partial aggregation") : ""}`,
    t("※生涯戦績ではありません", "※Not a lifetime record"),
    t("※称号も上記保存範囲のみ。未取得・削除済み履歴は判定しません", "※Titles cover only the retained scope above. Missing or deleted history is not evaluated."),
  ];
}
