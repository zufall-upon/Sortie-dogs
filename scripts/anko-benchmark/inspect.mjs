import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ANKO_BASE, INSTRUCTION_SHA256, hashFile, packageReceiptPath, readJson, sha256,
  runRecordRoot, tarEntryFromTgz } from './core.mjs';
import { readOwnedUsage } from './usage.mjs';
import { nativeTurnTerminal, observeSessionTurn } from './observe.mjs';

export function analyzeSavedTrial(history, events, usage, observation) {
  const turns = new Map();
  for (const event of events) observeSessionTurn(turns, event);
  const nativeTurnsSettled = usage.sessions.length > 0 && usage.sessions.every(session => nativeTurnTerminal(session, turns));
  const exported = new Map(history.flatMap(session => session.messages.filter(item => ['assistant', 'compaction'].includes(item.type))
    .map(message => [message.id, message])));
  const failures = usage.records.filter(item => item.error_type === 'provider.transport').map(item => {
    const related = events.filter(event => event.assistant_message_id === item.id);
    const failed = related.find(event => event.type === 'session.step.failed');
    const lastTool = related.filter(event => event.type === 'session.tool.success').at(-1);
    const interrupted = events.find(event => event.session_id === item.session_id && event.type === 'session.execution.interrupted');
    return { ...item, export_record_observed: exported.has(item.id), export_usage_absent: !exported.get(item.id)?.tokens,
      tool_success_at: lastTool?.created ?? null, failed_at: failed?.created ?? null,
      tool_success_to_failure_ms: failed && lastTool ? failed.created - lastTool.created : null,
      interrupted_at: interrupted?.created ?? null,
      retry_scheduled_events: related.filter(event => event.type === 'session.retry.scheduled').length,
      retry_step_starts_after_schedule: events.filter(event => event.session_id === item.session_id &&
        event.type === 'session.step.started' && event.created > (failed?.created ?? Infinity)).length,
      observer_events_after_failure: events.filter(event => event.created > (failed?.created ?? Infinity)).length };
  });
  return { execution_elapsed_ms: observation.execution_elapsed_ms, stop_reason: observation.stop_reason,
    observer_stream_error: observation.native_event_stream?.error ?? null,
    provider_failures: failures, priced_subtotal_usd: usage.priced_usd,
    recorded_estimated_total_usd: usage.estimated_total_usd,
    estimated_total_usd: nativeTurnsSettled ? usage.estimated_total_usd : null, actual_billed_usd: null,
    latest_native_turns_settled: nativeTurnsSettled,
    usage_records: usage.records, owned_sessions: usage.sessions.map(item => ({ id: item.id,
      parent_id: item.parent_id, agent: item.agent, outcome: item.idle_outcome, time_idle: item.time_idle,
      recorded_native_terminal_observed: item.native_terminal_observed,
      native_terminal_observed: nativeTurnTerminal(item, turns),
      latest_observed_turn: turns.get(item.id) ?? null })),
    db_assistant_records: usage.records.filter(item => item.message_type === 'assistant').length,
    export_assistant_records: [...exported.values()].filter(item => item.type === 'assistant').length,
    db_compaction_records: usage.records.filter(item => item.message_type === 'compaction').length,
    export_compaction_records: [...exported.values()].filter(item => item.type === 'compaction').length,
    db_records_absent_from_export: usage.records.filter(item => !exported.has(item.id)).map(item => item.id),
    conclusion: failures.length ? 'provider-error-and-usage-absence-coobserved; cause-not-proven' :
      'no-provider-transport-failure-observed; stop-cause-requires-native-tool-analysis',
    limitations: [...(failures.length ? ['1006の切断元・ネットワーク経路・provider内部原因は保存履歴から不明。'] : []),
      'usage欠測の有無は各DB/export recordで判断する。欠測時にprovider未送信かhost未保存かは不明。',
      'retry予約は推論再実行の証拠ではない。interrupt ackやprocess停止はnative終端の証拠ではない。'] };
}

