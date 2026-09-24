import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { installedFixture, startV2ReleaseServer, command } from './release-cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };

/** Kill the host after a real native exit but before the launch wrapper receives its result. */
export async function commandRecoverySmoke(tgz, directory) {
  const f = await installedFixture(tgz, directory, 'v011');
  const config = await json(join(f.control, 'opencode.json'));
  config.agents = Object.fromEntries(['compaction', 'title', 'summary'].map(name => [name, { model: 'openai/gpt-6-luna-fast#high' }]));
  await writeFile(join(f.control, 'opencode.json'), JSON.stringify(config));
  await writeFile(join(f.project, '.gitignore'), '.opencode/\nresult.txt\n');
  await writeFile(join(f.project, 'runner.mjs'), "import{existsSync,writeFileSync}from'node:fs';if(existsSync('result.txt'))throw Error('duplicate execution');writeFileSync('result.txt','ready\\n');console.log('native one-shot complete');\n");
  await writeFile(join(f.project, 'verify.mjs'), "import{readFileSync}from'node:fs';import assert from'node:assert/strict';assert.equal(readFileSync('result.txt','utf8'),'ready\\n');console.log('ONE-SHOT PASS');\n");
  await writeFile(join(f.project, 'AGENTS.md'), '# Project\nNever edit source/configuration/tests or commit. Run node runner.mjs once; verify with node verify.mjs. If interrupted, inspect the existing native process/result; do not duplicate it.\n');
  const held = join(f.run, 'held.json');
  await writeFile(join(f.control, 'plugins/sortie-dogs/index.js'), `import plugin from 'sortie-dogs';import{existsSync}from'node:fs';import{writeFile}from'node:fs/promises';
export default {...plugin,async setup(ctx){const cleanup=await plugin.setup(ctx);
await ctx.tool.transform(editor=>editor.update('shell',tool=>{const execute=tool.execute;tool.execute=async(input,execution)=>{
const result=await execute(input,execution);if(input.command==='node runner.mjs'&&!existsSync(${JSON.stringify(held)})){
await writeFile(${JSON.stringify(held)},JSON.stringify({root:execution.sessionID,call:execution.id,result}));await new Promise(()=>{});
}return result;};}));return cleanup;}};\n`);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed one-shot recovery']]) await command('git', args, f.project, f.env);
  const protectedFiles = ['runner.mjs', 'verify.mjs', 'AGENTS.md', '.gitignore', '.opencode/opencode.json', '.opencode/plugins/sortie-dogs/index.js'];
  const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async path => [path, hash(await readFile(join(f.project, path)))])));
  let server = await startV2ReleaseServer(f.project, f.env), identity, errorMessage, history, receipt;
  const cli = async (prompt, root, path) => {
    try { await writeFile(path, await command('timeout', ['--signal=TERM', '--kill-after=10s', '300s', 'opencode', 'run', '--server', server.url, '--format', 'json', '--agent', 'dog-operator', '--model', 'openai/gpt-6-sol#xhigh', ...(root ? ['--session', root] : []), prompt], f.project, server.env, 325000)); }
    catch (error) { await writeFile(path, error.processResult?.stdout ?? error.message); }
  };
  const started = Date.now();
  try {
    const first = cli('準備済みの node runner.mjs を1回実行し、node verify.mjs で実行結果を検証して完了してください。', null, join(f.run, 'first.jsonl'));
    const deadline = Date.now() + 120000;
    while (!identity && Date.now() < deadline) { identity = await json(held).catch(() => null); if (!identity) await delay(100); }
    assert(identity?.root, 'Native exit fault boundary not reached');
    await server.stop(); await first;
    server = await startV2ReleaseServer(f.project, f.env);
    await cli('続けてください。', identity.root, join(f.run, 'resumed.jsonl'));
    const response = await fetch(server.url + '/api/session/' + identity.root + '/context', { headers: { authorization: 'Basic ' + Buffer.from('opencode:' + server.env.OPENCODE_SERVER_PASSWORD).toString('base64') } });
    assert(response.ok, 'Native history unavailable'); const value = await response.json(); history = value.data ?? value;
    const review = history.flatMap(m => m.content ?? []).filter(p => p.type === 'tool' && p.name === 'sortie_v011_review_work' && p.state?.status === 'completed').at(-1);
    receipt = review ? JSON.parse(review.state.content.map(p => p.text ?? '').join('')) : null;
    assert(receipt?.receipt?.status === 'succeeded', 'Ambiguous launch did not reach verified same-work acceptance');
    assert(receipt.execution_results.length === 1, 'Recovered one-shot launch was duplicated');
    assert(receipt.execution_results[0].nativeID?.startsWith('sh_') && receipt.execution_results[0].exit === 0, 'Actual native terminal evidence not recovered');
    await command('node', ['verify.mjs'], f.project, f.env);
    for (const [path, digest] of Object.entries(protectedHashes)) assert(hash(await readFile(join(f.project, path))) === digest, 'Protected file changed: ' + path);
  } catch (error) { errorMessage = error.message; }
  finally {
    await server.stop();
    await writeFile(join(f.run, 'native-history.json'), JSON.stringify(history ?? null, null, 2));
    await writeFile(join(f.run, 'qualification.json'), JSON.stringify({ terminal: errorMessage ? 'failed' : 'succeeded', error: errorMessage ?? null, identity, receipt,
      sha256: hash(await readFile(tgz)), driver_sha256: hash(await readFile(import.meta.filename)), elapsed_ms: Date.now() - started, protected_hashes: protectedHashes }, null, 2));
    await rm(join(f.control, 'node_modules'), { recursive: true, force: true });
  }
  if (errorMessage) throw Error(errorMessage + '; evidence: ' + f.run);
  return { terminal: 'succeeded', run: f.run };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) commandRecoverySmoke(resolve(process.argv[2]), resolve(process.argv[3])).then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.message); process.exitCode = 1; });
