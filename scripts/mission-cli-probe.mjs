import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';
import { estimateModelUsageCost } from '../dist/plugin/model-cost.js';

const database = () => new DatabaseSync(join(homedir(), '.local/share/opencode/opencode.db'), { readOnly: true });
export function observeMissionCLI(project, since = 0, rootAgent = 'dog-operator') {
  const db = database();
  try {
    const sessions = db.prepare('select id, parent_id, agent, time_created from session_v2 where directory = ? and time_created >= ? order by time_created').all(project, since);
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
          tools.push({ agent: session.agent, tool: part.name, status: part.state?.status, at_ms: part.time?.created - root.time_created });
          if (part.state?.status === 'error') errors.push({ sessionID: session.id, tool: part.name,
            error: String(JSON.stringify(part.state?.error ?? part.state?.content)).slice(0, 1500) });
        }
      }
      if (first) models.push(first);
    }
    return { root: root?.id, models, tools, responses, errors, priced_usd: usd, unpriced_requests: unpriced };
  } finally { db.close(); }
}

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
  setupFixture, model } = {}) {
  if (!Number.isFinite(capUSD) || capUSD <= 0 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw Error('Probe needs finite positive limits');
  const fixture = await installedFixture(tgz, output, 'v012', { nested: false });
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
  const since = Date.now();
  const buildStart = mode === 'build-start';
  const operatorResponse = mode === 'operator-response';
  const rootAgent = buildStart ? 'build' : 'dog-operator';
  const request = prompt ?? (buildStart ? 'Reply with just: ready' : operatorResponse
    ? '作業は不要です。ツールを呼ばず、READYとだけ返してください。' : 'result.txt の seed を recovered に置換して。末尾改行は維持。検証は node check.mjs。check.mjs と設定は変更しない。単純な1ユニット作業として実装して。');
  const rootModel = model ?? (operatorResponse ? 'openai/gpt-6-luna-fast#max' : 'openai/gpt-6-sol#xhigh');
  const child = spawn('opencode', ['run', '--server', server.url, '--format', 'json', '--agent', rootAgent, '--model', rootModel, request], {
    cwd: project, env: { ...server.env, PWD: project }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', stopped = false, stopping, cutoff;
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const stop = reason => {
    if (stopped) return;
    cutoff = observeMissionCLI(project, since, rootAgent);
    stopped = reason;
    stopping = server.stop();
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  };
  const timer = setInterval(() => {
    const observed = observeMissionCLI(project, since, rootAgent);
    if (observed.priced_usd >= capUSD) stop('budget');
    else if (observed.errors.length) stop('tool-error');
    else if (mode === 'start' && observed.models.some(item => item.agent === 'dog-worker-v010')) stop('worker-started');
    else if (buildStart && observed.responses.some(item => item.agent === 'build')) stop('build-responded');
    else if (operatorResponse && observed.responses.some(item => item.agent === 'dog-operator')) stop('operator-responded');
    else if (Date.now() - since > timeoutSeconds * 1000) stop('timeout');
  }, 250);
  let code;
  try { code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); }
  finally { clearInterval(timer); await stopping; await server.stop(); }
  const observed = observeMissionCLI(project, since, rootAgent);
  const state = async area => {
    if (!observed.root) return null;
    try { return JSON.parse(await readFile(join(project, fixture.runtime.stateDirectory, area,
      `${createHash('sha256').update(observed.root).digest('hex')}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const mission = await state('missions'), operator = await state('operators');
  const result = { ...observed, ...(cutoff ? { errors: cutoff.errors,
    cancellation_errors: observed.errors.filter(error => /"type":"aborted"/.test(error.error)) } : {}),
    project, mode, stopped, code, elapsed_ms: Date.now() - since,
    mission_phase: mission?.phase ?? null, receipt_status: operator?.receipt?.status ?? null,
    review: mission?.review ? { verdict: mission.review.verdict, child: mission.review.child ?? null } : null,
    candidate_sha256: createHash('sha256').update(await readFile(tgz)).digest('hex') };
  const worker = result.models.find(item => item.agent === 'dog-worker-v010');
  const schemaRejected = /invalid_function_parameters|Invalid schema for function/u.test(stdout + stderr);
  result.accepted = operatorResponse ? !schemaRejected && !result.errors.length &&
    (stopped === 'operator-responded' || (!stopped && code === 0)) && result.responses.some(item => item.agent === 'dog-operator') &&
    result.models.some(item => item.agent === 'dog-operator' && item.model?.id === 'gpt-6-luna-fast' && item.model.variant === 'max') :
    buildStart ? !result.errors.length && (stopped === 'build-responded' || (!stopped && code === 0)) &&
    result.responses.some(item => item.agent === 'build') &&
    result.models.some(item => item.agent === 'build' && item.model?.id === 'gpt-6-sol') :
    !result.errors.length && worker?.model?.id === 'gpt-6-luna-fast' && worker.model.variant === 'max' &&
    worker.started_ms <= (instance ? 180_000 : 60_000) && (mode === 'start' ? stopped === 'worker-started'
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
  if (result.accepted && ['start', 'build-start', 'operator-response'].includes(result.mode)) {
    const control = join(result.project, '.opencode');
    const observation = JSON.parse(await readFile(join(dirname(result.project), 'observation.json'), 'utf8'));
    if (observation.project === result.project && observation.candidate_sha256 === result.candidate_sha256 &&
        (await lstat(control)).isDirectory()) await rm(control, { recursive: true });
  }
  if (!result.accepted) process.exitCode = 1;
}
