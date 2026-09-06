import assert from "node:assert/strict";
import test from "node:test";

import { compileAcceptanceCoverage, type AcceptanceCompileProposal } from "../src/core/acceptance-compiler.ts";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function proposal(): AcceptanceCompileProposal {
  return {
    version: "0.1",
    provenance: { producer: "dog-coordinator", acceptance_fingerprint: digest("a"), capsule_inputs_exclude_secrets: true },
    unit_ids: ["compiler", "runtime"],
    declared_capsule_ids: [digest("c")],
    acceptance_items: [
      { acceptance_id: "ac-1", observable_criterion: "All accepted items have one owner." },
      { acceptance_id: "ac-2", observable_criterion: "Validation evidence covers every item." },
    ],
    validations: [
      { validation_id: "focused", unit_id: "compiler", command_fingerprint: digest("f"), references: { capsule_ids: [digest("c")], artifact_ids: [digest("1")] } },
      { validation_id: "integration", unit_id: "runtime", command_fingerprint: digest("8"), references: { capsule_ids: [], artifact_ids: [digest("2")] } },
    ],
    coverage: [
      { acceptance_id: "ac-1", unit_id: "compiler", validation_ids: ["focused"] },
      { acceptance_id: "ac-2", unit_id: "runtime", validation_ids: ["integration"] },
    ],
  };
}

function compileWithoutMutation(value: unknown) {
  const before = structuredClone(value);
  const result = compileAcceptanceCoverage(value);
  assert.deepEqual(value, before);
  return result;
}

test("compiles deterministic immutable final coverage without duplicating DAG scope", () => {
  const first = compileWithoutMutation(proposal());
  const second = compileWithoutMutation(structuredClone(proposal()));
  assert.equal(first.status, "accepted");
  assert.equal(first.plan_id, second.plan_id);
  assert.deepEqual(first.coverage_map, [
    { acceptance_id: "ac-1", unit_id: "compiler", validation_ids: ["focused"], references: { capsule_ids: [digest("c")], artifact_ids: [digest("1")] } },
    { acceptance_id: "ac-2", unit_id: "runtime", validation_ids: ["integration"], references: { capsule_ids: [], artifact_ids: [digest("2")] } },
  ]);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.coverage_map));
  assert.equal("scope_write" in proposal(), false);
});

test("rejects uncovered acceptance then accepts a corrected proposal", () => {
  const invalid = proposal();
  invalid.coverage = invalid.coverage.slice(0, 1);
  const rejected = compileWithoutMutation(invalid);
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejected.gaps, [{ code: "uncovered_acceptance", pointer: "/acceptance_items/1", acceptance_id: "ac-2", unit_id: null, validation_id: null }]);
  assert.deepEqual(rejected.coverage_map, []);
  const accepted = compileWithoutMutation(proposal());
  assert.equal(accepted.status, "accepted");
  assert.notEqual(accepted.plan_id, rejected.plan_id);
});

test("returns located bounded gaps for unknown, duplicate, mismatched, undeclared, and evidence-free references", () => {
  const invalid = proposal();
  invalid.acceptance_items = [...invalid.acceptance_items, invalid.acceptance_items[0]!];
  invalid.unit_ids = ["compiler", "runtime", "runtime"];
  invalid.validations = [
    ...invalid.validations,
    { validation_id: "empty", unit_id: "missing-unit", command_fingerprint: digest("e"), references: { capsule_ids: [], artifact_ids: [] } },
    { validation_id: "foreign", unit_id: "compiler", command_fingerprint: digest("9"), references: { capsule_ids: [digest("7")], artifact_ids: [digest("9")] } },
  ];
  invalid.coverage = [
    ...invalid.coverage,
    { acceptance_id: "unknown", unit_id: "missing-unit", validation_ids: ["missing-validation"] },
    { acceptance_id: "ac-1", unit_id: "runtime", validation_ids: ["foreign"] },
  ];
  const result = compileWithoutMutation(invalid);
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") {
    const codes = new Set(result.gaps.map((entry) => entry.code));
    for (const code of ["duplicate_acceptance_id", "duplicate_unit_id", "duplicate_coverage", "unknown_unit_id", "validation_evidence_missing", "undeclared_capsule", "unknown_acceptance_id", "unknown_validation_id", "validation_unit_mismatch"] as const) assert(codes.has(code), code);
    assert(result.gaps.every((entry) => entry.pointer.startsWith("/")));
  }
});

test("rejects unknown unit ownership in an otherwise complete proposal", () => {
  const invalid = proposal();
  invalid.validations[0]!.unit_id = "missing-unit";
  invalid.coverage[0]!.unit_id = "missing-unit";
  const result = compileWithoutMutation(invalid);
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.coverage_map, []);
  assert.deepEqual(result.gaps, [
    { code: "unknown_unit_id", pointer: "/validations/0/unit_id", acceptance_id: null, unit_id: "missing-unit", validation_id: "focused" },
    { code: "unknown_unit_id", pointer: "/coverage/0/unit_id", acceptance_id: "ac-1", unit_id: "missing-unit", validation_id: null },
  ]);
});

test("rejects validation ownership mismatch in an otherwise complete proposal", () => {
  const invalid = proposal();
  invalid.coverage[0]!.unit_id = "runtime";
  const result = compileWithoutMutation(invalid);
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.coverage_map, []);
  assert.deepEqual(result.gaps, [
    { code: "validation_unit_mismatch", pointer: "/coverage/0/validation_ids", acceptance_id: "ac-1", unit_id: "runtime", validation_id: "focused" },
  ]);
});

test("closed schema rejects raw request text and a missing producer secret-exclusion assertion", () => {
  assert.equal(compileWithoutMutation({ ...proposal(), raw_request_text: "do not retain" }).status, "rejected");
  const invalid = proposal() as unknown as { provenance: Record<string, unknown> };
  delete invalid.provenance.capsule_inputs_exclude_secrets;
  assert.equal(compileWithoutMutation(invalid).status, "rejected");
});
