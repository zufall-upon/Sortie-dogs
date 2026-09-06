import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  diagnoseFailure,
  type FailureDiagnosisCandidate,
  type FailureDiagnosisInput,
} from "../dist/core/failure-diagnosis.js";
import {
  planFailureSwarm,
  type FailureSwarmIdentity,
  type FailureSwarmPlanInput,
} from "../dist/core/failure-swarm-plan.js";

const capsuleA = `sha256:${"a".repeat(64)}`;
const capsuleB = `sha256:${"b".repeat(64)}`;

function identity(overrides: Partial<FailureSwarmIdentity> = {}): FailureSwarmIdentity {
  return {
    run_id: "run-synthetic",
    unit_id: "unit-synthetic",
    attempt_id: "attempt-current",
    candidate_id: "candidate-synthetic",
    ...overrides,
  };
}

function swarmInput(overrides: Partial<FailureSwarmPlanInput> = {}): FailureSwarmPlanInput {
  return {
    identity: identity(),
    remediation_status: "completed",
    canonical_result: "failed",
    cause: "unknown",
    origin: "implementation",
    prior_diagnosis_attempts: [identity({ attempt_id: "attempt-previous" })],
    causal_classes: ["network", "configuration", "dependency"],
    lanes: [
      { lane_id: "lane-write", access: "write", available: true },
      { lane_id: "lane-c", access: "read_only", available: false },
      { lane_id: "lane-b", access: "read_only", available: true },
      { lane_id: "lane-a", access: "read_only", available: true },
    ],
    max_lanes: 2,
    per_lane_budget_charge: {
      kind: "read_only_diagnosis",
      recovery_actions: 1,
      probe_iterations: 2,
      model_attempts: 1,
    },
    budget_limits: { recovery_actions: 10, probe_iterations: 10, model_attempts: 10 },
    budget_consumed: { recovery_actions: 2, probe_iterations: 1, model_attempts: 3 },
    ...overrides,
  };
}

function candidate(overrides: Partial<FailureDiagnosisCandidate> = {}): FailureDiagnosisCandidate {
  return {
    diagnosis_id: "diagnosis-a",
    capsule_id: capsuleA,
    recovery_kind: "adaptive_probe",
    proposal: "Inspect the bounded failure evidence.",
    budget_request: {
      kind: "adaptive_probe",
      recovery_actions: 1,
      probe_iterations: 2,
      model_attempts: 1,
    },
    ...overrides,
  };
}

function diagnosisInput(overrides: Partial<FailureDiagnosisInput> = {}): FailureDiagnosisInput {
  return {
    candidates: [
      candidate(),
      candidate({
        diagnosis_id: "diagnosis-b",
        capsule_id: capsuleB,
        recovery_kind: "model_rescue",
        proposal: "Use the alternate bounded model analysis.",
        budget_request: {
          kind: "model_rescue",
          recovery_actions: 2,
          probe_iterations: 1,
          model_attempts: 2,
        },
      }),
    ],
    coordinator_selection: { diagnosis_id: "diagnosis-a", capsule_id: capsuleA },
    budget_limits: { recovery_actions: 8, probe_iterations: 8, model_attempts: 8 },
    budget_consumed: { recovery_actions: 2, probe_iterations: 3, model_attempts: 1 },
    ...overrides,
  };
}

function callWithoutMutation<T, R>(input: T, call: (value: T) => R): R {
  const before = structuredClone(input);
  const result = call(input);
  assert.deepStrictEqual(input, before, "policy evaluation must not mutate its synthetic input");
  return result;
}

