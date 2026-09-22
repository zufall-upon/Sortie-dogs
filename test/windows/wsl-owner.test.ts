import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
assert.equal(process.platform, 'win32', 'Windows suite requires Windows');

test('Windows cancellation pipe stops the owned detached WSL descendant and propagates cancellation', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(process.cwd(), '_testenv', 'wsl-owner-'));
  let owner;
  try {
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
    await mkdir(join(root, 'scripts'));
    await copyFile(resolve('scripts/wsl-test-helper.mjs'), join(root, 'scripts/wsl-test-helper.mjs'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'owner-fixture', version: '1.0.0', type: 'module', scripts: { test: 'node scripts/test-router.mjs' } }));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'owner-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'owner-fixture', version: '1.0.0' } } }));
    await writeFile(join(root, 'scripts/test-router.mjs'), "import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log('OWNED_PID '+c.pid);setInterval(()=>{},1000);");
    const cancel = join(root, 'cancel.request');
    owner = spawn(process.execPath, [resolve('scripts/test-router.mjs'), 'quick'], { cwd: root, env: { ...process.env, SORTIE_TEST_CANCEL_FILE: cancel }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    owner.stdout.on('data', chunk => { output += chunk; });
    owner.stderr.on('data', chunk => { output += chunk; });
    const closed = new Promise<number | null>(done => owner.once('close', done));
    const deadline = Date.now() + 15000;
    while (!output.includes('OWNED_PID ') && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    const pid = Number(/OWNED_PID (\d+)/.exec(output)?.[1]);
    assert.ok(pid > 0, output);
    await writeFile(cancel, 'cancel');
    assert.equal(await closed, 130, output);
    const { stdout } = await exec('wsl.exe', ['--distribution', process.env.SORTIE_WSL_DISTRO || 'Ubuntu', '--exec', 'bash', '-lc', `cat /proc/${pid}/stat 2>/dev/null || true`]);
    assert.ok(stdout.trim() === '' || /\) Z /.test(stdout), stdout);
  } finally {
    if (owner?.exitCode === null) owner.kill();
    await rm(root, { recursive: true, force: true });
  }
});
