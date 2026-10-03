import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MISSION_BEHAVIOR_REVIEW, MISSION_GIT_SCOPE, VALIDATION_WORKFLOW, WORKER_VALIDATION_WORKFLOW, missionWorkerContent } from '../dist/runtime-mission-assets.js';
import { V010_RUNTIME_PROFILE } from '../dist/core/runtime-profile.js';
import { runtimeAssets } from '../dist/runtime-assets-v010.js';

const roles = ['dog-operator', 'dogs-coordinator', 'dog-worker-v010'];

test('planning and implementation share a staged validation workflow without new authority', t => {
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
  assert.match(WORKER_VALIDATION_WORKFLOW, /never drop required validation/);
  assert.match(WORKER_VALIDATION_WORKFLOW, /contract\/freshness requires/);
  assert.match(WORKER_VALIDATION_WORKFLOW, /required broad checks/);
  assert.doesNotMatch(WORKER_VALIDATION_WORKFLOW, /Operator\/Coordinator:/);
  const worker = runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content;
  assert.match(worker, /formal check exactly in order/);
  assert.match(worker, /no extra approval, restart or delegation/);
  for (const name of roles) {
    const content = runtimeAssets.find(item => item.name === name)!.content;
    if (name !== 'dog-worker-v010') {
      assert.equal(content.split(MISSION_GIT_SCOPE).length, 2, `${name}: ordinary Git scope guidance exactly once`);
      assert.match(content, /before independent Review/);
      assert.match(content, /review-before-commit gate or a commit-only handoff/);
      assert.match(content, /Preserve explicit user ordering|respecting explicit user ordering/);
    } else {
      assert.match(content, /Requested add\/commit needs source paths, not \.git\/\*\* scope/);
      assert.match(content, /requested commit in this Task/);
      assert.match(content, /no review-before-commit gate/);
      assert.match(content, /Preserve user scope and ordering/);
    }
  }
  const operator = runtimeAssets.find(item => item.name === 'dog-operator')!.content;
  assert.match(operator, /only explicit path prohibitions from the user or applicable instructions/);
  assert.match(operator, /Do not infer a parent glob from a project\/repository name/);
  assert.match(operator, /preserving the authorized clone and exact prohibited paths/);
  assert.doesNotMatch(operator, /If the original request supplies a meaningful formal validation command/);
  assert.match(worker, /Read handoff_path in full first:/);
  assert.match(worker, /pre-change test helpers as oracles, not new implementation\/tests\. Check\s+result\/error\/state together/);
  assert.doesNotMatch(worker, /Assert public return value|Check a\s+materially different failure input|uncaught failures/);
  assert.match(worker, /Implement, test and requested commit in this Task/);
  for (const boundary of [/(?:in this Task|here) via sortie_v010_expand_unit/, /\.git\/\*\* scope/, /formal evidence/,
    /without a hypothetical exhaustive matrix/, /\.sortie-env\//, /Do not spawn nested subagents/,
    /PROCESS_DEFECT: local:/, /TRUE_BLOCKER: external:/, /host repair diagnostics/,
    /not before execution/, /foreground native shell calls/]) assert.match(worker, boundary);
  assert.ok(worker.length <= 3000, `complete generated Worker asset: ${worker.length}`);
  const body = missionWorkerContent(V010_RUNTIME_PROFILE);
  const prose = body.slice(body.indexOf('---', 3) + 3);
  assert.ok(body.length <= 2500, `common Worker content: ${body.length}`);
  assert.ok(prose.length <= 2400, `common Worker prose: ${prose.length}`);
  t.diagnostic(JSON.stringify({ generated_worker_asset_chars: worker.length, common_worker_chars: body.length,
    common_worker_prose_chars: prose.length }));
  assert.match(worker, /bind_write_gate with exact project_root and manifest_path=operation_manifest/);
  assert.match(worker, /verbatim original_requests\/unit_instruction/);
  assert.match(worker, /After compaction recover handoff; inspect diff\/results/);
  assert.match(worker, /assigned criteria, not Mission completion/);
  assert.doesNotMatch(worker, /Root-approved unit coverage|Changed-path coverage|Practical operation guide|Communication language continuity/);
});

