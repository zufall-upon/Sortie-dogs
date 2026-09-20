import assert from "node:assert/strict";
import nodeTest, { describe } from "node:test";

import { validationEvidenceKey, type ValidationBudgetRequest } from "../dist/core/validation-budget.js";
import { decideFabricValidationAdmission, finalizeFabricValidationSettlement } from "../dist/core/worktree-parallel-dispatch.js";
import { worktreeDispatchCases } from "./integration/worktree-parallel-dispatch.test.ts?normal";

describe("worktree dispatch", { concurrency: 3 }, () => {
  for (const candidate of worktreeDispatchCases("normal")) {
    nodeTest(candidate.name, candidate.options ?? {}, candidate.run);
  }
});

nodeTest("parallel settled-pass admission reports only the prior successful duration", () => {
  const request: ValidationBudgetRequest = {
    run_id: "run", operation_id: "operation", source_snapshot: "source", candidate: "candidate",
    command: [process.execPath, "check"], environment: { platform: process.platform, arch: process.arch, runtime: process.version },
    scope: "canonical", owner: "coordinator", expected_evidence: ["candidate"],
    marginal_value: { unmet_criteria: ["candidate"], risk_hypothesis: null }, reason: "acceptance",
  };
  const evidenceKey = validationEvidenceKey(request);
  const priorFingerprint = `sha256:${"a".repeat(64)}`;
  const events = [
    { kind: "validation.admission", decision: "ALLOW", reservation_id: "failed", evidence_key: evidenceKey },
    { kind: "validation.settled", reservation_id: "failed", evidence_key: evidenceKey,
      outcome: "failed", exit_code: 1, duration_ms: 900 },
    { kind: "validation.admission", decision: "ALLOW", reservation_id: "passed", evidence_key: evidenceKey },
    { kind: "validation.settled", reservation_id: "passed", evidence_key: evidenceKey,
      outcome: "passed", exit_code: 0, duration_ms: 37, evidence_fingerprint: priorFingerprint },
  ];
  const decision = decideFabricValidationAdmission(request, 1, events);
  assert.deepEqual({ decision: decision.decision, saved_ms: decision.redundant_time_ms,
    reused_fingerprint: decision.reused_fingerprint },
  { decision: "SKIP", saved_ms: 37, reused_fingerprint: "a".repeat(64) });
});

nodeTest("parallel settled-pass reuse fails closed without an exact valid proof fingerprint", () => {
  const request: ValidationBudgetRequest = {
    run_id: "proof-run", operation_id: "proof-operation", source_snapshot: "source", candidate: "candidate",
    command: [process.execPath, "proof-check"], environment: { platform: process.platform, arch: process.arch, runtime: process.version },
    scope: "canonical", owner: "coordinator", expected_evidence: ["candidate"],
    marginal_value: { unmet_criteria: ["candidate"], risk_hypothesis: null }, reason: "acceptance",
  };
  const key = validationEvidenceKey(request);
  for (const evidence_fingerprint of [undefined, "sha256:not-a-valid-proof"]) {
    const decision = decideFabricValidationAdmission(request, 1, [
      { kind: "validation.admission", decision: "ALLOW", reservation_id: "passed", evidence_key: key },
      { kind: "validation.settled", reservation_id: "passed", evidence_key: key,
        outcome: "passed", exit_code: 0, duration_ms: 91, ...(evidence_fingerprint === undefined ? {} : { evidence_fingerprint }) },
    ]);
    assert.deepEqual({ decision: decision.decision, reason: decision.reason,
      saved_ms: decision.redundant_time_ms, reused_fingerprint: decision.reused_fingerprint },
    { decision: "DENY", reason: "evidence-proof-unavailable", saved_ms: 0, reused_fingerprint: null });
  }
});

nodeTest("exit zero that dirties the validation worktree settles failed and remains non-reusable", () => {
  const request: ValidationBudgetRequest = {
    run_id: "dirty-run", operation_id: "dirty-operation", source_snapshot: "source", candidate: "candidate",
    command: [process.execPath, "dirty-check"], environment: { platform: process.platform, arch: process.arch, runtime: process.version },
    scope: "canonical", owner: "coordinator", expected_evidence: ["clean_worktree"],
    marginal_value: { unmet_criteria: ["clean_worktree"], risk_hypothesis: null }, reason: "acceptance",
  };
  const key = validationEvidenceKey(request);
  const settlement = finalizeFabricValidationSettlement({ outcome: "passed", exitCode: 0, duration_ms: 41 }, false);
  assert.deepEqual(settlement, { outcome: "failed", exitCode: 0, duration_ms: 41 });
  const decision = decideFabricValidationAdmission(request, 1, [
    { kind: "validation.admission", decision: "ALLOW", reservation_id: "dirty", evidence_key: key },
    { kind: "validation.settled", reservation_id: "dirty", evidence_key: key,
      outcome: settlement.outcome, exit_code: settlement.exitCode, duration_ms: settlement.duration_ms },
  ]);
  assert.deepEqual({ decision: decision.decision, reason: decision.reason },
    { decision: "DENY", reason: "duplicate-evidence" });
});
