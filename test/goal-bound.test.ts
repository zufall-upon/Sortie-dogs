import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { goalFingerprint, selectGoalDelivery, validGoalEvidence, type GoalEvidence } from "../dist/core/goal-bound.js";
import { RunFlightLedger, RunFlightLedgerError } from "../dist/core/run-flight-ledger.js";

const root = fileURLToPath(new URL(`../_testenv/goal-bound-${process.pid}/`, import.meta.url));
const at = "2026-09-08T00:00:00.000Z";
const acceptance = goalFingerprint(["usable result"]);

test.before(async () => { await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true }); });
test.after(async () => { await rm(root, { recursive: true, force: true }); });

async function accepted(name: string, maxUnits = 4) {
  const ledger = await RunFlightLedger.openGoal(path.join(root, name, ".sortie-dogs", "run-flight", "root.json"));
  const state = await ledger.appendGoal({ kind: "goal.accepted", at, goal_id: `goal-${name}`, revision: 1,
    scope_epoch: 1, acceptance_fingerprint: acceptance, origin_user_message_id: "user-1",
    origin_session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: { max_units: maxUnits, time_ms: null, cost_usd: null, source: "policy-default" },
    acceptance_contract: null });
  return { ledger, state };
}

test("delivery selection follows explicit current-turn facts without a classifier", () => {
  assert.equal(selectGoalDelivery({ declared_intent: "design", requested_usable_path_established: false,
    irreversible_or_major_scope: false }), "planning-only");
  assert.equal(selectGoalDelivery({ declared_intent: "implementation", requested_usable_path_established: false,
    irreversible_or_major_scope: false }), "mvp-first");
  assert.equal(selectGoalDelivery({ declared_intent: "implementation", requested_usable_path_established: true,
    irreversible_or_major_scope: false }), "mvp-first");
  assert.equal(selectGoalDelivery({ declared_intent: "repair", requested_usable_path_established: true,
    irreversible_or_major_scope: false }), "repair-first");
  assert.equal(selectGoalDelivery({ declared_intent: "implementation", requested_usable_path_established: false,
    irreversible_or_major_scope: true }), "controlled-change");
  assert.equal(selectGoalDelivery({ declared_intent: "repair", requested_usable_path_established: true,
    irreversible_or_major_scope: false, explicit_mode: "mvp-first" }), "mvp-first");
});