// Offline only. No prepare, diagnose, server, credentials, prompt or receipt writes.
export async function inspectVersion(version, { attempt = null } = {}) {
  const root = runRecordRoot(version, attempt);
  const lockPath = join(root, 'run-once.lock');
  const lock = await readJson(lockPath);
  assert.equal(lock.stage, 'arm-terminal');
  assert.equal(lock.version, version);
  assert.equal(lock.benchmark_attempt, 1);
  const trial = lock.trial_directory;
  const names = ['receipt.json', 'observation.json', 'native-events.jsonl', 'native-history.json', 'progress-events.jsonl',
    'usage/opencode.db', 'data/opencode/opencode.db', 'run-arm.mjs', 'provenance.json', 'execution-policy.json',
    'instruction.md', 'run-attempt.lock', `sortie-dogs-${version}.tgz`];
  const inputPaths = [lockPath, packageReceiptPath(version), ...names.map(name => join(trial, name))];
  const before = await Promise.all(inputPaths.map(hashFile));
  const [observation, receipt, history, provenance, packageReceipt] = await Promise.all([
    readJson(join(trial, 'observation.json')), readJson(join(trial, 'receipt.json')),
    readJson(join(trial, 'native-history.json')), readJson(join(trial, 'provenance.json')), readJson(packageReceiptPath(version)),
  ]);
  assert.equal(receipt.execution_stop_reason, observation.stop_reason);
  assert.equal(receipt.execution_elapsed_ms, observation.execution_elapsed_ms);
  assert.equal(receipt.archive_sha256, lock.package_sha256);
  assert.equal(packageReceipt.sha256, lock.package_sha256);
  assert.equal(receipt.candidate_base, ANKO_BASE);
  assert.equal(await hashFile(join(trial, 'instruction.md')), INSTRUCTION_SHA256);
  assert.equal(await hashFile(join(trial, 'run-arm.mjs')), provenance.runner.sha256);
  const archive = await readFile(join(trial, `sortie-dogs-${version}.tgz`));
  assert.equal(sha256(archive), lock.package_sha256);
  const costPath = join(trial, 'project/.opencode/node_modules/sortie-dogs/dist/plugin/model-cost.js');
  const costHash = await hashFile(costPath);
  assert.equal(costHash, sha256(tarEntryFromTgz(archive, 'package/dist/plugin/model-cost.js')),
    'saved price estimator differs from the selected package');
  const { estimateModelUsageCost } = await import(pathToFileURL(costPath).href);
  const dbPath = join(trial, 'usage/opencode.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credential').get().n, 0); }
  finally { db.close(); }
  const usage = readOwnedUsage(dbPath, observation.root, estimateModelUsageCost);
  assert(Math.abs(usage.priced_usd - observation.priced_usd) < 1e-10, 'saved priced subtotal changed');
  const events = (await readFile(join(trial, 'native-events.jsonl'), 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  for (const name of names) assert.equal(await hashFile(join(lock.record_path, name)), await hashFile(join(trial, name)),
    `persistent trial copy differs: ${name}`);
  assert.deepEqual(await Promise.all(inputPaths.map(hashFile)), before, 'offline inspection changed saved inputs');
  assert.equal(await hashFile(costPath), costHash);
  const result = { version, benchmark_arm_started: false, provider_requests_sent: 0,
    saved_benchmark_attempts: lock.benchmark_attempt, package_sha256: lock.package_sha256,
    saved_runner_sha256: provenance.runner.sha256, input_files_checked_unchanged: inputPaths.length,
    fixed_limits: { max_attempts: observation.max_attempts, max_wall_minutes: observation.max_wall_minutes,
      max_priced_usd: observation.max_priced_usd, grading: 'none' },
    ...analyzeSavedTrial(history, events, usage, observation) };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
