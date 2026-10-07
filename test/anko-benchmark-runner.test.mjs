import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  ROOT, STATE_ROOT, READ_STALL_MS, fixedProfile, noProgressStopReason, packageJsonFromTgz, packageRoot,
  diagnosticReadObservations, parseCommand, parseVersion, profilePath, progressSignature, shouldStopForNoProgress,
  priorStandaloneAttempt, versionRoot, writeExclusive,
} from '../scripts/anko-benchmark/core.mjs';
import { eligibleReadPermission } from '../scripts/anko-benchmark/recovery.mjs';
import { expectSessionTurn, installObservationFiles, nativeTurnTerminal, observeSessionState,
  observeSessionTurn, observeToolEvent, observerPlugin, safeNativeEvent, toolPaths, toolWaitObservations, tracedSortiePlugin } from '../scripts/anko-benchmark/observe.mjs';
import { assertReusableDriver, comparablePath, hostPaths, goToolchain, npmCommand } from '../scripts/anko-benchmark/host.mjs';
import { classifyUsage, nativeTerminal, readOwnedUsage, summarizeOwnedUsage, usageSafetyStopReason } from '../scripts/anko-benchmark/usage.mjs';
import { createObservationDeadline, recoverOwnedSessions, settleOwnedSessions } from '../scripts/anko-benchmark/settle.mjs';
import { analyzeSavedTrial } from '../scripts/anko-benchmark/inspect.mjs';
import { estimateModelUsageCost } from '../dist/plugin/model-cost.js';

function packageArchive(packageJson) {
  const content = Buffer.from(JSON.stringify(packageJson));
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header[156] = 48;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(body);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

test('Anko runner CLI keeps package, version and shared profile identities separate', () => {
  assert.deepEqual(parseCommand(['prepare', '--version', '0.13.8', '--package', 'saved.tgz']), {
    command: 'prepare', version: '0.13.8', packagePath: 'saved.tgz',
  });
  assert.throws(() => parseCommand(['run']), /requires --version/u);
  assert.throws(() => parseCommand(['diagnose', '--version', '0.13.8', '--version', '0.13.9']), /repeated/u);
  assert.throws(() => parseCommand(['verify', '--version', '../0.13.8']), /Invalid --version/u);
  assert.equal(parseCommand(['inspect', '--version', '0.13.8']).command, 'inspect');
  assert.equal(versionRoot('0.13.8'), join(STATE_ROOT, 'v0.13.8'));
  assert.equal(packageRoot('0.13.8'), join(STATE_ROOT, 'packages', 'v0.13.8'));
  assert.equal(profilePath(), join(STATE_ROOT, 'common', 'profile.json'));
  const profile = fixedProfile();
  assert.equal(profile.benchmark.max_attempts, 1);
  assert.equal(profile.benchmark.max_wall_ms, 3_600_000);
  assert.equal(profile.benchmark.max_priced_usd, 15);
  assert.equal(profile.benchmark.grading, 'none');
  assert.equal(profile.stall_policy.no_progress_ms, 180_000);
  assert.equal(profile.stall_policy.active_session_status_is_progress, false);
  assert.equal(profile.stall_policy.contextual_recovery.max_prompts, 1);
});

const fullTokens = { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } };
const testModel = { providerID: 'openai', id: 'test', variant: 'max' };
const pricedEstimate = input => ({ status: 'priced', usd: input.uncachedInputTokens / 1000, priceKey: 'test' });
const activeSession = { id: 'root', parent_id: null, time_idle: null, idle_outcome: null };
const endedSession = { ...activeSession, time_idle: 100, idle_outcome: 'interrupted' };

test('Anko terminal events win over delayed starts without hiding another active call', () => {
  for (const terminal of ['session.tool.failed', 'session.tool.success', 'plugin-hook-after']) {
    const tools = new Map(), ended = new Set();
    const send = (type, now) => observeToolEvent(tools, ended,
      { session_id: 'worker', call_id: 'shell', tool: 'shell',
        ...(type.startsWith('plugin-') ? { phase: type } : { type }) }, now);
    send('session.tool.called', 1000);
    send(terminal, 2000);
    send('plugin-hook-before', 2500);
    send('session.tool.input.started', 2600);
    send('session.tool.progress', 2700);
    assert.equal(tools.size, 0);
    observeToolEvent(tools, ended, { type: 'session.tool.called', session_id: 'other', call_id: 'shell', tool: 'shell' }, 3000);
    const live = tools.get('other/shell');
    assert.equal(shouldStopForNoProgress({ now: 26_900, lastProgressAt: live.last_progress_at }), false);
    assert.equal(shouldStopForNoProgress({ now: 183_000, lastProgressAt: live.last_progress_at }), true);
    observeToolEvent(tools, ended, { type: 'session.tool.input.ended', session_id: 'other', call_id: 'shell' }, 184_000);
    assert.equal(tools.size, 1, 'input end is not execution completion');
  }
});

test('Anko a new execution cannot reuse a previous terminal even at the same timestamp', () => {
  const turns = new Map();
  observeSessionTurn(turns, { type: 'session.execution.started', session_id: 'root', created: 10 });
  observeSessionTurn(turns, { type: 'session.execution.interrupted', session_id: 'root', created: 100 });
  observeSessionTurn(turns, { type: 'session.execution.started', session_id: 'root', created: 100 });
  assert.equal(nativeTurnTerminal(endedSession, turns), false);
  observeSessionTurn(turns, { type: 'session.execution.interrupted', session_id: 'root', created: 100 });
  assert.equal(nativeTurnTerminal(endedSession, turns), true);
  observeSessionTurn(turns, { type: 'session.execution.started', session_id: 'root', created: 200 });
  observeSessionTurn(turns, { type: 'session.execution.interrupted', session_id: 'root', created: 100 });
  assert.equal(nativeTurnTerminal(endedSession, turns), false);
});

