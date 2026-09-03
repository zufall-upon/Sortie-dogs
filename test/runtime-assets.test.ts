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
