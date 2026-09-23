import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';
import { createInferenceManifest, createInstancePrompt, cloneInstance, benchmarkPermissionPolicy } from './swebench-lite-runner.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };
const events = value => value.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const content = value => typeof value === 'string' ? value : value?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';

export async function prepareUserProxyCandidate(candidate, tgz, directory) {
  assert(hash(await readFile(tgz)) === candidate.sha256, 'candidate-package-sha256-mismatch');
  const fixture = await installedFixture(tgz, directory, 'v011');
  assert(fixture.pkg.version === candidate.version, 'candidate-package-version-mismatch');
  assert(fixture.runtimeMarker === candidate.runtime_marker, 'candidate-runtime-marker-mismatch');
  const plugin = await import(pathToFileURL(join(fixture.installed, 'dist/index.js')).href);
  assert(plugin.default?.id === 'sortie-dogs.v011' && typeof plugin.default.setup === 'function', 'candidate-v011-entry-invalid');
  assert(Number(fixture.cliVersion.split('.')[0]) >= 2, 'Native OpenCode V2 is required');
  return { environment: fixture.env, runtimeRoot: fixture.run, evidence: { package_sha256: candidate.sha256,
    version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker, profile: 'v011', agent: 'dog-operator',
    opencode_version: fixture.cliVersion, default_plugin: plugin.default.id, runtime_assets_verified: true } };
}