test("terminal report snapshots are idempotent, receipt-bound, and cannot alter goal execution state", async () => {
  const { ledger } = await accepted("report");
  const receipt = { goal_id: "goal-report", terminal_revision: 1, acceptance_fingerprint: acceptance,
    started_at: at, ended_at: "2026-09-08T00:00:01.000Z", status: "stopped" as const, stop_reason: "stopped" as const,
    unit_ids: [], session_ids: ["root-session"], evidence_refs: [], milestone_at: null };
  const before = await ledger.appendGoal({ kind: "goal.terminal", at: receipt.ended_at, goal_id: receipt.goal_id, receipt });
  const report = { definition: "pre-terminal-host-tokens/v1" as const, terminal_key: goalFingerprint(receipt),
    tokens: 10, models: [{ model: "fixture/model", tokens: 10 }], first_pass_eligible: false, traits: [] };
  await assert.rejects(ledger.appendGoal({ kind: "goal.reported", at: receipt.ended_at, goal_id: receipt.goal_id,
    report: { ...report, terminal_key: goalFingerprint("wrong receipt") } }), RunFlightLedgerError);
  const after = await ledger.appendGoal({ kind: "goal.reported", at: receipt.ended_at, goal_id: receipt.goal_id, report });
  assert.deepEqual(after, before);
  await ledger.appendGoal({ kind: "goal.reported", at: receipt.ended_at, goal_id: receipt.goal_id, report });
  assert.equal((await ledger.readGoal()).records.filter(({ event }) => event.kind === "goal.reported").length, 1);
  await ledger.appendGoal({ kind: "goal.user-continued", at: "2026-09-08T00:00:02.000Z", goal_id: receipt.goal_id,
    origin_user_message_id: "user-2", session_id: "root-session", selected_agent: "dog-coordinator" });
  const resumed = { ...receipt, ended_at: "2026-09-08T00:00:03.000Z" };
  await ledger.appendGoal({ kind: "goal.terminal", at: resumed.ended_at, goal_id: resumed.goal_id, receipt: resumed });
  await ledger.appendGoal({ kind: "goal.reported", at: resumed.ended_at, goal_id: resumed.goal_id,
    report: { ...report, terminal_key: goalFingerprint(resumed), tokens: 20, models: [{ model: "fixture/model", tokens: 20 }] } });
  const { summarizeCareer } = await import("../dist/plugin/sortie-career.js");
  const result = summarizeCareer([(await ledger.readGoal()).records], { files: 1, included: 1, unavailable: 0, truncated: false });
  assert.equal(result.goals, 1);
  assert.equal(result.interrupted, 1);
  assert.equal(result.tokens.sum, 20);
  const snapshot = await ledger.readGoal();
  let previous: string | null = null;
  const future = snapshot.records.map((entry) => {
    const event = entry.event.kind === "goal.reported"
      ? { ...entry.event, report: { ...entry.event.report, definition: "future-telemetry/v2" } } : entry.event;
    const next = { ...entry, previous_hash: previous, event, event_hash: goalFingerprint({ sequence: entry.sequence, previous_hash: previous, event }) };
    previous = next.event_hash;
    return next;
  });
  await writeFile(path.join(root, "report", ".sortie-dogs", "run-flight", "root.json"), JSON.stringify({ schema_version: "0.1", goal_events: future }));
  assert.deepEqual((await ledger.readGoal()).state, snapshot.state, "future presentation metadata must not block execution replay");
});

test("a stopped goal may be followed by a distinct accepted goal on the same root", async () => {
  const { ledger } = await accepted("fresh-after-stop");
  const receipt = { goal_id: "goal-fresh-after-stop", terminal_revision: 1, acceptance_fingerprint: acceptance,
    started_at: at, ended_at: "2026-09-08T00:00:01.000Z", status: "stopped" as const,
    stop_reason: "stop_budget" as const, unit_ids: [], session_ids: ["root-session"], evidence_refs: [], milestone_at: null };
  await ledger.appendGoal({ kind: "goal.terminal", at: receipt.ended_at, goal_id: receipt.goal_id, receipt });
  const nextFingerprint = goalFingerprint(["new user order"]);
  const nextEvent = { kind: "goal.accepted" as const, at: "2026-09-08T00:00:02.000Z",
    goal_id: "goal-next", revision: 1, scope_epoch: 1, acceptance_fingerprint: nextFingerprint,
    origin_user_message_id: "user-2", origin_session_id: "root-session", selected_agent: "dog-coordinator",
    delivery: "mvp-first", budget: { max_units: 32, time_ms: null, cost_usd: null, source: "policy-default" },
    acceptance_contract: null } as const;
  const next = await ledger.appendGoal(nextEvent);
  assert.equal(next.goal_id, "goal-next");
  assert.equal(next.origin_user_message_id, "user-2");
  assert.equal(next.consumed_units, 0);
  assert.equal(next.receipt, null);
  assert.equal((await ledger.appendGoal(nextEvent)).goal_id, "goal-next");
  assert.equal((await ledger.readGoal()).records.filter(({ event }) => event.kind === "goal.accepted" &&
    event.origin_user_message_id === "user-2").length, 1);
  await assert.rejects(ledger.appendGoal({ ...nextEvent,
    budget: { ...nextEvent.budget, max_units: 31 } }), RunFlightLedgerError);
});

