import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_ROOT, ANKO_BASE, CLI, CLI_VERSION, COST_LIMIT_USD, INSTRUCTION_SHA256,
  LEGACY_RUN, PREPARED_GO, READ_STALL_MS, ROOT, SOURCE_PROJECT, STATE_ROOT, WALL_LIMIT_MS,
  copyExclusive, exists, hashFile, packageReceiptPath, profilePath, readJson, sha256,
  versionRoot, writeExclusive, writeJson,
} from './core.mjs';
import { verifyVersion } from './verify.mjs';
import { prepareVersion } from './prepare.mjs';
import { diagnoseVersion } from './diagnostic-owned.mjs';
import { fixExecutionPolicy } from './recovery.mjs';

const sourceFile = fileURLToPath(import.meta.url);
const armSource = join(dirname(sourceFile), 'arm.mjs');
const coreSource = join(dirname(sourceFile), 'core.mjs');
const verifySource = join(dirname(sourceFile), 'verify.mjs');
const prepareSource = join(dirname(sourceFile), 'prepare.mjs');
const usageSource = join(ROOT, 'scripts/anko-benchmark.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeTrialID() {
  return `${new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`;
}

async function buildTrial(version, receipt, profile, diagnosis) {
  const root = versionRoot(version);
  const trialID = makeTrialID();
  const trial = join(root, 'trials', trialID);
  const project = join(trial, 'project');
  const packageName = `sortie-dogs-${version}.tgz`;
  const branchName = `bench/anko-v${version.replaceAll('.', '')}`;
  const recordPath = join(ARTIFACT_ROOT, `v${version}/${trialID}`);
  assert.equal(await exists(trial), false);
  assert.equal(await exists(recordPath), false, `persistent artifact path already exists: ${recordPath}`);
  await mkdir(dirname(trial), { recursive: true });
  await mkdir(trial, { recursive: false });
  const clone = spawn('git', ['clone', '--no-hardlinks', SOURCE_PROJECT, project], { cwd: ROOT,
    stdio: 'inherit', windowsHide: true });
  const cloneExit = await new Promise((resolve, reject) => {
    clone.once('error', reject);
    clone.once('close', code => resolve(code));
  });
  assert.equal(cloneExit, 0, 'candidate source clone failed');
  try { git(['remote', 'remove', 'origin'], project); } catch {}
  git(['branch', '--force', 'main', ANKO_BASE], project);
  git(['checkout', '--force', '-B', branchName, ANKO_BASE], project);
  const excludePath = join(SOURCE_PROJECT, '.git/info/exclude');
  await cp(excludePath, join(project, '.git/info/exclude'), { force: true });
  assert.equal(git(['rev-parse', 'HEAD'], project), ANKO_BASE);
  assert.equal(git(['rev-parse', 'main'], project), ANKO_BASE);
  assert.equal(git(['branch', '--show-current'], project), branchName);
  assert.equal(git(['status', '--porcelain=v1'], project), '');
  await cp(join(root, 'template-project/.opencode'), join(project, '.opencode'),
    { recursive: true, force: false, errorOnExist: true });
  await copyExclusive(receipt.archive_path, join(trial, packageName));
  await copyExclusive(join(PREPARED_GO, 'instruction.md'), join(trial, 'instruction.md'));
  await copyExclusive(join(root, 'frozen-inputs.json'), join(trial, 'frozen-inputs.json'));
  await copyExclusive(profilePath(), join(trial, 'profile.json'));
  await copyExclusive(join(STATE_ROOT, 'common/AGENTS.md'), join(trial, 'applicable-AGENTS.md'));
  await copyExclusive(join(root, `diagnosis/attempt-${diagnosis.attempt_number}/${diagnosis.result_filename ?? 'diagnosis.json'}`),
    join(trial, 'diagnosis.json'));
  await copyExclusive(join(ROOT, '.sortie-env/node_modules/@opencode/client/package.json'), join(trial, 'driver-client-package.json'));
  await copyExclusive(join(ROOT, '.sortie-env/package-lock.json'), join(trial, 'driver-client-package-lock.json'));
  await copyExclusive(armSource, join(trial, 'run-arm.mjs'));
  await copyExclusive(coreSource, join(trial, 'core.mjs'));
  await copyExclusive(join(dirname(sourceFile), 'observe.mjs'), join(trial, 'observe.mjs'));
  await copyExclusive(join(dirname(sourceFile), 'usage.mjs'), join(trial, 'usage.mjs'));
  await copyExclusive(join(dirname(sourceFile), 'settle.mjs'), join(trial, 'settle.mjs'));
  await copyExclusive(join(dirname(sourceFile), 'recovery.mjs'), join(trial, 'recovery.mjs'));
  await copyExclusive(join(root, 'execution-policy.json'), join(trial, 'execution-policy.json'));
  await copyExclusive(verifySource, join(trial, 'verify.mjs'));
  await copyExclusive(prepareSource, join(trial, 'prepare.mjs'));
  await copyExclusive(usageSource, join(trial, 'run.mjs'));
  await writeFile(join(trial, 'candidate-package.json'), `${JSON.stringify({
    version, archive_path: join(trial, packageName), source_archive: receipt.archive_path,
    source_kind: receipt.source_kind, source_commit: receipt.source_commit,
    patch_sha256: receipt.patch_sha256, sha256: receipt.sha256, shasum: receipt.sha1,
    integrity: receipt.integrity, runtime_marker: receipt.runtime_marker,
    archive_filename: packageName,
  }, null, 2)}\n`, { flag: 'wx' });
  const oldProvenance = await readJson(join(LEGACY_RUN, 'provenance.json'));
  oldProvenance.package = { source_archive: receipt.archive_path, local_archive: join(trial, packageName),
    version, shasum: receipt.sha1, sha256: receipt.sha256, integrity: receipt.integrity,
    runtime_marker: receipt.runtime_marker, source_commit: receipt.source_commit, patch_sha256: receipt.patch_sha256 };
  oldProvenance.source.branch = branchName;
  oldProvenance.runner = { path: 'scripts/anko-benchmark/arm.mjs', git_commit: git(['rev-parse', 'HEAD'], ROOT),
    sha256: await hashFile(armSource), entrypoint_sha256: await hashFile(usageSource),
    core_sha256: await hashFile(coreSource),
     inherited_path: join(LEGACY_RUN, 'run-arm.mjs'), inherited_sha256: await hashFile(join(LEGACY_RUN, 'run-arm.mjs')) };
  oldProvenance.runner.module_sha256 = Object.fromEntries(await Promise.all(
    ['core.mjs', 'observe.mjs', 'usage.mjs', 'settle.mjs', 'recovery.mjs'].map(async name =>
      [name, await hashFile(join(trial, name))])));
  oldProvenance.verifier = { path: 'scripts/anko-benchmark/verify.mjs', sha256: await hashFile(verifySource) };
  oldProvenance.limits = { max_attempts: 1, max_wall_minutes: 60, max_priced_usd: COST_LIMIT_USD, grading: 'none' };
  oldProvenance.reusable_runner = { entrypoint: 'scripts/anko-benchmark.mjs', version, package_sha256: receipt.sha256,
    read_no_progress_ms: READ_STALL_MS, active_status_counts_as_progress: false,
    permission_reply: 'none', prompt_replay_on_unknown_cause: false };
  await writeJson(join(trial, 'provenance.json'), oldProvenance, { flag: 'wx' });
  await writeJson(join(trial, 'setup.json'), { prepared_at: new Date().toISOString(),
    benchmark_roots_created: 0, version, package_sha256: receipt.sha256,
    profile_sha256: await hashFile(profilePath()), applicable_agents_sha256: profile.applicable_agents_sha256,
    common_driver_reused: true, control_profile_reused: true, go_installation_reused: true,
    candidate_base: ANKO_BASE, original_instruction_sha256: INSTRUCTION_SHA256,
     stall_policy_sha256: sha256(JSON.stringify(profile.stall_policy)),
    frozen_input_count: Object.keys(await readJson(join(trial, 'frozen-inputs.json'))).length,
    diagnosis_status: (await readJson(join(trial, 'diagnosis.json'))).status }, { flag: 'wx' });
  await writeFile(join(trial, 'package-SHA256SUMS'), `${receipt.sha256}  ${packageName}\n`, { flag: 'wx' });
  await writeExclusive(join(trial, 'run-attempt.lock'), `${JSON.stringify({ one_shot: true,
    benchmark_attempt: 1, version, package_sha256: receipt.sha256, created_at: new Date().toISOString(),
    diagnostic_is_separate: true, old_trials_resumed: false }, null, 2)}\n`);
  assert.equal((await readFile(join(trial, 'instruction.md'))).length, 1825);
  assert.equal(await hashFile(join(trial, 'instruction.md')), INSTRUCTION_SHA256);
  assert.equal(await hashFile(join(trial, packageName)), receipt.sha256);
  assert.equal(await hashFile(join(trial, 'run-arm.mjs')), oldProvenance.runner.sha256);
  assert.equal(await hashFile(join(trial, 'core.mjs')), oldProvenance.runner.core_sha256);
  assert.equal(await hashFile(join(trial, 'verify.mjs')), oldProvenance.verifier.sha256);
  assert.equal(profile.benchmark.max_wall_ms, WALL_LIMIT_MS);
  return { trial_id: trialID, trial_directory: trial, project_directory: project, record_path: recordPath,
    package_name: packageName, runner_sha256: oldProvenance.runner.sha256 };
}