/** One declared public dev23 case, native v0.11 inference, then an immutable patch for external official scoring. */
export async function userProxyBench(tgz, sourceManifest, instanceID, directory, costLimit = 1.5) {
  assert(Number.isFinite(costLimit) && costLimit > 0, 'A positive per-case budget is required');
  const input = createInferenceManifest(JSON.parse(await readFile(sourceManifest, 'utf8')));
  assert(input.dataset.split === 'dev' && input.instances.length === 23, 'Expected the pinned public dev23 manifest');
  const instance = input.instances.find(item => item.instance_id === instanceID);
  assert(instance, 'Case is not in the pinned dev23 set');
  const driverHash = hash(await readFile(import.meta.filename));
  const packageHash = hash(await readFile(tgz));
  const fixture = await installedFixture(tgz, directory, 'v011');
  const { project, control, env, run, cliVersion } = fixture;
  assert(Number(cliVersion.split('.')[0]) >= 2, 'Native OpenCode V2 is required');
  const workspace = join(project, 'repository');
  await cloneInstance(instance, workspace);
  const configPath = join(control, 'opencode.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.model = 'openai/gpt-6-sol#xhigh';
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(name => [name, { model: 'openai/gpt-6-luna-fast#high' }]));
  config.permissions = [
    { action: '*', resource: '*', effect: 'allow' },
    ...['webfetch', 'websearch', 'browser*'].map(action => ({ action, resource: '*', effect: 'deny' })),
    ...Object.entries(benchmarkPermissionPolicy().bash).filter(([, value]) => value === 'deny')
      .map(([resource]) => ({ action: 'shell', resource, effect: 'deny' })),
  ];
  await writeFile(configPath, JSON.stringify(config, null, 2));
  // Qualification-only observation and request-boundary budget. Production routing comes from the installed package.
  await writeFile(join(control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';
import {appendFile} from 'node:fs/promises';
import {estimateModelUsageCost} from '../../node_modules/sortie-dogs/dist/plugin/model-cost.js';
export default {...plugin,async setup(ctx){
  const cleanup=await plugin.setup(ctx),seen=new Set();
  const record=value=>appendFile(new URL('../../benchmark-routing.jsonl',import.meta.url),JSON.stringify(value)+'\\n');
  const {data:models}=await ctx.model.list();
  const fast=models.find(model=>model.providerID==='openai'&&model.id==='gpt-6-luna-fast');
  if(!fast||fast.modelID!=='gpt-6-luna'||!['priority','fast'].includes(fast.body?.service_tier))throw Error('Native Fast catalog missing');
  await record({kind:'catalog',model:fast.id,api_model:fast.modelID,tier:fast.body.service_tier});
  async function usage(){
    let usd=0,requests=0;const unpriced=[];
    for(const sessionID of seen){let cursor;
      for(let page=0;page<100;page++){
        const result=await ctx.message.list({sessionID,limit:100,...(cursor?{cursor}:{order:'asc'})});
        for(const m of result.data){
          if(!['assistant','compaction'].includes(m.type)||!m.time?.completed)continue;
          const t=m.tokens??{},model=m.model??{};
          const price=estimateModelUsageCost({providerID:model.providerID,modelID:model.id,uncachedInputTokens:t.input,
            cacheReadTokens:t.cache?.read,cacheWriteTokens:t.cache?.write,outputTokens:t.output,reasoningTokens:t.reasoning,
            serviceTier:model.id==='gpt-6-luna-fast'?'priority':m.providerState?.serviceTier??'standard'});
          requests++;if(price.status==='priced')usd+=price.usd;else unpriced.push(model);
        }
        cursor=result.cursor?.next;if(!cursor)break;
        if(page===99)throw Error('Benchmark usage history limit');
      }
    }return{usd,requests,unpriced};
  }
  for(const kind of ['context','compaction','title','generate'])await ctx.session.hook(kind,async event=>{
    seen.add(event.sessionID);const cost=await usage();await record({kind:'usage',...cost});
    if(cost.unpriced.length||cost.usd>=${JSON.stringify(costLimit)})throw Error('Benchmark request-boundary cost limit');
    if(event.tools)for(const name of Object.keys(event.tools))if(/browser|webfetch|websearch/.test(name))delete event.tools[name];
  });
  await ctx.session.hook('http.request',async event=>{
    if(event.request.method!=='POST')return;const body=await event.request.clone().json().catch(()=>({}));
    if(body.model)await record({kind:event.kind,sessionID:event.sessionID,model:event.model.id,api_model:body.model,tier:body.service_tier??null,transport:'http'});
  });
  await ctx.session.hook('experimental.ws.send',async event=>{
    const frame=JSON.parse(event.frame);if(frame.type!=='response.create')return;const body=frame.response??frame;
    await record({kind:event.kind,sessionID:event.sessionID,model:event.model.id,api_model:body.model,tier:body.service_tier??null,transport:'ws'});
  });
  return cleanup;
}};\n`);
  const frozen = { schema: 1, dataset: input.dataset, instance,
    candidate: { version: fixture.pkg.version, sha256: packageHash, runtime_marker: fixture.runtimeMarker, profile: 'v011',
      source_commit: (await command('git', ['rev-parse', 'HEAD'], resolve(import.meta.dirname, '..'), env)).trim() },
    source_manifest_sha256: hash(await readFile(sourceManifest)), driver_sha256: driverHash,
    cliVersion, cost_limit_usd: costLimit, timeout_seconds: 1800, attempts: 1,
    models: { operator: 'openai/gpt-6-sol#xhigh', implementer: 'openai/gpt-6-luna-fast#max', auxiliary: 'openai/gpt-6-luna-fast#high' },
    scoring: 'external official Docker harness after all inference writers stop and patch is frozen' };
  await writeFile(join(run, 'frozen-input.json'), JSON.stringify(frozen, null, 2));
  const server = await startV2ReleaseServer(workspace, env);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${server.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` };
  const api = async path => {
    const response = await fetch(server.url + path, { headers });
    assert(response.ok, `Native API ${path}: ${response.status}`);
    const value = await response.json(); return value.data ?? value;
  };
  const started = Date.now(); let root, errorMessage = null, family = [], receipt;
  try {
    let output;
    try {
      output = await command('timeout', ['--signal=TERM', '--kill-after=10s', '1800s', 'opencode', 'run', '--server', server.url,
        '--format', 'json', '--agent', 'dog-operator', '--model', 'openai/gpt-6-sol#xhigh', createInstancePrompt(instance)], workspace, server.env, 1840000);
    } catch (error) { output = error.processResult?.stdout ?? ''; errorMessage = error.message; }
    await writeFile(join(run, 'inference.jsonl'), output);
    root = events(output).find(event => event.sessionID)?.sessionID;
    assert(root, 'No native root session');
    const messages = await api(`/api/session/${root}/context`);
    const parts = messages.flatMap(message => message.content ?? []);
    const children = [...new Set(parts.filter(part => part.type === 'tool' && part.name === 'subagent').flatMap(part => part.state?.metadata?.sessionID ?? []))];
    family = [{ id: root, messages }, ...await Promise.all(children.map(async id => ({ id, messages: await api(`/api/session/${id}/context`) })))];
    const review = parts.filter(part => part.name === 'sortie_v011_review_work' && part.state?.status === 'completed').at(-1);
    receipt = review ? JSON.parse(content(review.state.content)) : null;
    assert(!errorMessage, errorMessage);
    assert(receipt?.receipt?.status === 'succeeded', 'Operator did not accept the benchmark task');
    assert(receipt.checks.some(check => check.current && check.exit === 0), 'No current successful native check');
    const routing = events(await readFile(join(control, 'benchmark-routing.jsonl'), 'utf8'));
    const luna = routing.filter(item => item.transport && item.model === 'gpt-6-luna-fast');
    assert(luna.length && luna.every(item => item.api_model === 'gpt-6-luna' && ['priority', 'fast'].includes(item.tier)), 'Fast routing was lost');
    assert((await command('git', ['rev-parse', 'HEAD'], workspace, env)).trim() === instance.base_commit, 'Benchmark worker committed');
  } catch (error) { errorMessage = error.message; }
  finally { await server.stop(); }
  // All native writers have stopped. Preserve even an unsuccessful patch for transparent diagnosis/scoring.
  await command('git', ['add', '-N', '--', '.'], workspace, env);
  const patch = await command('git', ['diff', '--binary', '--no-ext-diff', '--no-color', 'HEAD'], workspace, env);
  await writeFile(join(run, 'candidate.patch'), patch, { flag: 'wx' });
  const prediction = { instance_id: instanceID, model_name_or_path: `sortie-dogs-v${fixture.pkg.version}-native`, model_patch: patch };
  await writeFile(join(run, 'predictions.jsonl'), JSON.stringify(prediction) + '\n', { flag: 'wx' });
  const report = { ...frozen, root, elapsed_ms: Date.now() - started, terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage,
    receipt, patch_sha256: hash(patch), patch_bytes: Buffer.byteLength(patch),
    routing: events(await readFile(join(control, 'benchmark-routing.jsonl'), 'utf8').catch(() => '')) };
  await writeFile(join(run, 'native-history.json'), JSON.stringify(family, null, 2));
  await writeFile(join(run, 'inference-result.json'), JSON.stringify(report, null, 2));
  if (errorMessage) throw Error(`${errorMessage}; evidence: ${join(run, 'inference-result.json')}`);
  return { ...report, run };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  userProxyBench(...process.argv.slice(2, 6).map((value, index) => index === 2 ? value : resolve(value)), Number(process.argv[6] ?? 1.5))
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
