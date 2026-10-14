import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tarEntryFromTgz } from './anko-benchmark/core.mjs';

// One driver for the retained release and a fixed, non-installed local candidate.
// Selection is read once before prepare/run; it never alters an active arm.
const receiptArg = process.argv.indexOf('--candidate-receipt');
const candidateReceiptPath = receiptArg < 0 ? null : process.argv[receiptArg + 1];
const candidate = candidateReceiptPath ? JSON.parse(readFileSync(candidateReceiptPath, 'utf8')) : null;

const VERSION = candidate?.version ?? '0.13.21';
const PACKAGE_SHA256 = candidate?.sha256 ?? 'b8e0fe937a86d7bedaca75bce5c2277a8b34ee8d0c38356d03d1eb3939f47c9b';
const RELEASE_COMMIT = candidate?.source_commit ?? '04c3f31972a25ac65f6c2e6c26eab49b4b60ce2e';
const RUNTIME_MARKER = candidate?.runtime_marker ?? '0.13.21-operation-recovery-v1';
const BASE_COMMIT = '3f269a72ff69398b1250c584171f32d12c0d8085';
const TASK_SHA256 = '96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe';
const TASK_BYTES = 1825;
const WALL_LIMIT_MS = 3_600_000;
const CODEX_CLI_PATH = 'C:\\Users\\rozen\\AppData\\Local\\OpenAI\\Codex\\bin\\2e5e00daee91c61d\\codex.exe';
const SOURCE_PROJECT = candidate?.fixture_project ?? 'M:\\_work\\_Sortie-dogs\\_testenv\\anko-pr169-20261007\\project';
const releaseRoot = join(process.cwd(), '_testenv', `global-apply-v${VERSION}`);
const ARCHIVE_PATH = candidate?.archive_path ?? join(releaseRoot, `sortie-dogs-${VERSION}.tgz`);
const ARCHIVE_SHA_PATH = candidate?.sha_manifest ?? join(releaseRoot, 'SHA256SUMS');
const PACK_RESULT_PATH = candidateReceiptPath ?? join(releaseRoot, 'plan.json');
const PACKAGE_RECEIPT_PATH = candidateReceiptPath ?? join(releaseRoot, 'application-receipt.json');
const GLOBAL_APPLY_VERIFICATION_PATH = PACKAGE_RECEIPT_PATH;
const TASK_PATH = 'M:/_work/_Sortie-dogs-artifacts/records/anko-reusable/v0.13.8-candidate-f109bf0c0d64/20261006T103412354Z-2cd8f6c0/instruction.md';
const RECORD_ROOT = candidate?.record_root ?? `M:/_work/_Sortie-dogs-artifacts/records/anko-codex/v${VERSION}`;
const PREVIOUS_RECORD = 'M:/_work/_Sortie-dogs-artifacts/records/anko-codex/v0.13.11/20261007T103208897Z-ab8e3704';
const EXPECTED_FIXTURES = {
  'AGENTS.md': '4bd2a243854ae8dcf6defaadd2edbc1b715196c902d38a0b4430ce529f65894b',
  '.benchmark/go.ps1': 'f5b1466d666932f15897ec2020789ab0d0c0011e12923727d3c6be3d6b9a75d8',
  '.benchmark/gofmt.ps1': '6d46dfbf6db0888f7ce6b4ee3f5acffd25fe41d8349a4036079f453e0534ce9d',
  '.benchmark/validate.ps1': 'dd46ed40c9a4bc12c1857b147508326c7a645668e9e31b0d68e5d1319aa10902',
};
const PACKAGE_MODULES = [
  'package.json',
  'dist/codex/mission-session.js',
  'dist/codex/app-server.js',
  'dist/cli/codex-mission.js',
  'dist/core/worktree-commit-artifact.js',
  'dist/core/operator-mission.js',
  'dist/core/runtime-profile.js',
  'dist/asset-version.js',
];
const repoRoot = process.cwd();
const labRoot = candidate?.lab_root ?? `M:/_work/_Sortie-dogs/_testenv/anko-codex-v${VERSION}-20261014`;
const packageRoot = join(labRoot, 'package');
const projectRoot = join(labRoot, 'project');
const preparedPath = join(labRoot, 'prepared.json');
const runnerPath = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = path => sha256(readFileSync(path));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const appendJsonl = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`);
const now = () => new Date().toISOString();
const normalizedPath = path => path.replaceAll('\\', '/');
const withinRecordRoot = path => typeof path === 'string' && normalizedPath(path).startsWith(`${normalizedPath(RECORD_ROOT)}/`);

// Adapt the already-accepted application receipt in memory; never rewrite it.
// File identities come from the same hash-pinned archive, not the installation.
function packageReceipt() {
  const receipt = JSON.parse(readFileSync(PACKAGE_RECEIPT_PATH, 'utf8'));
  const bytes = readFileSync(ARCHIVE_PATH);
  if (sha256(bytes) !== PACKAGE_SHA256) fail('Selected release archive changed');
  return {
    ...receipt,
    source_commit: candidate ? receipt.source_commit : receipt.release_commit,
    sha256: candidate ? receipt.sha256 : receipt.archive_sha256,
    files: [...PACKAGE_MODULES, '.agents/skills/sortie-dogs/sortie-dogs.version'].map(path => ({
      path, sha256: sha256(tarEntryFromTgz(bytes, `package/${path}`)),
    })),
  };
}

function globalApplyReceipt() {
  const receipt = JSON.parse(readFileSync(GLOBAL_APPLY_VERIFICATION_PATH, 'utf8'));
  if (candidate) return { source_commit: receipt.source_commit, package_sha256: receipt.sha256, roots: [], live_runtime_reload: false, global_install_modified: false };
  return { ...receipt, source_commit: receipt.release_commit, package_sha256: receipt.archive_sha256,
    roots: receipt.placements, live_runtime_reload: false };
}
const safeJsonl = path => existsSync(path)
  ? readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
  : [];

function commandIncludesValidation(command) {
  if (command == null) return false;
  const serialized = JSON.stringify(command);
  return typeof serialized === 'string' && serialized.includes('.benchmark/validate.ps1');
}

function hostCommandLedger(commands) {
  const started = new Map(commands.filter(item => item.phase === 'started').map(item => [item.id, item]));
  const terminal = new Map(commands
    .filter(item => ['completed', 'interrupted', 'not-started', 'unknown'].includes(item.phase))
    .map(item => [item.id, item]));
  const pending = [...started.values()].filter(item => !terminal.has(item.id));
  return { started, terminal, pending };
}

function validationCommandExecutions(commands) {
  const ledger = hostCommandLedger(commands);
  return [...ledger.started.values()]
    .filter(item => commandIncludesValidation(item.command))
    .map(start => {
      const terminal = ledger.terminal.get(start.id);
      return {
        id: start.id,
        tool: start.tool,
        thread_id: start.thread_id,
        call_id: start.call_id,
        command: start.command,
        cwd: start.cwd,
        started_at: start.at,
        terminal_phase: terminal?.phase ?? null,
        terminal_exit: terminal?.exit ?? null,
        terminal_signal: terminal?.signal ?? null,
      };
    });
}

function nativeEventUsage(recordDir) {
  const latest = new Map();
  for (const event of safeJsonl(join(recordDir, 'native-events.jsonl'))) {
    if (event.method !== 'thread/tokenUsage/updated') continue;
    const threadId = event.params?.threadId;
    const total = event.params?.tokenUsage?.total;
    if (typeof threadId !== 'string' || !total || typeof total !== 'object') continue;
    latest.set(threadId, {
      thread_id: threadId,
      observed_at: event.at,
      totals: total,
      model_context_window: event.params?.tokenUsage?.modelContextWindow ?? null,
    });
  }

  const snapshots = [...latest.values()];
  const fields = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  const complete = snapshots.length > 0 && snapshots.every(snapshot =>
    fields.every(field => Number.isFinite(snapshot.totals[field])));
  const aggregate = complete
    ? Object.fromEntries(fields.map(field => [field, snapshots.reduce((sum, snapshot) => sum + snapshot.totals[field], 0)]))
    : null;
  if (aggregate) aggregate.uncachedInputTokens = aggregate.inputTokens - aggregate.cachedInputTokens;

  return {
    status: complete ? 'latest-per-thread-snapshots; final usage unconfirmed' : 'unavailable-or-incomplete',
    snapshots,
    aggregate,
  };
}

function summarizeHostCommand(item) {
  const args = Array.isArray(item.command) ? item.command.map(String) : [];
  return {
    id: item.id,
    tool: item.tool ?? null,
    thread_id: item.thread_id ?? null,
    call_id: item.call_id ?? null,
    cwd: item.cwd ?? null,
    observed_phase: item.phase,
    argv_count: args.length,
    total_argument_characters: args.reduce((sum, arg) => sum + arg.length, 0),
    largest_argument_characters: args.reduce((largest, arg) => Math.max(largest, arg.length), 0),
    executable: args[0] ?? null,
  };
}

function recoverMissingRunArtifacts(recordDir, status, baseline, commands, usageSnapshot) {
  const generated = [];
  const ledger = hostCommandLedger(commands);
  const validationCommands = validationCommandExecutions(commands);
  const repositoryValidationPassed = validationCommands.some(item =>
    item.terminal_phase === 'completed' && item.terminal_exit === 0);
  const pendingCommands = ledger.pending.map(summarizeHostCommand);
  const commandReconciliation = {
    started_count: ledger.started.size,
    terminal_count: ledger.terminal.size,
    pending_count: pendingCommands.length,
    pending: pendingCommands,
    recorder_flag_command_drain_complete: status.command_drain_complete === true,
    reconciled: pendingCommands.length === 0
      && ledger.started.size === ledger.terminal.size
      && status.host_commands === status.host_commands_completed,
  };
  const missing = ['quality.json', 'usage.json', 'cleanup.json']
    .filter(file => !existsSync(join(recordDir, file)));

  if (missing.includes('quality.json')) {
    writeJson(join(recordDir, 'quality.json'), {
      recovered_after_runner_exception: true,
      grading: 'none',
      official_hidden_grading: false,
      baseline: { status: baseline.status, exit: baseline.exit, duration_ms: baseline.duration_ms },
      validation_commands: validationCommands,
      repository_validation_passed: repositoryValidationPassed,
      acceptance: { sdk_accepted: status.accepted, native_turn_status: status.native_status },
      source_git: status.git_after ?? null,
      note: 'Recovered from the saved command journal; Mission acceptance and repository validation are separate observations. No official Anko grader was run.',
    });
    generated.push('quality.json');
  }

  if (missing.includes('usage.json')) {
    writeJson(join(recordDir, 'usage.json'), {
      recovered_after_runner_exception: true,
      sessions: status.sessions ?? null,
      cumulative_tokens: status.usage ?? null,
      native_event_usage_snapshot: usageSnapshot,
      estimated_usd: null,
      actual_billed_usd: null,
      priced_usd: null,
      interpretation: 'SDK result/session usage was not saved. Native per-thread tokenUsage events provide latest observed snapshots only, not a confirmed final total. USD charges were not observed; unknown is not zero.',
    });
    generated.push('usage.json');
  }

  if (missing.includes('cleanup.json')) {
    writeJson(join(recordDir, 'cleanup.json'), {
      recovered_after_runner_exception: true,
      ended_at: status.ended_at ?? null,
      adapter_close_error: status.close_error ?? null,
      command_drain_complete: commandReconciliation.reconciled,
      recorder_flag_command_drain_complete: status.command_drain_complete === true,
      host_command_reconciliation: commandReconciliation,
      pending_host_commands: commandReconciliation.pending_count,
      shared_mission_snapshot: status.missions ?? null,
      mission_terminal: status.mission_terminal === true,
      native_status: status.native_status ?? null,
      model_wall_timeout: status.timeout === true,
    });
    generated.push('cleanup.json');
  }

  if (generated.length > 0 && !existsSync(join(recordDir, 'recovery.json'))) {
    const nativeExecutionErrors = safeJsonl(join(recordDir, 'native-events.jsonl'))
      .filter(event => event.method === 'sortie/commandExecution'
        && pendingCommands.some(item => item.call_id === event.params?.callId)
        && event.params?.status === 'unknown')
      .map(event => ({
        at: event.at,
        call_id: event.params.callId,
        tool: event.params.tool,
        status: event.params.status,
        reason: event.params.reason ?? null,
      }));
    writeJson(join(recordDir, 'recovery.json'), {
      schema_version: 1,
      recovered_at: now(),
      mode: 'artifact-only record recovery; no Mission or model retry',
      trigger: {
        runner_failure: 'TypeError: Cannot read properties of undefined (reading \'includes\')',
        cause: 'The post-run quality writer called JSON.stringify(item.command).includes(...) for terminal command records that have no command field. The live status had already been saved; result.json and derived summaries were not written.',
        execution_runner_revision: status.runner_revision,
        execution_runner_sha256: status.runner_sha256,
      },
      preserved_inputs: ['live-status.json', 'host-commands.jsonl', 'native-events.jsonl', 'native-routes.jsonl', 'run-once.lock'],
      generated_records: generated,
      sdk_result_file_present: existsSync(join(recordDir, 'result.json')),
      mission: {
        accepted: status.accepted,
        native_status: status.native_status,
        mission_terminal: status.mission_terminal,
        recorder_terminal: status.recorder_terminal,
        latest_snapshot_phase: Array.isArray(status.missions) ? status.missions.map(item => ({
          id: item.id,
          phase: item.phase,
          owner_closed: item.codexOwner?.closed ?? null,
        })) : null,
      },
      command_reconciliation: commandReconciliation,
      native_execution_errors: nativeExecutionErrors,
      result_interpretation: 'These files recover derived summaries from saved evidence. They do not synthesize an SDK result, command terminal, Mission terminal, acceptance, formal validation, grade, or USD charge.',
    });
    generated.push('recovery.json');
  }

  return { recovered: generated.length > 0, generated, command_reconciliation: commandReconciliation };
}

function fail(message) {
  throw new Error(message);
}

function parseArgs() {
  const [, , action, ...args] = process.argv;
  const options = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--') || index + 1 >= args.length) fail(`Invalid argument: ${key}`);
    if (options.has(key)) fail(`Duplicate argument: ${key}`);
    options.set(key, args[++index]);
  }
  if (!['prepare', 'baseline', 'run', 'verify'].includes(action)) fail(`Usage: node ${runnerPath} <prepare|baseline|run|verify> --version ${VERSION}`);
  if (options.get('--version') !== VERSION || options.size !== (candidate ? 2 : 1)
    || (candidate && options.get('--candidate-receipt') !== candidateReceiptPath)) fail(`Use --version ${VERSION} and the fixed optional --candidate-receipt`);
  return action;
}

function runCommand(executable, args, cwd, timeoutMs = 0) {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let spawnError;
    let timedOut = false;
    let timer;
    child.stdout.on('data', part => stdout.push(part));
    child.stderr.on('data', part => stderr.push(part));
    child.once('error', error => { spawnError = error; });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    }
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        executable,
        args,
        cwd,
        exit: code,
        signal,
        spawn_error: spawnError?.message ?? null,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function recordedSetupCommand(recordDir, label, executable, args, cwd, timeoutMs = 0) {
  const result = await runCommand(executable, args, cwd, timeoutMs);
  const { stdout, stderr, ...metadata } = result;
  appendJsonl(join(recordDir, 'setup-commands.jsonl'), { at: now(), label, ...metadata });
  writeFileSync(join(recordDir, `${label}.stdout.log`), stdout);
  writeFileSync(join(recordDir, `${label}.stderr.log`), stderr);
  if (result.exit !== 0 || result.spawn_error || result.timed_out) {
    fail(`${label} failed (exit=${result.exit}, timeout=${result.timed_out}): ${stderr || stdout || result.spawn_error}`);
  }
  return result;
}

function git(project, args, label, recordDir = null) {
  return runCommand('git', ['-C', project, ...args], repoRoot).then(result => {
    if (recordDir) {
      const { stdout, stderr, ...metadata } = result;
      appendJsonl(join(recordDir, 'git-observations.jsonl'), { at: now(), label, ...metadata });
    }
    if (result.exit !== 0 || result.spawn_error) fail(`${label}: ${result.stderr || result.stdout || result.spawn_error}`);
    return result.stdout.trimEnd();
  });
}

function getRepositoryIdentity() {
  return Promise.all([
    runCommand('git', ['rev-parse', 'HEAD'], repoRoot),
    runCommand('git', ['status', '--short', '--branch', '--untracked-files=all'], repoRoot),
  ]).then(([head, status]) => {
    if (head.exit !== 0 || status.exit !== 0) fail('Unable to record Sortie repository identity');
    return {
      head: head.stdout.trim(),
      status: status.stdout.trimEnd(),
      runner_path: runnerPath,
      runner_sha256: hashFile(runnerPath),
    };
  });
}

function fixtureHashes(project) {
  return Object.fromEntries(Object.keys(EXPECTED_FIXTURES).map(path => [path, hashFile(join(project, path))]));
}

async function prepare() {
  if (!existsSync(join(repoRoot, '.git'))) fail('The runner must start from the declared repository root');
  let resumePrepared = null;
  if (existsSync(preparedPath)) {
    const existing = JSON.parse(readFileSync(preparedPath, 'utf8'));
    const recordDir = existing.record_dir;
    const conditionsPath = typeof recordDir === 'string' ? join(recordDir, 'conditions.json') : null;
    const existingConditions = conditionsPath && existsSync(conditionsPath)
      ? JSON.parse(readFileSync(conditionsPath, 'utf8'))
      : null;
    if (existing.version !== VERSION || existing.state !== 'preparing'
      || existing.project !== projectRoot || existing.package !== packageRoot
      || !existsSync(packageRoot) || existsSync(projectRoot)
      || !withinRecordRoot(recordDir)
      || existsSync(join(recordDir, 'run-once.lock')) || existsSync(join(recordDir, 'live-status.json'))
      || existingConditions?.initial_model_turns !== 0) {
      fail('Prepared benchmark paths already exist; refusing to overwrite a prior setup or arm');
    }
    resumePrepared = existing;
  } else if (existsSync(projectRoot) || existsSync(packageRoot)) {
    fail('Prepared benchmark paths already exist; refusing to overwrite a prior setup or arm');
  }
  mkdirSync(RECORD_ROOT, { recursive: true });

  const archiveHash = hashFile(ARCHIVE_PATH);
  if (archiveHash !== PACKAGE_SHA256) fail(`Fixed package hash mismatch: ${archiveHash}`);
  const shaManifest = readFileSync(ARCHIVE_SHA_PATH, 'utf8');
  if (!shaManifest.includes(`${PACKAGE_SHA256}  sortie-dogs-${VERSION}.tgz`)) fail('Existing package SHA256SUMS does not match the fixed archive');
  const packResult = JSON.parse(readFileSync(PACK_RESULT_PATH, 'utf8'));
  if (packResult.version !== VERSION || (candidate ? packResult.source_commit : packResult.commit) !== RELEASE_COMMIT || packResult.sha256 !== PACKAGE_SHA256) {
    fail('Existing package result does not identify the fixed archive and release commit');
  }
  const fixedReceipt = packageReceipt();
  const globalApply = globalApplyReceipt();
  if (fixedReceipt.version !== VERSION || fixedReceipt.source_commit !== RELEASE_COMMIT
    || fixedReceipt.sha256 !== PACKAGE_SHA256) fail('Global-apply package receipt does not match the fixed archive and release commit');
  if (globalApply.package_sha256 !== PACKAGE_SHA256 || globalApply.source_commit !== RELEASE_COMMIT
    || globalApply.roots.some(root => root.version !== VERSION)) fail('Global-apply verification does not match the fixed v0.13.11 package');
  const prompt = readFileSync(TASK_PATH);
  if (prompt.byteLength !== TASK_BYTES || sha256(prompt) !== TASK_SHA256) fail('The original Anko task bytes or hash changed');
  if (!existsSync(CODEX_CLI_PATH)) fail(`Previously used native Codex CLI executable is unavailable: ${CODEX_CLI_PATH}`);

  const sourceMain = await git(SOURCE_PROJECT, ['rev-parse', 'refs/heads/main'], 'source-main');
  if (sourceMain.trim() !== BASE_COMMIT) fail(`Existing Anko main no longer points at the pinned base: ${sourceMain.trim()}`);

  const id = resumePrepared?.attempt_id
    ?? `${new Date().toISOString().replaceAll(/[-:.]/gu, '').replace('Z', 'Z')}-${randomUUID().slice(0, 8)}`;
  const recordDir = resumePrepared?.record_dir ?? join(RECORD_ROOT, id);
  if (!resumePrepared) {
    mkdirSync(recordDir, { recursive: false });
    mkdirSync(labRoot, { recursive: false });
    writeFileSync(join(recordDir, 'instruction.md'), prompt);
  } else if (!existsSync(recordDir) || hashFile(join(recordDir, 'instruction.md')) !== TASK_SHA256) {
    fail('Interrupted pre-arm setup has no intact task record; preserving it without overwrite');
  }

  const repoIdentity = await getRepositoryIdentity();
  const conditions = resumePrepared
    ? JSON.parse(readFileSync(join(recordDir, 'conditions.json'), 'utf8'))
    : {
    schema_version: 1,
    version: VERSION,
    attempt_id: id,
    created_at: now(),
    task: 'datacurve/anko-typed-variable-bindings',
    original_instruction: { path: TASK_PATH, bytes: prompt.byteLength, sha256: sha256(prompt) },
    anko_base: BASE_COMMIT,
    execution: 'Windows native Codex SDK Mission; native Codex model sessions; existing SDK parent-host command executor',
    authentication: 'Reuse existing native Codex authentication; no credentials copied, changed, or exported',
    permission_overrides: null,
    native_sandbox_repaired: false,
    source_package: {
      path: ARCHIVE_PATH,
      sha256: archiveHash,
      version: VERSION,
      kind: candidate ? 'fixed-local-source-candidate; not published or globally installed' : 'official-release',
      source_commit: RELEASE_COMMIT,
      release_commit: RELEASE_COMMIT,
      pack_receipt: PACK_RESULT_PATH,
      global_apply_receipt: PACKAGE_RECEIPT_PATH,
      global_apply_verification: GLOBAL_APPLY_VERIFICATION_PATH,
      global_apply_runtime_reload: globalApply.live_runtime_reload,
      global_install_modified: false,
    },
    runner: {
      revision: repoIdentity.head,
      path: runnerPath,
      sha256: repoIdentity.runner_sha256,
      repository_status_at_prepare: repoIdentity.status,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.execPath,
      node_version: process.version,
      codex_cli: CODEX_CLI_PATH,
      codex_cli_sha256: hashFile(CODEX_CLI_PATH),
      codex_cli_version: null,
      previous_codex_cli: 'C:/Users/rozen/AppData/Local/OpenAI/Codex/bin/979a96ce184041d1/codex.exe',
      previous_codex_cli_version: 'codex-cli 0.162.0-alpha.2',
      cli_environment_difference: 'The previous executable is absent; reuse the currently installed native CLI without install, authentication, model, or permission changes. This is not a strictly matched release-only comparison.',
      pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    },
    limits: { model_arms: 1, wall_time_ms: WALL_LIMIT_MS, pricing_usd_cap: null, grading: 'none' },
    prior_history: {
      v01321_early_close: {
        evidence: 'M:/_work/_Sortie-dogs-artifacts/records/anko-codex/v0.13.21/20261014T061359203Z-95f23b92',
        package_sha256: 'b8e0fe937a86d7bedaca75bce5c2277a8b34ee8d0c38356d03d1eb3939f47c9b',
        elapsed_ms: 832956, accepted: false, native_status: 'completed', worker_native_terminal: false,
        latest_token_snapshot: 4704030, actual_billed_usd: null,
      },
      v01311_fixed_release: (() => {
        const previous = JSON.parse(readFileSync(join(PREVIOUS_RECORD, 'live-status.json'), 'utf8'));
        return { evidence: PREVIOUS_RECORD, package_sha256: previous.source_package_sha256,
          root: previous.root, elapsed_ms: previous.elapsed_ms, native_turns: previous.model_turns_started,
          host_commands: previous.host_commands, accepted: previous.accepted,
          usage_tokens: previous.usage?.totalTokens ?? null, actual_billed_usd: null };
      })(),
      v0139_native_manifest_arm: {
        started_at: '2026-10-07T04:56:41.286Z',
        elapsed_ms: 32284,
        result: 'failed before implementation; native sandbox setup refresh error; 160716 tokens observed; USD unknown',
        extra_arms: 0,
      },
      pr169_native_mission: {
        package_sha256: 'cf43d9664c7da46adb76eeecdcecd3b43d51ff0c280676fd5fc841647baf6ba3',
        elapsed_ms: 1646173,
        native_turns: 3,
        host_commands: 189,
        accepted: true,
        worker_route: { model: 'gpt-6-luna', effort: 'max', service_tier: 'priority' },
        usage_tokens: 12311739,
        actual_billed_usd: null,
        native_sandbox_repaired: false,
      },
      v0138_open_code_trial: {
        elapsed_ms: 1135039,
        stop_reason: 'contextual-recovery-limit-without-acceptance',
        accepted: false,
        estimated_usd: 0.293475,
        actual_billed_usd: null,
      },
      v01310_enametoolong_attempt: {
        evidence: 'docs/benchmarks/anko-v01310-20261007.md; M:/_work/_Sortie-dogs-artifacts/records/anko-codex/v0.13.10/20261007T083402155Z-c8c7be3d/',
        package_sha256: 'f3dc7a400e0239c54abc48a249ec9ee00629916e21e9e2fcb586639823cde05b',
        elapsed_ms: 554616,
        native_turns: 2,
        accepted: false,
        native_status: null,
        mission_terminal: false,
        host_commands: { started: 74, terminal: 73, pending: 1 },
        failed_write: { status: 'unknown', reason: 'spawn ENAMETOOLONG', total_argument_characters: 79529 },
        post_run_exception: "TypeError: Cannot read properties of undefined (reading 'includes')",
        latest_token_snapshot: 3445669,
        estimated_usd: null,
        actual_billed_usd: null,
        extra_arms: 0,
      },
      v01310_codex_snapshot_attempt: {
        evidence: 'M:/_work/_Sortie-dogs-artifacts/records/anko-codex/v0.13.10/20261007/postmortem.json',
        package_sha256: 'f92adb8a0bee4180490f13eb5df53cc49744c77ef61926d9d6ba90f370321bee',
        elapsed_ms: 1020129,
        native_turns: 2,
        accepted: false,
        mission_terminal: false,
        host_commands: { started: 102, terminal: 101, pending: 1 },
        failed_write: { status: 'unknown', reason: 'spawn ENAMETOOLONG', command_id: 102 },
        latest_token_snapshot: 9011823,
        estimated_usd: null,
        actual_billed_usd: null,
        extra_arms: 0,
      },
      v01311_preexisting_attempt_1: {
        evidence: 'M:/_work/_Sortie-dogs-artifacts/records/anko-codex/v0.13.11/20261007/attempt-1/',
        package_sha256: '7ba2657485ae134874559ec69115d28008ac7126526f5712f7d63cf1eca1c5f3',
        required_package_sha256: PACKAGE_SHA256,
        started_at: '2026-10-07T10:21:04.502Z',
        last_observed_at: '2026-10-07T10:29:39Z',
        root: '01a115e1-8b5c-7f62-964a-17a1a1790f2e',
        model_turns_started: 2,
        host_commands: { started: 69, terminal: 69 },
        accepted: false,
        recorder_terminal_at_snapshot: false,
        estimated_usd: null,
        actual_billed_usd: null,
        interpretation: 'Pre-existing separate arm using a different archive hash; its native termination/result was unavailable at inspection and it is not a result for the fixed candidate. Preserve its records; do not resume or adopt it.',
      },
      pr171_fixed_codex_mission: {
        evidence: 'docs/codex-write-status-anko-20261007.md',
        package_sha256: '74ba9e95f73c4c8a5fdceefbb566a421e09c634afc77049cfb9c8a14387186d6',
        elapsed_ms: 1808739,
        native_turns: 3,
        host_commands: { started: 190, terminal: 190 },
        accepted: true,
        native_status: 'completed',
        final_anko_commit: '8a8ccc29acf6105c76a4344d6ef8e29662055820',
        usage_tokens: 11922702,
        actual_billed_usd: null,
        native_sandbox_repaired: false,
      },
      pr173_open_code_campaign: {
        evidence: 'docs/benchmarks/operation-result-autonomy-20261007.md',
        package_sha256: 'f92adb8a0bee4180490f13eb5df53cc49744c77ef61926d9d6ba90f370321bee',
        attempts: [
          { id: 'v01310-once-20261007', stop_reason: 'session-no-progress-timeout', exit: 1, elapsed_ms: 650972 },
          { id: 'v01310-once-20261007-02', stop_reason: 'session-no-progress-timeout', exit: 1, elapsed_ms: 859784 },
        ],
        cumulative_known_priced_usd: 3.38283948,
        unresolved_usage_messages: 10,
        remaining_known_price_allowance_usd: 11.61716052,
        actual_billed_usd: null,
        applies_to: 'Separate Linux OpenCode benchmark campaign; not the native Codex SDK arm below.',
      },
      campaign_cost: 'Native Codex subscription USD usage is unknown and not reset; no metered charge or numeric USD cap is asserted for this arm. Separate OpenCode campaign accounting remains above and is not merged with this arm.',
    },
    project: projectRoot,
    record_dir: recordDir,
    package_dir: packageRoot,
    initial_model_turns: 0,
    baseline: { command: '& ".benchmark/validate.ps1"', status: 'pending' },
    grading: 'none',
    };
  if (resumePrepared) {
    const previousRunnerSha256 = conditions.runner.sha256;
    conditions.runner.initial_sha256 ??= previousRunnerSha256;
    conditions.runner.revision = repoIdentity.head;
    conditions.runner.sha256 = repoIdentity.runner_sha256;
    conditions.runner.repository_status_at_prepare = repoIdentity.status;
    conditions.runner.setup_recovery = {
      at: now(),
      previous_runner_sha256: previousRunnerSha256,
      reason: 'The fixed archive contains the declared legacy Skill marker; verify the marker against the fixed package receipt and record it instead of rejecting the pinned archive.',
      model_arms_started: 0,
    };
    writeJson(join(recordDir, 'conditions.json'), conditions);
    writeJson(join(recordDir, 'preparation-recovery.json'), {
      recorded_at: now(),
      action: 'resume the same pre-arm setup after a package-marker assertion rejected the exact pinned archive',
      previous_failure: 'Unexpected packaged Skill marker: 0.13.10-codex-skill-v2',
      fixed_archive_sha256: PACKAGE_SHA256,
      preserved_records: ['conditions.json', 'setup-commands.jsonl', 'extract-fixed-package.stdout.log', 'extract-fixed-package.stderr.log'],
      model_arms_started: 0,
      package_modified: false,
    });
  } else {
    writeJson(join(recordDir, 'conditions.json'), conditions);
    writeJson(preparedPath, { version: VERSION, attempt_id: id, record_dir: recordDir, project: projectRoot, package: packageRoot, state: 'preparing' });
  }

  if (!resumePrepared) {
    await recordedSetupCommand(recordDir, 'extract-fixed-package', 'C:\\WINDOWS\\system32\\tar.exe', ['-xzf', ARCHIVE_PATH, '-C', labRoot], repoRoot);
  } else {
    const extracted = safeJsonl(join(recordDir, 'setup-commands.jsonl'))
      .find(item => item.label === 'extract-fixed-package');
    if (!extracted || extracted.exit !== 0 || extracted.spawn_error || extracted.timed_out) {
      fail('Interrupted pre-arm setup has no successful fixed-package extraction receipt; preserving it without overwrite');
    }
  }
  const packageMetadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (packageMetadata.version !== VERSION) fail(`Extracted package reports version ${packageMetadata.version}`);
  const runtimeProfilePath = join(packageRoot, 'dist', 'core', 'runtime-profile.js');
  const skillPath = join(packageRoot, '.agents', 'skills', 'sortie-dogs', 'sortie-dogs.version');
  if (!existsSync(runtimeProfilePath) || !existsSync(skillPath)) fail('The fixed archive is missing the Codex runtime profile or packaged Skill marker');
  const skillMarker = readFileSync(skillPath, 'utf8').trim();
  const skillReceipt = fixedReceipt.files?.find(item => item.path === '.agents/skills/sortie-dogs/sortie-dogs.version');
  const skillMarkerSha256 = hashFile(skillPath);
  if (!skillReceipt || skillReceipt.sha256 !== skillMarkerSha256) fail('Packaged Skill marker differs from the fixed package receipt');
  const { V010_RUNTIME_ASSET_VERSION } = await import(pathToFileURL(join(packageRoot, 'dist', 'asset-version.js')));
  if (V010_RUNTIME_ASSET_VERSION !== RUNTIME_MARKER) {
    fail(`Unexpected v010 runtime asset marker: ${V010_RUNTIME_ASSET_VERSION}`);
  }
  conditions.package_metadata = {
    name: packageMetadata.name,
    version: packageMetadata.version,
    skill_marker: skillMarker,
    skill_marker_sha256: skillMarkerSha256,
    skill_marker_matches_package_receipt: true,
    skill_marker_matches_release_version: skillMarker === `${VERSION}-codex-skill-v2`,
    v010_runtime_asset_version: V010_RUNTIME_ASSET_VERSION,
  };
  conditions.extracted_package_files = Object.fromEntries(PACKAGE_MODULES.map(path => [path, hashFile(join(packageRoot, path))]));
  for (const [path, hash] of Object.entries(conditions.extracted_package_files)) {
    const receiptFile = fixedReceipt.files?.find(item => item.path === path);
    if (!receiptFile || receiptFile.sha256 !== hash) fail(`Extracted package file differs from the fixed package receipt: ${path}`);
  }

  await recordedSetupCommand(recordDir, 'clone-anko-main', 'git', [
    'clone', '--no-hardlinks', '--no-checkout', '--single-branch', '--branch', 'main', SOURCE_PROJECT, projectRoot,
  ], repoRoot);
  await recordedSetupCommand(recordDir, 'checkout-pinned-main', 'git', ['-C', projectRoot, 'checkout', 'main'], repoRoot);
  const checkedOut = await git(projectRoot, ['rev-parse', 'HEAD'], 'project-base', recordDir);
  if (checkedOut.trim() !== BASE_COMMIT) fail(`Anko clone is not at the pinned main commit: ${checkedOut.trim()}`);
  await recordedSetupCommand(recordDir, 'remove-project-remote', 'git', ['-C', projectRoot, 'remote', 'remove', 'origin'], repoRoot);

  copyFileSync(join(SOURCE_PROJECT, 'AGENTS.md'), join(projectRoot, 'AGENTS.md'));
  mkdirSync(join(projectRoot, '.benchmark'), { recursive: false });
  const sourceWslPath = await runCommand('wsl.exe', ['-e', 'wslpath', '-a', SOURCE_PROJECT], repoRoot);
  if (sourceWslPath.exit !== 0) fail('Could not resolve the retained fixture path');
  const sourceWslRoot = sourceWslPath.stdout.trim();
  const targetWslPath = await runCommand('wsl.exe', ['-e', 'wslpath', '-a', projectRoot], repoRoot);
  if (targetWslPath.exit !== 0) fail('Could not resolve the generated clone path for the existing WSL helper');
  const targetWslRoot = targetWslPath.stdout.trim();
  for (const name of ['go.ps1', 'gofmt.ps1', 'validate.ps1']) {
    const sourcePath = join(SOURCE_PROJECT, '.benchmark', name);
    const targetPath = join(projectRoot, '.benchmark', name);
    const source = readFileSync(sourcePath, 'utf8');
    const content = name === 'validate.ps1' ? source : source.replace(sourceWslRoot, targetWslRoot);
    if (name !== 'validate.ps1' && content === source) fail(`Could not bind ${name} to the new Anko clone path`);
    writeFileSync(targetPath, content);
  }
  mkdirSync(join(projectRoot, '.sortie-dogs', 'go-cache', 'path', 'bin'), { recursive: true });
  mkdirSync(join(projectRoot, '.sortie-dogs', 'go-cache', 'tmp'), { recursive: true });

  const fixtures = fixtureHashes(projectRoot);
  if (fixtures['AGENTS.md'] !== EXPECTED_FIXTURES['AGENTS.md']) fail('Copied Anko Mission instructions do not match the previous PR169 setup');
  for (const path of ['.benchmark/validate.ps1']) {
    if (fixtures[path] !== EXPECTED_FIXTURES[path]) fail(`Formal validator fixture changed: ${path}`);
  }
  const fixtureReport = Object.fromEntries(Object.entries(fixtures).map(([path, sha]) => [path, {
    sha256: sha,
    source_sha256: EXPECTED_FIXTURES[path],
    path_rebound_from_pr169: ['.benchmark/go.ps1', '.benchmark/gofmt.ps1'].includes(path),
  }]));
  writeJson(join(recordDir, 'fixtures.json'), fixtureReport);
  writeFileSync(join(recordDir, 'instruction.sha256'), `${TASK_SHA256}  instruction.md\n`);

  const codexVersion = await recordedSetupCommand(recordDir, 'codex-version', CODEX_CLI_PATH, ['--version'], repoRoot);
  conditions.host.codex_cli_version = codexVersion.stdout.trim();
  conditions.fixtures = fixtureReport;
  conditions.baseline = {
    command: '& ".benchmark/validate.ps1"',
    invocation: 'PowerShell 7, from the Anko project root; existing offline WSL Go 1.27.1 helper',
    expected_source_hashes: EXPECTED_FIXTURES,
    status: 'running',
  };
  writeJson(join(recordDir, 'conditions.json'), conditions);

  const baseline = await runCommand('C:\\Program Files\\PowerShell\\7\\pwsh.exe', [
    '-NoProfile', '-Command', '& ".benchmark/validate.ps1"',
  ], projectRoot, 1_800_000);
  writeFileSync(join(recordDir, 'baseline.stdout.log'), baseline.stdout);
  writeFileSync(join(recordDir, 'baseline.stderr.log'), baseline.stderr);
  const baselineSummary = {
    started_at: new Date(Date.now() - baseline.duration_ms).toISOString(),
    ended_at: now(),
    command: '& ".benchmark/validate.ps1"',
    native_invocation: { executable: baseline.executable, args: baseline.args, cwd: baseline.cwd },
    exit: baseline.exit,
    duration_ms: baseline.duration_ms,
    timed_out: baseline.timed_out,
    spawn_error: baseline.spawn_error,
    source_commit_before: BASE_COMMIT,
    source_commit_after: await git(projectRoot, ['rev-parse', 'HEAD'], 'baseline-source-head', recordDir),
    source_status_after: await git(projectRoot, ['status', '--short', '--branch', '--untracked-files=all'], 'baseline-source-status', recordDir),
    fixture_sha256: fixtureHashes(projectRoot),
    offline_toolchain: 'existing WSL Go 1.27.1, GOTOOLCHAIN=local, GOPROXY=off, GOSUMDB=off',
  };
  baselineSummary.status = baselineSummary.exit === 0 && !baselineSummary.timed_out && !baselineSummary.spawn_error
    ? 'passed'
    : 'failed';
  writeJson(join(recordDir, 'baseline.json'), baselineSummary);
  conditions.baseline = { ...conditions.baseline, status: baselineSummary.status, exit: baselineSummary.exit, duration_ms: baselineSummary.duration_ms };
  writeJson(join(recordDir, 'conditions.json'), conditions);
  writeJson(preparedPath, {
    version: VERSION,
    attempt_id: id,
    record_dir: recordDir,
    project: projectRoot,
    package: packageRoot,
    state: baselineSummary.status === 'passed' ? 'ready' : 'baseline-failed',
    baseline_file: 'baseline.json',
    baseline: baselineSummary,
  });
  console.log(JSON.stringify({
    phase: 'prepare',
    version: VERSION,
    attempt_id: id,
    archive_sha256: archiveHash,
    release_commit: RELEASE_COMMIT,
    runner_revision: repoIdentity.head,
    runner_sha256: repoIdentity.runner_sha256,
    task_sha256: sha256(prompt),
    base: checkedOut.trim(),
    codex_cli_version: conditions.host.codex_cli_version,
    baseline: { status: baselineSummary.status, exit: baselineSummary.exit, duration_ms: baselineSummary.duration_ms },
    records: recordDir,
  }));
  if (baselineSummary.status !== 'passed') process.exitCode = 1;
}

async function recoverBaseline() {
  if (!existsSync(preparedPath)) fail('Run prepare first; no prepared benchmark inputs were found');
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  if (prepared.version !== VERSION || prepared.state !== 'baseline-failed') fail(`Baseline recovery is not available from state ${prepared.state}`);
  const recordDir = prepared.record_dir;
  if (!withinRecordRoot(recordDir) || existsSync(join(recordDir, 'run-once.lock'))
    || existsSync(join(recordDir, 'baseline-attempt-02.json'))) fail('Baseline recovery is limited to one pre-arm setup correction');
  const conditionsPath = join(recordDir, 'conditions.json');
  const conditions = JSON.parse(readFileSync(conditionsPath, 'utf8'));
  const firstBaseline = JSON.parse(readFileSync(join(recordDir, prepared.baseline_file ?? 'baseline.json'), 'utf8'));
  const firstBaselineStderr = readFileSync(join(recordDir, 'baseline.stderr.log'), 'utf8');
  if (firstBaseline.status !== 'failed' || firstBaseline.exit === 0 || firstBaseline.timed_out) fail('Recorded first baseline does not match a recoverable setup failure');
  const currentRunnerSha256 = hashFile(runnerPath);
  if (conditions.runner.sha256 !== currentRunnerSha256) {
    conditions.runner.initial_sha256 ??= conditions.runner.sha256;
    conditions.runner.sha256 = currentRunnerSha256;
    conditions.runner.setup_correction = {
      at: now(),
      reason: 'The old toolchain tree was removed. Rebind only the new helper paths to a retained identical Go 1.27.1 archive/toolchain; preserve the failed pre-arm baseline.',
      previous_runner_sha256: conditions.runner.initial_sha256,
    };
  }
  mkdirSync(join(projectRoot, '.sortie-dogs', 'go-cache', 'path', 'bin'), { recursive: true });
  mkdirSync(join(projectRoot, '.sortie-dogs', 'go-cache', 'tmp'), { recursive: true });
  const recovery = {
    recorded_at: now(),
    cause: firstBaselineStderr.includes('go-cache/tmp: no such file or directory')
      ? 'The fixture helper sets TMPDIR to the clone-local Go cache, but the required directory was absent.'
      : 'The first baseline failed before any model arm; see baseline.json and the captured stderr.',
    repair: 'Only the newly generated go.ps1/gofmt.ps1 toolchain location was rebound. The old fixture, task, validator, source, global files, and toolchain bytes are unchanged; no install.',
    first_baseline: { file: prepared.baseline_file ?? 'baseline.json', exit: firstBaseline.exit, duration_ms: firstBaseline.duration_ms },
    model_turns_started: 0,
    model_arms_started: 0,
    automatic_model_retry: false,
  };
  const goArchive = 'M:/_work/_Sortie-dogs/_testenv/anko-v0134-20261003/go1.27.1.linux-amd64.tar.gz';
  if (hashFile(goArchive) !== '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445') fail('Retained Go archive differs from the pinned preparation');
  recovery.retained_go_archive = { path: goArchive, sha256: hashFile(goArchive) };
  recovery.retained_go_binary = { path: 'M:/_work/_Sortie-dogs/_testenv/anko-v0134-20261003/tools/go/bin/go',
    sha256: hashFile('M:/_work/_Sortie-dogs/_testenv/anko-v0134-20261003/tools/go/bin/go') };
  for (const [path, digest] of Object.entries(fixtureHashes(projectRoot))) {
    const original = conditions.fixtures[path];
    if (!['.benchmark/go.ps1', '.benchmark/gofmt.ps1'].includes(path) && digest !== original.sha256) fail(`Unexpected pre-arm fixture change: ${path}`);
    conditions.fixtures[path] = { ...original, initial_sha256: original.sha256, sha256: digest,
      toolchain_location_rebound: ['.benchmark/go.ps1', '.benchmark/gofmt.ps1'].includes(path) };
  }
  conditions.pre_arm_environment_recovery = recovery;
  writeJson(join(recordDir, 'baseline-recovery.json'), recovery);
  const baseline = await runCommand('C:\\Program Files\\PowerShell\\7\\pwsh.exe', [
    '-NoProfile', '-Command', '& ".benchmark/validate.ps1"',
  ], projectRoot, 1_800_000);
  writeFileSync(join(recordDir, 'baseline-attempt-02.stdout.log'), baseline.stdout);
  writeFileSync(join(recordDir, 'baseline-attempt-02.stderr.log'), baseline.stderr);
  const summary = {
    started_at: new Date(Date.now() - baseline.duration_ms).toISOString(),
    ended_at: now(),
    command: '& ".benchmark/validate.ps1"',
    native_invocation: { executable: baseline.executable, args: baseline.args, cwd: baseline.cwd },
    exit: baseline.exit,
    duration_ms: baseline.duration_ms,
    timed_out: baseline.timed_out,
    spawn_error: baseline.spawn_error,
    source_commit_before: BASE_COMMIT,
    source_commit_after: await git(projectRoot, ['rev-parse', 'HEAD'], 'baseline-recovery-source-head', recordDir),
    source_status_after: await git(projectRoot, ['status', '--short', '--branch', '--untracked-files=all'], 'baseline-recovery-source-status', recordDir),
    fixture_sha256: fixtureHashes(projectRoot),
    offline_toolchain: 'existing WSL Go 1.27.1, GOTOOLCHAIN=local, GOPROXY=off, GOSUMDB=off',
    setup_correction: recovery,
  };
  summary.status = summary.exit === 0 && !summary.timed_out && !summary.spawn_error ? 'passed' : 'failed';
  writeJson(join(recordDir, 'baseline-attempt-02.json'), summary);
  conditions.baseline = {
    ...conditions.baseline,
    status: summary.status,
    exit: summary.exit,
    duration_ms: summary.duration_ms,
    attempts: [
      { file: prepared.baseline_file ?? 'baseline.json', status: firstBaseline.status, exit: firstBaseline.exit, duration_ms: firstBaseline.duration_ms },
      { file: 'baseline-attempt-02.json', status: summary.status, exit: summary.exit, duration_ms: summary.duration_ms },
    ],
  };
  writeJson(conditionsPath, conditions);
  writeJson(preparedPath, {
    ...prepared,
    state: summary.status === 'passed' ? 'ready' : 'baseline-failed',
    baseline_file: 'baseline-attempt-02.json',
    baseline: summary,
  });
  console.log(JSON.stringify({
    phase: 'baseline-recovery',
    attempt_id: prepared.attempt_id,
    runner_sha256: currentRunnerSha256,
    baseline: { status: summary.status, exit: summary.exit, duration_ms: summary.duration_ms },
    model_arms_started: 0,
    records: recordDir,
  }));
  if (summary.status !== 'passed') process.exitCode = 1;
}

async function loadPrepared({ allowRunnerHashChange = false } = {}) {
  if (!existsSync(preparedPath)) fail('Run prepare first; no prepared benchmark inputs were found');
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  if (prepared.version !== VERSION || prepared.state !== 'ready') fail(`Prepared benchmark is not launch-ready: ${prepared.state}`);
  const recordDir = prepared.record_dir;
  if (!withinRecordRoot(recordDir)) fail(`Persistent record path is outside the assigned v${VERSION} root`);
  const conditions = JSON.parse(readFileSync(join(recordDir, 'conditions.json'), 'utf8'));
  const baseline = JSON.parse(readFileSync(join(recordDir, prepared.baseline_file ?? 'baseline.json'), 'utf8'));
  if (baseline.status !== 'passed' || baseline.exit !== 0) fail('The fixed-input offline baseline did not pass; no model arm will start');
  if (hashFile(ARCHIVE_PATH) !== PACKAGE_SHA256 || hashFile(TASK_PATH) !== TASK_SHA256) fail('A fixed benchmark input changed after preparation');
  if (!allowRunnerHashChange && hashFile(runnerPath) !== conditions.runner.sha256) {
    fail('Reusable runner changed after preparation');
  }
  for (const [path, expected] of Object.entries(conditions.extracted_package_files)) {
    if (hashFile(join(packageRoot, path)) !== expected) fail(`Extracted package file changed after preparation: ${path}`);
  }
  for (const [path, expected] of Object.entries(conditions.fixtures).map(([path, info]) => [path, info.sha256])) {
    if (hashFile(join(projectRoot, path)) !== expected) fail(`Prepared fixture changed: ${path}`);
  }
  return { prepared, conditions, baseline };
}

async function gitSnapshot(recordDir, label) {
  const [head, branch, status, diffStat, remotes, log] = await Promise.all([
    git(projectRoot, ['rev-parse', 'HEAD'], `${label}-head`, recordDir),
    git(projectRoot, ['branch', '--show-current'], `${label}-branch`, recordDir),
    git(projectRoot, ['status', '--short', '--branch', '--untracked-files=all'], `${label}-status`, recordDir),
    git(projectRoot, ['diff', '--stat'], `${label}-diff-stat`, recordDir),
    git(projectRoot, ['remote', '-v'], `${label}-remotes`, recordDir),
    git(projectRoot, ['log', '-5', '--format=%H%x09%s'], `${label}-log`, recordDir),
  ]);
  return { head, branch, status, diff_stat: diffStat, remotes, recent_commits: log.split(/\r?\n/u).filter(Boolean) };
}

function cumulativeUsage(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const numericFields = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  const totals = Object.fromEntries(numericFields.map(field => [field, 0]));
  for (const session of sessions) {
    const usage = session?.usage?.total;
    if (!usage || numericFields.some(field => !Number.isFinite(usage[field]))) return null;
    for (const field of numericFields) totals[field] += usage[field];
  }
  totals.uncachedInputTokens = totals.inputTokens - totals.cachedInputTokens;
  return totals;
}

async function runMission() {
  const { prepared, conditions, baseline } = await loadPrepared();
  const recordDir = prepared.record_dir;
  const runtimeProfilePath = join(packageRoot, 'dist', 'core', 'runtime-profile.js');
  const [
    { CodexMissionSession },
    { createCodexAppServerTransport },
    { codexMissionProgress },
    { terminateTree },
    { OperatorMissionRuntime },
    { V010_RUNTIME_PROFILE },
  ] = await Promise.all([
    import(pathToFileURL(join(packageRoot, 'dist', 'codex', 'mission-session.js'))),
    import(pathToFileURL(join(packageRoot, 'dist', 'codex', 'app-server.js'))),
    import(pathToFileURL(join(packageRoot, 'dist', 'cli', 'codex-mission.js'))),
    import(pathToFileURL(join(packageRoot, 'dist', 'core', 'worktree-commit-artifact.js'))),
    import(pathToFileURL(join(packageRoot, 'dist', 'core', 'operator-mission.js'))),
    import(pathToFileURL(runtimeProfilePath)),
  ]);
  const gitBefore = await gitSnapshot(recordDir, 'source-before');
  const lockPath = join(recordDir, 'run-once.lock');
  const lock = {
    one_shot: true,
    model_arms: 1,
    version: VERSION,
    attempt_id: prepared.attempt_id,
    package_sha256: conditions.source_package.sha256,
    release_commit: conditions.source_package.release_commit,
    runner_revision: conditions.runner.revision,
    runner_sha256: conditions.runner.sha256,
    anko_base: BASE_COMMIT,
    created_at: now(),
    old_trials_resumed: false,
    automatic_retry: false,
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
  const startedAt = Date.now();
  const status = {
    kind: 'Anko Mission',
    version: VERSION,
    attempt_id: prepared.attempt_id,
    started_at: new Date(startedAt).toISOString(),
    source_package_sha256: conditions.source_package.sha256,
    package_release_commit: conditions.source_package.release_commit,
    runner_revision: conditions.runner.revision,
    runner_sha256: conditions.runner.sha256,
    project: projectRoot,
    anko_base: BASE_COMMIT,
    prompt_sha256: TASK_SHA256,
    prompt_bytes: TASK_BYTES,
    execution: conditions.execution,
    permissions_override: null,
    native_sandbox_repaired: false,
    wall_limit_ms: WALL_LIMIT_MS,
    grading: 'none',
    model_turns_started: 0,
    host_commands: 0,
    host_commands_completed: 0,
    root: null,
    routes: {},
    accepted: false,
    native_status: null,
    root_turn_terminal: false,
    owned_tasks_settled: false,
    mission_accepted: false,
    mission_terminal: false,
    terminal: false,
    cost_usd: null,
    actual_billed_usd: null,
    billing: 'Native ChatGPT subscription usage; USD charge not observed; unknown is not zero',
    usage: null,
    baseline: { status: baseline.status, exit: baseline.exit, duration_ms: baseline.duration_ms },
    git_before: gitBefore,
  };
  const statusPath = join(recordDir, 'live-status.json');
  const save = () => writeJson(statusPath, { ...status, elapsed_ms: Date.now() - startedAt });
    const log = (file, value) => appendJsonl(join(recordDir, file), { at: now(), ...value });
  save();

  let adapter;
  const activeCommands = new Set();
  let timedOut = false;
  status.package_module_sha256 = conditions.extracted_package_files;
  status.package_runtime_profile_sha256 = conditions.extracted_package_files['dist/core/runtime-profile.js'];
  status.runtime_profile = V010_RUNTIME_PROFILE;
  save();

  const transportFactory = () => {
    const transport = createCodexAppServerTransport({ cwd: projectRoot, executable: CODEX_CLI_PATH });
    const pending = new Map();
    return {
      messages: (async function* () {
        for await (const message of transport.messages) {
          const method = pending.get(message.id);
          if (['thread/start', 'thread/resume'].includes(method) && message.result) {
            const result = message.result;
            log('native-routes.jsonl', {
              method,
              thread_id: result.thread?.id,
              model: result.model,
              effort: result.reasoningEffort,
              service_tier: result.serviceTier,
              sandbox: result.sandbox,
              approval_policy: result.approvalPolicy,
            });
          }
          if (message.method === 'turn/started') {
            status.model_turns_started++;
            log('native-routes.jsonl', { method: message.method, params: message.params });
            save();
          }
          yield message;
        }
      })(),
      send(message) {
        if (message.id != null && message.method) pending.set(message.id, message.method);
        if (message.method === 'turn/start') log('native-routes.jsonl', {
          method: message.method,
          thread_id: message.params.threadId,
          model: message.params.model,
          effort: message.params.effort,
          service_tier: message.params.serviceTier,
        });
        transport.send(message);
      },
      close: () => transport.close(),
    };
  };

    const executeCommand = async request => {
      if (request.signal.aborted) return { status: 'not-started', reason: 'Parent host execution already cancelled' };
      const id = ++status.host_commands;
      log('host-commands.jsonl', {
        id,
        phase: 'started',
        tool: request.tool,
        thread_id: request.threadId,
        turn_id: request.turnId,
        call_id: request.callId,
        command: request.command,
        cwd: request.cwd,
        timeout_ms: request.timeoutMs,
      });
      save();
      const running = new Promise(done => {
        let child;
        try {
          child = spawn(request.command[0], request.command.slice(1), {
            cwd: request.cwd,
            env: process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          const reason = error.stack ?? String(error);
          log('host-commands.jsonl', {
            id,
            phase: 'not-started',
            exit: null,
            signal: null,
            stdout: '',
            stderr: '',
            reason,
          });
          status.host_commands_completed++;
          save();
          done({ status: 'not-started', reason: error.message });
          return;
        }

        const stdout = [];
        const stderr = [];
        let interrupted = false;
        let spawnFailure;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => stdout.push(data));
        child.stderr.on('data', data => stderr.push(data));
        const exited = new Promise(resolve => child.once('exit', resolve));
        const stop = () => {
          if (interrupted) return;
          interrupted = true;
          void terminateTree(child, exited);
        };
        const timeout = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
          ? setTimeout(stop, request.timeoutMs)
          : null;
        request.signal.addEventListener('abort', stop, { once: true });
        child.once('error', error => { spawnFailure = error; });
        child.once('close', code => {
          if (timeout) clearTimeout(timeout);
          request.signal.removeEventListener('abort', stop);
          const out = stdout.join('');
          const err = stderr.join('');
          const result = interrupted
            ? { status: 'interrupted', reason: 'Parent host cancelled or timed out the owned process' }
            : spawnFailure
              ? { status: 'not-started', reason: spawnFailure.message }
              : code === null
                ? { status: 'unknown', reason: 'Owned process closed without an exit code' }
                : { status: 'completed', exitCode: code, stdout: out, stderr: err };
          log('host-commands.jsonl', {
            id,
            phase: result.status,
            exit: code,
            signal: child.signalCode,
            stdout: out,
            stderr: err,
            reason: result.reason,
          });
          status.host_commands_completed++;
          save();
          done(result);
        });
      });
      activeCommands.add(running);
      try {
        return await running;
      } finally {
        activeCommands.delete(running);
      }
    };

  const onEvent = event => {
    if (!status.root) status.root = event.threadId;
    if (event.method === 'sortie/modelRoute') status.routes[event.threadId] = event.params;
    if (event.method === 'turn/completed' && event.threadId === status.root) status.root_turn_terminal = true;
    if (event.method === 'sortie/modelRoute' && event.threadId === status.root) status.root_turn_terminal = false;
    status.last_event_at = now();
    if (!['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded'].includes(event.method)) {
      log('native-events.jsonl', event);
    }
    const progress = codexMissionProgress(event);
    if (progress) console.log(JSON.stringify(progress));
    save();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    status.timeout = true;
    void adapter?.close();
  }, WALL_LIMIT_MS);
  const cancel = () => {
    status.cancelled = true;
    void adapter?.close();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    adapter = await CodexMissionSession.create({ projectRoot, transportFactory, executeCommand, onEvent });
    const prompt = readFileSync(TASK_PATH);
    if (sha256(prompt) !== TASK_SHA256 || prompt.byteLength !== TASK_BYTES) fail('Original task changed before Mission submission');
    const result = await adapter.run(prompt.toString('utf8'));
    status.accepted = result.accepted === true;
    status.root = result.rootSessionID;
    status.native_status = result.turn?.status ?? null;
    status.root_turn_terminal = result.lifecycle?.root_turn_terminal ?? ['completed', 'failed', 'cancelled', 'interrupted'].includes(status.native_status);
    status.owned_tasks_settled = result.lifecycle?.owned_tasks_settled ?? false;
    status.mission_accepted = result.lifecycle?.mission_accepted ?? result.accepted === true;
    status.mission_terminal = ['completed', 'cancelled'].includes(result.lifecycle?.mission_phase);
    status.sessions = result.sessions ?? [];
    status.usage = cumulativeUsage(status.sessions);
    status.actual_billed_usd = null;
    status.cost_usd = null;
    writeJson(join(recordDir, 'result.json'), result);
    console.log(JSON.stringify({
      phase: 'benchmark-result',
      root: status.root,
      accepted: status.accepted,
      native_status: status.native_status,
      model_turns_started: status.model_turns_started,
    }));
    if (!status.accepted) process.exitCode = 1;
  } catch (error) {
    status.error = error.stack ?? String(error);
    status.accepted = false;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    try {
      await adapter?.close();
    } catch (error) {
      status.close_error = error.stack ?? String(error);
      process.exitCode = 1;
    }
    await Promise.allSettled([...activeCommands]);
    const commandLedger = hostCommandLedger(safeJsonl(join(recordDir, 'host-commands.jsonl')));
    const pendingHostCommands = commandLedger.pending.map(summarizeHostCommand);
    const commandReconciliation = {
      started_count: commandLedger.started.size,
      terminal_count: commandLedger.terminal.size,
      pending_count: pendingHostCommands.length,
      pending: pendingHostCommands,
      reconciled: pendingHostCommands.length === 0
        && commandLedger.started.size === commandLedger.terminal.size
        && status.host_commands === status.host_commands_completed,
    };
    status.command_drain_complete = activeCommands.size === 0 && commandReconciliation.reconciled;
    try {
      status.missions = await new OperatorMissionRuntime(projectRoot, V010_RUNTIME_PROFILE).current();
      status.mission_terminal = status.missions.some(item => item.root === status.root && ['completed', 'cancelled'].includes(item.phase));
    } catch (error) {
      status.mission_state_error = error.stack ?? String(error);
      status.missions = null;
      process.exitCode = 1;
    }
    try {
      status.git_after = await gitSnapshot(recordDir, 'source-after');
    } catch (error) {
      status.git_after_error = error.stack ?? String(error);
      process.exitCode = 1;
    }
    status.native_sandbox_repaired = false;
    status.recorder_terminal = true;
    status.terminal = true;
    status.timeout = timedOut || status.timeout === true;
    status.ended_at = now();
    status.elapsed_ms = Date.now() - startedAt;
    save();
    const hostCommands = safeJsonl(join(recordDir, 'host-commands.jsonl'));
    const validationCommands = validationCommandExecutions(hostCommands);
    writeJson(join(recordDir, 'quality.json'), {
      recovered_after_runner_exception: false,
      grading: 'none',
      official_hidden_grading: false,
      baseline: { status: baseline.status, exit: baseline.exit, duration_ms: baseline.duration_ms },
      validation_commands: validationCommands,
      repository_validation_passed: validationCommands.some(item =>
        item.terminal_phase === 'completed' && item.terminal_exit === 0),
      acceptance: { sdk_accepted: status.accepted, native_turn_status: status.native_status },
      source_git: status.git_after ?? null,
      note: 'SDK acceptance and repository validation are separate observations; no official Anko grader was run.',
    });
    const eventUsage = nativeEventUsage(recordDir);
    writeJson(join(recordDir, 'usage.json'), {
      recovered_after_runner_exception: false,
      sessions: status.sessions ?? null,
      cumulative_tokens: status.usage,
      native_event_usage_snapshot: eventUsage,
      estimated_usd: null,
      actual_billed_usd: null,
      priced_usd: null,
      interpretation: 'Native subscription usage is observed separately from metered USD charges; unknown is not zero.',
    });
    writeJson(join(recordDir, 'cleanup.json'), {
      recovered_after_runner_exception: false,
      ended_at: status.ended_at,
      adapter_close_error: status.close_error ?? null,
      command_drain_complete: commandReconciliation.reconciled,
      host_command_reconciliation: commandReconciliation,
      pending_host_commands: commandReconciliation.pending_count,
      shared_mission_snapshot: status.missions,
      mission_terminal: status.mission_terminal,
      native_status: status.native_status,
      model_wall_timeout: status.timeout,
    });
  }
}

async function verify() {
  const { prepared, conditions, baseline } = await loadPrepared({ allowRunnerHashChange: true });
  const recordDir = prepared.record_dir;
  const lockPath = join(recordDir, 'run-once.lock');
  if (!existsSync(lockPath)) fail('No one-shot lock exists; verify never starts a model arm');
  if (!existsSync(join(recordDir, 'live-status.json'))) fail('No terminal benchmark status was saved');
  const status = JSON.parse(readFileSync(join(recordDir, 'live-status.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const commands = safeJsonl(join(recordDir, 'host-commands.jsonl'));
  const routes = safeJsonl(join(recordDir, 'native-routes.jsonl'));
  const commandLedger = hostCommandLedger(commands);
  const validationCommands = validationCommandExecutions(commands);
  const completedValidation = validationCommands.filter(item => item.terminal_phase === 'completed');
  const formalValidation = completedValidation.find(item => item.terminal_exit === 0);
  const eventUsage = nativeEventUsage(recordDir);
  const recoveredRecords = recoverMissingRunArtifacts(recordDir, status, baseline, commands, eventUsage);
  const verificationRunner = {
    revision: await git(repoRoot, ['rev-parse', 'HEAD'], 'verification-runner-revision', recordDir),
    path: runnerPath,
    sha256: hashFile(runnerPath),
  };
  const derivedArtifacts = ['quality.json', 'usage.json', 'cleanup.json'];
  const derivedArtifactsSaved = derivedArtifacts.every(file => existsSync(join(recordDir, file)));
  const usageRecord = existsSync(join(recordDir, 'usage.json'))
    ? JSON.parse(readFileSync(join(recordDir, 'usage.json'), 'utf8'))
    : null;
  const workerRoute = routes.find(item => ['thread/start', 'turn/start'].includes(item.method)
    && item.model === 'gpt-6-luna' && item.effort === 'max' && item.service_tier === 'priority');
  const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  const fixedReceipt = packageReceipt();
  const globalApply = globalApplyReceipt();
  const sourceHeadAfter = status.git_after?.head ?? null;
  const checks = {
    fixed_package_sha256: hashFile(ARCHIVE_PATH) === PACKAGE_SHA256 && conditions.source_package.sha256 === PACKAGE_SHA256,
    global_apply_receipt_matches: fixedReceipt.sha256 === PACKAGE_SHA256 && fixedReceipt.source_commit === RELEASE_COMMIT
      && globalApply.package_sha256 === PACKAGE_SHA256 && globalApply.source_commit === RELEASE_COMMIT,
    release_commit_separate_from_runner: conditions.source_package.release_commit === RELEASE_COMMIT
      && conditions.runner.revision !== undefined && conditions.runner.sha256 !== PACKAGE_SHA256,
    extracted_version_matches: packageVersion === VERSION,
    v010_runtime_asset_marker_matches_release: conditions.package_metadata?.v010_runtime_asset_version === RUNTIME_MARKER,
    packaged_skill_marker_matches_receipt: conditions.package_metadata?.skill_marker_matches_package_receipt === true,
    original_task_unchanged: hashFile(TASK_PATH) === TASK_SHA256 && conditions.original_instruction.bytes === TASK_BYTES,
    pinned_anko_base_recorded: conditions.anko_base === BASE_COMMIT && baseline.source_commit_before === BASE_COMMIT,
    baseline_passed: baseline.status === 'passed' && baseline.exit === 0,
    one_shot_lock_matches: lock.one_shot === true && lock.model_arms === 1 && lock.automatic_retry === false
      && lock.attempt_id === prepared.attempt_id && lock.package_sha256 === PACKAGE_SHA256 && lock.anko_base === BASE_COMMIT,
    execution_runner_identity_fixed: lock.runner_revision === conditions.runner.revision
      && lock.runner_sha256 === conditions.runner.sha256
      && status.runner_revision === lock.runner_revision && status.runner_sha256 === lock.runner_sha256,
    terminal_record_saved: status.terminal === true && status.recorder_terminal === true,
    model_result_recorded_or_failure_explicit: status.accepted === true || Boolean(status.error) || status.native_status !== null,
    host_commands_reconciled: commandLedger.pending.length === 0
      && commandLedger.started.size === commandLedger.terminal.size
      && status.host_commands === status.host_commands_completed && status.command_drain_complete === true,
    mission_native_terminal_distinct: candidate
      ? status.mission_terminal === status.missions?.some(item => item.root === status.root && ['completed', 'cancelled'].includes(item.phase))
        && status.mission_accepted === status.accepted
      : status.mission_terminal === (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.native_status)),
    usage_and_usd_unknown_preserved: status.cost_usd === null && status.actual_billed_usd === null
      && usageRecord?.estimated_usd === null && usageRecord?.actual_billed_usd === null && usageRecord?.priced_usd === null,
    derived_run_artifacts_saved: derivedArtifactsSaved,
    no_official_grading: conditions.limits.grading === 'none' && status.grading === 'none',
    source_git_state_saved: typeof status.git_before?.head === 'string' && typeof sourceHeadAfter === 'string'
      && typeof status.git_after?.branch === 'string' && typeof status.git_after?.status === 'string',
    parent_host_executor_route_recorded: conditions.execution.includes('parent-host command executor'),
    worker_native_route_observed: workerRoute !== undefined,
    formal_validation_observed: completedValidation.length > 0,
  };
  const outcome = {
    schema_version: 1,
    verified_at: now(),
    attempt_id: prepared.attempt_id,
    version: VERSION,
    package_sha256: conditions.source_package.sha256,
    package_release_commit: conditions.source_package.release_commit,
    package_advisories: conditions.package_metadata?.skill_marker_matches_release_version === false
      ? [{
        kind: 'packaged-skill-marker-version-mismatch',
        expected_for_release: `${VERSION}-codex-skill-v2`,
        observed: conditions.package_metadata.skill_marker,
        sha256: conditions.package_metadata.skill_marker_sha256,
        matches_fixed_package_receipt: conditions.package_metadata.skill_marker_matches_package_receipt,
        interpretation: 'The exact fixed tarball contains this marker; package bytes were not changed. The Codex Mission runtime asset marker was checked separately.',
      }]
      : [],
    execution_runner: { revision: conditions.runner.revision, sha256: conditions.runner.sha256 },
    verification_runner: verificationRunner,
    baseline: { status: baseline.status, exit: baseline.exit, duration_ms: baseline.duration_ms },
    run: {
      accepted: status.accepted,
      native_status: status.native_status,
      mission_terminal: status.mission_terminal,
      root_turn_terminal: status.root_turn_terminal ?? null,
      owned_tasks_settled: status.owned_tasks_settled ?? null,
      mission_accepted: status.mission_accepted ?? null,
      recorder_terminal: status.recorder_terminal,
      elapsed_ms: status.elapsed_ms,
      model_turns_started: status.model_turns_started,
      host_commands: status.host_commands,
      worker_route: workerRoute ?? null,
      validation_commands: validationCommands,
      formal_validation: formalValidation ?? null,
      usage: status.usage,
      native_event_usage_snapshot: eventUsage,
      sdk_result_file_present: existsSync(join(recordDir, 'result.json')),
      estimated_usd: null,
      actual_billed_usd: null,
      final_head: sourceHeadAfter,
      final_branch: status.git_after?.branch ?? null,
      final_status: status.git_after?.status ?? null,
      remotes: status.git_after?.remotes ?? null,
      error: status.error ?? null,
    },
    artifact_recovery: recoveredRecords,
    checks,
    integrity_passed: Object.entries(checks).filter(([name]) => !['worker_native_route_observed', 'formal_validation_observed'].includes(name))
      .every(([, passed]) => passed),
    benchmark_accepted: status.accepted === true && status.native_status === 'completed',
    record_dir: recordDir,
    interpretation: 'Verification checks record integrity and observations, not Mission acceptance or official Anko grading.',
  };
  writeJson(join(recordDir, 'verification.json'), outcome);
  console.log(JSON.stringify(outcome, null, 2));
  if (!outcome.integrity_passed) process.exitCode = 1;
}

try {
  const action = parseArgs();
  if (action === 'prepare') await prepare();
  else if (action === 'baseline') await recoverBaseline();
  else if (action === 'run') await runMission();
  else await verify();
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
