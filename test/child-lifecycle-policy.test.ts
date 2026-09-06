import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planChildCancellation } from "../dist/core/child-cancellation-plan.js";
import type { ChildCancellationPlanInput } from "../dist/core/child-cancellation-plan.js";
import {
  reconcileChildTerminal,
  type ChildTerminalEvidence,
  type ChildTerminalEvidenceName,
  type ChildTerminalIdentity,
  type ChildTerminalReconciliationInput,
} from "../dist/core/child-terminal-reconciliation.js";

const evidenceNames: readonly ChildTerminalEvidenceName[] = [
  "terminal",
  "tools_quiescent",
  "artifact_window_closed",
  "writer_released",
  "gate_released",
  "lease_released",
  "worktree_released",
];

function identity(overrides: Partial<ChildTerminalIdentity> = {}): ChildTerminalIdentity {
  return {
    run_id: "run-synthetic",
    unit_id: "unit-synthetic",
    attempt_id: "attempt-current",
    predecessor_attempt_id: "attempt-previous",
    candidate_id: "candidate-synthetic",
    route_id: "route-synthetic",
    child_id: "child-synthetic",
    call_id: "call-synthetic",
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

function reconciliationInput(
  overrides: Partial<ChildTerminalReconciliationInput> = {},
): ChildTerminalReconciliationInput {
  const current = identity();
  return {
    current,
    observation: { identity: { ...current }, disposition: "succeeded", observed_at: "2035-01-01T00:00:00Z" },
    evidence: evidence(),
    ...overrides,
  };
}

function cancellationInput(overrides: Partial<ChildCancellationPlanInput> = {}): ChildCancellationPlanInput {
  const current = identity();
  return {
    current,
    observation: { identity: { ...current }, disposition: "continue", observed_at: "not-a-clock-input" },
    evidence: evidence({ terminal: "unsatisfied" }),
    deadline_ms: 1_000,
    now_ms: 999,
    cancellation_requested: false,
    prior_stop_requests: [],
    ...overrides,
  };
}

function callWithoutMutation<T, R>(input: T, call: (value: T) => R): R {
  const before = structuredClone(input);
  const result = call(input);
  assert.deepStrictEqual(input, before, "policy evaluation must not mutate its synthetic input");
  return result;
}

describe("child terminal reconciliation policy", () => {
  it("becomes ready only when all seven independently named evidence conditions are satisfied", () => {
    const readyInput = reconciliationInput();
    const ready = callWithoutMutation(readyInput, reconcileChildTerminal);
    assert.deepStrictEqual(
      {
        status: ready.status,
        reason: ready.reason,
        unknown: ready.unknown,
        blocking: ready.blocking,
        replayed: ready.replayed,
        emitTerminalEvent: ready.emitTerminalEvent,
      },
      {
        status: "ready",
        reason: "terminal_ready",
        unknown: [],
        blocking: [],
        replayed: false,
        emitTerminalEvent: true,
      },
    );
    assert.match(ready.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);

    for (const name of evidenceNames) {
      const unsatisfiedInput = reconciliationInput({ evidence: evidence({ [name]: "unsatisfied" }) });
      const unsatisfied = callWithoutMutation(unsatisfiedInput, reconcileChildTerminal);
      assert.equal(unsatisfied.status, "withheld", `${name} must block readiness when unsatisfied`);
      assert.equal(unsatisfied.reason, "evidence_unsatisfied");
      assert.deepStrictEqual(unsatisfied.blocking, [name]);
      assert.deepStrictEqual(unsatisfied.unknown, []);
      assert.equal(unsatisfied.emitTerminalEvent, false);

      const unknownInput = reconciliationInput({ evidence: evidence({ [name]: "unknown" }) });
      const unknown = callWithoutMutation(unknownInput, reconcileChildTerminal);
      assert.equal(unknown.status, "withheld", `${name} must block readiness when unknown`);
      assert.equal(unknown.reason, "evidence_unknown");
      assert.deepStrictEqual(unknown.unknown, [name]);
      assert.deepStrictEqual(unknown.blocking, []);
      assert.equal(unknown.emitTerminalEvent, false);
    }
  });

  it("rejects conflicting context identity and distinguishes a delayed attempt", () => {
    const contextFields = ["run_id", "unit_id", "candidate_id", "route_id", "child_id", "call_id"] as const;
    for (const field of contextFields) {
      const current = identity();
      const conflicting = identity({ [field]: `${current[field]}-other` });
      const input = reconciliationInput({
        current,
        observation: { identity: conflicting, disposition: "failed" },
      });
      const result = callWithoutMutation(input, reconcileChildTerminal);
      assert.deepStrictEqual(
        { status: result.status, reason: result.reason, fingerprint: result.fingerprint },
        { status: "rejected", reason: "identity_conflict", fingerprint: null },
        `${field} is part of context identity`,
      );
    }

    const current = identity();
    const delayedInput = reconciliationInput({
      current,
      observation: { identity: identity({ attempt_id: "attempt-previous" }), disposition: "succeeded" },
    });
    const delayed = callWithoutMutation(delayedInput, reconcileChildTerminal);
    assert.equal(delayed.status, "rejected");
    assert.equal(delayed.reason, "late_terminal");

    const predecessorConflictInput = reconciliationInput({
      current,
      observation: { identity: identity({ predecessor_attempt_id: "different-predecessor" }), disposition: "succeeded" },
    });
    const predecessorConflict = callWithoutMutation(predecessorConflictInput, reconcileChildTerminal);
    assert.equal(predecessorConflict.status, "rejected");
    assert.equal(predecessorConflict.reason, "identity_conflict");
  });

  it("suppresses a settled replay and excludes observation time from its fingerprint", () => {
    const firstInput = reconciliationInput();
    const first = callWithoutMutation(firstInput, reconcileChildTerminal);
    assert.equal(first.status, "ready");
    assert.equal(first.emitTerminalEvent, true);
    assert.ok(first.fingerprint);

    const replayInput = reconciliationInput({
      observation: {
        identity: identity(),
        disposition: "succeeded",
        observed_at: "this-different-value-is-deliberately-not-parsed",
      },
      settled_fingerprint: first.fingerprint,
    });
    const replay = callWithoutMutation(replayInput, reconcileChildTerminal);
    assert.deepStrictEqual(
      {
        status: replay.status,
        reason: replay.reason,
        fingerprint: replay.fingerprint,
        replayed: replay.replayed,
        emitTerminalEvent: replay.emitTerminalEvent,
      },
      {
        status: "ready",
        reason: "terminal_replayed",
        fingerprint: first.fingerprint,
        replayed: true,
        emitTerminalEvent: false,
      },
    );
  });
});

describe("child cancellation planner policy", () => {
  it("uses an inclusive deadline boundary and gives explicit cancellation trigger precedence", () => {
    const beforeInput = cancellationInput({ now_ms: 999, deadline_ms: 1_000 });
    const before = callWithoutMutation(beforeInput, planChildCancellation);
    assert.deepStrictEqual(before, { status: "not_proposed", reason: "cancellation_not_requested" });

    const boundaryInput = cancellationInput({ now_ms: 1_000, deadline_ms: 1_000 });
    const boundary = callWithoutMutation(boundaryInput, planChildCancellation);
    assert.equal(boundary.status, "proposed");
    if (boundary.status !== "proposed") assert.fail("deadline boundary must propose cancellation");
    assert.equal(boundary.proposal.trigger, "deadline_expired");
    assert.deepStrictEqual(boundary.proposal.identity, identity());

    const explicitBeforeInput = cancellationInput({ cancellation_requested: true, now_ms: 0, deadline_ms: 1_000 });
    const explicitBefore = callWithoutMutation(explicitBeforeInput, planChildCancellation);
    assert.equal(explicitBefore.status, "proposed");
    if (explicitBefore.status !== "proposed") assert.fail("explicit cancellation must not await the deadline");
    assert.equal(explicitBefore.proposal.trigger, "explicit_cancellation");

    const explicitAtBoundaryInput = cancellationInput({ cancellation_requested: true, now_ms: 1_000, deadline_ms: 1_000 });
    const explicitAtBoundary = callWithoutMutation(explicitAtBoundaryInput, planChildCancellation);
    assert.equal(explicitAtBoundary.status, "proposed");
    if (explicitAtBoundary.status !== "proposed") assert.fail("explicit cancellation must propose at the boundary");
    assert.equal(explicitAtBoundary.proposal.trigger, "explicit_cancellation");
  });

  it("waits for a closed artifact window and known unsatisfied terminal evidence", () => {
    const cases = [
      {
        evidence: evidence({ terminal: "unsatisfied", artifact_window_closed: "unsatisfied" }),
        reason: "artifact_window_open",
      },
      {
        evidence: evidence({ terminal: "unsatisfied", artifact_window_closed: "unknown" }),
        reason: "artifact_window_unknown",
      },
      {
        evidence: evidence({ terminal: "unknown", artifact_window_closed: "satisfied" }),
        reason: "terminal_unknown",
      },
      {
        evidence: evidence({ terminal: "satisfied", artifact_window_closed: "satisfied" }),
        reason: "terminal_already_observed",
      },
    ] as const;

    for (const testCase of cases) {
      const input = cancellationInput({ evidence: testCase.evidence, cancellation_requested: true });
      const result = callWithoutMutation(input, planChildCancellation);
      assert.deepStrictEqual(result, { status: "not_proposed", reason: testCase.reason });
    }
  });

  it("suppresses only an exact eight-field prior stop identity", () => {
    const current = identity();
    const exactInput = cancellationInput({
      current,
      observation: { identity: { ...current }, disposition: "continue" },
      cancellation_requested: true,
      prior_stop_requests: [{ ...current }],
    });
    const exact = callWithoutMutation(exactInput, planChildCancellation);
    assert.deepStrictEqual(exact, { status: "not_proposed", reason: "stop_already_requested" });

    const fields = [
      "run_id",
      "unit_id",
      "attempt_id",
      "predecessor_attempt_id",
      "candidate_id",
      "route_id",
      "child_id",
      "call_id",
    ] as const;
    for (const field of fields) {
      const nearMatch = { ...current, [field]: `${current[field] ?? "none"}-other` };
      const input = cancellationInput({
        current,
        observation: { identity: { ...current }, disposition: "continue" },
        cancellation_requested: true,
        prior_stop_requests: [nearMatch],
      });
      const result = callWithoutMutation(input, planChildCancellation);
      assert.equal(result.status, "proposed", `${field} mismatch must not suppress this identity's stop proposal`);
    }
  });

  it("rejects invalid caller-supplied times without reading or depending on a clock", () => {
    const invalidTimes = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const invalidTime of invalidTimes) {
      for (const field of ["deadline_ms", "now_ms"] as const) {
        const input = cancellationInput({ [field]: invalidTime });
        const result = callWithoutMutation(input, planChildCancellation);
        assert.deepStrictEqual(result, { status: "rejected", reason: "invalid_time" });
      }
    }
  });

  it("returns an inert proposal while leaving process stop, release, and terminal persistence to runtime", () => {
    const input = cancellationInput({ cancellation_requested: true });
    const result = callWithoutMutation(input, planChildCancellation);
    assert.equal(result.status, "proposed");
    if (result.status !== "proposed") assert.fail("explicit cancellation must create an inert proposal");
    assert.deepStrictEqual(result.proposal.runtime_responsibilities, {
      persist_stop_request_for_idempotency: true,
      stop_normal_process_tree: true,
      verify_actual_cancellation_and_no_leaks: true,
    });

    // This pure API does not stop a process, release resources, or persist a terminal event.
    // Those effects remain runtime responsibilities; the assertion covers only its inert proposal.
    assert.deepStrictEqual(result.proposal.identity, input.current);
    assert.notStrictEqual(result.proposal.identity, input.current);
  });
});
