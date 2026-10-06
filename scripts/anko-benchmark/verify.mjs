import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ARTIFACT_ROOT, ANKO_BASE, CLI_SHA256, CLIENT_LOCK_SHA256, COST_LIMIT_USD, INSTRUCTION_SHA256,
  READ_STALL_MS, WALL_LIMIT_MS, WORKER_MODEL, exists, fixedProfile, hashFile, packageReceiptPath, profilePath,
  readJson, sha256, versionRoot, writeJson,
} from './core.mjs';

function verifyNoCredentials(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credential').get().n, 0, `retained database has credential rows: ${path}`); }
  finally { db.close(); }
}

async function verifyProfile() {
  const profile = await readJson(profilePath());
  assert.deepEqual(profile.benchmark, fixedProfile().benchmark);
  assert.deepEqual(profile.stall_policy, fixedProfile().stall_policy);
  assert.equal(profile.benchmark.max_attempts, 1);
  assert.equal(profile.benchmark.max_wall_ms, WALL_LIMIT_MS);
  assert.equal(profile.benchmark.max_priced_usd, COST_LIMIT_USD);
  assert.equal(profile.benchmark.grading, 'none');
  assert.equal(profile.benchmark.base, ANKO_BASE);
  assert.equal(profile.benchmark.instruction_sha256, INSTRUCTION_SHA256);
  assert.equal(profile.stall_policy.no_progress_ms, READ_STALL_MS);
  assert.equal(profile.stall_policy.active_session_status_is_progress, false);
  assert.equal(profile.stall_policy.pending_permission_response, 'observe-only; never auto-allow, auto-reject or infer consent');
  assert.equal(profile.cli.sha256, CLI_SHA256);
  assert.equal(profile.driver_client.version, '2.0.18');
  assert.equal(profile.driver_client.package_lock_sha256, CLIENT_LOCK_SHA256);
  assert.equal(await hashFile(join(process.cwd(), 'AGENTS.md')), profile.applicable_agents_sha256,
    'current AGENTS.md differs from the execution profile');
  return profile;
}

async function verifyFrozenInputs(root, setup) {
  const frozenPath = join(root, 'frozen-inputs.json');
  assert.equal(await hashFile(frozenPath), setup.frozen_inputs_sha256);
  const frozen = await readJson(frozenPath);
  for (const [path, digest] of Object.entries(frozen)) {
    assert.equal(await hashFile(path), digest, `saved prior input changed: ${path}`);
  }
  return Object.keys(frozen).length;
}

