import { mkdir, writeFile, readFile, lstat, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess, shellQuote } from './release-process.mjs';
import { releaseProfile } from './release-profiles.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };
export const fixtureOpenCodeConfig = (entry, runtime, openCodeVersion = '1.0.0') => ({
  $schema: 'https://opencode.ai/config.json',
  ...(runtime.id === 'v010' ? { experimental: { subagent_depth: 2 } } : {}),
  [Number.parseInt(openCodeVersion.split('.')[0], 10) >= 2 ? 'plugins' : 'plugin']: [pathToFileURL(entry).href],
});
export const parseOpenCodeVersion = output => output.trim().match(/(?:^|\bv)(\d+\.\d+\.\d+)(?:\b|$)/)?.[1];
export const pluginPackageForOpenCodeVersion = version => Number.parseInt(version.split('.')[0], 10) >= 2
  ? '@opencode/plugin' : '@opencode-ai/plugin';
export const runLocationArgsForOpenCodeVersion = (version, project, serverURL) =>
  Number.parseInt(version.split('.')[0], 10) >= 2
    ? serverURL === undefined ? ['--standalone'] : ['--server', serverURL]
    : ['--dir', project];
export const RELEASE_SMOKE_RUN_TIMEOUT_SECONDS = 900;
export const RELEASE_SMOKE_TERMINAL_TIMEOUT_SECONDS = 180;
export const RELEASE_SMOKE_TERMINAL_PROMPT =
  'The recovery unit is already settled as succeeded with canonical PASS. Do not call tools, dispatch, validate, or edit. ' +
  'Reply with `status: DONE` as the first conclusion line and report this same goal complete.';
export const v2PluginWrapperSource = runtime => `import { createSortieDogsV2Plugin } from "sortie-dogs/server";\n` +
  `import { SortieDogsPlugin } from "${runtime.id === 'stable' ? 'sortie-dogs/plugin/stable' : 'sortie-dogs/plugin'}";\n` +
  `export default createSortieDogsV2Plugin(SortieDogsPlugin);\n`;
export const releaseSmokeWorkerStarted = (events, records, unitID) =>
  events.some(event => event.type === 'tool_use' && event.part?.tool === 'task' && event.part.state?.status === 'completed') ||
  records.some(({ event }) => event.kind === 'unit.settled' && event.unit_id === unitID && event.disposition === 'succeeded');
export async function command(executable, args, cwd, env, timeoutMs = 600_000) {
  const result = await runProcess(executable, args, { cwd, env: { ...process.env, ...env, PWD: cwd }, timeoutMs });
  if (executable === 'wsl.exe') {
    for (const line of result.stderr.split(/\r?\n/)) {
      try { const evidence = JSON.parse(line); if (['checkpoint', 'outcome'].includes(evidence.phase)) process.stderr.write(JSON.stringify(evidence) + '\n'); }
      catch { /* only typed fixture diagnostics are forwarded */ }
    }
  }
  if (result.code !== 0 || result.timedOut || result.overflow) {
    const error = Error(`${executable} failed (exit ${result.code}); output not persisted`);
    // Keep bounded process output in memory so a caller can extract typed evidence.
    // It is deliberately non-enumerable to prevent accidental raw-log persistence.
    Object.defineProperty(error, 'processResult', { value: result });
    throw error;
  }
  return result.stdout;
}

async function stopProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const signal = name => { try { process.kill(-child.pid, name); } catch { /* exited */ } };
  signal('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      signal('SIGKILL');
      const killTimer = setTimeout(resolve, 2_000);
      child.once('close', () => { clearTimeout(killTimer); resolve(); });
    }, 5_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

