import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { appendFile, chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { finished } from 'node:stream/promises';
import { READ_STALL_MS, MONITOR_INTERVAL_MS, WALL_LIMIT_MS, COST_LIMIT_USD, INSTRUCTION_SHA256,
  ANKO_BASE, CLI_VERSION, AGENT_ROUTES,
  ROOT_MODEL, WORKER_MODEL, noProgressStopReason, shouldStopForNoProgress, progressSignature } from './core.mjs';
import { expectSessionTurn, nativeTurnTerminal, observeSessionTurn, observeToolEvent,
  installObservationFiles, observeSessionState, safeNativeEvent, toolWaitObservations } from './observe.mjs';
import { eligibleReadPermission } from './recovery.mjs';
import { readOwnedUsage, usageSafetyStopReason } from './usage.mjs';
import { createObservationDeadline, recoverOwnedSessions } from './settle.mjs';
import { comparablePath, loadClient, goToolchain, npmCommand } from './host.mjs';

const runnerInvokedAt = Date.now();

assert.equal(process.argv.length, 2, 'run this arm only through scripts/anko-benchmark.mjs run --version X.Y.Z');
const packageVersion = process.env.ANKO_BENCHMARK_VERSION;
const output = process.env.ANKO_BENCHMARK_TRIAL_DIRECTORY;
const recordRoot = process.env.ANKO_BENCHMARK_RECORD_PATH;
assert(packageVersion && output && recordRoot, 'reusable runner launch context is incomplete');
const profile = JSON.parse(await readFile(join(output, 'profile.json'), 'utf8'));
const paths = profile.paths ?? (await import('./core.mjs')).HOST;
const { OpenCode } = await loadClient(paths);
const packageReceiptPath = process.env.ANKO_BENCHMARK_PACKAGE_RECEIPT;
const packageReceipt = JSON.parse(await readFile(packageReceiptPath, 'utf8'));
const candidatePackage = JSON.parse(await readFile(join(output, 'candidate-package.json'), 'utf8'));
const setupReceipt = { archive_sha256: candidatePackage.sha256 };
assert.equal(candidatePackage.version, packageVersion);
assert.equal(candidatePackage.sha256, process.env.ANKO_BENCHMARK_PACKAGE_SHA256);
assert.equal(packageReceipt.sha256, candidatePackage.sha256);
assert(!existsSync(join(output, 'data/opencode/opencode.db')));
assert(!existsSync(join(output, 'request.txt')));
assert(!existsSync(join(output, 'project/.sortie-dogs-v010')));
const attemptLockPath = join(output, 'run-attempt.lock');
if (existsSync(join(output, 'receipt.json')) || !existsSync(attemptLockPath))
  throw new Error('trial does not hold its exclusive one-shot launch record');
assert.equal(JSON.parse(await readFile(attemptLockPath, 'utf8')).benchmark_attempt, 1);
const sensitiveEnvironmentKeys = Object.keys(process.env).filter(name =>
  /(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|(?:^|_)TOKEN(?:_|$)|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH|NODE_OPTIONS|NODE_PATH|GIT_ASKPASS|SSH_AUTH_SOCK|SSH_AGENT_PID)/iu.test(name));
for (const name of sensitiveEnvironmentKeys) delete process.env[name];
process.env.HOME = output;
process.env.USERPROFILE = output;
process.env.APPDATA = join(output, 'appdata');
process.env.LOCALAPPDATA = join(output, 'localappdata');
await mkdir(join(output, 'tmp'), { recursive: true });
await Promise.all([mkdir(process.env.APPDATA, { recursive: true }), mkdir(process.env.LOCALAPPDATA, { recursive: true })]);
process.env.TMP = join(output, 'tmp');
process.env.TEMP = join(output, 'tmp');
process.env.TMPDIR = join(output, 'tmp');
const source = join(output, candidatePackage.archive_filename);
const goArchive = paths.go_archive;
const project = join(output, 'project');
const control = join(project, '.opencode');
const config = join(output, 'config');
const official = output;
const nativeGoDirectory = paths.go_directory;
const toolchain = goToolchain(paths, project);
const go = toolchain.executable;
const base = '3f269a72ff69398b1250c584171f32d12c0d8085';
const archiveSha = candidatePackage.sha256;
const archiveShasum = candidatePackage.shasum;
const archiveIntegrity = candidatePackage.integrity;
const goArchiveSha = '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445';
const instructionSha = '96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe';
const marker = candidatePackage.runtime_marker;
assert.equal(typeof marker, 'string', 'version-specific runtime marker is missing from package receipt');
const cli = profile.cli.path;
const driverClientPackage = paths.client_package;
const driverClientLockPath = paths.client_lock;
const hostDatabase = paths.host_database;
const cliDatabase = join(output, 'data/opencode/opencode.db');
const usageSnapshot = join(output, 'usage/opencode.db');
const hookLogPath = join(output, 'native-hook-events.jsonl');
const cliSha = profile.cli.sha256;
const clientLockSha = await hashFile(join(output, 'driver-client-package-lock.json'));
const expectedRootModel = ROOT_MODEL;
const expectedWorkerModel = WORKER_MODEL;
const cliVersion = CLI_VERSION;
const branchName = JSON.parse(await readFile(join(output, 'provenance.json'), 'utf8')).source.branch;
const expectedOfficial = { 'instruction.md': instructionSha };
const hash = data => createHash('sha256').update(data).digest('hex');
const sensitiveValues = [];
const rememberSensitiveValue = value => {
  if (typeof value === 'string' && value.length >= 8 && !sensitiveValues.includes(value)) sensitiveValues.push(value);
};
const redactSensitiveText = value => sensitiveValues.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value));
async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
const delay = ms => new Promise(done => setTimeout(done, ms));
const cmd = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options });
const gitRefExists = (cwd, ref) => {
  try { execFileSync('git', ['-C', cwd, 'show-ref', '--verify', '--quiet', ref], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const sha512Integrity = data => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const modelRoute = model => model?.providerID && (model.id || model.model)
  ? `${model.providerID}/${model.id ?? model.model}${model.variant ? `#${model.variant}` : ''}` : null;

function normalizePath(value) {
  return comparablePath(value);
}

function sanitizedPermission(request) {
  return { id: request.id, session_id: request.sessionID, action: request.action,
    resources: Array.isArray(request.resources) ? request.resources.map(String) : [],
    source: request.source?.type === 'tool' ? { type: 'tool', id: request.source.id } : request.source?.type ?? null };
}

function nativeObserver(client, output, project, rootSessionID) {
  const controller = new AbortController();
  const eventsPath = join(output, 'native-events.jsonl');
  const ownedSessionIDs = new Set([rootSessionID]);
  const tools = new Map();
  const terminalTools = new Set();
  const turns = new Map();
  const permissions = new Map();
  const progressEventTypes = new Set(['session.execution.started', 'session.execution.succeeded',
    'session.execution.failed', 'session.execution.interrupted', 'session.step.started', 'session.step.ended',
    'session.step.failed', 'session.text.started', 'session.text.delta', 'session.text.ended',
    'session.reasoning.started', 'session.reasoning.delta', 'session.reasoning.ended',
    'session.tool.input.started', 'session.tool.input.delta', 'session.tool.input.ended',
    'session.tool.called', 'session.tool.progress', 'session.tool.success', 'session.tool.failed',
    'session.usage.updated', 'session.usage.recorded', 'permission.asked', 'permission.replied', 'session.idle']);
  const state = { started_at: new Date().toISOString(), last_progress_at: Date.now(),
    last_progress_source: 'root-session-created', events_seen: 0, progress_event_count: 0, stream_error: null };
  const task = (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        const sessionID = data.sessionID;
        if (!sessionID) continue;
        const projectEvent = normalizePath(event.location?.directory) === normalizePath(project);
        if (!ownedSessionIDs.has(sessionID) && !projectEvent) continue;
        const key = `${sessionID}/${data.id ?? data.requestID ?? ''}`;
        const prior = tools.get(key);
        const safe = safeNativeEvent(event, data.name ?? prior?.name ?? null);
        safe.observed_at = new Date().toISOString();
        safe.ownership_basis = ownedSessionIDs.has(sessionID) ? 'native-session-owned-by-root' : 'isolated-project-awaiting-session-reconciliation';
        observeToolEvent(tools, terminalTools, safe);
        observeSessionTurn(turns, safe);
        await appendFile(eventsPath, `${JSON.stringify(safe)}\n`);
        state.events_seen += 1;
        if (event.type === 'permission.asked') permissions.set(data.id, safe);
        if (event.type === 'permission.replied') permissions.delete(data.requestID);
        if (progressEventTypes.has(event.type)) {
          state.last_progress_at = Date.now();
          state.last_progress_source = event.type;
          state.progress_event_count += 1;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) state.stream_error = String(error);
    }
  })();
  return { controller, task, ownedSessionIDs, tools, terminalTools, turns, permissions, state, eventsPath,
    async stop() {
      controller.abort();
      await Promise.race([task, delay(3_000)]);
    } };
}

async function capturePermissionSnapshots(client, sessionIDs, output) {
  const at = new Date().toISOString();
  const snapshots = await Promise.all([...new Set(sessionIDs)].sort().map(async sessionID => {
    try {
      const requests = await client.permission.list({ sessionID }, { signal: AbortSignal.timeout(2_000) });
      return { at, session_id: sessionID, status: 'observed', requests: requests.map(sanitizedPermission) };
    } catch (error) {
      return { at, session_id: sessionID, status: 'query-error', error: String(error), requests: [] };
    }
  }));
  if (snapshots.length) await appendFile(join(output, 'permission-snapshots.jsonl'),
    snapshots.map(snapshot => JSON.stringify(snapshot)).join('\n') + '\n');
  return snapshots;
}

async function readHookEvents(path, offset) {
  const text = await readFile(path, 'utf8').catch(error => error?.code === 'ENOENT' ? '' : Promise.reject(error));
  const lines = text.split(/\r?\n/u).filter(Boolean);
  return { count: lines.length, events: lines.slice(offset).map(line => JSON.parse(line)) };
}

function sourceProgressSignature(project) {
  const head = cmd('git', ['rev-parse', 'HEAD'], { cwd: project }).trim();
  const status = cmd('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: project });
  const diff = cmd('git', ['diff', 'HEAD', '--binary'], { cwd: project });
  const untracked = cmd('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: project })
    .split('\0').filter(Boolean).map(path => [path, hash(readFileSync(join(project, path)))]);
  return hash(JSON.stringify({ head, status, diff, untracked }));
}

async function readJsonLines(path) {
  const text = await readFile(path, 'utf8').catch(error => error?.code === 'ENOENT' ? '' : Promise.reject(error));
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function findLoadedRuntime(value, visited = new Set()) {
  if (typeof value === 'string') {
    try { return findLoadedRuntime(JSON.parse(value), visited); } catch {}
    const marker = /"runtime_asset_version"\s*:\s*"([^"]+)"/u.exec(value)?.[1];
    if (marker) return { runtime_asset_version: marker, evidence: 'serialized operator_status output' };
    return null;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return null;
  visited.add(value);
  const runtime = value.runtime && typeof value.runtime === 'object' ? value.runtime : value;
  if (typeof runtime.runtime_asset_version === 'string' || typeof runtime.runtime_marker === 'string') {
    return Object.fromEntries(['runtime_asset_version', 'runtime_marker', 'adapter_sha256', 'profiled_sha256',
      'implementation_sha256', 'loaded_at', 'pid', 'host_version'].filter(key => runtime[key] !== undefined)
      .map(key => [key, runtime[key]]));
  }
  for (const child of Object.values(value)) {
    const found = findLoadedRuntime(child, visited);
    if (found) return found;
  }
  return null;
}

async function installObserverPlugin() {
  const control = join(project, '.opencode');
  const configPath = join(control, 'opencode.json');
  await installObservationFiles(project);
  const configValue = JSON.parse(await readFile(configPath, 'utf8'));
  configValue.plugins ??= [];
  if (!configValue.plugins.includes('./plugins/anko-benchmark-observer'))
    configValue.plugins.push('./plugins/anko-benchmark-observer');
  await writeFile(configPath, `${JSON.stringify(configValue, null, 2)}\n`);
}

let stage = 'preflight';
let root = null;
let client = null;
let server = null;
const servers = [];
let promptSubmitted = false;
let promptSettled = false;
let promptError = null;
let promptPromise = null;
const promptController = new AbortController();
let terminal = false;
let benchmarkAccepted = false;
const reportedUsageGaps = new Set();
let stopReason = null;
let failure = null;
let started = null;
let stoppedAt = null;
let launch = null;
let lastUsage = null;
let worker = null;
let workerMismatch = false;
let host = null;
let inputHashes = null;
let runtimeInfo = null;
let estimateModelUsageCost = null;
let archiveHashObserved = null;
let credentialSeed = null;
let databaseSanitization = null;
let preflightSessionCount = null;
let npmPackageLockSha = null;
let goStdlibPackageCount = null;
let modelDiscovery = null;
let configuredAgents = [];
let interruptionResults = [];
let settlement = null;
let recoveredHistory = [];
let recoveredHistoryErrors = [];
const interruptedSessionIDs = new Set();
let native = null;
let hookEvents = [];
let hookEventCount = 0;
let permissionSnapshots = [];
const permissionReplies = new Set();
const executionPolicy = JSON.parse(await readFile(join(output, 'execution-policy.json'), 'utf8'));
let lastPermissionSnapshotAt = 0;
let lastProgressAt = null;
let lastProgressSignature = '';
let lastProgressSource = 'root-session-created';
let lastObservedNativeProgressCount = 0;
let lastObservedHookCount = 0;
let lastPermissionStateSignature = '[]';
let candidateSourceSignature = null;
let contextualRecoveryCount = 0;
let promptReplayCount = 0;
const runnerPath = fileURLToPath(import.meta.url);
const auditPath = join(output, 'verify.mjs');
const provenancePath = join(output, 'provenance.json');
let runnerCommit = null;
let runnerChanges = [];
let runnerSha = null;
let auditSha = null;
let provenanceSha = null;
const wallMs = WALL_LIMIT_MS;
const costCap = Number(process.env.ANKO_BENCHMARK_COST_LIMIT_USD ?? COST_LIMIT_USD);
assert(Number.isFinite(costCap) && costCap > 0 && costCap <= COST_LIMIT_USD);

async function startPrivateServer(env, logPrefix) {
  let password = randomBytes(24).toString('hex');
  // Same lifecycle as release-cli: the plugin's public-history fallback must
  // discover this exact private service, never the user's shared listener.
  const state = join(output, `${logPrefix}-service-state`);
  const registrationPath = join(state, 'opencode/service.json');
  await mkdir(state, { recursive: true });
  rememberSensitiveValue(password);
  rememberSensitiveValue(Buffer.from(`opencode:${password}`).toString('base64'));
  const stdoutPath = join(output, `${logPrefix}-server-stdout.log`);
  const stderrPath = join(output, `${logPrefix}-server-stderr.log`);
  const out = createWriteStream(stdoutPath);
  const err = createWriteStream(stderrPath);
  const child = spawn(cli, ['serve', '--service', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: project, env: { ...env, XDG_STATE_HOME: state, OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  let errors = '';
  let closed = false;
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  child.once('close', () => { closed = true; });
  child.stdout.on('data', data => { log = (log + data).slice(-8192); out.write(data); });
  child.stderr.on('data', data => { errors = (errors + data).slice(-8192); err.write(data); });
  const deadline = Date.now() + 45_000;
  while (!/http:\/\/127\.0\.0\.1:\d+/u.test(log) && !closed && !spawnError && Date.now() < deadline) await delay(100);
  const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(log)?.[0];
  const handle = {
    child, url, get closed() { return closed; }, errors: () => errors, spawnError,
    client: null,
    async stop() {
      if (!closed) {
        const closedPromise = new Promise(done => child.once('close', done));
        child.kill();
        await Promise.race([closedPromise, delay(10_000)]);
        if (!closed) {
          child.kill('SIGKILL');
          await Promise.race([new Promise(done => child.once('close', done)), delay(5_000)]);
        }
      }
      const flushed = Promise.all([finished(out), finished(err)]);
      out.end();
      err.end();
      await flushed;
      for (const path of [stdoutPath, stderrPath]) {
        const logText = await readFile(path, 'utf8');
        await writeFile(path, redactSensitiveText(logText));
      }
      if (closed) await rm(registrationPath, { force: true });
      return closed;
    },
  };
  servers.push(handle);
  if (!url) {
    await handle.stop();
    throw new Error(`V2 server ${logPrefix} startup failed: ${String(spawnError ?? errors)}`);
  }
  try {
    const registration = JSON.parse(await readFile(registrationPath, 'utf8'));
    assert.equal(registration.url, url, 'private service registration/listener mismatch');
    assert.equal(registration.pid, child.pid, 'private service registration/PID mismatch');
    // --service generates its own password; the registration is authoritative.
    password = registration.password;
    rememberSensitiveValue(password);
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    rememberSensitiveValue(authorization);
    handle.client = OpenCode.make({ baseUrl: url, headers: { Authorization: authorization } });
    const info = await handle.client.server.info({ signal: AbortSignal.timeout(10_000) });
    assert.equal(info.pid, child.pid, 'private service info/PID mismatch');
    await writeFile(join(output, `${logPrefix}-service-registration.json`), JSON.stringify({
      pid: info.pid, version: info.version, url, registered: true, isolated_state: state,
      password_retained: false, owning_history_endpoint: true,
    }, null, 2));
  } catch (error) {
    await handle.stop();
    throw error;
  }
  return handle;
}

async function seedOpenAICredential() {
  const sourceDb = new DatabaseSync(hostDatabase, { readOnly: true });
  let credential;
  try {
    credential = sourceDb.prepare('SELECT id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated FROM credential WHERE integration_id = ? ORDER BY time_updated DESC LIMIT 1').get('openai');
    assert(credential && JSON.parse(credential.value).type === 'oauth', 'OpenAI OAuth credential unavailable in host database');
    rememberSensitiveValue(credential.value);
    const credentialValue = JSON.parse(credential.value);
    for (const [key, value] of Object.entries(credentialValue)) {
      if (/(?:token|secret|key)/iu.test(key)) rememberSensitiveValue(value);
    }
  } finally { sourceDb.close(); }
  if (process.platform !== 'win32') {
    await chmod(dirname(cliDatabase), 0o700);
    await chmod(cliDatabase, 0o600);
  }
  const targetDb = new DatabaseSync(cliDatabase);
  try {
    const count = targetDb.prepare('SELECT COUNT(*) AS count FROM credential').get().count;
    assert.equal(count, 0, 'isolated V2 database was not empty before credential seeding');
    targetDb.prepare('INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      credential.id, credential.integration_id, credential.label, credential.value, credential.connector_id,
      credential.method_id, credential.active, credential.time_created, credential.time_updated);
  } finally { targetDb.close(); }
  return { provider: 'openai', credential_type: 'oauth', rows: 1, source_database_read_only: true,
    destination: 'isolated run database; no host session rows copied' };
}

async function sanitizeDatabase() {
  if (!existsSync(cliDatabase)) return { status: 'not-created', database_path: cliDatabase,
    database_retained: false, snapshot: null, credential_rows_removed: 0, credential_rows_remaining: 0,
    session_count: 0, session_message_count: 0, original_removed: false };
  if (servers.some(handle => !handle.closed))
    return { status: 'server-still-running', database_path: cliDatabase,
      database_retained: true, snapshot: null, credential_rows_remaining: null, original_removed: false };
  let credentialRowsRemoved = 0;
  let credentialsRemaining = null;
  let snapshotCredentialsRemaining = null;
  let sessions = null;
  let sessionMessages = null;
  try {
    await mkdir(dirname(usageSnapshot), { recursive: true, mode: 0o700 });
    const sourceDb = new DatabaseSync(cliDatabase);
    try {
      const hasCredential = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credential'").get();
      if (hasCredential) {
        sourceDb.exec('PRAGMA secure_delete=ON');
        const before = sourceDb.prepare('SELECT COUNT(*) AS count FROM credential').get().count;
        sourceDb.exec('DELETE FROM credential');
        sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        sourceDb.exec('VACUUM');
        const checkpoint = sourceDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint && checkpoint.busy !== 0) throw new Error(`credential cleanup WAL checkpoint busy: ${JSON.stringify(checkpoint)}`);
        credentialsRemaining = sourceDb.prepare('SELECT COUNT(*) AS count FROM credential').get().count;
        credentialRowsRemoved = before - credentialsRemaining;
      } else credentialsRemaining = 0;
      const hasSessions = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get();
      if (hasSessions) {
        sessions = sourceDb.prepare('SELECT COUNT(*) AS count FROM session_v2').get().count;
        const hasMessages = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_message'").get();
        if (hasMessages) sessionMessages = sourceDb.prepare('SELECT COUNT(*) AS count FROM session_message').get().count;
      }
      sourceDb.prepare('VACUUM INTO ?').run(usageSnapshot);
    }
    finally { sourceDb.close(); }
    if (process.platform !== 'win32') await chmod(usageSnapshot, 0o600);
    const snapshotDb = new DatabaseSync(usageSnapshot, { readOnly: true });
    try {
      const hasCredential = snapshotDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credential'").get();
      snapshotCredentialsRemaining = hasCredential
        ? snapshotDb.prepare('SELECT COUNT(*) AS count FROM credential').get().count : 0;
    } finally { snapshotDb.close(); }
  } catch (error) {
    const errorMessage = String(error);
    return { status: 'failed', error: errorMessage, database_path: cliDatabase,
      database_retained: existsSync(cliDatabase), snapshot: existsSync(usageSnapshot) ? usageSnapshot : null,
      credential_rows_removed: credentialRowsRemoved, credential_rows_remaining: credentialsRemaining,
      snapshot_credential_rows_remaining: snapshotCredentialsRemaining, session_count: sessions,
      session_message_count: sessionMessages, original_removed: false };
  }
  return { status: credentialsRemaining === 0 && snapshotCredentialsRemaining === 0 ? 'sanitized' : 'credential-remains',
    database_path: cliDatabase, database_retained: existsSync(cliDatabase),
    snapshot: existsSync(usageSnapshot) ? usageSnapshot : null,
    credential_rows_removed: credentialRowsRemoved, credential_rows_remaining: credentialsRemaining,
    snapshot_credential_rows_remaining: snapshotCredentialsRemaining, session_count: sessions,
    session_message_count: sessionMessages, original_removed: false };
}

function usage(rootId) {
  if (typeof estimateModelUsageCost !== 'function') throw new Error('model cost estimator unavailable');
  return readOwnedUsage(cliDatabase, rootId, estimateModelUsageCost);
}

async function persistFinal() {
  let mission = null;
  let operator = null;
  let history = [];
  let historyError = null;
  let finalUsage = lastUsage;
  let loadedRuntime = null;
  let nativeEventRecords = [];
  let nativeHookRecords = [];
  let permissionSnapshotRecords = [];
  if (root && client) {
    try {
      finalUsage = usage(root.id);
      history = recoveredHistory;
      if (recoveredHistoryErrors.length) historyError = JSON.stringify(recoveredHistoryErrors);
      await writeFile(join(output, 'native-history.json'), JSON.stringify(history, null, 2));
    } catch (error) { historyError = redactSensitiveText(error); }
    loadedRuntime = findLoadedRuntime(history);
    if (native) await native.stop().catch(error => { historyError ??= `native event observer stop: ${String(error)}`; });
    try { nativeEventRecords = await readJsonLines(join(output, 'native-events.jsonl')); }
    catch (error) { historyError ??= `native event read: ${String(error)}`; }
    try { nativeHookRecords = await readJsonLines(hookLogPath); }
    catch (error) { historyError ??= `native hook read: ${String(error)}`; }
    try { permissionSnapshotRecords = await readJsonLines(join(output, 'permission-snapshots.jsonl')); }
    catch (error) { historyError ??= `permission snapshot read: ${String(error)}`; }
    try { finalUsage ??= usage(root.id); } catch (error) { historyError ??= `usage: ${redactSensitiveText(error)}`; }
    const state = async area => readFile(join(project, '.sortie-dogs-v010', area, `${hash(root.id)}.json`), 'utf8')
      .then(JSON.parse).catch(() => null);
    mission = await state('missions');
    operator = await state('operators');
    if (mission) await writeFile(join(output, 'mission.json'), JSON.stringify(mission, null, 2));
    if (operator) await writeFile(join(output, 'operator.json'), JSON.stringify(operator, null, 2));
    const git = (args, options = {}) => cmd('git', args, { cwd: project, ...options }).trim();
    try {
      const changes = git(['status', '--porcelain=v1']).split(/\r?\n/u).filter(Boolean);
      const head = git(['rev-parse', 'HEAD']);
      const branch = git(['branch', '--show-current']);
      const commits = Number(git(['rev-list', '--count', `${base}..HEAD`]));
      runtimeInfo = { ...(runtimeInfo ?? {}), changes, head, branch, commits };
    } catch (error) { runtimeInfo = { ...(runtimeInfo ?? {}), git_error: String(error) }; }
    if (finalUsage) await writeFile(join(output, 'progress.json'), JSON.stringify({ at: new Date().toISOString(),
       elapsed_ms: started === null ? 0 : Date.now() - started, priced_usd: finalUsage.priced_usd,
       priced_messages: finalUsage.priced_messages, unpriced_messages: finalUsage.unpriced_messages,
       pending_messages: finalUsage.pending_messages, missing_token_messages: finalUsage.missing_token_messages,
       models: finalUsage.models,
       sessions: finalUsage.sessions, cap_usd: costCap, final: true,
       go_stdlib_package_count: goStdlibPackageCount, npm_package_lock_sha256: npmPackageLockSha,
      mission_phase: mission?.phase ?? null,
      review: mission?.review && { verdict: mission.review.verdict, child: mission.review.child },
      submission_status: mission?.submission?.status ?? null,
      operator_stage: operator?.phase ?? null, operator_decision: operator?.decision ?? null,
       native_receipt_status: operator?.receipt?.status ?? null, owned_sessions: finalUsage.sessions,
       native_progress_event_count: native?.state.progress_event_count ?? 0,
       native_event_count: nativeEventRecords.length, plugin_hook_event_count: nativeHookRecords.length,
       permission_snapshot_count: permissionSnapshotRecords.length, final: true }, null, 2));
  }
  const observedAt = new Date().toISOString();
  const nativeReceipt = operator?.receipt ?? null;
  const executionElapsed = started === null || stoppedAt === null ? 0 : stoppedAt - started;
   const accepted = stopReason === 'accepted' && nativeReceipt?.status === 'succeeded' &&
     nativeReceipt?.stop_reason === 'completed' && settlement?.native_settled === true;
   benchmarkAccepted = accepted;
  const eventTypes = Object.fromEntries([...new Set(nativeEventRecords.map(event => event.type))]
    .map(type => [type, nativeEventRecords.filter(event => event.type === type).length]));
  const readCalls = nativeEventRecords.filter(event => event.type === 'session.tool.called' && event.tool === 'read');
  const readHooks = nativeHookRecords.filter(event => event.tool === 'read');
  const pendingPermissionAtEnd = permissionSnapshotRecords.toReversed().find(item => item.status === 'observed')?.requests ?? [];
  const ownedSessions = (finalUsage?.sessions ?? []).map(item => ({ id: item.id, agent: item.agent,
    parent_id: item.parent_id ?? null, outcome: item.idle_outcome ?? null,
    time_idle: item.time_idle ?? null, native_terminal_observed: item.native_terminal_observed }));
  const observation = { ...(launch ?? {}), root: root?.id ?? null, observed_at: observedAt,
    prompt_submitted: promptSubmitted, prompt_settled: promptSettled, inference_observed: Boolean(finalUsage?.priced_messages || finalUsage?.unpriced_messages),
    elapsed_ms: started === null ? 0 : Date.now() - started,
     execution_elapsed_ms: executionElapsed,
     terminal, stop_reason: stopReason ?? (failure ? 'driver-error' : 'not-started'), failure,
     benchmark_attempts: 1, accepted,
      priced_usd: finalUsage?.priced_usd ?? null, priced_messages: finalUsage?.priced_messages ?? null,
      unpriced_messages: finalUsage?.unpriced_messages ?? null, pending_messages: finalUsage?.pending_messages ?? null,
      missing_token_messages: finalUsage?.missing_token_messages ?? null,
      recorded_cost_estimate_complete: finalUsage?.cost_estimate_complete ?? false,
      recorded_estimated_total_usd: finalUsage?.estimated_total_usd ?? null,
      cost_estimate_complete: settlement?.native_settled === true && finalUsage?.cost_estimate_complete === true,
      estimated_total_usd: settlement?.native_settled === true ? finalUsage?.estimated_total_usd ?? null : null,
      actual_billed_usd: null,
      usage_records: finalUsage?.records ?? [], settlement,
    user_interventions: 0,
    mission_phase: mission?.phase ?? null, plans: mission?.plans ?? null,
    coordinator: mission?.coordinator ?? null, progress: mission?.progress ?? [],
    submission: mission?.submission ?? null,
     review: mission?.review && { verdict: mission.review.verdict, child: mission.review.child },
     operator_stage: operator?.phase ?? null, operator_decision: operator?.decision ?? null,
     receipt: nativeReceipt,
     sessions: ownedSessions,
     inner_dispatch_count: Math.max(0, ownedSessions.filter(item => item.id !== root?.id).length),
     inner_dispatch_by_agent: Object.fromEntries([...new Set(ownedSessions.filter(item => item.id !== root?.id)
       .map(item => item.agent))].map(agent => [agent, ownedSessions.filter(item => item.agent === agent && item.id !== root?.id).length])),
      session_models: finalUsage?.sessions ?? [], model_usage: finalUsage?.models ?? {}, changes: runtimeInfo?.changes ?? null,
     head: runtimeInfo?.head ?? null, branch: runtimeInfo?.branch ?? null, commits: runtimeInfo?.commits ?? null,
     loaded_runtime: loadedRuntime,
     loaded_runtime_observation: loadedRuntime ? 'operator_status output in native session export' : 'not observed in native session export',
     native_event_stream: { status: native?.state.stream_error ? 'error' : nativeEventRecords.length ? 'observed' : 'no-events',
       events_seen: nativeEventRecords.length, progress_event_count: native?.state.progress_event_count ?? 0,
       error: native?.state.stream_error ?? null, types: eventTypes, file: 'native-events.jsonl' },
     native_tool_observations: { calls: readCalls, read_call_count: readCalls.length,
       plugin_hooks: readHooks, native_event_count: nativeEventRecords.filter(event => event.type.startsWith('session.tool.')).length },
     plugin_hook_observations: { event_count: nativeHookRecords.length,
       before_count: nativeHookRecords.filter(event => event.phase === 'plugin-hook-before').length,
       after_count: nativeHookRecords.filter(event => event.phase === 'plugin-hook-after').length,
       read_before_count: readHooks.filter(event => event.phase === 'plugin-hook-before').length,
       read_after_count: readHooks.filter(event => event.phase === 'plugin-hook-after').length,
       file: 'native-hook-events.jsonl' },
     permission_observations: { snapshot_count: permissionSnapshotRecords.length,
       query_error_count: permissionSnapshotRecords.filter(item => item.status === 'query-error').length,
       asked_event_count: nativeEventRecords.filter(event => event.type === 'permission.asked').length,
       replied_event_count: nativeEventRecords.filter(event => event.type === 'permission.replied').length,
       pending_at_end: pendingPermissionAtEnd, file: 'permission-snapshots.jsonl' },
     no_progress_timeout_ms: READ_STALL_MS, last_progress_at: lastProgressAt ? new Date(lastProgressAt).toISOString() : null,
     last_progress_source: lastProgressSource, active_session_status_counted_as_progress: false,
     contextual_recovery_count: contextualRecoveryCount, prompt_replay_count: promptReplayCount,
     no_progress_stop: existsSync(join(output, 'no-progress-stop.json'))
       ? JSON.parse(await readFile(join(output, 'no-progress-stop.json'), 'utf8')) : null,
      history_error: historyError, worker_observed: worker !== null, worker_model_mismatch: workerMismatch,
     failure_stage: failure ? stage : null, model_discovery: modelDiscovery, configured_agents: configuredAgents,
     interruption_results: interruptionResults };
    const receipt = { root: root?.id ?? null, package_version: packageVersion, archive_sha256: archiveHashObserved,
      npm_package_lock_sha256: npmPackageLockSha, go_stdlib_package_count: goStdlibPackageCount,
      runner_commit: runnerCommit, runner_sha256: runnerSha, audit_sha256: auditSha,
      candidate_base: base, instruction_sha256: instructionSha, request_sha256: existsSync(join(output, 'request.txt'))
        ? await hashFile(join(output, 'request.txt')) : null, started_at: launch?.at ?? null,
        ended_at: observedAt, execution_stop_reason: observation.stop_reason,
       benchmark_attempts: 1, execution_elapsed_ms: executionElapsed, accepted,
       native_stop_reason: nativeReceipt?.stop_reason ?? null, native_status: nativeReceipt?.status ?? null,
       no_progress_timeout_ms: READ_STALL_MS, contextual_recovery_count: contextualRecoveryCount,
       prompt_replay_count: promptReplayCount, loaded_runtime: loadedRuntime,
       native_event_count: nativeEventRecords.length, native_hook_event_count: nativeHookRecords.length,
       permission_snapshot_count: permissionSnapshotRecords.length,
       native_receipt: nativeReceipt, failure, credential_seed: credentialSeed,
      failure_stage: failure ? stage : null, model_discovery: modelDiscovery, configured_agents: configuredAgents,
      preflight_session_count: preflightSessionCount, interruption_results: interruptionResults,
       settlement, database_sanitization: databaseSanitization };
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await writeFile(join(output, 'observation.json'), JSON.stringify(observation, null, 2));
  if (failure) await writeFile(join(output, 'driver-error.txt'), `${redactSensitiveText(failure)}\n`);
  console.log(JSON.stringify({ phase: 'finished', root: root?.id ?? null,
    stop_reason: observation.stop_reason, terminal, priced_usd: observation.priced_usd,
    unpriced_messages: observation.unpriced_messages, worker_observed: observation.worker_observed,
    mission_phase: observation.mission_phase, native_status: observation.receipt?.status ?? null,
    head: observation.head, changes: observation.changes, failure }));
}

async function collectSettlement() {
  if (!root || !client) return;
  const observationDeadline = createObservationDeadline({ started: stoppedAt ?? Date.now(),
    wallDeadline: started === null ? Infinity : started + wallMs });
  const recovered = await recoverOwnedSessions({ readUsage: () => usage(root.id),
    observationDeadline,
    requested: interruptedSessionIDs,
    exportSession: (sessionID, signal) => client.session.export({ sessionID }, { signal }),
    observeSession: (sessionID, signal) => client.session.get({ sessionID }, { signal }),
    listPermissions: (sessionID, signal) => client.permission.list({ sessionID }, { signal }),
    activeTools: () => [...(native?.tools.values() ?? [])],
    isTerminal: session => nativeTurnTerminal(session, native?.turns),
    interrupt: (sessionID, signal) => client.session.interrupt({ sessionID }, { signal }),
    record: snapshot => appendFile(join(output, 'settlement-snapshots.jsonl'), JSON.stringify(snapshot) + '\n') });
  settlement = recovered.settlement;
  recoveredHistory = recovered.history;
  recoveredHistoryErrors = recovered.history_errors;
  interruptionResults.push(...(settlement.interruptions ?? []));
  lastUsage = settlement.usage ?? lastUsage;
  await writeFile(join(output, 'settlement.json'), JSON.stringify(settlement, null, 2));
}

try {
  await mkdir(config);
   const originalInstructionBytes = await readFile(paths.instruction);
   assert.deepEqual(await readFile(join(output, 'instruction.md')), originalInstructionBytes);
  runnerCommit = cmd('git', ['rev-parse', 'HEAD']).trim();
  runnerChanges = cmd('git', ['status', '--porcelain=v1']).split(/\r?\n/u).filter(Boolean);
  runnerSha = await hashFile(runnerPath);
  auditSha = await hashFile(auditPath);
  provenanceSha = await hashFile(provenancePath);
   const archiveHash = setupReceipt.archive_sha256;
  archiveHashObserved = archiveHash;
    assert.equal(archiveHash, archiveSha, `selected local ${packageVersion} candidate archive hash drift`);
   assert.equal(await hashFile(source), archiveSha);
  const pinned = JSON.parse(await readFile(provenancePath, 'utf8'));
  assert.equal(pinned.pins.anko_base, base, 'pinned Anko base drift');
  assert.equal(pinned.task_id, 'datacurve/anko-typed-variable-bindings');
    assert.equal(pinned.package?.source_archive, packageReceipt.archive_path);
    assert.equal(pinned.package?.local_archive, source);
  assert.equal(pinned.package?.version, packageVersion, 'provenance package version mismatch');
  assert.equal(pinned.package?.shasum, archiveShasum, 'provenance archive SHA-1 mismatch');
  assert.equal(pinned.package?.sha256, archiveSha, 'provenance package hash mismatch');
  assert.equal(pinned.package?.integrity, archiveIntegrity, 'provenance npm integrity mismatch');
  assert.equal(pinned.package?.runtime_marker, marker, 'provenance runtime marker mismatch');
  assert.equal(pinned.opencode?.version, cliVersion, 'provenance CLI version mismatch');
  assert.equal(pinned.opencode?.cli_sha256, cliSha, 'provenance CLI hash mismatch');
  assert.equal(process.version, pinned.toolchain?.node_version, 'Node version drift');
  const npm = npmCommand(['--version']);
  const npmVersion = cmd(npm.file, npm.args).trim();
  assert.equal(npmVersion, pinned.toolchain?.npm_version, 'npm version drift');
  assert.equal(process.platform, pinned.toolchain?.runner_platform, 'runner platform drift');
  assert.equal(pinned.go?.version, 'go version go1.27.1 linux/amd64', 'provenance Go version mismatch');
  assert.equal(await hashFile(join(project, '.gopath/bin/goyacc')), pinned.go.generator.sha256);
  assert.equal(await hashFile(goArchive), goArchiveSha, 'Go archive hash mismatch');
  const driverClient = JSON.parse(await readFile(driverClientPackage, 'utf8'));
  assert.equal(driverClient.version, '2.0.18', 'driver @opencode/client version mismatch');
  assert.equal(await hashFile(driverClientLockPath), pinned.driver_client?.package_lock_sha256,
    'driver @opencode/client lockfile drift');
  assert.equal(await hashFile(driverClientLockPath), clientLockSha, 'driver @opencode/client lockfile changed');
  assert.deepEqual(await readFile(join(output, 'driver-client-package.json')), await readFile(driverClientPackage));
  assert.deepEqual(await readFile(join(output, 'driver-client-package-lock.json')), await readFile(driverClientLockPath));
  assert.equal(pinned.limits?.max_attempts, 1, 'provenance attempt limit mismatch');
  assert.equal(pinned.limits?.max_wall_minutes, 60, 'provenance wall limit mismatch');
  assert.equal(pinned.limits?.max_priced_usd, costCap, 'provenance cost limit mismatch');
  assert.equal(pinned.limits?.grading, 'none', 'provenance grading condition mismatch');
   assert.equal(await hashFile(runnerPath), pinned.runner?.sha256, 'pinned runner hash mismatch');
   for (const [name, digest] of Object.entries(pinned.runner.module_sha256 ?? {}))
     assert.equal(await hashFile(join(output, name)), digest, `pinned runner module changed: ${name}`);
  assert.equal(runnerCommit, pinned.runner?.git_commit, 'pinned runner git revision mismatch');
  assert.equal(await hashFile(auditPath), pinned.verifier?.sha256, 'pinned verifier hash mismatch');
  inputHashes = {};
  for (const [name, expected] of Object.entries(expectedOfficial).filter(([name]) => name === 'instruction.md')) {
    const actual = hash(await readFile(join(official, name)));
    assert.equal(actual, expected, `official input changed: ${name}`);
    assert.equal(pinned.official_sha256[name], expected, `pinned manifest mismatch: ${name}`);
    inputHashes[name] = actual;
  }
  const instructionBytes = await readFile(join(official, 'instruction.md'));
  assert.equal(hash(instructionBytes), instructionSha);
  assert.deepEqual(instructionBytes, originalInstructionBytes, 'original task instruction changed during preflight');
  const instruction = instructionBytes.toString('utf8');
    await writeFile(join(output, 'package-SHA256SUMS'), `${archiveSha}  ${candidatePackage.archive_filename}\n`);

   stage = 'reuse-prepared-clone';
   assert.equal(cmd('git', ['rev-parse', 'HEAD'], { cwd: project }).trim(), base);
   assert.equal(cmd('git', ['rev-parse', 'main'], { cwd: project }).trim(), base);
   assert.equal(cmd('git', ['status', '--porcelain=v1'], { cwd: project }).trim(), '');
   assert.equal(cmd('git', ['remote'], { cwd: project }).trim(), '');

  stage = 'install';
  await mkdir(dirname(cliDatabase), { recursive: true, mode: 0o700 });
  await mkdir(join(output, 'cache'), { recursive: true, mode: 0o700 });
  await mkdir(join(output, 'tmp'), { recursive: true, mode: 0o700 });
  const env = { ...process.env, XDG_CONFIG_HOME: output, OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG: join(config, 'opencode.json'), NPM_CONFIG_CACHE: join(output, 'npm-cache'),
    XDG_DATA_HOME: join(output, 'data'), XDG_CACHE_HOME: join(output, 'cache'), OPENCODE_DB: cliDatabase,
    ANKO_BENCHMARK_HOOK_LOG: hookLogPath,
    TMP: join(output, 'tmp'), TEMP: join(output, 'tmp'), TMPDIR: join(output, 'tmp') };
  if (process.platform !== 'win32') {
    Object.assign(env, toolchain.variables);
    env.PATH = [dirname(cli), dirname(process.execPath), join(nativeGoDirectory, 'bin'),
      join(project, '.gopath/bin'), env.PATH].join(':');
  }
  await writeFile(env.OPENCODE_CONFIG, '{}\n');
  env.NPM_CONFIG_USERCONFIG = join(config, 'npmrc');
  env.NPM_CONFIG_GLOBALCONFIG = join(config, 'npm-globalrc');
  env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
  await writeFile(env.NPM_CONFIG_USERCONFIG, '\n');
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '\n');
   // Reuse the successful isolated installation; do not repeat npm install/init.
   npmPackageLockSha = await hashFile(join(control, 'package-lock.json'));
   await cp(join(control, 'package-lock.json'), join(output, 'npm-package-lock.json'), { force: false, errorOnExist: true });
   const installedPackageLock = JSON.parse(await readFile(join(control, 'package-lock.json'), 'utf8'));
   assert.equal(installedPackageLock.packages['node_modules/sortie-dogs'].version, packageVersion);
   assert.equal(installedPackageLock.packages['node_modules/sortie-dogs'].integrity, archiveIntegrity);
   const installed = join(control, 'node_modules/sortie-dogs');
   assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, packageVersion);
  const assetVersion = await import(pathToFileURL(join(installed, 'dist/asset-version.js')).href);
  assert.equal(assetVersion.V010_RUNTIME_ASSET_VERSION, marker);
  const costModule = await import(pathToFileURL(join(installed, 'dist/plugin/model-cost.js')).href);
  estimateModelUsageCost = costModule.estimateModelUsageCost;
   assert.equal((await readFile(join(control, 'sortie-dogs-v010.version'), 'utf8')).trim(), marker);
    await cp(join(control, 'opencode.json'), join(output, 'isolated-opencode.json'), { force: false, errorOnExist: true });
  await Promise.all(['.gocache', '.gomodcache', '.gopath', '.tmp'].map(name =>
    mkdir(join(project, name), { recursive: true })));
    assert(existsSync(join(nativeGoDirectory, 'bin/go')), 'saved Go installation is missing');
   goStdlibPackageCount = profile.go?.stdlib_package_count ?? null;

  stage = 'database-init';
  const preflight = await startPrivateServer(env, 'preflight');
  host = await preflight.client.server.info();
  assert.equal(host.version, '2.0.18');
  preflightSessionCount = (await preflight.client.session.list({ directory: project, limit: 100 })).data?.length ?? 0;
  assert.equal(preflightSessionCount, 0, 'database-only preflight created a session');
  assert(await preflight.stop(), 'database-only preflight server did not stop');
  credentialSeed = await seedOpenAICredential();

  stage = 'server';
  await installObserverPlugin();
  server = await startPrivateServer(env, 'server');
  client = server.client;
  host = await client.server.info();
  assert.equal(host.version, '2.0.18');
  let plugins = [];
  for (let i = 0; i < 100; i += 1) {
    plugins = (await client.plugin.list({ location: { directory: project } })).data ?? [];
    if (plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active')) break;
    await delay(100);
  }
  assert(plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active'),
      `Sortie v010 plugin did not become active: ${JSON.stringify(plugins)}`);
  assert(plugins.some(item => /anko-benchmark-observer/u.test(item.id) && item.state.status === 'active'),
    `Anko native observer plugin did not become active: ${JSON.stringify(plugins)}`);

   stage = 'model-routing-preflight';
   let catalog = [];
   const catalogueDeadline = Date.now() + 45_000;
   do {
     catalog = (await client.model.list({ location: { directory: project } },
       { signal: AbortSignal.timeout(10_000) })).data ?? [];
     if (['gpt-6.1-sol', 'gpt-6-luna-fast'].every(id => catalog.some(item => item.providerID === 'openai' && item.id === id))) break;
     await delay(500);
   } while (Date.now() < catalogueDeadline);
   const wantedModels = [
     { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'xhigh' },
     { providerID: 'openai', modelID: 'gpt-6-luna-fast', variant: 'max' },
   ];
   const available = wantedModels.map(wanted => {
      const found = catalog.find(item => item.providerID === wanted.providerID && item.id === wanted.modelID);
      return { ...wanted, selectable_id: found?.id ?? null, api_model_id: found?.modelID ?? null,
        body: found?.body ?? null, available: Boolean(found), variants: (found?.variants ?? []).map(item => item.id) };
   });
   modelDiscovery = { at: new Date().toISOString(), source: 'isolated OpenCode V2 model.list', models: available };
   await writeFile(join(output, 'model-discovery.json'), JSON.stringify(modelDiscovery, null, 2));
   for (const wanted of wantedModels) {
     const found = available.find(item => item.providerID === wanted.providerID && item.modelID === wanted.modelID);
     assert(found?.available && found.variants.includes(wanted.variant),
       `required model route is unavailable: ${wanted.providerID}/${wanted.modelID}#${wanted.variant}`);
   }
    const agentList = (await client.agent.list({ location: { directory: project } },
      { signal: AbortSignal.timeout(30_000) })).data ?? [];
    configuredAgents = agentList.map(item => ({ id: item.id, mode: item.mode, configured_model: modelRoute(item.model) }));
    await writeFile(join(output, 'configured-agents.json'), JSON.stringify(configuredAgents, null, 2));
     for (const [agentID, expectedRoute] of Object.entries(AGENT_ROUTES)) {
      const configured = configuredAgents.find(item => item.id === agentID);
      assert(configured, `required configured agent is unavailable: ${agentID}`);
      assert.equal(configured.configured_model, expectedRoute,
        `required configured model route mismatch for ${agentID}`);
    }

  stage = 'session';
  started = Date.now();
  root = await client.session.create({ title: `${packageVersion} Anko型付き変数の新規単一arm`, agent: 'dog-operator',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'xhigh' }, location: { directory: project } });
  native = nativeObserver(client, output, project, root.id);
  lastProgressAt = started;
  candidateSourceSignature = sourceProgressSignature(project);
   launch = { root: root.id, project, commit: base, archive_sha256: archiveHash,
      package_source: candidatePackage.source_kind,
      package_source_commit: candidatePackage.source_commit, package_patch_sha256: candidatePackage.patch_sha256,
     node_version: process.version, runner_platform: process.platform,
     driver_client_package: '@opencode/client', driver_client_version: driverClient.version,
     instruction_sha256: hash(instruction), official_sha256: inputHashes, provenance_sha256: provenanceSha,
     host, marker, package_version: packageVersion, package_integrity: archiveIntegrity,
     model_discovery: modelDiscovery, configured_agents: configuredAgents,
      go_archive_sha256: goArchiveSha, at: new Date(started).toISOString(),
      max_attempts: 1, max_wall_minutes: 60, max_priced_usd: costCap, model_route: expectedRootModel,
      no_progress_timeout_ms: READ_STALL_MS, active_session_status_is_progress: false,
      permission_response_policy: executionPolicy,
      max_contextual_recovery_prompts: 1, prompt_replay_on_no_progress: false,
      observer_plugin: 'anko-benchmark-observer',
      root_model_observed: modelRoute(root.model),
     expected_sol_model: expectedRootModel, expected_worker_model: expectedWorkerModel,
     runner: 'isolated OpenCode V2 CLI (not Desktop)',
    cli_path: cli, cli_sha256: cliSha, database_path: cliDatabase, usage_snapshot_path: usageSnapshot,
     database_isolation: true, credential_seed: credentialSeed, preflight_session_count: preflightSessionCount,
     environment_sanitization: { sensitive_variable_names_removed: sensitiveEnvironmentKeys.length,
       home_and_user_config_isolated: true },
      go_version: pinned.go.version, go_stdlib_package_count: goStdlibPackageCount,
      node_version: process.version, npm_version: npmVersion,
      validation_command: toolchain.validation_command,
     go_path: go, npm_package_lock_sha256: npmPackageLockSha, package_path: installed, runner_commit: runnerCommit,
    runner_worktree_paths: runnerChanges, runner_sha256: runnerSha, audit_sha256: auditSha,
    branch: branchName, official_scoring: false };
   await writeFile(join(output, 'launch.json'), JSON.stringify(launch, null, 2));
   stage = 'root-model-preflight';
   assert.equal(launch.root_model_observed, expectedRootModel, 'root session model route drift before prompt submission');
  console.log(JSON.stringify({ phase: 'launched', root: root.id, at: launch.at,
     package_version: launch.package_version, package_sha256: launch.archive_sha256,
    model_route: launch.model_route, worker_model_expected: launch.expected_worker_model,
    wall_cap_minutes: launch.max_wall_minutes, priced_cost_cap_usd: launch.max_priced_usd,
    go_stdlib_package_count: goStdlibPackageCount }));

    stage = 'execution';
    const applicableAgentsText = await readFile(join(output, 'applicable-AGENTS.md'), 'utf8');
    assert.equal(hash(Buffer.from(applicableAgentsText)), profile.applicable_agents_sha256,
      'applicable AGENTS.md context differs from the fixed profile');
     const prompt = `この一件のAnko typed-variable-bindings実装を、完了まで自律的に進めて。チャット・Task・引継ぎ・報告は日本語。開始時にsortie_v010_operator_statusで実loaded runtimeのmarker/hashを記録して。base commit ${base} を固定し、新しい隔離branchを作成済み。必要な調査・実装・局所テスト・再修正・レビュー・commit・native Mission受理receiptまで進めて。品質未達なら同じMissionへ具体的に差し戻し、通常の要求内継続をユーザーに要求しない。作業repo root: ${project}。patchはこのroot基準の相対pathを使い、読取結果のpathを引き継いで別repoと取り違えない。公式hidden grader、公式採点、追加スコアリングは実行・参照・変更しない。Anko上流へのPR・push、Sortie-dogs変更、公開・リリースは課題外。実行環境: ${toolchain.environment_description}。正式検証コマンド: ${toolchain.validation_command}。以下は事前読込済みの適用AGENTS.md (SHA-256 ${profile.applicable_agents_sha256})。同じ内容を取得するだけの再readは不要。候補repo固有の適用指示は通常どおり読む。\n\n--- 適用済みAGENTS.md ---\n${applicableAgentsText}\n--- AGENTS.mdここまで ---\n\nユーザーの課題文（以下、逐語）:\n\n${instruction}`;
   await writeFile(join(output, 'request.txt'), prompt);
  promptSubmitted = true;
   promptPromise = client.session.prompt({ sessionID: root.id, text: prompt, delivery: 'queue', resume: true },
     { signal: promptController.signal }).then(
     () => { promptSettled = true; }, error => { promptSettled = true; promptError = redactSensitiveText(error); });
    let workerWritten = false;
    let lastLiveLogAt = started;
    let hookLineOffset = 0;
    let recoveryPending = false;
    while (Date.now() - started < wallMs) {
      const iterationAt = Date.now();
      lastUsage = usage(root.id);
      for (const session of lastUsage.sessions) native.ownedSessionIDs.add(session.id);
      const observedWorker = lastUsage.sessions.find(item => item.agent === 'dog-worker-v010');
      if (observedWorker && (observedWorker.configured_model && observedWorker.configured_model !== expectedWorkerModel ||
        observedWorker.observed_models.some(route => route !== expectedWorkerModel))) workerMismatch = true;
      if (observedWorker?.observed_models.length && !workerWritten) {
        worker = { at: new Date().toISOString(), ...observedWorker };
        await writeFile(join(output, 'worker-start.json'), JSON.stringify(worker, null, 2));
        console.log(JSON.stringify({ phase: 'worker-observed', ...worker }));
        workerWritten = true;
      }
      const wrongSolRoute = lastUsage.records.filter(item => item.message_type === 'assistant').map(item => item.model).find(route =>
        /\/[^/]*sol(?:#|$)/iu.test(route) && route !== expectedRootModel);
      const rootSession = lastUsage.sessions.find(item => item.id === root.id);
      const wrongRootRoute = rootSession?.configured_model && rootSession.configured_model !== expectedRootModel;
      if (workerMismatch) { stopReason = 'worker-model-mismatch'; break; }
      if (wrongSolRoute || wrongRootRoute) { stopReason = 'sol-model-mismatch'; break; }
      if (promptError) { failure = promptError; stopReason = 'session-prompt-error'; break; }
      if (lastUsage.priced_usd >= costCap) { stopReason = 'priced-cost-cap'; break; }
        for (const gap of lastUsage.records.filter(record => record.status === 'missing-terminal-usage')) {
          if (reportedUsageGaps.has(gap.id)) continue;
          reportedUsageGaps.add(gap.id);
          const warning = { phase: 'usage-accounting-gap', at: new Date().toISOString(), record: gap,
            known_priced_subtotal_usd: lastUsage.priced_usd, estimated_total_usd: null,
            action: 'retain unknown cost; leave native retry to the host; keep wall/no-progress/known-price limits' };
          await appendFile(join(output, 'usage-gap-events.jsonl'), `${JSON.stringify(warning)}\n`);
          console.log(JSON.stringify(warning));
        }
        if (usageSafetyStopReason(lastUsage)) {
         stopReason = usageSafetyStopReason(lastUsage);
         await writeFile(join(output, 'usage-safety-stop.json'), JSON.stringify({ at: new Date().toISOString(),
           elapsed_ms: Date.now() - started, stop_reason: stopReason, usage: lastUsage,
           observer_stream_error: native.state.stream_error, original_prompt_replayed: false }, null, 2));
         break;
       }

      const state = await observeSessionState(
        () => client.session.get({ sessionID: root.id }, { signal: AbortSignal.timeout(10_000) }),
        observation => appendFile(join(output, 'session-observation-errors.jsonl'), JSON.stringify({
          at: new Date().toISOString(), session_id: root.id, ...observation,
        }) + '\n'));
      const statePath = area => join(project, '.sortie-dogs-v010', area, `${hash(root.id)}.json`);
      const liveMission = await readFile(statePath('missions'), 'utf8').then(JSON.parse).catch(() => null);
      const liveOperator = await readFile(statePath('operators'), 'utf8').then(JSON.parse).catch(() => null);
      const priorCandidateSourceSignature = candidateSourceSignature;
      const hookBatch = await readHookEvents(hookLogPath, hookLineOffset);
      hookLineOffset = hookBatch.count;
      if (hookBatch.events.length) {
        hookEvents.push(...hookBatch.events);
        for (const event of hookBatch.events) {
          observeToolEvent(native.tools, native.terminalTools, event);
        }
      }
      if (iterationAt - lastPermissionSnapshotAt >= MONITOR_INTERVAL_MS) {
        permissionSnapshots = await capturePermissionSnapshots(client, lastUsage.sessions.map(item => item.id), output);
        lastPermissionSnapshotAt = Date.now();
      }
      candidateSourceSignature = sourceProgressSignature(project);
      const pendingPermissions = new Map();
      for (const request of native.permissions.values()) pendingPermissions.set(request.id, request);
      for (const snapshot of permissionSnapshots) for (const request of snapshot.requests)
        pendingPermissions.set(request.id, { ...request, observed_via: 'permission.list' });
      const pendingPermissionList = [...pendingPermissions.values()];
      for (const request of pendingPermissionList) {
        if (permissionReplies.has(request.id)) continue;
        const key = `${request.session_id ?? request.sessionID}/${request.source?.id ?? ''}`;
        if (!eligibleReadPermission(request, native.tools.get(key), executionPolicy, native.ownedSessionIDs)) continue;
        assert.equal(await hashFile(executionPolicy.applicable_agents_path), executionPolicy.applicable_agents_sha256);
        permissionReplies.add(request.id);
        await appendFile(join(output, 'permission-recovery.jsonl'), JSON.stringify({ at: new Date().toISOString(),
          request_id: request.id, session_id: request.session_id ?? request.sessionID, action: request.action,
          call_id: request.source.id, path: executionPolicy.applicable_agents_path, decision: 'once',
          file_sha256: executionPolicy.applicable_agents_sha256 }) + '\n');
        await client.permission.reply({ sessionID: request.session_id ?? request.sessionID, requestID: request.id,
          decision: 'once' }, { signal: AbortSignal.timeout(5_000) });
      }
      const permissionStateSignature = JSON.stringify(pendingPermissionList.map(item => ({ id: item.id,
        session_id: item.session_id, action: item.action, resources: item.resources }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))));
      const activeTools = [...native.tools.values()].map(tool => ({ ...tool,
        elapsed_ms: Date.now() - tool.started_at, no_progress_ms: Date.now() - tool.last_progress_at }));
      const stateSignature = progressSignature({
        priced_usd: lastUsage.priced_usd, priced_messages: lastUsage.priced_messages,
        unpriced_messages: lastUsage.unpriced_messages, mission_phase: liveMission?.phase ?? null,
        review: liveMission?.review && { verdict: liveMission.review.verdict, child: liveMission.review.child },
        submission_status: liveMission?.submission?.status ?? null, operator_stage: liveOperator?.phase ?? null,
        operator_decision: liveOperator?.decision ?? null, native_receipt_status: liveOperator?.receipt?.status ?? null,
        native_progress_event_count: native.state.progress_event_count, plugin_hook_event_count: hookLineOffset,
        candidate_source_signature: candidateSourceSignature,
        permission_state: pendingPermissionList.map(item => ({ id: item.id, session_id: item.session_id,
          action: item.action, resources: item.resources })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
        owned_sessions: lastUsage.sessions,
      });
      const stateChanged = stateSignature !== lastProgressSignature;
      if (stateChanged) {
        lastProgressAt = Date.now();
        lastProgressSignature = stateSignature;
        lastProgressSource = native.state.progress_event_count > lastObservedNativeProgressCount
          ? native.state.last_progress_source
          : hookLineOffset > lastObservedHookCount ? 'plugin-hook-boundary'
            : permissionStateSignature !== lastPermissionStateSignature ? 'permission-request-state-change'
              : candidateSourceSignature !== priorCandidateSourceSignature ? 'candidate-source-change'
                : 'usage/mission/session-state-change';
        lastObservedNativeProgressCount = native.state.progress_event_count;
        lastObservedHookCount = hookLineOffset;
        lastPermissionStateSignature = permissionStateSignature;
      }
      if (native.state.last_progress_at > lastProgressAt) {
        lastProgressAt = native.state.last_progress_at;
        lastProgressSource = native.state.last_progress_source;
      }
      const progress = { at: new Date().toISOString(), elapsed_ms: Date.now() - started,
        priced_usd: lastUsage.priced_usd, priced_messages: lastUsage.priced_messages,
        unpriced_messages: lastUsage.unpriced_messages, pending_messages: lastUsage.pending_messages,
        missing_token_messages: lastUsage.missing_token_messages, models: lastUsage.models,
        sessions: lastUsage.sessions, cap_usd: costCap, go_stdlib_package_count: goStdlibPackageCount,
        npm_package_lock_sha256: npmPackageLockSha, native_root_outcome: state.outcome ?? null,
        native_root_idle: Boolean(state.time?.idle), mission_phase: liveMission?.phase ?? null,
        review: liveMission?.review && { verdict: liveMission.review.verdict, child: liveMission.review.child },
        submission_status: liveMission?.submission?.status ?? null, operator_stage: liveOperator?.phase ?? null,
        operator_decision: liveOperator?.decision ?? null, native_receipt_status: liveOperator?.receipt?.status ?? null,
        native_receipt_stop_reason: liveOperator?.receipt?.stop_reason ?? null,
        owned_sessions: lastUsage.sessions.map(item => ({ id: item.id, agent: item.agent,
          parent_id: item.parent_id, configured_model: item.configured_model, observed_models: item.observed_models,
          outcome: item.idle_outcome, time_idle: item.time_idle })),
        active_session_status_is_progress: false,
        last_progress_at: lastProgressAt ? new Date(lastProgressAt).toISOString() : null,
        last_progress_source: lastProgressSource,
        no_progress_ms: lastProgressAt === null ? null : Date.now() - lastProgressAt,
        no_progress_timeout_ms: READ_STALL_MS, active_native_tools: activeTools,
        pending_permission_requests: pendingPermissionList,
        permission_poll_status: permissionSnapshots.map(snapshot => ({ session_id: snapshot.session_id, status: snapshot.status })),
        native_event_count: native.state.events_seen, native_progress_event_count: native.state.progress_event_count,
        native_event_stream_error: native.state.stream_error, plugin_hook_event_count: hookLineOffset,
        candidate_source_signature: candidateSourceSignature, contextual_recovery_count: contextualRecoveryCount,
        prompt_replay_count: promptReplayCount };
      await writeFile(join(output, 'progress.json'), JSON.stringify(progress, null, 2));
      const logDue = stateChanged || Date.now() - lastLiveLogAt >= 30_000;
      if (logDue) {
        const progressEvent = { phase: 'progress', root: root.id,
          elapsed_ms: progress.elapsed_ms, priced_usd: progress.priced_usd, cap_usd: costCap,
          no_progress_ms: progress.no_progress_ms, no_progress_timeout_ms: READ_STALL_MS,
          active_native_tools: activeTools, pending_permission_requests: pendingPermissionList,
          tool_wait_observations: toolWaitObservations(activeTools, hookEvents, pendingPermissionList, project),
          sessions: progress.owned_sessions, native_root_outcome: progress.native_root_outcome,
          native_root_idle: progress.native_root_idle, mission_phase: progress.mission_phase,
          review: progress.review, submission_status: progress.submission_status,
          operator_stage: progress.operator_stage, operator_decision: progress.operator_decision,
          native_receipt_status: progress.native_receipt_status,
          native_receipt_stop_reason: progress.native_receipt_stop_reason };
        await appendFile(join(output, 'progress-events.jsonl'), `${JSON.stringify(progressEvent)}\n`);
        console.log(JSON.stringify(progressEvent));
        lastLiveLogAt = Date.now();
      }

      if (native.state.stream_error) {
        failure = `native event stream failed: ${native.state.stream_error}`;
        stopReason = 'native-event-stream-error';
        break;
      }
      // A parent's subagent wait is not stalled while its owned descendant makes
      // measured progress. Global inactivity still bounds the entire arm.
      const stalledTool = activeTools.find(tool => tool.name !== 'subagent' && tool.no_progress_ms >= READ_STALL_MS);
      if (stalledTool || shouldStopForNoProgress({ now: Date.now(), lastProgressAt, threshold: READ_STALL_MS })) {
        stopReason = noProgressStopReason({ pendingPermissionCount: pendingPermissionList.length,
          activeTool: stalledTool });
        const timeoutRecord = { at: new Date().toISOString(), stop_reason: stopReason,
          root_session: root.id, elapsed_ms: Date.now() - started, no_progress_ms: progress.no_progress_ms,
          no_progress_timeout_ms: READ_STALL_MS, stalled_tool: stalledTool ?? null,
          active_native_tools: activeTools, pending_permission_requests: pendingPermissionList,
          tool_wait_observations: toolWaitObservations(activeTools, hookEvents, pendingPermissionList, project),
          native_event_count: native.state.events_seen, native_progress_event_count: native.state.progress_event_count,
          last_progress_source: native.state.last_progress_source, stream_error: native.state.stream_error,
          owned_sessions: progress.owned_sessions };
        await writeFile(join(output, 'no-progress-stop.json'), JSON.stringify(timeoutRecord, null, 2));
        console.log(JSON.stringify({ phase: 'no-progress-stop', ...timeoutRecord }));
        break;
      }

      const rootTurnSettled = nativeTurnTerminal({ ...state, id: root.id }, native.turns);
      const allOwnedSessionsSettled = lastUsage.sessions.length > 0 &&
        lastUsage.sessions.every(item => nativeTurnTerminal(item, native.turns));
      const acceptedReceipt = liveOperator?.phase === 'completed' && liveOperator.receipt?.status === 'succeeded' &&
        liveOperator.receipt?.stop_reason === 'completed';
      if (promptSettled && rootTurnSettled && allOwnedSessionsSettled && !recoveryPending) {
        if (acceptedReceipt) { terminal = true; stopReason = 'accepted'; break; }
        if (contextualRecoveryCount >= 1 || !liveMission || activeTools.length || pendingPermissionList.length) {
          terminal = true;
          stopReason = contextualRecoveryCount >= 1 ? 'contextual-recovery-limit-without-acceptance' :
            !liveMission ? 'root-terminal-incomplete-no-mission' : 'root-terminal-incomplete-unresolved-native-state';
          break;
        }
        const material = { mission_phase: liveMission.phase, submission: liveMission.submission ?? null,
          review: liveMission.review?.verdict ?? null, operator_stage: liveOperator?.phase ?? null,
          decision: liveOperator?.decision ?? null,
          units: liveOperator?.units?.map(unit => ({ id: unit.id, status: unit.status, resultClass: unit.resultClass })) ?? [],
          native_terminals: lastUsage.sessions.map(item => ({ id: item.id, agent: item.agent,
            outcome: item.idle_outcome, time_idle: item.time_idle })),
          root_native_outcome: state.outcome ?? null, head: cmd('git', ['rev-parse', 'HEAD'], { cwd: project }).trim() };
        const signature = hash(JSON.stringify(material));
        const text = `同じRoot sessionと同じMissionの要求内継続。元課題promptは再送しない。nativeでRootと全owned sessionの終了を確認済み: ${JSON.stringify(material)}。pending tool/permissionは0件。事前読込済み適用AGENTS.md (${profile.applicable_agents_sha256})を次に添付するので、内容再取得だけの同一祖先readは不要。未完了の実装・正式検証・Review・要求commit・受理が残る場合だけ既存Missionを継続し、受理済み成功を捏造しない。native終端が確認できた原因の要求内修正のみ行い、同一原因の再派遣を繰り返さない。別trial/armや消費resetは禁止。残り本体上限 ${Math.max(0, wallMs - (Date.now() - started))}ms、累計価格推定 $${lastUsage.priced_usd} / $${costCap}。適用済みAGENTS.md:\n\n${applicableAgentsText}`;
        contextualRecoveryCount += 1;
        expectSessionTurn(native.turns, root.id);
        await appendFile(join(output, 'recovery-events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(),
          elapsed_ms: Date.now() - started, signature, material, contextual_recovery_count: contextualRecoveryCount,
          original_prompt_replayed: false, prompt: text })}\n`);
        promptSettled = false;
        recoveryPending = true;
        promptPromise = client.session.prompt({ sessionID: root.id, text }, { signal: promptController.signal }).then(
          () => { promptSettled = true; recoveryPending = false; },
          error => { promptSettled = true; recoveryPending = false; promptError = redactSensitiveText(error); });
      }

      await delay(MONITOR_INTERVAL_MS);
    }
   stoppedAt = Date.now();
   if (!terminal && !stopReason) stopReason = 'wall-time-cap';
    if (promptError && !failure) { failure = promptError; stopReason ??= 'session-prompt-error'; }
} catch (error) {
  failure = redactSensitiveText(error);
  stopReason ??= root ? (promptSubmitted ? 'driver-error' : `preprompt-failure:${stage}`) : `setup-failure:${stage}`;
  stoppedAt ??= Date.now();
} finally {
    try { await collectSettlement(); }
    catch (error) { settlement = { status: 'query-error', native_settled: false, error: redactSensitiveText(error) }; }
    // Cancel any unconfirmed local admission response; never wait a second budget,
    // replay the prompt or infer native termination from this transport cancellation.
    promptController.abort();
   try { await persistFinal(); }
  catch (error) {
    failure ??= `finalization failed: ${String(error)}`;
    try { await writeFile(join(output, 'driver-error.txt'), `${redactSensitiveText(failure)}\n`); } catch {}
    console.error(redactSensitiveText(failure));
  }
  for (const handle of [...servers].reverse()) {
    try {
      const stopped = await handle.stop();
      if (!stopped) failure ??= 'server cleanup failed: process remains active';
    } catch (error) { failure ??= `server cleanup failed: ${redactSensitiveText(error)}`; }
  }
  if (native) await native.stop().catch(error => { failure ??= `native observer cleanup failed: ${redactSensitiveText(error)}`; });
  try { databaseSanitization = await sanitizeDatabase(); }
  catch (error) { databaseSanitization = { status: 'failed', error: redactSensitiveText(error), database_path: cliDatabase,
    database_retained: existsSync(cliDatabase), credential_rows_remaining: null, original_removed: false }; }
  try {
    const observationPath = join(output, 'observation.json');
    const receiptPath = join(output, 'receipt.json');
    const observation = JSON.parse(await readFile(observationPath, 'utf8'));
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
     observation.database_sanitization = databaseSanitization;
     receipt.database_sanitization = databaseSanitization;
     if (databaseSanitization.status === 'sanitized' && root && estimateModelUsageCost) {
       const postCleanup = { observed_at: new Date().toISOString(), server_process_stopped: servers.every(handle => handle.closed),
         usage: readOwnedUsage(usageSnapshot, root.id, estimateModelUsageCost),
         native_termination_is_not_inferred_from_process_stop: true };
       await writeFile(join(output, 'post-cleanup-usage.json'), JSON.stringify(postCleanup, null, 2));
       observation.post_cleanup = postCleanup;
     }
    if (databaseSanitization.status === 'credential-remains' || databaseSanitization.status === 'failed' ||
      databaseSanitization.status === 'server-still-running' ||
      (databaseSanitization.status !== 'not-created' && (databaseSanitization.database_retained !== true ||
        databaseSanitization.credential_rows_remaining !== 0 || databaseSanitization.snapshot_credential_rows_remaining !== 0))) {
      failure ??= `isolated credential cleanup failed: ${JSON.stringify(databaseSanitization)}`;
      observation.failure = failure;
      receipt.failure = failure;
      await writeFile(join(output, 'driver-error.txt'), `${redactSensitiveText(failure)}\n`);
    }
    if (failure) {
      observation.failure = redactSensitiveText(failure);
      observation.failure_stage ??= stage;
      receipt.failure = redactSensitiveText(failure);
      receipt.failure_stage ??= stage;
    }
    await writeFile(observationPath, JSON.stringify(observation, null, 2));
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  } catch (error) { failure ??= `sanitization evidence write failed: ${String(error)}`; }
}

try {
  const retainedFiles = [
       'run.mjs', 'run-arm.mjs', 'core.mjs', 'host.mjs', 'observe.mjs', 'usage.mjs', 'settle.mjs', 'recovery.mjs', 'execution-policy.json', 'prepare.mjs', 'setup.json', 'candidate-package.json', 'launch-management.patch',
     'bootstrap-config.json', 'provenance.json', 'verify.mjs', 'verify-regression.mjs', 'frozen-inputs.json', 'preparation-usage.json', 'driver-client-package.json', 'driver-client-package-lock.json',
     candidatePackage.archive_filename, 'instruction.md', 'applicable-AGENTS.md', 'profile.json', 'package-SHA256SUMS',
     'isolated-opencode.json', 'model-discovery.json', 'configured-agents.json',
     'npm-package-lock.json', 'run-attempt.lock', 'launch.json', 'worker-start.json', 'progress.json',
     'progress-events.jsonl', 'recovery-events.jsonl', 'no-progress-stop.json', 'receipt.json', 'observation.json', 'mission.json', 'operator.json',
       'native-events.jsonl', 'native-hook-events.jsonl', 'permission-snapshots.jsonl', 'permission-recovery.jsonl', 'session-observation-errors.jsonl',
       'usage-safety-stop.json', 'settlement.json', 'settlement-snapshots.jsonl', 'post-cleanup-usage.json',
    'native-history.json', 'request.txt', 'driver-error.txt',
    'preflight-server-stdout.log', 'preflight-server-stderr.log',
    'server-server-stdout.log', 'server-server-stderr.log',
    'data/opencode/opencode.db', 'usage/opencode.db', 'usage-gap-events.jsonl', 'goyacc.json',
    'seed-service-registration.json', 'run-service-registration.json',
  ];
  await mkdir(recordRoot, { recursive: true });
  for (const relative of retainedFiles) {
    const sourcePath = join(output, ...relative.split('/'));
    if (!existsSync(sourcePath)) continue;
    const destinationPath = join(recordRoot, ...relative.split('/'));
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, { force: false, errorOnExist: true });
  }
  if (existsSync(project)) {
    const candidateSource = join(recordRoot, 'candidate-source');
    const excludedCandidateDirs = ['.gocache', '.gomodcache', '.gopath', '.tmp'];
    await cp(project, candidateSource, { recursive: true, force: false, errorOnExist: true,
      filter(sourcePath) {
        const relativePath = sourcePath.slice(project.length).replace(/^[\\/]+/u, '');
        const topLevel = relativePath.split(/[\\/]/u)[0];
        return !excludedCandidateDirs.includes(topLevel);
      } });
    await writeFile(join(recordRoot, 'candidate-source-retention.json'), JSON.stringify({
      retained: true, path: candidateSource, git_included: true, ignored_working_state_included: true,
      excluded_cache_directories: excludedCandidateDirs,
      head: runtimeInfo?.head ?? null, branch: runtimeInfo?.branch ?? null,
      commits: runtimeInfo?.commits ?? null, changes: runtimeInfo?.changes ?? null,
    }, null, 2));
  }
  console.log(JSON.stringify({ phase: 'record-retained', record_root: recordRoot,
    command_elapsed_ms: Date.now() - runnerInvokedAt }));
} catch (error) {
  failure ??= `persistent record sync failed: ${String(error)}`;
  console.error(redactSensitiveText(failure));
  process.exitCode = 1;
}

 if (failure || !root || !benchmarkAccepted) process.exitCode = 1;