test('Anko queued continuation acknowledgement cannot reuse the previous native turn', () => {
  const turns = new Map();
  observeSessionTurn(turns, { type: 'session.execution.started', session_id: 'root', created: 10 });
  observeSessionTurn(turns, { type: 'session.execution.interrupted', session_id: 'root', created: 100 });
  expectSessionTurn(turns, 'root', 200);
  observeSessionTurn(turns, { type: 'session.inbox.enqueued', session_id: 'root', created: 201 });
  assert.equal(nativeTurnTerminal({ ...endedSession, time_idle: 202 }, turns), false);
  observeSessionTurn(turns, { type: 'session.execution.started', session_id: 'root', created: 250 });
  assert.equal(nativeTurnTerminal(endedSession, turns), false);
  observeSessionTurn(turns, { type: 'session.execution.interrupted', session_id: 'root', created: 250 });
  assert.equal(nativeTurnTerminal({ ...endedSession, time_idle: 250 }, turns), true);
});

test('Anko offline inspection distinguishes saved estimates from an unconfirmed newer turn', () => {
  const usage = summarizeOwnedUsage([endedSession], [{ id: 'm', session_id: 'root', type: 'assistant',
    data: { model: testModel, time: { completed: 100 }, tokens: fullTokens } }], 'root', pricedEstimate);
  const analysis = analyzeSavedTrial([{ messages: [{ id: 'm', type: 'assistant', tokens: fullTokens }] }],
    [{ type: 'session.execution.started', session_id: 'root', created: 202 }], usage, {});
  assert.equal(analysis.priced_subtotal_usd, 0.02);
  assert.equal(analysis.recorded_estimated_total_usd, 0.02);
  assert.equal(analysis.estimated_total_usd, null);
  assert.equal(analysis.latest_native_turns_settled, false);
  assert.equal(analysis.owned_sessions[0].recorded_native_terminal_observed, true);
  assert.equal(analysis.owned_sessions[0].native_terminal_observed, false);
  assert.equal(usage.estimated_total_usd, 0.02);
});

test('Anko missing terminal usage never reaches the price estimator or becomes zero cost', () => {
  const forbidden = () => assert.fail('incomplete counts were sent to the estimator');
  assert.equal(classifyUsage({ model: testModel }, activeSession, forbidden).status, 'pending-usage');
  for (const message of [
    { model: testModel, error: { type: 'provider.transport' } },
    { time: { completed: 10 } }, // unidentified model must not disappear from the safety stop
    { model: testModel, time: { completed: 10 }, tokens: { ...fullTokens, reasoning: undefined } },
    { model: testModel, time: { completed: 10 }, tokens: { ...fullTokens, output: -1 } },
  ]) {
    const result = classifyUsage(message, activeSession, forbidden);
    assert.equal(result.status, 'missing-terminal-usage');
    assert.equal(result.usd, null);
  }
  assert.equal(classifyUsage({}, endedSession, forbidden).status, 'missing-terminal-usage');
  const zero = classifyUsage({ model: testModel, time: { completed: 10 }, tokens: {
    input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, endedSession, pricedEstimate);
  assert.equal(zero.status, 'priced');
  assert.equal(zero.usd, 0); // explicitly complete counts, not a missing-field default
  for (const reason of ['unknown-model', 'unsupported-service-tier']) {
    const result = classifyUsage({ tokens: fullTokens }, endedSession, () => ({ status: 'unpriced', reason }));
    assert.equal(result.status, 'unpriced-usage');
    assert.equal(result.reason, reason);
    assert.equal(result.usd, null);
  }
});

test('Anko opaque provider state preserves the previous string-only service tier contract', () => {
  const message = { model: { providerID: 'openai', id: 'gpt-6.1-sol' }, tokens: fullTokens };
  const expected = classifyUsage(message, endedSession, estimateModelUsageCost);
  assert.equal(expected.status, 'priced');
  for (const serviceTier of [null, 7, {}, false]) {
    assert.deepEqual(classifyUsage({ ...message, providerState: { serviceTier } }, endedSession,
      estimateModelUsageCost), expected);
  }
});

test('Anko owned compaction usage contributes to the subtotal and missing compaction stops safely', async () => {
  const parent = join(ROOT, '_testenv/anko-reusable');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'usage-test-'));
  const path = join(directory, 'compaction.db');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE session_v2(id,parent_id,agent,model,time_idle,idle_outcome,time_updated); CREATE TABLE session_message(id,session_id,type,data);');
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)').run('root', null, 'worker', JSON.stringify(testModel), 100, 'interrupted', 100);
    const insert = db.prepare('INSERT INTO session_message VALUES (?,?,?,?)');
    insert.run('assistant', 'root', 'assistant', JSON.stringify({ model: testModel, tokens: fullTokens }));
    insert.run('compact', 'root', 'compaction', JSON.stringify({ status: 'completed',
      model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' }, tokens: fullTokens }));
    db.close();
    const priced = readOwnedUsage(path, 'root', pricedEstimate);
    assert.equal(priced.priced_usd, 0.04);
    assert.equal(priced.estimated_total_usd, 0.04);
    assert.equal(priced.sessions[0].assistant_messages, 1);
    assert.deepEqual(priced.sessions[0].observed_models, ['openai/test#max']);
    const armSource = await readFile(join(ROOT, 'scripts/anko-benchmark/arm.mjs'), 'utf8');
    const routeFragment = armSource.slice(armSource.indexOf('const wrongSolRoute ='), armSource.indexOf('const rootSession ='));
    assert.equal(vm.runInNewContext(`${routeFragment};wrongSolRoute`, {
      lastUsage: priced, expectedRootModel: 'openai/gpt-6.1-sol#xhigh',
    }), undefined);
    const update = new DatabaseSync(path);
    update.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({ status: 'failed', error: { type: 'provider.transport' } }), 'compact');
    update.close();
    const missing = readOwnedUsage(path, 'root', pricedEstimate);
    assert.equal(missing.priced_usd, 0.02);
    assert.equal(missing.cost_estimate_complete, false);
    assert.equal(missing.estimated_total_usd, null);
    assert.equal(missing.actual_billed_usd, null);
    assert.equal(usageSafetyStopReason(missing), 'unpriced-usage-safety-stop');
    assert.equal(missing.records.find(item => item.id === 'compact').status, 'missing-terminal-usage');
    const correlation = analyzeSavedTrial([{ messages: [{ id: 'compact', type: 'compaction', status: 'failed',
      error: { type: 'provider.transport' } }] }], [], missing, {});
    assert.equal(correlation.db_assistant_records, 1);
    assert.equal(correlation.db_compaction_records, 1);
    assert.equal(correlation.export_compaction_records, 1);
    assert.equal(correlation.provider_failures[0].export_record_observed, true);
    const pending = summarizeOwnedUsage([activeSession], [{ id: 'compact', session_id: 'root', type: 'compaction',
      data: { status: 'running' } }], 'root', pricedEstimate);
    assert.equal(pending.pending_messages, 1);
    assert.equal(pending.estimated_total_usd, null);
    assert.equal(usageSafetyStopReason(pending), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Anko read-only DB accounting includes owned descendants, excludes strangers and preserves missing records', async () => {
  const parent = join(ROOT, '_testenv/anko-reusable');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'usage-test-'));
  const path = join(directory, 'usage.db');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE session_v2(id,parent_id,agent,model,time_idle,idle_outcome,time_updated); CREATE TABLE session_message(id,session_id,type,data);');
    const insert = db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)');
    for (const [id, parentID] of [['root', null], ['child', 'root'], ['grandchild', 'child'], ['stranger', null]])
      insert.run(id, parentID, 'worker', JSON.stringify(testModel), 100, 'interrupted', 100);
    const message = db.prepare('INSERT INTO session_message VALUES (?,?,?,?)');
    message.run('priced', 'root', 'assistant', JSON.stringify({ model: testModel, tokens: fullTokens }));
    message.run('missing', 'child', 'assistant', JSON.stringify({ error: { type: 'provider.transport' } }));
    message.run('incomplete', 'grandchild', 'assistant', '{}');
    message.run('ignore', 'stranger', 'assistant', JSON.stringify({ model: testModel, tokens: fullTokens }));
    db.close();
    const before = await readFile(path);
    const usage = readOwnedUsage(path, 'root', pricedEstimate);
    assert.equal(usage.priced_usd, 0.02);
    assert.equal(usage.unpriced_messages, 2);
    assert.equal(usage.missing_token_messages, 2);
    assert.equal(usage.estimated_total_usd, null);
    assert.equal(usage.actual_billed_usd, null);
    assert.equal(usageSafetyStopReason(usage), 'unpriced-usage-safety-stop');
    assert.deepEqual(usage.sessions.map(item => item.id), ['root', 'child', 'grandchild']);
    assert.equal(usage.records.find(item => item.id === 'missing').estimated_usd, null);
    assert.deepEqual(await readFile(path), before);
    assert.throws(() => readOwnedUsage(path, 'absent', pricedEstimate), /root is missing/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Anko transport observation retains typed failure, usage presence and retry metadata without secret text', () => {
  const event = safeNativeEvent({ type: 'session.step.failed', data: { sessionID: 'child',
    error: { type: 'provider.transport', message: 'WebSocket closed with code 1006 SECRET' },
    attempt: 2, at: 50, headers: { Authorization: 'SECRET' }, providerState: { responseId: 'SECRET' } } });
  assert.equal(event.error_type, 'provider.transport');
  assert.equal(event.transport_close_code, '1006');
  assert.equal(event.usage_present, false);
  assert.equal(event.retry_attempt, 2);
  assert(!JSON.stringify(event).includes('SECRET'));
  assert.equal(safeNativeEvent({ data: { tokens: fullTokens } }).usage_present, true);
});

