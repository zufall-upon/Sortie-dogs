import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MISSION_BEHAVIOR_REVIEW, MISSION_CLIENT_STATE_CHECK, MISSION_REPRESENTATION_ORACLE, MISSION_RETURN_CONTRACT, MISSION_MUTATION_CONTRACT, MISSION_REGRESSION_PLACEMENT, MISSION_GIT_SCOPE, VALIDATION_WORKFLOW, WORKER_VALIDATION_WORKFLOW, missionWorkerContent } from '../dist/runtime-mission-assets.js';
import { V010_RUNTIME_PROFILE } from '../dist/core/runtime-profile.js';
import { runtimeAssets } from '../dist/runtime-assets-v010.js';

const roles = ['dog-operator', 'dogs-coordinator', 'dog-worker-v010'];

test('side-effect guidance checks controls with client state without redefining authorized behavior', () => {
  for (const name of ['dog-operator', 'dogs-coordinator', 'dog-reviewer-v010']) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.equal(content.split(MISSION_CLIENT_STATE_CHECK).length, 2, name);
    assert.match(content, /check remaining controls with existing client-owned state, not only isolated defaults/);
    assert.match(content, /Judge allowed effects from the original request; preserve authorized opt-in behavior/);
  }
  const worker = runtimeAssets.find(asset => asset.name === 'dog-worker-v010')!.content;
  assert.match(worker, /Preserve user scope and ordering/);
  assert.match(worker, /No exhaustive matrix/);
  assert.match(worker, /verbatim original_requests\/unit_instruction/);
  assert.match(VALIDATION_WORKFLOW, /this workflow adds no approval or denial/);
  assert.match(MISSION_BEHAVIOR_REVIEW, /Missing assertions\s+alone are not defects/);
  assert.doesNotMatch(MISSION_CLIENT_STATE_CHECK + WORKER_VALIDATION_WORKFLOW,
    /pydicom|901|NullHandler|StreamHandler|handler_type|test_config|debug\(|official|hidden|new argument|must remove/);
});

