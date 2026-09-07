import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EvidenceCapsuleStore } from "../dist/core/evidence-capsule.js";
import {
  appendRunFlightLedgerEvents,
  createRunFlightPlanPrefix,
  RunFlightLedger,
  type FlightObservation,
  type RunFlightEvent,
  type RunFlightEventRecord,
} from "../dist/core/run-flight-ledger.js";
import { selectWaveBoundaryReplay, WaveBoundaryReplayError } from "../dist/core/wave-boundary-replay.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const root = fileURLToPath(new URL(`../_testenv/replay-${process.pid}/`, import.meta.url));
const at = "2026-09-06T08:00:00Z";
const observation = (stage: FlightObservation["stage"]): FlightObservation => ({
  stage,
  duration_ms: null,
  usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
  estimated_cost: { usd: null, provenance: "unknown" },
});
const event = <T extends RunFlightEvent>(value: T): T => value;

function fabricRecords(): readonly RunFlightEventRecord[] {
  const planId = digest("a");
  const bindingId = digest("b");
  const c0 = "0".repeat(40);
  const c1 = "1".repeat(40);
  const c2 = "2".repeat(40);
  const scheduler0 = { wave: 1, base_sha: c0, pending: ["a", "b"], completed: [],
    active: { number: 1, base_sha: c0, unit_ids: ["a"], lanes: { a: 0 } }, lane_affinity: {} };
  const scheduler1 = { wave: 2, base_sha: c1, pending: ["b"], completed: ["a"],
    active: { number: 2, base_sha: c1, unit_ids: ["b"], lanes: { b: 0 } }, lane_affinity: {} };
  const scheduler2 = { wave: 2, base_sha: c2, pending: [], completed: ["a", "b"], active: null, lane_affinity: {} };
  const artifact = (unit_id: string, commit_sha: string) => ({ unit_id, commit_sha,
    change_fingerprint: "d".repeat(64), validation_fingerprint: "e".repeat(64) });
  return appendRunFlightLedgerEvents(createRunFlightPlanPrefix({
    kind: "plan.compiled", at, plan_id: planId, proposal_id: digest("c"), decision: "accepted", gap_codes: [],
  }), [{
    kind: "fabric.wave.accepted", at, plan_id: planId, plan_binding_id: bindingId, wave_index: 1,
    from_candidate_id: c0, candidate_id: c1, artifacts: [artifact("a", "a".repeat(40))],
    scheduler_before: scheduler0, scheduler_after: scheduler1,
    candidate_snapshot: { authority_sha: c0, target_branch: "main", candidate_ref: "refs/candidate/run",
      candidate_head: c1, wave_heads: [c1] },
  }, {
    kind: "fabric.wave.accepted", at, plan_id: planId, plan_binding_id: bindingId, wave_index: 2,
    from_candidate_id: c1, candidate_id: c2, artifacts: [artifact("b", "b".repeat(40))],
    scheduler_before: scheduler1, scheduler_after: scheduler2,
    candidate_snapshot: { authority_sha: c0, target_branch: "main", candidate_ref: "refs/candidate/run",
      candidate_head: c2, wave_heads: [c1, c2] },
  }]);
}