test("issued ticket is one-use and bound to goal revision, sequence, session, and origin user", async () => {
  const { ledger } = await accepted("ticket");
  await ledger.appendGoal({ kind: "ticket.issued", at, ticket_id: "ticket-1", goal_id: "goal-ticket",
    revision: 1, scope_epoch: 1, checkpoint: "unit-1", sequence: 1, session_id: "root-session",
    origin_user_message_id: "user-1" });
  await assert.rejects(ledger.appendGoal({ kind: "ticket.issued", at, ticket_id: "ticket-future",
    goal_id: "goal-ticket", revision: 1, scope_epoch: 1, checkpoint: "unit-2", sequence: 3,
    session_id: "root-session", origin_user_message_id: "user-1" }), RunFlightLedgerError);
  await assert.rejects(ledger.appendGoal({ kind: "ticket.consumed", at, ticket_id: "unknown",
    goal_id: "goal-ticket", receiving_message_id: "host-message", session_id: "root-session",
    origin_user_message_id: "user-1" }), RunFlightLedgerError);
  await ledger.appendGoal({ kind: "ticket.consumed", at, ticket_id: "ticket-1", goal_id: "goal-ticket",
    receiving_message_id: "host-message", session_id: "root-session", origin_user_message_id: "user-1" });
  await assert.rejects(ledger.appendGoal({ kind: "ticket.consumed", at, ticket_id: "ticket-1",
    goal_id: "goal-ticket", receiving_message_id: "duplicate", session_id: "root-session",
    origin_user_message_id: "user-1" }), RunFlightLedgerError);
});

test("rename and real continuation retain goal/spend; explicit revision cannot reset consumed budget", async () => {
  const { ledger } = await accepted("budget", 2);
  await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "reserve-1", goal_id: "goal-budget",
    unit_id: "unit-before-rename", session_id: "root-session", ticket_id: null });
  await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: "reserve-1", receipt_id: "receipt-1",
    goal_id: "goal-budget", unit_id: "unit-before-rename", disposition: "succeeded",
    progress_fingerprint: null, evidence: [], elapsed_ms: 10, cost_usd: null });
  const continued = await ledger.appendGoal({ kind: "goal.user-continued", at, goal_id: "goal-budget",
    origin_user_message_id: "user-2", session_id: "root-session", selected_agent: "dog-coordinator" });
  assert.equal(continued.goal_id, "goal-budget");
  assert.equal(continued.origin_user_message_id, "user-1");
  assert.equal(continued.latest_user_message_id, "user-2");
  assert.equal(continued.consumed_units, 1);
  await assert.rejects(ledger.appendGoal({ kind: "goal.revised", at, goal_id: "goal-budget", revision: 2,
    scope_epoch: 2, acceptance_fingerprint: goalFingerprint(["revised"]), origin_user_message_id: "user-2",
    session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: { max_units: 0, time_ms: null, cost_usd: null, source: "user-revision" } }), RunFlightLedgerError);
});

test("accepted budget revision synchronizes validation limit without resetting consumption", async () => {
  const { ledger } = await accepted("validation-revision", 1);
  const request = { run_id: "goal-validation-revision", operation_id: "first",
    source_snapshot: "source-1", candidate: "candidate", command: ["node", "check"],
    scope: "targeted" as const, expected_evidence: ["command", "source_snapshot"], reason: "preflight" as const };
  const first = await ledger.reserveValidation(request, 1);
  assert.equal(first.decision, "ALLOW");
  await ledger.settleValidation(first.reservation_id!, request, "passed", 0);
  const before = (await ledger.readGoal()).state;
  const revised = await ledger.appendGoal({ kind: "goal.revised", at, goal_id: request.run_id,
    revision: 2, scope_epoch: 2, acceptance_fingerprint: goalFingerprint(["expanded"]),
    origin_user_message_id: "user-2", session_id: "root-session", selected_agent: "dog-coordinator",
    delivery: "mvp-first", budget: { max_units: 3, time_ms: null, cost_usd: null, source: "user-revision" },
    acceptance_contract: null });
  assert.equal(revised.validation_budget.limit, 3);
  assert.equal(revised.validation_budget.consumed, 1);
  assert.deepEqual(revised.validation_budget.evidence_keys, before.validation_budget.evidence_keys);
  assert.equal(revised.consumed_units, before.consumed_units);
  assert.equal(revised.consumed_time_ms, before.consumed_time_ms);
  assert.equal(revised.no_progress_results, 0);
  assert.equal(revised.replan_required, false);
  assert.equal(revised.replan_used, false);
  const duplicate = await ledger.reserveValidation({ ...request, operation_id: "duplicate" }, 3);
  assert.equal(duplicate.decision, "DENY");
  const next = { ...request, operation_id: "second", source_snapshot: "source-2" };
  assert.equal((await ledger.reserveValidation(next, 3)).decision, "ALLOW");
  assert.equal((await ledger.readGoal()).state.validation_budget.consumed, 2);
  await assert.rejects(ledger.appendGoal({ kind: "goal.revised", at, goal_id: request.run_id,
    revision: 3, scope_epoch: 3, acceptance_fingerprint: acceptance, origin_user_message_id: "user-3",
    session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: { max_units: 1, time_ms: null, cost_usd: null, source: "user-revision" },
    acceptance_contract: null }), RunFlightLedgerError);
});

