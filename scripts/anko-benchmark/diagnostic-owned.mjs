import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_ROOT, CLI_VERSION, SOURCE_PROJECT, READ_STALL_MS, ROOT_MODEL, WORKER_MODEL,
  diagnosticRoot, diagnosticReadObservations, exists, hashFile, noProgressStopReason,
  packageReceiptPath, profilePath, readJson, versionRoot, writeExclusive, writeJson } from './core.mjs';
import { makeEnvironment, startServer, seedCredential, sanitizeDatabase, pluginObserver,
  nativeObserver, pollPermissions, copyDiagnostic, readJsonLines, diagnosticTargets } from './diagnose.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

export async function diagnoseVersion(version) {
  const root = diagnosticRoot(version);
  const pointer = join(root, 'diagnosis-latest.json');
  const previousPath = await exists(pointer) ? pointer : join(root, 'diagnosis-terminal.json');
  const previous = await exists(previousPath) ? await readJson(previousPath) : null;
  const old = previous ? await readJson(join(previous.attempt_directory, previous.result_filename ?? 'diagnosis.json')) : null;
  if (old?.diagnostic_stage === 'admitted-worker-read-probe') {
    console.log(JSON.stringify({ diagnosis: 'reused', status: old.status, record_path: old.record_path }));
    return old;
  }
  if (previous) {
  assert.equal(previous.attempt_number, 4, 'inspect the corrected hook diagnostic before changing its admission route');
  if (old.host?.pid) execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `if (Get-Process -Id ${Number(old.host.pid)} -ErrorAction SilentlyContinue) { exit 1 }`], { stdio: 'ignore' });
  const previousExport = await readJson(join(previous.attempt_directory, 'native-session-export.json'));
  const rejected = previousExport.messages.flatMap(item => item.content ?? []).filter(item => item.type === 'tool');
  assert.equal(rejected.length, 3);
  assert(rejected.every(item => item.executed === false && item.state?.error?.message?.startsWith('runtime-profile-session-inactive')),
    'new local probe requires observed admission-route defect, not an unchanged-task retry');
  }

  const attemptNumber = previous ? previous.attempt_number + 1 : 1;
  const output = join(root, `attempt-${attemptNumber}`);
  const lock = join(root, attemptNumber === 1 ? 'diagnose-once.lock' : `diagnose-attempt-${attemptNumber}.lock`);
  const recordPath = join(ARTIFACT_ROOT, `v${version}/diagnosis/attempt-${attemptNumber}`);
  await writeExclusive(lock, JSON.stringify({ version, attempt_number: attemptNumber, benchmark_arm: false,
    changed_route: previous ? 'formal readonly Worker admission; previous standalone Worker rejected' : 'formal readonly Worker admission', at: new Date().toISOString() }));
  await mkdir(output, { recursive: true });
  const project = join(output, 'project');
  const servers = [];
  let env, native, client, host, rootSession, stopReason = null, interruption = [], report, sanitize;
  const snapshots = [];
  const startedAt = Date.now();
  try {
    git(['clone', '--no-hardlinks', SOURCE_PROJECT, project]);
    git(['remote', 'remove', 'origin'], project);
    await cp(join(SOURCE_PROJECT, '.git/info/exclude'), join(project, '.git/info/exclude'));
    await cp(join(versionRoot(version), 'template-project/.opencode'), join(project, '.opencode'), { recursive: true });
    await pluginObserver(project);
    env = await makeEnvironment(output, project, join(project, '.opencode'));
    for (const name of ['native-events.jsonl', 'native-hook-events.jsonl', 'plugin-hook-events.jsonl', 'permission-snapshots.jsonl'])
      await writeFile(join(output, name), '', { flag: 'wx' });
    const first = await startServer(env.env, output, project);
    servers.push(first);
    await first.client.server.info();
    await first.stop();
    await seedCredential(env.db);
    const server = await startServer(env.env, output, project);
    servers.push(server);
    client = server.client;
    host = await client.server.info();
    assert.equal(host.version, CLI_VERSION);
    let plugins;
    const readinessDeadline = Date.now() + 45_000;
    do {
      plugins = (await client.plugin.list({ location: { directory: project } })).data ?? [];
      if (plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active') &&
        plugins.some(item => item.id === 'anko-benchmark-observer' && item.state.status === 'active')) break;
      await sleep(250);
    } while (Date.now() < readinessDeadline);
    assert(plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active'));
    rootSession = await client.session.create({ title: 'Anko正式Workerのread境界局所診断・本体ではない',
      agent: 'dog-operator', model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'xhigh' },
      location: { directory: project } });
    native = nativeObserver(client, output, rootSession.id);
    const targets = diagnosticTargets(project);
    const text = `日本語で応答・Task作成。これはAnko実装ベンチ本体ではなく、同じpackage/model/権限でのnative read境界局所診断。原文実装課題は実行しない。sortie_v010_start_missionでread-only unitを1つ直接登録して返されたWorker Taskをそのままforeground派遣する（別Coordinator不要）。要求はWorkerが次の3pathをnative readで順に各1回読むだけ: ${targets.map(item => item.path).join('、')}。repo内既存go.mod、不在AGENTS、repo外祖先AGENTSを比較する。unit write: []、read: ['go.mod']、validation: ['git diff --exit-code']。objectiveへ3pathと各1回native readの順序を明記。Workerはshell/glob/grepでreadを代替せず、改変/権限返信/追加Worker/再送しない。git diff --exit-codeは調査後の非改変検証だけ。本体実装、commit、release、global適用、採点はしない。Rootは開始時operator_statusでloaded runtimeを記録する。permission要求なら観測のみ、180秒無進捗でrunnerがowned sessionを停止する。診断結果の報告だけで終了する。`;
    await writeFile(join(output, 'request.txt'), text, { flag: 'wx' });
    await client.session.prompt({ sessionID: rootSession.id, text, delivery: 'queue', resume: true },
      { signal: AbortSignal.timeout(10_000) });
    let states = [], hooks = [], lastLog = 0;
    while (true) {
      const listing = (await client.session.list({ directory: project, limit: 100 }, { signal: AbortSignal.timeout(5_000) })).data ?? [];
      const owned = new Set([rootSession.id]);
      for (let i = 0; i < listing.length; i++) for (const session of listing)
        if (owned.has(session.parentID)) owned.add(session.id);
      for (const id of owned) native.owned.add(id);
      states = await Promise.all([...owned].map(sessionID => client.session.get({ sessionID },
        { signal: AbortSignal.timeout(5_000) })));
      for (const id of owned) snapshots.push(await pollPermissions(client, id, output));
      hooks = await readJsonLines(env.logPath);
      const pending = snapshots.slice(-owned.size).flatMap(item => item.requests);
      const activeTool = [...native.tools.values()].at(-1) ?? null;
      const now = Date.now();
      const progress = { at: new Date().toISOString(), elapsed_ms: now - startedAt,
        no_progress_ms: now - native.state.last_progress_at, last_progress_source: native.state.last_progress_source,
        active_native_tool: activeTool, pending_permission_requests: pending, owned_sessions: states.map(item => ({
          id: item.id, agent: item.agent, outcome: item.outcome, idle: Boolean(item.time?.idle) })) };
      await writeJson(join(output, 'progress.json'), progress);
      if (now - lastLog >= 15_000) { console.log(JSON.stringify({ phase: 'admitted-diagnostic-progress', ...progress })); lastLog = now; }
      if (states.every(item => item.outcome || item.time?.idle)) break;
      if (progress.no_progress_ms >= READ_STALL_MS) {
        stopReason = noProgressStopReason({ pendingPermissionCount: pending.length, activeTool });
        for (const item of states.filter(item => !item.outcome && !item.time?.idle)) {
          await client.session.interrupt({ sessionID: item.id }, { signal: AbortSignal.timeout(5_000) }).then(
            () => interruption.push({ session_id: item.id, interrupt_requested: true }),
            error => interruption.push({ session_id: item.id, interrupt_requested: true, error: String(error) }));
        }
        await sleep(1_000);
        break;
      }
      assert.equal(native.state.stream_error, null);
      await sleep(1_000);
    }
    const exports = await Promise.all([...native.owned].map(sessionID => client.session.export({ sessionID },
      { signal: AbortSignal.timeout(5_000) })));
    await writeJson(join(output, 'native-session-export.json'), { sessions: exports });
    hooks = await readJsonLines(env.logPath);
    const events = await readJsonLines(join(output, 'native-events.jsonl'));
    const readHooks = hooks.filter(item => ['plugin-hook-before', 'plugin-hook-after'].includes(item.phase) && item.tool === 'read');
    await writeFile(join(output, 'plugin-hook-events.jsonl'), readHooks.map(item => JSON.stringify(item)).join('\n') + '\n');
    const observations = diagnosticReadObservations(events, readHooks, targets);
    report = { schema_version: 1, version, attempt_number: attemptNumber,
      diagnostic_stage: 'admitted-worker-read-probe', runner_sha256: await hashFile(fileURLToPath(import.meta.url)),
      diagnosis_kind: 'local-native-tool-probe-not-benchmark-arm', prompt_submitted: true,
      prompt_replayed: false, package_sha256: (await readJson(packageReceiptPath(version))).sha256,
      profile_sha256: await hashFile(profilePath()), root_session: rootSession.id,
      host: { version: host.version, pid: host.pid }, observer_plugin_loaded: true,
      candidate_project_path: project, diagnostic_targets: targets,
      configured_model: ROOT_MODEL, configured_worker_model: WORKER_MODEL,
      status: stopReason ? 'stopped-no-progress' : 'completed', stop_reason: stopReason,
      probe_elapsed_ms: Date.now() - startedAt, no_progress_timeout_ms: READ_STALL_MS,
      no_progress_state: await readJson(join(output, 'progress.json')),
      interruption: { interrupt_requested: interruption.length > 0, requests: interruption },
      target_read_observations: observations, permission_observations: snapshots,
      native_tool_calls: events.filter(item => item.name === 'read' && item.type === 'session.tool.called'),
      native_tool_events: events, plugin_hook_observations: readHooks,
      native_event_stream: { error: native.state.stream_error, events_seen: events.length },
      interpretation: { policy: 'no permission allow/reject reply; admitted read-only Worker; no Anko benchmark arm',
        not_established: 'filesystem syscall stages are not observable; historical permission waiting remains unconfirmed' },
      record_path: recordPath };
  } finally {
    native?.controller.abort();
    if (native) await Promise.race([native.task, sleep(1_000)]);
    for (const server of servers.toReversed()) await server.stop();
    if (env?.db) sanitize = await sanitizeDatabase(env.db, join(output, 'usage/opencode.db'), servers);
  }
  assert.equal(sanitize.status, 'sanitized');
  report.database_sanitization = sanitize;
  await writeJson(join(output, 'diagnosis.json'), report, { flag: 'wx' });
  await copyDiagnostic(output, recordPath);
  await writeJson(pointer, { attempt_number: attemptNumber, attempt_directory: output, result_filename: 'diagnosis.json',
    status: report.status, record_path: recordPath, benchmark_arm: false });
  console.log(JSON.stringify({ diagnosis: report.status, stop_reason: stopReason, target_read_observations: report.target_read_observations,
    elapsed_ms: report.probe_elapsed_ms, record_path: recordPath }, null, 2));
  return report;
}