export async function startV2ReleaseServer(cwd, env) {
  const password = randomBytes(24).toString('hex');
  const serverEnv = { ...process.env, ...env, PWD: cwd, OPENCODE_SERVER_PASSWORD: password };
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd, env: serverEnv, shell: false, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  try {
    const url = await new Promise((resolveReady, rejectReady) => {
      let output = '';
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      };
      const fail = error => { cleanup(); rejectReady(error); };
      const onError = error => fail(error);
      const onClose = code => fail(Error(`OpenCode V2 release server exited before readiness (${code})`));
      const onData = data => {
        output = (output + data.toString()).slice(-8_192);
        const match = /server listening on (http:\/\/127\.0\.0\.1:[1-9][0-9]*)/u.exec(output);
        if (match === null) return;
        cleanup();
        child.stdout.resume();
        resolveReady(match[1]);
      };
      const timer = setTimeout(() => fail(Error('OpenCode V2 release server readiness timeout')), 30_000);
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('close', onClose);
    });
    return { url, env: serverEnv, stop: () => stopProcessGroup(child) };
  } catch (error) {
    await stopProcessGroup(child);
    throw error;
  }
}

export async function installedFixture(tgz, directory, profileId = 'stable') {
  const release = releaseProfile(profileId);
  // A failed attempt remains available; retries use a fresh fixture, never overwrite its ledger.
  await mkdir(directory, { recursive: true });
  let attempt = 1;
  const names = await readdir(directory);
  while (names.includes(`smoke-${attempt}`)) attempt++;
  const run = join(directory, `smoke-${attempt}`), project = join(run, 'project');
  const control = join(project, '.opencode');
  await mkdir(control, { recursive: true });
  const xdg = join(run, 'xdg');
  await mkdir(join(xdg, 'opencode'), { recursive: true });
  await writeFile(join(xdg, 'opencode/opencode.json'), '{}\n');
  const env = { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: join(xdg, 'opencode'), OPENCODE_CONFIG: join(xdg, 'opencode/opencode.json') };
  const cliVersion = parseOpenCodeVersion(await command('opencode', ['--version'], project, env));
  assert(cliVersion, 'Cannot identify CLI version');
  const dependency = `file:${relative(control, tgz).replaceAll('\\', '/')}`;
  const pluginPackage = pluginPackageForOpenCodeVersion(cliVersion);
  await writeFile(join(control, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { 'sortie-dogs': dependency, [pluginPackage]: cliVersion } }, null, 2));
  await command('npm', ['install', '--force'], control, env);
  const installed = join(control, 'node_modules/sortie-dogs');
  assert(!(await lstat(installed)).isSymbolicLink(), 'Fixture package is a link');
  const packageJSON = JSON.parse(await readFile(join(control, 'package.json'), 'utf8'));
  assert(packageJSON.dependencies['sortie-dogs'] === dependency, 'Fixture dependency was rewritten');
  const lock = JSON.parse(await readFile(join(control, 'package-lock.json'), 'utf8'));
  assert(lock.packages['node_modules/sortie-dogs']?.link !== true &&
    typeof lock.packages['node_modules/sortie-dogs']?.integrity === 'string', 'Fixture lock must bind a tarball');
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const versions = await import(pathToFileURL(join(installed, 'dist/asset-version.js')).href);
  const RUNTIME_ASSET_VERSION = versions[release.markerExport];
  const { runtimeAssets } = await import(pathToFileURL(join(installed, 'dist', release.assetsModule)).href);
  const profiles = await import(pathToFileURL(join(installed, 'dist/core/runtime-profile.js')).href).catch(() => undefined);
  const runtime = profiles?.RUNTIME_PROFILES[release.runtimeProfile] ?? { id: 'stable', stateDirectory: '.sortie-dogs', agentSuffix: '' };
  const coordinatorAgent = profiles?.profileAgent(runtime, 'dog-coordinator') ?? `dog-coordinator${runtime.agentSuffix}`;
  const operatorAgent = profiles?.profileAgent(runtime, 'dog-operator') ?? `dog-operator${runtime.agentSuffix}`;
  const workerAgent = profiles?.profileAgent(runtime, 'dog-worker') ?? `dog-worker${runtime.agentSuffix}`;
  await mkdir(join(project, 'child', runtime.stateDirectory, 'contracts'), { recursive: true });
  const { acceptanceContinuityFingerprint } = await import(pathToFileURL(join(installed, 'dist/core/acceptance-continuity.js')).href);
  const { reduceGoalFlight } = await import(pathToFileURL(join(installed, 'dist/core/goal-bound.js')).href);
  const legacy = join(installed, 'dist/plugin/legacy.js');
  const entry = release.runtimeProfile === 'stable' && await lstat(legacy).then(info => info.isFile()).catch(() => false)
    ? legacy : join(installed, 'dist/plugin/opencode.js');
  let pluginTarget = entry;
  if (Number.parseInt(cliVersion.split('.')[0], 10) >= 2) {
    pluginTarget = join(control, 'plugins', 'sortie-dogs');
    await mkdir(pluginTarget, { recursive: true });
    await writeFile(join(pluginTarget, 'index.js'), v2PluginWrapperSource(runtime));
  }
  await writeFile(join(control, 'opencode.json'), JSON.stringify(fixtureOpenCodeConfig(pluginTarget, runtime, cliVersion), null, 2));
  await command('node', [join(installed, 'dist/cli/main.js'), 'init', project,
    ...(profiles ? ['--profile', release.runtimeProfile] : [])], project, env);
  for (const asset of runtimeAssets) assert((await readFile(join(control, asset.installPath), 'utf8')) === asset.content, 'CLI asset mismatch');
  return { run, project, control, env, installed, pkg, runtime, release, coordinatorAgent, operatorAgent, workerAgent,
    cliVersion, runtimeMarker: RUNTIME_ASSET_VERSION, acceptanceContinuityFingerprint, reduceGoalFlight };
}