test("validation admission permits monotonic limit growth for a changed candidate", async () => {
  const { ledger } = await accepted("validation-growth", 1);
  const firstRequest = { run_id: "goal-validation-growth", operation_id: "first",
    source_snapshot: "source-1", candidate: "candidate", command: ["node", "check"],
    scope: "targeted" as const, expected_evidence: ["command", "source_snapshot"], reason: "acceptance" as const };
  const first = await ledger.reserveValidation(firstRequest, 1);
  assert.equal(first.decision, "ALLOW");
  await ledger.settleValidation(first.reservation_id!, firstRequest, "failed", 1);
  const changed = { ...firstRequest, operation_id: "second", source_snapshot: "source-2" };
  assert.equal((await ledger.reserveValidation(changed, 2)).decision, "ALLOW");
  const state = (await ledger.readGoal()).state;
  assert.equal(state.validation_budget.limit, 2);
  assert.equal(state.validation_budget.consumed, 2);
});

test("two no-progress boundaries permit one replan, then require stop", async () => {
  const { ledger } = await accepted("stall", 6);
  for (let index = 1; index <= 2; index += 1) {
    await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: `r-${index}`, goal_id: "goal-stall",
      unit_id: `u-${index}`, session_id: "root-session", ticket_id: null });
    await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: `r-${index}`, receipt_id: `x-${index}`,
      goal_id: "goal-stall", unit_id: `u-${index}`, disposition: "failed", progress_fingerprint: null,
      evidence: [], elapsed_ms: null, cost_usd: null });
  }
  await assert.rejects(ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "blocked",
    goal_id: "goal-stall", unit_id: "u-3", session_id: "root-session", ticket_id: null }), RunFlightLedgerError);
  const replanned = await ledger.appendGoal({ kind: "goal.replanned", at, goal_id: "goal-stall", revision: 1,
    reason: "no-progress" });
  assert.equal(replanned.replan_used, true);
});

test("accepted revision starts a fresh no-progress cycle without resetting spend", async () => {
  const { ledger } = await accepted("revision-after-stall", 8);
  for (let index = 1; index <= 4; index += 1) {
    await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: `stall-r-${index}`,
      goal_id: "goal-revision-after-stall", unit_id: `stall-u-${index}`, session_id: "root-session", ticket_id: null });
    await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: `stall-r-${index}`, receipt_id: `stall-x-${index}`,
      goal_id: "goal-revision-after-stall", unit_id: `stall-u-${index}`, disposition: "failed",
      result_class: "acceptance", progress_fingerprint: null, evidence: [], elapsed_ms: 10, cost_usd: null });
    if (index === 2) {
      await ledger.appendGoal({ kind: "goal.replanned", at, goal_id: "goal-revision-after-stall", revision: 1,
        reason: "no-progress" });
    }
  }
  const stalled = (await ledger.readGoal()).state;
  assert.equal(stalled.consumed_units, 4);
  assert.equal(stalled.replan_used, true);
  assert.equal(stalled.replan_required, true);

  const revised = await ledger.appendGoal({ kind: "goal.revised", at, goal_id: "goal-revision-after-stall",
    revision: 2, scope_epoch: 2, acceptance_fingerprint: goalFingerprint(["revised-after-stall"]),
    origin_user_message_id: "user-2", session_id: "root-session", selected_agent: "dog-coordinator",
    delivery: "mvp-first", budget: { max_units: 8, time_ms: null, cost_usd: null, source: "user-revision" },
    acceptance_contract: null, reset_no_progress: true });
  assert.equal(revised.consumed_units, 4);
  assert.equal(revised.no_progress_results, 0);
  assert.equal(revised.replan_required, false);
  assert.equal(revised.replan_used, false);
  await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "resumed-r-1",
    goal_id: "goal-revision-after-stall", unit_id: "resumed-u-1", session_id: "root-session", ticket_id: null });
});

