import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { installedFixture, startV2ReleaseServer, stopProcessGroup, nativeCLI, command } from './release-cli.mjs';
import { estimateModelUsageCost } from '../dist/plugin/model-cost.js';

const database = () => new DatabaseSync(join(homedir(), '.local/share/opencode/opencode.db'), { readOnly: true });
export const observationDirectories = project => [project, project.replaceAll('\\', '/')];
export function observeMissionCLI(project, since = 0, rootAgent = 'dog-operator') {
  const db = database();
  try {
    const sessions = db.prepare('select id, parent_id, agent, time_created from session_v2 where directory in (?, ?) and time_created >= ? order by time_created')
      .all(...observationDirectories(project), since);
    const roots = sessions.filter(session => !session.parent_id && session.agent === rootAgent);
    const root = roots.at(-1);
    const descendants = new Set(root ? [root.id] : []);
    for (const session of sessions) if (descendants.has(session.parent_id)) descendants.add(session.id);
    let usd = 0, unpriced = 0;
    const errors = [], models = [], tools = [], responses = [];
    for (const session of sessions.filter(item => descendants.has(item.id))) {
      let first;
      for (const message of db.prepare('select id, type, data from session_message where session_id = ? order by seq').all(session.id)) {
        if (message.type !== 'assistant') continue;
        const data = JSON.parse(message.data), tokens = data.tokens;
        first ??= { sessionID: session.id, parentID: session.parent_id, agent: session.agent, model: data.model,
          started_ms: data.time?.created - root.time_created };
        if (data.finish === 'stop' && (data.content ?? []).some(part => part.type === 'text' && part.text?.trim())) {
          responses.push({ sessionID: session.id, agent: session.agent, finished_ms: data.time?.completed - root.time_created });
        }
        const price = estimateModelUsageCost({ providerID: data.model?.providerID, modelID: data.model?.id,
          uncachedInputTokens: tokens?.input, cacheReadTokens: tokens?.cache?.read, cacheWriteTokens: tokens?.cache?.write,
          outputTokens: tokens?.output, reasoningTokens: tokens?.reasoning });
        if (price.status === 'priced') usd += price.usd;
        else unpriced++;
        for (const part of data.content ?? []) if (part.type === 'tool') {
          tools.push({ agent: session.agent, tool: part.name, status: part.state?.status, at_ms: part.time?.created - root.time_created,
            ...(part.name === 'sortie_v010_operator_status' ? { model: data.model } : {}) });
          if (part.state?.status === 'error') errors.push({ sessionID: session.id, tool: part.name,
            error: String(JSON.stringify(part.state?.error ?? part.state?.content)).slice(0, 1500) });
        }
      }
      if (first) models.push(first);
    }
    return { root: root?.id, models, tools, responses, errors, priced_usd: usd, unpriced_requests: unpriced };
  } finally { db.close(); }
}

/** An explicit route/status probe is not a Mission run. Observe one real model turn and one status call. */
export function statusProbeStopReason(observed, expectedModel) {
  const first = observed.models.find(item => item.sessionID === observed.root && item.agent === 'dog-operator');
  if (!first) return null;
  const match = model => model?.providerID && model?.id &&
    `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}` === expectedModel;
  if (!match(first.model)) return 'model-mismatch';
  const status = observed.tools.find(item => item.agent === 'dog-operator' && item.tool === 'sortie_v010_operator_status' &&
    item.status === 'completed');
  if (!status) return null;
  return match(status.model) ? 'status-observed' : 'model-mismatch';
}

export const workerStartWithinProbeLimit = (mode, worker, instance, deadlineMs) =>
  mode !== 'start' || Number.isFinite(worker?.started_ms) && worker.started_ms >= 0 &&
    worker.started_ms <= (deadlineMs ?? (instance ? 180_000 : 60_000));

export function probeStopReason(observed, { mode, rootModel, capUSD, elapsedMs, timeoutMs }) {
  const statusReason = mode === 'status' ? statusProbeStopReason(observed, rootModel) : null;
  if (observed.priced_usd >= capUSD) return 'budget';
  if (statusReason) return statusReason;
  if (mode === 'start' && observed.models.some(item => item.agent === 'dog-worker-v010')) return 'worker-started';
  if (mode === 'build-start' && observed.responses.some(item => item.agent === 'build')) return 'build-responded';
  if (mode === 'operator-response' && observed.responses.some(item => item.agent === 'dog-operator')) return 'operator-responded';
  return elapsedMs > timeoutMs ? 'timeout' : null;
}

/** A normal parent exit can beat the interval even though its native Worker already started.
 * Inspect before server teardown; never relabel a failed exit or an earlier stop. */
