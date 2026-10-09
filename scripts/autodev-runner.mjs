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

const sha = value => createHash("sha256").update(value).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const present = async path => access(path).then(() => true, error => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const ensure = (ok, message) => { if (!ok) throw Error(message); };
const nonnegative = value => Number.isFinite(value) && value >= 0;
const exec = promisify(execFile);

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

export function sourceCost(source, value) {
  if (!value) return { priced: source.priced_usd ?? 0, held: source.reservation_usd, unknown: 0, active: true };
  if (source.kind === "supervisor") {
    ensure(nonnegative(value.spent_usd) && nonnegative(value.reserved_usd) &&
      nonnegative(value.held_unknown_usd ?? 0), "invalid-supervisor-cost");
    const active = !["completed", "failed"].includes(value.status);
    const priced = Math.max(source.priced_usd ?? 0, value.spent_usd);
    return { priced, held: active ? Math.max(value.held_unknown_usd ?? 0,
      source.reservation_usd - priced, value.reserved_usd) : value.held_unknown_usd ?? 0,
    unknown: value.held_unknown_usd ?? 0, active };
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
  ensure(root.location.directory === state.directory, "native-session-directory-changed");
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
  const final = turn.filter(item => item.type === "assistant" && item.time?.completed &&
    item.finish === "stop").at(-1);
  const text = final?.content.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "";
  return { root, sessions, acknowledged: userIndex >= 0 || queued,
    busy: sessions.some(item => item.running || item.inbox.length),
    needs_input: sessions.some(item => item.permissions.length || item.forms.length),
    settled: userIndex >= 0 && Boolean(final) && root.outcome === "succeeded",
    text, cost: nativeCost(sessions.flatMap(item => item.messages)),
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
  for (const wait of handoff.wait_for ?? []) {
    ensure(wait.kind === "supervisor" && isAbsolute(wait.path), "unsupported-wait: use blocked for user decisions");
    const state = await json(wait.path);
    if (!["completed", "failed"].includes(state.status)) waiting = true;
  }
  return { files, waiting, fingerprint: files.length ? sha(JSON.stringify(files)) : null };
}

export function nextAction(state, observation, proof = null) {
  if (state.paused) return { action: "paused", reason: state.pause_reason ?? "operator-paused" };
  if (!state.session_id) return { action: "dispatch", reason: "first-work-unit" };
  if (observation.needs_input) return { action: "needs-input", reason: "native permission or question pending; preserve host authority" };
  if (observation.busy) return { action: "running", reason: "owned session or descendant still active" };
  if (state.next_instruction || !state.pending) return { action: "dispatch", reason: "new-owner-instruction" };
  if (!observation.acknowledged) return { action: "blocked", reason: "prompt-admission-unknown; inspect before any intentional resend" };
  if (!observation.settled) return { action: "blocked", reason: "native-turn-not-succeeded; inspect its actual error" };
  const handoff = parseHandoff(observation.text);
  if (!handoff) return { action: "blocked", reason: "missing-structured-handoff; no blind keep-going loop" };
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
    ...(state.next_instruction ? [`New owner instruction (previous costs/attempts remain): ${state.next_instruction}`] : []),
    "Read the current AGENTS.md and canonical task contract. Keep existing host authority, user changes, acceptance and stop conditions. Do not add approval gates or duplicate verification/review.",
    `Runner: ${resolve(import.meta.dirname, "autodev-runner.mjs")}`,
    `Project config: ${config.config_path}; durable state: ${config.state_root}`,
    `Campaign accounting: ${JSON.stringify(budget)}`,
    "Before a separately billed benchmark or practical CLI session, reserve it through this runner's reserve command, using a unique id, its exact output state/observation path, and its full maximum exposure. Do not launch if reservation fails. Reservations and previous attempts survive restarts. Use the existing supervisor's own cost limit as well. Do not count unknown price as zero or claim an exact charge guarantee.",
    decision.handoff ? `Previous verified handoff: ${JSON.stringify(decision.handoff)}\nNext useful action: ${decision.reason}` : "Start with the current real task and existing evidence, not a toy smoke task or a new diagnostic framework.",
    "Make useful progress within the current task. When waiting for detached inference, return wait_for with kind=supervisor and its absolute state path. User decisions, unrecoverable errors and exhausted budgets are blocked, never automatically resumed.",
    "End the turn with <autodev>{\"status\":\"continue|wait|blocked|complete\",\"summary\":\"observable outcome / blocker\",\"next_action\":\"concrete next operation\",\"evidence\":[\"absolute existing evidence path\"],\"wait_for\":[]}</autodev>. Evidence must reflect actual work or a terminal backend result, not just a newly written plan. complete means the requested development campaign is finished; never use it for an intermediate unit or a patch without acceptance.",
  ].join("\n\n");
}

export async function tick(config, { execute = false, client: supplied } = {}) {
  const lock = execute ? await acquireRunLock(config.state_root) : null;
  try {
    const state = await readState(config);
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
    let observation = null, proof = null;
    if (state.session_id) {
      client ??= await connect();
      observation = await observe(client, state);
      state.native_priced_usd = Math.max(state.native_priced_usd, observation.cost.priced);
      if (observation.busy && state.pending && !observation.cost.unknown.length)
        state.native_reservation_usd = Math.max(0, state.pending.reservation_usd -
          (state.native_priced_usd - state.pending.priced_at_start));
      if (!observation.busy && observation.acknowledged && state.pending &&
        !state.accounted_dispatches.includes(state.pending.id)) {
        if (observation.cost.unknown.length) state.native_held_usd += state.native_reservation_usd;
        state.native_reservation_usd = 0;
        state.accounted_dispatches.push(state.pending.id);
      }
      const handoff = parseHandoff(observation.text);
      if (handoff) proof = await handoffEvidence(handoff);
    }
    const budget = await accounting(state);
    const decision = nextAction(state, observation, proof);
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
          priced_at_start: state.native_priced_usd, reservation_usd: reserve };
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
    if (execute) {
      if (["blocked", "complete"].includes(decision.action)) {
        state.paused = true; state.pause_reason = decision.reason;
      }
      state.updated_at = new Date().toISOString();
      state.last_action = { action: decision.action, reason: decision.reason };
      await writeAtomicJson(join(config.state_root, "state.json"), state);
    }
    const result = { project: config.id, ...decision, session_id: state.session_id,
      budget: await accounting(state), observed_models: observation?.models ?? [], proof };
    if (execute) await appendFile(join(config.state_root, "events.jsonl"), `${JSON.stringify({ at: state.updated_at, ...result })}\n`);
    return result;
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
    options[key.slice(2)] = ["execute", "quiet"].includes(key.slice(2)) ? true : args.shift();
  }
  if (command === "verify-cycle") return verifyCycle(resolve(options.receipt));
  ensure(options.config, "--config is required");
  const config = await loadProject(options.config, options.directory ? { directory: options.directory } : {});
  if (command === "plan") return { project: config.id, directory: config.directory, workflow: config.workflow,
    objective: config.objective, instructions: config.instructions, state_root: config.state_root, budget: config.budget };
  if (command === "status") return { project: config.id, state: await readState(config), budget: await accounting(await readState(config)) };
  if (command === "reserve") return reserveSource(config, { id: options.id, kind: options.kind,
    path: resolve(options.path), reservation_usd: Number(options.usd) });
  if (["pause", "resume"].includes(command)) {
    const lock = await acquireRunLock(config.state_root);
    try {
      const state = await readState(config);
      state.paused = command === "pause";
      if (command === "pause") state.pause_reason = options.reason ?? "owner-paused";
      else {
        ensure(options.instruction, "resume requires a new explicit owner --instruction file; no automatic retry");
        state.next_instruction = await readFile(resolve(options.instruction), "utf8");
        ensure(state.next_instruction.trim(), "owner-instruction-empty");
        delete state.pause_reason;
      }
      await writeAtomicJson(join(config.state_root, "state.json"), state);
      return { project: config.id, action: command === "pause" ? "paused" : "resumed", session_id: state.session_id };
    } finally { await releaseRunLock(lock); }
  }
  ensure(command === "tick", "commands: plan, status, tick [--execute], reserve, verify-cycle, pause, resume");
  const result = await tick(config, { execute: Boolean(options.execute) });
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
  try { const result = await main(); if (result) console.log(JSON.stringify(result, null, 2)); }
  catch (error) { console.error(JSON.stringify({ action: "error", reason: error.message })); process.exitCode = 1; }
}
