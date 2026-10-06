import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  ROOT, STATE_ROOT, fixedProfile, noProgressStopReason, packageJsonFromTgz, packageRoot,
  diagnosticReadObservations, parseCommand, parseVersion, profilePath, progressSignature, shouldStopForNoProgress,
  versionRoot, writeExclusive,
} from '../scripts/anko-benchmark/core.mjs';
import { eligibleReadPermission } from '../scripts/anko-benchmark/recovery.mjs';
import { installObservationFiles, observeSessionState, observerPlugin, safeNativeEvent, tracedSortiePlugin } from '../scripts/anko-benchmark/observe.mjs';
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
  for (const file of ['scripts/anko-benchmark.mjs', ...['arm', 'run', 'core', 'usage', 'settle', 'inspect', 'observe']
    .map(name => `scripts/anko-benchmark/${name}.mjs`)])
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
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
