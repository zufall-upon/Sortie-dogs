import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { appendFile, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { finished } from 'node:stream/promises';
import {
  ARTIFACT_ROOT, CLI, CLI_SHA256, CLI_VERSION, HOST_DATABASE, LEGACY_RUN, MONITOR_INTERVAL_MS,
  READ_STALL_MS, SOURCE_PROJECT, STATE_ROOT, WORKER_MODEL, diagnosticReadObservations, diagnosticRoot,
  exists, hashFile, noProgressStopReason, packageReceiptPath, readJson, sha256, shouldStopForNoProgress,
  versionRoot, writeExclusive, writeJson,
} from './core.mjs';
import { installObservationFiles } from './observe.mjs';
import { loadClient } from './host.mjs';

const SENSITIVE_ENV = /(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|(?:^|_)TOKEN(?:_|$)|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH|NODE_OPTIONS|NODE_PATH|GIT_ASKPASS|SSH_AUTH_SOCK|SSH_AGENT_PID)/iu;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = data => createHash('sha256').update(data).digest('hex');
const toRoute = model => model?.providerID && (model.id || model.model)
  ? `${model.providerID}/${model.id ?? model.model}${model.variant ? `#${model.variant}` : ''}` : null;

function sanitizedPermission(request) {
  return { id: request.id, sessionID: request.sessionID, action: request.action,
    resources: Array.isArray(request.resources) ? request.resources.map(String) : [],
    source: request.source?.type === 'tool' ? { type: 'tool', id: request.source.id } : request.source?.type ?? null,
    requested_at: Number.isFinite(request.time?.created) ? request.time.created : null };
}

function safeNativeEvent(event, toolName = null) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const input = data.input && typeof data.input === 'object' ? data.input : {};
  const name = toolName ?? data.name ?? null;
  const toolPath = name === 'read'
    ? (input.filePath ?? input.path ?? input.filepath ?? data.path ?? null) : null;
  const selected = { type: event?.type ?? null, id: event?.id ?? null, created: event?.created ?? null,
    sessionID: data.sessionID ?? null, assistantMessageID: data.assistantMessageID ?? null,
    callID: data.id ?? data.callID ?? data.requestID ?? null, name,
    path: typeof toolPath === 'string' ? toolPath : undefined,
    action: data.action ?? null, resources: Array.isArray(data.resources) ? data.resources.map(String) : undefined,
    reply: data.reply ?? undefined, executed: data.executed ?? undefined,
    delta_bytes: typeof data.delta === 'string' ? Buffer.byteLength(data.delta) : undefined };
  return Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== undefined));
}

const observerPlugin = `import { appendFile } from 'node:fs/promises';
const log = process.env.ANKO_BENCHMARK_HOOK_LOG;
const safe = (phase, event) => {
  const args = event?.input ?? event?.args ?? {};
  const tool = event?.tool ?? event?.name ?? null;
  return { at: new Date().toISOString(), phase, tool,
    session_id: event?.sessionID ?? event?.session_id ?? null,
    call_id: event?.callID ?? event?.call_id ?? event?.id ?? null,
    agent: event?.agent ?? null, path: tool === 'read' ?
      (args.path ?? args.filePath ?? args.filepath ?? null) : null,
    status: event?.status ?? null };
};
const record = async value => { if (log && value.tool === 'read') await appendFile(log, JSON.stringify(value) + '\\n'); };
export default {
  id: 'anko-benchmark-observer',
  async setup(ctx) {
    await ctx.tool.hook('execute.before', async event => record(safe('plugin-hook-before', event)));
    await ctx.tool.hook('execute.after', async event => record(safe('plugin-hook-after', event)));
  },
};
`;

async function makeEnvironment(output, project, control) {
  const config = join(output, 'config');
  const data = join(output, 'data');
  const cache = join(output, 'cache');
  const temp = join(output, 'tmp');
  await Promise.all([mkdir(config, { recursive: true }), mkdir(data, { recursive: true }),
    mkdir(cache, { recursive: true }), mkdir(temp, { recursive: true }),
    mkdir(join(output, 'appdata'), { recursive: true }), mkdir(join(output, 'localappdata'), { recursive: true })]);
  const env = { ...process.env };
  const removedNames = Object.keys(env).filter(name => SENSITIVE_ENV.test(name));
  for (const name of removedNames) delete env[name];
  const db = join(data, 'opencode/opencode.db');
  await mkdir(dirname(db), { recursive: true });
  const logPath = join(output, 'native-hook-events.jsonl');
  Object.assign(env, { HOME: output, USERPROFILE: output, APPDATA: join(output, 'appdata'),
    LOCALAPPDATA: join(output, 'localappdata'), XDG_CONFIG_HOME: output, OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG: join(config, 'opencode.json'), XDG_DATA_HOME: data, XDG_CACHE_HOME: cache,
    NPM_CONFIG_CACHE: join(output, 'npm-cache'), OPENCODE_DB: db, TMP: temp, TEMP: temp, TMPDIR: temp,
    ANKO_BENCHMARK_HOOK_LOG: logPath });
  await writeFile(env.OPENCODE_CONFIG, '{}\n');
  await Promise.all([writeFile(join(config, 'npmrc'), '\n'), writeFile(join(config, 'npm-globalrc'), '\n')]);
  env.NPM_CONFIG_USERCONFIG = join(config, 'npmrc');
  env.NPM_CONFIG_GLOBALCONFIG = join(config, 'npm-globalrc');
  env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
  return { env, db, logPath, removedNames };
}

async function startServer(env, output, project) {
  const { OpenCode } = await loadClient();
  const password = randomBytes(24).toString('hex');
  const secrets = [password, Buffer.from(`opencode:${password}`).toString('base64')];
  const stdoutPath = join(output, 'server-stdout.log');
  const stderrPath = join(output, 'server-stderr.log');
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const child = spawn(CLI, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: project, env: { ...env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  let errors = '';
  let closed = false;
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  child.once('close', () => { closed = true; });
  child.stdout.on('data', data => { log = (log + data).slice(-8192); stdout.write(data); });
  child.stderr.on('data', data => { errors = (errors + data).slice(-8192); stderr.write(data); });
  const until = Date.now() + 45_000;
  while (!/http:\/\/127\.0\.0\.1:\d+/u.test(log) && !closed && !spawnError && Date.now() < until) await sleep(100);
  const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(log)?.[0];
  const handle = { child, url, get closed() { return closed; }, errors: () => errors,
    client: url ? OpenCode.make({ baseUrl: url, headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    } }) : null,
    async stop() {
      if (!closed) {
        const done = new Promise(resolve => child.once('close', resolve));
        child.kill(); await Promise.race([done, sleep(10_000)]);
        if (!closed) { child.kill('SIGKILL'); await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(5_000)]); }
      }
      const flushed = Promise.all([finished(stdout), finished(stderr)]);
      stdout.end(); stderr.end(); await flushed;
      for (const path of [stdoutPath, stderrPath]) {
        const text = await readFile(path, 'utf8');
        await writeFile(path, secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), text));
      }
      return closed;
    } };
  if (!url) { await handle.stop(); throw new Error(`OpenCode server failed to start: ${String(spawnError ?? errors)}`); }
  return handle;
}