test('Coordinator authors preserve explicit effects under established caller preconditions', () => {
  const coordinator = runtimeAssets.find(asset => asset.name === 'dogs-coordinator')!.content;
  const marker = 'When removing implicit initialization effects';
  assert.equal(coordinator.split(marker).length, 2, 'author guidance exactly once');
  const guidance = coordinator.slice(coordinator.indexOf(marker)).split('\nFor read-only verification')[0];
  assert.match(guidance, /preserve established explicit opt-in behavior unless the request changes it/);
  assert.match(guidance, /Trace its real caller-visible effect from existing source\/tests/);
  assert.match(guidance, /flags or internal state alone are not that behavior/);
  assert.match(guidance, /Keep the established caller preconditions in the regression check/);
  assert.match(guidance, /added setup can supply the removed effect and mask a regression/);
  assert.match(guidance, /Reuse adequate checks and include this distinction in the current author's objective\/check plan/);
  assert.match(guidance, /not another unit or review round/);
  assert.doesNotMatch(guidance, /pydicom|sqlfluff|901|debug\(|StreamHandler|NullHandler|approval|permission/);
  for (const role of ['dog-operator', 'dog-worker-v010', 'dog-reviewer-v010']) {
    assert.ok(!runtimeAssets.find(asset => asset.name === role)!.content.includes(marker), role);
  }
});

test('Coordinator carries source-backed return shape and missing-value semantics into existing authorship', () => {
  const coordinator = runtimeAssets.find(item => item.name === 'dogs-coordinator')!.content;
  assert.equal(coordinator.split(MISSION_RETURN_CONTRACT).length, 2);
  assert.match(MISSION_RETURN_CONTRACT, /derive its return contract from public callers and unchanged source\/tests/);
  assert.match(MISSION_RETURN_CONTRACT, /return type\/container, metadata and label alignment/);
  assert.match(MISSION_RETURN_CONTRACT, /unless the original request changes them/);
  assert.match(MISSION_RETURN_CONTRACT, /equal numeric values alone do not prove that contract/);
  assert.match(MISSION_RETURN_CONTRACT, /Trace which inputs determine result shape and labels,\s+including non-primary parameters/);
  assert.match(MISSION_RETURN_CONTRACT, /a scalar primary input need not yield a scalar result/);
  assert.match(MISSION_RETURN_CONTRACT, /mask or conditional\s+replacement/);
  assert.match(MISSION_RETURN_CONTRACT, /preserve established broadcasting and missing-value propagation/);
  assert.match(MISSION_RETURN_CONTRACT, /an unknown condition is not proof\s+that replacement is intended/);
  assert.match(MISSION_RETURN_CONTRACT, /direct work or the Worker's objective/);
  assert.match(MISSION_RETURN_CONTRACT, /Reuse an adequate focused assertion/);
  assert.match(MISSION_RETURN_CONTRACT, /smallest source-backed regression when needed/);
  assert.match(MISSION_RETURN_CONTRACT, /not an input matrix,\s+another unit, validation lane or review/);
  assert.doesNotMatch(MISSION_RETURN_CONTRACT, /pvlib|physical|1154|1707|pandas|Series|NumPy|np\.where|fillna|mask\(.*False|permission|approval|must run/);
  for (const asset of runtimeAssets.filter(item => item.name !== 'dogs-coordinator')) {
    assert.ok(!asset.content.includes(MISSION_RETURN_CONTRACT), asset.name);
  }
});

test('Coordinator authors mutation checks from existing state and failure semantics, not the new mechanism', () => {
  const coordinator = runtimeAssets.find(item => item.name === 'dogs-coordinator')!.content;
  assert.equal(coordinator.split(MISSION_MUTATION_CONTRACT).length, 2);
  assert.match(MISSION_MUTATION_CONTRACT, /state and failure contract from public callers and unchanged source\/tests/);
  assert.match(MISSION_MUTATION_CONTRACT, /permission failures, link identity and new-file creation\/umask behavior/);
  assert.match(MISSION_MUTATION_CONTRACT, /preserve those established outcomes unless the original request changes them/);
  assert.match(MISSION_MUTATION_CONTRACT, /Derive regression expectations from\s+the original operation, not the new write mechanism/);
  assert.match(MISSION_MUTATION_CONTRACT, /direct work or the Worker's objective/);
  assert.match(MISSION_MUTATION_CONTRACT, /Reuse an adequate focused assertion/);
  assert.match(MISSION_MUTATION_CONTRACT, /only the smallest source-backed regression when needed/);
  assert.match(MISSION_MUTATION_CONTRACT, /not an exhaustive\s+matrix, another unit, validation lane or review/);
  assert.doesNotMatch(MISSION_MUTATION_CONTRACT, /sqlfluff|1763|persist_tree|_safe_create_replace_file|UnicodeEncodeError|NamedTemporaryFile|os\.replace|hidden|official|approval|grant/);
  for (const asset of runtimeAssets.filter(item => item.name !== 'dogs-coordinator')) {
    assert.ok(!asset.content.includes(MISSION_MUTATION_CONTRACT), asset.name);
  }
});

test('requested scratch cleanup precedes final formal checks without removing needed fixtures', () => {
  const cleanup = 'Finish requested scratch cleanup before final formal checks; retain fixtures those checks need.';
  for (const role of ['dog-operator', 'dogs-coordinator', 'dog-reviewer-v010']) {
    const content = runtimeAssets.find(asset => asset.name === role)!.content;
    assert.equal(content.split(cleanup).length, 2, `${role}: cleanup ordering exactly once`);
  }
  assert.match(VALIDATION_WORKFLOW, /this workflow adds no approval or denial/);
  assert.match(VALIDATION_WORKFLOW, /host evidence freshness requires it/);
  assert.doesNotMatch(cleanup, /sqlfluff|1763|dbt|persist|permission|ignore|exempt/);
});

test('changed outputs follow discovered public caller assertions within the current validation lane', () => {
  for (const name of ['dog-operator', 'dogs-coordinator']) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.match(content, /follow relevant search hits in existing public caller tests, including output snapshots/);
    assert.match(content, /Read the matched assertions and select their affected checks/);
    assert.match(content, /implementation-local fixtures alone may miss a consumer regression/);
    assert.match(content, /Update an affected expectation only when the original request changes its contract/);
    assert.match(content, /within the current unit, reusing passed checks; no extra suite, approval or review round/);
  }
  const worker = runtimeAssets.find(asset => asset.name === 'dog-worker-v010')!.content;
  assert.match(worker, /Check matched caller\/output tests/);
  const reviewer = runtimeAssets.find(asset => asset.name === 'dog-reviewer-v010')!.content;
  assert.match(reviewer, /inspect affected public caller assertions\/output snapshots found by search/);
  assert.match(reviewer, /not only implementation-local fixtures/);
  assert.match(reviewer, /Reconcile expected outputs with the original requirements and reuse adequate checks; no extra review round/);
  assert.doesNotMatch(VALIDATION_WORKFLOW + WORKER_VALIDATION_WORKFLOW + MISSION_BEHAVIOR_REVIEW,
    /sqlfluff|L031|commands_test|indentation_error_simple|hidden test|official score/);
});

test('public reproduction planning keeps its entrypoint rather than a lower-level surrogate', () => {
  for (const name of ['dog-operator', 'dogs-coordinator']) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.match(content, /carry its entrypoint and relevant input into the unit objective and formal reproduction check/);
    assert.match(content, /Derive the shell recipe without substituting lower-level library calls/);
    assert.match(content, /those checks may supplement, never replace, the public entrypoint/);
    assert.match(content, /Reuse existing checks that already exercise it/);
    assert.match(content, /If authorized setup cannot run it, retain useful work and report the verification gap, not a passing reproduction/);
    assert.match(content, /literal command in the original request is not required/);
    assert.match(content, /this workflow adds no approval or denial/);
  }
  assert.doesNotMatch(VALIDATION_WORKFLOW, /astroid|pylint|NumPy|1978|extension-pkg|rcfile|capsys|caplog/);
});

test('direct reproduction recipes use observed baseline context without another preparation lane', () => {
  for (const name of ['dog-operator', 'dogs-coordinator']) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.match(content, /For direct work with an unknown reproduction recipe/);
    assert.match(content, /resolve its flags, configuration and cwd with ordinary native diagnostics before formal registration/);
    assert.match(content, /Reuse an already observed failing baseline; do not rerun it merely to plan/);
    assert.match(content, /A command that never exercises the reported path is not a passing reproduction/);
    assert.match(content, /Use existing project configuration within the original path constraints/);
    assert.match(content, /Known recipes and Worker-owned investigation need no extra preparation or unit/);
    assert.match(content, /this workflow adds no approval or denial/);
  }
  assert.doesNotMatch(VALIDATION_WORKFLOW, /astroid|pylint|NumPy|1978|extension-pkg|rcfile|capsys|caplog/);
});

test('standalone reproduction planning preserves its fixture root without replacing the active environment', () => {
  for (const name of ['dog-operator', 'dogs-coordinator']) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.match(content, /Preserve its fixture layout and working directory/);
    assert.match(content, /A standalone example project belongs in its own fixture root within allowed paths/);
    assert.match(content, /invoke from there with the active environment, not the source checkout root/);
    assert.match(content, /import paths or configuration may mask the failure/);
    assert.match(content, /Reuse an already observed failing baseline; do not rerun it merely to plan/);
    assert.match(content, /this workflow adds no approval or denial/);
  }
  assert.doesNotMatch(VALIDATION_WORKFLOW, /astroid|pylint|1333|src\/project|\.repro-missing-init|sys\.path/);
});

test('dependency setup preserves original missing-only limits without disabling authorized repair', () => {
  for (const name of ['dog-operator', 'dogs-coordinator']) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.match(content, /Honor original dependency limits in setup and unit objectives/);
    assert.match(content, /If the user permits installs only for\s+proven-missing packages/);
    assert.match(content, /an installed but incompatible package is not missing/);
    assert.match(content, /General registry\/compatible-version guidance does not widen\s+that task-specific limit/);
    assert.match(content, /Reuse a supplied environment; create one only when the original request permits/);
    assert.match(content, /Otherwise carry out authorized dependency repair normally/);
    assert.match(content, /report the limitation, not successful verification/);
    assert.doesNotMatch(content, /pvlib|NumPy|numpy|np\.Inf|pip install.*<2/);
  }
  const worker = runtimeAssets.find(asset => asset.name === 'dog-worker-v010')!.content;
  assert.match(worker, /User missing-only: installed\/incompatible is not missing/);
  assert.match(worker, /bounded documented setup in \.sortie-env\/; reuse, never delete/);
});

