import assert from "node:assert/strict";
import test from "node:test";

import {
  LUNA_FABRIC_CONTRACT_VERSION,
  admitLunaFabric,
  type LunaFabricContract,
} from "../dist/core/luna-fabric-contract.js";

const SHA = "a".repeat(40);
const FINGERPRINT = "b".repeat(64);

function contract(): LunaFabricContract {
  return {
    version: LUNA_FABRIC_CONTRACT_VERSION,
    provenance: {
      source: "dog-coordinator",
      acceptance_fingerprint: FINGERPRINT,
      target_branch: "main",
      target_sha: SHA,
    },
    acceptance_items: ["accept-a", "accept-b", "accept-c"],
    effects: [],
    shared_paths: [],
    units: [
      {
        unit_id: "unit-a",
        acceptance_items: ["accept-a"],
        scope_read: ["src/shared.ts"],
        scope_write: ["src/a.ts"],
        depends_on: [],
        validation: { level: "targeted", command: ["node", "--test", "test/a.test.ts"] },
        shared_path_keys: [],
        exclusive_resources: [],
        scheduler_order: 0,
      },
      {
        unit_id: "unit-b",
        acceptance_items: ["accept-b"],
        scope_read: ["src/shared.ts"],
        scope_write: ["src/b.ts"],
        depends_on: [],
        validation: { level: "targeted", command: ["node", "--test", "test/b.test.ts"] },
        shared_path_keys: [],
        exclusive_resources: [],
        scheduler_order: 1,
      },
      {
        unit_id: "unit-c",
        acceptance_items: ["accept-c"],
        scope_read: ["src/a.ts"],
        scope_write: ["src/c.ts"],
        depends_on: ["unit-a"],
        validation: { level: "full", command: ["npm", "run", "test:full"] },
        shared_path_keys: [],
        exclusive_resources: [],
        scheduler_order: 2,
      },
    ],
  };
}

test("automatic admission accepts an exact coordinator DAG with useful safe width", () => {
  const first = admitLunaFabric(contract());
  assert.equal(first.route, "luna-fabric");
  if (first.route !== "luna-fabric") return;
  assert.equal(first.width, 2);
  assert.equal(first.depth, 2);
  assert.match(first.contract_fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(first.contract), true);

  const reordered = contract();
  const second = admitLunaFabric({
    units: reordered.units,
    shared_paths: reordered.shared_paths,
    provenance: reordered.provenance,
    version: reordered.version,
    effects: reordered.effects,
    acceptance_items: reordered.acceptance_items,
  });
  assert.equal(second.route, "luna-fabric");
  if (second.route === "luna-fabric") assert.equal(second.contract_fingerprint, first.contract_fingerprint);
});

test("malformed, unknown, external-effect, and narrow contracts route to Sol", () => {
  assert.deepEqual(admitLunaFabric({ ...contract(), unknown: true }), {
    route: "sol-serial",
    reason: "malformed-contract",
    diagnostics: [{
      code: "malformed-contract",
      pointer: "/",
      detail: "contract shape must contain only the closed v0.8 fields",
    }],
  });
  assert.equal(admitLunaFabric({ ...contract(), effects: ["unknown"] }).route, "sol-serial");
  assert.equal(admitLunaFabric({ ...contract(), effects: ["release"] }).route, "sol-serial");
  const narrow = contract();
  assert.equal(admitLunaFabric({
    ...narrow,
    acceptance_items: ["accept-a"],
    units: [narrow.units[0]],
  }).route, "sol-serial");
  const narrowResult = admitLunaFabric({
    ...narrow,
    acceptance_items: ["accept-a"],
    units: [narrow.units[0]],
  });
  assert.equal(narrowResult.route === "sol-serial" ? narrowResult.reason : "", "fewer-than-two-units");
});

test("invalid scope, dependency, and acceptance ownership fail closed before fan-out", () => {
  const invalidPath = structuredClone(contract()) as any;
  invalidPath.units[0]!.scope_write = ["../escape.ts"];
  const pathResult = admitLunaFabric(invalidPath);
  assert.equal(pathResult.route === "sol-serial" ? pathResult.reason : "", "invalid-scope");

  const unknownDependency = structuredClone(contract()) as any;
  unknownDependency.units[0]!.depends_on = ["missing"];
  const dependencyResult = admitLunaFabric(unknownDependency);
  assert.equal(dependencyResult.route === "sol-serial" ? dependencyResult.reason : "", "dependency-invalid");

  const cyclic = structuredClone(contract()) as any;
  cyclic.units[0]!.depends_on = ["unit-c"];
  const cycleResult = admitLunaFabric(cyclic);
  assert.equal(cycleResult.route === "sol-serial" ? cycleResult.reason : "", "dependency-invalid");

  const duplicateOwner = structuredClone(contract()) as any;
  duplicateOwner.units[1]!.acceptance_items = ["accept-a", "accept-b"];
  const acceptanceResult = admitLunaFabric(duplicateOwner);
  assert.equal(acceptanceResult.route === "sol-serial" ? acceptanceResult.reason : "", "acceptance-unowned");
});

test("shared writes need one owner key and exclusive resources disqualify concurrent units", () => {
  const overlap = structuredClone(contract()) as any;
  overlap.units[1]!.scope_write = ["src/a.ts"];
  const unowned = admitLunaFabric(overlap);
  assert.equal(unowned.route === "sol-serial" ? unowned.reason : "", "shared-path-unowned");

  const owned = structuredClone(contract()) as any;
  owned.shared_paths = [{ key: "shared-a", path: "src/a.ts" }];
  owned.units[0]!.shared_path_keys = ["shared-a"];
  owned.units[1]!.shared_path_keys = ["shared-a"];
  owned.units[1]!.scope_write = ["src/a.ts"];
  owned.units[2]!.scope_read = ["src/shared.ts"];
  assert.equal(admitLunaFabric(owned).route, "luna-fabric");

  const ownedOnly = structuredClone(owned) as any;
  ownedOnly.units = ownedOnly.units.slice(0, 2);
  ownedOnly.acceptance_items = ["accept-a", "accept-b"];
  const ownedOnlyResult = admitLunaFabric(ownedOnly);
  assert.equal(ownedOnlyResult.route === "sol-serial" ? ownedOnlyResult.reason : "", "no-safe-parallel-width");

  const exclusive = structuredClone(contract()) as any;
  exclusive.units[0]!.exclusive_resources = ["testenv"];
  exclusive.units[1]!.exclusive_resources = ["testenv"];
  const resourceResult = admitLunaFabric(exclusive);
  assert.equal(resourceResult.route === "sol-serial" ? resourceResult.reason : "", "exclusive-resource-conflict");
});

test("a dependency chain with no incomparable pair routes to Sol", () => {
  const chain = structuredClone(contract()) as any;
  chain.units[1]!.depends_on = ["unit-a"];
  chain.units[2]!.depends_on = ["unit-b"];
  const result = admitLunaFabric(chain);
  assert.equal(result.route === "sol-serial" ? result.reason : "", "no-safe-parallel-width");
});
