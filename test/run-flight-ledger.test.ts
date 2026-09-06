import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EvidenceCapsuleStore, type EvidenceCapsule } from "../src/core/evidence-capsule.ts";
import { RunFlightLedger, RunFlightLedgerError, reconstructRunFlightLedger, type FlightObservation, type RunFlightEvent } from "../src/core/run-flight-ledger.ts";
import { compileAcceptanceCoverage, type AcceptanceCompileProposal } from "../src/core/acceptance-compiler.ts";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const root = fileURLToPath(new URL(`../_testenv/run-flight-ledger-${process.pid}/`, import.meta.url));
const at = "2026-09-05T08:00:00Z";
const unknownObservation = (stage: FlightObservation["stage"]): FlightObservation => ({
  stage, duration_ms: null,
  usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
  estimated_cost: { usd: null, provenance: "unknown" },
});
const capsule = (): EvidenceCapsule => ({ schema_version: "0.1", extractor_version: "x1", sources: [{ path: "src/a.ts", blob_hash: digest("a") }], acceptance_links: [{ acceptance_id: "a7" }], risks: [], validations: [{ command: "npm test", fingerprint: digest("b") }], provenance: { producer: "scout", revision: "r1", scope_fingerprint: digest("c") } });

test.before(async () => { await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true }); });
test.after(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(name: string) {
  const store = new EvidenceCapsuleStore(path.join(root, name, "capsules"));
  const saved = await store.put(capsule(), ["src/a.ts"]);
  const file = path.join(root, name, "ledger.json");
  const access = { store, declared_capsule_ids: [saved.capsule_id], authorized_source_paths: ["src/a.ts"] };
  return { ledger: await RunFlightLedger.open(file, access), file, access, capsuleId: saved.capsule_id };
}

const event = <T extends RunFlightEvent>(value: T): T => value;

async function appendWave(ledger: RunFlightLedger, capsuleId: string, suffix: string, index: number, candidate: string, produced: string, predecessor: string | null, failedFirst = false) {
  await ledger.append(event({ kind: "route.selected", at, route_id: `r${suffix}`, candidate_id: candidate, role: failedFirst ? "rescue" : "implementation", model: failedFirst ? "m2" : "m1", variant: null, reason: failedFirst ? "model_rescue" : "implementation" }));
  await ledger.append(event({ kind: "wave.opened", at, wave_id: `w${suffix}`, wave_index: index, candidate_id: candidate }));
  await ledger.append(event({ kind: "unit.opened", at, unit_id: `u${suffix}`, wave_id: `w${suffix}`, candidate_id: candidate, references: { capsule_ids: [capsuleId], artifact_ids: [] } }));
  const attemptId = `a${suffix}`;
  await ledger.append(event({ kind: "attempt.started", at, attempt_id: attemptId, predecessor_attempt_id: predecessor, unit_id: `u${suffix}`, candidate_id: candidate, route_id: `r${suffix}`, role: failedFirst ? "rescue" : "implementation", selected_model: failedFirst ? "m2" : "m1", selected_variant: null, child_id: `child${suffix}`, call_id: `call${suffix}`, budget_charge: { kind: failedFirst ? "model_rescue" : "implementation", recovery_actions: failedFirst ? 1 : 0, probe_iterations: 0, model_attempts: failedFirst ? 1 : 0 } }));
  await ledger.append(event({ kind: "attempt.finished", at, attempt_id: attemptId, observed_model: failedFirst ? null : "m1-runtime", observed_variant: null, failure: null, disposition: "succeeded", observation: failedFirst ? unknownObservation("recovery") : { stage: "unit", duration_ms: 120, usage: { input_tokens: 10, cache_read_tokens: 4, output_tokens: 2, provenance: "measured" }, estimated_cost: { usd: 0.01, provenance: "provider_estimate" } }, references: { capsule_ids: [capsuleId], artifact_ids: [digest("d")] } }));
  await ledger.append(event({ kind: "validation.recorded", at, validation_id: `v${suffix}`, unit_id: `u${suffix}`, command_fingerprint: digest("e"), result: "passed", artifact_id: digest("f") }));
  await ledger.append(event({ kind: "unit.completed", at, unit_id: `u${suffix}`, disposition: "succeeded" }));
  await ledger.append(event({ kind: "wave.completed", at, wave_id: `w${suffix}`, produced_candidate_id: produced, artifact_id: digest(index === 1 ? "1" : "2") }));
  await ledger.append(event({ kind: "candidate.advanced", at, from_candidate_id: candidate, candidate_id: produced, wave_id: `w${suffix}`, artifact_id: digest(index === 1 ? "1" : "2") }));
}

test("appends, reopens, and reconstructs two real waves with hash-referenced capsule and artifact lineage", async () => {
  const { ledger, file, access, capsuleId } = await fixture("multi-wave");
  await ledger.append(event({ kind: "run.planned", at, run_id: "run1", initial_candidate_id: "c0", budget_limits: { recovery_actions: 3, probe_iterations: 2, model_attempts: 2 } }));
  await appendWave(ledger, capsuleId, "1", 1, "c0", "c1", null);
  const reopened = await RunFlightLedger.open(file, access);
  await appendWave(reopened, capsuleId, "2", 2, "c1", "c2", null, true);
  await reopened.append(event({ kind: "candidate.completed", at, candidate_id: "c2", references: { capsule_ids: [capsuleId], artifact_ids: [digest("2")] } }));
  await reopened.append(event({ kind: "cleanup.completed", at, run_id: "run1", observation: unknownObservation("cleanup") }));
  const state = await reopened.append(event({ kind: "run.completed", at, run_id: "run1", disposition: "succeeded" }));
  assert.equal(state.completed_wave_count, 2);
  assert.deepEqual(state.budget_consumed, { recovery_actions: 1, probe_iterations: 0, model_attempts: 1 });
  assert.deepEqual(state.child_counts, { implementation: 1, review: 0, advice: 0, rescue: 1 });
  assert.equal(state.validation_reruns, 1);
  assert.equal(state.observations[1].duration_ms, null);
  assert.equal(state.observations[1].usage.input_tokens, null);
  assert.equal(state.observations[1].estimated_cost.usd, null);
  const finalRead = await (await RunFlightLedger.open(file, access)).read();
  assert.equal(finalRead.state.terminal_disposition, "succeeded");
  const completedLedger = await readFile(file, "utf8");
  await assert.rejects(
    reopened.append(event({ kind: "route.selected", at, route_id: "r3", candidate_id: "c2", role: "review", model: "m3", variant: null, reason: "planning" })),
    (error: unknown) => error instanceof RunFlightLedgerError && error.code === "transition" && error.message === "No event may follow run completion.",
  );
  assert.equal(await readFile(file, "utf8"), completedLedger);
});

test("restart and model rescue retain predecessor and cumulative shared recovery budget", async () => {
  const { ledger, file, access, capsuleId } = await fixture("budget");
  await ledger.append(event({ kind: "run.planned", at, run_id: "run2", initial_candidate_id: "c0", budget_limits: { recovery_actions: 1, probe_iterations: 1, model_attempts: 1 } }));
  await ledger.append(event({ kind: "route.selected", at, route_id: "route1", candidate_id: "c0", role: "implementation", model: "m1", variant: "fast", reason: "implementation" }));
  await ledger.append(event({ kind: "wave.opened", at, wave_id: "w1", wave_index: 1, candidate_id: "c0" }));
  await ledger.append(event({ kind: "unit.opened", at, unit_id: "u1", wave_id: "w1", candidate_id: "c0", references: { capsule_ids: [capsuleId], artifact_ids: [] } }));
  await ledger.append(event({ kind: "attempt.started", at, attempt_id: "a1", predecessor_attempt_id: null, unit_id: "u1", candidate_id: "c0", route_id: "route1", role: "implementation", selected_model: "m1", selected_variant: "fast", child_id: null, call_id: "call1", budget_charge: { kind: "implementation", recovery_actions: 0, probe_iterations: 0, model_attempts: 0 } }));
  await ledger.append(event({ kind: "attempt.finished", at, attempt_id: "a1", observed_model: "m1-observed", observed_variant: "fast", failure: { category: "infrastructure", code: "worker-lost" }, disposition: "continue", observation: unknownObservation("unit"), references: { capsule_ids: [], artifact_ids: [] } }));
  await ledger.append(event({ kind: "recovery.recorded", at, recovery_id: "recovery1", failed_attempt_id: "a1", kind_detail: "model_rescue", candidate_id: "c0" }));
  const reopened = await RunFlightLedger.open(file, access);
  await reopened.append(event({ kind: "attempt.started", at, attempt_id: "a2", predecessor_attempt_id: "a1", unit_id: "u1", candidate_id: "c0", route_id: "route1", role: "rescue", selected_model: "m2", selected_variant: null, child_id: "child2", call_id: "call2", budget_charge: { kind: "model_rescue", recovery_actions: 1, probe_iterations: 0, model_attempts: 1 } }));
  await reopened.append(event({ kind: "attempt.finished", at, attempt_id: "a2", observed_model: null, observed_variant: null, failure: { category: "implementation", code: "still-failing" }, disposition: "continue", observation: unknownObservation("recovery"), references: { capsule_ids: [], artifact_ids: [] } }));
  await reopened.append(event({ kind: "recovery.recorded", at, recovery_id: "recovery2", failed_attempt_id: "a2", kind_detail: "adaptive_probe", candidate_id: "c0" }));
  const beforeRejected = await reopened.read();
  const bytesBeforeRejected = await readFile(file, "utf8");
  assert.deepEqual(beforeRejected.records.filter(({ event: entry }) => entry.kind === "attempt.started").map(({ event: entry }) => entry.kind === "attempt.started" ? [entry.attempt_id, entry.predecessor_attempt_id] : []), [["a1", null], ["a2", "a1"]]);
  assert.deepEqual(beforeRejected.records.filter(({ event: entry }) => entry.kind === "attempt.finished").map(({ event: entry }) => entry.kind === "attempt.finished" ? entry.failure : null), [{ category: "infrastructure", code: "worker-lost" }, { category: "implementation", code: "still-failing" }]);
  assert.deepEqual(beforeRejected.state.budget_consumed, { recovery_actions: 1, probe_iterations: 0, model_attempts: 1 });
  assert.equal(beforeRejected.state.observations[1].duration_ms, null);
  assert.equal(beforeRejected.state.observations[1].usage.input_tokens, null);
  assert.equal(beforeRejected.state.observations[1].estimated_cost.usd, null);
  await assert.rejects(reopened.append(event({ kind: "attempt.started", at, attempt_id: "a3", predecessor_attempt_id: "a2", unit_id: "u1", candidate_id: "c0", route_id: "route1", role: "advice", selected_model: "m3", selected_variant: null, child_id: null, call_id: "call3", budget_charge: { kind: "adaptive_probe", recovery_actions: 1, probe_iterations: 1, model_attempts: 0 } })), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "budget");
  assert.equal(await readFile(file, "utf8"), bytesBeforeRejected);
  const afterRejectedReopen = await (await RunFlightLedger.open(file, access)).read();
  assert.deepEqual(afterRejectedReopen.records, beforeRejected.records);
  assert.deepEqual(afterRejectedReopen.state.budget_consumed, beforeRejected.state.budget_consumed);
});

test("rejects missing, reordered, duplicate, and conflicting transitions", async () => {
  const { ledger, file, capsuleId } = await fixture("invalid-order");
  await assert.rejects(ledger.append(event({ kind: "wave.opened", at, wave_id: "w1", wave_index: 1, candidate_id: "c0" })), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "transition");
  await ledger.append(event({ kind: "run.planned", at, run_id: "run3", initial_candidate_id: "c0", budget_limits: { recovery_actions: 1, probe_iterations: 1, model_attempts: 1 } }));
  await ledger.append(event({ kind: "route.selected", at, route_id: "r1", candidate_id: "c0", role: "implementation", model: "m1", variant: null, reason: "planning" }));
  await assert.rejects(ledger.append(event({ kind: "wave.opened", at, wave_id: "w1", wave_index: 2, candidate_id: "c0" })), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "transition");
  const raw = JSON.parse(await readFile(file, "utf8")) as { events: unknown[] };
  raw.events.push(raw.events[0]);
  await writeFile(file, JSON.stringify(raw), "utf8");
  assert.throws(() => reconstructRunFlightLedger(raw.events as never[]), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "sequence");
  void capsuleId;
});

test("rejects undeclared capsules, out-of-scope capsule sources, unknown fields, and non-hash artifacts", async () => {
  const { ledger, file, access, capsuleId } = await fixture("scope");
  await ledger.append(event({ kind: "run.planned", at, run_id: "run4", initial_candidate_id: "c0", budget_limits: { recovery_actions: 1, probe_iterations: 1, model_attempts: 1 } }));
  await ledger.append(event({ kind: "route.selected", at, route_id: "r1", candidate_id: "c0", role: "implementation", model: "m1", variant: null, reason: "planning" }));
  await ledger.append(event({ kind: "wave.opened", at, wave_id: "w1", wave_index: 1, candidate_id: "c0" }));
  const undeclared = await RunFlightLedger.open(file, { ...access, declared_capsule_ids: [] });
  await assert.rejects(undeclared.append(event({ kind: "unit.opened", at, unit_id: "u1", wave_id: "w1", candidate_id: "c0", references: { capsule_ids: [capsuleId], artifact_ids: [] } })));
  const scoped = await RunFlightLedger.open(file, { ...access, authorized_source_paths: ["src/other.ts"] });
  await assert.rejects(scoped.append(event({ kind: "unit.opened", at, unit_id: "u2", wave_id: "w1", candidate_id: "c0", references: { capsule_ids: [capsuleId], artifact_ids: [] } })));
  await assert.rejects(ledger.append({ kind: "unit.opened", at, unit_id: "u3", wave_id: "w1", candidate_id: "c0", references: { capsule_ids: [], artifact_ids: [] }, metadata: { raw_log: "forbidden" } } as unknown as RunFlightEvent), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "invalid");
  await assert.rejects(ledger.append(event({ kind: "unit.opened", at, unit_id: "u4", wave_id: "w1", candidate_id: "c0", references: { capsule_ids: [], artifact_ids: ["raw-output"] } })), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "invalid");
});

test("persists rejected and accepted compile identities across reopen and keeps state unchanged after duplicate rejection", async () => {
  const { ledger, file, access } = await fixture("compile-decisions");
  await ledger.append(event({ kind: "run.planned", at, run_id: "run-plan", initial_candidate_id: "c0", budget_limits: { recovery_actions: 1, probe_iterations: 1, model_attempts: 1 } }));
  const base: AcceptanceCompileProposal = {
    version: "0.1", provenance: { producer: "dog-coordinator", acceptance_fingerprint: digest("a"), capsule_inputs_exclude_secrets: true },
    unit_ids: ["u1"], declared_capsule_ids: [], acceptance_items: [{ acceptance_id: "item1", observable_criterion: "observable" }],
    validations: [{ validation_id: "v1", unit_id: "u1", command_fingerprint: digest("b"), references: { capsule_ids: [], artifact_ids: [digest("c")] } }], coverage: [],
  };
  const rejected = compileAcceptanceCoverage(base);
  assert.equal(rejected.status, "rejected");
  await ledger.appendCompileResult(rejected, at);
  const accepted = compileAcceptanceCoverage({ ...base, coverage: [{ acceptance_id: "item1", unit_id: "u1", validation_ids: ["v1"] }] });
  assert.equal(accepted.status, "accepted");
  const acceptedState = await ledger.appendCompileResult(accepted, at);
  assert.deepEqual(acceptedState.plan_decisions.map(({ decision, plan_id }) => ({ decision, plan_id })), [
    { decision: "rejected", plan_id: rejected.plan_id }, { decision: "accepted", plan_id: accepted.plan_id },
  ]);
  const before = await readFile(file, "utf8");
  await assert.rejects(ledger.appendCompileResult(accepted, at), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "transition");
  assert.equal(await readFile(file, "utf8"), before);
  const reopened = await RunFlightLedger.open(file, access);
  assert.deepEqual((await reopened.read()).state.plan_decisions, acceptedState.plan_decisions);
  assert.equal(before.includes("observable"), false);
});