describe("failure swarm planning policy", () => {
  it("starts only after completed remediation for an unknown canonical failure", () => {
    const cases: readonly [Partial<FailureSwarmPlanInput>, string][] = [
      [{ remediation_status: "pending" }, "remediation_not_completed"],
      [{ canonical_result: "not_run" }, "canonical_failure_absent"],
      [{ canonical_result: "passed" }, "canonical_failure_absent"],
      [{ cause: "known" }, "cause_already_known"],
      [{ origin: "read_only_diagnosis" }, "recursive_diagnosis"],
      [{ prior_diagnosis_attempts: [identity()] }, "attempt_already_diagnosed"],
    ];

    for (const [overrides, reason] of cases) {
      const input = swarmInput(overrides);
      assert.deepStrictEqual(callWithoutMutation(input, planFailureSwarm), { status: "not_planned", reason });
    }
  });

  it("deterministically assigns distinct classes to available read-only lanes only", () => {
    const input = swarmInput();
    const result = callWithoutMutation(input, planFailureSwarm);
    assert.equal(result.status, "planned");
    if (result.status !== "planned") assert.fail("eligible failure must produce a swarm plan");

    assert.deepStrictEqual(result.plan.assignments, [
      { causal_class: "configuration", lane_id: "lane-a" },
      { causal_class: "dependency", lane_id: "lane-b" },
    ]);
    assert.deepStrictEqual(result.plan.budget_reservation, {
      status: "requested",
      charge: {
        kind: "read_only_diagnosis",
        recovery_actions: 2,
        probe_iterations: 4,
        model_attempts: 2,
      },
      remaining_after_reservation: { recovery_actions: 6, probe_iterations: 5, model_attempts: 5 },
    });
    assert.deepStrictEqual(result.plan.runtime_responsibilities, {
      persist_attempt_history: true,
      reserve_budget: true,
      dispatch_read_only_lanes: true,
      execute_diagnosis: true,
      accept_diagnosis_results: true,
    });

    // This pure planner neither reserves budget nor dispatches or executes diagnosis.
    assert.notStrictEqual(result.plan.identity, input.identity);
  });

  it("requires capacity and rejects cumulative exhaustion in each budget dimension", () => {
    const noCapacity = swarmInput({
      lanes: [
        { lane_id: "lane-write", access: "write", available: true },
        { lane_id: "lane-busy", access: "read_only", available: false },
      ],
    });
    assert.deepStrictEqual(callWithoutMutation(noCapacity, planFailureSwarm), {
      status: "not_planned",
      reason: "no_diagnosis_capacity",
    });

    for (const field of ["recovery_actions", "probe_iterations", "model_attempts"] as const) {
      const consumed = { recovery_actions: 0, probe_iterations: 0, model_attempts: 0, [field]: 9 };
      const input = swarmInput({
        budget_limits: { recovery_actions: 10, probe_iterations: 10, model_attempts: 10 },
        budget_consumed: consumed,
      });
      assert.deepStrictEqual(callWithoutMutation(input, planFailureSwarm), {
        status: "rejected",
        reason: "budget_exceeded",
      });
    }
  });

  it("rejects unsafe per-lane budget multiplication", () => {
    const input = swarmInput({
      per_lane_budget_charge: {
        kind: "read_only_diagnosis",
        recovery_actions: Number.MAX_SAFE_INTEGER,
        probe_iterations: 0,
        model_attempts: 0,
      },
      budget_limits: {
        recovery_actions: Number.MAX_SAFE_INTEGER,
        probe_iterations: Number.MAX_SAFE_INTEGER,
        model_attempts: Number.MAX_SAFE_INTEGER,
      },
      budget_consumed: { recovery_actions: 0, probe_iterations: 0, model_attempts: 0 },
    });
    assert.deepStrictEqual(callWithoutMutation(input, planFailureSwarm), {
      status: "rejected",
      reason: "invalid_budget",
    });
  });
});

describe("failure diagnosis selection policy", () => {
  it("requires one explicit coordinator selection", () => {
    const missing = diagnosisInput({ coordinator_selection: null });
    assert.deepStrictEqual(callWithoutMutation(missing, diagnoseFailure), {
      status: "selection_required",
      reason: "coordinator_selection_missing",
    });

    const mismatches = [
      { diagnosis_id: "diagnosis-missing", capsule_id: capsuleA },
      { diagnosis_id: "diagnosis-a", capsule_id: capsuleB },
    ];
    for (const coordinatorSelection of mismatches) {
      const input = diagnosisInput({ coordinator_selection: coordinatorSelection });
      assert.deepStrictEqual(callWithoutMutation(input, diagnoseFailure), {
        status: "rejected",
        reason: "invalid_selection",
      });
    }
  });

  it("rejects duplicate candidate identities instead of choosing either candidate", () => {
    const duplicate = candidate({ proposal: "A duplicate identity with different proposal text." });
    const input = diagnosisInput({ candidates: [candidate(), duplicate] });
    assert.deepStrictEqual(callWithoutMutation(input, diagnoseFailure), {
      status: "rejected",
      reason: "invalid_selection",
    });
  });

  it("proposes only the explicitly selected candidate with cumulative budget accounting", () => {
    const input = diagnosisInput();
    const result = callWithoutMutation(input, diagnoseFailure);
    assert.equal(result.status, "proposed");
    if (result.status !== "proposed") assert.fail("the exact coordinator selection must be proposed");

    assert.deepStrictEqual(result.proposal, {
      diagnosis_id: "diagnosis-a",
      capsule_id: capsuleA,
      recovery_kind: "adaptive_probe",
      proposal: "Inspect the bounded failure evidence.",
      budget_reservation: {
        status: "requested",
        charge: {
          kind: "adaptive_probe",
          recovery_actions: 1,
          probe_iterations: 2,
          model_attempts: 1,
        },
        remaining_after_reservation: { recovery_actions: 5, probe_iterations: 3, model_attempts: 6 },
      },
      runtime_responsibilities: {
        capsule_validation: true,
        duplicate_execution_suppression: true,
      },
    });

    // Reservation, diagnosis execution, capsule validation, and write authorization are runtime-only.
    assert.notStrictEqual(result.proposal.budget_reservation.charge, input.candidates[0]!.budget_request);
  });

  it("rejects cumulative exhaustion in each diagnosis budget dimension", () => {
    for (const field of ["recovery_actions", "probe_iterations", "model_attempts"] as const) {
      const consumed = { recovery_actions: 0, probe_iterations: 0, model_attempts: 0, [field]: 8 };
      const input = diagnosisInput({ budget_consumed: consumed });
      assert.deepStrictEqual(callWithoutMutation(input, diagnoseFailure), {
        status: "rejected",
        reason: "budget_exceeded",
      });
    }
  });
});