test.before(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(name: string): Promise<RunFlightLedger> {
  const store = new EvidenceCapsuleStore(path.join(root, name, "capsules"));
  return RunFlightLedger.open(path.join(root, name, "ledger.json"), {
    store,
    declared_capsule_ids: [],
    authorized_source_paths: [],
  });
}

async function appendWave(
  ledger: RunFlightLedger,
  suffix: string,
  index: number,
  candidate: string,
  produced: string,
  recoveryCharge = false,
): Promise<void> {
  await ledger.append(event({
    kind: "route.selected", at, route_id: `route-${suffix}`, candidate_id: candidate,
    role: recoveryCharge ? "rescue" : "implementation", model: `model-${suffix}`, variant: null,
    reason: recoveryCharge ? "model_rescue" : "implementation",
  }));
  await ledger.append(event({ kind: "wave.opened", at, wave_id: `wave-${suffix}`, wave_index: index, candidate_id: candidate }));
  await ledger.append(event({
    kind: "unit.opened", at, unit_id: `unit-${suffix}`, wave_id: `wave-${suffix}`, candidate_id: candidate,
    references: { capsule_ids: [], artifact_ids: [] },
  }));
  await ledger.append(event({
    kind: "attempt.started", at, attempt_id: `attempt-${suffix}`, predecessor_attempt_id: null,
    unit_id: `unit-${suffix}`, candidate_id: candidate, route_id: `route-${suffix}`,
    role: recoveryCharge ? "rescue" : "implementation", selected_model: `model-${suffix}`,
    selected_variant: null, child_id: null, call_id: `call-${suffix}`,
    resource_budget_request: { time_ms: 50, cost_usd: 0.5 },
    budget_charge: {
      kind: recoveryCharge ? "model_rescue" : "implementation",
      recovery_actions: recoveryCharge ? 1 : 0,
      probe_iterations: 0,
      model_attempts: recoveryCharge ? 1 : 0,
    },
  }));
  await ledger.append(event({
    kind: "attempt.finished", at, attempt_id: `attempt-${suffix}`, observed_model: `model-${suffix}`,
    observed_variant: null, failure: null, disposition: "succeeded", observation: {
      ...observation("unit"), duration_ms: index * 10,
      estimated_cost: { usd: index / 8, provenance: "calculated" },
    },
    references: { capsule_ids: [], artifact_ids: [] },
  }));
  await ledger.append(event({ kind: "unit.completed", at, unit_id: `unit-${suffix}`, disposition: "succeeded" }));
  await ledger.append(event({
    kind: "wave.completed", at, wave_id: `wave-${suffix}`, produced_candidate_id: produced,
    artifact_id: digest(index === 1 ? "1" : "2"),
  }));
  await ledger.append(event({
    kind: "candidate.advanced", at, from_candidate_id: candidate, candidate_id: produced,
    wave_id: `wave-${suffix}`, artifact_id: digest(index === 1 ? "1" : "2"),
  }));
}

async function completedTwoWaveLedger(name: string): Promise<readonly RunFlightEventRecord[]> {
  const ledger = await fixture(name);
  await ledger.append(event({
    kind: "run.planned", at, run_id: `run-${name}`, initial_candidate_id: "candidate-0",
    budget_limits: { recovery_actions: 3, probe_iterations: 2, model_attempts: 2 },
    resource_budget_limits: { time_ms: 100, cost_usd: 1 },
  }));
  await appendWave(ledger, "1", 1, "candidate-0", "candidate-1");
  await appendWave(ledger, "2", 2, "candidate-1", "candidate-2", true);
  await ledger.append(event({
    kind: "candidate.completed", at, candidate_id: "candidate-2",
    references: { capsule_ids: [], artifact_ids: [digest("2")] },
  }));
  return (await ledger.read()).records;
}

function expectReplayError(action: () => unknown, code: WaveBoundaryReplayError["code"], ledgerCode: string | null): void {
  assert.throws(action, (error: unknown) => error instanceof WaveBoundaryReplayError &&
    error.code === code && error.ledger_code === ledgerCode);
}

test("reconstructs the latest real-ledger wave boundary without changing its input", async () => {
  const records = await completedTwoWaveLedger("latest");
  const before = structuredClone(records);
  const boundaries = records.filter(({ event: entry }) => entry.kind === "candidate.advanced");

  const selected = selectWaveBoundaryReplay(records);

  assert.equal(selected.reason, "latest_accepted_boundary");
  assert.deepEqual(selected.boundary, {
    sequence: boundaries[1].sequence,
    event_hash: boundaries[1].event_hash,
    from_candidate_id: "candidate-1",
    candidate_id: "candidate-2",
    wave_id: "wave-2",
    artifact_id: digest("2"),
  });
  assert.equal(selected.prefix.length, boundaries[1].sequence);
  assert.equal(selected.prefix.at(-1)?.event_hash, boundaries[1].event_hash);
  assert.equal(selected.state.current_candidate_id, "candidate-2");
  assert.equal(selected.state.completed_wave_count, 2);
  assert.deepEqual(selected.recovery_budget, {
    budget_consumed: { recovery_actions: 1, probe_iterations: 0, model_attempts: 1 },
    budget_limits: { recovery_actions: 3, probe_iterations: 2, model_attempts: 2 },
    resource_budget_limits: { time_ms: 100, cost_usd: 1 },
    resource_budget_consumed: { time_ms: 30, cost_usd: 0.375 },
    resource_budget_reserved: { time_ms: 0, cost_usd: 0 },
    validated_event_count: records.length,
    validated_tail_hash: records.at(-1)?.event_hash,
  });
  assert.deepEqual(records, before);

  (selected.prefix[0].event as { at: string }).at = "2099-01-01T00:00:00Z";
  assert.deepEqual(records, before);
  assert.equal(selectWaveBoundaryReplay(records).prefix[0].event.at, at);
});

test("selects an explicit historical boundary while retaining full-ledger recovery consumption", async () => {
  const records = await completedTwoWaveLedger("override");
  const firstBoundary = records.find(({ event: entry }) => entry.kind === "candidate.advanced");
  assert.ok(firstBoundary);

  const selected = selectWaveBoundaryReplay(records, { boundary_event_hash: firstBoundary.event_hash });

  assert.equal(selected.reason, "diagnostic_override");
  assert.equal(selected.boundary.event_hash, firstBoundary.event_hash);
  assert.equal(selected.prefix.length, firstBoundary.sequence);
  assert.equal(selected.state.current_candidate_id, "candidate-1");
  assert.equal(selected.state.completed_wave_count, 1);
  assert.deepEqual(selected.state.budget_consumed, { recovery_actions: 0, probe_iterations: 0, model_attempts: 0 });
  assert.deepEqual(selected.recovery_budget.budget_consumed, { recovery_actions: 1, probe_iterations: 0, model_attempts: 1 });
  assert.deepEqual(selected.state.resource_budget_consumed, { time_ms: 10, cost_usd: 0.125 });
  assert.deepEqual(selected.recovery_budget.resource_budget_consumed, { time_ms: 30, cost_usd: 0.375 });
  assert.deepEqual(selected.recovery_budget.resource_budget_limits, { time_ms: 100, cost_usd: 1 });
  assert.equal(selected.recovery_budget.validated_event_count, records.length);
  assert.equal(selected.recovery_budget.validated_tail_hash, records.at(-1)?.event_hash);
});

test("selects typed accepted fabric boundaries without inventing unavailable budgets", () => {
  const records = fabricRecords();
  const boundaries = records.filter(({ event: entry }) => entry.kind === "fabric.wave.accepted");
  const automatic = selectWaveBoundaryReplay(records);
  assert.equal(automatic.reason, "latest_accepted_boundary");
  assert.equal("event_kind" in automatic.boundary && automatic.boundary.event_kind, "fabric.wave.accepted");
  if (!("event_kind" in automatic.boundary)) return;
  assert.equal(automatic.boundary.plan_id, digest("a"));
  assert.equal(automatic.boundary.plan_binding_id, digest("b"));
  assert.equal(automatic.boundary.wave_index, 2);
  assert.deepEqual(automatic.boundary.artifacts.map(({ unit_id }) => unit_id), ["b"]);
  assert.equal(automatic.boundary.candidate_snapshot.candidate_head, "2".repeat(40));
  assert.equal(automatic.state.current_candidate_id, "2".repeat(40));
  assert.equal(automatic.recovery_budget.budget_limits, null);
  assert.deepEqual(automatic.recovery_budget.resource_budget_consumed, { time_ms: 0, cost_usd: 0 });

  const diagnostic = selectWaveBoundaryReplay(records, { boundary_event_hash: boundaries[0]!.event_hash });
  assert.equal(diagnostic.reason, "diagnostic_override");
  assert.equal(diagnostic.boundary.event_hash, boundaries[0]!.event_hash);
  assert.equal(diagnostic.state.current_candidate_id, "1".repeat(40));
  assert.equal(diagnostic.recovery_budget.validated_tail_hash, records.at(-1)!.event_hash);
});

test("rejects absent boundaries, invalid overrides, and unknown canonical overrides", async () => {
  const ledger = await fixture("no-boundary");
  await ledger.append(event({
    kind: "run.planned", at, run_id: "run-no-boundary", initial_candidate_id: "candidate-0",
    budget_limits: { recovery_actions: 1, probe_iterations: 1, model_attempts: 1 },
  }));
  const records = (await ledger.read()).records;

  expectReplayError(() => selectWaveBoundaryReplay(records), "boundary_missing", null);
  expectReplayError(() => selectWaveBoundaryReplay(records, { boundary_event_hash: "not-a-hash" }), "invalid_override", null);
  expectReplayError(() => selectWaveBoundaryReplay(records, { unexpected: true }), "invalid_override", null);

  const completed = await completedTwoWaveLedger("unknown-override");
  expectReplayError(
    () => selectWaveBoundaryReplay(completed, { boundary_event_hash: digest("9") }),
    "unknown_override",
    null,
  );
});

test("rejects missing, duplicate, reordered, and hash-conflicting tails before historical replay", async () => {
  const records = await completedTwoWaveLedger("invalid-tail");
  const firstBoundary = records.find(({ event: entry }) => entry.kind === "candidate.advanced");
  assert.ok(firstBoundary);
  const replay = (candidate: readonly RunFlightEventRecord[]) => selectWaveBoundaryReplay(candidate, {
    boundary_event_hash: firstBoundary.event_hash,
  });

  const missing = structuredClone(records);
  missing.splice(firstBoundary.sequence + 1, 1);
  expectReplayError(() => replay(missing), "invalid_ledger", "sequence");

  const duplicate = structuredClone(records);
  duplicate.push(structuredClone(duplicate.at(-1)!));
  expectReplayError(() => replay(duplicate), "invalid_ledger", "sequence");

  const reordered = structuredClone(records);
  [reordered[reordered.length - 2], reordered[reordered.length - 1]] =
    [reordered[reordered.length - 1], reordered[reordered.length - 2]];
  expectReplayError(() => replay(reordered), "invalid_ledger", "sequence");

  const modified = structuredClone(records);
  const tail = modified.at(-1)!;
  assert.equal(tail.event.kind, "candidate.completed");
  if (tail.event.kind === "candidate.completed") {
    (tail.event as { candidate_id: string }).candidate_id = "candidate-tampered";
  }
  expectReplayError(() => replay(modified), "invalid_ledger", "conflict");
});
