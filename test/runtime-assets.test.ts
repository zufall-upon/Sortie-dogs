import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_ASSET_VERSION } from "../src/asset-version.ts";
import { runtimeAssets } from "../src/runtime-assets.ts";

test("parallel workers preserve descriptor validation command boundaries", () => {
  for (const name of ["dog-worker", "dog-luna-worker"] as const) {
    const asset = runtimeAssets.find((candidate) => candidate.name === name);
    assert.ok(asset);
    assert.equal(asset.version, RUNTIME_ASSET_VERSION);
    assert.match(asset.content, /validation\.command\[0\] to validation_executable/);
    assert.match(asset.content, /JSON\.stringify\(validation\.command\.slice\(1\)\) to validation_args_json/);
    assert.match(asset.content, /Never join the command array into one executable\s+string/);
  }
});

test("workers share the ordered minimum-solution ladder without weakening execution constraints", () => {
  const ladder = [
    "1. no change needed",
    "2. reuse existing implementation/pattern",
    "3. platform/stdlib",
    "4. existing dependency",
    "5. smallest change to existing structure",
    "6. minimum new implementation",
  ];
  for (const name of ["dog-worker", "dog-luna-worker"] as const) {
    const asset = runtimeAssets.find((candidate) => candidate.name === name);
    assert.ok(asset);
    const positions = ladder.map((stage) => asset.content.indexOf(stage));
    assert.ok(positions.every((position) => position >= 0), `${name} needs every ladder stage`);
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), `${name} ladder order`);
    assert.match(asset.content, /YAGNI applies to AI-proposed extras, not accepted user requirements/u);
    assert.match(asset.content, /allowed write scope is an\s+upper bound, not an obligation to touch every path/u);
    assert.match(asset.content, /Never reduce trust boundaries, security, data integrity, accessibility, compatibility/u);
    assert.match(asset.content, /never fabricate an empty commit or bypass authority/u);
    assert.match(asset.content, /require the applicable exact manifest/u);
    assert.match(asset.content, /sortie_bind_write_gate/u);
    assert.match(asset.content, /## Parallel immutable commit artifact/u);
    assert.match(asset.content, /Every failed validation must produce a concrete source or harness change/u);
  }
});

test("runtime asset version fixture matches the shared marker", () => {
  const coordinator = runtimeAssets.find((candidate) => candidate.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(coordinator.content, new RegExp(`runtime_version: ${RUNTIME_ASSET_VERSION}`));
  assert.match(coordinator.content, new RegExp(`packaged_expectation: test/plugin-loader\\.test\\.ts uses ${RUNTIME_ASSET_VERSION}`));
  assert.match(coordinator.content, new RegExp(`initialize_expectation: test/initialize\\.test\\.ts uses ${RUNTIME_ASSET_VERSION}`));
});

test("coordinator keeps root goal and sequential handoff acceptance fingerprints distinct", () => {
  const coordinator = runtimeAssets.find((candidate) => candidate.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(coordinator.content, /SORTIE_ACCEPTANCE_CONTINUITY_STATE/u);
  assert.match(coordinator.content, /next_sequential_parent_fingerprint/u);
  assert.match(coordinator.content, /never copy it into an\s+acceptance-continuity parent_fingerprint/u);
  assert.match(coordinator.content, /If no accepted criterion changed, carry the same ordered criteria and\s+fingerprint without adding a duplicate criterion/u);
  assert.match(coordinator.content, /Before Task, validate the whole typed declaration/u);
  assert.match(coordinator.content, /Do not dispatch on a declaration defect/u);
  assert.match(coordinator.content, /corrected Task call in\s+the same turn/u);
  assert.match(coordinator.content, /Only a settled worker result that actually fails the accepted criterion\s+increments no-progress/u);
  assert.match(coordinator.content, /locally repairable evidence defects,\s+consume no no-progress result/u);
});

test("terminal report is Japanese and concise while internal proof remains durable", () => {
  const coordinator = runtimeAssets.find((candidate) => candidate.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(coordinator.content, /DONE, INTERRUPTED, BLOCKED, or NEED_DECISION/u);
  assert.match(coordinator.content, /Japanese 変更点, 確認結果, and 次/u);
  assert.match(coordinator.content, /Never render a user-facing Evidence heading or Evidence details block, evidence reference, internal reason code/u);
  assert.match(coordinator.content, /Preserve explanatory paragraphs, code examples/u);
  assert.match(coordinator.content, /Keep ordered command\/exit\/fingerprint history, manifests, evidence refs,\s+review proof, and terminal receipt append-only/u);
  assert.match(coordinator.content, /locally repairable process or evidence defect is never a\s+user question/u);
});

test("coordinator delegates parallel identity transcription to the runtime", () => {
  const coordinator = runtimeAssets.find((candidate) => candidate.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(coordinator.content, /Put only the returned\s+run_id and task_id into the Task prompt/u);
  assert.match(coordinator.content, /runtime resolves the exact reserved descriptor and injects those machine-owned fields/u);
  assert.match(coordinator.content, /Do not transcribe handoff_path, operation_manifest, or project_root/u);
});

test("coordinator combines final Luna wave advancement with canonical validation", () => {
  const coordinator = runtimeAssets.find((candidate) => candidate.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(coordinator.content, /final wave also pass the absolute canonical\s+validation executable/u);
  assert.match(coordinator.content, /integrates and validates\s+only a fresh detached worktree/u);
  assert.match(coordinator.content, /Use sortie_validate_luna_fabric_candidate for\s+recovery of any complete pending candidate/u);
});

test("workers keep machine-bound control paths opaque after binding", () => {
  const worker = runtimeAssets.find((candidate) => candidate.name === "dog-luna-worker");
  assert.ok(worker);
  assert.match(worker.content, /After a successful bind, never Read, reconstruct, or retype operation_manifest/u);
  assert.match(worker.content, /runtime-injected control path as opaque/u);
});

test("coordinator routes safe multi-unit scope to Luna without opt-in and honors serial override", () => {
  const coordinator = runtimeAssets.find((candidate) => candidate.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(coordinator.content, /at least two safe independently implementable units/u);
  assert.match(coordinator.content, /Luna fabric route without user opt-in/u);
  assert.match(coordinator.content, /explicit user serial\/no-parallel request wins/u);
  assert.match(coordinator.content, /default: Luna fabric when accepted scope has >=2 safe independently implementable units/u);
});