test('native CLI init installs the validation workflow in each active mission role', async t => {
  await mkdir('_testenv', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '_testenv', 'validation-assets-'));
  try {
    await promisify(execFile)(process.execPath, ['dist/cli/main.js', 'init', root], { cwd: process.cwd() });
    for (const role of roles) {
      const installed = await readFile(join(root, '.opencode', 'agent', `${role}.md`), 'utf8');
      const policy = role === 'dog-worker-v010' ? WORKER_VALIDATION_WORKFLOW : VALIDATION_WORKFLOW;
      assert.equal(installed.split(policy).length, 2, role);
      if (role === 'dog-worker-v010') {
        assert.equal(installed, runtimeAssets.find(item => item.name === role)!.content);
        assert.ok(installed.length <= 3000, `complete installed Worker asset: ${installed.length}`);
        t.diagnostic(JSON.stringify({ installed_worker_asset_chars: installed.length }));
      }
    }
    const reviewer = await readFile(join(root, '.opencode', 'agent', 'dog-reviewer-v010.md'), 'utf8');
    assert.equal(reviewer, runtimeAssets.find(item => item.name === 'dog-reviewer-v010')!.content);
    assert.match(reviewer, /Run inherited formal commands in order as exact separate foreground native shell calls/);
    assert.match(reviewer, /Run formatting and diagnostics separately; do not append undeclared shell commands/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('per-call feature review distinguishes current use from retained creation settings without a new gate', () => {
  const reviewer = runtimeAssets.find(item => item.name === 'dog-reviewer-v010')!.content;
  const worker = runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content;
  assert.equal(reviewer.split(MISSION_BEHAVIOR_REVIEW).length, 2);
  assert.match(MISSION_BEHAVIOR_REVIEW, /current caller's setting from a captured creation-time\s+setting/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /requested contract to decide which governs/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /actual source crosses that boundary\s+and existing tests do not cover it/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /smallest public case, including the disabled behavior/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /Do not invent a lifecycle matrix/);
  assert.match(worker, /Per-call modes: check retained creation\/use for captured vs current settings/);
  assert.doesNotMatch(MISSION_BEHAVIOR_REVIEW, /TypedBindings|Anko|namedSlice|must run a new|second Reviewer/);
});

test('regressions compose by general naming and requirements are reconciled before formal checks', () => {
  const worker = runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content;
  const reviewer = runtimeAssets.find(item => item.name === 'dog-reviewer-v010')!.content;
  assert.match(worker, /existing suites\/subtests or distinctive regression entry names/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /New test entry\/helper names should be distinctive\s+and compose with other same-package test files/);
  assert.match(WORKER_VALIDATION_WORKFLOW, /reconcile requirements\/diff, run focused tests, then every registered formal check/);
  assert.match(WORKER_VALIDATION_WORKFLOW, /Rerun affected checks and required broad checks when contract\/freshness requires/);
  assert.match(worker, /Keep reproduction entrypoint\/input\/layout; rerun or report why unverified/);
  assert.match(reviewer, /correction exposes another concrete Major\/Medium defect, retain it through sortie_v010_repair_review/);
  assert.match(reviewer, /accumulates known findings without another Task, scope or check contract/);
  assert.doesNotMatch(MISSION_BEHAVIOR_REVIEW + worker, /TestTypedBindingsDeclarations|typed_bindings|hidden grader|rename.*official/);
});

test('shared helper rejection review follows existing unchanged callers without a new gate or task-specific oracle', () => {
  const reviewer = runtimeAssets.find(item => item.name === 'dog-reviewer-v010')!.content;
  assert.equal(reviewer.split(MISSION_BEHAVIOR_REVIEW).length, 2, 'one stable shared policy in the installed Reviewer');
  assert.match(MISSION_BEHAVIOR_REVIEW, /shared helper gains validation or a new rejection/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /search its existing callers,\s+including unchanged code/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /Read relevant caller branches; search hits alone do not\s+establish correct handling/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /later writes and result\/error resets back to the\s+public result\/error\/state/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /preserving unrelated existing behavior/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /not an exhaustive call graph or new approval gate/);
  assert.doesNotMatch(MISSION_BEHAVIOR_REVIEW, /Anko|TypedBindings|ChanStmt|invokeLetExpr|channel-status|vmStmt\.go|bool.{0,10}int64/);
  assert.doesNotMatch(MISSION_BEHAVIOR_REVIEW, /must enumerate every caller|separate Reviewer|mandatory coverage inventory/);
});

test('Worker instruction discovery reuses supplied instructions and prefers exact relevant paths', () => {
  const worker = runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content;
  assert.match(worker, /Reuse supplied AGENTS\.md/);
  assert.match(worker, /for gaps prefer exact ancestor files\/affected subtrees over parent globs/);
  assert.match(worker, /Read\/search: existing permissions/);
  assert.match(worker, /Keep prohibitions, host Git lifecycle[\s\S]+cumulative budget/);
  assert.match(worker, /every registered formal check exactly in order/);
  assert.doesNotMatch(worker, /allow all external|external_directory: allow|skip missing instructions|Anko|TypedBindings/);
});

test('Reviewer correction distinguishes exact formal shell calls from formatting and diagnostics', () => {
  const reviewer = runtimeAssets.find(item => item.name === 'dog-reviewer-v010')!.content;
  assert.match(reviewer, /Run inherited formal commands in order as exact separate foreground native shell calls/);
  assert.match(reviewer, /Run formatting and diagnostics separately; do not append undeclared shell commands, tee, redirect or wrapper/);
  assert.match(reviewer, /retain the requested commit\/clean boundary/);
  assert.match(reviewer, /actual successful terminal binds the current validated source/);
  assert.match(reviewer, /No unresolved Medium may pass/);
  assert.match(reviewer, /Review starts read-only/);
  assert.doesNotMatch(reviewer, /accept mixed diagnostic chains|infer successful shell members|Anko|TypedBindings/);
});
