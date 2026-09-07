import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { admitLunaFabric } from "../../../dist/core/luna-fabric-contract.js";
import {
  deriveExperienceTaskShape,
  EXPERIENCE_ROUTING_SCHEMA_VERSION,
  resolveExperienceRouting,
} from "../../../dist/core/experience-routing-runtime.js";
import {
  appendRunFlightLedgerEvents,
  createRunFlightLedgerInitialPrefix,
  RUN_FLIGHT_LEDGER_SCHEMA_VERSION,
} from "../../../dist/core/run-flight-ledger.js";

const digest = (character) => `sha256:${character.repeat(64)}`;
const at = (milliseconds) => new Date(Date.UTC(2026, 8, 7, 0, 0, 0, milliseconds)).toISOString();

export function experienceFabricContract() {
  const unit = (id, order) => ({
    unit_id: id,
    acceptance_items: [`accept-${id}`],
    scope_read: ["src/shared.ts"],
    scope_write: [`src/${id}.ts`],
    depends_on: [],
    validation: { level: "targeted", command: ["node", "--test", `test/${id}.test.ts`] },
    shared_path_keys: [],
    exclusive_resources: [],
    scheduler_order: order,
  });
  return {
    version: "0.8.0",
    provenance: {
      source: "dog-coordinator",
      acceptance_fingerprint: "a".repeat(64),
      target_branch: "main",
      target_sha: "b".repeat(40),
    },
    acceptance_items: ["accept-a", "accept-b"],
    effects: [],
    shared_paths: [],
    units: [unit("a", 0), unit("b", 1)],
  };
}

function completedLedger(runID, route, durationMs, cost, options = {}) {
  if (route === "luna-fabric-with-escalation" && options.liveTakeover === true) {
    return completedLiveTakeoverLedger(runID, durationMs, cost);
  }
  const candidate = `candidate-${runID}`;
  let records = createRunFlightLedgerInitialPrefix({
    run_planned: {
      kind: "run.planned", at: at(0), run_id: runID, initial_candidate_id: candidate,
      budget_limits: { recovery_actions: 2, probe_iterations: 1, model_attempts: 1 },
    },
    plan_compiled: {
      kind: "plan.compiled", at: at(0), plan_id: digest("a"), proposal_id: digest("b"),
      decision: "accepted", gap_codes: [],
    },
  });
  const attemptFailure = options.failureCategory === undefined ? null : {
    category: options.failureCategory,
    code: "synthetic-fixture-failure",
  };
  const firstDisposition = attemptFailure === null ? "succeeded" : "continue";
  const events = [
    { kind: "route.selected", at: at(1), route_id: route, candidate_id: candidate, role: "implementation",
      model: "declared-primary", variant: null, reason: "implementation" },
    { kind: "wave.opened", at: at(2), wave_id: `wave-${runID}`, wave_index: 1, candidate_id: candidate },
    { kind: "unit.opened", at: at(3), unit_id: `unit-${runID}`, wave_id: `wave-${runID}`,
      candidate_id: candidate, references: { capsule_ids: [], artifact_ids: [] } },
    { kind: "attempt.started", at: at(4), attempt_id: `attempt-${runID}-1`, predecessor_attempt_id: null,
      unit_id: `unit-${runID}`, candidate_id: candidate, route_id: route, role: "implementation",
      selected_model: "declared-primary", selected_variant: null, child_id: null, call_id: `call-${runID}-1`,
      budget_charge: { kind: "implementation", recovery_actions: 0, probe_iterations: 0, model_attempts: 0 } },
    { kind: "attempt.finished", at: at(5), attempt_id: `attempt-${runID}-1`, observed_model: "actual-primary",
      observed_variant: null, failure: attemptFailure, disposition: firstDisposition,
      observation: { stage: "unit", duration_ms: Math.max(1, durationMs - 10),
        usage: { input_tokens: 100, cache_read_tokens: 40, output_tokens: 20, provenance: "measured" },
        estimated_cost: options.unknownCost ? { usd: null, provenance: "unknown" } : { usd: cost, provenance: "calculated" } },
      references: { capsule_ids: [], artifact_ids: [digest("c")] } },
  ];
  if (attemptFailure !== null) {
    events.push(
      { kind: "recovery.recorded", at: at(6), recovery_id: `recovery-${runID}`,
        failed_attempt_id: `attempt-${runID}-1`, kind_detail: "normal_remediation", candidate_id: candidate },
      { kind: "attempt.started", at: at(7), attempt_id: `attempt-${runID}-2`,
        predecessor_attempt_id: `attempt-${runID}-1`, unit_id: `unit-${runID}`, candidate_id: candidate,
        route_id: route, role: "implementation", selected_model: "declared-remediation", selected_variant: "high",
        child_id: null, call_id: `call-${runID}-2`,
        budget_charge: { kind: "normal_remediation", recovery_actions: 1, probe_iterations: 0, model_attempts: 0 } },
      { kind: "attempt.finished", at: at(8), attempt_id: `attempt-${runID}-2`, observed_model: "actual-remediation",
        observed_variant: "high", failure: null, disposition: "succeeded",
        observation: { stage: "recovery", duration_ms: 1,
          usage: { input_tokens: 10, cache_read_tokens: 0, output_tokens: 2, provenance: "measured" },
          estimated_cost: options.unknownCost ? { usd: null, provenance: "unknown" } : { usd: 0, provenance: "calculated" } },
        references: { capsule_ids: [], artifact_ids: [digest("d")] } },
    );
  }
  events.push(
    { kind: "validation.recorded", at: at(9), validation_id: `validation-${runID}`, unit_id: `unit-${runID}`,
      command_fingerprint: digest("e"), result: "passed", artifact_id: digest("f") },
    { kind: "unit.completed", at: at(9), unit_id: `unit-${runID}`, disposition: "succeeded" },
    { kind: "wave.completed", at: at(9), wave_id: `wave-${runID}`, produced_candidate_id: `accepted-${runID}`,
      artifact_id: digest("1") },
    { kind: "candidate.advanced", at: at(9), from_candidate_id: candidate, candidate_id: `accepted-${runID}`,
      wave_id: `wave-${runID}`, artifact_id: digest("1") },
    { kind: "candidate.completed", at: at(9), candidate_id: `accepted-${runID}`,
      references: { capsule_ids: [], artifact_ids: [digest("1")] } },
    { kind: "cleanup.completed", at: at(9), run_id: runID,
      observation: { stage: "cleanup", duration_ms: 0,
        usage: { input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, provenance: "measured" },
        estimated_cost: options.unknownCost ? { usd: null, provenance: "unknown" } : { usd: 0, provenance: "calculated" } } },
    { kind: "run.completed", at: at(durationMs), run_id: runID, disposition: "succeeded" },
  );
  records = appendRunFlightLedgerEvents(records, events);
  return { schema_version: RUN_FLIGHT_LEDGER_SCHEMA_VERSION, events: records };
}

