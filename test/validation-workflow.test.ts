import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MISSION_GIT_SCOPE, VALIDATION_WORKFLOW, WORKER_VALIDATION_WORKFLOW } from '../dist/runtime-mission-assets.js';
import { runtimeAssets } from '../dist/runtime-assets-v010.js';

const roles = ['dog-operator', 'dogs-coordinator', 'dog-worker-v010'];

test('planning and implementation share a staged validation workflow without new authority', () => {
  for (const name of roles) {
    const asset = runtimeAssets.find(item => item.name === name);
    assert.ok(asset, name);
    const policy = name === 'dog-worker-v010' ? WORKER_VALIDATION_WORKFLOW : VALIDATION_WORKFLOW;
    assert.equal(asset.content.split(policy).length, 2, `${name}: role policy exactly once`);
  }
  assert.match(VALIDATION_WORKFLOW, /final integrated candidate,\s+not every implementation unit/);
  assert.match(VALIDATION_WORKFLOW, /Do not execute the entire\s+formal validation list after each patch/);
  assert.match(VALIDATION_WORKFLOW, /do not remove it, substitute a tiny check/);
  assert.match(VALIDATION_WORKFLOW, /host evidence freshness requires it/);
  assert.match(VALIDATION_WORKFLOW, /Documentation-only changes do not automatically invalidate/);
  assert.match(VALIDATION_WORKFLOW, /actual exit\/elapsed time and any rerun reason/);
  assert.match(VALIDATION_WORKFLOW, /this workflow adds no approval or denial/);
  assert.match(VALIDATION_WORKFLOW, /formal check from the user, project or task context/);
  assert.match(VALIDATION_WORKFLOW, /literal command in the original request is not required; empty or dummy checks do not qualify/);
  assert.match(WORKER_VALIDATION_WORKFLOW, /never drop required broad validation/);
  assert.match(WORKER_VALIDATION_WORKFLOW, /host evidence freshness requires it/);
  assert.match(WORKER_VALIDATION_WORKFLOW, /independent\s+review, accepted criteria and cumulative budget/);
  assert.doesNotMatch(WORKER_VALIDATION_WORKFLOW, /Operator\/Coordinator:/);
  const worker = runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content;
  assert.match(worker, /Run formal validation commands exactly as listed, in declared order/);
  assert.match(worker, /Do not ask the user or delegate to another agent/);
  for (const name of roles) {
    const content = runtimeAssets.find(item => item.name === name)!.content;
    assert.equal(content.split(MISSION_GIT_SCOPE).length, 2, `${name}: ordinary Git scope guidance exactly once`);
    assert.match(content, /before independent Review/);
    assert.match(content, /review-before-commit gate or a commit-only handoff/);
    assert.match(content, /Preserve explicit user ordering|respecting explicit user ordering/);
  }
  const operator = runtimeAssets.find(item => item.name === 'dog-operator')!.content;
  assert.match(operator, /only explicit path prohibitions from the user or applicable instructions/);
  assert.match(operator, /Do not infer a parent glob from a project\/repository name/);
  assert.match(operator, /preserving the authorized clone and exact prohibited paths/);
  assert.doesNotMatch(operator, /If the original request supplies a meaningful formal validation command/);
  assert.match(worker, /Read handoff_path once/);
  assert.match(worker, /changed fallible API, inspect relevant callsites for returned error loss or overwrite and state after failure/);
  assert.doesNotMatch(worker, /Assert public return value|Check a\s+materially different failure input|uncaught failures/);
  for (const boundary of [/same operation/, /\.git\/\*\* scope/, /formal evidence/,
    /mandatory exhaustive matrix or redundant tests/, /\.sortie-env\//, /Do not spawn nested subagents/,
    /PROCESS_DEFECT: local:/, /TRUE_BLOCKER: external:/, /correct-format-within-current-manifest/,
    /not before execution/, /Native shell background mode reports only process launch/]) assert.match(worker, boundary);
});

test('native CLI init installs the validation workflow in each active mission role', async () => {
  await mkdir('_testenv', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '_testenv', 'validation-assets-'));
  try {
    await promisify(execFile)(process.execPath, ['dist/cli/main.js', 'init', root], { cwd: process.cwd() });
    for (const role of roles) {
      const installed = await readFile(join(root, '.opencode', 'agent', `${role}.md`), 'utf8');
      const policy = role === 'dog-worker-v010' ? WORKER_VALIDATION_WORKFLOW : VALIDATION_WORKFLOW;
      assert.equal(installed.split(policy).length, 2, role);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