test("legacy revisions preserve their recorded no-progress semantics during replay", async () => {
  const { ledger } = await accepted("legacy-revision-replay", 8);
  for (let index = 1; index <= 2; index += 1) {
    await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: `legacy-r-${index}`,
      goal_id: "goal-legacy-revision-replay", unit_id: `legacy-u-${index}`, session_id: "root-session", ticket_id: null });
    await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: `legacy-r-${index}`, receipt_id: `legacy-x-${index}`,
      goal_id: "goal-legacy-revision-replay", unit_id: `legacy-u-${index}`, disposition: "failed",
      result_class: "acceptance", progress_fingerprint: null, evidence: [], elapsed_ms: 1, cost_usd: null });
  }
  await ledger.appendGoal({ kind: "goal.revised", at, goal_id: "goal-legacy-revision-replay", revision: 2,
    scope_epoch: 2, acceptance_fingerprint: goalFingerprint(["legacy-revision"]), origin_user_message_id: "user-2",
    session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: { max_units: 8, time_ms: null, cost_usd: null, source: "user-revision" }, acceptance_contract: null });
  await ledger.appendGoal({ kind: "goal.replanned", at, goal_id: "goal-legacy-revision-replay", revision: 2,
    reason: "no-progress" });
  const replayed = (await ledger.readGoal()).state;
  assert.equal(replayed.revision, 2);
  assert.equal(replayed.replan_used, true);
  assert.equal(replayed.replan_required, false);
});

test("pre-marker reset revisions replay an already accepted later dispatch", async () => {
  const { ledger } = await accepted("pre-marker-reset-replay", 8);
  for (let index = 1; index <= 4; index += 1) {
    await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: `pre-marker-r-${index}`,
      goal_id: "goal-pre-marker-reset-replay", unit_id: `pre-marker-u-${index}`, session_id: "root-session", ticket_id: null });
    await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: `pre-marker-r-${index}`, receipt_id: `pre-marker-x-${index}`,
      goal_id: "goal-pre-marker-reset-replay", unit_id: `pre-marker-u-${index}`, disposition: "failed",
      result_class: "acceptance", progress_fingerprint: null, evidence: [], elapsed_ms: 1, cost_usd: null });
    if (index === 2) await ledger.appendGoal({ kind: "goal.replanned", at,
      goal_id: "goal-pre-marker-reset-replay", revision: 1, reason: "no-progress" });
  }
  await ledger.appendGoal({ kind: "goal.revised", at, goal_id: "goal-pre-marker-reset-replay", revision: 2,
    scope_epoch: 2, acceptance_fingerprint: goalFingerprint(["pre-marker-revision"]), origin_user_message_id: "user-2",
    session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: { max_units: 8, time_ms: null, cost_usd: null, source: "user-revision" }, acceptance_contract: null });
  const resumed = await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "pre-marker-resumed",
    goal_id: "goal-pre-marker-reset-replay", unit_id: "pre-marker-resumed", session_id: "root-session", ticket_id: null });
  assert.equal(resumed.revision, 2);
  assert.equal(resumed.consumed_units, 4);
  assert.equal(resumed.replan_required, false);
  assert.equal(resumed.outstanding_reservations.length, 1);
});

