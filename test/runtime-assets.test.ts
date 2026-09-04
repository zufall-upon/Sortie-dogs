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

test("runtime asset version fixture matches the shared marker", () => {
  const coordinator = runtimeAssets.find((candidate) => candidate.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(coordinator.content, new RegExp(`runtime_version: ${RUNTIME_ASSET_VERSION}`));
  assert.match(coordinator.content, new RegExp(`packaged_expectation: test/plugin-loader\\.test\\.ts uses ${RUNTIME_ASSET_VERSION}`));
  assert.match(coordinator.content, new RegExp(`initialize_expectation: test/initialize\\.test\\.ts uses ${RUNTIME_ASSET_VERSION}`));
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
