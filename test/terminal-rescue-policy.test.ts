import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  proposeTerminalRescue,
  type TerminalRescueBudget,
  type TerminalRescuePolicyInput,
} from "../dist/core/terminal-rescue-policy.js";
import type {
  ChildTerminalEvidence,
  ChildTerminalIdentity,
  ChildTerminalReconciliationInput,
} from "../dist/core/child-terminal-reconciliation.js";

function identity(overrides: Partial<ChildTerminalIdentity> = {}): ChildTerminalIdentity {
  return {
    run_id: "run-rescue",
    unit_id: "unit-rescue",
    attempt_id: "attempt-normal-remediation",
    predecessor_attempt_id: "attempt-implementation",
    candidate_id: "candidate-accepted",
    route_id: "route-normal-remediation",
    child_id: "child-normal-remediation",
    call_id: "call-normal-remediation",
    ...overrides,
  };
}

function evidence(overrides: Partial<ChildTerminalEvidence> = {}): ChildTerminalEvidence {
  return {
    terminal: "satisfied",
    tools_quiescent: "satisfied",
    artifact_window_closed: "satisfied",
    writer_released: "satisfied",
    gate_released: "satisfied",
    lease_released: "satisfied",
    worktree_released: "satisfied",
    ...overrides,
  };
}

function reconciliation(
  current = identity(),
  overrides: Partial<ChildTerminalReconciliationInput> = {},
): ChildTerminalReconciliationInput {
  return {
    current,
    observation: { identity: { ...current }, disposition: "failed" },
    evidence: evidence(),
    ...overrides,
  };
}

function budget(
  recoveryActions: number,
  probeIterations: number,
  modelAttempts: number,
  timeMs: number,
  costUsd: number,
): TerminalRescueBudget {
  return {
    counters: {
      recovery_actions: recoveryActions,
      probe_iterations: probeIterations,
      model_attempts: modelAttempts,
    },
    resources: { time_ms: timeMs, cost_usd: costUsd },
  };
}

function validInput(overrides: Partial<TerminalRescuePolicyInput> = {}): TerminalRescuePolicyInput {
  const current = identity();
  return {
    prior_attempt: {
      identity: current,
      role: "implementation",
      recovery_kind: "normal_remediation",
      disposition: "failed",
      failure: { category: "implementation", code: "tests_failed" },
    },
    terminal_reconciliation: reconciliation(current),
    accepted_base: {
      candidate_id: "candidate-accepted",
      contract_id: "contract-accepted",
      scope: ["src/accepted.ts"],
      acceptance: ["accepted behavior remains fixed"],
      validation: ["npm test"],
    },
    available_target: { model: "openai/gpt-5.6-sol", variant: "high" },
    explicit_override: false,
    unit_rescue_count: 0,
    active_run_rescue_count: 0,
    budget_limits: budget(5, 3, 4, 10_000, 2),
    budget_consumed: budget(2, 1, 1, 4_000, 0.75),
    budget_request: budget(1, 1, 1, 2_000, 0.5),
    ...overrides,
  };
}

function evaluateWithoutMutation(input: TerminalRescuePolicyInput) {
  const before = structuredClone(input);
  const result = proposeTerminalRescue(input);
  assert.deepStrictEqual(input, before, "rescue policy must not mutate its input");
  return result;
}

function assertNonRescue(input: TerminalRescuePolicyInput, reason: string): void {
  assert.deepStrictEqual(evaluateWithoutMutation(input), { status: "non_rescue", reason });
}