test("process defects and interruptions do not consume no-progress while acceptance failures do", async () => {
  const { ledger } = await accepted("process-defect-budget", 6);
  for (const [index, resultClass] of ["process-defect", "process-defect", "interrupted"].entries()) {
    await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: `process-r-${index}`,
      goal_id: "goal-process-defect-budget", unit_id: `process-u-${index}`, session_id: "root-session", ticket_id: null });
    const state = await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: `process-r-${index}`,
      receipt_id: `process-x-${index}`, goal_id: "goal-process-defect-budget", unit_id: `process-u-${index}`,
      disposition: resultClass === "interrupted" ? "cancelled" : "failed", result_class: resultClass as "process-defect" | "interrupted",
      progress_fingerprint: null, evidence: [], elapsed_ms: null, cost_usd: null });
    assert.equal(state.no_progress_results, 0);
    assert.equal(state.replan_required, false);
  }
  for (let index = 0; index < 2; index += 1) {
    await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: `accept-r-${index}`,
      goal_id: "goal-process-defect-budget", unit_id: `accept-u-${index}`, session_id: "root-session", ticket_id: null });
    const state = await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: `accept-r-${index}`,
      receipt_id: `accept-x-${index}`, goal_id: "goal-process-defect-budget", unit_id: `accept-u-${index}`,
      disposition: "failed", result_class: "acceptance", progress_fingerprint: null, evidence: [], elapsed_ms: null, cost_usd: null });
    assert.equal(state.no_progress_results, index + 1);
  }
  assert.equal((await ledger.readGoal()).state.replan_required, true);
});

test("full proof requires requested oracle and exact revision while proxy and expected-negative stay typed", async () => {
  const { ledger, state: initialState } = await accepted("evidence");
  const contract = { criteria: [{ criterion_id: "criterion-1", target: "goal delivery", entrypoint: "fixture",
    workload: "one unit", oracle_coverage: ["requested-runtime"], build_boundary: "included" as const,
    source: "sha256:source", candidate: "sha256:candidate", fixture: "goal-bound-small",
    proof_scope: "requested-full" as const, expected_outcome: "pass" as const }] };
  const state = await ledger.appendGoal({ kind: "goal.revised", at, goal_id: initialState.goal_id!, revision: 2,
    scope_epoch: 2, acceptance_fingerprint: goalFingerprint(["bound evidence"]), origin_user_message_id: "user-1",
    session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: initialState.budget!, acceptance_contract: contract });
  const evidence = (proof_scope: GoalEvidence["proof_scope"], oracle: string[], outcome: GoalEvidence["execution"]["outcome"], exit: number | null): GoalEvidence => ({
    evidence_id: goalFingerprint([proof_scope, oracle]), goal_id: state.goal_id!, goal_revision: state.revision,
    scope_epoch: state.scope_epoch, acceptance_fingerprint: state.acceptance_fingerprint!,
    measurement: { criterion_ids: ["criterion-1"], target: "goal delivery", entrypoint: "fixture",
      workload: "one unit", oracle_coverage: oracle, build_boundary: "included" },
    identity: { source: "sha256:source", candidate: "sha256:candidate", fixture: "goal-bound-small" },
    execution: { command: ["node", "fixture.mjs"], exit_code: exit, outcome,
      started_at: at, ended_at: at, units: ["unit-1"] }, proof_scope,
  });
  assert.equal(validGoalEvidence(evidence("requested-full", ["proxy"], "pass", 0), state), false);
  assert.equal(validGoalEvidence(evidence("supporting-proxy", ["requested-runtime"], "pass", 0), state), false);
  assert.equal(validGoalEvidence(evidence("requested-full", ["requested-runtime"], "pass", 0), state), true);
  assert.equal(validGoalEvidence(evidence("requested-full", ["requested-runtime"], "fail", 1), state), false);
  assert.equal(validGoalEvidence({ ...evidence("requested-full", ["requested-runtime"], "pass", 0), goal_revision: 1 }, state), false);
  const first = evidence("requested-full", ["requested-runtime"], "pass", 0);
  await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "evidence-r1", goal_id: state.goal_id!,
    unit_id: "unit-1", session_id: "root-session", ticket_id: null });
  await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: "evidence-r1", receipt_id: "evidence-receipt-1",
    goal_id: state.goal_id!, unit_id: "unit-1", disposition: "succeeded", progress_fingerprint: goalFingerprint([first]),
    evidence: [first], elapsed_ms: 1, cost_usd: 0 });
  await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "evidence-r2", goal_id: state.goal_id!,
    unit_id: "unit-2", session_id: "root-session", ticket_id: null });
  const repeated = { ...first, evidence_id: "new-description-id",
    execution: { ...first.execution, units: ["unit-2"] } };
  const repeatedState = await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: "evidence-r2", receipt_id: "evidence-receipt-2",
    goal_id: state.goal_id!, unit_id: "unit-2", disposition: "failed", progress_fingerprint: null,
    evidence: [repeated], elapsed_ms: 1, cost_usd: 0 });
  assert.equal(repeatedState.no_progress_results, 1);
});

