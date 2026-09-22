import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshot, snapshotHelper, route, run } from '../scripts/test-router.mjs';

test('router preserves native Linux commands and rejects Windows suite on other hosts', () => {
  assert.equal(route('win32', 'quick'), 'wsl');
  assert.equal(route('win32', 'full'), 'wsl');
  assert.equal(route('linux', 'quick'), 'native');
  assert.equal(route('linux', 'full'), 'native');
  assert.equal(route('win32', 'windows'), 'native');
  assert.throws(() => route('linux', 'windows'), /requires Windows/);
  assert.throws(() => route('win32', 'unknown'), /Unknown/);
});

test('snapshot takes current dirty bytes, binary and nonignored untracked files, excluding deleted and generated state', async () => {
  const root = await mkdtemp(join(process.cwd(), '_testenv', 'snapshot-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  try {
    git('init', '-q');
    await writeFile(join(root, '.gitignore'), 'ignored\n');
    await writeFile(join(root, 'dirty'), 'staged');
    await writeFile(join(root, 'deleted'), 'gone');
    git('add', '.');
    await writeFile(join(root, 'dirty'), 'working');
    await rm(join(root, 'deleted'));
    await writeFile(join(root, 'binary'), Buffer.from([0, 255, 1]));
    await writeFile(join(root, 'ignored'), 'ignored');
    for (const path of ['node_modules', 'dist', '_testenv']) {
      await mkdir(join(root, path)); await writeFile(join(root, path, 'excluded'), 'no');
    }
    const first = snapshot(root);
    assert.deepEqual(first.files.map(f => f.path), ['.gitignore', 'binary', 'dirty']);
    assert.equal(Buffer.from(first.files.find(f => f.path === 'dirty')!.data!, 'base64').toString(), 'working');
    assert.deepEqual(Buffer.from(first.files.find(f => f.path === 'binary')!.data!, 'base64'), Buffer.from([0, 255, 1]));
    await rm(join(root, 'binary'));
    const second = snapshot(root);
    assert.notEqual(first.sha256, second.sha256);
    assert.ok(!second.files.some(f => f.path === 'binary'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('router propagates exact child failure', async () => {
  assert.equal(await run(process.execPath, ['-e', 'process.exit(37)'], { stdio: 'ignore' }), 37);
});

test('WSL helper execution stays bound to the captured source after edits', async () => {
  const root = await mkdtemp(join(process.cwd(), '_testenv', 'helper-snapshot-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(join(root, 'scripts'));
    const path = join(root, 'scripts', 'wsl-test-helper.mjs');
    await writeFile(path, 'original helper');
    const captured = snapshot(root);
    await writeFile(path, 'edited helper');
    assert.equal(Buffer.from(snapshotHelper(captured), 'base64').toString(), 'original helper');
    assert.equal(Buffer.from(snapshotHelper(snapshot(root)), 'base64').toString(), 'edited helper');
    await rm(path);
    assert.equal(Buffer.from(snapshotHelper(captured), 'base64').toString(), 'original helper');
    assert.throws(() => snapshotHelper(snapshot(root)), /regular snapshot file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux snapshot helper propagates exit, isolates runs and cancels detached descendants', { skip: process.platform !== 'linux', timeout: 30000 }, async () => {
  const start = (code: string) => {
    const contents = {
      'package.json': '{"name":"router-fixture","version":"1.0.0","type":"module","scripts":{"test":"node scripts/test-router.mjs"}}',
      'package-lock.json': '{"name":"router-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"router-fixture","version":"1.0.0"}}}',
      'scripts/test-router.mjs': code,
    };
    const files = Object.entries(contents).map(([path, data]) => ({ path, data: Buffer.from(data).toString('base64'), mode: 0o644 }));
    const child = spawn(process.execPath, ['scripts/wsl-test-helper.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdin.write(JSON.stringify({ files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), mode: 'quick' }) + '\n');
    const heartbeat = setInterval(() => { if (!child.stdin.writableEnded) child.stdin.write('heartbeat\n'); }, 1000);
    child.stdin.on('error', () => {});
    const closed = new Promise<number | null>(resolve => child.once('close', code => { clearInterval(heartbeat); resolve(code); }));
    return { child, closed, output: () => output };
  };
  const first = start('process.exit(37)');
  assert.equal(await first.closed, 37, first.output());
  const firstRoot = JSON.parse(first.output().split('\n').find(line => line.startsWith('SORTIE_WSL_RUN '))!.slice(15)).root;
  await assert.rejects(readFile(join(firstRoot, 'package.json')), { code: 'ENOENT' });
  const second = start("import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log('DESCENDANT '+c.pid); setInterval(()=>{},1000);");
  const until = Date.now() + 10000;
  while (!second.output().includes('DESCENDANT ') && Date.now() < until) await new Promise(done => setTimeout(done, 50));
  const pid = Number(/DESCENDANT (\d+)/.exec(second.output())?.[1]);
  assert.ok(pid > 0, second.output());
  second.child.stdin.end();
  assert.notEqual(await second.closed, 0);
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    assert.match(stat, /\) Z /, 'owned detached descendant must be dead');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const secondRoot = JSON.parse(second.output().split('\n').find(line => line.startsWith('SORTIE_WSL_RUN '))!.slice(15)).root;
  assert.notEqual(firstRoot, secondRoot);
  await assert.rejects(readFile(join(secondRoot, 'package.json')), { code: 'ENOENT' });
});