export const cliCloseStopReason = (code, stopped, observed, options) =>
  code === 0 && !stopped ? probeStopReason(observed, options) : null;

async function updateBudget(file, update) {
  if (!file) return;
  const lock = `${file}.lock`;
  await mkdir(lock); // An existing owner or unresolved crash blocks another launch.
  try {
    const budget = JSON.parse(await readFile(file, 'utf8'));
    update(budget);
    await writeFile(`${file}.tmp`, JSON.stringify(budget, null, 2));
    await rename(`${file}.tmp`, file);
  } finally { await rm(lock, { recursive: true }); }
}

export async function probe(tgz, output, { mode = 'start', prompt, instance, timeoutSeconds = 180, capUSD = 1, pythonBin, budgetFile,
  setupFixture, onServer, model, profileId = 'v012', workerStartDeadlineMs } = {}) {
  if (!Number.isFinite(capUSD) || capUSD <= 0 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw Error('Probe needs finite positive limits');
  const fixture = await installedFixture(tgz, output, profileId, { nested: false });
  const { project, env, run } = fixture;
  if (instance) {
    await command('git', ['init', '-q'], project, env);
    await command('git', ['fetch', '--depth=1', '--no-tags', `https://github.com/${instance.repo}.git`, instance.base_commit], project, env);
    await command('git', ['checkout', '--detach', '-q', 'FETCH_HEAD'], project, env);
    await writeFile(join(project, '.git/info/exclude'), `.opencode/\n${fixture.runtime.stateDirectory}/\n`);
    if (pythonBin) env.PATH = `${pythonBin}:${process.env.PATH}`;
  } else {
  await writeFile(join(project, '.gitignore'), `.opencode/\n${fixture.runtime.stateDirectory}/\nchild/\n`);
  await writeFile(join(project, 'result.txt'), 'seed\n');
  await writeFile(join(project, 'check.mjs'), "import{readFileSync}from'node:fs';import assert from'node:assert/strict';assert.equal(readFileSync('result.txt','utf8'),'recovered\\n');console.log('MISSION_CLI_PASS');\n");
  await command('git', ['init', '-q'], project, env);
  await command('git', ['add', '--', '.gitignore', 'result.txt', 'check.mjs'], project, env);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], project, env);
  }
  if (setupFixture) await setupFixture(fixture);
  await updateBudget(budgetFile, budget => {
    const probes = budget.probes ??= [];
    const charged = probes.reduce((sum, item) => sum + item.charged_usd, 0);
    const baseline = budget.prior_priced_usd + budget.unresolved_prior_reserve_usd;
    if (![charged, baseline, budget.limit_usd, budget.new_probe_total_limit_usd].every(Number.isFinite) ||
        capUSD > budget.per_probe_limit_usd || baseline + charged + capUSD > budget.limit_usd ||
        charged + capUSD > budget.new_probe_total_limit_usd) throw Error('Campaign budget/reservations cannot admit this probe');
    probes.push({ project, charged_usd: capUSD, reserved_usd: capUSD, state: 'reserved' });
  });
  const server = await startV2ReleaseServer(project, env);
  try { await onServer?.({ server, fixture }); }
  catch (error) { await server.stop(); throw error; }
  const since = Date.now();
  const buildStart = mode === 'build-start';
  const operatorResponse = mode === 'operator-response';
  const statusOnly = mode === 'status';
  const rootAgent = buildStart ? 'build' : 'dog-operator';
  const request = prompt ?? (statusOnly ? 'Call sortie_v010_operator_status once. Do not start a Mission or dispatch a Worker.' :
    buildStart ? 'Reply with just: ready' : operatorResponse
    ? '作業は不要です。ツールを呼ばず、READYとだけ返してください。' : 'result.txt の seed を recovered に置換して。末尾改行は維持。検証は node check.mjs。check.mjs と設定は変更しない。単純な1ユニット作業として実装して。');
  const rootModel = model ?? (operatorResponse ? 'openai/gpt-6-luna-fast#max' : 'openai/gpt-6.1-sol#xhigh');
  const launch = nativeCLI('opencode', ['run', '--server', server.url, '--format', 'json', '--agent', rootAgent, '--model', rootModel, request]);
  const child = spawn(launch.executable, launch.args, {
    cwd: project, env: { ...server.env, PWD: project }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', stopped = false, stopping, cutoff, stopObservation;
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const stop = (reason, observed, point) => {
    if (stopped) return;
    cutoff = observed;
    stopped = reason;
    stopObservation = point;
    stopping = Promise.all([stopProcessGroup(child), server.stop()]);
  };
  const stopOptions = () => ({ mode, rootModel, capUSD, elapsedMs: Date.now() - since, timeoutMs: timeoutSeconds * 1000 });
  const timer = setInterval(() => {
    const observed = observeMissionCLI(project, since, rootAgent);
    const reason = probeStopReason(observed, stopOptions());
    if (reason) stop(reason, observed, 'interval');
  }, 250);
  let code;
  try {
    code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    const observed = observeMissionCLI(project, since, rootAgent);
    const reason = cliCloseStopReason(code, stopped, observed, stopOptions());
    if (reason) stop(reason, observed, 'cli-close');
  }
  finally { clearInterval(timer); await stopping; await server.stop(); }
  const observed = observeMissionCLI(project, since, rootAgent);
  const state = async area => {
    if (!observed.root) return null;
    try { return JSON.parse(await readFile(join(project, fixture.runtime.stateDirectory, area,
      `${createHash('sha256').update(observed.root).digest('hex')}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const mission = await state('missions'), operator = await state('operators');
  const result = { ...observed, ...(statusOnly ? { expected_model: rootModel,
    observed_model: observed.tools.find(item => item.agent === 'dog-operator' && item.tool === 'sortie_v010_operator_status' &&
      item.status === 'completed')?.model ?? observed.models.find(item => item.sessionID === observed.root)?.model ?? null } : {}),
    ...(cutoff ? { errors: cutoff.errors,
    cancellation_errors: observed.errors.filter(error => /"type":"aborted"/.test(error.error)) } : {}),
    project, mode, stopped, stop_observation: stopObservation ?? null, code, elapsed_ms: Date.now() - since,
    package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker,
    mission_phase: mission?.phase ?? null, receipt_status: operator?.receipt?.status ?? null,
    review: mission?.review ? { verdict: mission.review.verdict, child: mission.review.child ?? null } : null,
    candidate_sha256: createHash('sha256').update(await readFile(tgz)).digest('hex') };
  const worker = result.models.find(item => item.agent === 'dog-worker-v010');
  const schemaRejected = /invalid_function_parameters|Invalid schema for function/u.test(stdout + stderr);
  result.accepted = statusOnly ? !schemaRejected && !result.errors.length && stopped === 'status-observed' &&
    result.mission_phase === null :
    operatorResponse ? !schemaRejected && !result.errors.length &&
    (stopped === 'operator-responded' || (!stopped && code === 0)) && result.responses.some(item => item.agent === 'dog-operator') &&
    result.models.some(item => item.agent === 'dog-operator' && item.model?.id === 'gpt-6-luna-fast' && item.model.variant === 'max') :
    buildStart ? !result.errors.length && (stopped === 'build-responded' || (!stopped && code === 0)) &&
    result.responses.some(item => item.agent === 'build') &&
    result.models.some(item => item.agent === 'build' && item.model?.id === 'gpt-6.1-sol') :
    !schemaRejected && worker?.model?.id === 'gpt-6-luna-fast' && worker.model.variant === 'max' &&
    workerStartWithinProbeLimit(mode, worker, instance, workerStartDeadlineMs) &&
    (mode === 'start' ? stopped === 'worker-started'
      : !stopped && code === 0 && result.mission_phase === 'completed' && result.receipt_status === 'succeeded');
  await writeFile(join(run, 'cli.stdout.jsonl'), stdout);
  await writeFile(join(run, 'cli.stderr.log'), stderr);
  await writeFile(join(run, 'observation.json'), JSON.stringify(result, null, 2));
  await updateBudget(budgetFile, budget => {
    const entry = budget.probes.find(item => item.project === project);
    Object.assign(entry, { state: 'settled', root: result.root, priced_usd: result.priced_usd,
      unpriced_requests: result.unpriced_requests,
      charged_usd: result.unpriced_requests ? Math.max(entry.reserved_usd, result.priced_usd) : result.priced_usd });
  });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await probe(resolve(process.argv[2]), resolve(process.argv[3]), { mode: process.argv[4] ?? 'start',
    timeoutSeconds: Number(process.argv[5] ?? 180), ...(process.argv[6] ? { prompt: await readFile(process.argv[6], 'utf8') } : {}) });
  console.log(JSON.stringify(result, null, 2));
  // CLI-only start probes have already persisted their observation and logs.
  // Drop the large isolated installation so old tool schemas cannot be loaded
  // when the shared OpenCode server later revisits this fixture's session.
  if (result.accepted && ['start', 'build-start', 'operator-response', 'status'].includes(result.mode)) {
    const control = join(result.project, '.opencode');
    const observation = JSON.parse(await readFile(join(dirname(result.project), 'observation.json'), 'utf8'));
    if (observation.project === result.project && observation.candidate_sha256 === result.candidate_sha256 &&
        (await lstat(control)).isDirectory()) await rm(control, { recursive: true });
  }
  if (!result.accepted) process.exitCode = 1;
}