async function seedCredential(databasePath) {
  const source = new DatabaseSync(HOST_DATABASE, { readOnly: true });
  let row;
  try {
    row = source.prepare('SELECT id,integration_id,label,value,connector_id,method_id,active,time_created,time_updated FROM credential WHERE integration_id=? ORDER BY time_updated DESC LIMIT 1').get('openai');
    assert(row && JSON.parse(row.value).type === 'oauth', 'OpenAI OAuth credential unavailable in host database');
  } finally { source.close(); }
  const target = new DatabaseSync(databasePath);
  try {
    assert.equal(target.prepare('SELECT COUNT(*) AS n FROM credential').get().n, 0);
    target.prepare('INSERT INTO credential (id,integration_id,label,value,connector_id,method_id,active,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.integration_id, row.label, row.value, row.connector_id, row.method_id, row.active, row.time_created, row.time_updated);
  } finally { target.close(); }
  if (process.platform !== 'win32') { await chmod(dirname(databasePath), 0o700); await chmod(databasePath, 0o600); }
  return { provider: 'openai', credential_type: 'oauth', source_database_read_only: true,
    destination: 'isolated local-diagnostic database; no host session rows copied' };
}

async function sanitizeDatabase(databasePath, snapshotPath, servers) {
  if (servers.some(server => !server.closed)) return { status: 'server-still-running', credential_rows_remaining: null };
  await mkdir(dirname(snapshotPath), { recursive: true });
  const source = new DatabaseSync(databasePath);
  let removed = null;
  let sessions = null;
  try {
    source.exec('PRAGMA secure_delete=ON');
    const present = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credential'").get();
    if (present) {
      const before = source.prepare('SELECT COUNT(*) AS n FROM credential').get().n;
      source.exec('DELETE FROM credential'); source.exec('PRAGMA wal_checkpoint(TRUNCATE)'); source.exec('VACUUM');
      const checkpoint = source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      assert.equal(checkpoint.busy, 0);
      removed = before;
      assert.equal(source.prepare('SELECT COUNT(*) AS n FROM credential').get().n, 0);
    } else removed = 0;
    const sessionsTable = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get();
    sessions = sessionsTable ? source.prepare('SELECT COUNT(*) AS n FROM session_v2').get().n : 0;
    source.prepare('VACUUM INTO ?').run(snapshotPath);
  } finally { source.close(); }
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  let remaining;
  try { remaining = snapshot.prepare('SELECT COUNT(*) AS n FROM credential').get().n; }
  finally { snapshot.close(); }
  return { status: remaining === 0 ? 'sanitized' : 'credential-remains', credential_rows_removed: removed,
    credential_rows_remaining: 0, snapshot_credential_rows_remaining: remaining, session_count: sessions,
    database_retained: true, snapshot: snapshotPath };
}

function pluginObserver(project) {
  const control = join(project, '.opencode');
  const configPath = join(control, 'opencode.json');
  return installObservationFiles(project).then(async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.plugins ??= [];
    if (!config.plugins.includes('./plugins/anko-benchmark-observer')) config.plugins.push('./plugins/anko-benchmark-observer');
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  });
}

function nativeObserver(client, output, sessionID, priorState = {}) {
  const owned = new Set([sessionID]);
  const controller = new AbortController();
  const eventsPath = join(output, 'native-events.jsonl');
  const tools = new Map(priorState.tools ?? []);
  const permissions = new Map(priorState.permissions ?? []);
  const state = { started_at: new Date().toISOString(), last_progress_at: priorState.last_progress_at ?? Date.now(),
    last_progress_source: priorState.last_progress_source ?? 'session-created',
    last_event: priorState.last_event ?? null, events_seen: priorState.events_seen ?? 0,
    progress_event_count: priorState.progress_event_count ?? 0,
    execution_started: priorState.execution_started ?? false,
    execution_terminal: priorState.execution_terminal ?? false, stream_error: null };
  const progressEventTypes = new Set(['session.execution.started', 'session.execution.succeeded', 'session.execution.failed',
    'session.execution.interrupted', 'session.step.started', 'session.step.ended', 'session.step.failed',
    'session.text.started', 'session.text.delta', 'session.text.ended', 'session.reasoning.started',
    'session.reasoning.delta', 'session.reasoning.ended', 'session.tool.input.started', 'session.tool.input.ended',
    'session.tool.called', 'session.tool.success', 'session.tool.failed', 'session.usage.updated',
    'permission.asked', 'permission.replied', 'session.idle']);
  const task = (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        if (!owned.has(data.sessionID)) continue;
        state.events_seen += 1;
        const key = `${data.sessionID}/${data.id ?? data.requestID ?? ''}`;
        const priorTool = tools.get(key);
        const safe = safeNativeEvent(event, data.name ?? priorTool?.name ?? null);
        safe.observed_at = new Date().toISOString();
        await appendFile(eventsPath, `${JSON.stringify(safe)}\n`);
        state.last_event = safe;
        if (event.type === 'session.execution.started') state.execution_started = true;
        if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.idle']
          .includes(event.type)) state.execution_terminal = true;
        if (event.type === 'session.tool.called' || event.type === 'session.tool.input.started') {
          const now = Date.now();
          tools.set(key, { call_id: data.id, name: data.name ?? priorTool?.name ?? null,
            started_at: priorTool?.started_at ?? now, last_progress_at: now,
            observed_at: new Date().toISOString() });
        } else if (event.type === 'session.tool.input.delta' || event.type === 'session.tool.input.ended' ||
          event.type === 'session.tool.progress') {
          if (priorTool) tools.set(key, { ...priorTool, last_progress_at: Date.now(),
            observed_at: new Date().toISOString() });
        } else if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
          tools.delete(key);
        }
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
   return { controller, task, tools, permissions, state, eventsPath, owned };
}

