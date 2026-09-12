import { mkdir, writeFile, readFile, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess, shellQuote } from './release-process.mjs';
import { releaseProfile } from './release-profiles.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };
export async function command(executable, args, cwd, env, timeoutMs = 600_000) {
  const result = await runProcess(executable, args, { cwd, env: { ...process.env, ...env, PWD: cwd }, timeoutMs });
  if (executable === 'wsl.exe') {
    for (const line of result.stderr.split(/\r?\n/)) {
      try { const evidence = JSON.parse(line); if (['checkpoint', 'outcome'].includes(evidence.phase)) process.stderr.write(JSON.stringify(evidence) + '\n'); }
      catch { /* only typed fixture diagnostics are forwarded */ }
    }
  }
  assert(result.code === 0 && !result.timedOut && !result.overflow, `${executable} failed (exit ${result.code}); output not persisted`);
  return result.stdout;
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
  const cliVersion = (await command('opencode', ['--version'], project, env)).trim();
  assert(/^\d+\.\d+\.\d+/.test(cliVersion), 'Cannot identify CLI version');
  const dependency = `file:${relative(control, tgz).replaceAll('\\', '/')}`;
  await writeFile(join(control, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { 'sortie-dogs': dependency, '@opencode-ai/plugin': cliVersion } }, null, 2));
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
  const coordinatorAgent = `dog-coordinator${runtime.agentSuffix}`, workerAgent = `dog-worker${runtime.agentSuffix}`;
  await mkdir(join(project, 'child', runtime.stateDirectory, 'contracts'), { recursive: true });
  const { acceptanceContinuityFingerprint } = await import(pathToFileURL(join(installed, 'dist/core/acceptance-continuity.js')).href);
  const { reduceGoalFlight } = await import(pathToFileURL(join(installed, 'dist/core/goal-bound.js')).href);
  const legacy = join(installed, 'dist/plugin/legacy.js');
  const entry = release.runtimeProfile === 'stable' && await lstat(legacy).then(info => info.isFile()).catch(() => false)
    ? legacy : join(installed, 'dist/plugin/opencode.js');
  await writeFile(join(control, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
    plugin: [pathToFileURL(entry).href] }, null, 2));
  await command('node', [join(installed, 'dist/cli/main.js'), 'init', project,
    ...(profiles ? ['--profile', release.runtimeProfile] : [])], project, env);
  for (const asset of runtimeAssets) assert((await readFile(join(control, asset.installPath), 'utf8')) === asset.content, 'CLI asset mismatch');
  return { run, project, control, env, installed, pkg, runtime, release, coordinatorAgent, workerAgent,
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
  async function cli(prompt, sessionID) {
    // timeout runs in WSL: Windows killing wsl.exe alone does not establish guest process cleanup.
    return jsonEvents(await command('timeout', ['--signal=TERM', '--kill-after=10s', '540s', 'opencode', 'run',
      '--dir', project, '--format', 'json', '--print-logs', '--agent', coordinatorAgent, ...(sessionID ? ['--session', sessionID] : []), prompt], project, env, 580_000));
  }
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
  validation: { level: full, command: node child/validate.mjs, diagnostics: [] }
  known_facts: ["The manifest and content oracle are fixed."]
  known_paths: ["child/result.txt","child/validate.mjs"]
  relevant_constraints: ["Read handoff before binding in a subsequent tool round.","Patch child/result.txt from the workspace root; do not commit."]
  resume_delta: none
source_manifest: ["result.txt","validate.mjs"]
operation_manifest: ${runtime.stateDirectory}/contracts/recovery.operation-manifest.json
goal_acceptance_fingerprint: ${fingerprint}
goal_budget_units: 8
delivery_intent: implementation
delivery_mode: repair-first
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
  const events = await cli(`Resume this same goal. Check the supplied contract, then dispatch one ${workerAgent} with this full ready-to-send context_digest and goal declaration. This is the direct one-worker fast path; no operator plan is needed. The Task prompt must contain exactly one acceptance header, one validation header, one source_manifest header and one project_root header. Preserve the structured declaration below verbatim and append only prose instructions. Worker must Read the absolute handoff path, wait for Read completion, then bind in a separate tool round. Use apply_patch on exactly child/result.txt to replace seed with recovered. Native tool CWD is ${project}; project_root for bind is ${join(project, 'child')}. Run exactly node child/validate.mjs from ${project}. No alternate editing tool or path, no commit. If admission or validation fails, stop and report it. Complete terminally only after canonical PASS.\n${declaration}`, sessionID);
  const records = JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events;
  const state = reduceGoalFlight(records);
  const workerStarted = events.some(event => event.type === 'tool_use' && event.part?.tool === 'task' && event.part.state?.status === 'completed');
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