export async function inside(tgz, directory, profileId = 'stable') {
  const { project, env, pkg, runtime, release, coordinatorAgent, workerAgent, cliVersion,
    runtimeMarker: RUNTIME_ASSET_VERSION, acceptanceContinuityFingerprint, reduceGoalFlight } = await installedFixture(tgz, directory, profileId);
  await writeFile(join(project, 'AGENTS.md'), '# Release fixture\nNative file paths resolve from this workspace. Use the supplied nested manifest. Do not edit contracts, tests, or package files. Workers must not commit.\n');
  await writeFile(join(project, '.gitignore'), `.opencode/\n${runtime.stateDirectory}/\nchild/${runtime.stateDirectory}/\n`);
  await writeFile(join(project, 'child/result.txt'), 'seed\n');
  await writeFile(join(project, 'child/validate.mjs'), "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./result.txt',import.meta.url),'utf8')).trim(),'recovered');console.log('RELEASE_SMOKE_PASS');\n");
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'child/result.txt', 'child/validate.mjs'], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initialize release fixture'], project, env);
  const criterion = 'result.txt equals recovered and canonical validation passes';
  const fingerprint = acceptanceContinuityFingerprint([criterion]);
  const handoff = join(project, 'child', runtime.stateDirectory, 'contracts/handoff.recovery.json');
  const manifest = { version: '0.1.0', task_id: 'recovery', read: ['result.txt', 'validate.mjs'], write: ['result.txt'], validation: ['node child/validate.mjs'] };
  await writeFile(join(project, 'child', runtime.stateDirectory, 'contracts/recovery.operation-manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(handoff, JSON.stringify({ version: '0.1.0', profile: 'minimal', id: 'recovery', created_at: new Date().toISOString(),
    task: { title: 'Release smoke', objective: criterion }, state: { done: [], next: ['Patch child/result.txt, then validate.'], blocked: [] }, risks: [],
    verification: [{ check: 'node child/validate.mjs', status: 'not_run', exit_code: null, summary: 'Content oracle' }],
    ext: { 'sortie-dogs/write-gate': { project_root: join(project, 'child'), operation_manifest: `${runtime.stateDirectory}/contracts/recovery.operation-manifest.json` },
      'sortie-dogs/acceptance-continuity': { schema_version: '0.1', authority: 'dispatch', task_id: 'recovery', criteria: [criterion], fingerprint, parent_fingerprint: 'none' } } }, null, 2));
  const jsonEvents = text => text.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const v2Server = Number.parseInt(cliVersion.split('.')[0], 10) >= 2
    ? await startV2ReleaseServer(project, env) : undefined;
  const cliEnv = v2Server?.env ?? env;
  async function cli(prompt, sessionID, timeoutSeconds = RELEASE_SMOKE_RUN_TIMEOUT_SECONDS) {
    // timeout runs in WSL: Windows killing wsl.exe alone does not establish guest process cleanup.
    return jsonEvents(await command('timeout', ['--signal=TERM', '--kill-after=10s', `${timeoutSeconds}s`, 'opencode', 'run',
      ...runLocationArgsForOpenCodeVersion(cliVersion, project, v2Server?.url), '--format', 'json', '--print-logs', '--agent', coordinatorAgent,
      ...(Number.parseInt(cliVersion.split('.')[0], 10) >= 2 ? ['--model', 'openai/gpt-6-sol#xhigh'] : []),
      ...(sessionID ? ['--session', sessionID] : []), prompt], project, cliEnv, (timeoutSeconds + 40) * 1_000));
  }
  const executeSmoke = async () => {
  const checkpoint = await cli('Open a goal for this release fixture. Do not call tools. Reply exactly RELEASE_CHECKPOINT without terminal status.');
  const sessionID = checkpoint.find(event => event.sessionID)?.sessionID;
  assert(sessionID?.startsWith('ses_'), 'No initial CLI session');
  process.stderr.write(JSON.stringify({ phase: 'checkpoint', sessionID, events: checkpoint.map(event => event.type), cliVersion }) + '\n');
  const ledgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory ?? 'run-flight', `${hash(runtime.id === 'stable' ? sessionID : `${runtime.id}\u0000${sessionID}`)}.json`);
  const initial = reduceGoalFlight(JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events);
  assert(initial.goal_id && initial.phase !== 'terminal', 'Checkpoint did not retain active goal');
  const declaration = `task_id: recovery
context_digest:
  project_root: ${join(project, 'child')}
  handoff_path: ${handoff}
  acceptance:
    - ${criterion}
  role: implementation
  validation: { level: targeted, command: node child/validate.mjs, diagnostics: [] }
  known_facts: ["The manifest and content oracle are fixed."]
  known_paths: ["child/result.txt","child/validate.mjs"]
  relevant_constraints: ["Read handoff before binding in a subsequent tool round.","Patch child/result.txt from the workspace root; do not commit."]
  resume_delta: none
source_manifest: ["result.txt","validate.mjs"]
operation_manifest: ${runtime.stateDirectory}/contracts/recovery.operation-manifest.json
goal_acceptance_fingerprint: ${fingerprint}
goal_budget_units: 8
delivery_intent: implementation
 delivery_mode: mvp-first
usable_path_established: false
controlled_change: false
goal_criterion_id: recovered-result
goal_target: recovered content
goal_entrypoint: child/validate.mjs
goal_workload: one nested file
goal_oracle_coverage: ["result.txt content"]
goal_build_boundary: not-applicable
goal_source: protected source
goal_candidate: protected candidate
goal_source_binding: current-protected
goal_candidate_binding: current-protected
goal_validation_command: node child/validate.mjs
goal_fixture: release-smoke
 goal_proof_scope: requested-full
goal_expected_outcome: pass`;
   let events = await cli(`Resume this same goal. User requirement: replace only child/result.txt seed with recovered and run node child/validate.mjs, accepting only canonical PASS. Follow the v0.10 Operator protocol, including begin_operator_proposal with bounded read/submission scope; dispatch its exact dogs-coordinator proposal Task; compare and approve the submitted proposal; then launch the operator run. This is one implementation unit, so the host may return a direct ${workerAgent} fast-path Task after approval: dispatch only that exact returned Task, never invent a worker Task or bypass approval. Keep the following goal declaration and context_digest verbatim in the accepted plan. The Task prompt must contain exactly one acceptance header, one validation header, one source_manifest header and one project_root header. Worker must Read the absolute handoff path, wait for Read completion, then bind in a separate tool round. Use apply_patch on exactly child/result.txt to replace seed with recovered. Native tool CWD is ${project}; project_root for bind is ${join(project, 'child')}. Run exactly node child/validate.mjs from ${project}. No alternate editing tool or path, no commit. If admission or validation fails, stop and report it. Complete terminally only after canonical PASS.\n${declaration}`, sessionID);
  let records = JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events;
  let state = reduceGoalFlight(records);
  let workerStarted = releaseSmokeWorkerStarted(events, records, 'recovery');
  const waitForTerminal = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    while (state.phase !== 'terminal' && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      records = JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events;
      state = reduceGoalFlight(records);
    }
  };
  if (workerStarted && state.phase !== 'terminal') await waitForTerminal(1_000);
  if (workerStarted && state.phase !== 'terminal') {
    events = [...events, ...await cli(RELEASE_SMOKE_TERMINAL_PROMPT, sessionID, RELEASE_SMOKE_TERMINAL_TIMEOUT_SECONDS)];
    records = JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events;
    state = reduceGoalFlight(records);
    await waitForTerminal(5_000);
    workerStarted = releaseSmokeWorkerStarted(events, records, 'recovery');
  }
  process.stderr.write(JSON.stringify({ phase: 'outcome', sessionID, phaseState: state.phase, stopReason: state.stop_reason,
    tools: events.filter(event => event.type === 'tool_use').map(event => ({ tool: event.part?.tool,
      status: event.part?.state?.status, error: event.part?.state?.error?.split('\n')[0] })) }) + '\n');
  assert(workerStarted && state.goal_id === initial.goal_id && state.receipt?.status === 'succeeded', 'CLI did not complete the same goal');
  // Independent content oracle plus native host-recorded validation, not model prose.
  await command('node', ['child/validate.mjs'], project, env);
  const validation = records.some(({ event }) => event.kind === 'unit.settled' && event.evidence.some(item =>
    item.execution.exit_code === 0 && item.execution.outcome === 'pass' && item.execution.command.join(' ') === 'node child/validate.mjs'));
  assert(validation, 'No native successful canonical evidence');
  return { schema: 1, version: pkg.version, profile: release.runtimeProfile, sha256: hash(await readFile(tgz)), runtimeMarker: RUNTIME_ASSET_VERSION,
    cliVersion, sessionID, beforeSession: sessionID, sameGoal: true, workerStarted,
    canonicalExit: 0, terminal: 'succeeded', artifactMatch: true };
  };
  try { return await executeSmoke(); }
  finally { await v2Server?.stop(); }
}

async function main() {
  const tgz = process.argv[2] && resolve(process.argv[2]), directory = process.argv[3] && resolve(process.argv[3]);
  const profileId = process.argv[4] ?? 'stable';
  assert(tgz && directory, 'tarball and receipt directory required');
  if (process.platform !== 'win32') { console.log(JSON.stringify(await inside(tgz, directory, profileId))); return; }
  const linuxPath = async path => (await command('wsl.exe', ['-e', 'wslpath', '-a', path], process.cwd())).trim();
  const [linuxTgz, linuxDirectory, script] = await Promise.all([linuxPath(tgz), linuxPath(directory), linuxPath(import.meta.filename)]);
  const output = await command('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s 1440s node ${[script, linuxTgz, linuxDirectory, profileId].map(shellQuote).join(' ')}`], process.cwd(), {}, 1_500_000);
  console.log(JSON.stringify(JSON.parse(output.trim())));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
