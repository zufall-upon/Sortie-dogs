import { randomUUID } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireRunLock, releaseRunLock, writeAtomicJson } from "./swebench-lite-supervisor.mjs";

const exec = promisify(execFile);
const read = path => readFile(path, "utf8").then(JSON.parse, error => {
  if (error.code === "ENOENT") return null;
  throw error;
});

// Hermes prunes terminal delivery payloads. Bind to its actual execution ID,
// not stdout, a nearby timestamp, or the job's last_status=ok.
export async function hermesDelivery(config, last) {
  const settings = config.notifications;
  if (!settings?.hermes_home || !settings.job_id) return {};
  const script = `
import json,os,sqlite3,sys
from pathlib import Path
home,job,previous=sys.argv[1:]
path=Path(home)/'cron'/'executions.db'
if not path.exists():
 print('{}');sys.exit(0)
db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
ancestors={};pid=os.getpid()
while pid>0:
 try:
  fields=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
  ancestors[pid]=int(fields[19]);pid=int(fields[1])
 except (OSError,ValueError):break
current=next((r['id'] for r in db.execute("select id,pid,process_started_at from executions where job_id=? and status in ('claimed','running') order by claimed_at desc",(job,)) if ancestors.get(r['pid'])==r['process_started_at']),None)
result={'current_execution_id':current}
if previous:
    row=db.execute('select id,status,delivery_outcome,finished_at,error from executions where id=? and job_id=?',(previous,job)).fetchone()
    if row:
        result['last']=dict(row)
        sent=None
        delivery=Path(home)/'cron'/'deliveries.db'
        if delivery.exists():
            d=sqlite3.connect('file:'+str(delivery)+'?mode=ro',uri=True);d.row_factory=sqlite3.Row
            sent=d.execute('select status,finished_at,error from deliveries where execution_id=?',(previous,)).fetchone()
            if sent:result['last'].update(dict(sent))
        if not sent and result['last']['status'] in ('completed','failed') and result['last']['delivery_outcome']:
            result['last']['status']=result['last']['delivery_outcome']
print(json.dumps(result))
`;
  const { stdout } = await exec("python3", ["-c", script, settings.hermes_home, settings.job_id,
    last?.execution_id ?? ""], { timeout: 10_000 });
  return JSON.parse(stdout);
}

const FORMAT_VERSION = 2;