test('Anko offline correlation separates provider failure from observer transport and scheduled retry from execution', () => {
  const sessions = [activeSession, { ...endedSession, id: 'child', parent_id: 'root' }];
  const data = { model: testModel, time: { completed: 120 }, error: {
    type: 'provider.transport', message: 'WebSocket closed with code 1006' }, retry: { attempt: 2, at: 300 } };
  const usage = summarizeOwnedUsage(sessions, [{ id: 'm', session_id: 'child', type: 'assistant', data },
    { id: 'root-stream', session_id: 'root', type: 'assistant', data: {} }], 'root', pricedEstimate);
  const analysis = analyzeSavedTrial([{ messages: [{ ...data, id: 'm', type: 'assistant' }] }], [
    { type: 'session.tool.success', assistant_message_id: 'm', created: 100 },
    { type: 'session.step.failed', assistant_message_id: 'm', created: 120 },
    { type: 'session.retry.scheduled', assistant_message_id: 'm', created: 121 },
    { type: 'session.text.delta', session_id: 'root', created: 122 },
    { type: 'session.execution.interrupted', session_id: 'child', created: 200 },
  ], usage, { native_event_stream: { error: null } });
  assert.equal(analysis.observer_stream_error, null);
  assert.equal(analysis.provider_failures[0].tool_success_to_failure_ms, 20);
  assert.equal(analysis.provider_failures[0].retry_step_starts_after_schedule, 0);
  assert.equal(analysis.provider_failures[0].observer_events_after_failure, 3);
  assert.deepEqual(analysis.db_records_absent_from_export, ['root-stream']);
  assert.equal(analysis.estimated_total_usd, null);
  assert.match(analysis.conclusion, /cause-not-proven/u);
});

function settlementFixture(readUsage, overrides = {}) {
  let clock = 1_000;
  const interrupted = [], snapshots = [];
  return { interrupted, snapshots, options: { readUsage,
    observeSession: async () => ({ outcome: 'interrupted', time: { idle: 100 } }),
    listPermissions: async () => [], activeTools: () => [],
    interrupt: async id => { interrupted.push(id); }, record: async snapshot => { snapshots.push(snapshot); },
    now: () => clock, wait: async ms => { clock += ms; }, budgetMs: 500, intervalMs: 100, ...overrides } };
}

