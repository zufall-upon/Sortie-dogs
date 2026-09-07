import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EvidenceCapsuleStore } from "../dist/core/evidence-capsule.js";
import { RunFlightLedger, type FlightObservation, type RunFlightEvent } from "../dist/core/run-flight-ledger.js";
import { TerminalRescueRuntime, type TerminalRescueHost, type TerminalRescueRequest } from "../dist/core/terminal-rescue-runtime.js";
import { CHILD_TERMINAL_EVIDENCE_FIELDS } from "../dist/core/child-terminal-reconciliation.js";
import { terminalRescueModel } from "../dist/plugin/terminal-rescue-binding.js";
import { createModelRoutingHook } from "../dist/plugin/model-routing-hook.js";

const at = "2026-09-07T00:00:00Z";
const refs = { capsule_ids: [], artifact_ids: [] };
const observation: FlightObservation = { stage: "recovery", duration_ms: 1,
  usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
  estimated_cost: { usd: 0, provenance: "calculated" } };
const evidence = Object.fromEntries(CHILD_TERMINAL_EVIDENCE_FIELDS.map((name) => [name, "satisfied"])) as
  Record<(typeof CHILD_TERMINAL_EVIDENCE_FIELDS)[number], "satisfied">;
const request: TerminalRescueRequest = { unit_id: "unit", failed_attempt_id: "remediation", explicit_override: false,
  accepted_base: { candidate_id: "candidate", contract_id: "contract", scope: ["output.ts"], acceptance: ["behavior"], validation: ["node test.mjs"] },
  budget_request: { counters: { recovery_actions: 1, probe_iterations: 0, model_attempts: 1 }, resources: { time_ms: 1000, cost_usd: 1 } } };

async function fixture(failure: "implementation" | "infrastructure" = "implementation", terminal = true, budgetKnown = true) {
  const directory = await mkdtemp(join(tmpdir(), "terminal-rescue-runtime-"));
  const path = join(directory, ".sortie-dogs", "flight.json");
  const access = { store: new EvidenceCapsuleStore(join(directory, "capsules")), declared_capsule_ids: [], authorized_source_paths: [] };
  const ledger = await RunFlightLedger.open(path, access);
  const initial: RunFlightEvent[] = [
    { kind: "run.planned", at, run_id: "run", initial_candidate_id: "candidate",
      budget_limits: { recovery_actions: 5, probe_iterations: 2, model_attempts: 5 }, resource_budget_limits: { time_ms: 10000, cost_usd: 10 } },
    { kind: "route.selected", at, route_id: "route", candidate_id: "candidate", role: "implementation", model: "test/sol", variant: null, reason: "implementation" },
    { kind: "wave.opened", at, wave_id: "wave", wave_index: 1, candidate_id: "candidate" },
    { kind: "unit.opened", at, unit_id: "unit", wave_id: "wave", candidate_id: "candidate", references: refs },
  ];
  for (const event of initial) await ledger.append(event);
  for (const [attempt_id, predecessor_attempt_id, kind] of [
    ["implementation", null, "implementation"], ["remediation", "implementation", "normal_remediation"],
  ] as const) {
    await ledger.append({ kind: "attempt.started", at, attempt_id, predecessor_attempt_id, unit_id: "unit", candidate_id: "candidate",
      route_id: "route", role: "implementation", selected_model: "test/sol", selected_variant: null,
      child_id: `child-${attempt_id}`, call_id: `call-${attempt_id}`, budget_charge: { kind, recovery_actions: kind === "implementation" ? 0 : 1,
        probe_iterations: 0, model_attempts: 1 }, resource_budget_request: { time_ms: 1000, cost_usd: 1 } });
    await ledger.append({ kind: "attempt.finished", at, attempt_id, observed_model: "test/sol", observed_variant: null,
      disposition: kind === "implementation" ? "continue" : "failed", failure: { category: failure, code: "tests_failed" },
      observation: budgetKnown || kind === "implementation" ? observation
        : { ...observation, estimated_cost: { usd: null, provenance: "unknown" } }, references: refs });
  }
  const identity = { run_id: "run", unit_id: "unit", attempt_id: "remediation", predecessor_attempt_id: "implementation",
    candidate_id: "candidate", route_id: "route", child_id: "child-remediation", call_id: "call-remediation" };
  await ledger.append({ kind: "child.registered", at, identity, deadline_ms: 1 });
  if (terminal) await ledger.append({ kind: "child.terminal", at, identity, disposition: "failed", evidence });
  await ledger.append({ kind: "validation.recorded", at, validation_id: "canonical", unit_id: "unit", command_fingerprint: `sha256:${"a".repeat(64)}`,
    result: "failed", artifact_id: null });
  return { directory, ledger, reopen: () => RunFlightLedger.open(path, access), close: () => rm(directory, { recursive: true, force: true }) };
}

