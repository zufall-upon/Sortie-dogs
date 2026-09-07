import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveExperienceRouting } from "../dist/core/experience-routing-runtime.js";
import { writeExperienceRoutingFixture } from "./fixtures/experience-router/run-experience-router-rpt.mjs";

const root = fileURLToPath(new URL(`../_testenv/experience-routing-runtime-${process.pid}/`, import.meta.url));

describe("experience routing runtime", () => {
  it("replays hash-bound ledger outcomes and selects Sol only when both medians do not regress", async () => {
    const directory = join(root, "matched");
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const fixture = await writeExperienceRoutingFixture(directory);

    const first = await resolveExperienceRouting(directory, fixture.admission);
    const replay = await resolveExperienceRouting(directory, fixture.admission);
    assert.deepStrictEqual(replay, first);
    assert.equal(first.route, "sol-serial");
    assert.equal(first.trace.fallback_reason, null);
    assert.equal(first.trace.evidence_refs.length, 6);
    assert.equal(first.trace.aggregates.length, 2);
    assert.deepEqual(first.trace.aggregates.map(({ route, runs }) => ({
      route,
      durations: runs.map((run) => run.wall_clock_duration_ms),
      costs: runs.map((run) => run.total_cost_per_accepted_completion),
    })), [
      { route: "sol-serial", durations: [70, 80, 90], costs: [7, 8, 9] },
      { route: "luna-fabric", durations: [100, 110, 120], costs: [10, 11, 12] },
    ]);
    assert.ok(first.trace.aggregates.every(({ recovery }) => recovery.status === "aggregated"));
    assert.ok(first.trace.aggregates.flatMap(({ runs }) => runs)
      .every((run) => run.attempts.every((attempt) => attempt.actual_target.model === "actual-primary")));
  });

  it("retains Luna for sparse, unknown-cost, and one-metric regression evidence", async () => {
    const cases = [
      { name: "sparse", options: { baselineDurations: [100, 110], baselineCosts: [10, 11],
        candidateDurations: [70, 80], candidateCosts: [7, 8] }, reason: "sparse-evidence" },
      { name: "unknown-cost", options: { candidateRunOptions: [{ unknownCost: true }, {}, {}] },
        reason: "sparse-evidence" },
      { name: "cost-regression", options: { candidateCosts: [12, 13, 14] }, reason: "threshold-not-met" },
    ];
    for (const value of cases) {
      const directory = join(root, value.name);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      const fixture = await writeExperienceRoutingFixture(directory, value.options);
      const decision = await resolveExperienceRouting(directory, fixture.admission);
      assert.equal(decision.route, "luna-fabric");
      assert.equal(decision.trace.fallback_reason, value.reason);
    }
  });

  it("keeps infrastructure failures inspectable but excludes them from matched evidence", async () => {
    const directory = join(root, "infra");
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const fixture = await writeExperienceRoutingFixture(directory, {
      candidateRunOptions: [{ failureCategory: "infrastructure" }, {}, {}],
    });
    const decision = await resolveExperienceRouting(directory, fixture.admission);
    assert.equal(decision.route, "luna-fabric");
    assert.equal(decision.trace.fallback_reason, "sparse-evidence");
    const excluded = decision.trace.aggregates.flatMap(({ runs }) => runs)
      .find((run) => run.exclusion_reason?.startsWith("infrastructure-exclusion:"));
    assert.ok(excluded);
    assert.equal(excluded.intervention_count, 1);
    assert.equal(excluded.attempts.length, 2);
    assert.equal(excluded.attempts[0].failure_category, "infrastructure");
    assert.equal(excluded.attempts[1].actual_target.model, "actual-remediation");
  });

  it("does not infer live Luna deadline takeover from an ordinary completion", async () => {
    const directory = join(root, "escalation-unproven");
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const fixture = await writeExperienceRoutingFixture(directory, { candidateRoute: "luna-fabric-with-escalation" });
    const decision = await resolveExperienceRouting(directory, fixture.admission);
    assert.equal(decision.route, "luna-fabric");
    assert.equal(decision.trace.escalation_availability, "unproven-live-deadline-takeover");
    assert.notEqual(decision.trace.fallback_reason, null);
  });

  it("selects escalation only from matched live-deadline Luna-to-Sol takeover records", async () => {
    const directory = join(root, "escalation-available");
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const fixture = await writeExperienceRoutingFixture(directory, {
      candidateRoute: "luna-fabric-with-escalation",
      candidateRunOptions: [{ liveTakeover: true }, { liveTakeover: true }, { liveTakeover: true }],
    });
    const decision = await resolveExperienceRouting(directory, fixture.admission);
    assert.equal(decision.route, "luna-fabric-with-escalation");
    assert.equal(decision.escalation_enabled, true);
    assert.equal(decision.trace.fallback_reason, null);
    assert.equal(decision.trace.escalation_availability, "available");
    const takeoverRuns = decision.trace.aggregates.find(({ route }) => route === "luna-fabric-with-escalation")!.runs;
    assert.equal(takeoverRuns.length, 3);
    assert.ok(takeoverRuns.every((run) => run.live_deadline_takeover_proven));
  });
});