test('Anko a newer execution invalidates stale idle in bounded settlement', async () => {
  const turns = new Map();
  observeSessionTurn(turns, { type: 'session.execution.started', session_id: 'root', created: 202 });
  const isTerminal = session => nativeTurnTerminal(session, turns);
  const stale = settlementFixture(() => ({ sessions: [endedSession], cost_estimate_complete: true }), {
    isTerminal, observeSession: async () => ({ outcome: 'interrupted', time: { idle: 100 } }),
  });
  const unresolved = await settleOwnedSessions(stale.options);
  assert.equal(unresolved.native_settled, false);
  assert.equal(unresolved.status, 'deadline-unresolved');
  assert.deepEqual(stale.interrupted, ['root']);
  observeSessionTurn(turns, { type: 'session.execution.interrupted', session_id: 'root', created: 300 });
  assert.equal(isTerminal({ ...endedSession, time_idle: 300, active: true }), false);
  const fresh = settlementFixture(() => ({ sessions: [{ ...endedSession, time_idle: 300 }], cost_estimate_complete: true }), {
    isTerminal, observeSession: async () => ({ outcome: 'interrupted', time: { idle: 300 } }),
  });
  assert.equal((await settleOwnedSessions(fresh.options)).native_settled, true);
});

test('Anko bounded drain recovers late usage and newly owned children without prompts or repeated interrupts', async () => {
  let reads = 0;
  const fixture = settlementFixture(() => {
    reads += 1;
    const sessions = reads >= 2 ? [endedSession, { ...endedSession, id: 'child', parent_id: 'root' }] : [activeSession];
    if (reads === 2) sessions[1] = { ...activeSession, id: 'child', parent_id: 'root' };
    return { sessions, cost_estimate_complete: reads >= 3, priced_usd: reads >= 3 ? 0.02 : 0,
      estimated_total_usd: reads >= 3 ? 0.02 : null };
  });
  const result = await settleOwnedSessions(fixture.options);
  assert.equal(result.status, 'settled');
  assert.equal(result.samples, 3);
  assert.equal(result.usage.priced_usd, 0.02);
  assert.deepEqual(fixture.interrupted, ['root', 'child']);
  assert.equal(fixture.snapshots[0].native_settled, false); // ack/API alone, DB still active
});

test('Anko native settlement requires both idle timestamp/outcome, successful permission queries and no pending tools', async () => {
  assert.equal(nativeTerminal({ idle_outcome: 'interrupted', time_idle: null }), false);
  assert.equal(nativeTerminal({ idle_outcome: null, time_idle: 100 }), false);
  for (const overrides of [
    { observeSession: async () => ({ outcome: null, time: {} }) },
    { observeSession: async () => ({ outcome: 'succeeded', time: { idle: 100 } }) },
    { observeSession: async () => ({ outcome: 'interrupted', time: { idle: 101 } }) },
    { listPermissions: async () => { throw new Error('query failed'); } },
    { listPermissions: async () => [{ id: 'permission' }] },
    { activeTools: () => [{ id: 'tool' }] },
  ]) {
    const fixture = settlementFixture(() => ({ sessions: [endedSession], cost_estimate_complete: true }), overrides);
    const result = await settleOwnedSessions(fixture.options);
    assert.equal(result.status, 'deadline-unresolved');
    assert.equal(result.elapsed_ms, 500);
    assert.equal(result.native_settled, false);
    assert.deepEqual(fixture.interrupted, []);
  }
});

test('Anko missing usage and hanging observation retain the stop within a bounded cleanup, interrupt once', async () => {
  const fixture = settlementFixture(() => ({ sessions: [activeSession], cost_estimate_complete: false }), {
    now: Date.now, wait: ms => new Promise(done => setTimeout(done, ms)), budgetMs: 30,
    observeSession: () => new Promise(() => {}),
  });
  const result = await settleOwnedSessions(fixture.options);
  assert.equal(result.status, 'deadline-unresolved');
  assert.equal(result.usage_recovered, false);
  assert.equal(result.observations[0].api_status, 'query-error');
  assert.deepEqual(fixture.interrupted, ['root']);
  assert(result.elapsed_ms < 1000);
});

test('Anko runner modules parse without invoking an arm or setup', () => {
  for (const file of ['scripts/anko-benchmark.mjs', ...['arm', 'run', 'core', 'host', 'prepare', 'verify', 'diagnostic-owned', 'diagnose', 'usage', 'settle', 'inspect', 'observe']
    .map(name => `scripts/anko-benchmark/${name}.mjs`)])
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
});

test('Anko Linux host uses existing native CLI, repository client and Go without WSL or Windows storage', () => {
  const paths = hostPaths({ root: '/workspace', platform: 'linux', home: '/home/test', env: {} });
  assert.equal(paths.host_database, '/home/test/.local/share/opencode/opencode.db');
  assert.equal(paths.client_package, '/workspace/node_modules/@opencode/client/package.json');
  assert.equal(paths.release_root, '/workspace/_testenv/releases');
  assert.equal(paths.artifact_root, '/workspace/_testenv/anko-records');
  const toolchain = goToolchain(paths, '/workspace/candidate', () => assert.fail('Linux invoked WSL'));
  assert.equal(toolchain.invocation(['test', './...']).file, `${paths.go_directory}/bin/go`);
  assert.match(toolchain.validation_command, /GOCACHE=\/workspace\/candidate\/\.gocache/u);
  assert(!toolchain.validation_command.includes('wsl.exe'));
  assert.deepEqual(npmCommand(['--version'], { platform: 'linux' }), { file: 'npm', args: ['--version'] });
});

test('Anko Windows host retains CLI/client paths and WSL Go validation', () => {
  const paths = hostPaths({ root: 'C:\\workspace', platform: 'win32', home: 'C:\\Users\\test', env: {} });
  assert.match(paths.client_package, /\.sortie-env\\node_modules\\@opencode\\client/u);
  assert(paths.cli.endsWith('2.0.18/opencode-cli.exe'));
  const calls = [];
  const toolchain = goToolchain(paths, 'C:\\workspace\\candidate', (file, args) => {
    calls.push([file, args]); return args.at(-1) === paths.go_directory ? '/mnt/c/go\n' : '/mnt/c/candidate\n';
  });
  assert.equal(calls.length, 2);
  assert(calls.every(([file]) => file === 'wsl.exe'));
  assert.equal(toolchain.invocation(['test', './...']).file, 'wsl.exe');
  assert.match(toolchain.validation_command, /\/mnt\/c\/go\/bin\/go/u);
  assert.deepEqual(npmCommand(['install'], { platform: 'win32', execPath: 'C:\\node\\node.exe', npmExecPath: 'C:\\node\\npm.js' }),
    { file: 'C:\\node\\node.exe', args: ['C:\\node\\npm.js', 'install'] });
});