async function runChild(trial, version, receipt, diagnosis) {
  const child = spawn(process.execPath, [join(trial.trial_directory, 'run-arm.mjs')], {
    cwd: ROOT,
    env: { ...process.env,
      ANKO_BENCHMARK_VERSION: version,
      ANKO_BENCHMARK_TRIAL_DIRECTORY: trial.trial_directory,
      ANKO_BENCHMARK_RECORD_PATH: trial.record_path,
      ANKO_BENCHMARK_PACKAGE_RECEIPT: packageReceiptPath(version),
      ANKO_BENCHMARK_DIAGNOSIS_PATH: join(versionRoot(version),
        `diagnosis/attempt-${diagnosis.attempt_number}/${diagnosis.result_filename ?? 'diagnosis.json'}`),
      ANKO_BENCHMARK_PROFILE_PATH: profilePath(),
      ANKO_BENCHMARK_PACKAGE_SHA256: receipt.sha256,
      ANKO_BENCHMARK_DIAGNOSIS_STATUS: diagnosis.status,
    }, stdio: 'inherit', windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ exit: code ?? 1, signal }));
  });
}

export async function runVersion(version) {
  const root = versionRoot(version);
  assert.equal(await exists(join(root, 'run-once.lock')), false,
    'this version already has an exclusive run record; never relaunch or reset it');
  await prepareVersion(version);
  await diagnoseVersion(version);
  const ready = await verifyVersion(version);
  assert.equal(ready.status, 'preflight-ready', `benchmark preflight is not ready: ${ready.status}`);
  assert.equal(ready.benchmark_accepted, false, 'a new arm is not permitted after an already recorded accepted trial');
  const receipt = await readJson(packageReceiptPath(version));
  const profile = await readJson(profilePath());
  const diagnosisTerminal = await readJson(join(root, await exists(join(root, 'diagnosis/diagnosis-latest.json')) ? 'diagnosis/diagnosis-latest.json' : 'diagnosis/diagnosis-terminal.json'));
  assert.ok(Number.isInteger(diagnosisTerminal.attempt_number), 'diagnostic terminal has no attempt identity');
  const diagnosis = await readJson(join(root,
    `diagnosis/attempt-${diagnosisTerminal.attempt_number}/${diagnosisTerminal.result_filename ?? 'diagnosis.json'}`));
  assert.notEqual(diagnosis.status, 'diagnostic-error', 'read-path diagnosis is not usable for an arm');
  const executionPolicy = await fixExecutionPolicy(version, profile, diagnosis);
  const oneShotPath = join(root, 'run-once.lock');
  const oneShot = { one_shot: true, benchmark_attempt: 1, version, package_sha256: receipt.sha256,
    diagnostic_root_session: diagnosis.root_session, stage: 'trial-preparation',
    old_trials_resumed: false, at: new Date().toISOString() };
  await writeExclusive(oneShotPath, `${JSON.stringify(oneShot, null, 2)}\n`);
  const trial = await buildTrial(version, receipt, profile, diagnosis);
  await writeJson(oneShotPath, { ...oneShot, stage: 'trial-prepared',
    trial_directory: trial.trial_directory, record_path: trial.record_path });
  const launch = { ...trial, version, benchmark_attempt: 1, package_sha256: receipt.sha256,
    profile_sha256: await hashFile(profilePath()), diagnosis_attempt: diagnosis.attempt_number,
    diagnosis_status: diagnosis.status,
     no_progress_timeout_ms: profile.stall_policy.no_progress_ms,
     execution_policy_sha256: await hashFile(join(root, 'execution-policy.json')), execution_policy: executionPolicy, launched: true,
    started_at: new Date().toISOString() };
  await writeJson(oneShotPath, { ...oneShot, stage: 'arm-launching', launched: true,
    trial_directory: trial.trial_directory, record_path: trial.record_path,
    started_at: launch.started_at });
  await writeJson(join(root, 'last-attempt.json'), launch);
  console.log(JSON.stringify({ phase: 'benchmark-arm-start', entrypoint: 'scripts/anko-benchmark.mjs',
    command: `node scripts/anko-benchmark.mjs run --version ${version}`, trial: trial.trial_id,
    package_sha256: receipt.sha256, profile_sha256: launch.profile_sha256,
    no_progress_timeout_ms: launch.no_progress_timeout_ms, max_wall_ms: WALL_LIMIT_MS,
    max_priced_usd: COST_LIMIT_USD, grading: 'none', record_path: trial.record_path }));
  const started = Date.now();
  let result;
  let spawnError = null;
  try { result = await runChild(trial, version, receipt, diagnosis); }
  catch (error) { spawnError = String(error); result = { exit: 1, signal: null }; }
  const completed = new Date().toISOString();
  const terminal = { ...launch, completed_at: completed, shell_elapsed_ms: Date.now() - started,
    native_shell_exit: result.exit, native_shell_signal: result.signal, launch_error: spawnError };
  await writeJson(join(root, 'last-attempt.json'), terminal);
  await writeJson(oneShotPath, { ...oneShot, stage: 'arm-terminal', launched: true,
    trial_directory: trial.trial_directory, record_path: trial.record_path,
    started_at: launch.started_at, completed_at: completed,
    native_shell_exit: result.exit, native_shell_signal: result.signal, launch_error: spawnError });
  console.log(JSON.stringify({ phase: 'benchmark-arm-terminal', trial: trial.trial_id,
    native_shell_exit: result.exit, native_shell_signal: result.signal,
    shell_elapsed_ms: terminal.shell_elapsed_ms, record_path: trial.record_path }));
  process.exitCode = result.exit;
  return terminal;
}
