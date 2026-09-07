import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  summarizeExperienceEvidence,
  type ExperienceRunObservation,
} from "../dist/core/experience-evidence-summary.js";
import {
  selectExperienceRoute,
  type ExperienceRoute,
  type ExperienceRoutePolicyTable,
} from "../dist/core/experience-route-policy.js";

const identity = Object.freeze({
  package: "sortie-dogs@0.8.5-corpus",
  fixture: "experience-router-fixed-corpus",
  validation: "synthetic-complete-run",
  cache: "fixed",
  price_basis: "synthetic-unit-price",
  denominator: "complete-run",
});

const policy: ExperienceRoutePolicyTable = Object.freeze({
  version: "v0.8.5-fixed-corpus",
  evidence_window: "fixed-window",
  minimum_samples: 3,
  duration_threshold: 0.8,
  cost_threshold: 0.8,
  rows: Object.freeze([
    Object.freeze({
      shape: "eligible-shape",
      baseline_route: "sol-serial",
      policy_route: "luna-fabric",
    }),
  ]),
});

function observation(
  run_id: string,
  route: ExperienceRoute,
  duration_ms: number,
  estimated_cost_amount: number,
  shape = "eligible-shape",
): ExperienceRunObservation {
  return {
    run_id,
    completed: true,
    shape,
    route,
    evidence_window: policy.evidence_window,
    identity,
    duration_ms,
    estimated_cost_amount,
  };
}

function corpus(
  candidateDurations = [70, 80, 90],
  candidateCosts = [7, 8, 9],
  samples = 3,
): readonly ExperienceRunObservation[] {
  const baselineDurations = [90, 100, 110];
  const baselineCosts = [9, 10, 11];
  return [
    ...baselineDurations.slice(0, samples).map((duration, index) =>
      observation(`baseline-${index}`, "sol-serial", duration, baselineCosts[index])),
    ...candidateDurations.slice(0, samples).map((duration, index) =>
      observation(`candidate-${index}`, "luna-fabric", duration, candidateCosts[index])),
  ];
}

function summarizeAndSelect(
  observations: readonly ExperienceRunObservation[],
  shape = "eligible-shape",
) {
  const summary = summarizeExperienceEvidence({ observations });
  assert.equal(summary.status, "summarized");
  if (summary.status !== "summarized") assert.fail("fixed corpus must summarize");
  return {
    summary,
    selection: selectExperienceRoute({
      shape,
      caller_heuristic_route: "sol-serial",
      policy,
      evidence: summary.evidence,
    }),
  };
}

describe("experience router fixed-corpus replay", () => {
  it("connects median evidence to a proposal when duration and cost meet both thresholds", () => {
    const first = summarizeAndSelect(corpus());
    const replay = summarizeAndSelect(corpus());

    assert.deepStrictEqual(replay, first, "identical fixed input must replay identically");
    assert.deepStrictEqual(
      first.summary.evidence.map(({ route, samples, duration, cost }) => ({
        route,
        samples,
        duration: duration.milliseconds,
        cost: cost.amount,
      })),
      [
        { route: "sol-serial", samples: 3, duration: 100, cost: 10 },
        { route: "luna-fabric", samples: 3, duration: 80, cost: 8 },
      ],
    );
    assert.equal(first.selection.status, "proposed");
    assert.equal(first.selection.route, "luna-fabric");
    assert.equal(first.selection.reason, "matched-evidence-within-thresholds");
    assert.equal(first.selection.authority.execution, "not-performed");
  });

  it("falls back when either the duration or cost threshold is not met", () => {
    const cases = [
      corpus([80, 81, 82], [7, 8, 9]),
      corpus([70, 80, 90], [8, 9, 10]),
    ];

    for (const observations of cases) {
      const { selection } = summarizeAndSelect(observations);
      assert.equal(selection.status, "fallback");
      assert.equal(selection.route, "sol-serial");
      assert.equal(selection.reason, "threshold-not-met");
    }
  });

  it("uses typed fallbacks for an unseen shape and sparse summarized evidence", () => {
    const unseen = summarizeAndSelect(corpus(), "unknown-shape").selection;
    assert.equal(unseen.status, "fallback");
    assert.equal(unseen.route, "sol-serial");
    assert.equal(unseen.reason, "shape-unseen");

    const sparse = summarizeAndSelect(corpus(undefined, undefined, 2)).selection;
    assert.equal(sparse.status, "fallback");
    assert.equal(sparse.route, "sol-serial");
    assert.equal(sparse.reason, "sparse-evidence");
  });

  it("records changed choices only when both matched medians pass and otherwise retains the Terra baseline", () => {
    const replayCases = [
      { name: "both-improve", observations: corpus(), expected: "luna-fabric", changed: true },
      { name: "duration-regresses", observations: corpus([81, 82, 83], [7, 8, 9]), expected: "sol-serial", changed: false },
      { name: "cost-regresses", observations: corpus([70, 80, 90], [9, 10, 11]), expected: "sol-serial", changed: false },
      { name: "sparse", observations: corpus(undefined, undefined, 2), expected: "sol-serial", changed: false },
    ] as const;
    for (const replayCase of replayCases) {
      const { summary, selection } = summarizeAndSelect(replayCase.observations);
      assert.equal(selection.route, replayCase.expected, replayCase.name);
      const byRoute = new Map(summary.evidence.map((entry) => [entry.route, entry]));
      if (replayCase.changed) {
        const baseline = byRoute.get("sol-serial")!;
        const candidate = byRoute.get("luna-fabric")!;
        assert.ok(candidate.duration.milliseconds <= baseline.duration.milliseconds * policy.duration_threshold);
        assert.ok(candidate.cost.amount <= baseline.cost.amount * policy.cost_threshold);
      } else {
        assert.equal(selection.route, "sol-serial", `${replayCase.name} must retain recorded Terra choice`);
      }
    }
  });
});
