import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";
import { evidenceFromObservedExecution } from "../dist/core/observed-goal-evidence.js";

test("Reviewer correction validation inherits current unit inputs without resurrecting retired review scope", async () => {
  const { fixture, initial } = await import("./helpers/reviewer-correction-fixture.ts");
  const f = await fixture(), external = await mkdtemp(resolve("_testenv/retired-review-input-"));
  try {
    const prior = await initial(f, { keepReviewOpen: true });
    await writeFile(join(external, "old.mjs"), "// unrelated historical input\n");
    await mkdir(join(f.directory, "retired"));
    await symlink(join(external, "old.mjs"), join(f.directory, "retired", "old.mjs"));
    // Model a saved earlier estimate already replaced by the current, validated unit declaration.
    await f.missions.update("root", mission => { mission.reviewScope = {
      read: [...prior.run.units[0]!.unit.read, "retired/**"], write: [...prior.run.units[0]!.unit.write, "retired-output/**"],
    }; });
    await f.tool("author", "repair_review", { findings: "Medium: result.txt must contain ready, not wrong." });
    const current = await f.run();
    assert.deepEqual(current.units[0]!.unit.read, prior.run.units[0]!.unit.read);
    assert.deepEqual(current.units[0]!.unit.write, prior.run.units[0]!.unit.write);
    assert.ok((await f.missions.required("root")).reviewScope!.read.includes("retired/**"), "historical Review context is retained, not reused as current validation authority");
    await f.shell("author", "node check.mjs");
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks?.[0]?.fresh, true, "current native check binds despite the unrelated retired symlink");
  } finally { await f.dispose(); await rm(external, { recursive: true, force: true }); }
});