test('error fallback investigation distinguishes related failures from repeated same-error inputs', () => {
  const coordinator = runtimeAssets.find(item => item.name === 'dogs-coordinator')!.content;
  const worker = runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content;
  assert.match(coordinator, /distinguish already handled errors from errors the called operation\s+can still raise/);
  assert.match(coordinator, /Already handled failures and successful neighbors do not establish that new boundary/);
  assert.match(coordinator, /Repeating the reported error with another input does not cover still-unhandled related errors/);
  assert.match(coordinator, /If peer source\/tests expose a plausible related still-unhandled error, probe its expected fallback/);
  assert.match(coordinator, /reuse adequate checks\. Include this in the current author's objective\/check\s+plan, not another unit or review round/);
  assert.match(coordinator, /Do not invent an exhaustive error matrix/);
  assert.match(worker, /Fallback: probe other unhandled errors from peer source\/tests/);
  assert.match(worker, /Pre-change oracles, not new tests; check result\/error\/state/);
  assert.match(worker, /No exhaustive matrix/);
  for (const content of [coordinator, worker]) {
    assert.doesNotMatch(content, /astroid-1866|Unknown format code|except \(IndexError, KeyError, TypeError, ValueError\)/);
  }
});

test('direct implementation, Worker and Review share same-type representation oracle guidance without benchmark answers', () => {
  for (const name of ['dogs-coordinator', 'dog-worker-v010', 'dog-reviewer-v010']) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.equal(content.split(MISSION_REPRESENTATION_ORACLE).length, 2, name);
  }
  assert.match(MISSION_REPRESENTATION_ORACLE, /Same-type representation, not name\/visitor analogy/);
  assert.match(MISSION_REPRESENTATION_ORACLE, /resolve conflicts/);
  assert.doesNotMatch(MISSION_REPRESENTATION_ORACLE, /Unknown|astroid|1268|approval|permission/);
});