describe("terminal rescue policy", () => {
  it("proposes only after failed normal remediation with reconciled terminal implementation evidence", () => {
    const input = validInput();
    const result = evaluateWithoutMutation(input);

    assert.equal(result.status, "proposed");
    if (result.status !== "proposed") assert.fail("eligible terminal rescue must be proposed");
    assert.deepStrictEqual(result.proposal.target, input.available_target);
    assert.deepStrictEqual(result.proposal.predecessor_identity, input.prior_attempt.identity);

    assertNonRescue(validInput({
      prior_attempt: { ...validInput().prior_attempt, role: "review" },
    }), "prior_executor_not_normal_worker");
    assertNonRescue(validInput({
      prior_attempt: { ...validInput().prior_attempt, recovery_kind: "implementation" },
    }), "normal_remediation_not_exhausted");
    assertNonRescue(validInput({
      prior_attempt: { ...validInput().prior_attempt, disposition: "succeeded" },
    }), "prior_attempt_not_failed");
  });

  it("excludes non-implementation failure categories and cancellation", () => {
    const cases = [
      ["infrastructure", "infrastructure_failure"],
      ["authorization", "authorization_failure"],
      ["contract", "contract_failure"],
      ["cancellation", "cancellation_failure"],
      ["unknown", "unknown_failure"],
    ] as const;

    for (const [category, reason] of cases) {
      assertNonRescue(validInput({
        prior_attempt: {
          ...validInput().prior_attempt,
          failure: { category, code: `${category}_failure` },
        },
      }), reason);
    }

    assertNonRescue(validInput({
      prior_attempt: { ...validInput().prior_attempt, disposition: "cancelled" },
    }), "cancellation_failure");
  });

  it("requires completed reconciliation with matching identity and failed disposition", () => {
    assertNonRescue(validInput({
      terminal_reconciliation: reconciliation(identity(), {
        evidence: evidence({ tools_quiescent: "unknown" }),
      }),
    }), "terminal_not_reconciled");

    const priorIdentity = identity();
    const otherIdentity = identity({ call_id: "call-other" });
    assertNonRescue(validInput({
      prior_attempt: { ...validInput().prior_attempt, identity: priorIdentity },
      terminal_reconciliation: reconciliation(otherIdentity),
    }), "terminal_identity_conflict");

    const current = identity();
    assertNonRescue(validInput({
      prior_attempt: { ...validInput().prior_attempt, identity: current },
      terminal_reconciliation: reconciliation(current, {
        observation: { identity: { ...current }, disposition: "succeeded" },
      }),
    }), "terminal_identity_conflict");
  });

  it("excludes unavailable targets, overrides, used unit rescue, and active run rescue", () => {
    const cases: readonly [Partial<TerminalRescuePolicyInput>, string][] = [
      [{ available_target: null }, "target_unavailable"],
      [{ explicit_override: true }, "explicit_override"],
      [{ unit_rescue_count: 1 }, "unit_rescue_already_used"],
      [{ active_run_rescue_count: 1 }, "run_rescue_active"],
    ];
    for (const [override, reason] of cases) assertNonRescue(validInput(override), reason);
  });

  it("uses cumulative count, time, and cost budgets at the inclusive boundary", () => {
    const limits = budget(5, 3, 4, 10_000, 2);
    const consumed = budget(2, 1, 1, 4_000, 0.75);
    const exactRemainder = budget(3, 2, 3, 6_000, 1.25);
    assert.equal(evaluateWithoutMutation(validInput({
      budget_limits: limits,
      budget_consumed: consumed,
      budget_request: exactRemainder,
    })).status, "proposed");

    const exhaustedCases = [
      budget(4, 2, 3, 6_000, 1.25),
      budget(3, 3, 3, 6_000, 1.25),
      budget(3, 2, 4, 6_000, 1.25),
      budget(3, 2, 3, 6_001, 1.25),
      budget(3, 2, 3, 6_000, 1.251),
    ];
    for (const request of exhaustedCases) {
      assertNonRescue(validInput({ budget_limits: limits, budget_consumed: consumed, budget_request: request }), "budget_exhausted");
    }
  });

  it("rejects integer and floating-point cumulative overflow", () => {
    assertNonRescue(validInput({
      budget_limits: budget(Number.MAX_SAFE_INTEGER, 3, 4, 10_000, 2),
      budget_consumed: budget(Number.MAX_SAFE_INTEGER, 1, 1, 4_000, 0.75),
      budget_request: budget(1, 1, 1, 2_000, 0.5),
    }), "budget_exhausted");
    assertNonRescue(validInput({
      budget_limits: budget(5, 3, 4, Number.MAX_SAFE_INTEGER, 2),
      budget_consumed: budget(2, 1, 1, Number.MAX_SAFE_INTEGER, 0.75),
      budget_request: budget(1, 1, 1, 1, 0.5),
    }), "budget_exhausted");
    assertNonRescue(validInput({
      budget_limits: budget(5, 3, 4, 10_000, Number.MAX_VALUE),
      budget_consumed: budget(2, 1, 1, 4_000, Number.MAX_VALUE),
      budget_request: budget(1, 1, 1, 2_000, Number.MAX_VALUE),
    }), "budget_exhausted");
  });

  it("preserves accepted base fields and returns detached frozen proposal data", () => {
    const input = validInput();
    const result = evaluateWithoutMutation(input);
    assert.equal(result.status, "proposed");
    if (result.status !== "proposed") assert.fail("eligible terminal rescue must be proposed");

    const proposal = result.proposal;
    assert.equal(proposal.accepted_base_candidate_id, input.accepted_base.candidate_id);
    assert.equal(proposal.contract_id, input.accepted_base.contract_id);
    assert.deepStrictEqual(proposal.scope, input.accepted_base.scope);
    assert.deepStrictEqual(proposal.acceptance, input.accepted_base.acceptance);
    assert.deepStrictEqual(proposal.validation, input.accepted_base.validation);
    assert.deepStrictEqual(proposal.budget_request, input.budget_request);

    assert.notStrictEqual(proposal.target, input.available_target);
    assert.notStrictEqual(proposal.scope, input.accepted_base.scope);
    assert.notStrictEqual(proposal.acceptance, input.accepted_base.acceptance);
    assert.notStrictEqual(proposal.validation, input.accepted_base.validation);
    assert.notStrictEqual(proposal.predecessor_identity, input.prior_attempt.identity);
    assert.notStrictEqual(proposal.budget_request, input.budget_request);
    assert.notStrictEqual(proposal.budget_request.counters, input.budget_request.counters);
    assert.notStrictEqual(proposal.budget_request.resources, input.budget_request.resources);

    for (const value of [
      result,
      proposal,
      proposal.target,
      proposal.scope,
      proposal.acceptance,
      proposal.validation,
      proposal.predecessor_identity,
      proposal.budget_request,
      proposal.budget_request.counters,
      proposal.budget_request.resources,
      proposal.obligations,
    ]) assert.equal(Object.isFrozen(value), true);
  });

  it("returns pure advice while runtime retains dispatch, writer authorization, budget consumption, and CAS", () => {
    const result = evaluateWithoutMutation(validInput());
    assert.equal(result.status, "proposed");
    if (result.status !== "proposed") assert.fail("eligible terminal rescue must be proposed");

    // No dispatch, writer authorization, budget charge, or candidate mutation is performed here.
    // Runtime must enforce these obligations before and after acting on this inert proposal.
    assert.deepStrictEqual(result.proposal.obligations, [
      "stop_confirmed",
      "writer_exclusive",
      "final_validation",
      "final_review",
      "candidate_cas",
    ]);
  });
});