for (const actor of ["root", "coordinator"]) for (const interruption of ["none", "accepted", "binding"]) test(`queued Mission after terminal: ${actor} ${interruption}`, async t => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/queued-registration-"));
  try {
    const agents: Record<string, object> = { root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" } };
    const history: Record<string, object[]> = {};
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }), children: async () => ({ data: [] }),
    } } } as never);
    let hooks = await create();
    const tool = async (id: string, name: string, args: object = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: id }));
    const chat = async (id: string, text: string, messageID: string, agent = "dog-operator") => {
      const message = { info: { id: messageID, sessionID: id, role: "user", agent, time: { created: Date.now() } }, parts: [{ type: "text", text }] };
      (history[id] ??= []).push(message);
      await hooks["chat.message"]!({ sessionID: id, messageID, agent }, {
        message: { id: messageID, agent, model: { providerID: "openai", modelID: "gpt-6.1-sol" } }, parts: message.parts,
      });
    };
    await chat("root", "Complete A, then process my pending requests", "request-a");
    await tool("root", "start_mission", { requirements: ["Complete A"] });
    const ledgerPath = join(directory, ".sortie-dogs-v010/run-flight", `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
    const ledger = await RunFlightLedger.openGoal(ledgerPath);
    const initial = (await ledger.readGoal()).state, at = new Date().toISOString(), goalID = initial.goal_id!;
    const criterion = { criterion_id: "a", target: "A", entrypoint: "check A", workload: "A", oracle_coverage: ["A"],
      build_boundary: "included" as const, source: "source", candidate: "candidate", fixture: "A", validation_command: "check A", proof_scope: "requested-full" as const, expected_outcome: "pass" as const };
    // Construct the saved predecessor state, not 28 new native model/test executions.
    for (let revision = 2; revision <= 27; revision++) await ledger.appendGoal({ kind: "goal.revised", at, goal_id: goalID,
      revision, scope_epoch: revision, acceptance_fingerprint: goalFingerprint("A"), origin_user_message_id: "request-a",
      session_id: "root", selected_agent: "dog-coordinator", delivery: "mvp-first", budget: initial.budget!, acceptance_contract: { criteria: [criterion] } });
    for (let i = 0; i < 28; i++) {
      const state = await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: goalID, unit_id: `a-${i}`, reservation_id: `a-${i}`, session_id: "root", ticket_id: null });
      const evidence = i === 27 ? evidenceFromObservedExecution({ owner: "coordinator", immutableRef: goalFingerprint("saved A"), command: ["check A"],
        startedAt: at, endedAt: at, exitCode: 0, outcome: "pass", fresh: true, source: "source", candidate: "candidate",
        binding: { manifest_hash: goalFingerprint("fixture manifest"), project_root: directory, manifest_path: "fixture.json", source_paths: [], candidate_paths: [] } }, state, `a-${i}`) : [];
      await ledger.appendGoal({ kind: "unit.settled", at, goal_id: goalID, unit_id: `a-${i}`, reservation_id: `a-${i}`, receipt_id: `a-${i}`,
        ...(i === 0 ? { native_session_id: "a-author" } : {}),
        disposition: i === 27 ? "succeeded" : "failed", result_class: "process-defect", progress_fingerprint: evidence.length ? goalFingerprint(evidence) : null,
        evidence, elapsed_ms: 17, cost_usd: actor === "root" && i === 0 ? null : 0.25 });
    }
    await chat("root", "Process the separately requested B", "request-b");
    const state = (await ledger.readGoal()).state;
    const receipt = { goal_id: goalID, terminal_revision: 27, acceptance_fingerprint: state.acceptance_fingerprint!,
      started_at: initial.goal_id ? (await ledger.readGoal()).records[0]!.event.at : at, ended_at: new Date().toISOString(),
      status: "succeeded" as const, stop_reason: "completed" as const, unit_ids: state.unit_ids, session_ids: state.session_ids, evidence_refs: state.evidence_refs, milestone_at: null };
    await ledger.appendGoal({ kind: "goal.terminal", at: receipt.ended_at, goal_id: goalID, receipt });
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.update("root", mission => { mission.phase = "completed"; });
    const prior = await ledger.readGoal();
    const started = await tool("root", "start_mission", { intent: "replace", requirements: ["Process B"] });
    if (actor === "coordinator") {
      await hooks["tool.execute.before"]!({ sessionID: "root", callID: "coordinator-call", tool: "task" }, { args: structuredClone(started.task) });
      await chat("coordinator", started.task.prompt, "coordinator-request", "dogs-coordinator");
    }
    const missionBefore = await missions.required("root");
    const plan = { executor: "worker", units: [{ title: "B", objective: "Process B", read: [], write: ["result.txt"], validation: ["node check.mjs"] }] };
    const append = RunFlightLedger.prototype.appendGoal, update = OperatorMissionRuntime.prototype.update;
    if (actor === "root" && interruption === "none") {
      const accepted = { kind: "goal.queued-accepted" as const, at, goal_id: "goal-b", revision: 1 as const, scope_epoch: 1 as const,
        acceptance_fingerprint: goalFingerprint("B"), origin_user_message_id: "request-b", origin_session_id: "root", selected_agent: "dog-coordinator",
        delivery: "mvp-first" as const, budget: state.budget!, acceptance_contract: null,
        queued_from: { goal_id: goalID, receipt_fingerprint: goalFingerprint(receipt), mission_id: missionBefore.id, request_fingerprint: goalFingerprint(missionBefore.requests[0]) } };
      for (const change of [{ budget: { ...state.budget!, max_units: 64 } }, { budget: { ...state.budget!, max_units: 4 } },
        { queued_from: { ...accepted.queued_from, receipt_fingerprint: goalFingerprint("wrong receipt") } }]) {
        await assert.rejects(ledger.appendGoal({ ...accepted, ...change }), /exact settled terminal budget predecessor/);
        assert.deepEqual(await ledger.readGoal(), prior);
      }
      await assert.rejects(ledger.appendGoal({ ...accepted, origin_user_message_id: "request-a" }), /Accepted goal conflicts with its durable user message identity/);
      assert.deepEqual(await ledger.readGoal(), prior);
      const native = history.root![1] as { info: { sessionID: string; role: string }; parts: { type: string; text: string; synthetic?: boolean }[] };
      const original = structuredClone(native);
      // Exact native request identity, not a model-authored ID or same-looking text, is authority.
      for (const defect of ["missing", "foreign", "assistant", "synthetic", "changed"] as const) {
        Object.assign(native, structuredClone(original));
        if (defect === "missing") history.root = [history.root![0]!];
        if (defect === "foreign") native.info.sessionID = "other-root";
        if (defect === "assistant") native.info.role = "assistant";
        if (defect === "synthetic") native.parts[0]!.synthetic = true;
        if (defect === "changed") native.parts[0]!.text = "unrelated content";
        await assert.rejects(tool(actor, "plan_units", plan), /mission-goal-request-native-proof-unavailable/, defect);
        assert.deepEqual(await ledger.readGoal(), prior);
        history.root = [history.root![0]!, native];
      }
      Object.assign(native, original);
    }
    let injected = false;
    if (interruption === "accepted") t.mock.method(RunFlightLedger.prototype, "appendGoal", async function (this: RunFlightLedger, event: Parameters<typeof append>[0]) {
      const result = await append.call(this, event);
      if (event.kind === "goal.queued-accepted" && !injected) { injected = true; throw new Error("injected-after-accept"); }
      return result;
    });
    if (interruption === "binding") t.mock.method(OperatorMissionRuntime.prototype, "update", function (this: OperatorMissionRuntime, root: string, mutate: Parameters<typeof update>[1]) {
      return update.call(this, root, mission => { const before = mission.runID; mutate(mission);
        if (mission.runID !== before && !injected) { injected = true; throw new Error("injected-binding"); } });
    });
    if (interruption !== "none") {
      await assert.rejects(tool(actor, "plan_units", plan), /injected-/);
      t.mock.restoreAll();
      const prepared = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(prepared.phase, "prepared"); assert.equal(prepared.units[0]!.status, "pending");
      await assert.rejects(tool(actor, "start_direct_unit"), /mission-run-registration-incomplete/);
      hooks = await create();
      await tool(actor, "plan_units", plan);
      const recovered = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(recovered.runID, prepared.runID); assert.equal(recovered.planHash, prepared.planHash);
      assert.deepEqual(recovered.units[0]!.hashes, prepared.units[0]!.hashes);
    } else await tool(actor, "plan_units", plan);
    const registered = await ledger.readGoal(), missionAfter = await missions.required("root");
    assert.equal(missionAfter.id, missionBefore.id); assert.deepEqual(missionAfter.requests, missionBefore.requests);
    assert.deepEqual(missionAfter.requirements, missionBefore.requirements);
    assert.notEqual(registered.state.goal_id, goalID); assert.equal(registered.state.origin_user_message_id, "request-b");
    assert.equal(registered.state.consumed_units, 28); assert.equal(registered.state.budget!.max_units, 32);
    assert.equal(registered.state.outstanding_reservations.length, 0); assert.equal(registered.state.consumed_time_ms, prior.state.consumed_time_ms);
    assert.equal(registered.state.consumed_cost_usd, actor === "root" ? null : 7, "predecessor usage, including unknown cost, is retained");
    assert.deepEqual(registered.records.slice(0, prior.records.length), prior.records, "old receipt, failures, evidence and hashes remain byte-for-byte bound");
    assert.equal(registered.records.filter(({ event }) => event.kind === "goal.queued-accepted").length, 1);
    assert.deepEqual(registered.state.satisfied_criteria, [], "A's passing evidence is not B's proof");
    assert.deepEqual(registered.state.unit_ids, []);
    // A normal registration retry must reuse the prepared run and consume no extra budget.
    const run = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    await tool(actor, "plan_units", plan);
    assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).runID, run.runID);
    assert.deepEqual((await ledger.readGoal()).records, registered.records);
    if (actor === "coordinator" && interruption === "none") {
      await assert.rejects(tool(actor, "plan_units", { executor: "worker", reason: "Exercise retained remaining allowance", units:
        Array.from({ length: 5 }, (_, i) => ({ ...plan.units[0], title: `B-${i}`, validation: [`node check-${i}.mjs`] })) }),
      /mission-budget-exhausted: plan needs 5 units; 4 remain/);
      assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).runID, run.runID);
    }
    const currentGoalID = registered.state.goal_id!;
    if (interruption === "none") {
      if (actor === "root") {
        agents.holder = { agent: "dog-operator" };
        await chat("holder", "Hold the fixture output", "holder-request");
        await tool("holder", "start_mission", { requirements: ["Hold the fixture output"] });
        await tool("holder", "plan_units", { ...plan, executor: "self" });
        await assert.rejects(tool(actor, "start_direct_unit"), /mission-direct-activation:manifest-overlap/);
        assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("holder")).units[0]!.status, "running");
        await tool("holder", "submit_mission", { status: "blocked", summary: "Fixture holder releases its own unvalidated unit" });
      }
      assert.equal((await tool(actor, "start_direct_unit")).status, "direct-unit-running");
      const admitted = await ledger.readGoal();
      assert.equal(admitted.state.consumed_units, 28); assert.equal(admitted.state.outstanding_reservations.length, 1);
      await tool(actor, "submit_mission", { status: "blocked", summary: "Fixture admission is not completed B validation" });
      assert.equal((await ledger.readGoal()).state.consumed_units, 29);
      return;
    }
    await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: currentGoalID, unit_id: "b-cost", reservation_id: "b-cost", session_id: "root", ticket_id: null });
    await ledger.appendGoal({ kind: "unit.settled", at, goal_id: currentGoalID, unit_id: "b-cost", reservation_id: "b-cost", receipt_id: "b-cost",
      native_session_id: "b-author", disposition: "failed", result_class: "process-defect", progress_fingerprint: null, evidence: [], elapsed_ms: 5, cost_usd: null });
    const priced = await ledger.appendGoal({ kind: "unit.usage-reconciled", at, goal_id: currentGoalID, reservation_id: "b-cost", native_session_id: "b-author",
      source: "native-usage-price-table", cost_usd: 0.5 });
    assert.equal(priced.consumed_units, 29); assert.equal(priced.consumed_cost_usd, actor === "root" ? null : 7.5);
    if (actor === "root" && interruption === "binding") {
      const beforePricing = await ledger.readGoal();
      history["a-author"] = [{ info: { id: "late-a-usage", role: "assistant", providerID: "openai", modelID: "gpt-6-luna-fast",
        time: { created: 2000, completed: 3000 }, tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } }];
      const status = await tool("root", "operator_status");
      assert.equal(status.budget.settled_cost_usd, 7.2503, "late A usage must reconcile the inherited budget, including B's own cost");
      assert.equal(status.budget.consumed_units, 29); assert.equal(status.budget.reserved_units, 0);
      const afterPricing = await ledger.readGoal();
      assert.deepEqual(afterPricing.records.slice(0, beforePricing.records.length), beforePricing.records);
      assert.deepEqual(afterPricing.records.slice(beforePricing.records.length).map(({ event }) => [event.kind, event.goal_id]),
        [["unit.usage-reconciled", goalID]], "only append predecessor pricing; never rewrite A's receipt or B's acceptance/evidence");
      assert.equal(afterPricing.state.goal_id, currentGoalID); assert.deepEqual(afterPricing.state.satisfied_criteria, []);
      await tool("root", "operator_status");
      assert.deepEqual(await ledger.readGoal(), afterPricing, "repeated status cannot price A twice");
      await assert.rejects(ledger.appendGoal({ kind: "unit.usage-reconciled", at, goal_id: goalID, reservation_id: "a-0",
        native_session_id: "wrong-author", source: "native-usage-price-table", cost_usd: 0.0003 }), /Usage reconciliation/);
    }
    if (actor === "root" && interruption === "accepted") {
      await tool("root", "start_mission", { intent: "replace", requirements: ["Do not accept B a second time"] });
      await assert.rejects(tool("root", "plan_units", plan), /mission-goal-request-already-accepted/);
      assert.deepEqual((await ledger.readGoal()).state, priced);
    }
    for (let i = 0; i < 3; i++) await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: currentGoalID,
      unit_id: `b-limit-${i}`, reservation_id: `b-limit-${i}`, session_id: "root", ticket_id: null });
    await assert.rejects(ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: currentGoalID,
      unit_id: "b-over-limit", reservation_id: "b-over-limit", session_id: "root", ticket_id: null }), /Goal unit budget exhausted/);
    await assert.rejects(ledger.appendGoal({ kind: "goal.revised", at, goal_id: goalID, revision: 28, scope_epoch: 28,
      acceptance_fingerprint: state.acceptance_fingerprint!, origin_user_message_id: "request-b", session_id: "root", selected_agent: "dog-coordinator",
      delivery: "mvp-first", budget: state.budget!, acceptance_contract: state.acceptance_contract }), /Goal identity mismatch/);
    if (actor === "root" && interruption === "binding") {
      for (let i = 0; i < 3; i++) await ledger.appendGoal({ kind: "unit.settled", at, goal_id: currentGoalID,
        unit_id: `b-limit-${i}`, reservation_id: `b-limit-${i}`, receipt_id: `b-limit-${i}`, native_session_id: "b-unpriced",
        disposition: "cancelled", result_class: "interrupted", progress_fingerprint: null, evidence: [], elapsed_ms: 1, cost_usd: null });
      const stopped = (await ledger.readGoal()).state;
      await ledger.appendGoal({ kind: "goal.terminal", at, goal_id: currentGoalID, receipt: { ...receipt,
        goal_id: currentGoalID, terminal_revision: stopped.revision, acceptance_fingerprint: stopped.acceptance_fingerprint!,
        status: "stopped", stop_reason: "stopped", unit_ids: stopped.unit_ids, session_ids: stopped.session_ids, evidence_refs: stopped.evidence_refs } });
      await ledger.appendGoal({ kind: "goal.accepted", at, goal_id: "ordinary-new-goal", revision: 1, scope_epoch: 1,
        acceptance_fingerprint: goalFingerprint("ordinary new request"), origin_user_message_id: "ordinary-new-request",
        origin_session_id: "root", selected_agent: "dog-coordinator", delivery: "mvp-first", budget: initial.budget!, acceptance_contract: null });
      assert.equal((await tool("root", "operator_status")).budget.settled_cost_usd, 0, "ordinary acceptance still starts a separate budget");
      const independent = await ledger.readGoal();
      await assert.rejects(ledger.appendGoal({ kind: "unit.usage-reconciled", at, goal_id: currentGoalID, reservation_id: "b-limit-0",
        native_session_id: "b-unpriced", source: "native-usage-price-table", cost_usd: 0.25 }), /Goal identity mismatch/);
      assert.deepEqual(await ledger.readGoal(), independent, "pricing an unrelated previous budget cannot mutate the new goal");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const stage of ["goal", "binding"]) test(`prepared Mission ${stage} failure resumes the same run without premature admission`, async t => {
  const directory = await mkdtemp(resolve("_testenv/partial-registration-"));
  try {
    const agents: Record<string, object> = { root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" } };
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      messages: async () => ({ data: [] }), children: async () => ({ data: [] }),
    } } } as never);
    let hooks = await create();
    const tool = async (name: string, args: object = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
    await hooks["chat.message"]!({ sessionID: "root", messageID: "original", agent: "dog-operator" }, {
      message: { id: "original", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
      parts: [{ type: "text", text: "Write result and validate it" }],
    });
    await tool("start_mission", { requirements: ["Write result and validate it"] });
    const ledgerPath = join(directory, ".sortie-dogs-v010/run-flight", `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
    const ledger = await RunFlightLedger.openGoal(ledgerPath), goalID = (await ledger.readGoal()).state.goal_id!;
    const at = new Date().toISOString();
    await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: goalID, unit_id: "prior", reservation_id: "prior", session_id: "root", ticket_id: null });
    await ledger.appendGoal({ kind: "unit.settled", at, goal_id: goalID, unit_id: "prior", reservation_id: "prior", receipt_id: "prior-receipt",
      disposition: "failed", result_class: "process-defect", progress_fingerprint: null, evidence: [], elapsed_ms: 17, cost_usd: 0.25 });
    let injected = 0;
    const append = RunFlightLedger.prototype.appendGoal, update = OperatorMissionRuntime.prototype.update;
    if (stage === "goal") t.mock.method(RunFlightLedger.prototype, "appendGoal", async function (this: RunFlightLedger, event: Parameters<typeof append>[0]) {
      if (event.kind === "goal.revised" && injected++ < 2) throw new Error("injected-goal-failure");
      return append.call(this, event);
    });
    else t.mock.method(OperatorMissionRuntime.prototype, "update", function (this: OperatorMissionRuntime, root: string, mutate: Parameters<typeof update>[1]) {
      return update.call(this, root, state => {
        const prior = state.runID; mutate(state);
        if (state.runID !== prior && injected++ < 2) throw new Error("injected-binding-failure");
      });
    });
    const plan = { executor: stage === "goal" ? "self" : "worker", units: [{ title: "Write result", objective: "Write result and validate it",
      read: [], write: ["result.txt"], validation: ["node check.mjs"] }] };
    await assert.rejects(tool("plan_units", plan), new RegExp(`injected-${stage}-failure`));
    await assert.rejects(tool("plan_units", plan), new RegExp(`injected-${stage}-failure`));
    t.mock.restoreAll();
    const runtime = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const before = await runtime().required("root");
    const ledgerBefore = await RunFlightLedger.readGoalFile(ledgerPath);
    assert.equal(before.phase, "prepared"); assert.equal(before.units[0]!.status, "pending");
    await assert.rejects(tool("start_direct_unit"), /mission-run-registration-incomplete/);
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "root", callID: "premature", tool: "task" },
      { args: structuredClone(runtime().nextWorkerTask(before)) }), /mission-run-registration-incomplete/);
    assert.deepEqual(await runtime().required("root"), before, "neither admission mutated the prepared run");
    // Reload the public plugin, not a private recovery helper. Same declaration completes the missing stage.
    hooks = await create();
    const resumed = await tool("plan_units", plan), after = await runtime().required("root");
    assert.equal(after.runID, before.runID); assert.equal(after.planHash, before.planHash);
    assert.deepEqual(after.units[0]!.hashes, before.units[0]!.hashes);
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).runID, before.runID);
    const registered = await RunFlightLedger.readGoalFile(ledgerPath);
    assert.equal(registered.state.goal_id, ledgerBefore.state.goal_id);
    assert.equal(registered.state.origin_user_message_id, "original");
    assert.equal(registered.state.consumed_units, ledgerBefore.state.consumed_units);
    assert.equal(registered.state.consumed_units, 1); assert.equal(registered.state.consumed_time_ms, 17);
    assert.equal(registered.state.consumed_cost_usd, 0.25);
    assert.deepEqual(registered.state.validation_budget, ledgerBefore.state.validation_budget);
    assert.equal(registered.records.filter(({ event }) => event.kind === "goal.revised").length, 1);
    if (stage === "binding") {
      assert.ok(resumed.task);
      await hooks["tool.execute.before"]!({ sessionID: "root", callID: "normal", tool: "task" }, { args: structuredClone(resumed.task) });
    } else {
      assert.equal(resumed.status, "direct-unit-running");
      assert.equal((await tool("start_direct_unit")).run_id, before.runID);
    }
    const final = await runtime().required("root");
    assert.equal(final.units[0]!.status, "running");
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).plans, 1);
    assert.equal((await RunFlightLedger.readGoalFile(ledgerPath)).records.filter(({ event }) => event.kind === "goal.revised").length, 1);
    assert.equal((await RunFlightLedger.readGoalFile(ledgerPath)).state.outstanding_reservations.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const readOnly of [false, true]) test(`returned recoverable mission Worker releases overlap for serial ${readOnly ? "reader" : "writer"}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/serial-binding-"));
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  try {
    await writeFile(join(directory, "check.mjs"), "console.log('check');\n");
    await writeFile(join(directory, "result.txt"), "old result\n");
    const identities: Record<string, object> = { root: { agent: "dog-operator" },
      coordinator: { agent: "dogs-coordinator", parentID: "root" },
      old: { agent: "dog-worker-v010", parentID: "coordinator" }, next: { agent: "dog-worker-v010", parentID: "coordinator" } };
    const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async () => ({ data: [] }), messages: async () => ({ data: [] }),
    } } } as never);
    const tool = async (name: string, sessionID: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID }));
    const chat = (sessionID: string, text: string, agent: string) => hooks["chat.message"]!({ sessionID, messageID: sessionID + "-user", agent },
      { message: { id: sessionID + "-user", agent, model: { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }] });
    const dispatch = (sessionID: string, callID: string, task: object) => hooks["tool.execute.before"]!({ sessionID, callID, tool: "task" }, { args: structuredClone(task) });
    const inspect = async (sessionID: string, path: string, callID: string) => {
      const args = { filePath: path };
      await hooks["tool.execute.before"]!({ sessionID, callID, tool: "read" }, { args });
      const source = await readFile(path, "utf8"), output = { output: source, status: "completed" as const };
      await hooks["tool.execute.after"]!({ sessionID, callID, tool: "read", args }, output);
      assert.equal(output.output, source, "legacy Read presents the actual full file, not a fictional inspection result");
    };
    // This is an external observer of the plugin-owned runtime. A retained instance caches
    // its first run and cannot observe a later plan written by the plugin's different instance.
    const run = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    const ledger = () => RunFlightLedger.readGoalFile(join(directory, ".sortie-dogs-v010", "run-flight",
      `${createHash("sha256").update("v010\0root").digest("hex")}.json`));
    await chat("root", "Run the procedure", "dog-operator");
    const start = await tool("start_mission", "root", { requirements: ["Run procedure"] });
    await dispatch("root", "coordinator-call", start.task);
    await chat("coordinator", start.task.prompt, "dogs-coordinator");
    const unit = { title: "Run", objective: "Run procedure", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] };
    const first = await tool("plan_units", "coordinator", { units: [unit] });
    await dispatch("coordinator", "old-call", first.task);
    await chat("old", first.task.prompt, "dog-worker-v010");
    const firstRun = await run(), old = firstRun.units[0]!;
    await inspect("old", old.handoffPath, "initial-read");
    assert.equal((await tool("bind_write_gate", "old", { project_root: directory, manifest_path: old.manifestPath })).status, "bound");
    now += 29 * 60_000;
    await inspect("old", join(directory, "check.mjs"), "keep-authorization-live");
    now += 2 * 60_000;
    assert.equal((await tool("bind_write_gate", "old", { project_root: directory, manifest_path: old.manifestPath })).reason, "handoff-uninspected");
    identities.old = { agent: "dog-worker-v010", parentID: "coordinator", outcome: "interrupted" };
    await hooks["tool.execute.after"]!({ sessionID: "coordinator", callID: "old-call", tool: "task" },
      { output: "PROCESS_DEFECT: local: handoff-uninspected", metadata: { sessionId: "old" } });
    const stopped = (await run()).units[0]!;
    assert.equal(stopped.status, "cancelled", "the real native interrupted outcome takes precedence over returned report text");
    assert.equal(stopped.resultClass, "interrupted"); assert.deepEqual(stopped.evidence, []);
    const returned = await ledger();
    assert.equal(returned.state.consumed_units, 1);
    assert.equal(returned.state.outstanding_reservations.length, 0);
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "old", callID: "stale-write", tool: "write" },
      { args: { filePath: join(directory, "result.txt"), content: "stale\n" } }), /operator-worker-owner-mismatch/,
    "return releases the old writer without reviving its grant");
    const second = await tool("plan_units", "coordinator", { units: [{ ...unit, title: "Continue", objective: "Continue retained operation",
      read: readOnly ? ["check.mjs", "result.txt"] : unit.read, write: readOnly ? [] : unit.write }], reason: "Returned Worker could not bind" });
    await dispatch("coordinator", "next-call", second.task);
    await chat("next", second.task.prompt, "dog-worker-v010");
    const nextRun = await run(), next = nextRun.units[0]!;
    assert.notEqual(nextRun.runID, firstRun.runID);
    assert.equal(next.childSessionID, "next"); assert.equal(next.callID, "next-call");
    assert.notEqual(next.manifestPath, old.manifestPath, "the next admission uses CURRENT controls, not a cached old run");
    const manifest = await readFile(next.manifestPath, "utf8"), mtime = Math.trunc((await stat(next.manifestPath)).mtimeMs);
    assert.equal(createHash("sha256").update(manifest).digest("hex"), next.hashes[1]);
    if (!readOnly) {
      const args = { filePath: join(directory, "result.txt"), content: "current result\n" };
      await hooks["tool.execute.before"]!({ sessionID: "next", callID: "current-write", tool: "write" }, { args });
      await writeFile(args.filePath, args.content);
      await hooks["tool.execute.after"]!({ sessionID: "next", callID: "current-write", tool: "write", args }, { output: "Updated result.txt" });
    } else await inspect("next", join(directory, "result.txt"), "current-source-read");
    const admitted = await ledger();
    assert.equal(admitted.state.consumed_units, 1); assert.equal(admitted.state.outstanding_reservations.length, 1);
    await inspect("next", old.handoffPath, "old-read");
    const currentHost = await tool("operator_status", "coordinator");
    assert.equal(currentHost.run_id, nextRun.runID, "historical handoff cannot hide the current host run");
    assert.equal(currentHost.budget.consumed_units, 1); assert.equal(currentHost.budget.reserved_units, 1);
    assert.equal(currentHost.task, undefined, "an existing Worker must not be dispatched again from stale context");
    assert.equal((await tool("bind_write_gate", "next", { project_root: directory, manifest_path: old.manifestPath })).reason,
      "binding-replay", "reading historical controls never replaces the new admission");
    await inspect("next", next.handoffPath, "next-read");
    for (let retry = 0; retry < 2; retry++) {
      const bound = await tool("bind_write_gate", "next", { project_root: directory, manifest_path: next.manifestPath });
      assert.equal(bound.status, "bound", JSON.stringify(bound)); assert.equal(bound.idempotent, true);
      assert.equal(bound.manifest_hash, next.hashes[1]);
    }
    assert.deepEqual(await ledger(), admitted, "Read and repeated legacy bind do not invent execution proof or change accounting");
    assert.equal(await readFile(next.manifestPath, "utf8"), manifest);
    assert.equal(Math.trunc((await stat(next.manifestPath)).mtimeMs), mtime);
    assert.deepEqual((await run()).units[0]!.hashes, next.hashes);
    // This is an overlap/TTL fixture, not an acceptance fixture: its Date.now-only clock
    // does not model real command timestamps. Do not manufacture success from activation.
    identities.next = { agent: "dog-worker-v010", parentID: "coordinator", outcome: "interrupted" };
    await hooks["tool.execute.after"]!({ sessionID: "coordinator", callID: "next-call", tool: "task" },
      { output: "Stopped serial overlap fixture", metadata: { sessionId: "next" }, status: "cancelled" });
    const completed = (await run()).units[0]!;
    assert.equal(completed.status, "cancelled"); assert.deepEqual(completed.evidence, []);
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "next", callID: "returned-write", tool: "write" },
      { args: { filePath: join(directory, "result.txt"), content: "leaked\n" } }), /operator-worker-owner-mismatch/);
    const settled = await ledger();
    assert.equal(settled.state.consumed_units, 2, "interrupted old Worker and returned new Worker are each counted once");
    assert.equal(settled.state.outstanding_reservations.length, 0);
    await hooks["tool.execute.after"]!({ sessionID: "coordinator", callID: "old-call", tool: "task" },
      { output: "Duplicate old return", metadata: { sessionId: "old" } });
    assert.deepEqual((await ledger()).records.filter(({ event }) => event.kind === "unit.settled"),
      settled.records.filter(({ event }) => event.kind === "unit.settled"));
  } finally { Date.now = clock; await rm(directory, { recursive: true, force: true }); }
});

for (const actor of ["second", "coordinator"]) for (const action of ["handoff", "cancel", "blocked", "needs-decision"]) test(`${actor} overlapping direct writer manages ${action} without evicting a live owner`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/direct-overlap-"));
  try {
    await writeFile(join(directory, "check.mjs"), 'import { readFileSync } from "node:fs"; if (readFileSync("result.txt", "utf8") !== "fixed\\n") process.exit(1);\n');
    await writeFile(join(directory, "result.txt"), "before\n");
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      first: { agent: "dog-operator" }, second: { agent: "dog-operator" },
      coordinator: { agent: "dogs-coordinator", parentID: "second" },
    };
    const history: Record<string, object[]> = {};
    const aborted: string[] = [];
    const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents)
        .filter(([, value]) => value.parentID === path.id).map(([id, value]) => ({ id, ...value })) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }),
      abort: async ({ path }: { path: { id: string } }) => {
        aborted.push(path.id); agents[path.id]!.outcome = "interrupted"; return { data: true };
      },
    } } } as never);
    const chat = async (id: string, text: string, messageID: string) => hooks["chat.message"]!(
      { sessionID: id, messageID, agent: agents[id]!.agent },
      { message: { id: messageID, agent: agents[id]!.agent, model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
        parts: [{ type: "text", text }] });
    const tool = async (id: string, name: string, args: object = {}, callID = `${id}-${name}`) => {
      await hooks["tool.execute.before"]!({ sessionID: id, callID, tool: `sortie_v010_${name}` }, { args });
      return JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: id, callID }));
    };
    const state = (id: string) => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required(id);
    const unit = { title: "Fix result", objective: "Write and validate result.txt", read: ["check.mjs"],
      write: ["result.txt"], validation: ["node check.mjs"] };
    let coordinatorTask: object | undefined;
    for (const id of ["first", "second"]) {
      await chat(id, "Write result.txt and run the real check", `${id}-request`);
      const started = await tool(id, "start_mission", { requirements: ["Write and validate result.txt"] });
      if (id === "second") coordinatorTask = started.task;
    }
    if (actor === "coordinator") {
      const task = { args: structuredClone(coordinatorTask!) } as { args: { prompt: string } };
      await hooks["tool.execute.before"]!({ sessionID: "second", callID: "coordinator-call", tool: "task" }, task);
      await chat("coordinator", task.args.prompt, "coordinator-request");
    }
    assert.equal((await tool("first", "plan_units", { executor: "self", units: [unit] })).status, "direct-unit-running");
    await assert.rejects(tool(actor, "plan_units", { executor: "self", units: [unit] }), /mission-direct-activation:manifest-overlap/);
    const before = await state("second"), missionID = (await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("second")).id;
    await chat("second", "お願い", "second-continue");
    const status = await tool(actor, "operator_status");
    assert.equal(status.budget.reserved_units, 1);
    const write = async (id: string, callID: string) => {
      const args = { filePath: join(directory, "result.txt"), content: "fixed\n" };
      await hooks["tool.execute.before"]!({ sessionID: id, callID, tool: "write" }, { args });
      await writeFile(args.filePath, args.content);
      (history[id] ??= []).push({ info: { role: "assistant", sessionID: id }, parts: [{ type: "tool", tool: "write", callID,
        state: { status: "completed", input: args, time: { end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ sessionID: id, callID, tool: "write", args }, { output: "written" });
    };
    const check = async (id: string, callID: string) => {
      const args = { command: "node check.mjs", workdir: directory }, start = Date.now();
      await hooks["tool.execute.before"]!({ sessionID: id, callID, tool: "bash" }, { args });
      await promisify(execFile)(process.execPath, ["check.mjs"], { cwd: directory });
      (history[id] ??= []).push({ info: { role: "assistant", sessionID: id }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: args, metadata: { exit: 0 }, time: { start, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ sessionID: id, callID, tool: "bash", args }, { output: "", metadata: { exit: 0, status: "completed" } });
    };
    if (action !== "handoff") {
      if (action === "cancel") await tool("second", "cancel_operator", { reason: "plain" });
      else await tool(actor, "submit_mission", { status: action, summary: "The overlapping writer is still active; retain this incomplete work." });
      const stopped = await state("second"), settled = await tool("second", "operator_status");
      assert.equal(stopped.runID, before.runID);
      assert.equal(stopped.units[0]!.status, action === "cancel" ? "cancelled" : "failed");
      assert.deepEqual(stopped.units[0]!.evidence, [], "management is never successful validation");
      assert.equal(settled.mission_id, missionID);
      assert.equal(settled.budget.reserved_units, 0);
      assert.equal(settled.budget.consumed_units, 1);
      assert.deepEqual(aborted, action === "cancel" && actor === "coordinator" ? ["coordinator"] : []);
      assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "before\n", "management preserves existing artifacts");
      assert.equal((await state("first")).units[0]!.status, "running", "management does not revoke another owner's writer");
      await write("first", "first-write-after-management");
      await check("first", "first-check-after-management");
      assert.notEqual((await tool("first", "finish_direct_unit")).status, "direct-unit-awaits-validation");
      assert.equal((await state("first")).units[0]!.status, "succeeded");
      return;
    }
    const handoff = await tool(actor, "plan_units", { executor: "worker", handoff_context: "Continue the same requested work." }, "handoff");
    assert.ok(handoff.task, JSON.stringify(handoff));
    assert.equal((await state("second")).runID, before.runID);
    assert.equal((await state("second")).units[0]!.status, "pending");
    assert.equal((await state("first")).units[0]!.status, "running", "the live parallel owner remains active");
    await write("first", "first-write");
    await check("first", "first-check");
    assert.notEqual((await tool("first", "finish_direct_unit")).status, "direct-unit-awaits-validation");
    agents.worker = { agent: "dog-worker-v010", parentID: actor };
    const task = { args: structuredClone(handoff.task) };
    await hooks["tool.execute.before"]!({ sessionID: actor, callID: "worker-call", tool: "task" }, task);
    await chat("worker", task.args.prompt, "worker-request");
    await write("worker", "worker-write");
    await check("worker", "worker-check");
    agents.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ sessionID: actor, callID: "worker-call", tool: "task" },
      { output: "Done", metadata: { sessionId: "worker" } });
    const after = await state("second"), settled = await tool("second", "operator_status");
    assert.equal(after.runID, before.runID);
    assert.equal(after.units[0]!.status, "succeeded");
    assert.equal(settled.mission_id, missionID);
    assert.equal(settled.budget.reserved_units, 0);
    assert.equal(settled.budget.consumed_units, 1);
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "fixed\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
