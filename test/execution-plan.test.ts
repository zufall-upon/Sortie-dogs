import assert from "node:assert/strict";
import test from "node:test";

import { compileAcceptanceCoverage } from "../dist/core/acceptance-compiler.js";
import {
  createExecutionPlan,
  ExecutionPlanError,
  executionPlanManifestFingerprint,
  inspectExecutionPlan,
} from "../dist/core/execution-plan.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function fabric(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.8.0",
    provenance: { source: "dog-coordinator", acceptance_fingerprint: "b".repeat(64), target_branch: "main", target_sha: "a".repeat(40) },
    acceptance_items: ["accept-a", "accept-b"],
    effects: [],
    shared_paths: [],
    units: ["a", "b"].map((unit_id, scheduler_order) => ({
      unit_id,
      acceptance_items: [`accept-${unit_id}`],
      scope_read: ["base.txt"],
      scope_write: [`${unit_id}.txt`],
      depends_on: [],
      validation: { level: "targeted", command: ["node", "--test"] },
      shared_path_keys: [],
      exclusive_resources: [],
      scheduler_order,
    })),
    ...overrides,
  };
}

function compiled() {
  return compileAcceptanceCoverage({
    version: "0.1",
    provenance: { producer: "dog-coordinator", acceptance_fingerprint: hash("b"), capsule_inputs_exclude_secrets: true },
    unit_ids: ["a", "b"],
    declared_capsule_ids: [hash("c")],
    acceptance_items: ["a", "b"].map((id) => ({ acceptance_id: `accept-${id}`, observable_criterion: `observable ${id}` })),
    validations: ["a", "b"].map((id) => ({ validation_id: `validate-${id}`, unit_id: id, command_fingerprint: hash("d"), references: { capsule_ids: [hash("c")], artifact_ids: [] } })),
    coverage: ["a", "b"].map((id) => ({ acceptance_id: `accept-${id}`, unit_id: id, validation_ids: [`validate-${id}`] })),
  });
}

function assertDagRejectedWithoutMutation(input: ReturnType<typeof fabric>) {
  const before = structuredClone(input);
  assert.throws(() => createExecutionPlan(compiled(), input, executionPlanManifestFingerprint({ write: ["a.txt", "b.txt"] })), (error: unknown) => {
    assert.ok(error instanceof ExecutionPlanError);
    assert.equal(error.code, "dag-rejected");
    assert.equal(error.message, "Only an admitted v0.8 Luna DAG can be bound.");
    return true;
  });
  assert.deepEqual(input, before);
}

test("accepted compiler coverage binds the exact DAG, manifest, and deduplicated capsule set", () => {
  const manifest = executionPlanManifestFingerprint({ write: ["a.txt", "b.txt"], validation: ["npm test"] });
  const plan = createExecutionPlan(compiled(), fabric(), manifest);
  assert.equal(plan.plan_id, compiled().plan_id);
  assert.deepEqual(plan.capsule_ids, [hash("c")]);
  assert.equal(plan.operation_manifest_fingerprint, manifest);
  assert.equal(inspectExecutionPlan(structuredClone(plan), fabric()).binding_id, plan.binding_id);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.coverage_map));
});

test("binding rejects rejected coverage, unsafe DAGs, ownership drift, and resume mutation", () => {
  const manifest = executionPlanManifestFingerprint({ write: ["a.txt", "b.txt"] });
  const rejected = compileAcceptanceCoverage({});
  assert.throws(() => createExecutionPlan(rejected, fabric(), manifest), (error: unknown) => error instanceof ExecutionPlanError && error.code === "compile-rejected");
  assert.throws(() => createExecutionPlan(compiled(), fabric({ effects: ["publish"] }), manifest), (error: unknown) => error instanceof ExecutionPlanError && error.code === "dag-rejected");
  const wrongOwner = fabric();
  (wrongOwner.units[0]!.acceptance_items as string[]) = ["accept-b"];
  (wrongOwner.units[1]!.acceptance_items as string[]) = ["accept-a"];
  assert.throws(() => createExecutionPlan(compiled(), wrongOwner, manifest), (error: unknown) => error instanceof ExecutionPlanError && error.code === "coverage-mismatch");
  const plan = structuredClone(createExecutionPlan(compiled(), fabric(), manifest));
  plan.operation_manifest_fingerprint = hash("e");
  assert.throws(() => inspectExecutionPlan(plan, fabric()), (error: unknown) => error instanceof ExecutionPlanError && error.code === "identity-mismatch");
  const capsuleMutation = structuredClone(createExecutionPlan(compiled(), fabric(), manifest));
  capsuleMutation.capsule_ids = [];
  assert.throws(() => inspectExecutionPlan(capsuleMutation, fabric()), (error: unknown) => error instanceof ExecutionPlanError && error.code === "identity-mismatch");
});

test("binding rejects an unknown dependency without mutating the DAG input", () => {
  const input = fabric();
  (input.units[1]!.depends_on as string[]).push("missing");
  assertDagRejectedWithoutMutation(input);
});

test("binding rejects an unowned shared path without mutating the DAG input", () => {
  const input = fabric();
  (input.units[1]!.scope_read as string[]).push("a.txt");
  assertDagRejectedWithoutMutation(input);
});

test("binding rejects an unresolved exclusive resource without mutating the DAG input", () => {
  const input = fabric();
  (input.units[0]!.exclusive_resources as string[]).push("repo-lock");
  (input.units[1]!.exclusive_resources as string[]).push("repo-lock");
  assertDagRejectedWithoutMutation(input);
});