function completedLiveTakeoverLedger(runID, durationMs, cost) {
  const c0 = `candidate-${runID}`;
  const c1 = `takeover-${runID}`;
  const c2 = `accepted-${runID}`;
  const identity = {
    run_id: runID, unit_id: `luna-unit-${runID}`, attempt_id: `luna-attempt-${runID}`,
    predecessor_attempt_id: null, candidate_id: c0, route_id: "luna-fabric",
    child_id: `luna-child-${runID}`, call_id: `luna-call-${runID}`,
  };
  const satisfied = {
    terminal: "satisfied", tools_quiescent: "satisfied", artifact_window_closed: "satisfied",
    writer_released: "satisfied", gate_released: "satisfied", lease_released: "satisfied",
    worktree_released: "satisfied",
  };
  let records = createRunFlightLedgerInitialPrefix({
    run_planned: { kind: "run.planned", at: at(0), run_id: runID, initial_candidate_id: c0,
      budget_limits: { recovery_actions: 2, probe_iterations: 1, model_attempts: 1 } },
    plan_compiled: { kind: "plan.compiled", at: at(0), plan_id: digest("a"), proposal_id: digest("b"),
      decision: "accepted", gap_codes: [] },
  });
  records = appendRunFlightLedgerEvents(records, [
    { kind: "route.selected", at: at(1), route_id: "luna-fabric", candidate_id: c0,
      role: "implementation", model: "declared-luna", variant: null, reason: "implementation" },
    { kind: "wave.opened", at: at(2), wave_id: `luna-wave-${runID}`, wave_index: 1, candidate_id: c0 },
    { kind: "unit.opened", at: at(3), unit_id: identity.unit_id, wave_id: `luna-wave-${runID}`,
      candidate_id: c0, references: { capsule_ids: [], artifact_ids: [] } },
    { kind: "attempt.started", at: at(4), attempt_id: identity.attempt_id, predecessor_attempt_id: null,
      unit_id: identity.unit_id, candidate_id: c0, route_id: "luna-fabric", role: "implementation",
      selected_model: "declared-luna", selected_variant: null, child_id: identity.child_id,
      call_id: identity.call_id,
      budget_charge: { kind: "implementation", recovery_actions: 0, probe_iterations: 0, model_attempts: 0 } },
    { kind: "child.registered", at: at(5), identity, deadline_ms: 1000 },
    { kind: "child.stop-requested", at: at(6), identity, trigger: "deadline_expired" },
    { kind: "child.terminal", at: at(7), identity, disposition: "cancelled", evidence: satisfied },
    { kind: "attempt.finished", at: at(8), attempt_id: identity.attempt_id,
      observed_model: "actual-luna", observed_variant: null,
      failure: { category: "cancellation", code: "live-deadline-takeover" }, disposition: "cancelled",
      observation: { stage: "unit", duration_ms: Math.max(1, Math.floor(durationMs / 2)),
        usage: { input_tokens: 60, cache_read_tokens: 20, output_tokens: 10, provenance: "measured" },
        estimated_cost: { usd: cost / 2, provenance: "calculated" } },
      references: { capsule_ids: [], artifact_ids: [] } },
    { kind: "unit.completed", at: at(9), unit_id: identity.unit_id, disposition: "failed" },
    { kind: "wave.completed", at: at(10), wave_id: `luna-wave-${runID}`, produced_candidate_id: c1,
      artifact_id: digest("1") },
    { kind: "candidate.advanced", at: at(11), from_candidate_id: c0, candidate_id: c1,
      wave_id: `luna-wave-${runID}`, artifact_id: digest("1") },
    { kind: "route.selected", at: at(12), route_id: "sol-serial", candidate_id: c1,
      role: "implementation", model: "declared-sol", variant: null, reason: "implementation" },
    { kind: "wave.opened", at: at(13), wave_id: `sol-wave-${runID}`, wave_index: 2, candidate_id: c1 },
    { kind: "unit.opened", at: at(14), unit_id: `sol-unit-${runID}`, wave_id: `sol-wave-${runID}`,
      candidate_id: c1, references: { capsule_ids: [], artifact_ids: [] } },
    { kind: "attempt.started", at: at(15), attempt_id: `sol-attempt-${runID}`,
      predecessor_attempt_id: null, unit_id: `sol-unit-${runID}`, candidate_id: c1, route_id: "sol-serial",
      role: "implementation", selected_model: "declared-sol", selected_variant: null, child_id: null,
      call_id: `sol-call-${runID}`,
      budget_charge: { kind: "implementation", recovery_actions: 0, probe_iterations: 0, model_attempts: 0 } },
    { kind: "attempt.finished", at: at(16), attempt_id: `sol-attempt-${runID}`,
      observed_model: "actual-sol", observed_variant: null, failure: null, disposition: "succeeded",
      observation: { stage: "unit", duration_ms: Math.max(1, durationMs - Math.floor(durationMs / 2)),
        usage: { input_tokens: 40, cache_read_tokens: 10, output_tokens: 8, provenance: "measured" },
        estimated_cost: { usd: cost / 2, provenance: "calculated" } },
      references: { capsule_ids: [], artifact_ids: [digest("d")] } },
    { kind: "validation.recorded", at: at(17), validation_id: `validation-${runID}`,
      unit_id: `sol-unit-${runID}`, command_fingerprint: digest("e"), result: "passed", artifact_id: digest("f") },
    { kind: "unit.completed", at: at(18), unit_id: `sol-unit-${runID}`, disposition: "succeeded" },
    { kind: "wave.completed", at: at(19), wave_id: `sol-wave-${runID}`, produced_candidate_id: c2,
      artifact_id: digest("2") },
    { kind: "candidate.advanced", at: at(20), from_candidate_id: c1, candidate_id: c2,
      wave_id: `sol-wave-${runID}`, artifact_id: digest("2") },
    { kind: "candidate.completed", at: at(21), candidate_id: c2,
      references: { capsule_ids: [], artifact_ids: [digest("2")] } },
    { kind: "cleanup.completed", at: at(22), run_id: runID,
      observation: { stage: "cleanup", duration_ms: 0,
        usage: { input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, provenance: "measured" },
        estimated_cost: { usd: 0, provenance: "calculated" } } },
    { kind: "run.completed", at: at(durationMs), run_id: runID, disposition: "succeeded" },
  ]);
  return { schema_version: RUN_FLIGHT_LEDGER_SCHEMA_VERSION, events: records };
}

