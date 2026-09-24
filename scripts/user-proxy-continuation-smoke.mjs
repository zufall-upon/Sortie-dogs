import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };

/** Targeted recovery qualification: eight real modules, seven injected interruptions.
 * This exercises the dispatch boundary, not ordinary-repository success or natural pacing.
 */
export async function continuationSmoke(tgz, directory) {
  const f = await installedFixture(tgz, directory, 'v011');
  const config = await json(join(f.control, 'opencode.json'));
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(name => [name, { model: 'openai/gpt-6-luna-fast#high' }]));
  await writeFile(join(f.control, 'opencode.json'), JSON.stringify(config));
  for (const path of ['input', 'output', 'test']) await mkdir(join(f.project, path));
  const medium = resolve(import.meta.dirname, '../test/fixtures/representative-medium/project');
  for (let n = 1; n <= 5; n++) for (const path of [`input/unit-${n}.md`, `test/unit-${n}.test.mjs`]) await writeFile(join(f.project, path), await readFile(join(medium, path)));
  const extras = [
    [6, 'port(value = 80): accept integer numbers in [1,65535]; reject other types with TypeError and out-of-range/noninteger/NaN/Infinity with RangeError.',
      "import{port}from'../output/unit-6.mjs';test('port domain',()=>{assert.equal(port(),80);for(const n of [1,80,65535])assert.equal(port(n),n);for(const x of ['80',null,{},true])assert.throws(()=>port(x),TypeError);for(const n of [0,-1,65536,1.5,NaN,Infinity])assert.throws(()=>port(n),RangeError);});"],
    [7, 'escapeCsv(value): strings only (other types throw TypeError). Return unchanged unless comma, quote, CR or LF is present; then surround with double quotes and double each embedded quote.',
      "import{escapeCsv}from'../output/unit-7.mjs';test('CSV field quoting',()=>{for(const s of ['', 'simple',' spaced '])assert.equal(escapeCsv(s),s);for(const s of ['a,b','a\\nb','a\\rb','a\"b'])assert.equal(escapeCsv(s),'\"'+s.replaceAll('\"','\"\"')+'\"');for(const x of [null,undefined,1,[]])assert.throws(()=>escapeCsv(x),TypeError);});"],
    [8, 'stableUnique(values): arrays only (other types throw TypeError). Return a fresh array in first-occurrence order using SameValueZero equality, including NaN. Preserve object identity and never modify input.',
      "import{stableUnique}from'../output/unit-8.mjs';test('stable unique and ownership',()=>{const o={};const a=Object.freeze([o,NaN,0,-0,o,NaN,'x','x']);const r=stableUnique(a);assert.deepEqual(r,[o,NaN,0,'x']);assert.notEqual(r,a);assert.equal(r[0],o);assert.equal(a.length,8);assert.deepEqual(stableUnique([]),[]);for(const x of [null,undefined,{},'x'])assert.throws(()=>stableUnique(x),TypeError);});"],
  ];
  for (const [n, spec, test] of extras) {
    await writeFile(join(f.project, `input/unit-${n}.md`), `Implement output/unit-${n}.mjs with named export ${spec}\nVerify with node --test test/unit-${n}.test.mjs.\n`);
    await writeFile(join(f.project, `test/unit-${n}.test.mjs`), "import test from'node:test';import assert from'node:assert/strict';" + test + '\n');
  }
  for (let n = 1; n <= 8; n++) await writeFile(join(f.project, `output/unit-${n}.mjs`), '// Implementation pending\n');
  await writeFile(join(f.project, 'validate.mjs'), "import{spawnSync}from'node:child_process';const files=Array.from({length:8},(_,n)=>`test/unit-${n+1}.test.mjs`);const r=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});process.exitCode=r.status??1;\n");
  await writeFile(join(f.project, '.gitignore'), '.opencode/\n');
  await writeFile(join(f.project, 'AGENTS.md'), '# Project\nImplement every input/unit-N.md contract (1 through 8). Only the eight matching output/unit-N.mjs files may change. Preserve tests, inputs, validation and configuration. Use node validate.mjs for final full verification. No dependencies or commits.\n');
  const stages = join(f.control, 'completed-units.json'), acceptedPath = join(f.control, 'accepted.json');
  await writeFile(stages, '[]');
  await writeFile(join(f.control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';import{WorkLoop}from'../../node_modules/sortie-dogs/dist/core/work-loop.js';import{readFile,writeFile,appendFile}from'node:fs/promises';
export default {...plugin,async setup(ctx){const cleanup=await plugin.setup(ctx),loop=new WorkLoop(ctx.location.directory,ctx.storage);
const completed=new Set(JSON.parse(await readFile(${JSON.stringify(stages)},'utf8')));
const nextUnit=()=>Array.from({length:8},(_,n)=>n+1).find(n=>!completed.has(n));
await ctx.tool.transform(editor=>{
 editor.update('patch',tool=>{const execute=tool.execute;tool.execute=async(input,execution)=>{
  const s=await ctx.session.get({sessionID:execution.sessionID}),next=nextUnit();
  if(s.agent==='dogs-coordinator'&&next&&[...input.patchText.matchAll(/^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$/gm)].some(m=>m[1]!==('output/unit-'+next+'.mjs')))
    throw Error('Qualification fault boundary: only output/unit-'+next+'.mjs is available until its individual behavior test passes. Original scope remains all eight modules.');
  return execute(input,execution);
 };});
 editor.update('sortie_v011_check',tool=>{const execute=tool.execute;tool.execute=async(input,execution)=>{
  const next=nextUnit();if(next&&input.command!=='node --test test/unit-'+next+'.test.mjs')throw Error('Qualification fault boundary: run node --test test/unit-'+next+'.test.mjs before the next module is available.');
  return execute(input,execution);
 };});
});
await ctx.session.hook('context',async e=>{const s=await ctx.session.get({sessionID:e.sessionID});if(s.agent!=='dogs-coordinator')return;
 const next=nextUnit();
 if(next)e.system.push({type:'text',text:'Qualification fault injection, isolated to this fixture: complete only the next unfinished module, unit '+next+', and run its existing node --test test/unit-'+next+'.test.mjs with sortie_v011_check. A real interruption will cut this invocation after that successful behavior test. Full original scope remains all eight modules; continuation belongs to the operator. Do not skip tests or claim the full task complete.'});
});
await ctx.tool.hook('execute.after',async e=>{
 if(e.status!=='completed'||!['sortie_v011_check','sortie_v011_review_work'].includes(e.tool))return;
 const c=e.result.content,r=JSON.parse(typeof c==='string'?c:c.map(p=>p.text??'').join(''));
 if(e.tool==='sortie_v011_review_work'&&r.receipt?.status==='succeeded'){await writeFile(${JSON.stringify(acceptedPath)},JSON.stringify({root:e.sessionID,result:r}));return;}
 const s=await ctx.session.get({sessionID:e.sessionID});if(s.agent!=='dogs-coordinator'||r.exit!==0)return;
 const match=/test\\/unit-([1-8])\\.test\\.mjs/.exec(r.command??'');if(!match||completed.has(Number(match[1])))return;
 const n=Number(match[1]);completed.add(n);await writeFile(${JSON.stringify(stages)},JSON.stringify([...completed]));
 await appendFile(${JSON.stringify(join(f.run, 'interruptions.jsonl'))},JSON.stringify({at:Date.now(),unit:n,check:r.id,child:s.id,root:s.parentID})+'\\n');
 if(completed.size<8){const work=await loop.current(s.parentID);await loop.stall(s.parentID,work.callID,'Qualification interruption after verified unit '+n+'; remaining original modules still required');void ctx.session.interrupt({sessionID:s.id,resume:false});}
});return cleanup;}};\n`);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed eight-module recovery']]) await command('git', args, f.project, f.env);
  const protectedFiles = ['AGENTS.md', '.gitignore', 'validate.mjs', '.opencode/opencode.json', '.opencode/plugins/sortie-dogs/index.js', ...Array.from({ length: 8 }, (_, n) => [`input/unit-${n+1}.md`, `test/unit-${n+1}.test.mjs`]).flat()];
  const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async path => [path, hash(await readFile(join(f.project, path)))])));
  await writeFile(join(f.run, 'frozen-spec.json'), JSON.stringify({ sha256: hash(await readFile(tgz)), modules: 8, interruptions: 7, max_attempts: 6, timeout_ms: 1200000, protected_hashes: protectedHashes,
    claim: 'Targeted same-child continuation across a real six-dispatch boundary, with real edits and behavior checks. Deliberate per-module fault injection; not an ordinary-task speed benchmark.' }, null, 2));
  const server = await startV2ReleaseServer(f.project, f.env), started = Date.now();
  let accepted, errorMessage, output, history;
  try {
    try { output = await command('timeout', ['--signal=TERM', '--kill-after=10s', '1200s', 'opencode', 'run', '--server', server.url, '--format', 'json', '--agent', 'dog-operator', '--model', 'openai/gpt-6-sol#xhigh', 'input/unit-1.md から unit-8.md までの全仕様を実装し、既存の node validate.mjs で全体を検証して完了してください。'], f.project, server.env, 1225000); }
    catch (error) { output = error.processResult?.stdout ?? error.message; }
    while (!accepted && Date.now() - started < 1200000) { accepted = await json(acceptedPath).catch(() => null); if (!accepted) await delay(200); }
    assert(accepted?.result?.receipt?.status === 'succeeded', 'Eight-module task did not reach autonomous acceptance');
    const result = accepted.result;
    assert(result.attempts >= 8, 'Seven interruption boundaries were not exercised');
    assert(result.attempt_extensions.some(item => item.attempts >= 6), 'No retained extension beyond six dispatches');
    const observed = (await readFile(join(f.run, 'interruptions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert(new Set(observed.map(item => item.child)).size === 1, 'Continuation replaced the native child');
    assert(new Set(observed.map(item => item.unit)).size === 8, 'Not all behavior checkpoints passed');
    assert(result.original_requests.length === 1 && result.unresolved_checks.length === 0, 'Continuation needed user prompting or lost check obligations');
    await writeFile(join(f.run, 'oracle.log'), await command('node', ['validate.mjs'], f.project, f.env));
    for (const [path, digest] of Object.entries(protectedHashes)) assert(hash(await readFile(join(f.project, path))) === digest, 'Protected file changed: ' + path);
    const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + server.env.OPENCODE_SERVER_PASSWORD).toString('base64') };
    history = await Promise.all([accepted.root, result.child_session_id].map(async id => { const response = await fetch(server.url + '/api/session/' + id + '/context', { headers }); const value = await response.json(); return { id, messages: value.data ?? value }; }));
  } catch (error) { errorMessage = error.message; }
  finally {
    const root=accepted?.root;
    if(root&&!history) {
      const headers={authorization:'Basic '+Buffer.from('opencode:'+server.env.OPENCODE_SERVER_PASSWORD).toString('base64')};
      history=await Promise.all([root,accepted.result.child_session_id].filter(Boolean).map(async id=>{
        const response=await fetch(server.url+'/api/session/'+id+'/context',{headers});const value=await response.json();return{id,messages:value.data??value};
      })).catch(error=>({error:error.message}));
    }
    await server.stop(); await writeFile(join(f.run, 'native-run.jsonl'), output ?? '');
    await writeFile(join(f.run, 'native-history.json'), JSON.stringify(history ?? null, null, 2));
    await writeFile(join(f.run, 'qualification.json'), JSON.stringify({ terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage ?? null, accepted,
      sha256: hash(await readFile(tgz)), driver_sha256: hash(await readFile(import.meta.filename)), elapsed_ms: Date.now() - started }, null, 2));
    await rm(join(f.control, 'node_modules'), { recursive: true, force: true });
  }
  if (errorMessage) throw Error(errorMessage + '; evidence: ' + f.run);
  return { terminal: 'succeeded', attempts: accepted.result.attempts, run: f.run };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) continuationSmoke(resolve(process.argv[2]), resolve(process.argv[3])).then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.message); process.exitCode = 1; });
