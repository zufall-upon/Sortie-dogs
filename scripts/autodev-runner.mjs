#!/usr/bin/env node
// Hermes schedules this control plane; OpenCode owns the implementation session.
// A tick observes before sending. It never infers completion from a process exit.
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireRunLock, releaseRunLock, writeAtomicJson } from "./swebench-lite-supervisor.mjs";
import { estimateModelUsageCost } from "./swebench-model-cost.mjs";
import { notification } from "./autodev-notifications.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const present = async path => access(path).then(() => true, error => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const ensure = (ok, message) => { if (!ok) throw Error(message); };
const nonnegative = value => Number.isFinite(value) && value >= 0;
const exec = promisify(execFile);
const observationPauseReasons = new Set([
  "native-turn-not-succeeded; inspect its actual error",
  "prompt-admission-unknown; inspect before any intentional resend",
  "missing-structured-handoff; no blind keep-going loop",
  "no-new-work-evidence; diagnose before continuing",
]);
// Re-observation is not a retry. A recovered native turn still has to satisfy
// admission, latest-result, evidence and budget checks before any new work.
const observePausedNative = state => state.paused && state.pause_origin === "runner" &&
  observationPauseReasons.has(state.pause_reason);

export async function loadProject(path, overrides = {}) {
  path = resolve(path);
  const config = { ...await json(path), ...overrides };
  ensure(config.schema_version === 1 && config.id && ["swebench", "kanban"].includes(config.workflow), "invalid-project-config");
  ensure(typeof config.objective === "string" && config.objective.trim(), "project-objective-required");
  config.directory = resolve(dirname(path), config.directory);
  config.state_root = resolve(dirname(path), config.state_root);
  config.config_path = path;
  if (config.budget) {
    ensure(nonnegative(config.budget.limit_usd) && config.budget.limit_usd > 0 &&
      nonnegative(config.budget.turn_reserve_usd) && config.budget.turn_reserve_usd > 0, "invalid-campaign-budget");
  }
  return config;
}

export function initialState(config) {
  return { schema_version: 1, project: config.id, directory: config.directory, workflow: config.workflow,
    budget_limit_usd: config.budget?.limit_usd ?? null, session_id: null, pending: null,
    native_priced_usd: 0, native_held_usd: 0, native_reservation_usd: 0,
    accounted_dispatches: [], sources: [], last_progress: null, paused: false,
    created_at: new Date().toISOString() };
}

export async function readState(config) {
  const file = join(config.state_root, "state.json");
  const state = await present(file) ? await json(file) : initialState(config);
  ensure(state.schema_version === 1 && state.project === config.id && state.directory === config.directory &&
    state.workflow === config.workflow && state.budget_limit_usd === (config.budget?.limit_usd ?? null),
  "campaign-identity-changed: preserve state and use a separate campaign for changed conditions");
  return state;
}

async function standingInstructions(config) {
  const files = await Promise.all((config.autonomy?.instruction_files ?? []).map(async file => {
    const path = resolve(config.state_root, file), text = await readFile(path, "utf8");
    ensure(text.trim(), "standing-owner-instruction-empty");
    return { path, sha256: sha(text), text };
  }));
  if (!files.length) return null;
  return { sha256: sha(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))),
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    text: files.map(file => `Recorded owner instruction: ${file.path}\n${file.text}`).join("\n\n") };
}

export function sourceCost(source, value) {
  if (!value) return { priced: source.priced_usd ?? 0, held: source.reservation_usd, unknown: 0, active: true };
  if (source.kind === "supervisor") {
    ensure(nonnegative(value.spent_usd) && nonnegative(value.reserved_usd) &&
      nonnegative(value.held_unknown_usd ?? 0), "invalid-supervisor-cost");
    const active = !["completed", "failed"].includes(value.status);
    const priced = Math.max(source.priced_usd ?? 0, value.spent_usd);
    const release = !active && source.no_inference_release?.snapshot_sha256 === sha(JSON.stringify(value))
      ? source.no_inference_release.usd : 0;
    ensure(nonnegative(release) && release <= (value.held_unknown_usd ?? 0), "invalid-no-inference-release");
    const unknown = (value.held_unknown_usd ?? 0) - release;
    return { priced, held: active ? Math.max(value.held_unknown_usd ?? 0,
      source.reservation_usd - priced, value.reserved_usd) : unknown, unknown, active };
  }
  ensure(source.kind === "probe" && nonnegative(value.priced_usd) &&
    Number.isInteger(value.unpriced_requests) && value.unpriced_requests >= 0, "invalid-practical-session-cost");
  const priced = Math.max(source.priced_usd ?? 0, value.priced_usd);
  const held = value.unpriced_requests ? Math.max(0, source.reservation_usd - priced) : 0;
  return { priced, held, unknown: held, active: false };
}

export async function accounting(state) {
  let priced = state.native_priced_usd;
  let held = state.native_held_usd + state.native_reservation_usd;
  const sources = [];
  for (const source of state.sources) {
    const value = await present(source.path) ? await json(source.path) : null;
    const cost = sourceCost(source, value);
    source.priced_usd = cost.priced;
    priced += cost.priced;
    held += cost.held;
    sources.push({ id: source.id, kind: source.kind, path: source.path, ...cost });
  }
  ensure(nonnegative(priced) && nonnegative(held), "invalid-campaign-accounting");
  return { priced_usd: priced, held_usd: held, exposure_usd: priced + held,
    spent_or_unknown_usd: priced + state.native_held_usd + sources.reduce((sum, item) => sum + item.unknown, 0),
    limit_usd: state.budget_limit_usd, sources,
    basis: "API-equivalent estimate; subscription charge and unreported in-flight usage are not known" };
}

