// No model calls, credentials, shared service, or real session/Mission records.
// Usage: node test/fixtures/reviewer-transform-host.mjs <cli> <dist/plugin/v2.js> <new-output-root>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [cli, entry, output] = process.argv.slice(2);
if (!cli || !entry || !output) throw Error('CLI, compiled plugin entry and new output root required');
const root = resolve(output), project = join(root, 'project'), plugin = join(project, '.opencode/plugins/probe');
await mkdir(root); // Never overwrite an earlier run.
for (const name of ['project/.opencode/agent', 'project/.opencode/plugins/probe', 'config', 'data', 'cache', 'tmp', 'logs']) {
  await mkdir(join(root, name), { recursive: true });
}
const { runtimeAssets } = await import(pathToFileURL(resolve(dirname(entry), '../runtime-assets-v010.js')).href);
for (const asset of runtimeAssets.filter(asset => asset.installPath.startsWith('agent/'))) {
  await writeFile(join(project, '.opencode/agent', `${asset.name}.md`), asset.content);
}
const observed = join(root, 'observed.jsonl'), resultPath = join(root, 'result.json');
await writeFile(join(plugin, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
await writeFile(join(plugin, 'index.js'), `
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createSortieDogsV2Plugin, syncReviewerCorrectionPermissions } from ${JSON.stringify(pathToFileURL(resolve(entry)).href)};
import { SortieDogsV010Plugin } from ${JSON.stringify(pathToFileURL(resolve(dirname(entry), 'profiled.js')).href)};
const observe = value => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value)+'\\n');
const wait = ms => new Promise(done => setTimeout(done, ms));
export default { id:'sortie-dogs.v010', async setup(ctx) {
  const model = {providerID:'openai',id:'gpt-6.1-sol',variant:'high'};
  let selected = 'dog-reviewer-v010', scoped = true, missing = false, hooks;
  const key = 'v2-reviewer-correction-permissions:probe';
  const storage = new Map([[key, {agent:selected,model,generation:1}]]);
  const context = {...ctx,
    storage:{get:async k=>storage.get(k),set:async(k,v)=>storage.set(k,v),remove:async k=>storage.delete(k),
      scan:async({prefix})=>({entries:[...storage].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value}))})},
    agent:{...ctx.agent,transform:cb=>ctx.agent.transform(editor=>{
      observe({stage:'replay',permission_count:editor.get('dog-reviewer-v010')?.permissions?.length??null});cb(editor);
    })},
    message:{...ctx.message,list:async()=>({data:[],cursor:{}})},
    session:{...ctx.session,get:async({sessionID})=>({id:sessionID,agent:sessionID==='probe'?selected:'dog-operator',model}),
      context:async()=>[],list:async()=>({data:[],cursor:{}}),
      switchAgent:async input=>{assert.equal(input.sessionID,'probe');selected=input.agent;observe({stage:'switch',agent:selected});}}
  };
  const cleanup = await createSortieDogsV2Plugin(async(input,options)=>{
    hooks = {...await SortieDogsV010Plugin(input,options),reviewerCorrectionScope:async id=>id==='probe'&&scoped?{generation:1}:undefined};
    return hooks;
  }).setup(context);
  observe({stage:'setup',selected,identity_retained:storage.has(key)});
  // Return from plugin setup before the builtin config.agent source registers.
  // The native domain, not a test editor, controls replay/materialization ordering.
  const timer=setTimeout(async()=>{
    try {
      for(let i=0;i<100;i++) {
        const response=await ctx.agent.get({agentID:'dog-reviewer-v010'}).catch(()=>undefined);
        const reviewer=response?.data??response;
        if(reviewer?.permissions?.some(rule=>rule.action==='sortie_*'))break;
        await wait(25);
      }
      const custom=[{action:'edit',resource:'protected.txt',effect:'deny'},{action:'shell',resource:'approval',effect:'ask'}];
      await ctx.agent.transform(editor=>editor.update('dog-reviewer-v010',agent=>{
        if(missing)agent.permissions=agent.permissions.filter(rule=>rule.action!=='sortie_*');
        agent.permissions=[...agent.permissions,...custom];
      }));
      const names=async()=>(await ctx.tool.list()).map(tool=>tool.id);
      assert((await names()).includes('sortie_v010_operator_status'));
      await syncReviewerCorrectionPermissions(context,hooks,'probe');
      const alias=selected;
      assert.match(alias,/^dog-reviewer-correction-/);
      let response=await ctx.agent.get({agentID:alias}), projected=response.data??response;
      assert.deepEqual(projected.model,model);
      assert.deepEqual(projected.permissions.slice(-custom.length),custom);
      missing=true;await ctx.agent.reload();
      response=await ctx.agent.get({agentID:alias});projected=response.data??response;
      assert.deepEqual(projected.permissions,[{action:'*',resource:'*',effect:'deny'}]);
      assert((await names()).includes('sortie_v010_operator_status'));
      await assert.rejects(syncReviewerCorrectionPermissions(context,hooks,'probe'),/native-reviewer-correction-readonly-role-block-unavailable/);
      assert.equal(selected,'dog-reviewer-v010');assert(storage.has(key));
      missing=false;await ctx.agent.reload();
      await syncReviewerCorrectionPermissions(context,hooks,'probe');
      assert.equal(selected,alias);
      scoped=false;await syncReviewerCorrectionPermissions(context,hooks,'probe');
      assert.equal(selected,'dog-reviewer-v010');assert.equal(storage.has(key),false);
      const rootModel={providerID:model.providerID,modelID:model.id,variant:model.variant};
      await hooks['chat.message']({sessionID:'root',messageID:'probe-root',agent:'dog-operator',model:rootModel},
        {message:{id:'probe-root',agent:'dog-operator',model:rootModel},parts:[{type:'text',text:'Observe recovery status without starting work.'}]});
      const status=await hooks.tool.sortie_v010_operator_status.execute({}, {sessionID:'root',agent:'dog-operator'});
      assert.equal(typeof status,'string');
      writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:true,cold_setup_deferred:true,
        native_replay_failed_closed:true,operator_tool_registered:true,operator_status_executed:true,
        recovery_identity_retained:true,role_and_model_restored:true,custom_deny_ask_retained:true,
        model_requests:0,real_session_recovery:false})+'\\n');
    }catch(error){writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:false,error:String(error),stack:error?.stack})+'\\n');}
  },0);
  return ()=>{clearTimeout(timer);cleanup?.();};
}};
`);
await writeFile(join(project, 'opencode.json'), JSON.stringify({ plugins: [pathToFileURL(plugin).href] }));
const password = randomBytes(24).toString('hex');
const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
  OPENCODE_CONFIG_DIR: join(root, 'config/opencode'), XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_DB: join(root, 'data/opencode.db'),
  TMPDIR: join(root, 'tmp'), OPENCODE_SERVER_PASSWORD: password };
delete env.OPENCODE_SESSION_ID;
const child = spawn(cli, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
  cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
});
let logs = '', url, closed = false;
child.stdout.on('data', bytes => { logs += bytes; url ??= /http:\/\/127\.0\.0\.1:\d+/u.exec(logs)?.[0]; });
child.stderr.on('data', bytes => { logs += bytes; });
child.on('close', () => { closed = true; });
child.on('error', error => { logs += String(error); });
const wait = ms => new Promise(done => setTimeout(done, ms));
const query = new URLSearchParams({ 'location[directory]': project });
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
const started = Date.now();
try {
  const deadline = Date.now() + 45_000;
  while (!url && !closed && Date.now() < deadline) await wait(50);
  assert(url, 'private server did not start');
  // Loading a location is asynchronous; its first registry read can precede plugin setup.
  let result, plugins;
  while (Date.now() < deadline && !closed) {
    const response = await fetch(`${url}/api/plugin?${query}`, { headers, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    plugins = await response.json();
    const plugin = plugins.data?.find(item => item.id === 'sortie-dogs.v010');
    if (plugin?.state?.status === 'failed') throw Error(plugin.state.error);
    result = await readFile(resultPath, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (result) break;
    await wait(50);
  }
  await writeFile(join(root, 'plugins.json'), JSON.stringify(plugins, null, 2)+'\n');
  assert(result, 'native recovery probe did not finish');
  assert(result.ok, result.stack ?? result.error);
  assert.equal(plugins.data.find(item => item.id === 'sortie-dogs.v010').state.status, 'active');
  console.log(JSON.stringify({ ...result, elapsed_seconds: (Date.now()-started)/1000, output: root }));
} finally {
  if (!closed) child.kill('SIGTERM');
  for (let i = 0; i < 30 && !closed; i++) await wait(100);
  if (!closed) child.kill('SIGKILL');
  await writeFile(join(root, 'logs/host.log'), logs);
}