async function verifyPackage(version, setup) {
  const receiptPath = packageReceiptPath(version);
  const receipt = await readJson(receiptPath);
  assert.equal(receipt.version, version);
  assert.equal(receipt.package_name, 'sortie-dogs');
  assert.equal(receipt.package_version, version);
  assert.equal(await hashFile(receipt.archive_path), receipt.sha256, 'stored version archive does not match its receipt');
  const control = join(versionRoot(version), 'template-project/.opencode');
  const lock = JSON.parse(await readFile(join(control, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages?.['node_modules/sortie-dogs']?.version, version);
  assert.equal(lock.packages?.['node_modules/sortie-dogs']?.integrity, receipt.integrity);
  assert.equal(await hashFile(join(control, 'package-lock.json')), setup.package_lock_sha256);
  assert.equal(setup.package_receipt_sha256, receipt.sha256);
  const installed = JSON.parse(await readFile(join(control, 'node_modules/sortie-dogs/package.json'), 'utf8'));
  assert.equal(installed.version, version);
  const assetVersion = await import(`${new URL(`file:///${join(control, 'node_modules/sortie-dogs/dist/asset-version.js').replaceAll('\\', '/')}`).href}?verify=${encodeURIComponent(version)}`);
  if (receipt.runtime_marker) assert.equal(assetVersion.V010_RUNTIME_ASSET_VERSION, receipt.runtime_marker);
  return { receipt, control, package_lock_sha256: setup.package_lock_sha256,
    loaded_asset_marker: assetVersion.V010_RUNTIME_ASSET_VERSION };
}

async function verifyDiagnosis(version, profile) {
  const root = join(versionRoot(version), 'diagnosis');
  const terminal = await readJson(join(root, await exists(join(root, 'diagnosis-latest.json')) ? 'diagnosis-latest.json' : 'diagnosis-terminal.json'));
  assert.equal(terminal.benchmark_arm, false);
  assert.ok(Number.isInteger(terminal.attempt_number), 'diagnosis terminal does not identify its attempt');
  const attempt = join(root, `attempt-${terminal.attempt_number}`);
  const reportFilename = terminal.result_filename ?? 'diagnosis.json';
  const reportPath = join(attempt, reportFilename);
  const lockPath = terminal.reconciled_existing_session ? join(attempt, 'reattach-once.lock') :
    join(root, terminal.attempt_number === 1 ? 'diagnose-once.lock' : `diagnose-attempt-${terminal.attempt_number}.lock`);
  assert.equal(await exists(lockPath), true, 'diagnosis did not record an exclusive start');
  assert.equal(await exists(reportPath), true, 'read-path diagnosis has no terminal record');
  const report = await readJson(reportPath);
  assert.equal(report.attempt_number, terminal.attempt_number);
  assert.equal(terminal.status, report.status);
  assert.equal(report.version, version);
  assert.ok(['local-native-tool-probe-not-benchmark-arm', 'reattached-native-tool-probe-not-benchmark-arm']
    .includes(report.diagnosis_kind));
  assert.equal(report.package_sha256, (await readJson(packageReceiptPath(version))).sha256);
  assert.equal(report.profile_sha256, await hashFile(profilePath()));
  assert.equal(report.benchmark_arm, undefined);
  assert.ok(['completed', 'stopped-no-progress'].includes(report.status),
    report.error ?? `read-path diagnosis did not reach a verifiable terminal state: ${report.status}`);
  assert.equal(report.observer_plugin_loaded, true, 'native plugin hook observer did not load');
  assert.equal(report.database_sanitization.status, 'sanitized');
  assert.equal(report.database_sanitization.credential_rows_remaining, 0);
  assert.equal(report.database_sanitization.snapshot_credential_rows_remaining, 0);
  assert.equal(report.native_event_stream.error, null, 'native event stream did not remain observable');
  assert.ok(report.permission_observations.length > 0, 'native permission.list was never queried');
  assert.equal(report.no_progress_timeout_ms, READ_STALL_MS);
  assert.equal(report.interpretation.policy.includes('no permission allow/reject reply'), true);
  const targetIDs = ['repo-existing-file', 'repo-missing-agents', 'ancestor-agents'];
  assert.deepEqual(report.diagnostic_targets.map(item => item.id), targetIDs,
    'diagnostic did not define the three fixed read targets');
  assert.deepEqual(report.target_read_observations.map(item => item.target_id), targetIDs,
    'diagnostic read observations do not preserve each target, including unobserved targets');
  assert.equal(report.diagnostic_targets[0].path, join(report.candidate_project_path, 'go.mod'));
  assert.equal(report.diagnostic_targets[1].path, join(report.candidate_project_path, 'AGENTS.md'));
  assert.equal(report.diagnostic_targets[2].path, join(profile.repo_root, 'AGENTS.md'));
  assert.ok(report.target_read_observations.some(item => item.status === 'read-boundary-observed'),
    'no read target reached a native or plugin-hook boundary');
  const hooks = report.plugin_hook_observations;
  assert.ok(hooks.every(event => ['plugin-hook-before', 'plugin-hook-after'].includes(event.phase)),
    'read plugin hook observations contain an unknown boundary phase');
  const readTargetsComplete = report.target_read_observations.every(item =>
    item.native_tool_start_observed && item.native_tool_terminal_observed && item.plugin_hook_before_observed && item.plugin_hook_after_observed);
  if (report.status === 'completed') assert.equal(readTargetsComplete, true,
    'completed probe did not observe all three read starts and plugin-hook boundaries');
  if (report.status === 'stopped-no-progress') {
    assert.ok(['permission-confirmation-no-progress-timeout', 'native-read-no-progress-timeout',
      'native-tool-no-progress-timeout', 'session-no-progress-timeout'].includes(report.stop_reason));
    const timedOut = report.no_progress_state?.no_progress_ms >= READ_STALL_MS ||
      report.no_progress_state?.active_native_tool?.no_progress_ms >= READ_STALL_MS;
    assert.equal(timedOut, true, 'no-progress record does not prove the frozen timeout elapsed');
    assert.equal(report.interruption?.interrupt_requested, true,
      'stalled diagnostic session was not interrupted after recording native state');
  }
  if (report.reconciled_existing_session) {
    assert.equal(report.prompt_replayed, false);
    assert.equal(report.original_prompt_submission_count, 1);
    assert.equal(report.database_sanitization.status, 'sanitized');
    assert.equal(report.database_sanitization.credential_rows_remaining, 0);
    assert.equal(report.database_sanitization.snapshot_credential_rows_remaining, 0);
  }
  assert.equal(await exists(report.record_path), true, 'persistent read-only diagnostic record is missing');
  const external = await readJson(join(report.record_path, reportFilename));
  assert.equal(external.root_session, report.root_session);
  assert.equal(external.status, report.status);
  const originalArtifacts = ['native-events.jsonl', 'plugin-hook-events.jsonl', 'permission-snapshots.jsonl', 'progress.json', reportFilename,
    'data/opencode/opencode.db', 'usage/opencode.db'];
  const recoveryArtifacts = report.reconciled_existing_session ? [
    'recovery/native-events.jsonl', 'recovery/native-hook-events.jsonl', 'recovery/plugin-hook-events.jsonl',
    'recovery/permission-snapshots.jsonl', 'recovery/progress.json', 'recovery/native-session-export.json',
    'recovery/database-sanitization.json', 'recovery/data/opencode/opencode.db', 'recovery/usage/opencode.db',
  ] : [];
  for (const relative of [...originalArtifacts, ...recoveryArtifacts]) {
    assert.equal(await hashFile(join(report.record_path, relative)), await hashFile(join(attempt, relative)),
      `persistent diagnosis record differs: ${relative}`);
  }
  for (const base of [attempt, report.record_path])
    for (const relative of ['data/opencode/opencode.db', 'usage/opencode.db']) verifyNoCredentials(join(base, relative));
  assert.equal(profile.stall_policy.no_progress_ms, report.no_progress_timeout_ms);
  return report;
}

async function verifyRun(version, profile) {
  const root = versionRoot(version);
  const attemptLock = join(root, 'run-once.lock');
  assert.equal(await exists(attemptLock), true, 'benchmark launch has no exclusive lock');
  const exclusiveLaunch = await readJson(attemptLock);
  assert.equal(exclusiveLaunch.one_shot, true);
  assert.equal(exclusiveLaunch.benchmark_attempt, 1);
  assert.equal(exclusiveLaunch.version, version);
  assert.equal(exclusiveLaunch.stage, 'arm-terminal', 'exclusive launch record has no native terminal observation');
  const launchRecord = await readJson(join(root, 'last-attempt.json'));
  assert.equal(launchRecord.version, version);
  assert.equal(launchRecord.benchmark_attempt, 1);
  assert.equal(launchRecord.launched, true);
  assert.equal(exclusiveLaunch.package_sha256, launchRecord.package_sha256);
  assert.equal(exclusiveLaunch.trial_directory, launchRecord.trial_directory);
  assert.equal(exclusiveLaunch.record_path, launchRecord.record_path);
  assert.equal(exclusiveLaunch.native_shell_exit, launchRecord.native_shell_exit);
  const trial = launchRecord.trial_directory;
  const executionPolicyPath = join(trial, 'execution-policy.json');
  assert.equal(await hashFile(executionPolicyPath), launchRecord.execution_policy_sha256);
  assert.equal(await hashFile(join(root, 'execution-policy.json')), launchRecord.execution_policy_sha256);
  const receipt = await readJson(join(trial, 'receipt.json'));
  const observation = await readJson(join(trial, 'observation.json'));
  const launch = await readJson(join(trial, 'launch.json'));
  assert.equal(receipt.package_version, version);
  assert.equal(receipt.archive_sha256, (await readJson(packageReceiptPath(version))).sha256);
  assert.equal(receipt.candidate_base, ANKO_BASE);
  assert.equal(receipt.instruction_sha256, INSTRUCTION_SHA256);
  assert.equal(receipt.execution_stop_reason, observation.stop_reason);
  assert.equal(receipt.benchmark_attempts, 1);
  assert.equal(receipt.execution_elapsed_ms, observation.execution_elapsed_ms);
  assert.equal(receipt.accepted, observation.accepted);
  assert.equal(launch.max_attempts, 1);
  assert.equal(launch.max_wall_minutes, 60);
  assert.equal(launch.max_priced_usd, COST_LIMIT_USD);
  assert.equal(launch.official_scoring, false);
  assert.equal(launch.host.version, '2.0.18');
  assert.equal(receipt.execution_elapsed_ms <= WALL_LIMIT_MS + 10_000, true,
    'arm exceeded its bounded runtime plus final poll/interrupt allowance');
  const ownedSessions = (observation.session_models ?? []).filter(item => item.id !== observation.root);
  const workerSessions = (observation.session_models ?? []).filter(item =>
    ['dog-worker-v010', 'dog-luna-worker-v010'].includes(item.agent));
  assert.equal(observation.inner_dispatch_count, ownedSessions.length);
  assert.equal(observation.inner_dispatch_count, observation.sessions.filter(item => item.id !== observation.root).length);
  assert.equal(observation.no_progress_timeout_ms, profile.stall_policy.no_progress_ms);
  assert.equal(observation.active_session_status_counted_as_progress, false);
  assert.equal(observation.prompt_replay_count, 0);
  assert.equal(observation.contextual_recovery_count <= profile.stall_policy.contextual_recovery.max_prompts, true);
  assert.equal(observation.benchmark_attempts, 1);
  assert.equal(observation.accepted, observation.stop_reason === 'accepted' &&
    observation.receipt?.status === 'succeeded' && observation.receipt?.stop_reason === 'completed' &&
    (!Object.hasOwn(observation, 'settlement') ||
      observation.settlement?.native_settled === true && observation.cost_estimate_complete === true));
  assert.equal(await exists(launchRecord.record_path), true, 'persistent benchmark artifact record is missing');
  for (const relative of ['receipt.json', 'observation.json', 'launch.json', 'run-attempt.lock',
    'native-events.jsonl', 'permission-snapshots.jsonl', 'native-hook-events.jsonl', 'execution-policy.json', 'no-progress-stop.json',
    'data/opencode/opencode.db', 'usage/opencode.db']) {
    if (relative === 'no-progress-stop.json' && !await exists(join(trial, relative))) continue;
    assert.equal(await hashFile(join(launchRecord.record_path, relative)), await hashFile(join(trial, relative)),
      `persistent record differs: ${relative}`);
  }
  for (const base of [trial, launchRecord.record_path])
    for (const relative of ['data/opencode/opencode.db', 'usage/opencode.db']) verifyNoCredentials(join(base, relative));
  return { launch_record: launchRecord, receipt, observation, launch };
}

export async function verifyVersion(version) {
  const root = versionRoot(version);
  const profile = await verifyProfile();
  const setup = await readJson(join(root, 'setup.json'));
  assert.equal(setup.profile_sha256, await hashFile(profilePath()));
  assert.equal(setup.package_version, version);
  assert.equal(setup.template_base, ANKO_BASE);
  const frozenInputs = await verifyFrozenInputs(root, setup);
  const packageInfo = await verifyPackage(version, setup);
  const diagnosis = await verifyDiagnosis(version, profile);
  const hasRun = await exists(join(root, 'last-attempt.json'));
  const hasRunLock = await exists(join(root, 'run-once.lock'));
  assert.equal(hasRunLock && !hasRun, false, 'exclusive run lock exists without a terminal launch record');
  const run = hasRun ? await verifyRun(version, profile) : null;
  const result = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    status: run ? 'record-integrity-verified' : 'preflight-ready',
    benchmark_accepted: run?.observation.accepted ?? false,
    version,
    profile_sha256: await hashFile(profilePath()),
    package: { path: packageInfo.receipt.archive_path, sha256: packageInfo.receipt.sha256,
      integrity: packageInfo.receipt.integrity, runtime_marker: packageInfo.loaded_asset_marker },
    fixed_conditions: profile.benchmark,
    no_progress_policy: profile.stall_policy,
    diagnosis: { status: diagnosis.status, root_session: diagnosis.root_session,
      stop_reason: diagnosis.stop_reason, no_progress_timeout_ms: diagnosis.no_progress_timeout_ms,
      permission_requests_observed: diagnosis.permission_observations.reduce((count, snapshot) => count + snapshot.requests.length, 0),
      read_tool_calls: diagnosis.native_tool_calls.filter(event => event.name === 'read').length,
      hook_events: diagnosis.plugin_hook_observations.length, record_path: diagnosis.record_path },
    frozen_input_count: frozenInputs,
    run: run ? { root: run.observation.root, stop_reason: run.observation.stop_reason,
      execution_elapsed_ms: run.observation.execution_elapsed_ms,
      estimated_cost_usd: run.observation.priced_usd, inner_dispatch_count: run.observation.inner_dispatch_count,
      loaded_runtime: run.observation.loaded_runtime, record_path: run.launch_record.record_path } : null,
    note: 'record-integrity/preflight PASS does not imply Anko implementation acceptance or quality success',
  };
  // Keep an existing terminal verification receipt stable. Native shell history
  // records each fresh check; rewriting only its timestamp invalidates unrelated
  // source-bound checks without changing the candidate or the observed result.
  const verificationPath = join(root, 'verification.json');
  const saved = await exists(verificationPath) ? await readJson(verificationPath) : null;
  if (!saved || saved.status !== result.status || saved.package.sha256 !== result.package.sha256)
    await writeJson(verificationPath, result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}
