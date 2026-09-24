import { workCheckCurrent, workUnresolvedChecks, type WorkState } from "./work-loop.js";
import { progressView, type WorkProgress } from "./work-progress.js";

export { WORK_OVERVIEW_RPC } from "./work-overview-rpc.js";
const short = (value: string, length = 160) => value.replace(/\s+/gu, " ").slice(0, length);

export function pendingWorkOverview(progress: WorkProgress, now = Date.now()) {
  return { work_id: null, phase: "thinking", elapsed_ms: Math.max(0, now - progress.startedAt),
    current: "依頼受付・最初の実行待ち", done: "確認済みの成果はまだありません", blocked: "作業未開始",
    cost: "未集計／使用量不明（0ドルではありません）", cost_as_of: null, returned: "成果物はまだありません" };
}

export function workOverview(work: WorkState, now = Date.now()) {
  const progress = work.progress ? progressView(work.progress, now) : undefined;
  const complete = work.phase === "completed";
  const source = work.sourceView?.fingerprint ?? work.acceptedSource ?? "unobserved";
  const pending = work.checks.filter(check => check.pending);
  const unresolved = workUnresolvedChecks(work, source).filter(check => !check.pending);
  const passed = work.checks.filter(check => check.exit === 0 && !check.interrupted && !check.timedOut && !check.pending && workCheckCurrent(work, check, source));
  const commands = (work.commands ?? []).filter(command => !work.commands!.some(retry => retry.retryOf === command.id));
  const unverified = commands.filter(command => command.status !== "launching" && (command.status !== "completed" || command.exit !== 0));
  const changed = work.sourceView?.changed;
  const known = work.usage?.estimatedUsd ?? work.usage?.usd;
  const unknown = work.usage?.unpricedRequests;
  const cost = typeof known === "number" && work.usage?.requests !== 0 ? `既知分 推定$${known.toFixed(4)}${unknown ? ` + 使用量不明 ${unknown}件` : ""}（未確定分を除く・請求額ではありません）`
    : "未集計／使用量不明（0ドルではありません）";
  const blockers = [
    ...(unresolved.length ? [`必須検証の未成功・再確認待ち ${unresolved.length}件: ${short(unresolved.at(-1)!.command, 80)}`] : []),
    ...(unverified.length ? [`開始エラー・未確認の実行 ${unverified.length}件: ${short(unverified.at(-1)!.command, 80)}`] : []),
    ...(work.controller && ["failed", "launch-failed"].includes(work.controller.status) ? [`controller: ${work.controller.status}`] : []),
    ...(work.progress?.stopped ? [`内部の軌道修正: ${short(work.progress.stopped.reason, 80)}`] : []),
  ];
  const phase = complete ? "returned" : ["blocked", "interrupted", "cancelled", "waiting"].includes(work.phase) ? work.phase : progress?.phase ?? work.phase;
  return {
    work_id: work.id, phase,
    elapsed_ms: Math.max(0, (complete ? work.updatedAt : now) - work.startedAt),
    current: complete ? "依頼全体を受理・帰還済み" : work.phase === "blocked" ? "外部問題で停止中" : ["interrupted", "cancelled"].includes(work.phase) ? "中断・記録保持"
      : work.phase === "waiting" ? `既存controller: ${work.controller?.status ?? "確認中"}` : pending.length ? `必須検証実行中: ${short(pending.at(-1)!.command, 100)}` : short(progress?.summary ?? work.phase),
    done: complete ? `依頼全体を検証・受理（${work.acceptedChecks.length}件の採用チェック）`
      : `${passed.length ? `直近確認ソースで検証PASS ${passed.length}件: ${short(passed.at(-1)!.command, 80)}` : "直近確認ソースの検証PASSはまだありません"}。依頼全体は未受理`,
    blocked: complete ? "なし（受理した依頼範囲）" : work.phase === "blocked" ? short(work.assessment ?? "外部問題を確認中")
      : ["interrupted", "cancelled"].includes(work.phase) ? "中断中。作業・検証記録を保持"
        : blockers.join("。") || "既知のブロッカーなし。実装・検証または最終受理待ち",
    cost, cost_as_of: work.usage?.meteredAt ?? null,
    returned: complete ? `${changed?.length ? `受理時の変更: ${short(changed.join(", "), 100)}。` : "実行結果を受理。"}記録 ${work.id}`
      : changed?.length ? `直近確認の変更: ${short(changed.join(", "), 100)}（未受理）` : "受理済みの成果物はまだありません",
    source_as_of: work.sourceView?.at ?? null,
    note: `操作・チェックの成功と依頼全体の受理を区別します。ソースは${complete ? "受理時点" : "直近確認時点"}、費用は保存済み使用量の推定です。`,
  };
}