async function pollPermissions(client, sessionID, output) {
  const at = new Date().toISOString();
  try {
    const requests = await client.permission.list({ sessionID }, { signal: AbortSignal.timeout(5_000) });
    const snapshot = { at, session_id: sessionID, status: 'observed', requests: requests.map(sanitizedPermission) };
    await appendFile(join(output, 'permission-snapshots.jsonl'), `${JSON.stringify(snapshot)}\n`);
    return snapshot;
  } catch (error) {
    const snapshot = { at, session_id: sessionID, status: 'query-error', error: String(error), requests: [] };
    await appendFile(join(output, 'permission-snapshots.jsonl'), `${JSON.stringify(snapshot)}\n`);
    return snapshot;
  }
}

async function copyDiagnostic(output, recordPath) {
  assert.equal(await exists(recordPath), false, `diagnostic record destination already exists: ${recordPath}`);
  await mkdir(dirname(recordPath), { recursive: true });
  await cp(output, recordPath, { recursive: true, force: false, errorOnExist: true });
}

async function readJsonLines(path) {
  const text = await readFile(path, 'utf8').catch(error => error?.code === 'ENOENT' ? '' : Promise.reject(error));
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function diagnosticTargets(project) {
  const existing = join(project, 'go.mod');
  const missing = join(project, 'AGENTS.md');
  const ancestors = join(process.cwd(), 'AGENTS.md');
  return [
    { id: 'repo-existing-file', path: existing, expected_presence: 'present', aliases: ['go.mod', './go.mod'] },
    { id: 'repo-missing-agents', path: missing, expected_presence: 'absent', aliases: ['AGENTS.md', './AGENTS.md'] },
    { id: 'ancestor-agents', path: ancestors, expected_presence: 'present', aliases: [] },
  ];
}

async function reconcileSubmittedDiagnostic(version, prior, packageReceipt) {
  assert.equal(prior.status, 'diagnostic-error');
  assert.equal(prior.error, 'ReferenceError: STATE_ROOT is not defined');
  assert.equal(prior.prompt_submitted, true);
  assert.ok(prior.root_session, 'submitted diagnostic has no native root to reattach');
  const root = diagnosticRoot(version);
  const attemptNumber = prior.attempt_number;
  const attempt = join(root, `attempt-${attemptNumber}`);
  const recovery = join(attempt, 'recovery');
  const lockPath = join(attempt, 'reattach-once.lock');
  const recordPath = join(ARTIFACT_ROOT, `v${version}/diagnosis/attempt-${attemptNumber}-reconciled`);
  assert.equal(await exists(lockPath), false, 'submitted diagnostic reattachment already started; do not repeat');
  assert.equal(await exists(recordPath), false, `reconciliation record already exists: ${recordPath}`);
  await writeExclusive(lockPath, `${JSON.stringify({ one_shot: true, version, attempt_number: attemptNumber,
    root_session: prior.root_session, prompt_replayed: false, started_at: new Date().toISOString() }, null, 2)}\n`);

  const project = join(attempt, 'project');
  const control = join(project, '.opencode');
  const sourceDatabase = join(attempt, 'data/opencode/opencode.db');
  const originalProgress = await readJson(join(attempt, 'progress.json'));
  const originalEvents = await readJsonLines(join(attempt, 'native-events.jsonl'));
  const originalHooks = await readJsonLines(join(attempt, 'plugin-hook-events.jsonl'));
  const originalPermissions = await readJsonLines(join(attempt, 'permission-snapshots.jsonl'));
  const targets = diagnosticTargets(project);
  const servers = [];
  let envInfo = null;
  let native = null;
  let host = null;
  let credentialSeed = null;
  let databaseSanitization = null;
  let interruption = null;
  let stopReason = null;
  let sessionState = null;
  let observerEvents = [];
  try {
    assert.equal(await exists(sourceDatabase), true, 'sanitized source database for the existing native session is missing');
    envInfo = await makeEnvironment(recovery, project, control);
    await Promise.all(['native-events.jsonl', 'native-hook-events.jsonl', 'plugin-hook-events.jsonl',
      'permission-snapshots.jsonl'].map(name => writeFile(join(recovery, name), '', { flag: 'wx' })));
    await cp(sourceDatabase, envInfo.db, { force: false, errorOnExist: true });
    credentialSeed = await seedCredential(envInfo.db);
    assert.equal(await hashFile(CLI), (await readJson(join(STATE_ROOT, 'common/profile.json'))).cli.sha256);
    const server = await startServer(envInfo.env, recovery, project);
    servers.push(server);
    const client = server.client;
    host = await client.server.info();
    assert.equal(host.version, CLI_VERSION);
    let plugins = [];
    const pluginDeadline = Date.now() + 45_000;
    do {
      plugins = (await client.plugin.list({ location: { directory: project } })).data ?? [];
      if (plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active') &&
        plugins.some(item => /anko-benchmark-observer/u.test(item.id) && item.state.status === 'active')) break;
      await sleep(250);
    } while (Date.now() < pluginDeadline);
    const sortiePlugin = plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active');
    const observerLoaded = plugins.some(item => /anko-benchmark-observer/u.test(item.id) && item.state.status === 'active');
    assert(sortiePlugin && observerLoaded, `diagnostic reattachment plugins are not active: ${JSON.stringify(plugins)}`);

    const savedProgressAt = Date.parse(originalProgress.last_progress_at);
    const eventProgressAt = originalEvents.filter(event => ['session.execution.started', 'session.execution.succeeded',
      'session.execution.failed', 'session.execution.interrupted', 'session.step.started', 'session.step.ended',
      'session.step.failed', 'session.text.started', 'session.text.delta', 'session.text.ended',
      'session.reasoning.started', 'session.reasoning.delta', 'session.reasoning.ended',
      'session.tool.input.started', 'session.tool.input.ended', 'session.tool.called', 'session.tool.success',
      'session.tool.failed', 'session.usage.updated', 'permission.asked', 'permission.replied', 'session.idle']
      .includes(event.type)).map(event => Date.parse(event.observed_at)).filter(Number.isFinite);
    const priorProgressCandidates = [...eventProgressAt, ...(Number.isFinite(savedProgressAt) ? [savedProgressAt] : [])];
    const priorProgressAt = priorProgressCandidates.length ? Math.max(...priorProgressCandidates) : Date.now();
    const priorTools = new Map();
    const priorPermissions = new Map();
    for (const event of originalEvents) {
      const key = `${event.sessionID}/${event.callID ?? ''}`;
      if (event.type === 'session.tool.called' || event.type === 'session.tool.input.started')
        priorTools.set(key, { call_id: event.callID, name: event.name,
          started_at: Date.parse(event.observed_at) || priorProgressAt,
          last_progress_at: Date.parse(event.observed_at) || priorProgressAt, observed_at: event.observed_at });
      if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') priorTools.delete(key);
      if (event.type === 'permission.asked') priorPermissions.set(event.id, event);
      if (event.type === 'permission.replied') priorPermissions.delete(event.requestID);
    }
    const priorProgressCount = originalEvents.filter(event => ['session.execution.started',
      'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
      'session.step.started', 'session.step.ended', 'session.step.failed', 'session.text.started',
      'session.text.delta', 'session.text.ended', 'session.reasoning.started', 'session.reasoning.delta',
      'session.reasoning.ended', 'session.tool.input.started', 'session.tool.input.ended',
      'session.tool.called', 'session.tool.success', 'session.tool.failed', 'session.usage.updated',
      'permission.asked', 'permission.replied', 'session.idle'].includes(event.type)).length;
    const priorState = { last_progress_at: Number.isFinite(priorProgressAt) ? priorProgressAt : Date.now(),
      last_progress_source: originalProgress.last_progress_source ?? 'prior-attempt-progress',
      last_event: originalEvents.at(-1) ?? null, events_seen: originalEvents.length,
      progress_event_count: priorProgressCount,
      execution_started: originalEvents.some(event => event.type === 'session.execution.started'),
      execution_terminal: originalEvents.some(event => ['session.execution.succeeded',
        'session.execution.failed', 'session.execution.interrupted', 'session.idle'].includes(event.type)),
      tools: priorTools, permissions: priorPermissions };
    native = nativeObserver(client, recovery, prior.root_session, priorState);

    const sessionID = prior.root_session;
    const latestPermissions = [];
    let lastPermissionPoll = 0;
    let lastHookRead = 0;
    const pendingObserverEvents = [];
    let nextSessionPoll = 0;
    let timeoutProgress = null;
    while (true) {
      const now = Date.now();
      if (now - lastPermissionPoll >= MONITOR_INTERVAL_MS) {
        latestPermissions.push(await pollPermissions(client, sessionID, recovery));
        lastPermissionPoll = Date.now();
      }
      const hookLines = (await readFile(envInfo.logPath, 'utf8').catch(() => '')).split(/\r?\n/u).filter(Boolean);
      while (lastHookRead < hookLines.length) {
        const event = JSON.parse(hookLines[lastHookRead++]);
        pendingObserverEvents.push(event);
        await appendFile(join(recovery, 'plugin-hook-events.jsonl'), `${JSON.stringify(event)}\n`);
      }
      if (now >= nextSessionPoll) {
        sessionState = await client.session.get({ sessionID }).catch(error => ({ error: String(error) }));
        nextSessionPoll = Date.now() + MONITOR_INTERVAL_MS;
      }
      const pending = new Map(native.permissions);
      for (const snapshot of [...originalPermissions, ...latestPermissions])
        for (const request of snapshot.requests ?? []) pending.set(request.id, request);
      const activeToolRecord = [...native.tools.values()].at(-1) ?? null;
      const activeTool = activeToolRecord ? { ...activeToolRecord,
        elapsed_ms: now - activeToolRecord.started_at, no_progress_ms: now - activeToolRecord.last_progress_at } : null;
      const progress = { at: new Date().toISOString(), root_session: sessionID,
        elapsed_ms: now - (Number.isFinite(priorProgressAt) ? priorProgressAt : now),
        no_progress_ms: now - native.state.last_progress_at,
        last_progress_at: new Date(native.state.last_progress_at).toISOString(),
        last_progress_source: native.state.last_progress_source, worker_active_is_progress: false,
        active_native_tool: activeTool, pending_permission_requests: [...pending.values()],
        permission_snapshot: latestPermissions.at(-1) ?? originalPermissions.at(-1) ?? null,
        native_event_count: native.state.events_seen, stream_error: native.state.stream_error };
      await writeJson(join(recovery, 'progress.json'), progress);
      console.log(JSON.stringify({ phase: 'diagnostic-reattachment-progress', root_session: sessionID,
        elapsed_ms: progress.elapsed_ms, no_progress_ms: progress.no_progress_ms,
        last_progress_source: progress.last_progress_source, active_native_tool: activeTool,
        pending_permission_requests: progress.pending_permission_requests.length }));
      const nativeTerminal = native.state.execution_terminal ||
        (native.state.execution_started && Boolean(sessionState?.outcome || sessionState?.time?.idle));
      if (nativeTerminal) break;
      if (native.state.stream_error) throw new Error(`native event stream failed: ${native.state.stream_error}`);
      if (shouldStopForNoProgress({ now, lastProgressAt: native.state.last_progress_at, threshold: READ_STALL_MS })) {
        stopReason = noProgressStopReason({ pendingPermissionCount: pending.size, activeTool });
        timeoutProgress = progress;
        await client.session.interrupt({ sessionID }).then(
          () => { interruption = { interrupt_requested: true, error: null }; },
          error => { interruption = { interrupt_requested: true, error: String(error) }; });
        break;
      }
      await sleep(250);
    }
    if (stopReason && interruption?.interrupt_requested) {
      await sleep(1_000);
      sessionState = await client.session.get({ sessionID }).catch(error => ({ error: String(error) }));
    }
    const finalPermission = await pollPermissions(client, sessionID, recovery);
    latestPermissions.push(finalPermission);
    const exported = await client.session.export({ sessionID }).catch(error => ({ export_error: String(error) }));
    await writeJson(join(recovery, 'native-session-export.json'), exported);
    const runtimeText = [...JSON.stringify(exported).matchAll(/"text":"(\{[^"\\]*(?:\\.[^"\\]*)*\})"/gu)]
      .map(match => { try { return JSON.parse(match[1]); } catch { return null; } })
      .find(value => value?.runtime?.runtime_asset_version);
    const originalHooksAfter = await readJsonLines(join(attempt, 'plugin-hook-events.jsonl'));
    observerEvents = [...originalHooksAfter, ...pendingObserverEvents];
    const nativeEvents = [...originalEvents, ...await readJsonLines(join(recovery, 'native-events.jsonl'))];
    const hookEvents = observerEvents.filter(event => event.tool === 'read');
    const targetsRead = diagnosticReadObservations(nativeEvents, hookEvents, targets);
    const calls = nativeEvents.filter(event => ['session.tool.called', 'session.tool.input.started'].includes(event.type) &&
      event.name === 'read').map(event => ({
      type: event.type, call_id: event.callID ?? event.call_id, name: event.name, path: event.path,
      created: event.created, observed_at: event.observed_at,
    }));
    const allReadBoundariesObserved = targetsRead.every(item => item.native_tool_start_observed &&
      item.plugin_hook_before_observed && item.plugin_hook_after_observed && item.native_tool_terminal_observed);
    const diagnosisStatus = stopReason ? 'stopped-no-progress' :
      allReadBoundariesObserved ? 'completed' : 'incomplete-diagnostic';
    const report = {
      schema_version: 1, version, attempt_number: attemptNumber, result_filename: 'diagnosis-reconciled.json',
      diagnostic_stage: 'reattached-existing-root', prompt_submitted: true, prompt_replayed: false,
      reconciled_existing_session: true, original_prompt_submission_count: 1,
      profile_sha256: await hashFile(join(STATE_ROOT, 'common/profile.json')),
      package_sha256: packageReceipt.sha256, package_integrity: packageReceipt.integrity,
      diagnosis_kind: 'reattached-native-tool-probe-not-benchmark-arm',
      status: diagnosisStatus, root_session: sessionID,
      agent: 'dog-worker-v010', configured_model: WORKER_MODEL,
      host: { version: host.version, pid: host.pid ?? null }, observer_plugin_loaded: true,
      sortie_plugin_loaded: true, loaded_runtime: runtimeText?.runtime ?? null,
      candidate_project_path: project, diagnostic_targets: targets.map(({ id, path, expected_presence }) => ({
        id, path, expected_presence,
      })),
      probe_elapsed_ms: Date.now() - (Number.isFinite(priorProgressAt) ? priorProgressAt : Date.now()),
      no_progress_timeout_ms: READ_STALL_MS, stop_reason: stopReason,
      prompt_error: null, no_progress_state: timeoutProgress,
      session_state: { outcome: sessionState?.outcome ?? null, idle: Boolean(sessionState?.time?.idle),
        error: sessionState?.error ?? null },
      interruption, permission_observations: [...originalPermissions, ...latestPermissions],
      native_tool_calls: calls, native_tool_events: nativeEvents, target_read_observations: targetsRead,
      plugin_hook_observations: hookEvents,
      tool_hook_boundary_observed: hookEvents.some(event => event.phase === 'plugin-hook-before') &&
        hookEvents.some(event => event.phase === 'plugin-hook-after'),
      native_event_stream: { events_seen: nativeEvents.length, error: native.state.stream_error,
        last_progress_source: native.state.last_progress_source },
      pending_permission_at_end: finalPermission.requests,
      native_usage: { cost: exported.info?.cost ?? null, tokens: exported.info?.tokens ?? null,
        model: exported.info?.model ?? null },
      interpretation: {
        established: 'original prompt/session was reattached read-only; native tool, plugin hook, and permission evidence combines the original submission and the no-prompt-replay reattachment.',
        not_established: 'A missing permission row/event does not prove no request was pending outside the observation window; native tool events do not expose internal filesystem syscall stages.',
        policy: 'no permission allow/reject reply, no prompt replay, no replacement Worker, and no Anko benchmark arm was launched.',
      },
      credential_seed: credentialSeed, database_sanitization: null,
      record_path: recordPath, captured_at: new Date().toISOString(),
    };
    native.controller.abort();
    await Promise.race([native.task, sleep(3_000)]);
    await server.stop();
    databaseSanitization = await sanitizeDatabase(envInfo.db, join(recovery, 'usage/opencode.db'), servers);
    assert.equal(databaseSanitization.status, 'sanitized', 'reattachment database credential cleanup failed');
    report.database_sanitization = databaseSanitization;
    await writeJson(join(attempt, 'diagnosis-reconciled.json'), report, { flag: 'wx' });
    await copyDiagnostic(attempt, recordPath);
    const terminal = { at: new Date().toISOString(), attempt_number: attemptNumber, attempt_directory: attempt,
      result_filename: 'diagnosis-reconciled.json', status: report.status, stop_reason: stopReason,
      root_session: sessionID, record_path: recordPath, benchmark_arm: false,
      reconciled_existing_session: true, prompt_replayed: false };
    await writeJson(join(root, 'diagnosis-terminal.json'), terminal);
    console.log(JSON.stringify({ diagnosis: report.status, reattached_existing_root: sessionID,
      prompt_replayed: false, stop_reason: stopReason, probe_elapsed_ms: report.probe_elapsed_ms,
      target_read_observations: targetsRead, record_path: recordPath }, null, 2));
    return report;
  } catch (error) {
    await writeJson(join(recovery, 'reattachment-error.json'), { at: new Date().toISOString(),
      root_session: prior.root_session, prompt_replayed: false, error: String(error) }).catch(() => undefined);
    throw error;
  } finally {
    native?.controller.abort();
    if (native) await Promise.race([native.task, sleep(1_000)]);
    for (const server of [...servers].reverse()) await server.stop().catch(() => undefined);
    if (envInfo?.db && existsSync(envInfo.db)) {
      databaseSanitization ??= await sanitizeDatabase(envInfo.db, join(recovery, 'usage/opencode.db'), servers)
        .catch(error => ({ status: 'failed', error: String(error) }));
      await writeJson(join(recovery, 'database-sanitization.json'), databaseSanitization).catch(() => undefined);
    }
  }
}

export async function diagnoseVersion(version) {
  const receiptPath = packageReceiptPath(version);
  const packageReceipt = await readJson(receiptPath);
  const root = diagnosticRoot(version);
  let attemptNumber = 1;
  const latestPath = join(root, 'diagnosis-latest.json');
  const terminalPath = await exists(latestPath) ? latestPath : join(root, 'diagnosis-terminal.json');
  if (await exists(terminalPath)) {
    const terminal = await readJson(terminalPath);
    if (terminal.status !== 'diagnostic-error' && Number.isInteger(terminal.attempt_number)) {
      const existingPath = join(root, `attempt-${terminal.attempt_number}/${terminal.result_filename ?? 'diagnosis.json'}`);
      const existing = await readJson(existingPath);
      if (existing.target_read_observations?.some(item => item.native_tool_start_observed)) {
        console.log(JSON.stringify({ diagnosis: 'reused', result_path: existingPath, status: existing.status,
          root_session: existing.root_session, record_path: existing.record_path }, null, 2));
        return existing;
      }
      // A stopped server cannot resume the old prompt. A changed observer diagnoses
      // the pre-read hook route in a new local probe; this is not an Anko arm retry.
      const fingerprint = await hashFile(fileURLToPath(import.meta.url));
      assert.notEqual(existing.runner_sha256, fingerprint, 'unchanged failed diagnostic must not be replayed');
      if (existing.host?.pid) {
        const active = execFileSync('powershell.exe', ['-NoProfile', '-Command',
          `if (Get-Process -Id ${Number(existing.host.pid)} -ErrorAction SilentlyContinue) { exit 1 }`],
          { stdio: 'ignore', windowsHide: true });
      }
      attemptNumber = terminal.attempt_number + 1;
    }
  }
  let previousAttempt = null;
  for (let number = 1; attemptNumber === 1 && number <= 3; number += 1) {
    const previousPath = join(root, `attempt-${number}/diagnosis.json`);
    if (!(await exists(previousPath))) break;
    previousAttempt = await readJson(previousPath);
    attemptNumber = number + 1;
  }
  if (previousAttempt && previousAttempt.status !== 'diagnostic-error') {
    const completedNumber = attemptNumber - 1;
    const existingPath = join(root, `attempt-${completedNumber}/diagnosis.json`);
    console.log(JSON.stringify({ diagnosis: 'reused', result_path: existingPath, status: previousAttempt.status,
      root_session: previousAttempt.root_session, record_path: previousAttempt.record_path }, null, 2));
    return previousAttempt;
  }
  if (previousAttempt) {
    if (previousAttempt.prompt_submitted === true && previousAttempt.error === 'ReferenceError: STATE_ROOT is not defined')
      return reconcileSubmittedDiagnostic(version, previousAttempt, packageReceipt);
    const recoverablePrePromptFailure = previousAttempt.root_session === null && previousAttempt.prompt_submitted !== true &&
      (previousAttempt.error === 'AssertionError [ERR_ASSERTION]: Sortie v010 plugin is not active: []' ||
        previousAttempt.diagnostic_stage === 'plugin-readiness');
    assert.equal(recoverablePrePromptFailure, true,
      'previous diagnosis failed without evidence that it stopped before prompt submission; do not repeat');
  }
  assert.equal(attemptNumber <= 4, true, 'corrected hook-boundary diagnostic already attempted; inspect its evidence');
  const attempt = join(root, `attempt-${attemptNumber}`);
  const lock = join(root, attemptNumber === 1 ? 'diagnose-once.lock' : `diagnose-attempt-${attemptNumber}.lock`);
  const resultPath = join(attempt, 'diagnosis.json');
  assert.equal(await exists(resultPath), false, `diagnostic attempt ${attemptNumber} already has a result`);
  assert.equal(await exists(lock), false, 'diagnosis already started without a terminal record; do not repeat it');
  await writeExclusive(lock, `${JSON.stringify({ one_shot: true, version, started_at: new Date().toISOString(),
    attempt_number: attemptNumber, benchmark_arm: false, prompt_replayed: false }, null, 2)}\n`);
  await mkdir(attempt, { recursive: true });
  await Promise.all(['native-events.jsonl', 'native-hook-events.jsonl', 'plugin-hook-events.jsonl',
    'permission-snapshots.jsonl'].map(name => writeFile(join(attempt, name), '', { flag: 'wx' })));
  const recordPath = join(ARTIFACT_ROOT, `v${version}/diagnosis/attempt-${attemptNumber}`);
  assert.equal(await exists(recordPath), false, `diagnostic record destination already exists: ${recordPath}`);
  const project = join(attempt, 'project');
  const controlSource = join(versionRoot(version), 'template-project/.opencode');
  const control = join(project, '.opencode');
  const observerEvents = [];
  const toolEvents = [];
  const permissionsSeen = [];
  const servers = [];
  let rootSession = null;
  let promptSettled = false;
  let promptSubmitted = false;
  let promptError = null;
  let stopReason = null;
  let promptStartedAt = null;
  let promptPromise = null;
  let native = null;
  let envInfo = null;
  let host = null;
  let credentialSeed = null;
  let databaseSanitization = null;
  let runtimeObservation = null;
  let terminal = null;
  let diagnosticStage = 'candidate-clone';
  try {
    execFileSync('git', ['clone', '--no-hardlinks', SOURCE_PROJECT, project], { stdio: 'inherit', windowsHide: true });
    execFileSync('git', ['-C', project, 'remote', 'remove', 'origin'], { stdio: 'ignore', windowsHide: true });
    const savedExclude = join(SOURCE_PROJECT, '.git/info/exclude');
    if (existsSync(savedExclude)) await cp(savedExclude, join(project, '.git/info/exclude'), { force: true });
    assert.equal(execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      '3f269a72ff69398b1250c584171f32d12c0d8085');
    assert.equal(execFileSync('git', ['-C', project, 'status', '--porcelain=v1'], { encoding: 'utf8' }).trim(), '');
    assert.equal(existsSync(join(project, 'go.mod')), true, 'diagnostic in-repository read target is missing');
    assert.equal(existsSync(join(project, 'AGENTS.md')), false, 'diagnostic missing-AGENTS target unexpectedly exists');
    await cp(controlSource, control, { recursive: true, force: false, errorOnExist: true });
    await pluginObserver(project);
    diagnosticStage = 'first-server-start';
    envInfo = await makeEnvironment(attempt, project, control);
    assert.equal(await hashFile(CLI), (await readJson(join(STATE_ROOT, 'common/profile.json'))).cli.sha256);
    const server = await startServer(envInfo.env, attempt, project);
    servers.push(server);
    host = await server.client.server.info();
    assert.equal(host.version, CLI_VERSION);
    diagnosticStage = 'plugin-readiness';
    let plugins = [];
    const pluginDeadline = Date.now() + 45_000;
    do {
      plugins = (await server.client.plugin.list({ location: { directory: project } })).data ?? [];
      const ready = plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active') &&
        plugins.some(item => /anko-benchmark-observer/u.test(item.id) && item.state.status === 'active');
      if (ready) break;
      await sleep(250);
    } while (Date.now() < pluginDeadline);
    const sortiePlugin = plugins.find(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active');
    const observerLoaded = plugins.some(item => /anko-benchmark-observer/u.test(item.id) && item.state.status === 'active');
      assert(sortiePlugin, `Sortie v010 plugin is not active: ${JSON.stringify(plugins)}`);
      assert(observerLoaded, `Anko native read-boundary observer is not active: ${JSON.stringify(plugins)}`);
    const staleSessions = (await server.client.session.list({ directory: project, limit: 100 })).data ?? [];
    assert.equal(staleSessions.length, 0, 'diagnostic database contains an unexpected prior session');
    diagnosticStage = 'credential-seed';
    await server.stop();
    credentialSeed = await seedCredential(envInfo.db);
    diagnosticStage = 'session-create';
    const activeServer = await startServer(envInfo.env, attempt, project);
    servers.push(activeServer);
    const client = activeServer.client;
    host = await client.server.info();
    assert.equal(host.version, CLI_VERSION);
    const route = WORKER_MODEL;
    const rootModel = { providerID: 'openai', id: 'gpt-6-luna-fast', variant: 'max' };
    rootSession = await client.session.create({ title: 'Anko native read-path diagnostic; no benchmark Mission',
      agent: 'dog-worker-v010', model: rootModel, location: { directory: project } });
    native = nativeObserver(client, attempt, rootSession.id);
    await writeJson(join(attempt, 'progress.json'), { at: new Date().toISOString(), root_session: rootSession.id,
      elapsed_ms: 0, no_progress_ms: 0, last_progress_at: new Date(native.state.last_progress_at).toISOString(),
      last_progress_source: native.state.last_progress_source, worker_active_is_progress: false,
      active_native_tool: null, pending_permission_requests: [], native_event_count: 0, stream_error: null });
    promptStartedAt = Date.now();
    const targets = diagnosticTargets(project);
    const prompt = `これはAnkoの実装試行ではなく、読み取り経路の局所診断のみ。日本語で応答。candidateは${project}、固定CLIは${CLI_VERSION}、Agent role dog-worker-v010 / ${route}。改変、shell、glob、grep、追加Worker、Mission、権限返信は行わない。native read toolを次の順で各1回だけ使い、各結果後に次へ進み、最後に各pathの成否だけ報告する: 1) repo内の既存ファイル ${targets[0].path}、2) repo内に存在しない AGENTS.md ${targets[1].path}、3) repo外の祖先instructions ${targets[2].path}。permissionが要求されたら応答を待ち、許可を推測しない。promptを再送しない。`;
    diagnosticStage = 'prompt-submit';
    promptSubmitted = true;
    promptPromise = client.session.prompt({ sessionID: rootSession.id, text: prompt, delivery: 'queue', resume: true }).then(
      () => { promptSettled = true; }, error => { promptSettled = true; promptError = String(error); });
    let lastPermissionPoll = 0;
    let lastSessionPoll = 0;
    let sessionState = null;
    while (true) {
      const now = Date.now();
      if (now - lastPermissionPoll >= MONITOR_INTERVAL_MS) {
        const snapshot = await pollPermissions(client, rootSession.id, attempt);
        permissionsSeen.push(snapshot);
        lastPermissionPoll = Date.now();
      }
      if (await exists(envInfo.logPath)) {
        const lines = (await readFile(envInfo.logPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
        while (observerEvents.length < lines.length) {
          const event = JSON.parse(lines[observerEvents.length]);
          observerEvents.push(event);
          if (event.phase === 'plugin-hook-before' || event.phase === 'plugin-hook-after') {
            await appendFile(join(attempt, 'plugin-hook-events.jsonl'), `${JSON.stringify(event)}\n`);
          }
        }
      }
      if (now - lastSessionPoll >= MONITOR_INTERVAL_MS) {
        sessionState = await client.session.get({ sessionID: rootSession.id }, { signal: AbortSignal.timeout(5_000) }).catch(error => ({ error: String(error) }));
        lastSessionPoll = Date.now();
      }
      const nativeTerminal = native.state.execution_terminal ||
        (native.state.execution_started && Boolean(sessionState?.outcome || sessionState?.time?.idle));
      if (promptError || (promptSettled && nativeTerminal)) break;
      const pending = [...native.permissions.values()];
      const activeToolRecord = [...native.tools.values()].at(-1) ?? null;
      const activeTool = activeToolRecord ? { ...activeToolRecord,
        elapsed_ms: now - activeToolRecord.started_at,
        no_progress_ms: now - activeToolRecord.last_progress_at } : null;
      const noProgressMs = now - native.state.last_progress_at;
      const progress = { at: new Date().toISOString(), elapsed_ms: now - promptStartedAt,
        no_progress_ms: noProgressMs, last_progress_at: new Date(native.state.last_progress_at).toISOString(),
        last_progress_source: native.state.last_progress_source, worker_active_is_progress: false,
        active_native_tool: activeTool, pending_permission_requests: pending, permission_snapshot: permissionsSeen.at(-1),
        native_event_count: native.state.events_seen, stream_error: native.state.stream_error };
      await writeJson(join(attempt, 'progress.json'), progress);
      console.log(JSON.stringify({ phase: 'diagnostic-progress', root_session: rootSession.id,
        elapsed_ms: progress.elapsed_ms, no_progress_ms: noProgressMs, last_progress_source: progress.last_progress_source,
        active_native_tool: activeTool, pending_permission_requests: pending.length }));
      if (shouldStopForNoProgress({ now, lastProgressAt: native.state.last_progress_at, threshold: READ_STALL_MS })) {
        stopReason = noProgressStopReason({ pendingPermissionCount: pending.length, activeTool });
        await client.session.interrupt({ sessionID: rootSession.id }, { signal: AbortSignal.timeout(5_000) }).then(
          () => { terminal = { interrupt_requested: true, error: null }; }, error => { terminal = { interrupt_requested: true, error: String(error) }; });
        break;
      }
      await sleep(250);
    }
    await Promise.race([promptPromise, sleep(10_000)]);
    await sleep(200);
    if (await exists(envInfo.logPath)) {
      const lines = (await readFile(envInfo.logPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
      while (observerEvents.length < lines.length) {
        const event = JSON.parse(lines[observerEvents.length]);
        observerEvents.push(event);
        if (event.phase === 'plugin-hook-before' || event.phase === 'plugin-hook-after')
          await appendFile(join(attempt, 'plugin-hook-events.jsonl'), `${JSON.stringify(event)}\n`);
      }
    }
    sessionState = await client.session.get({ sessionID: rootSession.id }).catch(error => ({ error: String(error) }));
    const latestPermissions = await pollPermissions(client, rootSession.id, attempt);
    permissionsSeen.push(latestPermissions);
    const exported = await client.session.export({ sessionID: rootSession.id }).catch(error => ({ export_error: String(error) }));
    await writeJson(join(attempt, 'native-session-export.json'), exported);
    const text = JSON.stringify(exported);
    const runtimeText = [...text.matchAll(/"text":"(\{[^"\\]*(?:\\.[^"\\]*)*\})"/gu)].map(match => {
      try { return JSON.parse(match[1]); } catch { return null; }
    }).find(value => value?.runtime?.runtime_asset_version);
    runtimeObservation = runtimeText?.runtime ?? null;
    const nativeEvents = [];
    for (const line of (await readFile(join(attempt, 'native-events.jsonl'), 'utf8').catch(() => '')).split(/\r?\n/u).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.name === 'read' || event.type?.startsWith('session.tool.')) nativeEvents.push(event);
    }
    const hookEvents = observerEvents.filter(event => event.tool === 'read');
    const expectedReads = diagnosticReadObservations(nativeEvents, hookEvents, targets);
    const calls = nativeEvents.filter(event => ['session.tool.called', 'session.tool.input.started'].includes(event.type) &&
      event.name === 'read').map(event => ({
      type: event.type, call_id: event.callID ?? event.call_id, name: event.name, path: event.path,
      created: event.created, observed_at: event.observed_at,
    }));
    const noProgressState = stopReason ? await readJson(join(attempt, 'progress.json')).catch(() => null) : null;
    const elapsed = Date.now() - promptStartedAt;
    const report = {
      schema_version: 1, version, attempt_number: attemptNumber, diagnostic_stage: diagnosticStage,
      runner_sha256: await hashFile(fileURLToPath(import.meta.url)),
      prompt_submitted: promptSubmitted, profile_sha256: await hashFile(join(STATE_ROOT, 'common/profile.json')),
      package_sha256: packageReceipt.sha256, package_integrity: packageReceipt.integrity,
      diagnosis_kind: 'local-native-tool-probe-not-benchmark-arm',
      status: promptError ? 'prompt-error' : stopReason ? 'stopped-no-progress' : promptSettled ? 'completed' : 'incomplete',
      root_session: rootSession.id, agent: 'dog-worker-v010', configured_model: route,
      host: { version: host.version, pid: host.pid ?? null }, observer_plugin_loaded: observerLoaded,
      sortie_plugin_loaded: Boolean(sortiePlugin), loaded_runtime: runtimeObservation,
      candidate_project_path: project, diagnostic_targets: targets.map(({ id, path, expected_presence }) => ({
        id, path, expected_presence,
      })),
      probe_elapsed_ms: elapsed, no_progress_timeout_ms: READ_STALL_MS,
      stop_reason: stopReason, prompt_settled: promptSettled, prompt_error: promptError,
      no_progress_state: noProgressState,
      session_state: { outcome: sessionState.outcome ?? null, idle: Boolean(sessionState.time?.idle),
        error: sessionState.error ?? null }, interruption: terminal,
      permission_observations: permissionsSeen, native_tool_calls: calls, native_tool_events: nativeEvents,
      target_read_observations: expectedReads,
      plugin_hook_observations: hookEvents,
      tool_hook_boundary_observed: hookEvents.some(event => event.phase === 'plugin-hook-before') &&
        hookEvents.some(event => event.phase === 'plugin-hook-after'),
      native_event_stream: { events_seen: native.state.events_seen, error: native.state.stream_error,
        last_progress_source: native.state.last_progress_source },
      pending_permission_at_end: latestPermissions.requests,
      interpretation: {
        established: 'native tool request/hook/event and permission.list/event observations below are direct for this isolated CLI 2.0.18 diagnostic session.',
        not_established: 'A missing permission row/event does not prove no request was pending outside the observation window; native tool events do not expose internal filesystem syscall stages.',
        policy: 'no permission allow/reject reply, no prompt replay, no replacement Worker, and no Anko benchmark arm was launched.',
      },
      credential_seed: credentialSeed,
      database_sanitization: null,
      record_path: recordPath,
      captured_at: new Date().toISOString(),
    };
    await writeJson(join(attempt, 'diagnosis.json'), report);
    await writeJson(join(attempt, 'probe-summary.json'), { root_session: rootSession.id,
      targets: expectedReads, hook_event_count: hookEvents.length, permission_snapshots: permissionsSeen.length,
      status: report.status, stop_reason: stopReason, elapsed_ms: elapsed });
    native.controller.abort();
    await Promise.race([native.task, sleep(3_000)]);
    await activeServer.stop();
    databaseSanitization = await sanitizeDatabase(envInfo.db, join(attempt, 'usage/opencode.db'), servers);
    report.database_sanitization = databaseSanitization;
    await writeJson(join(attempt, 'diagnosis.json'), report);
    assert.equal(databaseSanitization.status, 'sanitized');
    await copyDiagnostic(attempt, recordPath);
    await writeJson(latestPath, { at: new Date().toISOString(),
      attempt_number: attemptNumber, attempt_directory: attempt, result_filename: 'diagnosis.json', status: report.status,
      stop_reason: stopReason, root_session: rootSession.id, record_path: recordPath, benchmark_arm: false });
    console.log(JSON.stringify({ diagnosis: report.status, root_session: report.root_session,
      stop_reason: stopReason, probe_elapsed_ms: report.probe_elapsed_ms,
      native_read_calls: calls.length, read_hooks: hookEvents.length,
      permission_snapshots: permissionsSeen.length, record_path: recordPath }, null, 2));
    return report;
  } catch (error) {
    const report = { schema_version: 1, version, attempt_number: attemptNumber, status: 'diagnostic-error',
      error: String(error), diagnostic_stage: diagnosticStage, prompt_submitted: promptSubmitted,
      root_session: rootSession?.id ?? null, benchmark_arm: false, captured_at: new Date().toISOString(),
      stop_reason: stopReason, record_path: recordPath };
    await writeJson(join(attempt, 'diagnosis.json'), report).catch(() => undefined);
    await writeJson(latestPath, { ...report, attempt_directory: attempt }).catch(() => undefined);
    throw error;
  } finally {
    native?.controller.abort();
    if (native) await Promise.race([native.task, sleep(1_000)]);
    for (const server of [...servers].reverse()) await server.stop().catch(() => undefined);
    if (envInfo?.db && existsSync(envInfo.db)) {
      databaseSanitization ??= await sanitizeDatabase(envInfo.db, join(attempt, 'usage/opencode.db'), servers).catch(error => ({ status: 'failed', error: String(error) }));
      await writeJson(join(attempt, 'database-sanitization.json'), databaseSanitization).catch(() => undefined);
    }
    if (await exists(resultPath) && !(await exists(recordPath)) && databaseSanitization?.status === 'sanitized') {
      const report = await readJson(resultPath);
      report.database_sanitization = databaseSanitization;
      await writeJson(resultPath, report);
      await copyDiagnostic(attempt, recordPath).catch(() => undefined);
    }
  }
}

export { makeEnvironment, startServer, seedCredential, sanitizeDatabase, pluginObserver,
  nativeObserver, pollPermissions, copyDiagnostic, readJsonLines, diagnosticTargets };
