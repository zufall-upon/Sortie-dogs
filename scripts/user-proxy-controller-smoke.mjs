import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';
import { processAlive, stopSupervisor } from './swebench-lite-supervisor.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const json = path => readFile(path, 'utf8').then(JSON.parse);
const assert = (condition, message) => { if (!condition) throw Error(message); };

/** Real detached processes and a server restart; the existing supervisor, not a model, owns the jobs. */
export async function controllerSmoke(tgz, directory) {
  const f = await installedFixture(tgz, directory, 'v011');
  const config = await json(join(f.control, 'opencode.json'));
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(id => [id, { model: 'openai/gpt-6-luna-fast#high' }]));
  await writeFile(join(f.control, 'opencode.json'), JSON.stringify(config));
  await writeFile(join(f.control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';import{writeFile}from'node:fs/promises';
export default {...plugin,async setup(ctx){const cleanup=await plugin.setup(ctx);
 await ctx.tool.hook('execute.after',async e=>{if(e.tool==='sortie_v011_review_work'&&e.status==='completed'){
 const c=e.result.content,r=JSON.parse(typeof c==='string'?c:c.map(p=>p.text??'').join(''));
 if(r.receipt?.status==='succeeded')await writeFile(new URL('../../accepted.json',import.meta.url),JSON.stringify({root:e.sessionID,result:r}));
 }});return cleanup;}};\n`);
  const supervisor = resolve(import.meta.dirname, 'swebench-lite-supervisor.mjs');
  const runRoot = join(f.control, 'jobs'), statePath = join(runRoot, 'supervisor-state.json');
  const manifestPath = join(f.control, 'manifest.json'), outputPath = join(f.control, 'predictions.jsonl');
  const startsPath = join(f.control, 'starts.jsonl'), runner = join(f.control, 'local-runner.mjs');
  await writeFile(startsPath, '');
  await writeFile(manifestPath, JSON.stringify({ dataset: { id: 'local-controller-fixture' }, candidate: { package_tgz: tgz, sha256: hash(await readFile(tgz)), version: f.pkg.version },
    instances: [{ instance_id: 'one' }, { instance_id: 'two' }] }));
  await writeFile(runner, `import{readFile,mkdir,writeFile,appendFile}from'node:fs/promises';import{dirname}from'node:path';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1],m=JSON.parse(await readFile(value('--manifest'),'utf8')),id=m.instances[0].instance_id;
await appendFile(${JSON.stringify(startsPath)},JSON.stringify({id,pid:process.pid,at:Date.now()})+'\\n');
await new Promise(resolve=>setTimeout(resolve,45000));await mkdir(dirname(value('--output')),{recursive:true});
await writeFile(value('--output'),JSON.stringify({instance_id:id,model_name_or_path:'local-behavior-fixture',model_patch:''})+'\\n');
await writeFile(value('--metadata'),JSON.stringify({execution:{spent_usd:0},results:[{instance_id:id,status:'succeeded',usage:{usd:0}}]}));\n`);
  const launch = `node ${quote(supervisor)} --start --manifest ${quote(manifestPath)} --run-root ${quote(runRoot)} --output ${quote(outputPath)} --cost-limit-usd 1 --per-instance-usd 0.5 --workers 2 --runner-script ${quote(runner)}`;
  const stop = `node ${quote(supervisor)} --stop --state-path ${quote(statePath)}`;
  await writeFile(join(f.project, 'verify.mjs'), `import{readFileSync}from'node:fs';import assert from'node:assert/strict';
const s=JSON.parse(readFileSync(${JSON.stringify(statePath)},'utf8')),starts=readFileSync(${JSON.stringify(startsPath)},'utf8').trim().split('\\n').map(JSON.parse);
assert.equal(s.status,'completed');assert.equal(s.workers,2);assert.deepEqual(s.instances.map(i=>i.status),['succeeded','succeeded']);assert.equal(s.spent_usd,0);
assert.equal(starts.length,2);assert.deepEqual(starts.map(i=>i.id).sort(),['one','two']);assert(Math.abs(starts[0].at-starts[1].at)<5000);console.log('Two real concurrent jobs completed exactly once');\n`);
  await writeFile(join(f.project, '.gitignore'), '.opencode/\n');
  await writeFile(join(f.project, 'AGENTS.md'), '# Controller fixture\nNever edit any source or configuration. Use the supplied existing controller, state and stop commands. Verify terminal results with node verify.mjs. No dependencies or commits.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed controller fixture']]) await command('git', args, f.project, f.env);
  const protectedFiles = ['verify.mjs', 'AGENTS.md', '.opencode/manifest.json', '.opencode/local-runner.mjs', '.opencode/plugins/sortie-dogs/index.js'];
  const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async path => [path, hash(await readFile(join(f.project, path)))])));
  let server = await startV2ReleaseServer(f.project, f.env), errorMessage, accepted, root, history;
  const started = Date.now();
  const api = async path => {
    const r = await fetch(server.url + path, { headers: { authorization: 'Basic ' + Buffer.from('opencode:' + server.env.OPENCODE_SERVER_PASSWORD).toString('base64') } });
    assert(r.ok, 'Native controller API HTTP ' + r.status); const v = await r.json(); return v.data ?? v;
  };
  try {
    const stdout = await command('timeout', ['--signal=TERM', '--kill-after=10s', '120s', 'opencode', 'run', '--server', server.url, '--format', 'json', '--agent', 'dog-operator', '--model', 'openai/gpt-6-sol#xhigh',
      `準備済みの2件のローカル処理を開始し、終了後にnode verify.mjsで重複なく2並列で完了したことを検証してください。既存controllerに長時間処理を管理させてください。起動command: ${launch}\ncontroller_state: ${statePath}\nstop_command: ${stop}\nソースと設定は変更しないでください。`], f.project, server.env, 145000);
    await writeFile(join(f.run, 'first-attachment.jsonl'), stdout);
    const events = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
    root = events.find(e => e?.sessionID)?.sessionID;
    assert(root, 'Root session identity unavailable');
    assert(!await json(join(f.control, 'accepted.json')).catch(() => null), 'Launch accepted before target completion');
    const before = await json(statePath);
    assert(before.status === 'running' && await processAlive(before.heartbeat.supervisor), 'Controller not running at restart boundary');
    await server.stop();
    assert(await processAlive(before.heartbeat.supervisor), 'Native server restart killed the detached controller');
    server = await startV2ReleaseServer(f.project, f.env);
    await api('/api/plugin?' + new URLSearchParams({ 'location[directory]': f.project }));
    // Observe host recovery; no user prompt or replacement controller is submitted after restart.
    while (!accepted && Date.now() - started < 180000) {
      accepted = await json(join(f.control, 'accepted.json')).catch(() => null);
      if (!accepted) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(accepted?.root === root, 'Controller completion did not autonomously return to the same root');
    assert(accepted.result.controller.runID === before.run_id, 'Controller identity changed');
    await command('node', ['verify.mjs'], f.project, f.env);
    for (const [path, digest] of Object.entries(protectedHashes)) assert(hash(await readFile(join(f.project, path))) === digest, 'Protected source changed: ' + path);
    history = await api('/api/session/' + root + '/context');
  } catch (error) { errorMessage = error.message; }
  finally {
    const state = await json(statePath).catch(() => null);
    if (state?.status === 'running') await stopSupervisor(statePath).catch(() => undefined);
    await server.stop();
    const report = { sha256: hash(await readFile(tgz)), driver_sha256: hash(await readFile(import.meta.filename)), root,
      terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage ?? null, elapsed_ms: Date.now() - started, accepted, state: await json(statePath).catch(() => null) };
    await writeFile(join(f.run, 'qualification.json'), JSON.stringify(report, null, 2));
    await writeFile(join(f.run, 'native-history.json'), JSON.stringify(history ?? null, null, 2));
    await rm(join(f.control, 'node_modules'), { recursive: true, force: true });
  }
  if (errorMessage) throw Error(errorMessage + '; evidence: ' + f.run);
  return { terminal: 'succeeded', root, run: f.run, elapsed_ms: Date.now() - started };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) controllerSmoke(resolve(process.argv[2]), resolve(process.argv[3])).then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.message); process.exitCode = 1; });
