import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { VALIDATION_WORKFLOW } from '../dist/runtime-mission-assets.js';
import { runtimeAssets } from '../dist/runtime-assets-v010.js';

const roles = ['dog-operator', 'dogs-coordinator', 'dog-worker-v010'];

test('planning and implementation share a staged validation workflow without new authority', () => {
  for (const name of roles) {
    const asset = runtimeAssets.find(item => item.name === name);
    assert.ok(asset, name);
    assert.equal(asset.content.split(VALIDATION_WORKFLOW).length, 2, `${name}: policy exactly once`);
  }
  assert.match(VALIDATION_WORKFLOW, /final integrated candidate,\s+not every implementation unit/);
  assert.match(VALIDATION_WORKFLOW, /Do not execute the entire\s+formal validation list after each patch/);
  assert.match(VALIDATION_WORKFLOW, /do not remove it, substitute a tiny check/);
  assert.match(VALIDATION_WORKFLOW, /host evidence freshness requires it/);
  assert.match(VALIDATION_WORKFLOW, /Documentation-only changes do not automatically invalidate/);
  assert.match(VALIDATION_WORKFLOW, /actual exit\/elapsed time and any rerun reason/);
  assert.match(VALIDATION_WORKFLOW, /this workflow adds no approval or denial/);
  const worker = runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content;
  assert.match(worker, /Run formal validation commands exactly as listed, in declared order/);
  assert.match(worker, /Do not ask the user or delegate to another agent/);
});

test('native CLI init installs the validation workflow in each active mission role', async () => {
  await mkdir('_testenv', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '_testenv', 'validation-assets-'));
  try {
    await promisify(execFile)(process.execPath, ['dist/cli/main.js', 'init', root], { cwd: process.cwd() });
    for (const role of roles) {
      const installed = await readFile(join(root, '.opencode', 'agent', `${role}.md`), 'utf8');
      assert.equal(installed.split(VALIDATION_WORKFLOW).length, 2, role);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