test('Coordinator planning and direct authorship compose regressions without a new validation lane', () => {
  const coordinator = runtimeAssets.find(item => item.name === 'dogs-coordinator')!.content;
  assert.equal(coordinator.split(MISSION_REGRESSION_PLACEMENT).length, 2);
  assert.match(MISSION_REGRESSION_PLACEMENT, /existing relevant test suite\/subtest or fixture/);
  assert.match(MISSION_REGRESSION_PLACEMENT, /when it can express the regression assertion/);
  assert.match(MISSION_REGRESSION_PLACEMENT, /If a new test module is needed/);
  assert.match(MISSION_REGRESSION_PLACEMENT, /distinctive behavior-specific name over automatically mirroring the implementation module/);
  assert.match(MISSION_REGRESSION_PLACEMENT, /Preserve established assertions and project test discovery/);
  assert.match(MISSION_REGRESSION_PLACEMENT, /not another test, unit or review requirement/);
  assert.match(coordinator, /Continue directly while your context makes that efficient/);
  assert.match(coordinator, /independent Review and Operator final acceptance still follow/i);
  assert.doesNotMatch(MISSION_REGRESSION_PLACEMENT, /sqlfluff|pydicom|L060|2419|901|test_config|std_L060|hidden|official|permission|approval/);
  for (const name of ['dog-operator', 'dog-worker-v010', 'dog-reviewer-v010']) {
    assert.ok(!runtimeAssets.find(item => item.name === name)!.content.includes(MISSION_REGRESSION_PLACEMENT), name);
  }
});

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
  assert.match(worker, /Pre-change oracles, not new tests; check result\/error\/state/);
  assert.doesNotMatch(worker, /Assert public return value|Check a\s+materially different failure input|uncaught failures/);
  assert.match(worker, /Implement, test and requested commit in this Task/);
  for (const boundary of [/(?:in this Task|here) via sortie_v010_expand_unit/, /\.git\/\*\* scope/, /formal evidence/,
    /No exhaustive matrix/, /\.sortie-env\//, /Do not spawn nested subagents/,
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
      if (role !== 'dog-worker-v010') {
        assert.match(installed, /Finish requested scratch cleanup before final formal checks/);
        assert.match(installed, /retain fixtures those checks need/);
        assert.equal(installed.split(MISSION_CLIENT_STATE_CHECK).length, 2, role);
      }
      assert.match(installed, role === 'dog-worker-v010'
        ? /User missing-only: installed\/incompatible is not missing/
        : /an installed but incompatible package is not missing/);
      if (role !== 'dog-worker-v010') {
        assert.match(installed, /carry its entrypoint and relevant input into the unit objective and formal reproduction check/);
        assert.match(installed, /Preserve its fixture layout and working directory/);
        assert.match(installed, /invoke from there with the active environment, not the source checkout root/);
        assert.match(installed, /those checks may supplement, never replace, the public entrypoint/);
        assert.match(installed, /retain useful work and report the verification gap, not a passing reproduction/);
      }
      if (role === 'dog-worker-v010') {
        assert.equal(installed, runtimeAssets.find(item => item.name === role)!.content);
        assert.match(installed, /check result\/error\/state/);
        assert.match(installed, /independent Review after return/);
        assert.ok(installed.length <= 3000, `complete installed Worker asset: ${installed.length}`);
        t.diagnostic(JSON.stringify({ installed_worker_asset_chars: installed.length }));
      }
    }
    const reviewer = await readFile(join(root, '.opencode', 'agent', 'dog-reviewer-v010.md'), 'utf8');
    const coordinator = await readFile(join(root, '.opencode', 'agent', 'dogs-coordinator.md'), 'utf8');
    assert.equal(reviewer.split(MISSION_CLIENT_STATE_CHECK).length, 2);
    assert.equal(await readFile(join(root, '.opencode', 'agent', 'dog-worker-v010.md'), 'utf8'),
      runtimeAssets.find(item => item.name === 'dog-worker-v010')!.content);
    assert.equal(coordinator.split(MISSION_RETURN_CONTRACT).length, 2);
    assert.equal(coordinator.split(MISSION_MUTATION_CONTRACT).length, 2);
    assert.equal(coordinator.split(MISSION_REGRESSION_PLACEMENT).length, 2);
    assert.match(coordinator, /not another test, unit or review requirement/);
    assert.equal(coordinator.split('When removing implicit initialization effects').length, 2);
    assert.match(coordinator, /preserve established explicit opt-in behavior unless the request changes it/);
    assert.match(coordinator, /flags or internal state alone are not that behavior/);
    assert.match(coordinator, /Keep the established caller preconditions in the regression check/);
    assert.match(coordinator, /added setup can supply the removed effect and mask a regression/);
    assert.equal(reviewer, runtimeAssets.find(item => item.name === 'dog-reviewer-v010')!.content);
    assert.match(reviewer, /Run inherited formal commands in order as exact separate foreground native shell calls/);
    assert.match(reviewer, /Run formatting and diagnostics separately; do not append undeclared shell commands/);
    assert.match(reviewer, /Finish requested scratch cleanup before final formal checks/);
    assert.match(reviewer, /retain fixtures those checks need/);
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
