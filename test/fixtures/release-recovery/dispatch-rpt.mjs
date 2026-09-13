import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess, shellQuote } from '../../../scripts/release-process.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const assert = (value, message) => { if (!value) throw Error(message); };
async function run(command, args, cwd, env, timeoutMs = 300000) {
  const result = await runProcess(command, args, { cwd, env: { ...process.env, ...env, PWD: cwd }, timeoutMs });
  assert(result.code === 0 && !result.timedOut, `${command} failed: exit ${result.code}`);
  return result.stdout;
}

async function inside(candidate, baseline, directory) {
  const area = join(directory, `dispatch-rpt-${Date.now()}`), root = join(area, 'project');
  const control = join(root, '.opencode'), xdg = join(area, 'xdg');
  await mkdir(join(root, '.sortie-dogs/contracts'), { recursive: true });
  await mkdir(control, { recursive: true }); await mkdir(join(xdg, 'opencode'), { recursive: true });
  await writeFile(join(xdg, 'opencode/opencode.json'), '{}');
  const delayPlugin = join(control, 'read-delay.mjs');
  await writeFile(delayPlugin, `export default async () => ({"tool.execute.before": async (input, output) => {
    if (input.tool === "read" && /handoff\\.recovery\\.json$/.test(output.args?.filePath ?? ""))
      await new Promise(resolve => setTimeout(resolve, 100));
  }});\n`);
  const env = { XDG_CONFIG_HOME: xdg, PWD: root };
  const cliVersion = (await run('opencode', ['--version'], root, env)).trim();
  await writeFile(join(root, 'AGENTS.md'), '# Release dispatch fixture\nChange result.txt only. Read and bind may be scheduled in the same tool round. The host must validate the exact handoff. No commit by workers.\n');
  await writeFile(join(root, '.gitignore'), '.opencode/\n.sortie-dogs/\n');
  await writeFile(join(root, 'result.txt'), 'seed\n');
  await writeFile(join(root, 'validate.mjs'), "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile('result.txt','utf8')).trim(),'recovered');console.log('DISPATCH_RPT_PASS');\n");
  await run('git', ['init', '-q', '-b', 'main'], root, env);
  await run('git', ['add', '--', 'AGENTS.md', '.gitignore', 'result.txt', 'validate.mjs'], root, env);
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initialize dispatch fixture'], root, env);
  const installed = join(control, 'node_modules/sortie-dogs');
  async function install(tgz) {
    const bytes = await readFile(tgz), archive = join(area, `${hash(bytes)}.tgz`);
    await copyFile(tgz, archive);
    const dependency = `file:${relative(control, archive)}`;
    await writeFile(join(control, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dependencies: { 'sortie-dogs': dependency, '@opencode-ai/plugin': cliVersion } }));
    await run('npm', ['install', '--force'], control, env);
    assert(!(await lstat(installed)).isSymbolicLink(), 'fixture cannot be a package link');
    assert(JSON.parse(await readFile(join(control, 'package.json'), 'utf8')).dependencies['sortie-dogs'] === dependency, 'dependency rewritten');
    const lock = JSON.parse(await readFile(join(control, 'package-lock.json'), 'utf8'));
    assert(lock.packages['node_modules/sortie-dogs'].integrity === `sha512-${createHash('sha512').update(bytes).digest('base64')}`, 'installed integrity mismatch');
    await writeFile(join(control, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
      plugin: [pathToFileURL(join(installed, 'dist/plugin/opencode.js')).href, pathToFileURL(delayPlugin).href] }));
    await run('node', [join(installed, 'dist/cli/main.js'), 'init', root], root, env);
  }
  await install(candidate);
  const { acceptanceContinuityFingerprint } = await import(pathToFileURL(join(installed, 'dist/core/acceptance-continuity.js')).href);
  const acceptance = 'result.txt equals recovered and node validate.mjs passes';
  const handoff = join(root, '.sortie-dogs/contracts/handoff.recovery.json');
  await writeFile(join(root, '.sortie-dogs/contracts/recovery.operation-manifest.json'), JSON.stringify({ version: '0.1.0', task_id: 'recovery',
    read: ['result.txt', 'validate.mjs'], write: ['result.txt'], validation: ['node validate.mjs'] }));
  await writeFile(handoff, JSON.stringify({ version: '0.1.0', profile: 'minimal', id: 'recovery', created_at: new Date().toISOString(),
    task: { title: 'Dispatch recovery', objective: acceptance }, state: { done: [], next: ['Change result.txt and validate.'], blocked: [] }, risks: [],
    verification: [{ check: 'node validate.mjs', status: 'not_run', exit_code: null, summary: 'Content oracle' }], ext: {
      'sortie-dogs/write-gate': { project_root: root, operation_manifest: '.sortie-dogs/contracts/recovery.operation-manifest.json' },
      'sortie-dogs/acceptance-continuity': { schema_version: '0.1', authority: 'dispatch', task_id: 'recovery', criteria: [acceptance],
        fingerprint: acceptanceContinuityFingerprint([acceptance]), parent_fingerprint: 'none' } } }));
  await writeFile(join(root, '.sortie-dogs/contracts/goal.json'), JSON.stringify({ delivery_intent: 'implementation', delivery_mode: 'repair-first',
    usable_path_established: true, controlled_change: false, goal_budget_units: 8,
    defaults: { entrypoint: 'validate.mjs', workload: 'one content fixture', oracle_coverage: ['result.txt content'], build_boundary: 'not-applicable',
      source: 'fixture source', candidate: 'fixture candidate', source_binding: 'current-protected', candidate_binding: 'current-protected',
      fixture: 'dispatch-rpt', proof_scope: 'requested-full', expected_outcome: 'pass', validation_command: 'node validate.mjs' },
    criteria: [{ target: acceptance }] }));
  const declaration = `task_id: recovery
context_digest:
  project_root: ${root}
  handoff_path: ${handoff}
  role: implementation
  acceptance:
    - ${acceptance}
  validation: { level: full, command: node validate.mjs, diagnostics: [] }
  known_facts: ["One declared file, one content oracle."]
  known_paths: ["result.txt","validate.mjs"]
  relevant_constraints: ["Read and bind together in one tool round; host joins inspection.","No commit."]
  resume_delta: none
source_manifest: ["result.txt","validate.mjs"]
operation_manifest: .sortie-dogs/contracts/recovery.operation-manifest.json
goal_declaration_path: .sortie-dogs/contracts/goal.json
goal_budget_units: 8`;
  let sessionID;
  async function exercise(phase) {
    const server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root,
      env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
    process.once('exit', stop); let out = ''; server.stdout.on('data', data => out += data); server.stderr.on('data', () => {});
    try {
      let url;
      for (let i = 0; i < 150; i++) { url = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) break; await new Promise(r => setTimeout(r, 100)); }
      assert(url, 'fixture server unavailable');
      if (!sessionID) {
        const created = await (await fetch(`${url}/session?directory=${encodeURIComponent(root)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Dispatch recovery fixture' })
        })).json();
        sessionID = created.id;
      }
      assert(sessionID, 'fixture session missing');
      const priorMessages = await (await fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(root)}`)).json();
      const priorIDs = new Set(priorMessages.map(message => message.info.id));
      const phaseStart = Date.now();
      const prompt = `Execute this accepted fixture, keeping its goal across continuation. I approve cumulative budget 8; do not shrink it to one unit. First output one progress checkpoint, then on the synthetic continuation dispatch dog-worker with the declaration below verbatim. All source, path, manifest, and oracle evidence is supplied and fixed: do not dispatch dog-scout, dog-advisor, or dog-reviewer; the first and only Task must be dog-worker. Do not add flat goal criteria to Task: the goal file is the accepted shared definition. Tell worker to issue Read of ${handoff} and sortie_bind_write_gate concurrently, in the same assistant message; do not wait for the Read result before requesting bind. Then change result.txt from seed to recovered and run node validate.mjs. This changes only text fixture data, not executable source. No commit. If dispatch OR worker bind is rejected, I explicitly request a hold for regression measurement: return status: INTERRUPTED with TRUE_INTERRUPTION: user: requested fixture hold, and do not repair/retry. After success finish terminally.\n${declaration}`;
      let executionError;
      const execution = run('timeout', ['--signal=TERM', '--kill-after=10s', '480s', 'opencode', 'run', '--attach', url, '--dir', root,
        '--format', 'json', '--print-logs', '--agent', 'dog-coordinator', '--session', sessionID, prompt], root, env, 510000)
        .catch(error => { executionError = error; return ''; });
      let messages = [];
      for (let i = 0; i < 900; i++) {
        messages = (await (await fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(root)}`)).json())
          .filter(message => !priorIDs.has(message.info.id));
        const tools = messages.flatMap(message => message.parts).filter(part => part.type === 'tool' && part.tool === 'task');
        const flight = await readFile(join(root, '.git/sortie-dogs/run-flight', `${hash(sessionID)}.json`), 'utf8').then(JSON.parse).catch(() => undefined);
        const lastReceipt = flight?.goal_events.findLast(record => record.event.kind === 'goal.terminal')?.event.receipt;
        const rejected = tools.some(part => /goal_(?:fingerprint|criteria)_missing/.test(part.state.error ?? '') || /handoff-uninspected/.test(part.state.output ?? ''));
        const workerReturnedWithoutChange = tools.some(part => part.state.status === 'completed' && part.state.input?.subagent_type === 'dog-worker') &&
          (await readFile(join(root, 'result.txt'), 'utf8')).trim() === 'seed' && lastReceipt?.status !== 'succeeded';
        if (phase === 'before' && (rejected || workerReturnedWithoutChange)) break;
        if (phase === 'after' && tools.some(part => part.state.status === 'completed') && lastReceipt?.status === 'succeeded' && Date.parse(lastReceipt.ended_at) >= phaseStart) break;
        if (executionError) throw executionError;
        await new Promise(r => setTimeout(r, 500));
      }
      await fetch(`${url}/session/${sessionID}/abort?directory=${encodeURIComponent(root)}`, { method: 'POST' });
      await execution;
      await new Promise(r => setTimeout(r, 1000));
      messages = (await (await fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(root)}`)).json())
        .filter(message => !priorIDs.has(message.info.id));
      const tasks = messages.flatMap(message => message.parts).filter(part => part.type === 'tool' && part.tool === 'task');
      const synthetic = messages.some(message => message.info.synthetic &&
        message.parts.some(part => part.text?.startsWith('SORTIE_STEP_CONTINUE'))) ||
        messages.flatMap(message => message.parts).some(part => part.synthetic && part.text?.startsWith('SORTIE_STEP_CONTINUE'));
      const records = JSON.parse(await readFile(join(root, '.git/sortie-dogs/run-flight', `${hash(sessionID)}.json`), 'utf8')).goal_events;
      return { tasks, synthetic, records, summaries: messages.filter(message => message.info.role === 'assistant')
        .flatMap(message => message.parts).filter(part => part.type === 'text').slice(-2).map(part => part.text.slice(0, 800)) };
    } finally { stop(); process.removeListener('exit', stop); await new Promise(r => setTimeout(r, 1000)); }
  }
  const after = await exercise('after');
  console.error(JSON.stringify({ phase: 'candidate', synthetic: after.synthetic,
    tasks: after.tasks.map(task => ({ status: task.state.status, error: task.state.error?.split('\n')[0] })), summaries: after.summaries }));
  const accepted = after.records.find(record => record.event.kind === 'goal.accepted')?.event;
  const terminal = after.records.findLast(record => record.event.kind === 'goal.terminal')?.event.receipt;
  assert(accepted && terminal?.goal_id === accepted.goal_id && terminal.status === 'succeeded', 'candidate did not complete the same goal');
  await run('node', ['validate.mjs'], root, env);
  assert(after.synthetic, 'synthetic continuation not observed');
  assert(after.tasks.some(task => task.state.status === 'completed'), 'worker never completed');
  assert(after.tasks.some(task => task.state.status === 'completed' && /goal_declaration_path:/.test(task.state.input?.prompt ?? '')),
    'candidate did not use the shared goal reference');
  const packageJSON = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const marker = (await readFile(join(control, 'sortie-dogs.version'), 'utf8')).trim();
  return { schema: 1, version: packageJSON.version, sha256: hash(await readFile(candidate)), runtimeMarker: marker, cliVersion,
    sessionID, sameGoal: true, workerStarted: true, canonicalExit: 0, terminal: 'succeeded', artifactMatch: true,
    baselineSha256: hash(await readFile(baseline)), continuationEvidence: 'synthetic-turn' };
}

const [candidate, baseline, directory] = process.argv.slice(2).map(value => resolve(value));
try {
  if (process.platform === 'win32') {
    const linux = async path => (await run('wsl.exe', ['-e', 'wslpath', '-a', path], process.cwd(), {})).trim();
    const args = await Promise.all([import.meta.filename, candidate, baseline, directory].map(linux));
    const output = await run('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s 1200s node ${args.map(shellQuote).join(' ')}`], process.cwd(), {}, 1260000);
    console.log(JSON.stringify(JSON.parse(output.trim())));
  } else console.log(JSON.stringify(await inside(candidate, baseline, directory)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
