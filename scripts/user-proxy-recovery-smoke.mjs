import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };
const content = value => typeof value === 'string' ? value : (value ?? []).map(part => part.text ?? '').join('\n');
const json = path => readFile(path, 'utf8').then(JSON.parse);

/** A real interrupted native tool, server restart and same-child resume. No user-session database edits. */
export async function userProxyRecoverySmoke(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'v011');
  const { project, control, env, run } = fixture;
  const config = await json(join(control, 'opencode.json'));
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(name => [name, { model: 'openai/gpt-6-luna-fast#high' }]));
  await writeFile(join(control, 'opencode.json'), JSON.stringify(config));
  await writeFile(join(project, '.gitignore'), '.opencode/\n');
  await writeFile(join(project, 'result.txt'), 'pending\n');
  await writeFile(join(project, 'check.mjs'), "import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';assert.equal(readFileSync('result.txt','utf8'),'done\\n');console.log('PASS');\n");
  await writeFile(join(project, 'AGENTS.md'), '# Recovery fixture\nRead result.txt before changing it. Only result.txt may change. Do not edit tests, AGENTS.md or .opencode. Run node check.mjs using sortie_v011_check after editing. Do not commit or install dependencies.\n');
  await writeFile(join(control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';
import {existsSync} from 'node:fs';import {writeFile,appendFile} from 'node:fs/promises';
export default {...plugin,async setup(ctx){
  const record=value=>appendFile(new URL('../../recovery-observation.jsonl',import.meta.url),JSON.stringify(value)+'\\n');
  const audit=event=>{const pending=new Set();for(const m of event.messages??[])for(const p of m.content??[]){if(p.providerExecuted)continue;if(p.type==='tool-call')pending.add(p.id);if(p.type==='tool-result')pending.delete(p.id);}return [...pending];};
  await ctx.session.hook('context',async e=>record({kind:'before-context',sessionID:e.sessionID,missing:audit(e)}));
  const cleanup=await plugin.setup(ctx);
  await ctx.session.hook('context',async e=>record({kind:'after-context',sessionID:e.sessionID,missing:audit(e)}));
  const marker=new URL('../../held-read.json',import.meta.url);let holding=false;
  await ctx.tool.transform(editor=>editor.update('read',tool=>{const execute=tool.execute;tool.execute=async(input,execution)=>{
    const result=await execute(input,execution),session=await ctx.session.get({sessionID:execution.sessionID});
    if(session.agent!=='dogs-coordinator'||holding||existsSync(marker))return result;
    holding=true;await writeFile(marker,JSON.stringify({root:session.parentID,child:session.id,callID:execution.id}));
    await new Promise(resolve=>{if(execution.signal.aborted)resolve();else execution.signal.addEventListener('abort',resolve,{once:true});});
    return result;
  };}));return cleanup;
}};\n`);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed recovery']]) await command('git', args, project, env);
  const protectedPaths = ['AGENTS.md', 'check.mjs', '.gitignore', '.opencode/plugins/sortie-dogs/index.js'];
  const protectedHashes = Object.fromEntries(await Promise.all(protectedPaths.map(async path => [path, hash(await readFile(join(project, path)))])));
  let server = await startV2ReleaseServer(project, env), identity, firstHistory, finalHistory, errorMessage;
  const api = async (path, method = 'GET') => {
    const response = await fetch(server.url + path, { method, headers: { authorization: 'Basic ' + Buffer.from('opencode:' + server.env.OPENCODE_SERVER_PASSWORD).toString('base64') } });
    assert(response.ok, 'Native recovery API HTTP ' + response.status);
    if (response.status === 204) return;
    const value = await response.json(); return value.data ?? value;
  };
  const cli = async (text, root, name) => {
    try { await writeFile(join(run, name), await command('timeout', ['--signal=TERM', '--kill-after=10s', '420s', 'opencode', 'run', '--server', server.url, '--format', 'json', '--agent', 'dog-operator', '--model', 'openai/gpt-6-sol#xhigh', ...(root ? ['--session', root] : []), text], project, server.env, 460000)); }
    catch (error) { await writeFile(join(run, name), error.processResult?.stdout ?? error.message); return error.message; }
  };
  const started = Date.now();
  try {
    const first = cli('result.txtをdoneと改行だけにしてください。最初にresult.txtをreadし、既存node check.mjsで検証してください。AGENTS.mdも守ってください。', undefined, 'turn-1.jsonl');
    const deadline = Date.now() + 180000;
    // Fixture controller waits for the one deliberate interruption boundary, not a model polling loop.
    while (!identity && Date.now() < deadline) {
      identity = await json(join(control, 'held-read.json')).catch(() => undefined);
      if (!identity) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(identity?.root && identity?.child, 'Native held-read boundary was not reached');
    await api(`/api/session/${identity.root}/interrupt`, 'POST');
    await first;
    firstHistory = { root: await api(`/api/session/${identity.root}/context`), child: await api(`/api/session/${identity.child}/context`) };
    await writeFile(join(run, 'interrupted-history.json'), JSON.stringify(firstHistory, null, 2));
    await server.stop();
    server = await startV2ReleaseServer(project, env);
    const error = await cli('中断した同じ作業を再開してください。既存のresult.txtとcheckを確認し、同じ子セッションで完了・検証・受理まで進めてください。', identity.root, 'turn-2.jsonl');
    finalHistory = { root: await api(`/api/session/${identity.root}/context`), child: await api(`/api/session/${identity.child}/context`) };
    const tools = finalHistory.root.flatMap(m => m.content ?? []).filter(p => p.type === 'tool');
    const accepted = tools.filter(p => p.name === 'sortie_v011_review_work' && p.state?.status === 'completed').at(-1);
    const result = accepted ? JSON.parse(content(accepted.state.content)) : null;
    assert(!error, error);
    assert(result?.receipt?.status === 'succeeded', 'Same-child recovery did not reach acceptance');
    const children = [...new Set(tools.filter(p => p.name === 'subagent').flatMap(p => p.state?.metadata?.sessionID ?? []))];
    assert(children.length === 1 && children[0] === identity.child, 'Recovery replaced the original child');
    assert(result.attempts >= 2, 'Recovery reset the attempt budget');
    await command('node', ['check.mjs'], project, env);
    for (const [path, expected] of Object.entries(protectedHashes)) assert(hash(await readFile(join(project, path))) === expected, 'Protected fixture changed: ' + path);
  } catch (error) { errorMessage = error.message; }
  finally {
    await server.stop();
    await rm(join(control, 'native-server.json'), { force: true });
    await writeFile(join(run, 'final-history.json'), JSON.stringify(finalHistory ?? null, null, 2));
    const report = { schema: 1, version: fixture.pkg.version, sha256: hash(await readFile(tgz)), runtimeMarker: fixture.runtimeMarker,
      driver_sha256: hash(await readFile(import.meta.filename)), identity, elapsed_ms: Date.now() - started,
      terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage ?? null, same_child: !errorMessage, server_restarted: Boolean(firstHistory),
      observation: (await readFile(join(control, 'recovery-observation.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse) };
    await writeFile(join(run, 'recovery.json'), JSON.stringify(report, null, 2));
  }
  return json(join(run, 'recovery.json'));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  userProxyRecoverySmoke(resolve(process.argv[2]), resolve(process.argv[3])).then(report => { console.log(JSON.stringify(report, null, 2)); if (report.terminal !== 'succeeded') process.exitCode = 1; }).catch(error => { console.error(error); process.exitCode = 1; });
}