function japaneseLine(value, fallback, limit = 70) {
  if (typeof value !== "string" || !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value) ||
    /[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){3,}/u.test(value)) return fallback;
  const text = value.replace(/https?:\/\/\S+|\/(?:[\w.-]+\/)+[\w/.-]+|\b(?:ses|msg)_[\w]+|\b[a-f0-9]{12,}\b/gu, "")
    .replace(/[\r\n\u2028\u2029\s]+/gu, " ").replace(/[*`#]/gu, "").trim();
  if (!text) return fallback;
  if ([...text].length <= limit) return text;
  let summary = "";
  for (const sentence of text.split(/(?<=[。！？])/u)) {
    if ([...summary + sentence].length > limit) break;
    summary += sentence;
  }
  return summary.trim() || fallback;
}

export function formatNotification(config, result) {
  const labels = { dispatched: "次の作業を開始", running: "作業中", waiting: "実行結果待ち",
    paused: "停止中", blocked: "停止", complete: "完了", "needs-input": "回答待ち", "needs-host": "ホスト操作待ち" };
  const money = value => `$${value.toFixed(2)}`;
  const budget = result.budget;
  const names = { "sortie-dogs-dev23": "Sortie-dogs", "vibe-dev-mate-kanban": "Vibe-Dev-Mate" };
  const stale = result.reason === "new-owner-instruction" ||
    (["running", "dispatched"].includes(result.action) && result.handoff?.status === "blocked");
  const handoff = stale ? null : result.handoff;
  const brief = handoff?.notification ?? {};
  const progress = result.proof?.progress?.at(-1);
  const campMismatch = config.id === "vibe-dev-mate-kanban"
    ? (result.reason ?? "").match(/Camp.*?revision\s*(\d+).*?revision\s*(\d+)/u) : null;
  const reconsidering = result.action === "dispatched" && result.continuation?.kind === "reconsider-blocker";
  const localWork = result.action === "dispatched" && result.continuation?.kind === "local-work";
  const outcome = reconsidering ? "既存承認内で進められる製品作業の確認を依頼しました。"
    : localWork ? "外部待ちと分離し、進められる製品作業を開始しました。"
    : campMismatch ? "承認済みの新しい作業は未開始です。"
    : progress?.total ? `評価用推論は${progress.total}件中${progress.finished}件終了。公式採点は未確定。`
    : result.action === "running" ? "既存の作業を継続中。新しい結果は未確定。"
    : result.action === "dispatched" ? "既存の作業履歴を引き継ぎ、次の作業へ進みました。"
    : "ここまでの作業記録を保存しています。";
  const reasons = {
    "campaign-budget-exhausted": "累計予算の上限に到達しています。",
    "insufficient-remaining-campaign-budget": "次の作業を予約する予算が不足しています。",
    "prompt-admission-unknown; inspect before any intentional resend": "送信受付を確認できません。再送せず確認が必要です。",
    "native-turn-not-succeeded; inspect its actual error": "開発処理が正常終了していません。原因確認が必要です。",
    "missing-structured-handoff; no blind keep-going loop": "作業結果の引き継ぎが未確認です。",
    "no-new-work-evidence; diagnose before continuing": "新しい作業成果を確認できていません。",
  };
  const blocked = ["paused", "blocked", "needs-host"].includes(result.action);
  const monitorError = result.reason?.startsWith("runner-error:");
  const budgetRepaired = result.reconciliation && /budget|予算/u.test(result.reason ?? "") &&
    budget?.limit_usd !== null && budget?.limit_usd - budget?.exposure_usd >= 46;
  let blocker = result.inputs?.length ? "開発画面に未回答の質問・権限要求があります。"
    : monitorError ? "自動監視がエラーで停止。作業の継続を確認できていません。"
    : blocked ? reasons[result.reason] ?? "作業は停止中。次の判断をこの通知へ返信してください。"
    : "判断待ちはありません。";
  let next = result.inputs?.length ? "既存の開発画面で回答してください。"
    : monitorError ? "監視エラーを修復し、既存セッションの状態を確認します。"
    : blocked ? "不足する判断・操作をこの通知へ返信してください。"
    : "実行結果を確認し、次の作業へ進みます。";
  if (budgetRepaired) { blocker = "以前の予算停止は精算済みです。"; next = "既存の作業を再開する指示待ちです。"; }
  else if (campMismatch) {
    blocker = `育成記録の改訂${campMismatch[1]}が入口条件の改訂${campMismatch[2]}に合わず停止。`;
    next = "育成記録を保持した入口・受入契約の変更可否を返信してください。";
  } else if (blocked) blocker = japaneseLine(brief.blocker ?? result.reason, blocker);
  if (!budgetRepaired && !campMismatch) next = japaneseLine(brief.next_action ?? handoff?.next_action, next);
  if (reconsidering || localWork) {
    blocker = "外部待ちは保持。新しい権限・費用枠は追加しません。";
    next = reconsidering ? "同じ開発セッションで、進められる製品作業を一度確認します。"
      : japaneseLine(result.continuation.next_action, "同じ開発セッションで製品実装を進めます。");
  }
  const costs = !budget ? "費用：集計待ち。請求額ではありません。"
    : budget.limit_usd === null ? `費用換算：計上${money(budget.exposure_usd)}（予約込み・請求額ではない）`
    : `費用換算：計上${money(budget.exposure_usd)}／残り${money(budget.limit_usd - budget.exposure_usd)}（予約込み・請求額ではない）`;
  return [`【${names[config.id] ?? "自動開発"}】${labels[result.action] ?? "状態確認"}`,
    `成果：${japaneseLine(brief.outcome ?? (campMismatch ? null : handoff?.summary), outcome)}`,
    `確認：${japaneseLine(budgetRepaired ? null : brief.question, blocker)}`, `次：${next}`, costs].join("\n");
}

export async function sendNotification(config, text) {
  const settings = config.notifications;
  try {
    const { stdout } = await exec(settings.hermes_command, ["send", "--to", settings.target, "--json", text],
      { env: { ...process.env, HERMES_HOME: settings.hermes_home, HERMES_DISABLE_LAZY_INSTALLS: "1" }, timeout: 30_000 });
    return JSON.parse(stdout);
  } catch (error) {
    return { error: error.message, delivery_uncertain: true };
  }
}

export async function notification(config, result, { execute = false, now = Date.now(), delivery = hermesDelivery,
  send = sendNotification } = {}) {
  if (!execute) return formatNotification(config, result);
  const lock = await acquireRunLock(config.state_root);
  try {
    const path = join(config.state_root, "notification-state.json");
    const state = await read(path) ?? {};
    const direct = config.notifications?.delivery === "direct";
    const previousDirect = state.last?.transport === "hermes-send";
    const receipt = await delivery(config, previousDirect ? null : state.last);
    if (previousDirect && state.last.status === "sending") {
      state.last.status = "unknown";
      await writeAtomicJson(path, state);
      await appendFile(join(config.state_root, "notification-events.jsonl"), `${JSON.stringify({
        at: new Date(now).toISOString(), marker: state.last.marker, execution_id: state.last.execution_id,
        status: "unknown", reason: "direct-send-receipt-unavailable" })}\n`);
    }
    if (state.last && receipt.last && !previousDirect) {
      const status = receipt.last.status;
      if (state.last.status !== status) {
        state.last.status = status;
        state.last.delivery_receipt = receipt.last;
        await appendFile(join(config.state_root, "notification-events.jsonl"), `${JSON.stringify({
          at: new Date(now).toISOString(), marker: state.last.marker, execution_id: state.last.execution_id,
          status, receipt: receipt.last })}\n`);
      }
      if (status === "delivered") state.delivered_signature = state.last.signature;
      await writeAtomicJson(path, state);
    }
    const transport = direct ? "hermes-send" : "cron";
    const signature = JSON.stringify({ format: FORMAT_VERSION, transport, action: result.action, reason: result.reason,
      handoff: result.handoff, inputs: result.inputs, progress: result.proof?.progress,
      reconciliation: result.reconciliation?.path, continuation: result.continuation });
    const active = ["running", "waiting"].includes(result.action);
    const handoffSignature = JSON.stringify({ handoff: result.handoff, inputs: result.inputs });
    const lastSignature = state.last ? JSON.parse(state.last.signature) : null;
    const wasActive = ["running", "waiting", "dispatched"].includes(lastSignature?.action);
    const newHandoff = result.handoff && handoffSignature !== JSON.stringify({
      handoff: lastSignature?.handoff, inputs: lastSignature?.inputs });
    const interval = (config.notifications?.progress_minutes ?? 30) * 60_000;
    if (active && wasActive && !newHandoff && state.last?.format_version === FORMAT_VERSION && state.last.transport === transport &&
      now - Date.parse(state.last.emitted_at) < interval) return null;
    if (!active && state.delivered_signature === signature) return null;
    if (!active && state.last?.signature === signature &&
      !["failed", "suppressed", "not_configured"].includes(state.last.status)) return null;
    if (state.last?.execution_id && state.last.status === "unknown" && state.last.signature === signature) return null;
    const marker = `autodev/${randomUUID()}`;
    const notice = { marker, signature, format_version: FORMAT_VERSION, emitted_at: new Date(now).toISOString(),
      execution_id: receipt.current_execution_id ?? null, transport: direct ? "hermes-send" : "cron",
      status: direct ? "sending" : "emitted-unverified", text: formatNotification(config, result) };
    // A manual preview is not delivery and must not consume the real cron notice.
    if (config.notifications?.job_id && !notice.execution_id) return notice.text;
    state.last = notice;
    await writeAtomicJson(path, state);
    await appendFile(join(config.state_root, "notification-events.jsonl"), `${JSON.stringify(notice)}\n`);
    if (direct) {
      notice.delivery_receipt = await send(config, notice.text);
      notice.status = notice.delivery_receipt.success === true && notice.delivery_receipt.message_id &&
        !notice.delivery_receipt.skipped ? "delivered" : "unknown";
      if (notice.status === "delivered") state.delivered_signature = signature;
      await writeAtomicJson(path, state);
      await appendFile(join(config.state_root, "notification-events.jsonl"), `${JSON.stringify({
        at: new Date().toISOString(), marker, execution_id: notice.execution_id, status: notice.status,
        receipt: notice.delivery_receipt })}\n`);
      return null; // Hermes must not wrap/send the same five-line message again.
    }
    return notice.text;
  } finally { await releaseRunLock(lock); }
}
