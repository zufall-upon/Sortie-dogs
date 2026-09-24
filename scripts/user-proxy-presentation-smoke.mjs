import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const assert = (condition, message) => { if (!condition) throw Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function presentationSmoke(tgz, directory, pythonPath) {
  const f = await installedFixture(tgz, directory, 'v011');
  const config = await json(join(f.control, 'opencode.json'));
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(id => [id, { model: 'openai/gpt-6-luna-fast#high' }]));
  config.model = 'openai/gpt-6-sol#xhigh';
  await writeFile(join(f.control, 'opencode.json'), JSON.stringify(config));
  await writeFile(join(f.control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';import{appendFile,writeFile}from'node:fs/promises';
import{observeAuxiliaryResponse}from'../../node_modules/sortie-dogs/dist/plugin/work-usage.js';
export default {...plugin,async setup(ctx){const cleanup=await plugin.setup(ctx),abort=new AbortController();
const log=value=>appendFile(${JSON.stringify(join(f.run, 'native-shell.jsonl'))},JSON.stringify(value)+'\\n');
const snapshot=async()=>{const entries=[];let after;do{
 const page=await ctx.storage.scan({prefix:'work-loop/',limit:100,...(after?{after}:{})});
 for(const entry of page.entries){const work=entry.value?.work??entry.value;if(work?.directory===ctx.location.directory)entries.push(entry);}
 after=page.next;
}while(after);return{entries};};
await ctx.session.hook('model.request',event=>log({kind:'model-request',sessionID:event.sessionID,flow:event.kind,model:event.model}));
await ctx.session.hook('http.response',event=>{
 if(['title','generate'].includes(event.kind)){
  void log({kind:'auxiliary-response',flow:event.kind,status:event.response.status,content_type:event.response.headers.get('content-type')});
  void observeAuxiliaryResponse(event.response.clone(),value=>log({kind:'auxiliary-payload',flow:event.kind,keys:Object.keys(value),usage:value.usage??value.response?.usage}));
 }
});
await ctx.tool.transform(editor=>editor.update('shell',tool=>{const execute=tool.execute;tool.execute=async(input,execution)=>{
 const result=await execute(input,{...execution,progress:async value=>{await log({kind:'progress',value});await execution.progress?.(value);}});
 await log({kind:'result',input,result});return result;};}));
void(async()=>{for await(const e of ctx.event.subscribe({signal:abort.signal})){
 if(e.type.startsWith('shell.'))await log(e);
 if(e.type==='session.execution.succeeded'){
  const s=await ctx.session.get({sessionID:e.data.sessionID});if(s.agent==='dog-operator'&&!s.parentID){
   await new Promise(resolve=>setTimeout(resolve,200));
   await writeFile(${JSON.stringify(join(f.run, 'retained-ledger.json'))},JSON.stringify(await snapshot()));
  }
 }
}})().catch(()=>{});
return async()=>{abort.abort();await writeFile(${JSON.stringify(join(f.run, 'retained-ledger.json'))},JSON.stringify(await snapshot()));cleanup?.();};}};\n`);
  await writeFile(join(f.project, '.gitignore'), '.opencode/\n');
  await mkdir(join(f.project, 'src'));
  await writeFile(join(f.project, 'src/tags.mjs'), 'export function tags(values) { return values.map(v => v.trim()); }\n');
  await writeFile(join(f.project, 'check.mjs'), "import{tags}from'./src/tags.mjs';import assert from'node:assert/strict';await new Promise(r=>setTimeout(r,8000));assert.deepEqual(tags([' a ','',42,'a','A',null,' b ']),['a','A','b']);for(const v of [null,{},'x'])assert.deepEqual(tags(v),[]);const a=Object.freeze([' x ','x']);assert.deepEqual(tags(a),['x']);console.log('TARGET PASS');\n");
  await writeFile(join(f.project, 'AGENTS.md'), '# Project\nOnly src/tags.mjs may change. Preserve the existing check and configuration. Use node check.mjs to verify behavior. No dependencies or commits.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed UI fixture']]) await command('git', args, f.project, f.env);
  const server = await startV2ReleaseServer(f.project, f.env);
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(server.url + path, { method, headers: { authorization: 'Basic ' + Buffer.from('opencode:' + server.env.OPENCODE_SERVER_PASSWORD).toString('base64'), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert(r.ok, 'UI native API HTTP ' + r.status); if (r.status === 204) return; const v = await r.json(); return v.data ?? v;
  };
  let capture, exited, root, messages, errorMessage, result, replayed = false, accounting;
  const captureScreen = directory => {
    const child = spawn('python', [resolve(import.meta.dirname, 'user-proxy-tui-capture.py'), f.project, server.url, root.id, directory],
      { cwd: f.project, env: { ...process.env, ...server.env, PYTHONPATH: pythonPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const exit = new Promise(resolve => child.on('close', async code => {
      const receipt = { code, output }; await writeFile(join(directory, 'capture-exit.json'), JSON.stringify(receipt)); resolve(receipt);
    }));
    return { child, exit };
  };
  try {
    root = await api('/api/session', 'POST', { agent: 'dog-operator', model: { providerID: 'openai', id: 'gpt-6-sol', variant: 'xhigh' }, location: { directory: f.project } });
    ({ child: capture, exit: exited } = captureScreen(f.run));
    const readyBy = Date.now() + 30000;
    while (Date.now() < readyBy && !await json(join(f.run, 'tui-ready.json')).catch(() => null)) await delay(100);
    assert(await json(join(f.run, 'tui-ready.json')).catch(() => null), 'Native TUI did not render');
    await api('/api/session/' + root.id + '/prompt', 'POST', { text: 'タグ正規化のバグを修正してください。文字列だけの前後空白を除き、空文字を除外。大文字小文字を区別して重複を除き順序を保持し、入力を変更しないこと。非配列には空配列を返してください。既存の node check.mjs で検証して完了してください。' });
    const deadline = Date.now() + 210000;
    while (Date.now() < deadline) {
      messages = await api('/api/session/' + root.id + '/context');
      const final = messages.filter(m => m.type === 'assistant' && m.time?.completed && !(m.content ?? []).some(p => p.type === 'tool')).at(-1);
      if ((final?.content ?? []).some(p => p.type === 'text' && p.text.includes('PACK RECORD'))) break;
      await delay(500);
    }
    const accepted = messages.flatMap(m => m.content ?? []).find(p => p.type === 'tool' && p.name === 'sortie_v011_review_work' && p.state?.status === 'completed');
    result = accepted ? JSON.parse(accepted.state.content.map(p => p.text ?? '').join('')) : null;
    assert(result?.receipt?.status === 'succeeded', 'UI task never reached real acceptance');
    await writeFile(join(f.run, 'inspect-report'), 'Read all panels with ordinary TUI navigation');
    const inspectBy = Date.now() + 6000;
    while (Date.now() < inspectBy && !await readFile(join(f.run, 'report-inspected')).catch(() => null)) await delay(100);
    await writeFile(join(f.run, 'capture-stop'), ''); assert((await exited).code === 0, 'Native capture process failed');
    const rendered = await json(join(f.run, 'capture.json'));
    for (const stage of ['departure', 'live', 'executing', 'overview-live', 'overview-returned', 'return', 'mission', 'cost', 'career']) assert(rendered.stages.includes(stage), 'Native screen did not show ' + stage);
    const liveOverview = await readFile(join(f.run, 'screen-overview-live.txt'), 'utf8');
    assert(!liveOverview.includes('依頼全体を受理・帰還済み'), 'Live work was displayed as accepted completion');
    const final = messages.filter(m => m.type === 'assistant').at(-1).content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    assert(final.includes(result.return_report), 'Displayed response differs from the canonical host report');
    assert(final.split(result.return_report).length === 2, 'Report duplicated within final response');
    const replayDir = join(f.run, 'replay'); await mkdir(replayDir);
    const requests = async () => (await readFile(join(f.run, 'native-shell.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.kind === 'model-request');
    const beforeReplay = await requests(), beforeMessages = JSON.stringify(await api('/api/session/' + root.id + '/context'));
    const replay = captureScreen(replayDir);
    try {
      const readyBy = Date.now() + 30000;
      while (Date.now() < readyBy && !await json(join(replayDir, 'tui-ready.json')).catch(() => null)) await delay(100);
      assert(await json(join(replayDir, 'tui-ready.json')).catch(() => null), 'Replay TUI did not render');
      await writeFile(join(replayDir, 'inspect-report'), 'Replay the existing report without a new prompt');
      const inspectedBy = Date.now() + 6000;
      while (Date.now() < inspectedBy && !await readFile(join(replayDir, 'report-inspected')).catch(() => null)) await delay(100);
    } finally { await writeFile(join(replayDir, 'capture-stop'), ''); assert((await replay.exit).code === 0, 'Replay capture failed'); }
    const replayCapture = await json(join(replayDir, 'capture.json'));
    for (const stage of ['overview-returned', 'return', 'mission', 'cost', 'career']) assert(replayCapture.stages.includes(stage), 'Replayed screen did not show ' + stage);
    assert(JSON.stringify(await requests()) === JSON.stringify(beforeReplay), 'Replaying presentation made a model request');
    assert(JSON.stringify(await api('/api/session/' + root.id + '/context')) === beforeMessages, 'Replay changed native history');
    const family = [{ id: root.id, messages }, ...(result.child_session_id ? [{ id: result.child_session_id, messages: await api('/api/session/' + result.child_session_id + '/context') }] : [])];
    await writeFile(join(f.run, 'native-family.json'), JSON.stringify(family, null, 2));
    const ledger = await json(join(f.run, 'retained-ledger.json'));
    const work = ledger.entries.map(e => e.value.work ?? e.value).find(w => w.id === result.work_id);
    assert(work?.presentation?.id === result.return_report_id && work.presentation.report === result.return_report, 'Retained report differs from the displayed receipt');
    const returnedOverview = await readFile(join(replayDir, 'screen-overview-returned.txt'), 'utf8');
    for (const value of ['依頼全体を受理・帰還済み', '依頼全体を検証・受理', 'なし（受理した依頼範囲）', 'src/tags.mjs', work.id]) {
      assert(returnedOverview.includes(value), 'Five-field overview omitted retained result: ' + value);
    }
    const paid = family.flatMap(s => s.messages.filter(m => ['assistant', 'compaction'].includes(m.type) && m.time?.completed && m.time.created >= work.startedAt));
    for (const message of paid) assert(work.usageReceipts?.[message.id], 'Durable accounting omitted native request ' + message.id);
    const last = messages.filter(m => m.type === 'assistant' && m.time?.completed).at(-1);
    assert(work.usageReceipts[last.id], 'Final response is missing from durable accounting');
    const auxiliaryRequests = (await requests()).filter(e => ['title', 'generate'].includes(e.flow));
    const auxiliaryReceipts = Object.entries(work.usageReceipts).filter(([id]) => id.startsWith('auxiliary:'));
    assert(auxiliaryRequests.some(e => e.flow === 'title'), 'Native automatic title generation was not exercised');
    assert(auxiliaryRequests.length === auxiliaryReceipts.length, 'Auxiliary native requests were omitted or counted twice');
    assert(auxiliaryReceipts.every(([, receipt]) => !receipt.pending && receipt.tokens > 0 && receipt.usd > 0), 'Completed native auxiliary usage was not retained');
    accounting = { native_requests: paid.length, retained_receipts: Object.keys(work.usageReceipts).length, final_response_retained: true,
      native_auxiliary_requests: auxiliaryRequests.length, retained_auxiliary_receipts: auxiliaryReceipts.length,
      report_is_pre_final_snapshot: true, ledger_tokens: work.usage.tokens, ledger_usd: work.usage.usd };
    replayed = true;
    await command('node', ['check.mjs'], f.project, f.env);
  } catch (error) { errorMessage = error.message; }
  finally {
    await writeFile(join(f.run, 'capture-stop'), ''); if (exited) await exited;
    await server.stop();
    await writeFile(join(f.run, 'native-history.json'), JSON.stringify(messages ?? null, null, 2));
    await writeFile(join(f.run, 'qualification.json'), JSON.stringify({ terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage ?? null, root: root?.id,
      replayed_without_model_calls: replayed, accounting,
      sha256: hash(await readFile(tgz)), ui: 'OpenCode native TUI; desktop browser remains unverified', driver_sha256: hash(await readFile(import.meta.filename)) }, null, 2));
    await rm(join(f.control, 'node_modules'), { recursive: true, force: true });
  }
  if (errorMessage) throw Error(errorMessage + '; evidence: ' + f.run);
  return { terminal: 'succeeded', run: f.run, root: root.id };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) presentationSmoke(resolve(process.argv[2]), resolve(process.argv[3]), resolve(process.argv[4])).then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.message); process.exitCode = 1; });
