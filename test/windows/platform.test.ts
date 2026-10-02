import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectKey } from '../../dist/reflection/config.js';
import { createProjectPaths, createWriteGate, WriteDeniedError } from '../../dist/plugin/gate.js';
import { stopOwnedTree } from '../helpers/full-test-runner.ts';
import { validationScratchPaths, prepareValidationScratch } from '../../dist/plugin/validation-scratch.js';
// Exercise the optimized containment and exact contract view on the native Windows path implementation too.
import '../snapshot-scratch-exclusion.test.ts';
import '../native-contract-read.test.ts';

assert.equal(process.platform, 'win32', 'Windows suite requires Windows');
test('Windows reflection identity is case insensitive', () => {
  assert.equal(projectKey('C:\\Projects\\Example'), projectKey('c:\\projects\\EXAMPLE'));
});
test('WSL validation scratch uses the native project identity for freshness and preparation', async () => {
  const root = 'M:\\_work\\_Anko';
  const command = 'wsl.exe -d Ubuntu -- bash -lc \'cd /mnt/m/_work/_Anko && /usr/bin/env GOCACHE="/mnt/m/_work/_Anko/.gocache" GOMODCACHE="/mnt/m/_work/_Anko/.gomodcache" GOPATH="/mnt/m/_work/_Anko/.gopath" TMPDIR="/mnt/m/_work/_Anko/.tmp" go test ./parser ./env ./vm\'';
  assert.deepEqual(validationScratchPaths(root, [command]), [join(root, '.gocache'), join(root, '.gomodcache'),
    join(root, '.gopath/pkg/mod'), join(root, '.gopath/pkg/sumdb'), join(root, '.tmp')].sort());
  assert.deepEqual(validationScratchPaths(root, ['TMPDIR=/mnt/c/outside GOCACHE=/mnt/m/_work/_Anko/.git/cache TMPDIR="$UNKNOWN"']), []);
  const directory = await mkdtemp(join(process.cwd(), '_testenv', 'windows-scratch-'));
  try {
    const wsl = `/mnt/${directory[0]!.toLowerCase()}/${directory.slice(3).replaceAll('\\', '/')}/.tmp`;
    const checks = [`wsl.exe -- /usr/bin/env TMPDIR="${wsl}" go test ./parser`];
    assert.deepEqual(validationScratchPaths(directory, checks), [join(directory, '.tmp')]);
    assert.deepEqual((await prepareValidationScratch(directory, checks)).prepared_directories, ['.tmp']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Windows junction cannot escape the declared write scope', async () => {
  const root = await mkdtemp(join(process.cwd(), '_testenv', 'windows-junction-'));
  try {
    await mkdir(join(root, 'scope')); await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'scope', 'link'), 'junction');
    const gate = await createWriteGate(await createProjectPaths(root), { version: '0.1.0', task_id: 'windows-junction', read: [], write: ['scope'], validation: [] });
    await assert.rejects(gate.checkPath(join(root, 'scope', 'link', 'escaped.txt')), WriteDeniedError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Windows cleanup stops the owned process tree', async () => {
  const child = spawn(process.execPath, ['-e', "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = await new Promise<number>(resolve => child.stdout.once('data', data => resolve(Number(data.toString().trim()))));
  try {
    assert.equal(await stopOwnedTree(child.pid!), true);
    assert.throws(() => process.kill(pid, 0));
  } finally { if (child.pid) await stopOwnedTree(child.pid); }
});