export function nativeCost(messages) {
  let priced = 0;
  const unknown = [];
  for (const message of messages.filter(item => item.type === "assistant" && item.time?.completed)) {
    const tokens = message.tokens;
    const cost = estimateModelUsageCost({ providerID: message.model?.providerID, modelID: message.model?.id,
      serviceTier: message.metadata?.serviceTier, uncachedInputTokens: tokens?.input,
      cacheReadTokens: tokens?.cache?.read, cacheWriteTokens: tokens?.cache?.write,
      outputTokens: tokens?.output, reasoningTokens: tokens?.reasoning });
    if (cost.status === "priced") priced += cost.usd;
    else unknown.push(message.id);
  }
  return { priced, unknown };
}

async function pages(call) {
  const result = [];
  let cursor;
  const seen = new Set();
  do {
    const page = await call(cursor);
    ensure(Array.isArray(page.data), "invalid-native-page");
    result.push(...page.data);
    cursor = page.cursor?.next ?? undefined;
    ensure(!cursor || !seen.has(cursor), "native-pagination-loop");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}

export async function connect() {
  const [{ OpenCode }, { Service }] = await Promise.all([
    import("@opencode/client"), import("@opencode/client/service")]);
  const endpoint = await Service.discover();
  ensure(endpoint, "opencode-service-unavailable: use the existing host service; no automatic restart");
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
}

export async function observe(client, state) {
  const options = () => ({ signal: AbortSignal.timeout(15_000) });
  const root = await client.session.get({ sessionID: state.session_id }, options());
  // The retained Session can legitimately move to a development worktree.
  // Its ID remains the execution identity; directory is not an admission gate.
  ensure(root.id === state.session_id, "native-session-identity-changed");
  const [all, active] = await Promise.all([
    pages(cursor => client.session.list({ project: root.projectID, cursor }, options())),
    client.session.active(options()),
  ]);
  const ids = new Set([root.id]);
  let size;
  do {
    size = ids.size;
    for (const session of all) if (ids.has(session.parentID)) ids.add(session.id);
  } while (ids.size !== size);
  const sessions = await Promise.all([...ids].map(async sessionID => {
    const [messages, inbox, permissions, forms] = await Promise.all([
      pages(cursor => client.message.list({ sessionID, ...(cursor ? { cursor } : { order: "asc", limit: 100 }) }, options())),
      client.session.inbox.list({ sessionID }, options()),
      client.permission.list({ sessionID }, options()),
      client.session.form.list({ sessionID }, options()),
    ]);
    return { id: sessionID, messages, inbox, permissions, forms, running: Boolean(active[sessionID]) };
  }));
  const own = sessions.find(item => item.id === root.id);
  const dispatch = state.pending?.id;
  const userIndex = dispatch ? own.messages.findIndex(item => item.type === "user" && item.metadata?.autodev_dispatch === dispatch) : -1;
  const queued = Boolean(dispatch && own.inbox.some(item => item.payload?.metadata?.autodev_dispatch === dispatch));
  const turn = userIndex < 0 ? [] : own.messages.slice(userIndex + 1);
  const latestUserIndex = own.messages.findLastIndex(item => item.type === "user");
  const latest = userIndex < 0 ? null : own.messages.slice(Math.max(userIndex, latestUserIndex) + 1)
    .filter(item => item.type === "assistant").at(-1);
  const final = latest?.time?.completed && latest.finish === "stop" && !latest.error ? latest : null;
  const text = final?.content.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "";
  const cost = nativeCost(sessions.flatMap(item => item.messages));
  const currentUnknown = state.pending?.unknown_at_start
    ? cost.unknown.filter(id => !state.pending.unknown_at_start.includes(id))
    : nativeCost([...turn, ...sessions.filter(item => item.id !== root.id).flatMap(item => item.messages
      .filter(message => !own.messages[userIndex]?.time?.created ||
        message.time?.created >= own.messages[userIndex].time.created))]).unknown;
  return { root, sessions, acknowledged: userIndex >= 0 || queued,
    busy: sessions.some(item => item.running || item.inbox.length),
    needs_input: sessions.some(item => item.permissions.length || item.forms.length),
    settled: userIndex >= 0 && Boolean(final) && root.outcome === "succeeded",
    text, cost, current_unknown: currentUnknown,
    terminal: latest ? { message_id: latest.id, user_message_id: own.messages[latestUserIndex]?.id,
      finish: latest.finish, completed_at: latest.time?.completed ?? null } : null,
    native_failure: latest?.error ? { message_id: latest.id, type: latest.error.type,
      message: latest.error.message?.slice(0, 500) } : null,
    models: [...new Map(sessions.flatMap(item => item.messages.filter(message => message.type === "assistant")
      .map(message => { const model = { session_id: item.id, agent: message.agent, model: message.model };
        return [JSON.stringify(model), model]; }))).values()] };
}

export function parseHandoff(text) {
  const matches = [...text.matchAll(/<autodev>([\s\S]*?)<\/autodev>/gu)];
  if (!matches.length) return null;
  const handoff = JSON.parse(matches.at(-1)[1]);
  ensure(["continue", "wait", "blocked", "complete"].includes(handoff.status) &&
    typeof handoff.summary === "string" && Array.isArray(handoff.evidence), "invalid-autodev-handoff");
  ensure(handoff.evidence.every(path => typeof path === "string" && isAbsolute(path)), "absolute-evidence-paths-required");
  return handoff;
}

export async function handoffEvidence(handoff) {
  const files = [];
  for (const path of handoff.evidence) files.push({ path, sha256: sha(await readFile(path)) });
  let waiting = false;
  const progress = [], waits = [];
  for (const wait of handoff.wait_for ?? []) {
    ensure(wait.kind === "supervisor" && isAbsolute(wait.path), "unsupported-wait: use blocked for user decisions");
    const bytes = await readFile(wait.path), state = JSON.parse(bytes);
    if (!files.some(file => file.path === wait.path)) waits.push({ path: wait.path, sha256: sha(bytes) });
    if (!["completed", "failed"].includes(state.status)) waiting = true;
    if (Array.isArray(state.instances)) progress.push({ total: state.instances.length,
      finished: state.instances.filter(item => item.result).length, status: state.status });
  }
  return { files, waits, waiting, progress,
    fingerprint: files.length || waits.length ? sha(JSON.stringify([...files, ...waits])) : null };
}

export function nextAction(state, observation, proof = null, config = {}) {
  const delegated = config.autonomy?.reconsider_blocked_once === true && Boolean(state.standing_authority?.sha256);
  if (state.paused && !observePausedNative(state) && !(delegated && state.pause_origin === "runner"))
    return { action: "paused", reason: state.pause_reason ?? "operator-paused" };
  if (!state.session_id) return { action: "dispatch", reason: "first-work-unit" };
  if (observation.needs_input) return { action: "needs-input", reason: "native permission or question pending; preserve host authority" };
  if (observation.busy) return { action: "running", reason: "owned session or descendant still active" };
  if (state.next_instruction || !state.pending) return { action: "dispatch", reason: "new-owner-instruction" };
  if (!observation.acknowledged) return { action: "blocked", reason: "prompt-admission-unknown; inspect before any intentional resend" };
  if (!observation.settled) return { action: "blocked", reason: "native-turn-not-succeeded; inspect its actual error" };
  const handoff = parseHandoff(observation.text);
  if (!handoff) return { action: "blocked", reason: "missing-structured-handoff; no blind keep-going loop" };
  if (handoff.status === "blocked" && delegated && proof?.fingerprint && !proof.waiting &&
    handoff.local_work_exhausted !== true &&
    !["budget", "auth", "permission", "acceptance", "no-resend"].includes(handoff.blocker_kind) &&
    !/budget|予算|追加費用|認証|token_expired|provider\.auth|permission|権限要求|追加承認|承認してください|再送禁止/iu
      .test(`${handoff.summary}\n${handoff.notification?.question ?? ""}`)) {
    const work_id = typeof handoff.work_id === "string" && handoff.work_id.trim()
      ? handoff.work_id : state.work_id ?? config.id;
    if (typeof handoff.local_next_action === "string" && handoff.local_next_action.trim() &&
      proof.fingerprint !== state.last_progress) return { action: "dispatch", reason: handoff.local_next_action, handoff,
      continuation: { kind: "local-work", work_id, next_action: handoff.local_next_action } };
    const key = sha(JSON.stringify({ work_id, authority: state.standing_authority.sha256 }));
    if (!(state.autonomous_reconsiderations ?? []).some(item => item.key === key))
      return { action: "dispatch", reason: "authorized-blocker-reconsideration", handoff,
        continuation: { kind: "reconsider-blocker", key, work_id, authority_sha256: state.standing_authority.sha256 } };
  }
  if (handoff.status === "blocked" || handoff.status === "complete")
    return { action: handoff.status, reason: handoff.summary, handoff };
  if (proof?.waiting) return { action: "waiting", reason: handoff.summary, handoff };
  if (!proof?.fingerprint || proof.fingerprint === state.last_progress)
    return { action: "blocked", reason: "no-new-work-evidence; diagnose before continuing", handoff };
  return { action: "dispatch", reason: handoff.next_action ?? handoff.summary, handoff };
}

export function workPrompt(config, state, decision, budget) {
  return [
    "User-authorized continuous development. Principles: autonomous, efficient, visible.",
    config.objective, ...(config.instructions ?? []),
    ...(state.standing_authority ? [`Retained standing owner instructions, applicable to EVERY work unit, not a new model/fee/Task allowance:\n${state.standing_authority.text}`] : []),
    ...(state.next_instruction ? [`New owner instruction (previous costs/attempts remain): ${state.next_instruction}`] : []),
    "Read the current AGENTS.md and canonical task contract. Keep existing host authority, user changes, acceptance and stop conditions. Do not add approval gates or duplicate verification/review.",
    `Runner: ${resolve(import.meta.dirname, "autodev-runner.mjs")}`,
    `Project config: ${config.config_path}; durable state: ${config.state_root}`,
    `Canonical repository/accounting directory: ${config.directory}; existing Session working directory: ${state.native_directory ?? config.directory}. Preserve a legitimate worktree move; do not move the Session back just to satisfy the monitor.`,
    `Campaign accounting: ${JSON.stringify(budget)}`,
    "Before a separately billed benchmark or practical CLI session, reserve it through this runner's reserve command, using a unique id, its exact output state/observation path, and its full maximum exposure. Do not launch if reservation fails. Reservations and previous attempts survive restarts. Use the existing supervisor's own cost limit as well. Do not count unknown price as zero or claim an exact charge guarantee.",
    decision.handoff ? `Previous verified handoff: ${JSON.stringify(decision.handoff)}\nNext useful action: ${decision.reason}` : "Start with the current real task and existing evidence, not a toy smoke task or a new diagnostic framework.",
    "Make useful progress within the current task. When waiting for detached inference, return wait_for with kind=supervisor and its absolute state path. User decisions, unrecoverable errors and exhausted budgets are blocked, never automatically resumed.",
    ...(config.autonomy?.reconsider_blocked_once ? [
      `Existing stable work_id: ${decision.continuation?.work_id ?? state.work_id ?? "use the current canonical outcome card ID"}. Keep that exact identity until the full current card is completed and the live board selects the next card; do not rename it for a subunit or blocker.`,
      "Standing-delegation scheduling: a deferred Windows/host/input/validation step does not stop available authorized product source work. Return continue with its concrete local next_action and deferred:[{reason,next_action}] for external steps. Use a stable work_id equal to the current full outcome card ID, not a subunit or changing prose. blocked means no authorized local product work remains, not merely that a later real-input/host gate is unavailable. Optional local_next_action identifies still-available authorized source work; local_work_exhausted:true records genuine exhaustion with concrete evidence. blocker_kind can distinguish host/input/implementation from budget/auth/permission/acceptance/no-resend. These are scheduling hints, not new approval or acceptance authority.",
      ...(decision.continuation?.kind === "reconsider-blocker" ? [
        "Hermes automatically requests ONE bounded reconsideration of this blocked work unit under the retained standing delegation. This is the same implementation Session, not a new reviewer or controller. Separate unavailable real-input execution from implementation still possible locally. Inspect the existing product path, implement its smallest meaningful unconnected step if authorized, and return continue with actual changed source evidence. Do not merely rename the blocker, add documentation/probes/scaffolding or repeat completed work. If genuinely no local work remains, return blocked with local_work_exhausted:true, the exact missing native input/host operation and evidence. Do not acquire new permissions, fees, models, receipts or product Task starts; do not replay consumed operations. The same work/authority will not be reconsidered again automatically.",
      ] : []),
    ] : []),
    "ユーザーへの通知は必ず日本語で最大5行。handoffには notification:{outcome,blocker,next_action,question} を追加し、各値は日本語の短い1文（70字以内、改行なし）、不要なblocker/questionはnull。outcomeは今回の実成果、blocker/questionは今の停止理由・必要な判断、next_actionは次の操作。英語の引継ぎ原文、過去の予算停止、パス・ハッシュ・Session ID・ログを通知文に転載しない。詳細証跡は既存evidenceへ保持。通知形式のために追加モデルやレビューを呼ばない。",
    "利用者の操作が必要ならquestionへ具体的な操作依頼を書き、next_actionで利用者の操作とこちらの操作を区別する。『次に受入します』だけで受入ボタン操作待ちを隠さない。最新の結果固有の承認を読む。同じ承認を再要求しない。送信成功は既読・認知の証拠ではない。",
    "End the turn with <autodev>{\"status\":\"continue|wait|blocked|complete\",\"summary\":\"observable outcome / blocker\",\"next_action\":\"concrete next operation\",\"notification\":{\"outcome\":\"今回の実成果を日本語で短く要約\",\"blocker\":null,\"next_action\":\"次の操作を日本語で短く要約\",\"question\":null},\"evidence\":[\"absolute existing evidence path\"],\"wait_for\":[]}</autodev>. Evidence must reflect actual work or a terminal backend result, not just a newly written plan. complete means the requested development campaign is finished; never use it for an intermediate unit or a patch without acceptance.",
  ].join("\n\n");
}

export async function tick(config, { execute = false, client: supplied } = {}) {
  const lock = execute ? await acquireRunLock(config.state_root) : null;
  try {
    const state = await readState(config);
    state.standing_authority = await standingInstructions(config);
    for (const path of config.required_commands ?? []) {
      if (!await present(path)) {
        const result = { project: config.id, action: "needs-host", reason: `required canonical command unavailable: ${path}` };
        if (execute) {
          state.last_action = result;
          await writeAtomicJson(join(config.state_root, "state.json"), state);
        }
        return result;
      }
    }
    let client = supplied;
    let observation = null, proof = null, handoff = null;
    if (state.session_id) {
      client ??= await connect();
      observation = await observe(client, state);
      state.native_directory = observation.root.location.directory;
      state.native_priced_usd = Math.max(state.native_priced_usd, observation.cost.priced);
      if (state.pending && !state.accounted_dispatches.includes(state.pending.id))
        state.native_reservation_usd = Math.max(0, state.pending.reservation_usd -
          (state.native_priced_usd - state.pending.priced_at_start));
      if (!observation.busy && observation.acknowledged && state.pending &&
        !state.accounted_dispatches.includes(state.pending.id)) {
        if (observation.current_unknown.length) {
          state.native_held_usd += state.native_reservation_usd;
          (state.native_holds ??= []).push({ dispatch_id: state.pending.id,
            held_usd: state.native_reservation_usd, unknown_message_ids: observation.current_unknown });
        }
        state.native_reservation_usd = 0;
        state.accounted_dispatches.push(state.pending.id);
      }
      // New owner instructions supersede an old handoff, not native execution or
      // accounting. Missing old temporary evidence must not prevent recovery.
      handoff = state.next_instruction ? null : parseHandoff(observation.text);
      if (typeof handoff?.work_id === "string" && handoff.work_id.trim()) state.work_id = handoff.work_id;
      if (handoff && (!state.paused || (state.pause_origin === "runner" &&
        config.autonomy?.reconsider_blocked_once === true && state.standing_authority) || observePausedNative(state)) &&
        !observation.busy && !observation.needs_input &&
        observation.acknowledged && observation.settled) proof = await handoffEvidence(handoff);
    }
    const previousPause = observePausedNative(state) ? { previous_reason: state.pause_reason,
      dispatch_id: state.pending?.id, terminal_id: observation?.terminal?.message_id ?? null } : null;
    const budget = await accounting(state);
    const decision = nextAction(state, observation, proof, config);
    // A fully reserved operation is admitted work, not exhausted measured usage.
    if (budget.limit_usd !== null && (budget.exposure_usd > budget.limit_usd + 1e-8 ||
      budget.spent_or_unknown_usd >= budget.limit_usd)) {
      decision.action = "blocked"; decision.reason = "campaign-budget-exhausted";
      if (execute && observation?.busy) await Promise.all(observation.sessions.filter(item => item.running)
        .map(item => client.session.interrupt({ sessionID: item.id }, { signal: AbortSignal.timeout(15_000) })));
    }
    if (execute && decision.action === "dispatch") {
      const reserve = config.budget?.turn_reserve_usd ?? 0;
      if (budget.limit_usd !== null && budget.exposure_usd + reserve > budget.limit_usd) {
        decision.action = "blocked"; decision.reason = "insufficient-remaining-campaign-budget";
      } else {
        client ??= await connect();
        if (!state.session_id) {
          state.session_id = `ses_${randomUUID().replaceAll("-", "")}`;
          state.paused = true; state.pause_reason = "session-creation-unconfirmed";
          await writeAtomicJson(join(config.state_root, "state.json"), state);
          await client.session.create({ id: state.session_id, title: `Autodev: ${config.id}`,
            location: { directory: config.directory }, ...(config.agent ? { agent: config.agent } : {}),
            ...(config.model ? { model: config.model } : {}) }, { signal: AbortSignal.timeout(15_000) });
          state.paused = false; delete state.pause_reason;
        }
        const text = workPrompt(config, state, decision, budget);
        state.pending = { id: randomUUID(), sent_at: new Date().toISOString(), prompt_sha256: sha(text), status: "sending",
          priced_at_start: state.native_priced_usd, reservation_usd: reserve,
          unknown_at_start: observation?.cost.unknown ?? [] };
        if (decision.continuation?.kind === "reconsider-blocker") {
          (state.autonomous_reconsiderations ??= []).push({ ...decision.continuation,
            dispatch_id: state.pending.id, at: state.pending.sent_at });
        }
        state.paused = false; delete state.pause_reason; delete state.pause_origin;
        state.native_reservation_usd = reserve;
        state.last_progress = proof?.fingerprint ?? null;
        delete state.next_instruction;
        await writeAtomicJson(join(config.state_root, "state.json"), state);
        try {
          const accepted = await client.session.prompt({ sessionID: state.session_id, text,
            metadata: { autodev_dispatch: state.pending.id }, delivery: "queue" },
          { signal: AbortSignal.timeout(15_000) });
          state.pending.status = "accepted"; state.pending.inbox_id = accepted.id;
          decision.action = "dispatched";
        } catch (error) {
          state.pending.status = "unknown";
          await writeAtomicJson(join(config.state_root, "state.json"), state);
          throw error;
        }
      }
    }
    const recovery = previousPause && ["running", "needs-input", "waiting", "dispatched"].includes(decision.action)
      ? { ...previousPause, at: new Date().toISOString(), action: decision.action } : null;
    if (execute) {
      if (recovery) {
        state.paused = false; delete state.pause_reason; delete state.pause_origin;
        state.last_recovery = recovery;
      }
      if (["blocked", "complete"].includes(decision.action)) {
        state.paused = true; state.pause_reason = decision.reason; state.pause_origin = "runner";
      }
      state.updated_at = new Date().toISOString();
      state.last_action = { action: decision.action, reason: decision.reason };
      await writeAtomicJson(join(config.state_root, "state.json"), state);
    }
    const result = { project: config.id, ...decision, session_id: state.session_id,
      native_directory: state.native_directory ?? null,
      budget: await accounting(state), observed_models: observation?.models ?? [], proof,
      native_failure: observation?.native_failure ?? null, recovery,
      reconciliation: state.last_reconciliation ?? null,
      handoff: decision.handoff ?? handoff,
      inputs: observation?.sessions.filter(item => item.permissions.length || item.forms.length)
        .map(item => ({ session_id: item.id, permissions: item.permissions, forms: item.forms })) ?? [] };
    if (execute) await appendFile(join(config.state_root, "events.jsonl"), `${JSON.stringify({ at: state.updated_at, ...result })}\n`);
    return result;
  } finally { await releaseRunLock(lock); }
}

export async function runTick(config, options = {}, notificationOptions = {}) {
  try {
    const result = await tick(config, options);
    return options.notify ? notification(config, result, { ...notificationOptions, execute: Boolean(options.execute) }) : result;
  } catch (error) {
    if (options.notify) {
      const state = await readState(config);
      const result = { project: config.id, action: "needs-host", reason: `runner-error:${error.message}`,
        session_id: state.session_id, budget: await accounting(state), inputs: [] };
      if (options.execute) {
        const lock = await acquireRunLock(config.state_root);
        try {
          const current = await readState(config);
          current.monitoring_error = { at: new Date().toISOString(), reason: error.message };
          await writeAtomicJson(join(config.state_root, "state.json"), current);
          await appendFile(join(config.state_root, "events.jsonl"), `${JSON.stringify({ at: current.monitoring_error.at, ...result })}\n`);
        } finally { await releaseRunLock(lock); }
      }
      await notification(config, result, { ...notificationOptions, execute: Boolean(options.execute) });
    }
    throw error; // A delivered diagnostic must not turn an unsuccessful tick into success.
  }
}

// Explicit repair of a retained ledger, never a new inference attempt or automatic resume.
export async function reconcile(config, { execute = false, client: supplied } = {}) {
  const lock = execute ? await acquireRunLock(config.state_root) : null;
  try {
    const state = await readState(config), beforeState = JSON.stringify(state);
    ensure(state.session_id, "reconciliation-requires-existing-session");
    const observation = await observe(supplied ?? await connect(), state);
    ensure(!observation.busy, "reconciliation-waits-for-owned-work");
    const before = await accounting(state);
    const unknown = new Set(observation.cost.unknown), assignments = new Map();
    const own = observation.sessions.find(item => item.id === state.session_id);
    const dispatches = own.messages.filter(item => item.type === "user" && item.metadata?.autodev_dispatch);
    ensure(state.accounted_dispatches.every(id => dispatches.some(item => item.metadata.autodev_dispatch === id)),
      "settled-dispatch-history-incomplete");
    const observedIds = new Set(observation.sessions.flatMap(item => item.messages.map(message => message.id)));
    ensure((state.native_holds ?? []).every(item => item.unknown_message_ids.every(id => observedIds.has(id))),
      "previous-unknown-message-unavailable");
    let dispatch;
    const assign = (message, id) => {
      if (!unknown.has(message.id)) return;
      ensure(id && state.accounted_dispatches.includes(id), "unknown-usage-without-settled-dispatch");
      const ids = assignments.get(id) ?? [];
      ids.push(message.id); assignments.set(id, ids); unknown.delete(message.id);
    };
    for (const message of own.messages) {
      if (message.type === "user" && message.metadata?.autodev_dispatch) dispatch = message.metadata.autodev_dispatch;
      assign(message, dispatch);
    }
    for (const session of observation.sessions.filter(item => item.id !== state.session_id)) {
      for (const message of session.messages.filter(item => unknown.has(item.id))) {
        ensure(message.time?.created && dispatches.every(item => item.time?.created), "unknown-descendant-time-unavailable");
        assign(message, dispatches.filter(item => item.time.created <= message.time.created).at(-1)?.metadata.autodev_dispatch);
      }
    }
    ensure(!unknown.size, "unattributed-native-unknown-usage");
    state.native_priced_usd = Math.max(state.native_priced_usd, observation.cost.priced);
    const existing = new Map((state.native_holds ?? []).map(item => [item.dispatch_id, item]));
    state.native_holds = [...assignments].map(([dispatch_id, unknown_message_ids]) => ({ dispatch_id,
      held_usd: existing.get(dispatch_id)?.held_usd ?? config.budget?.turn_reserve_usd ?? 0,
      unknown_message_ids }));
    state.native_held_usd = state.native_holds.reduce((sum, item) => sum + item.held_usd, 0);
    const releases = [];
    for (const source of state.sources.filter(item => item.kind === "supervisor" && !item.no_inference_release)) {
      if (!await present(source.path)) continue;
      const value = await json(source.path);
      if (!["completed", "failed"].includes(value.status)) continue;
      const proofs = [];
      for (const item of value.instances ?? []) {
        const result = item.result;
        if (!item.held_unknown_usd || !result?.status?.startsWith("prepared-environment-image-missing:") ||
          result.failure !== result.status || result.usage?.requests !== 0 || result.usage?.usd !== 0 ||
          result.usage?.unpriced?.length !== 0 || result.watchdog_events !== 0 || result.exit_code !== null ||
          !result.replay_artifact?.path) continue;
        const replayBytes = await readFile(result.replay_artifact.path);
        ensure(sha(replayBytes) === result.replay_artifact.sha256, "no-inference-replay-unconfirmed");
        const artifact = JSON.parse(replayBytes);
        ensure(artifact.failure === result.failure &&
          artifact.execution?.command === null && artifact.execution?.exit_code === null &&
          artifact.execution?.stdout_bytes === 0 && artifact.execution?.stderr_bytes === 0 && artifact.patch_bytes === 0,
        "no-inference-replay-unconfirmed");
        proofs.push({ instance_id: item.instance_id, usd: item.held_unknown_usd,
          replay: result.replay_artifact.path, replay_sha256: result.replay_artifact.sha256, reason: result.failure });
      }
      if (proofs.length) {
        source.no_inference_release = { snapshot_sha256: sha(JSON.stringify(value)),
          usd: proofs.reduce((sum, item) => sum + item.usd, 0), proofs };
        releases.push({ source_id: source.id, ...source.no_inference_release });
      }
    }
    const after = await accounting(state), at = new Date().toISOString();
    const receipt = { at, project: config.id, action: "reconciled", session_id: state.session_id,
      original_state_sha256: sha(beforeState), original_state: JSON.parse(beforeState),
      before, after, native_holds: state.native_holds, releases,
      paused: state.paused, conditions_unchanged: true };
    if (execute) {
      const path = join(config.state_root, `reconciliation-${at.replaceAll(":", "-")}.json`);
      await writeAtomicJson(path, receipt);
      state.last_reconciliation = { path, at, sha256: sha(JSON.stringify(receipt)),
        before_exposure_usd: before.exposure_usd, after_exposure_usd: after.exposure_usd };
      await writeAtomicJson(join(config.state_root, "state.json"), state);
      await appendFile(join(config.state_root, "events.jsonl"), `${JSON.stringify(receipt)}\n`);
    }
    return receipt;
  } finally { await releaseRunLock(lock); }
}

export async function reserveSource(config, source) {
  ensure(config.budget, "project-has-no-campaign-budget");
  ensure(source.id && ["supervisor", "probe"].includes(source.kind) && isAbsolute(source.path) &&
    nonnegative(source.reservation_usd) && source.reservation_usd > 0, "invalid-cost-reservation");
  const lock = await acquireRunLock(config.state_root);
  try {
    const state = await readState(config);
    const existing = state.sources.find(item => item.id === source.id);
    if (existing) {
      ensure(existing.kind === source.kind && existing.path === source.path &&
        existing.reservation_usd === source.reservation_usd, "reservation-identity-changed");
      return { action: "already-reserved", source: existing, budget: await accounting(state) };
    }
    ensure(!state.sources.some(item => item.path === source.path), "cost-source-already-accounted");
    const budget = await accounting(state);
    ensure(budget.exposure_usd + source.reservation_usd <= config.budget.limit_usd, "insufficient-remaining-campaign-budget");
    state.sources.push({ ...source, reserved_at: new Date().toISOString() });
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    return { action: "reserved", source, budget: await accounting(state) };
  } finally { await releaseRunLock(lock); }
}

export async function verifyCycle(path) {
  const receipt = await json(path);
  const [manifest, supervisor, scoring, practical] = await Promise.all([
    json(receipt.manifest), json(receipt.supervisor), json(receipt.scoring), json(receipt.practical.observation),
  ]);
  const packageHash = sha(await readFile(receipt.package));
  ensure(packageHash === receipt.package_sha256 && packageHash === manifest.candidate.sha256 &&
    practical.candidate_sha256 === packageHash,
  "cycle-candidate-mismatch");
  ensure(supervisor.manifest === receipt.manifest && supervisor.input_sha256 === sha(JSON.stringify(manifest)),
    "cycle-supervisor-manifest-mismatch");
  const ids = manifest.instances.map(item => item.instance_id);
  const publicLock = await json(new URL("./swebench-lite-public-lock.json", import.meta.url));
  const canonicalIds = Object.keys(publicLock.splits.dev.rows);
  ensure(manifest.dataset.id === publicLock.dataset.id && manifest.dataset.revision === publicLock.dataset.revision &&
    manifest.dataset.split === "dev" && ids.length === 23 && new Set(ids).size === 23 &&
    ids.every(id => canonicalIds.includes(id)),
    "cycle-requires-23-distinct-dev-cases");
  ensure(supervisor.status === "completed" && supervisor.policy.attempts_per_instance === 1 &&
    supervisor.policy.retry_count === 0 && supervisor.instances.length === 23 &&
    supervisor.instances.every((item, index) => item.instance_id === ids[index] && item.attempt === 1), "cycle-inference-incomplete");
  ensure(scoring.status === "completed" && ids.every(id => scoring.graded?.[id]?.result &&
    typeof scoring.graded[id].result.resolved === "boolean"), "cycle-official-score-incomplete");
  ensure(scoring.split === "dev" && scoring.max_workers === 1 && scoring.retry_count === 0 &&
    supervisor.limits.workers === 8 && supervisor.limits.per_instance_usd === 2 &&
    supervisor.limits.cost_limit_usd === 46 && supervisor.limits.timeout_seconds === 2400 &&
    supervisor.limits.prepared_environment === "official-image-testbed", "cycle-comparison-conditions-mismatch");
  ensure(scoring.supervisor_state === receipt.supervisor && scoring.last_harness?.exit_code === 0 &&
    sha(await readFile(receipt.manifest)) === receipt.manifest_sha256 &&
    sha(await readFile(receipt.predictions)) === receipt.predictions_sha256,
  "cycle-frozen-artifacts-unconfirmed");
  const predictions = (await readFile(receipt.predictions, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  ensure(predictions.length === 23 && predictions.every((item, index) => item.instance_id === ids[index] &&
    typeof item.model_patch === "string" && sha(item.model_patch) === scoring.graded[item.instance_id].patch_sha256),
  "cycle-scored-prediction-mismatch");
  ensure(practical.mode === "complete" && practical.accepted === true && practical.mission_phase === "completed" &&
    practical.receipt_status === "succeeded" && practical.code === 0 && practical.stopped === false &&
    practical.models?.some(item => item.agent === "dog-worker-v010" && item.model?.providerID === "openai" &&
      item.model.id === "gpt-6-luna-fast" && item.model.variant === "max"),
  "cycle-practical-session-not-accepted");
  ensure(receipt.runtime_marker && receipt.runtime_marker === manifest.candidate.runtime_marker &&
    practical.runtime_marker === receipt.runtime_marker && practical.package_version === manifest.candidate.version,
  "cycle-runtime-identity-mismatch");
  ensure(receipt.practical.task && receipt.practical.repo && receipt.practical.base_commit &&
    receipt.practical.verification?.length && practical.instance?.repo === receipt.practical.repo &&
    practical.instance?.base_commit === receipt.practical.base_commit &&
    practical.task_sha256 === sha(await readFile(receipt.practical.task)), "cycle-practical-original-task-required");
  for (const check of receipt.practical.verification) {
    ensure(typeof check.command === "string" && check.command && check.exit === 0 &&
      check.log_sha256 === sha(await readFile(check.log)), "cycle-practical-verification-incomplete");
  }
  ensure(receipt.commit && receipt.runner_commit && receipt.main_integrated === true && receipt.source_repo && receipt.main_commit,
    "cycle-main-integration-unconfirmed");
  await exec("git", ["merge-base", "--is-ancestor", receipt.commit, receipt.main_commit], { cwd: receipt.source_repo });
  await exec("git", ["merge-base", "--is-ancestor", receipt.main_commit, "origin/main"], { cwd: receipt.source_repo });
  ensure(receipt.runner_root && (await exec("git", ["rev-parse", "HEAD"], { cwd: receipt.runner_root })).stdout.trim() === receipt.runner_commit,
    "cycle-runner-commit-mismatch");
  for (const script of ["scripts/swebench-lite-runner.mjs", "scripts/swebench-lite-supervisor.mjs",
    "scripts/swebench-lite-grader.mjs", "scripts/swebench-model-cost.mjs", "scripts/release-cli.mjs"]) {
    ensure(receipt.runner_sha256?.[script] === sha(await readFile(join(receipt.runner_root, script))), "cycle-runner-source-mismatch");
  }
  return { action: "cycle-verified", package_sha256: packageHash, commit: receipt.commit,
    resolved: ids.filter(id => scoring.graded[id].result.resolved), total: 23,
    practical_session: practical.root, guarantee: "observed task/candidate only, not universal correctness" };
}

export async function main(args = process.argv.slice(2)) {
  const command = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    ensure(key.startsWith("--"), "expected-option");
    options[key.slice(2)] = ["execute", "quiet", "notify"].includes(key.slice(2)) ? true : args.shift();
  }
  if (command === "verify-cycle") return verifyCycle(resolve(options.receipt));
  ensure(options.config, "--config is required");
  const config = await loadProject(options.config, options.directory ? { directory: options.directory } : {});
  if (command === "plan") return { project: config.id, directory: config.directory, workflow: config.workflow,
    objective: config.objective, instructions: config.instructions, state_root: config.state_root, budget: config.budget,
    autonomy: config.autonomy ?? null };
  if (command === "status") return { project: config.id, state: await readState(config), budget: await accounting(await readState(config)) };
  if (command === "reconcile") return reconcile(config, { execute: Boolean(options.execute) });
  if (command === "reserve") return reserveSource(config, { id: options.id, kind: options.kind,
    path: resolve(options.path), reservation_usd: Number(options.usd) });
  if (["pause", "resume"].includes(command)) {
    const lock = await acquireRunLock(config.state_root);
    try {
      const state = await readState(config);
      state.paused = command === "pause";
      if (command === "pause") { state.pause_reason = options.reason ?? "owner-paused"; state.pause_origin = "owner"; }
      else {
        ensure(options.instruction, "resume requires a new explicit owner --instruction file; no automatic retry");
        state.next_instruction = await readFile(resolve(options.instruction), "utf8");
        ensure(state.next_instruction.trim(), "owner-instruction-empty");
        delete state.pause_reason;
        delete state.pause_origin;
      }
      await writeAtomicJson(join(config.state_root, "state.json"), state);
      return { project: config.id, action: command === "pause" ? "paused" : "resumed", session_id: state.session_id };
    } finally { await releaseRunLock(lock); }
  }
  ensure(command === "tick", "commands: plan, status, tick [--execute], reconcile [--execute], reserve, verify-cycle, pause, resume");
  const result = await runTick(config, { execute: Boolean(options.execute), notify: Boolean(options.notify) });
  if (options.notify) return result;
  if (options.quiet && options.execute) {
    if (["running", "waiting", "paused"].includes(result.action)) return null;
    const notice = join(config.state_root, "last-output.json");
    const signature = sha(JSON.stringify({ action: result.action, reason: result.reason, session_id: result.session_id }));
    if (await present(notice) && (await json(notice)).signature === signature) return null;
    await writeAtomicJson(notice, { signature, at: new Date().toISOString() });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await main(); if (result) console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(JSON.stringify({ action: "error", reason: error.message })); process.exitCode = 1; }
}
