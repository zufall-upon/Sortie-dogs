import assert from "node:assert/strict";
import test from "node:test";
import { decideValidationBudget, selectValidationScope, validationEvidenceKey, validationEvidenceState, validationResultFingerprint, type ValidationBudgetRequest } from "../dist/core/validation-budget.js";

const request = (extra: Partial<ValidationBudgetRequest> = {}): ValidationBudgetRequest => ({
  run_id: "run", operation_id: "operation", source_snapshot: "base", candidate: "candidate",
  command: ["node", "check"], environment: { platform: "win32", arch: "x64", runtime: "node-22" },
  scope: "targeted", owner: "worker", expected_evidence: ["command", "source_snapshot"],
  marginal_value: { unmet_criteria: ["criterion"], risk_hypothesis: null }, reason: "preflight", ...extra,
});
const state = (consumed = 0, evidence_keys: string[] = [], prior_duration_ms?: number, blocked_evidence_keys: string[] = []) => ({
  limit: 1, consumed, evidence_keys, prior_duration_ms, blocked_evidence_keys,
});

test("typed invalid requests deny before execution", () => {
  assert.equal(decideValidationBudget({ ...request(), reason: "not-a-reason" }, state()).decision, "DENY");
  assert.equal(decideValidationBudget({ ...request(), expected_evidence: [] }, state()).reason, "invalid-contract");
});

test("same candidate, command, and environment dedupe while changed conditions do not", () => {
  const first = validationEvidenceKey(request());
  assert.equal(validationEvidenceKey({ ...request(), reason: "acceptance" }), first);
  assert.notEqual(validationEvidenceKey({ ...request(), candidate: "changed" }), first);
  assert.notEqual(validationEvidenceKey({ ...request(), command: ["node", "other-check"] }), first);
  assert.notEqual(validationEvidenceKey({ ...request(), environment: { ...request().environment, runtime: "node-23" } }), first);
  assert.equal(decideValidationBudget(request(), state(0, [first])).reason, "duplicate-evidence");
});

test("evidence identity includes actual owner and normalized scope provenance", () => {
  const workerTargeted = validationEvidenceKey(request());
  const workerStatic = validationEvidenceKey(request({ scope: "static" }));
  const coordinatorCanonical = validationEvidenceKey(request({ scope: "canonical", owner: "coordinator" }));
  const coordinatorLegacyFull = validationEvidenceKey(request({ scope: "full", owner: "coordinator" }));
  assert.notEqual(workerTargeted, workerStatic);
  assert.notEqual(workerTargeted, coordinatorCanonical);
  assert.equal(coordinatorCanonical, coordinatorLegacyFull);
  assert.equal(decideValidationBudget(request({ scope: "canonical", owner: "coordinator" }), state(0, [workerTargeted])).decision, "ALLOW");
});

test("request identity does not affect deduplication, but candidate content does", () => {
  const renamed = { ...request(), run_id: "renamed-run", operation_id: "renamed-operation" };
  const first = validationEvidenceKey(request());
  assert.equal(validationEvidenceKey(renamed), first);
  assert.equal(decideValidationBudget(renamed, state(0, [first])).reason, "duplicate-evidence");
  const changed = { ...renamed, candidate: "actual-content-changed" };
  assert.equal(decideValidationBudget(changed, state(0, [first])).decision, "ALLOW");
});

test("retry requires a bounded cause and consumes one reservation", () => {
  assert.equal(decideValidationBudget({ ...request(), reason: "retry" }, state()).reason, "retry-justification-required");
  const result = decideValidationBudget({ ...request(), reason: "retry", retry_of: "prior", changed_cause: "source changed" }, state());
  assert.deepEqual({ decision: result.decision, consumed: result.consumed }, { decision: "ALLOW", consumed: 1 });
});

test("exhausted budget denies without selecting a smaller scope", () => {
  const result = decideValidationBudget({ ...request(), scope: "full-suite", owner: "coordinator" }, state(1));
  assert.deepEqual({ decision: result.decision, reason: result.reason, scope: result.scope }, { decision: "DENY", reason: "budget-exhausted", scope: "full-suite" });
});

test("validation scope changes preserve the declared high-risk review evidence", () => {
  const expectedEvidence = ["command", "source_snapshot", "independent-review"];
  for (const [scope, owner] of [["targeted", "worker"], ["full-suite", "coordinator"]] as const) {
    const validation = { ...request(), scope, owner, expected_evidence: expectedEvidence };
    const result = decideValidationBudget(validation, state());
    assert.equal(result.decision, "ALLOW");
    assert.deepEqual(validation.expected_evidence, expectedEvidence);
    assert.ok(validation.expected_evidence.includes("independent-review"));
  }
});

