import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  criticalPathTakeoverTrigger,
  proposeCriticalPathTakeover,
  type CriticalPathInput,
  type CriticalPathUnitObservation,
} from "../dist/core/critical-path.js";

function unit(
  unit_id: string,
  overrides: Partial<CriticalPathUnitObservation> = {},
): CriticalPathUnitObservation {
  return {
    unit_id,
    depends_on: [],
    state: "completed",
    executor: "other",
    deadline: "within_deadline",
    failures: "not_repeated",
    ...overrides,
  };
}

function input(
  units: readonly CriticalPathUnitObservation[],
  active_takeover_count = 0,
): CriticalPathInput {
  return { units, active_takeover_count };
}

function evaluateWithoutMutation(value: unknown) {
  const before = structuredClone(value);
  const result = proposeCriticalPathTakeover(value);
  assert.deepStrictEqual(value, before, "critical-path evaluation must not mutate caller input");
  return result;
}

function activeLuna(
  unit_id: string,
  overrides: Partial<CriticalPathUnitObservation> = {},
): CriticalPathUnitObservation {
  return unit(unit_id, {
    state: "active",
    executor: "luna",
    deadline: "deadline_exceeded",
    ...overrides,
  });
}

describe("critical-path takeover proposal", () => {
  it("rejects malformed graphs before suppressing an existing takeover", () => {
    const cases = [
      {
        value: input([unit("duplicate"), unit("duplicate")], 1),
        expected: { status: "rejected", code: "duplicate-unit", unit_id: "duplicate" },
      },
      {
        value: input([unit("unknown", { depends_on: ["missing"] })], 1),
        expected: { status: "rejected", code: "unknown-dependency", unit_id: "unknown" },
      },
      {
        value: input([
          unit("cycle-a", { depends_on: ["cycle-b"] }),
          unit("cycle-b", { depends_on: ["cycle-a"] }),
        ], 1),
        expected: { status: "rejected", code: "cycle", unit_id: null },
      },
      {
        value: input([
          unit("unfinished", { state: "pending" }),
          activeLuna("invalid-active", { depends_on: ["unfinished"] }),
        ], 1),
        expected: { status: "rejected", code: "invalid-state", unit_id: "invalid-active" },
      },
      {
        value: input([unit("duplicate-dependency", { depends_on: ["root", "root"] }), unit("root")]),
        expected: { status: "rejected", code: "invalid-state", unit_id: "duplicate-dependency" },
      },
    ] as const;

    for (const testCase of cases) {
      assert.deepStrictEqual(evaluateWithoutMutation(testCase.value), testCase.expected);
    }

    assert.deepStrictEqual(
      evaluateWithoutMutation(input([activeLuna("otherwise-eligible")], 1)),
      { status: "none", reason: "active-takeover" },
    );
    assert.deepStrictEqual(
      evaluateWithoutMutation(input([activeLuna("invalid-count")], 2)),
      { status: "rejected", code: "invalid-state", unit_id: null },
    );
  });

  it("considers only active Luna units with an observed deadline overrun or repeated failure", () => {
    const ineligible = [
      activeLuna("pending", { state: "pending" }),
      activeLuna("other", { executor: "other" }),
      activeLuna("healthy", { deadline: "within_deadline", failures: "not_repeated" }),
      activeLuna("unknown", { deadline: "unknown", failures: "unknown" }),
      activeLuna("completed", { state: "completed" }),
      activeLuna("cancelled", { state: "cancelled" }),
    ];
    for (const candidate of ineligible) {
      assert.deepStrictEqual(
        evaluateWithoutMutation(input([candidate])),
        { status: "none", reason: "no-conservative-blocker" },
        `${candidate.unit_id} must not qualify`,
      );
    }

    const deadline = evaluateWithoutMutation(input([activeLuna("deadline")]));
    assert.equal(deadline.status, "proposed");
    if (deadline.status !== "proposed") assert.fail("deadline observation must qualify");
    assert.equal(deadline.reason, "deadline_exceeded");

    const repeated = evaluateWithoutMutation(input([
      activeLuna("repeated", { deadline: "within_deadline", failures: "repeated" }),
    ]));
    assert.equal(repeated.status, "proposed");
    if (repeated.status !== "proposed") assert.fail("repeated failure observation must qualify");
    assert.equal(repeated.reason, "repeated_failure");
  });

  it("requires a sole unfinished direct dependency on a path that reaches completion", () => {
    const eligible = input([
      activeLuna("blocker"),
      unit("done"),
      unit("join", { depends_on: ["blocker", "done"], state: "pending" }),
      unit("completion-leaf", { depends_on: ["join"], state: "pending" }),
    ]);
    const proposed = evaluateWithoutMutation(eligible);
    assert.equal(proposed.status, "proposed");
    if (proposed.status !== "proposed") assert.fail("sole live dependency must qualify");
    assert.equal(proposed.unit_id, "blocker");
    assert.equal(proposed.structural_basis, "sole-unfinished-direct-dependency-with-completion-reachability");

    const competingDependency = input([
      activeLuna("blocker"),
      unit("also-unfinished", { state: "pending" }),
      unit("join", { depends_on: ["blocker", "also-unfinished"], state: "pending" }),
    ]);
    assert.deepStrictEqual(
      evaluateWithoutMutation(competingDependency),
      { status: "none", reason: "no-conservative-blocker" },
    );

    const disconnectedFromCompletion = input([
      activeLuna("blocker"),
      unit("join", { depends_on: ["blocker"], state: "pending" }),
      unit("cancelled-tail", { depends_on: ["join"], state: "cancelled" }),
    ]);
    assert.deepStrictEqual(
      evaluateWithoutMutation(disconnectedFromCompletion),
      { status: "none", reason: "no-conservative-blocker" },
    );
  });

  it("excludes a candidate when its relevant dependency set contains a cancelled unit", () => {
    const direct = input([
      activeLuna("blocker"),
      unit("cancelled-peer", { state: "cancelled" }),
      unit("join", { depends_on: ["blocker", "cancelled-peer"], state: "pending" }),
    ]);
    assert.deepStrictEqual(
      evaluateWithoutMutation(direct),
      { status: "none", reason: "no-conservative-blocker" },
    );

    const virtualSink = input([
      activeLuna("blocker"),
      unit("cancelled-leaf", { state: "cancelled" }),
    ]);
    assert.deepStrictEqual(
      evaluateWithoutMutation(virtualSink),
      { status: "none", reason: "no-conservative-blocker" },
    );
  });

  it("selects the lexically first eligible unit independent of input order", () => {
    const graph = [
      activeLuna("z-blocker"),
      unit("z-tail", { depends_on: ["z-blocker"], state: "pending" }),
      activeLuna("a-blocker", { deadline: "within_deadline", failures: "repeated" }),
      unit("a-tail", { depends_on: ["a-blocker"], state: "pending" }),
    ];
    for (const units of [graph, [...graph].reverse(), [graph[2], graph[0], graph[3], graph[1]]]) {
      const result = evaluateWithoutMutation(input(units));
      assert.equal(result.status, "proposed");
      if (result.status !== "proposed") assert.fail("both branches contain an eligible blocker");
      assert.equal(result.unit_id, "a-blocker");
      assert.equal(result.reason, "repeated_failure");
    }
  });

  it("returns inert runtime obligations without claiming any obligation is complete", () => {
    const result = evaluateWithoutMutation(input([activeLuna("candidate")]));
    assert.deepStrictEqual(result, {
      status: "proposed",
      unit_id: "candidate",
      reason: "deadline_exceeded",
      structural_basis: "sole-unfinished-direct-dependency-with-completion-reachability",
      runtime_obligations: [
        "accepted-base",
        "same-contract",
        "source-stopped",
        "exclusive-writer",
        "final-validation",
        "final-review",
        "candidate-cas",
      ],
    });
    assert.deepStrictEqual(Object.keys(result).sort(), [
      "reason",
      "runtime_obligations",
      "status",
      "structural_basis",
      "unit_id",
    ]);
    // This pure decision API neither stops execution nor performs takeover, writer exclusion,
    // validation, review, or CAS. It returns names of obligations for runtime enforcement only.
    if (result.status === "proposed") assert.equal(Object.isFrozen(result.runtime_obligations), true);
  });

  it("maps policy reasons to typed live triggers without using terminal rescue", () => {
    const deadline = proposeCriticalPathTakeover(input([activeLuna("deadline")]));
    assert.equal(deadline.status, "proposed");
    if (deadline.status === "proposed") assert.equal(criticalPathTakeoverTrigger(deadline), "live_deadline_exceeded");
    const repeated = proposeCriticalPathTakeover(input([
      activeLuna("repeated", { deadline: "within_deadline", failures: "repeated" }),
    ]));
    assert.equal(repeated.status, "proposed");
    if (repeated.status === "proposed") assert.equal(criticalPathTakeoverTrigger(repeated), "live_repeated_failure");
  });
});