test("document and expected-negative receipts prove the requested subject without inventing code execution", async () => {
  const { ledger, state: initialState } = await accepted("typed-subjects");
  const contract = { criteria: [
    { criterion_id: "document", target: "message", entrypoint: "host-persist", workload: "one document",
      oracle_coverage: ["persisted-id", "content-digest"], build_boundary: "not-applicable" as const,
      source: "request-v1", candidate: "sha256:document", fixture: "host-message-store",
      proof_scope: "document-deliverable" as const, expected_outcome: "pass" as const },
    { criterion_id: "rejection", target: "candidate", entrypoint: "assessment", workload: "one candidate",
      oracle_coverage: ["required-rejection"], build_boundary: "excluded" as const,
      source: "source-v1", candidate: "candidate-bad", fixture: "negative-fixture",
      proof_scope: "expected-negative" as const, expected_outcome: "fail" as const },
  ] };
  const state = await ledger.appendGoal({ kind: "goal.revised", at, goal_id: initialState.goal_id!, revision: 2,
    scope_epoch: 2, acceptance_fingerprint: goalFingerprint(contract), origin_user_message_id: "user-1",
    session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: initialState.budget!, acceptance_contract: contract });
  const common = { goal_id: state.goal_id!, goal_revision: 2, scope_epoch: 2,
    acceptance_fingerprint: state.acceptance_fingerprint! };
  const document: GoalEvidence = { ...common, evidence_id: "host-document-receipt",
    measurement: { criterion_ids: ["document"], target: "message", entrypoint: "host-persist",
      workload: "one document", oracle_coverage: ["persisted-id", "content-digest"], build_boundary: "not-applicable" },
    identity: { source: "request-v1", candidate: "sha256:document", fixture: "host-message-store" },
    execution: { command: ["host", "persist", "message-42", "sha256:document"], exit_code: 0, outcome: "pass",
      started_at: at, ended_at: at, units: ["document-unit"] }, proof_scope: "document-deliverable" };
  const rejected: GoalEvidence = { ...common, evidence_id: "validator-negative-receipt",
    measurement: { criterion_ids: ["rejection"], target: "candidate", entrypoint: "assessment",
      workload: "one candidate", oracle_coverage: ["required-rejection"], build_boundary: "excluded" },
    identity: { source: "source-v1", candidate: "candidate-bad", fixture: "negative-fixture" },
    execution: { command: ["validator", "assess", "candidate-bad"], exit_code: 0, outcome: "fail",
      started_at: at, ended_at: at, units: ["negative-unit"] }, proof_scope: "expected-negative" };
  assert.equal(validGoalEvidence(document, state), true);
  assert.equal(validGoalEvidence(rejected, state), true);
  assert.equal(validGoalEvidence({ ...rejected, identity: { ...rejected.identity, source: "stale-source" } }, state), false);
  assert.equal(validGoalEvidence({ ...rejected, measurement: { ...rejected.measurement, build_boundary: "included" } }, state), false);
});