function host(directory: string) {
  let starts = 0;
  const runtime: TerminalRescueHost = {
    availableTarget: async () => ({ model: "test/astra", variant: null }),
    start: async (attempt) => {
      starts++;
      assert.deepEqual(attempt.terminal_rescue_contract, request.accepted_base);
      const identity = { run_id: "run", unit_id: "unit", attempt_id: attempt.attempt_id, predecessor_attempt_id: "remediation",
        candidate_id: "candidate", route_id: "route", child_id: "child-rescue", call_id: attempt.call_id };
      return { child_id: identity.child_id, begin: async () => {
        const input = { owner_root: directory, session_id: identity.child_id,
          binding: { ledger_path: ".sortie-dogs/flight.json", attempt_id: attempt.attempt_id },
          scope_write: request.accepted_base.scope, acceptance: request.accepted_base.acceptance, validation: request.accepted_base.validation };
        const target = await terminalRescueModel(input);
        await assert.rejects(terminalRescueModel({ ...input, session_id: "foreign-child" }), /rescue-attempt-inactive/);
        await assert.rejects(terminalRescueModel({ ...input, scope_write: ["outside.ts"] }), /rescue-contract-drift/);
        const route = createModelRoutingHook({ catalog: {}, freeTierFallbackModels: [] },
          { v2: { model: { list: async () => ({ data: [{ providerID: "test", id: "astra", enabled: true }] }) } } });
        const output = { message: { agent: "dog-worker", model: { providerID: "test", modelID: "sol" } }, parts: [] };
        await route({ sessionID: identity.child_id, agent: "dog-worker" }, output, { terminalRescueTarget: target });
        assert.deepEqual(output.message.model, { providerID: "test", modelID: "astra" });
        const unavailable = createModelRoutingHook({ catalog: {}, freeTierFallbackModels: [] },
          { v2: { model: { list: async () => ({ data: [] }) } } });
        await assert.rejects(unavailable({ sessionID: identity.child_id, agent: "dog-worker" }, output,
          { terminalRescueTarget: target }), /Model routing denied/);
      }, runtime: {
        observe: async () => ({ observation: { identity, disposition: "succeeded" }, evidence }),
        stop: async () => { throw new Error("unexpected stop"); }, release: async () => {}, terminal: async () => {},
      }, completion: Promise.resolve({ disposition: "succeeded", observed_model: null, observed_variant: null,
        observation, failure: null, references: refs }) };
    },
  };
  return { runtime, starts: () => starts };
}

test("terminal rescue reserves before dispatch, preserves authority, and counts an actual rescue child", async () => {
  const value = await fixture();
  try {
    const worker = host(value.directory);
    const result = await new TerminalRescueRuntime(value.ledger, worker.runtime).execute(request);
    assert.equal(result.status, "finished");
    if (result.status !== "finished") assert.fail("rescue did not finish");
    assert.equal(result.attempt.selected_model, "test/astra");
    assert.equal(result.outcome.observed_model, null, "selected model is not fabricated observation");
    assert.equal(result.candidate_gates, "validation_review_cas_required");
    const { records, state } = await value.ledger.read();
    assert.equal(state.current_candidate_id, "candidate");
    assert.equal(state.child_counts.rescue, 1);
    assert.equal(state.budget_consumed.model_attempts, 3);
    assert.equal(records.some(({ event }) => event.kind === "candidate.advanced"), false);
    const again = await new TerminalRescueRuntime(await value.reopen(), worker.runtime).execute(request);
    assert.equal(again.status, "existing");
    assert.deepEqual(await new TerminalRescueRuntime(value.ledger, worker.runtime).execute({ ...request,
      accepted_base: { ...request.accepted_base, scope: ["outside.ts"] } }),
    { status: "non_rescue", reason: "rescue_contract_changed" });
    assert.equal(worker.starts(), 1);
  } finally { await value.close(); }
});

test("concurrent rescue requests cannot launch two workers", async () => {
  const value = await fixture();
  try {
    const worker = host(value.directory);
    const results = await Promise.allSettled([
      new TerminalRescueRuntime(value.ledger, worker.runtime).execute(request),
      new TerminalRescueRuntime(await value.reopen(), worker.runtime).execute(request),
    ]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled" && entry.value.status === "finished").length, 1);
    assert.equal(worker.starts(), 1);
    assert.equal((await value.ledger.read()).state.child_counts.rescue, 1);
  } finally { await value.close(); }
});

test("non-quality failure, unreleased predecessor, unavailable target, override and unknown or exhausted budgets do not dispatch", async () => {
  for (const reason of ["infrastructure_failure", "terminal_not_reconciled", "target_unavailable", "explicit_override", "budget_unknown", "budget_exhausted"]) {
    const value = await fixture(reason === "infrastructure_failure" ? "infrastructure" : "implementation",
      reason !== "terminal_not_reconciled", reason !== "budget_unknown");
    try {
      const worker = host(value.directory);
      if (reason === "target_unavailable") worker.runtime.availableTarget = async () => null;
      const before = await value.ledger.read();
      const input = structuredClone(request);
      const result = await new TerminalRescueRuntime(value.ledger, worker.runtime).execute({ ...input,
        explicit_override: reason === "explicit_override",
        ...(reason === "budget_exhausted" ? { budget_request: { ...input.budget_request, resources: { time_ms: 100000, cost_usd: 100 } } } : {}) });
      assert.deepEqual(result, { status: "non_rescue", reason });
      assert.equal(worker.starts(), 0);
      assert.deepEqual(await value.ledger.read(), before);
    } finally { await value.close(); }
  }
});

test("a stalled host is bounded and a restart cannot launch the reserved attempt again", async () => {
  const value = await fixture();
  try {
    let calls = 0, aborted = false;
    const worker: TerminalRescueHost = { availableTarget: async () => ({ model: "test/astra", variant: null }),
      start: async (_attempt, signal) => {
        calls++;
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise(() => {});
      } };
    const result = await new TerminalRescueRuntime(value.ledger, worker).execute({ ...request,
      budget_request: { ...request.budget_request, resources: { time_ms: 100, cost_usd: 1 } } });
    assert.equal(result.status, "waiting");
    if (result.status !== "waiting") assert.fail("stalled host was not bounded");
    assert.equal(result.reason, "host_deadline_pending");
    assert.equal(aborted, true);
    const restarted = new TerminalRescueRuntime(await value.reopen(), worker);
    assert.equal((await restarted.execute(request)).status, "existing");
    assert.equal(calls, 1);
    assert.equal((await value.ledger.read()).state.child_counts.rescue, 0, "no host child was observed");
  } finally { await value.close(); }
});