test("profile ladder and ownership escalation are deterministic", () => {
  assert.equal(selectValidationScope({ profile: "fast", canonical: false, release: false, explicit_risk: false }), "static");
  assert.equal(selectValidationScope({ profile: "balanced", canonical: false, release: false, explicit_risk: false }), "targeted");
  assert.equal(selectValidationScope({ profile: "assurance", canonical: false, release: false, explicit_risk: false }), "related");
  assert.equal(selectValidationScope({ profile: "fast", canonical: true, release: false, explicit_risk: false }), "canonical");
  assert.equal(selectValidationScope({ profile: "balanced", canonical: false, release: true, explicit_risk: false }), "full-suite");
  assert.equal(selectValidationScope({ profile: "balanced", canonical: false, release: false, explicit_risk: true }), "full-suite");
  assert.equal(decideValidationBudget({ ...request(), scope: "canonical", owner: "worker" }, state()).reason, "owner-mismatch");
});

test("duplicate skip preserves budget and reports prior duration; settlement fingerprint is stable", () => {
  const first = request();
  const key = validationEvidenceKey(first);
  const result = decideValidationBudget(first, state(1, [key], 125));
  assert.deepEqual({ decision: result.decision, consumed: result.consumed, redundant_time_ms: result.redundant_time_ms },
    { decision: "SKIP", consumed: 1, redundant_time_ms: 125 });
  assert.notEqual(validationResultFingerprint(first, "passed", 0), validationResultFingerprint(first, "failed", 1));
});

test("blocked evidence denies instead of producing a false skip", () => {
  const key = validationEvidenceKey(request());
  for (const blocked of [key]) {
    const result = decideValidationBudget(request(), state(0, [], undefined, [blocked]));
    assert.deepEqual({ decision: result.decision, reason: result.reason, consumed: result.consumed },
      { decision: "DENY", reason: "duplicate-evidence", consumed: 0 });
  }
});

test("nonzero failures can consume a fresh attempt, while active and unsettled outcomes remain blocked", () => {
  const key = validationEvidenceKey(request());
  const admission = { kind: "validation.admission", decision: "ALLOW", reservation_id: "first", evidence_key: key };
  const failure = { kind: "validation.settled", reservation_id: "first", evidence_key: key, outcome: "failed", exit_code: 1 };
  const evidence = validationEvidenceState([admission, failure]);
  assert.deepEqual(evidence, { reusable: [], blocked: [] });
  const budget = { limit: 2, consumed: 1, evidence_keys: evidence.reusable, blocked_evidence_keys: evidence.blocked };
  assert.deepEqual(decideValidationBudget(request(), budget), {
    decision: "ALLOW", reason: "allowed", scope: "targeted", evidence_key: key, consumed: 2, redundant_time_ms: 0,
  });
  assert.equal(decideValidationBudget(request(), { ...budget, limit: 1 }).reason, "budget-exhausted");
  const retry = { ...admission, reservation_id: "second" };
  assert.deepEqual(validationEvidenceState([admission, failure, retry]), { reusable: [], blocked: [key] });
  assert.deepEqual(validationEvidenceState([admission, failure, retry, { ...failure, reservation_id: "second", outcome: "passed", exit_code: 0 }]),
    { reusable: [key], blocked: [] });
  for (const [outcome, exit_code] of [["failed", 0], ["failed", null], ["timeout", 124], ["interrupted", 130], ["cancelled", null]]) {
    assert.deepEqual(validationEvidenceState([admission, { ...failure, outcome, exit_code }]), { reusable: [], blocked: [key] });
  }
});

test("passed evidence is reusable only with exit code zero", () => {
  const key = validationEvidenceKey(request());
  const evidence = validationEvidenceState([
    { kind: "validation.admission", decision: "ALLOW", reservation_id: "reservation", evidence_key: key },
    { kind: "validation.settled", reservation_id: "reservation", evidence_key: key, outcome: "passed", exit_code: 9 },
  ]);
  assert.deepEqual(evidence, { reusable: [], blocked: [key] });
});

test("marginal value and retry justification fail closed", () => {
  assert.equal(decideValidationBudget({ ...request(), marginal_value: { unmet_criteria: [], risk_hypothesis: null } }, state()).reason, "marginal-value-required");
  assert.equal(decideValidationBudget({ ...request(), reason: "retry", retry_of: "prior" }, state()).reason, "retry-justification-required");
});
