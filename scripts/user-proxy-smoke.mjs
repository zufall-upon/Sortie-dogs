import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { installedFixture, startV2ReleaseServer, command, runLocationArgsForOpenCodeVersion } from './release-cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };
const events = value => value.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

/** Frozen installed-package qualification of the actual default V2/Sol6/Luna6-Fast workflow. */
export async function userProxySmoke(tgz, directory) {
  const driverHash = hash(await readFile(import.meta.filename));
  const fixture = await installedFixture(tgz, directory, 'v011');
  const { project, control, env, cliVersion, run } = fixture;
  const configPath = join(control, 'opencode.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.model = 'openai/gpt-6-sol';
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(name => [name, { model: 'openai/gpt-6-luna-fast#high' }]));
  await writeFile(configPath, JSON.stringify(config, null, 2));
  // Test instrumentation invokes the public compaction endpoint on the same private server.
  // OpenCode 2.0.14 exposes this endpoint but omits compact from the plugin SessionDomain.
  await writeFile(join(control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';
import {readFile,appendFile} from 'node:fs/promises';
export default {...plugin,async setup(ctx){
   const cleanup=await plugin.setup(ctx);const compacted=new Set();
   const record=async value=>appendFile(new URL('../../request-routing.jsonl',import.meta.url),JSON.stringify(value)+'\\n');
   await ctx.tool.transform(editor=>editor.update('subagent',tool=>{const execute=tool.execute;tool.execute=(input,execution)=>execute(input,{...execution,progress:async update=>{
     if(update.sortie_progress)await record({kind:'work-progress',root:execution.sessionID,child:update.sessionID,progress:update.sortie_progress});
     await execution.progress(update);
   }});}));
  const {data:models}=await ctx.model.list();
  const fast=models.find(model=>model.providerID==='openai'&&model.id==='gpt-6-luna-fast');
  if(!fast||fast.modelID!=='gpt-6-luna'||!['priority','fast'].includes(fast.body?.service_tier))throw Error('Native Luna6 Fast catalog entry missing or invalid');
  await record({kind:'model-catalog',selected_model:fast.id,api_model:fast.modelID,service_tier:fast.body.service_tier});
  const tools=await ctx.tool.list();
  if(!['sortie_v011_start_work','sortie_v011_check','sortie_v011_work_status','sortie_v011_review_work'].every(id=>tools.some(tool=>tool.id===id)))throw Error('Native Sortie tools missing');
  await ctx.tool.hook('execute.after',async event=>{
    if(event.tool!=='sortie_v011_check'||event.status!=='completed'||compacted.has(event.sessionID))return;
    const result=JSON.parse(typeof event.result.content==='string'?event.result.content:event.result.content.map(p=>p.text??'').join(''));
    if(result.exit===0||(await ctx.session.get({sessionID:event.sessionID})).agent!=='dogs-coordinator')return;
    compacted.add(event.sessionID);
    const server=JSON.parse(await readFile(new URL('../../native-server.json',import.meta.url),'utf8'));
    const response=await fetch(server.url+'/api/session/'+event.sessionID+'/compact',{method:'POST',headers:{authorization:server.authorization,'content-type':'application/json'},body:'{}'});
    if(!response.ok)throw Error('Native compaction admission failed: '+response.status);
    await record({sessionID:event.sessionID,kind:'compaction-admitted',receipt:await response.json()});
  });
  await ctx.session.hook('http.request',async event=>{
    if(event.request.method!=='POST')return;
    const body=await event.request.clone().json().catch(()=>({}));
    if(body.model)await record({sessionID:event.sessionID,kind:event.kind,model:body.model,selected_model:event.model.id,tier:body.service_tier??null,transport:'http'});
  });
  await ctx.session.hook('experimental.ws.send',async event=>{
    const frame=JSON.parse(event.frame);if(frame.type!=='response.create')return;
    const body=frame.response??frame;
    await record({sessionID:event.sessionID,kind:event.kind,model:body.model,selected_model:event.model.id,tier:body.service_tier??null,transport:'ws'});
  });
  return cleanup;
}};\n`);
  await mkdir(join(project, 'src')); await mkdir(join(project, 'test'));
  await writeFile(join(project, '.gitignore'), '.opencode/\n');
  await writeFile(join(project, 'src/tags.mjs'), 'export function normalizeTags(values) { return values.map(value => value.trim()); }\n');
  await writeFile(join(project, 'README.md'), '# Tags\nTODO: document normalizeTags.\n');
  const oracle = `import assert from 'node:assert/strict';import test from 'node:test';import {normalizeTags} from '../src/tags.mjs';
test('normalize, filter, deduplicate, preserve order and case',()=>{assert.deepEqual(normalizeTags([' a ','',42,'a','A',' b ',null]),['a','A','b']);});
test('empty and nonarray input',()=>{for(const value of [undefined,null,42,'abc',{}])assert.deepEqual(normalizeTags(value),[]);assert.deepEqual(normalizeTags([]),[]);});
test('do not mutate the caller',()=>{const input=Object.freeze([' x ','x']);assert.deepEqual(normalizeTags(input),['x']);assert.deepEqual(input,[' x ','x']);});\n`;
  await writeFile(join(project, 'test/tags.test.mjs'), oracle);
  await writeFile(join(project, 'AGENTS.md'), '# Qualification project\nOnly src/tags.mjs and README.md may change. Never edit tests, AGENTS.md, .gitignore or .opencode. Do not commit or install dependencies.\nThe implementer must reproduce the failing test with sortie_v011_check before editing. The qualification controller queues one native compaction after that initial failure; continue the same task afterward. Do not call a compaction tool or ask for extra compaction. Then implement and rerun the full test.\n');
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', '.gitignore', 'AGENTS.md', 'src', 'test', 'README.md'], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed native v0.11 qualification'], project, env);
  const protectedPaths = ['test/tags.test.mjs', 'AGENTS.md', '.gitignore', '.opencode/opencode.json',
    '.opencode/agent/dog-operator.md', '.opencode/agent/dogs-coordinator.md', '.opencode/plugins/sortie-dogs/index.js'];
  const protectedHashes = Object.fromEntries(await Promise.all(protectedPaths.map(async path => [path, hash(await readFile(join(project, path)))])));
  const initialHead = (await command('git', ['rev-parse', 'HEAD'], project, env)).trim();
  const server = await startV2ReleaseServer(project, env);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${server.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` };
  await writeFile(join(control, 'native-server.json'), JSON.stringify({ url: server.url, ...headers }), { mode: 0o600 });
  async function api(path) {
    const response = await fetch(`${server.url}${path}`, { headers });
    if (!response.ok) throw Error(`Native API ${path}: ${response.status}`);
    const value = await response.json(); return value.data ?? value;
  }
  const started = Date.now();
  let root, turns = [], family = [], errorMessage = null, pluginState, canonicalExit = null, artifactMatch = false;
  async function cli(prompt, id) {
    try {
      const output = await command('timeout', ['--signal=TERM', '--kill-after=10s', '900s', 'opencode', 'run',
        ...runLocationArgsForOpenCodeVersion(cliVersion, project, server.url), '--format', 'json', '--agent', 'dog-operator',
        '--model', 'openai/gpt-6-sol#xhigh', ...(id ? ['--session', id] : []), prompt], project, server.env, 940000);
      await writeFile(join(run, `turn-${turns.length + 1}.jsonl`), output);
      return events(output);
    } catch (error) {
      if (error.processResult) await writeFile(join(run, `turn-${turns.length + 1}-failure.json`), JSON.stringify(error.processResult));
      throw error;
    }
  }
  const collect = async id => {
    const messages = await api(`/api/session/${id}/context`);
    assert(Array.isArray(messages), 'Native session context missing');
    const tools = messages.flatMap(message => message.content ?? []).filter(part => part.type === 'tool');
    const review = tools.filter(part => part.name === 'sortie_v011_review_work' && part.state?.status === 'completed').at(-1);
    const reviewText = review && (typeof review.state.content === 'string' ? review.state.content : review.state.content?.filter(part => part.type === 'text').map(part => part.text).join('\n'));
    const result = reviewText ? JSON.parse(reviewText) : null;
    const children = [...new Set(tools.filter(part => part.name === 'subagent').flatMap(part => {
      const metadata = part.state?.metadata ?? {}; return metadata.sessionID ?? metadata.sessionId ?? [];
    }))];
    const childHistory = await Promise.all(children.map(async child => ({ id: child, messages: await api(`/api/session/${child}/context`) })));
    return { id, result, messages, children: childHistory };
  };
  try {
    turns.push(await cli('src/tags.mjsのnormalizeTagsを修正してください。文字列配列の前後空白を除去し、空文字と文字列以外を除外し、大文字小文字を区別したまま重複を除き、順序を保ってください。入力を変更せず、非配列には空配列を返してください。READMEに使用例を書いてください。既存テストは変更せず、node --test test/tags.test.mjsで検証してください。AGENTS.mdの手順も守ってください。'));
    root = turns[0].find(event => event.sessionID)?.sessionID;
    assert(root, 'Native root session missing');
    let first = await collect(root); family.push(first);
    // In OpenCode 2.0.14 an untouched location's registry can be empty until native run activates it.
    const plugins = await api(`/api/plugin?${new URLSearchParams({ 'location[directory]': project })}`);
    pluginState = plugins.find(plugin => plugin.id === 'sortie-dogs.v011');
    assert(pluginState?.state?.status === 'active', `Native plugin unavailable: ${JSON.stringify(pluginState?.state ?? plugins)}`);
    assert(first.result?.receipt?.status === 'succeeded', 'First real task did not reach operator acceptance');
    assert(first.result.checks.some(check => check.exit !== 0) && first.result.checks.some(check => check.exit === 0), 'Missing real failure-to-correction evidence');
    await command('node', ['--test', 'test/tags.test.mjs'], project, env);
    assert(first.children.length === 1, 'Expected one cheap implementation child');
     const routing = events(await readFile(join(control, 'request-routing.jsonl'), 'utf8'));
     assert(routing.some(item => item.kind === 'work-progress' && item.child === first.children[0].id), 'Parent native call did not receive live child progress');
    assert(routing.some(item => item.kind === 'compaction-admitted') && routing.some(item => item.kind === 'compaction'), 'Native child compaction not observed');
    const lunaRequests = routing.filter(item => item.model === 'gpt-6-luna');
    assert(lunaRequests.length && lunaRequests.every(item => item.tier === 'priority' || item.tier === 'fast'), 'A Luna6 request omitted Fast service tier');
    // A second task in the same root must not inherit a completed job's acceptance/budget bindings.
    turns.push(await cli('次の別タスクです。normalizeTagsの既存動作を維持し、READMEに非配列入力と凍結配列入力の例を追加してください。実装とテストは変更しないでください。node --test test/tags.test.mjsを実行して確認してください。今回の作業には追加compactionは不要です。', root));
    const second = await collect(root); family.push(second);
    assert(second.result?.receipt?.status === 'succeeded', 'Second task in the same root did not complete');
    assert(first.result.work_id !== second.result.work_id, 'Completed work polluted the next task');
    assert(second.result.original_requests.length === 1, 'Historical instructions were incorrectly reaccepted');
    for (const item of family) for (const child of item.children) {
      for (const message of child.messages.filter(message => message.type === 'assistant')) {
        assert(message.model?.providerID === 'openai' && message.model?.id === 'gpt-6-luna-fast', 'Implementer did not use the native Luna6 Fast selector');
      }
    }
    for (const message of second.messages.filter(message => message.type === 'assistant')) {
      assert(message.model?.providerID === 'openai' && message.model?.id === 'gpt-6-sol', 'Operator used a non-SOL6 model');
    }
    const allRouting = events(await readFile(join(control, 'request-routing.jsonl'), 'utf8'));
    const allLuna = allRouting.filter(item => item.selected_model === 'gpt-6-luna-fast' && item.transport);
    assert(allLuna.length && allLuna.every(item => ['priority', 'fast'].includes(item.tier)), 'Native Fast selector lost its tier on a later request');
    for (const [path, expected] of Object.entries(protectedHashes)) assert(hash(await readFile(join(project, path))) === expected, `Protected source changed: ${path}`);
    assert((await command('git', ['rev-parse', 'HEAD'], project, env)).trim() === initialHead, 'Worker committed despite the user prohibition');
    await command('node', ['--test', 'test/tags.test.mjs'], project, env);
    canonicalExit = 0; artifactMatch = true;
  } catch (error) { errorMessage = error.message; }
  finally {
    const report = { schema: 1, version: fixture.pkg.version, profile: 'v011', cliVersion, sha256: hash(await readFile(tgz)),
      driver_sha256: driverHash, plugin_state: pluginState?.state, protected_hashes: protectedHashes,
      workerStarted: family.some(item => item.children.length > 0), canonicalExit, artifactMatch,
      runtimeMarker: fixture.runtimeMarker, sessionID: root, elapsed_ms: Date.now() - started, terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage,
      turns: turns.length, tasks: family.map(item => ({ work_id: item.result?.work_id, receipt: item.result?.receipt, checks: item.result?.checks,
        cost: item.result?.cost, children: item.children.map(child => ({ id: child.id, models: [...new Set(child.messages.map(message => message.model?.id).filter(Boolean))],
          service_tiers: [...new Set(child.messages.map(message => message.providerState?.serviceTier).filter(Boolean))] })) })),
      request_routing: events(await readFile(join(control, 'request-routing.jsonl'), 'utf8').catch(()=>'')),
      measurement: 'Two native tasks, failed-test correction and native compaction. Not a representative cost benchmark.' };
    await writeFile(join(run, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(run, 'native-history.json'), JSON.stringify(family, null, 2));
    await server.stop();
    await rm(join(control, 'native-server.json'), { force: true });
  }
  if (errorMessage) throw Error(`${errorMessage}; evidence: ${join(run, 'qualification.json')}`);
  return JSON.parse(await readFile(join(run, 'qualification.json'), 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  userProxySmoke(resolve(process.argv[2]), resolve(process.argv[3])).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
