import assert from "node:assert/strict";
import test from "node:test";
import { decideValidationBudget, validationEvidenceKey, type ValidationBudgetRequest } from "../dist/core/validation-budget.js";

const request = (extra: Partial<ValidationBudgetRequest> = {}): ValidationBudgetRequest => ({
  run_id: "run", operation_id: "operation", source_snapshot: "base", candidate: "candidate",
  command: ["node", "check"], scope: "targeted", expected_evidence: ["command", "source_snapshot"], reason: "preflight", ...extra,
});
const state = (consumed = 0, evidence_keys: string[] = []) => ({ limit: 1, consumed, evidence_keys });

test("typed invalid requests deny before execution", () => {
  assert.equal(decideValidationBudget({ ...request(), reason: "not-a-reason" }, state()).decision, "DENY");
  assert.equal(decideValidationBudget({ ...request(), expected_evidence: [] }, state()).reason, "invalid-contract");
});

test("same evidence is stable across reason text and only changed conditions alter it", () => {
  const first = validationEvidenceKey(request());
  assert.equal(validationEvidenceKey({ ...request(), reason: "acceptance" }), first);
  assert.notEqual(validationEvidenceKey({ ...request(), source_snapshot: "changed" }), first);
  assert.equal(decideValidationBudget(request(), state(0, [first])).reason, "duplicate-evidence");
});

test("actual protected content, not the volatile request identity, controls deduplication", () => {
  const renamed = { ...request(), run_id: "renamed-run", operation_id: "renamed-operation", candidate: "renamed-task" };
  const first = validationEvidenceKey(request());
  assert.equal(validationEvidenceKey(renamed), first);
  assert.equal(decideValidationBudget(renamed, state(0, [first])).reason, "duplicate-evidence");
  const changed = { ...renamed, source_snapshot: "actual-content-changed" };
  assert.equal(decideValidationBudget(changed, state(0, [first])).decision, "ALLOW");
});

test("retry requires a bounded cause and consumes one reservation", () => {
  assert.equal(decideValidationBudget({ ...request(), reason: "retry" }, state()).reason, "retry-justification-required");
  const result = decideValidationBudget({ ...request(), reason: "retry", retry_of: "prior", changed_cause: "source changed" }, state());
  assert.deepEqual({ decision: result.decision, consumed: result.consumed }, { decision: "ALLOW", consumed: 1 });
});

test("exhausted budget denies without selecting a smaller scope", () => {
  const result = decideValidationBudget({ ...request(), scope: "full" }, state(1));
  assert.deepEqual({ decision: result.decision, reason: result.reason, scope: result.scope }, { decision: "DENY", reason: "budget-exhausted", scope: "full" });
});

test("validation scope changes preserve the declared high-risk review evidence", () => {
  const expectedEvidence = ["command", "source_snapshot", "independent-review"];
  for (const scope of ["targeted", "full"] as const) {
    const validation = { ...request(), scope, expected_evidence: expectedEvidence };
    const result = decideValidationBudget(validation, state());
    assert.equal(result.decision, "ALLOW");
    assert.deepEqual(validation.expected_evidence, expectedEvidence);
    assert.ok(validation.expected_evidence.includes("independent-review"));
  }
});
