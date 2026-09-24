import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedFixture, startV2ReleaseServer } from './release-cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };

/** Native API boundary regression, with real permission decisions/processes and zero inference. */
export async function nativeLaunchSmoke(tgz, directory) {
  const f = await installedFixture(tgz, directory, 'v011');
  const config = JSON.parse(await readFile(join(f.control, 'opencode.json'), 'utf8'));
  config.permissions = [{ action: '*', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*https://*', effect: 'deny' }];
  await writeFile(join(f.control, 'opencode.json'), JSON.stringify(config));
  const corrected = "python -c \"from pathlib import Path; Path('result.txt').write_text('done\\n')\"";
  const checkCommand = "python -c \"from pathlib import Path; assert Path('result.txt').read_text() == 'done\\n'; print('NATIVE LAUNCH PASS')\"";
  await writeFile(join(f.control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';import{Rpc}from'@opencode/plugin/rpc';import{WorkLoop}from'../../node_modules/sortie-dogs/dist/core/work-loop.js';
export default {...plugin,async setup(ctx){const cleanup=await plugin.setup(ctx),loop=new WorkLoop(ctx.location.directory,ctx.storage);
await ctx.session.hook('model.request',()=>{throw Error('This native API regression must make zero model requests');});
const definition=Rpc.define({id:'sortie-native-launch-qualification',events:{},methods:{run:{input:{type:'object'},output:{type:'object'},errors:{}}}});
await ctx.rpc.register(definition,{run:async(_input,{signal})=>{
 const session=await ctx.session.create({agent:'dog-operator',model:{providerID:'openai',id:'gpt-6-sol',variant:'xhigh'},title:'Native launch boundary'});
 await loop.observe(session.id,{id:'native-qualification-request',at:Date.now(),text:'Resolve the denied local launch with a linked permitted command. Write result.txt as done plus newline and verify it. Preserve every launch/check receipt.'});
 const tools=await ctx.tool.list();let calls=0;
 const call=async(name,input)=>JSON.parse((await tools.find(t=>t.id==='sortie_v011_'+name).execute(input,{sessionID:session.id,agent:'dog-operator',messageID:'msg_native_launch_qualification',id:'call_native_launch_'+(++calls),signal,progress:async()=>{}})).content);
 const denied=await call('start_work',{command:"python - <<'PY'\\nprint('https://example.test')\\nPY"});
 const corrected=${JSON.stringify(corrected)};
 const retry=await call('start_work',{command:corrected,retry_command:denied.execution_results[0].id});
 const replay=await call('start_work',{command:corrected,retry_command:denied.execution_results[0].id});
 const check=await call('check',{command:${JSON.stringify(checkCommand)}});
 await call('work_status',{});
 const accepted=await call('review_work',{decision:'accept',assessment:'Inspected real native prelaunch denial, linked permitted retry, deduplicated replay and final exact file-content assertion.',checks:[check.id]});
 return JSON.parse(JSON.stringify({denied,retry,replay,check,accepted,model_requests:0}));
}});return cleanup;}};\n`);
  const server = await startV2ReleaseServer(f.project, f.env);
  let result, errorMessage;
  try {
    const { OpenCode } = await import(pathToFileURL(join(f.control, 'node_modules/@opencode/client/dist/promise/index.js')).href);
    const { Rpc } = await import(pathToFileURL(join(f.control, 'node_modules/@opencode/plugin/dist/rpc.js')).href);
    const client = OpenCode.make({ baseUrl: server.url, headers: { authorization: 'Basic ' + Buffer.from('opencode:' + server.env.OPENCODE_SERVER_PASSWORD).toString('base64') } });
    const definition = Rpc.define({ id: 'sortie-native-launch-qualification', events: {}, methods: { run: { input: { type: 'object' }, output: { type: 'object' }, errors: {} } } });
    result = await client.rpc(definition).run({}, { location: { directory: f.project } });
    assert(result.denied.execution_results[0].nativeStatus === 'rejected' && result.denied.execution_results[0].exit === null, 'Native static denial was not identified without inventing an exit');
    assert(result.retry.execution_results[1].exit === 0 && result.retry.execution_results[1].nativeID, 'Corrected native process did not run');
    assert(result.replay.execution_results.length === 2, 'Retry replay duplicated execution');
    assert(result.check.exit === 0 && result.accepted.receipt?.status === 'succeeded', 'Actual final behavior did not reach acceptance');
    assert(await readFile(join(f.project, 'result.txt'), 'utf8') === 'done\n', 'Independent file oracle failed');
  } catch (error) { errorMessage = error.message ?? String(error); }
  finally {
    await server.stop();
    await writeFile(join(f.run, 'qualification.json'), JSON.stringify({ terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage ?? null,
      sha256: hash(await readFile(tgz)), driver_sha256: hash(await readFile(import.meta.filename)), result }, null, 2));
    await rm(join(f.control, 'node_modules'), { recursive: true, force: true });
  }
  if (errorMessage) throw Error(errorMessage + '; evidence: ' + f.run);
  return { terminal: 'succeeded', run: f.run, model_requests: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) nativeLaunchSmoke(resolve(process.argv[2]), resolve(process.argv[3])).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
