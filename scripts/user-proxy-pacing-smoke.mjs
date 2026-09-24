import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';
import { repositoryFixture } from './user-proxy-repository-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const driverHash = hash(await readFile(import.meta.filename));
const repositoryHash = hash(await readFile(new URL('./user-proxy-repository-fixture.mjs', import.meta.url)));
const rows = text => text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const text = content => typeof content === 'string' ? content : (content ?? []).map(p => p.text ?? '').join('\n');
export const PACING_LIMITS = Object.freeze({ known: 60000, ordinary: 120000, calls: 6, next: 90000, completion: 600000, repeats: 3 });

/** Observation only: no tool selection, continuation, test correction or host-policy replacement. */
export async function pacingSmoke(tgz, directory, scenario, mode = 'candidate') {
  if (!['known', 'bug', 'feature', 'repository', 'chain'].includes(scenario)) throw Error('Unknown pacing fixture');
  let f;
  try { f = await installedFixture(tgz, directory, 'v011'); }
  catch (error) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `setup-failure-${Date.now()}.json`), JSON.stringify({ error: error.message, process: error.processResult ?? null }, null, 2));
    throw error;
  }
  const eventPath = join(f.run, 'pacing.jsonl');
  await writeFile(eventPath, '');
  const env = { ...f.env, SORTIE_PACING_EVENTS: eventPath };
  const configPath = join(f.control, 'opencode.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.model = 'openai/gpt-6-sol#xhigh';
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(id => [id, { model: 'openai/gpt-6-luna-fast#high' }]));
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(join(f.control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';
import {appendFile,readFile} from 'node:fs/promises';
export default {...plugin,async setup(ctx){
 const cleanup=await plugin.setup(ctx);let previous;
 const record=row=>appendFile(process.env.SORTIE_PACING_EVENTS,JSON.stringify({at:Date.now(),...row})+'\\n');
 const source=async()=>Promise.all(['src/value.mjs','src/csv.mjs','src/events.mjs','bin/audit.mjs','README.md','REPORT.md'].map(p=>readFile(new URL('../../../'+p,import.meta.url),'utf8').catch(()=>null)));
 await ctx.session.hook('prompt',async e=>record({kind:'request',session:e.sessionID,parent:(await ctx.session.get({sessionID:e.sessionID})).parentID??null}));
 await ctx.session.hook('context',async e=>record({kind:'model',session:e.sessionID,model:e.model}));
 await ctx.tool.hook('execute.before',async e=>{await record({kind:'tool',id:e.id,tool:e.tool,session:e.sessionID,input:e.input});previous??=await source();});
 await ctx.tool.hook('execute.after',async e=>{
   await record({kind:'tool-result',id:e.id,tool:e.tool,session:e.sessionID,status:e.status});
   const b=await source();
   if(previous&&JSON.stringify(previous)!==JSON.stringify(b)){previous=b;await record({kind:'source-change',id:e.id});}
   if(e.tool==='sortie_v011_review_work'&&e.status==='completed'){
     const c=e.result.content,r=JSON.parse(typeof c==='string'?c:c.map(p=>p.text??'').join(''));
     if(r.receipt?.status==='succeeded')await record({kind:'accepted',receipt:r});
   }
 });return cleanup;
}};\n`);
  await mkdir(join(f.project, 'src')); await mkdir(join(f.project, 'test'));
  await writeFile(join(f.project, '.gitignore'), '.opencode/\nresult.txt\n');
  await writeFile(join(f.project, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test/value.test.mjs' } }));
  await writeFile(join(f.project, 'AGENTS.md'), '# Project\nNever edit existing test files, AGENTS.md, package.json, .gitignore or .opencode. Additional tests may go in new files. Do not commit or install dependencies. Use npm test for the behavioral check. Fix routine failures yourself.\n');
  const record = `const record=kind=>{if(process.env.SORTIE_PACING_EVENTS)appendFileSync(process.env.SORTIE_PACING_EVENTS,JSON.stringify({kind,at:Date.now()})+'\\n')};\n`;
  const setup = `import test,{after} from 'node:test';import assert from 'node:assert/strict';import{appendFileSync,readFileSync}from'node:fs';\n${record}after(()=>record('target-result'));\n`;
  let prompt, oracle, repository;
  if (['repository', 'chain'].includes(scenario)) {
    repository = await repositoryFixture(f.project, record, scenario === 'chain');
    ({ prompt, oracle } = repository);
  } else if (scenario === 'known') {
    await writeFile(join(f.project, 'runner.mjs'), `import{appendFileSync,writeFileSync,existsSync}from'node:fs';${record}if(existsSync('result.txt'))throw Error('duplicate launch');record('target-start');writeFileSync('result.txt','ready\\n');record('target-result');\n`);
    await writeFile(join(f.project, 'src/value.mjs'), '// no implementation changes required\n');
    oracle = setup + `test('runner output',()=>{record('target-start');assert.equal(readFileSync('result.txt','utf8'),'ready\\n');});\n`;
    prompt = '準備済みのrunnerを実行してください。コマンドは node runner.mjs です。result.txtが生成され、内容がreadyと改行になることをnpm testで検証してください。runnerやソース、README、テストは変更しないでください。';
  } else if (scenario === 'bug') {
    await writeFile(join(f.project, 'src/value.mjs'), 'export function normalizeTags(values) { return values.map(v => v.trim()); }\n');
    oracle = setup + `import{normalizeTags}from'../src/value.mjs';
test('normalization',()=>{record('target-start');assert.deepEqual(normalizeTags([' a ','',42,'a','A',' b ',null]),['a','A','b']);});
test('nonarrays',()=>{for(const v of [null,undefined,{},42,'x'])assert.deepEqual(normalizeTags(v),[]);});
test('immutable input',()=>{const a=Object.freeze([' x ','x']);assert.deepEqual(normalizeTags(a),['x']);assert.deepEqual(a,[' x ','x']);});\n`;
    prompt = 'タグ正規化のバグを修正してください。文字列配列の前後空白を除き、空文字と文字列以外を除外、大文字小文字は区別して重複を除き順序を保持してください。入力は変更せず、非配列には空配列を返してください。READMEに使い方と例も書いてください。既存テストを保持して検証してください。';
  } else {
    await writeFile(join(f.project, 'src/value.mjs'), "export function chunk(values, size) { throw Error('Not implemented'); }\n");
    oracle = setup + `import{chunk}from'../src/value.mjs';
test('ordered chunks',()=>{record('target-start');assert.deepEqual(chunk([1,2,3,4,5],2),[[1,2],[3,4],[5]]);});
test('size validation',()=>{for(const n of [0,-1,1.5,NaN,Infinity,'2',null])assert.throws(()=>chunk([],n),RangeError);});
test('input validation and immutability',()=>{assert.throws(()=>chunk(null,2),TypeError);const a=Object.freeze([1,2]);const r=chunk(a,5);assert.deepEqual(r,[[1,2]]);assert.notEqual(r[0],a);assert.deepEqual(chunk([],2),[]);});\n`;
    prompt = 'chunk機能を実装してください。配列を指定サイズごとの新しい配列に分割し、順序を保持、末尾の余りも返し、元配列を変更しないこと。空配列には空配列を返し、非配列入力はTypeError、サイズが正の整数でなければRangeErrorにしてください。READMEに仕様と例を書き、既存テストを保持して検証してください。';
  }
  if (!repository) await writeFile(join(f.project, 'README.md'), '# Array utilities\nImplementation in src/value.mjs. Run npm test.\n');
  await writeFile(join(f.project, 'test/value.test.mjs'), oracle);
  await command('git', ['init', '-q', '-b', 'main'], f.project, env);
  await command('git', ['add', '.'], f.project, env);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed pacing fixture'], f.project, env);
  const protectedFiles = ['test/value.test.mjs', 'AGENTS.md', 'package.json', '.gitignore', '.opencode/opencode.json', '.opencode/plugins/sortie-dogs/index.js',
    ...(scenario === 'known' ? ['runner.mjs', 'src/value.mjs', 'README.md'] : []), ...(repository?.protectedFiles ?? [])];
  const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async p => [p, hash(await readFile(join(f.project, p)))])));
  const head = (await command('git', ['rev-parse', 'HEAD'], f.project, env)).trim();
  const server = await startV2ReleaseServer(f.project, env);
  let failure = null, history = [], stdout = '', clientAt = Date.now();
  try {
    try { stdout = await command('timeout', ['--signal=TERM', '--kill-after=10s', '650s', 'opencode', 'run', '--server', server.url, '--format', 'json', '--agent', 'dog-operator', '--model', 'openai/gpt-6-sol#xhigh', prompt], f.project, server.env, 670000); }
    catch (error) { stdout = error.processResult?.stdout ?? ''; failure = error.message; }
    await writeFile(join(f.run, 'native-run.jsonl'), stdout);
    const events = rows(await readFile(eventPath, 'utf8'));
    for (const id of new Set(events.filter(e => e.session).map(e => e.session))) {
      const r = await fetch(server.url + '/api/session/' + id + '/context', { headers: { authorization: `Basic ${Buffer.from('opencode:' + server.env.OPENCODE_SERVER_PASSWORD).toString('base64')}` } });
      if (!r.ok) throw Error('Cannot retain native history');
      const v = await r.json(); history.push({ id, messages: v.data ?? v });
    }
    for (const [p, digest] of Object.entries(protectedHashes)) if (hash(await readFile(join(f.project, p))) !== digest) throw Error('Protected file changed: ' + p);
    if ((await command('git', ['rev-parse', 'HEAD'], f.project, env)).trim() !== head) throw Error('Unauthorized commit');
    await command('npm', ['test'], f.project, { ...env, SORTIE_PACING_EVENTS: '' });
    if (repository) await repository.verify();
    else if (scenario !== 'known' && !(await readFile(join(f.project, 'README.md'), 'utf8')).includes(scenario === 'bug' ? 'normalizeTags' : 'chunk')) throw Error('Requested documentation missing');
  } catch (error) { failure ??= error.message; }
  finally { await server.stop(); }
  const events = rows(await readFile(eventPath, 'utf8'));
  const request = events.find(e => e.kind === 'request' && !e.parent);
  const start = events.find(e => e.kind === 'target-start');
  const accepted = events.find(e => e.kind === 'accepted');
  const tools = events.filter(e => e.kind === 'tool' && e.at <= (start?.at ?? Infinity));
  const gaps = events.flatMap((e, index) => e.kind !== 'target-result' ? [] : [(() => {
    const next = events.slice(index + 1).find(n => ['target-start', 'source-change', 'accepted'].includes(n.kind));
    return next ? next.at - e.at : null;
  })()]);
  const failures = [...(failure ? [failure] : [])];
  const milestones = events.filter(e => ['target-start', 'target-result', 'source-change', 'accepted'].includes(e.kind));
  const continuity = milestones.slice(1).map((e, index) => e.at - milestones[index].at);
  if (!request || !start || start.at - request.at > PACING_LIMITS[['known', 'chain'].includes(scenario) ? 'known' : 'ordinary']) failures.push('target-start-deadline');
  if (scenario !== 'known' && tools.length > PACING_LIMITS.calls) failures.push('pretarget-tool-budget');
  if (!accepted || !request || accepted.at - request.at > PACING_LIMITS.completion) failures.push('verified-completion-deadline');
  if (gaps.some(g => g === null || g > PACING_LIMITS.next)) failures.push('next-action-deadline');
  if (continuity.some(g => g > PACING_LIMITS.next)) failures.push('continued-work-deadline');
  if (['known', 'chain'].includes(scenario) && (tools[0]?.tool !== 'sortie_v011_start_work' || !tools[0]?.input?.command || events.some(e => e.kind === 'model' && e.session !== request?.session && e.at < (start?.at ?? Infinity)))) failures.push('known-runner-not-direct');
  const report = { schema: 1, scenario, mode, sha256: hash(await readFile(tgz)), driver_sha256: driverHash, repository_driver_sha256: repositoryHash, version: f.pkg.version,
    limits: PACING_LIMITS, failures, terminal: failures.length ? 'failed' : 'succeeded', run: f.run,
    client_at: clientAt, received_at: request?.at, target_started_at: start?.at, accepted_at: accepted?.at,
    target_ms: request && start ? start.at - request.at : null, completion_ms: request && accepted ? accepted.at - request.at : null,
    pretarget_tools: tools.length, next_action_gaps_ms: gaps, continuity_gaps_ms: continuity, receipt: accepted?.receipt, protected_hashes: protectedHashes };
  await writeFile(join(f.run, 'native-history.json'), JSON.stringify(history, null, 2));
  await writeFile(join(f.run, 'qualification.json'), JSON.stringify(report, null, 2));
  if (process.env.SORTIE_KEEP_FIXTURE_DEPS !== '1') await rm(join(f.control, 'node_modules'), { recursive: true, force: true });
  console.log(JSON.stringify({ scenario, mode, run: f.run, terminal: report.terminal, failures, target_ms: report.target_ms,
    completion_ms: report.completion_ms, pretarget_tools: tools.length, next_action_gaps_ms: gaps }));
  if (mode === 'candidate' && failures.length) throw Error('Pacing qualification failed: ' + failures.join(', '));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) pacingSmoke(resolve(process.argv[2]), resolve(process.argv[3]), process.argv[4], process.argv[5]).catch(e => { console.error(e.message); process.exitCode = 1; });