test("unknown metered spend fails closed", async () => {
  const { ledger, state: initialState } = await accepted("metered", 4);
  const contract = { criteria: [{ criterion_id: "only", target: "target", entrypoint: "validator", workload: "work",
    oracle_coverage: ["full"], build_boundary: "included" as const, source: "source", candidate: "candidate",
    fixture: "fixture", proof_scope: "requested-full" as const, expected_outcome: "pass" as const }] };
  const state = await ledger.appendGoal({ kind: "goal.revised", at, goal_id: initialState.goal_id!, revision: 2,
    scope_epoch: 2, acceptance_fingerprint: goalFingerprint(contract), origin_user_message_id: "user-1",
    session_id: "root-session", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: { max_units: 4, time_ms: 100, cost_usd: 1, source: "accepted-plan" }, acceptance_contract: contract });
  const receipt = (unit: string, evidenceID: string): GoalEvidence => ({ evidence_id: evidenceID, goal_id: state.goal_id!,
    goal_revision: 2, scope_epoch: 2, acceptance_fingerprint: state.acceptance_fingerprint!,
    measurement: { criterion_ids: ["only"], target: "target", entrypoint: "validator", workload: "work",
      oracle_coverage: ["full"], build_boundary: "included" }, identity: { source: "source", candidate: "candidate", fixture: "fixture" },
    execution: { command: ["validator"], exit_code: 0, outcome: "pass", started_at: at, ended_at: at, units: [unit] },
    proof_scope: "requested-full" });
  await ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "metered-r1", goal_id: state.goal_id!,
    unit_id: "metered-u1", session_id: "root-session", ticket_id: null });
  const first = receipt("metered-u1", "evidence-1");
  const settled = await ledger.appendGoal({ kind: "unit.settled", at, reservation_id: "metered-r1", receipt_id: "receipt-1",
    goal_id: state.goal_id!, unit_id: "metered-u1", disposition: "succeeded", progress_fingerprint: goalFingerprint([first]),
    evidence: [first], elapsed_ms: null, cost_usd: null });
  assert.equal(settled.consumed_time_ms, null);
  assert.equal(settled.consumed_cost_usd, null);
  await assert.rejects(ledger.appendGoal({ kind: "dispatch.reserved", at, reservation_id: "metered-r2", goal_id: state.goal_id!,
    unit_id: "metered-u2", session_id: "root-session", ticket_id: null }), RunFlightLedgerError);
});

test("terminal receipt survives non-Git reopen and invalidates outstanding control", async () => {
  const { ledger } = await accepted("terminal");
  const receipt = { goal_id: "goal-terminal", terminal_revision: 1, acceptance_fingerprint: acceptance,
    started_at: at, ended_at: at, status: "succeeded" as const, stop_reason: "completed" as const,
    unit_ids: [], session_ids: ["root-session"], evidence_refs: [], milestone_at: null };
  await assert.rejects(ledger.appendGoal({ kind: "goal.terminal", at, goal_id: "goal-terminal", receipt }), RunFlightLedgerError);
  const stopped = { ...receipt, status: "stopped" as const, stop_reason: "stopped" as const };
  await ledger.appendGoal({ kind: "goal.terminal", at, goal_id: "goal-terminal", receipt: stopped });
  const reopened = await RunFlightLedger.openGoal(path.join(root, "terminal", ".sortie-dogs", "run-flight", "root.json"));
  assert.deepEqual((await reopened.readGoal()).state.receipt, stopped);
  await assert.rejects(reopened.appendGoal({ kind: "ticket.issued", at, ticket_id: "stale",
    goal_id: "goal-terminal", revision: 1, scope_epoch: 1, checkpoint: "after-done", sequence: 1,
    session_id: "root-session", origin_user_message_id: "user-1" }), RunFlightLedgerError);
});