test('Anko host overrides are preparation paths, not additional permission rules', () => {
  const paths = hostPaths({ root: '/workspace', platform: 'linux', home: '/home/test', env: {
    ANKO_CLI: '/tools/opencode', ANKO_SOURCE_PROJECT: '/source/anko', ANKO_GO_DIRECTORY: '/tools/go',
    ANKO_INSTRUCTION: '/inputs/instruction.md', ANKO_ARTIFACT_ROOT: '/records',
  } });
  assert.equal(paths.cli, '/tools/opencode');
  assert.equal(paths.source_project, '/source/anko');
  assert.equal(paths.instruction, '/inputs/instruction.md');
  assert.equal(paths.artifact_root, '/records');
  assert(!JSON.stringify(paths).includes('permissions'));
  assert.equal(comparablePath('/source/Env.go') === comparablePath('/source/env.go'), false);
  assert.equal(comparablePath('C:\\source\\Env.go'), comparablePath('c:/source/env.go'));
});

test('Anko Linux repository version bumps do not invalidate an unchanged driver, arm lock remains frozen', () => {
  const saved = { version: '2.0.18', package_lock_sha256: 'sortie-0.13.9-lock' };
  const current = { ...saved, package_lock_sha256: 'sortie-0.13.10-lock' };
  assert.doesNotThrow(() => assertReusableDriver(saved, current, 'linux'));
  assert.throws(() => assertReusableDriver(saved, { ...current, version: '2.0.20' }, 'linux'), /version changed/u);
  assert.throws(() => assertReusableDriver(saved, current, 'win32'), /Windows driver lock changed/u);
  const source = readFileSync(join(ROOT, 'scripts/anko-benchmark/arm.mjs'), 'utf8');
  assert.match(source, /const clientLockSha = await hashFile\(join\(output, 'driver-client-package-lock.json'\)\)/u);
  assert.match(source, /assert.equal\(await hashFile\(driverClientLockPath\), clientLockSha/u);
});

test('Anko CLI argument errors do not eagerly import a missing diagnostic client', () => {
  let error;
  try { execFileSync(process.execPath, ['scripts/anko-benchmark.mjs', 'run'], {
    encoding: 'utf8', env: { ...process.env, ANKO_CLI: '/absent/opencode' }, stdio: 'pipe',
  }); } catch (value) { error = value; }
  assert.equal(error.status, 1);
  assert.match(error.stderr, /run requires --version/u);
  assert(!error.stderr.includes('ERR_MODULE_NOT_FOUND'));
});

test('Anko run admits one arm without a paid diagnostic or historical-attempt gate', async () => {
  const source = await readFile(join(ROOT, 'scripts/anko-benchmark/run.mjs'), 'utf8');
  const calls = [], written = new Map();
  const context = { assert, join, console: { log() {} }, process: { exitCode: null }, Date,
    versionRoot: () => '/version', profilePath: () => '/profile', packageReceiptPath: () => '/package',
    exists: async () => false, prepareVersion: async () => calls.push('prepare'),
    priorStandaloneAttempt: async () => null,
    verifyVersion: async (_, options) => { assert.equal(options.includeDiagnosis, false); return { status: 'preflight-ready', benchmark_accepted: false }; },
    readJson: async path => path === '/package' ? { sha256: 'package' } : { stall_policy: { no_progress_ms: READ_STALL_MS } },
    fixExecutionPolicy: async (_, __, diagnosis) => { assert.equal(diagnosis, null); return {}; },
    writeExclusive: async (path, text) => { written.set(path, JSON.parse(text)); },
    writeJson: async (path, value) => { written.set(path, value); },
    hashFile: async () => 'digest', READ_STALL_MS, WALL_LIMIT_MS: 3_600_000, COST_LIMIT_USD: 15,
    buildTrial: async (_, __, ___, diagnosis) => { assert.equal(diagnosis, null); return { trial_id: 'one', trial_directory: '/trial', record_path: '/record' }; },
    runChild: async () => { calls.push('arm'); return { exit: 1, signal: null }; },
  };
  await vm.runInNewContext(source.slice(source.indexOf('export async function runVersion')).replace('export async', 'async') + ';runVersion("0.13.9")', context);
  assert.deepEqual(calls, ['prepare', 'arm']);
  assert.equal(written.get('/version/run-once.lock').stage, 'arm-terminal');
  assert.equal(written.get('/version/run-once.lock').benchmark_attempt, 1);
});

test('Anko common runner does not reset the consumed retained Linux attempt', async () => {
  const parent = join(ROOT, '_testenv/anko-reusable');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'prior-attempt-test-'));
  try {
    const paths = { platform: 'linux', legacy_run: directory };
    await writeFile(join(directory, 'candidate.json'), '{"version":"0.13.9","package_sha256":"fixed"}\n');
    assert.equal(await priorStandaloneAttempt('0.13.9', paths), null);
    await writeFile(join(directory, 'run-once.lock'), '{"max_attempts":1}\n');
    const before = await readFile(join(directory, 'run-once.lock'));
    assert.equal((await priorStandaloneAttempt('0.13.9', paths)).package_sha256, 'fixed');
    assert.equal(await priorStandaloneAttempt('0.13.10', paths), null);
    assert.deepEqual(await readFile(join(directory, 'run-once.lock')), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Anko pending patch preserves every file/rename target without retaining patch contents', () => {
  const patchText = '*** Begin Patch\n*** Update File: /candidate/ast/stmt.go\n+SECRET BODY\n*** Add File: /wrong/env/env.go\n*** Move to: env/moved.go\n*** Delete File: old.go\n*** End Patch';
  const expected = ['/candidate/ast/stmt.go', '/wrong/env/env.go', 'env/moved.go', 'old.go'];
  assert.deepEqual(toolPaths('patch', { patchText }), expected);
  const event = safeNativeEvent({ type: 'session.tool.called', data: {
    sessionID: 'worker', id: 'patch-1', name: 'patch', input: { patchText },
  } });
  assert.deepEqual(event.paths, expected);
  assert(!JSON.stringify(event).includes('SECRET BODY'));
  const tools = new Map();
  observeToolEvent(tools, new Set(), event, 1000);
  assert.deepEqual(tools.get('worker/patch-1').paths, expected);
  assert.equal(noProgressStopReason({ activeTool: tools.get('worker/patch-1') }), 'native-tool-no-progress-timeout');
  assert.equal(shouldStopForNoProgress({ now: 181000, lastProgressAt: tools.get('worker/patch-1').last_progress_at }), true);
  assert.match(observerPlugin, /paths: toolPaths/u);
  assert.match(tracedSortiePlugin, /paths: toolPaths/u);
  const arm = readFileSync(join(ROOT, 'scripts/anko-benchmark/arm.mjs'), 'utf8');
  assert.match(arm, /await installObservationFiles\(project\)/u);
});

test('Anko tool wait distinguishes native permission, unfinished Sortie hook and unknown boundary without enforcement', () => {
  const tool = { session_id: 'worker', call_id: 'patch', name: 'patch', paths: ['/candidate/code.go', '/wrong/env.go'] };
  const hook = { session_id: 'worker', call_id: 'patch', phase: 'sortie-hook-start', domain: 'tool', hook: 'execute.before', at: '2026-10-07T00:00:00Z' };
  const request = { id: 'permission', sessionID: 'worker', source: { id: 'patch' } };
  const pending = toolWaitObservations([tool], [hook], [request], '/candidate')[0];
  assert.equal(pending.observed_boundary, 'native-permission-pending');
  assert.deepEqual(pending.paths_outside_project, ['/wrong/env.go']);
  assert.deepEqual(pending.pending_permission_ids, ['permission']);
  assert.equal(pending.root_cause_confirmed, false);
  assert.equal(toolWaitObservations([tool], [hook], [], '/candidate')[0].observed_boundary, 'sortie-hook-start-without-end');
  const ended = { ...hook, phase: 'sortie-hook-end', at: '2026-10-07T00:00:01Z' };
  assert.equal(toolWaitObservations([tool], [hook, ended], [], '/candidate')[0].observed_boundary, 'native-tool-start-without-terminal');
  assert.deepEqual(tool.paths, ['/candidate/code.go', '/wrong/env.go']);
});

test('Anko repeated edits of an already dirty source count as progress', async () => {
  const parent = join(ROOT, '_testenv/anko-reusable');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'source-progress-test-'));
  try {
    const cmd = (file, args, options) => execFileSync(file, args, { encoding: 'utf8', ...options });
    const git = args => cmd('git', args, { cwd: directory });
    git(['init', '-q']);
    git(['config', 'user.name', 'Anko test']); git(['config', 'user.email', 'anko@example.invalid']);
    await writeFile(join(directory, 'code.go'), 'base\n');
    git(['add', 'code.go']); git(['commit', '-qm', 'base']);
    const source = readFileSync(join(ROOT, 'scripts/anko-benchmark/arm.mjs'), 'utf8');
    const fragment = source.slice(source.indexOf('function sourceProgressSignature'), source.indexOf('async function readJsonLines'));
    const signature = () => vm.runInNewContext(fragment + ';sourceProgressSignature(project)', {
      project: directory, cmd, join, readFileSync, hash: value => createHash('sha256').update(value).digest('hex'),
    });
    await writeFile(join(directory, 'code.go'), 'first change\n');
    const status = git(['status', '--porcelain']); const first = signature();
    await writeFile(join(directory, 'code.go'), 'second change\n');
    assert.equal(git(['status', '--porcelain']), status);
    assert.notEqual(signature(), first);
    await writeFile(join(directory, 'new.go'), 'first\n'); const untracked = signature();
    await writeFile(join(directory, 'new.go'), 'second\n');
    assert.notEqual(signature(), untracked);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Anko drain does not re-interrupt a previously requested session or query beyond a spent deadline', async () => {
  const fixture = settlementFixture(() => ({ sessions: [activeSession], cost_estimate_complete: false }), {
    requested: new Set(['root']), budgetMs: 0,
    observeSession: () => assert.fail('query beyond deadline'), listPermissions: () => assert.fail('query beyond deadline'),
  });
  const result = await settleOwnedSessions(fixture.options);
  assert.equal(result.status, 'deadline-unresolved');
  assert.equal(result.samples, 1);
  assert.equal(result.budget_ms, 0);
  assert.equal(result.native_settled, false);
  assert.deepEqual(fixture.interrupted, []);
});