export async function writeExperienceRoutingFixture(projectRoot, options = {}) {
  const contract = experienceFabricContract();
  const admission = admitLunaFabric(contract);
  assert.equal(admission.route, "luna-fabric");
  const shape = deriveExperienceTaskShape(admission);
  assert.ok(shape);
  const directory = join(projectRoot, ".sortie-dogs", "experience-routing");
  const contractPath = ".sortie-dogs/experience-routing/contracts/fixed-contract.json";
  await mkdir(join(directory, "contracts"), { recursive: true });
  await mkdir(join(directory, "ledgers"), { recursive: true });
  await writeFile(join(projectRoot, contractPath), JSON.stringify(contract));
  const identity = {
    package: "sortie-dogs@0.8.5-synthetic-fixture",
    fixture: "experience-router-fixed-synthetic-corpus",
    validation: "synthetic-same-task-output-validation",
    cache: "synthetic-fixed-cache",
    price_basis: "synthetic-fixed-usd-basis",
    denominator: "accepted-completion",
  };
  const baselineDurations = options.baselineDurations ?? [100, 110, 120];
  const baselineCosts = options.baselineCosts ?? [10, 11, 12];
  const candidateDurations = options.candidateDurations ?? [70, 80, 90];
  const candidateCosts = options.candidateCosts ?? [7, 8, 9];
  const candidateRoute = options.candidateRoute ?? "sol-serial";
  const runs = [
    ...baselineDurations.map((duration, index) => ({ runID: `baseline-${index}`, route: "luna-fabric", duration,
      cost: baselineCosts[index], options: options.baselineRunOptions?.[index] ?? {} })),
    ...candidateDurations.map((duration, index) => ({ runID: `candidate-${index}`, route: candidateRoute, duration,
      cost: candidateCosts[index], options: options.candidateRunOptions?.[index] ?? {} })),
  ];
  const observations = [];
  for (const run of runs) {
    const document = completedLedger(run.runID, run.route, run.duration, run.cost, run.options);
    const ledgerPath = `.sortie-dogs/experience-routing/ledgers/${run.runID}.json`;
    await writeFile(join(projectRoot, ledgerPath), JSON.stringify(document));
    observations.push({
      run_id: run.runID,
      route: run.route,
      evidence_window: "synthetic-fixed-window-v1",
      identity,
      ledger_path: ledgerPath,
      ledger_tail_hash: document.events.at(-1).event_hash,
      contract_path: contractPath,
      contract_fingerprint: admission.contract_fingerprint,
    });
  }
  const index = {
    schema_version: EXPERIENCE_ROUTING_SCHEMA_VERSION,
    evidence_window: "synthetic-fixed-window-v1",
    rows: [{ shape: shape.id, baseline_route: "luna-fabric", policy_route: candidateRoute }],
    observations,
  };
  await writeFile(join(projectRoot, ".sortie-dogs", "experience-routing.json"), JSON.stringify(index));
  return { contract, admission, shape, index };
}

async function main() {
  const projectRoot = fileURLToPath(new URL(`../../../_testenv/experience-router-rpt-${process.pid}/`, import.meta.url));
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(projectRoot, { recursive: true });
  const fixture = await writeExperienceRoutingFixture(projectRoot);
  const decision = await resolveExperienceRouting(projectRoot, fixture.admission);
  assert.equal(decision.route, "sol-serial");
  assert.equal(decision.trace.fallback_reason, null);
  assert.equal(decision.trace.evidence_refs.length, 6);
  console.log(JSON.stringify({
    status: "PASS",
    data_class: "synthetic-fixed-replay-not-observed-performance",
    route: decision.route,
    policy_version: decision.trace.policy_version,
    shape: decision.trace.shape.id,
    evidence_count: decision.trace.evidence_refs.length,
    decision_fingerprint: decision.trace.decision_fingerprint,
    root: projectRoot,
  }));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`))) {
  await main();
}