test('Anko failed interrupt stays unconfirmed and is requested only once during the drain', async () => {
  let attempts = 0;
  const fixture = settlementFixture(() => ({ sessions: [activeSession], cost_estimate_complete: false }), {
    interrupt: async () => { attempts += 1; throw new Error('transport unavailable'); },
  });
  const result = await settleOwnedSessions(fixture.options);
  assert.equal(attempts, 1);
  assert.equal(result.status, 'deadline-unresolved');
  assert.equal(result.native_settled, false);
  assert.equal(result.interruptions[0].acknowledged, false);
});

test('Anko post-stop history export shares the drain deadline and keeps earlier successful histories', async () => {
  const sessions = [endedSession, { ...endedSession, id: 'child', parent_id: 'root' }];
  let hangingSignal;
  const fixture = settlementFixture(() => ({ sessions, cost_estimate_complete: true }), {
    now: Date.now, wait: ms => new Promise(done => setTimeout(done, ms)), budgetMs: 30,
  });
  let cleanupReached = false;
  let recovered;
  const started = Date.now();
  try {
    recovered = await recoverOwnedSessions({ ...fixture.options, exportSession: (id, signal) => {
      if (id === 'root') return Promise.resolve({ info: { id }, messages: [] });
      hangingSignal = signal;
      return new Promise(() => {});
    } });
  } finally { cleanupReached = true; }
  assert.equal(cleanupReached, true);
  assert(Date.now() - started < 1000);
  assert.equal(hangingSignal.aborted, true);
  assert.equal(recovered.settlement.native_settled, true);
  assert.deepEqual(recovered.history, [{ info: { id: 'root' }, messages: [] }]);
  assert.deepEqual(recovered.history_errors, [{ session_id: 'child', error: 'session-export-unconfirmed' }]);
  const arm = await readFile(join(ROOT, 'scripts/anko-benchmark/arm.mjs'), 'utf8');
  assert.match(arm, /await recoverOwnedSessions\(/u);
  assert.match(arm, /client\.session\.export\(\{ sessionID \}, \{ signal \}\)/u);
  assert(!arm.includes('await Promise.race([promptPromise, delay(10_000)])'));
});

test('Anko spent wall deadline prevents every post-stop API and is not reset by recovery', async () => {
  let clock = 1000;
  const observationDeadline = createObservationDeadline({ now: () => clock, started: 900, wallDeadline: 1000 });
  const fixture = settlementFixture(() => ({ sessions: [activeSession], cost_estimate_complete: false }), {
    observationDeadline, now: () => clock,
    interrupt: () => assert.fail('interrupt beyond wall deadline'),
    observeSession: () => assert.fail('query beyond wall deadline'),
    listPermissions: () => assert.fail('permission query beyond wall deadline'),
  });
  const recovered = await recoverOwnedSessions({ ...fixture.options,
    exportSession: () => assert.fail('export beyond wall deadline') });
  assert.equal(recovered.observation_budget_ms, 100);
  assert.equal(recovered.settlement.elapsed_ms, 100);
  assert.equal(recovered.settlement.status, 'deadline-unresolved');
  assert.equal(recovered.history.length, 0);
  assert.equal(recovered.history_errors.length, 1);
  assert.deepEqual(fixture.interrupted, []);
});

test('Anko final ownership and dispatch counts survive missing native exports', async () => {
  const source = await readFile(join(ROOT, 'scripts/anko-benchmark/arm.mjs'), 'utf8');
  const fragment = source.slice(source.indexOf('const ownedSessions ='), source.indexOf('const observation ='));
  const finalUsage = { sessions: [endedSession, { ...activeSession, id: 'child', parent_id: 'root' }] };
  const context = vm.createContext({ history: [], finalUsage });
  const sessions = JSON.parse(JSON.stringify(vm.runInContext(`${fragment};ownedSessions`, context)));
  assert.deepEqual(sessions.map(item => item.id), ['root', 'child']);
  assert.equal(sessions.filter(item => item.id !== 'root').length, 1);
  assert.equal(sessions[0].outcome, 'interrupted');
  assert.equal(sessions[0].time_idle, 100);
  assert.equal(sessions[1].outcome, null);
  assert.equal(sessions[1].time_idle, null);
});

test('Anko record integrity preserves unaccepted settlement results and the legacy receipt contract', async () => {
  const source = await readFile(join(ROOT, 'scripts/anko-benchmark/verify.mjs'), 'utf8');
  const start = source.indexOf('assert.equal(observation.accepted,');
  const end = source.indexOf('assert.equal(await exists(launchRecord.record_path)', start);
  const check = source.slice(start, end);
  const legacy = { stop_reason: 'accepted', receipt: { status: 'succeeded', stop_reason: 'completed' }, accepted: true };
  for (const observation of [legacy,
    { ...legacy, accepted: false, settlement: { native_settled: false }, cost_estimate_complete: true },
    { ...legacy, accepted: false, settlement: { native_settled: true }, cost_estimate_complete: false },
    { ...legacy, settlement: { native_settled: true }, cost_estimate_complete: true },
  ]) vm.runInNewContext(check, { assert, observation });
});

test('Anko simultaneous unconfirmed interrupts and exports cannot multiply the cleanup budget', async () => {
  const sessions = [activeSession, { ...activeSession, id: 'child', parent_id: 'root' }];
  const attempts = [];
  const fixture = settlementFixture(() => ({ sessions, cost_estimate_complete: false }), {
    now: Date.now, wait: ms => new Promise(done => setTimeout(done, ms)), budgetMs: 30,
    interrupt: id => { attempts.push(id); return new Promise(() => {}); },
  });
  const started = Date.now();
  const recovered = await recoverOwnedSessions({ ...fixture.options, exportSession: () => new Promise(() => {}) });
  assert(Date.now() - started < 1000);
  assert.deepEqual(attempts, ['root', 'child']);
  assert.equal(recovered.settlement.status, 'deadline-unresolved');
  assert.equal(recovered.settlement.interruptions.length, 2);
  assert(recovered.settlement.interruptions.every(item => item.acknowledged === false));
  assert.equal(recovered.history_errors.length, 2);
});

test('Anko no-progress deadline distinguishes permission, stalled read and unknown session waits', () => {
  assert.equal(shouldStopForNoProgress({ now: 1_179_999, lastProgressAt: 1_000_000 }), false);
  assert.equal(shouldStopForNoProgress({ now: 1_180_000, lastProgressAt: 1_000_000 }), true);
  assert.equal(noProgressStopReason({ pendingPermissionCount: 1, activeTool: { name: 'read' } }),
    'permission-confirmation-no-progress-timeout');
  assert.equal(noProgressStopReason({ activeTool: { name: 'read' } }), 'native-read-no-progress-timeout');
  assert.equal(noProgressStopReason({}), 'session-no-progress-timeout');
});

test('Anko diagnostic read observations preserve a partial native and hook boundary without inventing completion', () => {
  const targets = [
    { id: 'repo-existing-file', path: 'M:\\candidate\\go.mod', expected_presence: 'present', aliases: ['go.mod'] },
    { id: 'repo-missing-agents', path: 'M:\\candidate\\AGENTS.md', expected_presence: 'absent', aliases: ['AGENTS.md'] },
    { id: 'ancestor-agents', path: 'M:\\repo\\AGENTS.md', expected_presence: 'present', aliases: [] },
  ];
  const events = [{ type: 'session.tool.input.started', call_id: 'read-1', name: 'read', path: 'M:/candidate/go.mod' }];
  const hooks = [{ phase: 'plugin-hook-before', call_id: 'read-1', tool: 'read', path: 'M:\\candidate\\go.mod' }];
  const observations = diagnosticReadObservations(events, hooks, targets);
  assert.deepEqual(observations.map(item => item.target_id), targets.map(item => item.id));
  assert.equal(observations[0].status, 'read-boundary-observed');
  assert.equal(observations[0].native_tool_start_observed, true);
  assert.equal(observations[0].plugin_hook_before_observed, true);
  assert.equal(observations[0].plugin_hook_after_observed, false);
  assert.equal(observations[0].native_tool_terminal_observed, false);
  assert.deepEqual(observations.slice(1).map(item => item.status), ['not-observed', 'not-observed']);
});

test('Anko progress signature ignores active status but records measured session and candidate changes', () => {
  const progress = { priced_usd: 0, priced_messages: 0, native_progress_event_count: 0,
    candidate_source_signature: 'base', permission_state: [], owned_sessions: [{ id: 'worker-1', agent: 'dog-worker-v010',
      active: true, outcome: null, time_idle: null, assistant_messages: 0, token_usage: { output: 0 } }] };
  const initial = progressSignature(progress);
  assert.equal(progressSignature({ ...progress, owned_sessions: [{ ...progress.owned_sessions[0], active: false }] }), initial);
  assert.notEqual(progressSignature({ ...progress, priced_messages: 1 }), initial);
  assert.notEqual(progressSignature({ ...progress, candidate_source_signature: 'changed' }), initial);
  assert.notEqual(progressSignature({ ...progress, native_progress_event_count: 1 }), initial);
});

test('Anko input-end is not proof of native read completion', () => {
  const target = { id: 'ancestor-agents', path: 'M:/repo/AGENTS.md' };
  const events = [{ type: 'session.tool.input.started', call_id: 'read-1', path: target.path },
    { type: 'session.tool.input.ended', call_id: 'read-1', path: target.path }];
  const [read] = diagnosticReadObservations(events, [], [target]);
  assert.equal(read.native_tool_start_observed, true);
  assert.equal(read.native_tool_terminal_observed, false);
});

test('Anko once recovery is bound to an owned native read of the fixed AGENTS file', () => {
  const policy = { applicable_agents_path: 'M:/repo/AGENTS.md' };
  const tool = { session_id: 'child', call_id: 'call-read', name: 'read', path: 'M:\\repo\\AGENTS.md' };
  const request = { id: 'permission-1', session_id: 'child', action: 'external_directory',
    resources: ['M:/repo/*'], source: { type: 'tool', id: 'call-read' } };
  const owned = new Set(['child']);
  assert.equal(eligibleReadPermission(request, tool, policy, owned), true);
  assert.equal(eligibleReadPermission(request, tool, policy, new Set()), false);
  assert.equal(eligibleReadPermission(request, { ...tool, name: 'patch' }, policy, owned), false);
  assert.equal(eligibleReadPermission(request, { ...tool, path: 'M:/repo/secret.txt' }, policy, owned), false);
  assert.equal(eligibleReadPermission({ ...request, resources: ['M:/*'] }, tool, policy, owned), false);
  assert.equal(eligibleReadPermission({ ...request, action: 'edit' }, tool, policy, owned), false);
  assert.equal(eligibleReadPermission({ ...request, source: { type: 'tool', id: 'other-call' } }, tool, policy, owned), false);
  assert.equal(eligibleReadPermission({ ...request, action: 'read', resources: ['M:/repo/AGENTS.md'] }, tool, policy, owned), true);
});

test('Anko package receipt reads the package manifest from a version-specific archive', () => {
  const manifest = { name: 'sortie-dogs', version: '0.13.8', marker: 'saved-local-package' };
  assert.deepEqual(packageJsonFromTgz(packageArchive(manifest)), manifest);
  assert.throws(() => packageJsonFromTgz(gzipSync(Buffer.alloc(512))), /package\/package.json/u);
});

test('Anko repeated session observation timeouts do not bypass the frozen inactivity deadline', async () => {
  const errors = [];
  const lastProgressAt = 1_000_000;
  let checks = 0, stoppedAt = null;
  for (const elapsed of [0, 60_000, 120_000, 180_000]) {
    const state = await observeSessionState(async () => { throw new Error('session.get timed out'); },
      async error => { errors.push(error); });
    assert.equal(state.outcome, null);
    assert.equal(Boolean(state.time.idle), false);
    checks += 1;
    if (shouldStopForNoProgress({ now: lastProgressAt + elapsed, lastProgressAt })) {
      stoppedAt = elapsed;
      break;
    }
  }
  assert.equal(stoppedAt, 180_000);
  assert.equal(checks, 4);
  assert.equal(errors.length, 4);
  assert(errors.every(item => item.status === 'query-error'));
  const nativeState = { outcome: 'succeeded', time: { idle: 42 } };
  assert.equal(await observeSessionState(async () => nativeState, () => assert.fail('unexpected error')), nativeState);
  await assert.rejects(observeSessionState(async () => { throw new Error('permission denied'); }, () => {}), /permission denied/u);
});

test('Anko observation files install into a template without an observer directory', async () => {
  const parent = join(ROOT, '_testenv/anko-reusable');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'observer-test-'));
  try {
    await mkdir(join(directory, '.opencode/plugins/sortie-dogs'), { recursive: true });
    await installObservationFiles(directory);
    assert.equal(await readFile(join(directory, '.opencode/plugins/anko-benchmark-observer/index.js'), 'utf8'), observerPlugin);
    assert.equal(await readFile(join(directory, '.opencode/plugins/sortie-dogs/index.js'), 'utf8'), tracedSortiePlugin);
    assert.equal(JSON.parse(await readFile(join(directory, '.opencode/plugins/anko-benchmark-observer/package.json'), 'utf8')).main, './index.js');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent Anko launch-lock creation admits one owner and preserves its terminal record', async () => {
  const parent = join(ROOT, '_testenv/anko-reusable');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'lock-test-'));
  const lock = join(directory, 'run-once.lock');
  try {
    const attempts = await Promise.allSettled([
      writeExclusive(lock, '{"owner":"candidate-a"}\n'),
      writeExclusive(lock, '{"owner":"candidate-b"}\n'),
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = attempts.find(result => result.status === 'rejected');
    assert.equal(rejected?.status, 'rejected');
    assert.equal(rejected.reason.code, 'EEXIST');
    const saved = await readFile(lock, 'utf8');
    const state = JSON.parse(saved);
    assert.ok(['candidate-a', 'candidate-b'].includes(state.owner));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
