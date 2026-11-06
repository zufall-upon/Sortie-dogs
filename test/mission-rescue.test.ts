import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE, profileAgent } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { durableScopeRoot } from "../dist/core/durable-scope-root.js";

const exec = promisify(execFile);
const coordinatorRole = profileAgent(V010_RUNTIME_PROFILE, "dog-operator");
const workerRole = profileAgent(V010_RUNTIME_PROFILE, "dog-worker");

async function fixture(rescueWorks: boolean, actor = "coordinator") {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-rescue-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.name", "test"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(join(root, "check.mjs"), 'import { readFileSync } from "node:fs";\n' +
    'if (readFileSync("result.txt", "utf8") !== "fixed\\n") process.exit(1);\n');
  await exec("git", ["add", "check.mjs"], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "validator"], { cwd: root });
  let models = [
    { providerID: "openai", id: "gpt-6.1-terra", enabled: true },
  ];
  const identities: Record<string, Record<string, unknown>> = {
    root: { agent: "dog-operator" }, coordinator: { agent: coordinatorRole, parentID: "root" },
  };
  const create = () => SortieDogsV010Plugin({ directory: root, client: {
    v2: { model: { list: async () => ({ data: models }) } },
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
    },
  } } as never);
  const hooks = await create();
  const chat = async (id: string, text: string) => {
    const info = identities[id]!;
    const model = info.model as Record<string, unknown> | undefined;
    const output = { message: { id: `${id}-user`, agent: info.agent, model: model
      ? { providerID: model.providerID, modelID: model.id, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) }
      : { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }] };
    await hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: info.agent as string }, output);
    return output;
  };
  await chat("root", "Repair the validated result, preserving the declared validation.");
  const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute(
    { requirements: ["Produce the validated result"] }, { sessionID: "root" }));
  if (actor === "coordinator") {
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
  }
  const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Validated result",
    objective: "Produce the result accepted by check.mjs", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] },
    { sessionID: actor }));

  const dispatch = async (task: Record<string, unknown>, childID: string, callID: string, astra = false) => {
    identities[childID] = { agent: workerRole, parentID: actor, outcome: "succeeded",
      model: { providerID: "openai", id: astra ? "gpt-6-astra" : "gpt-6.1-terra", variant: astra ? "low" : "max" } };
    const output = { args: structuredClone(task) as Record<string, unknown> };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID }, output);
    const message = await chat(childID, String(output.args.prompt));
    return { output, message };
  };

  const executeAttempt = async (childID: string, callID: string, taskOutput: { args: Record<string, unknown> },
    writeResult: boolean, skipValidation = false) => {
    const run = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
    const unit = run.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: childID, callID: `${callID}-handoff` },
      { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: childID, callID: `${callID}-handoff` }, { output: "handoff" });
    const bound = JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute(
      { project_root: root, manifest_path: unit.manifestPath }, { sessionID: childID }));
    assert.equal(bound.status, "bound", JSON.stringify(bound));
    if (writeResult) await writeFile(join(root, "result.txt"), "fixed\n");
    let exit = 0, stdout = "";
    if (!skipValidation) {
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: childID, callID: `${callID}-validation` },
        { args: { command: "node check.mjs" } });
      try { stdout = (await exec(process.execPath, ["check.mjs"], { cwd: root })).stdout; }
      catch (error) { exit = Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1); }
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: childID, callID: `${callID}-validation` },
        { output: stdout, metadata: { exit, status: exit === 0 ? "completed" : "error" } });
    }
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID },
      { output: `Worker ${childID} returned`, metadata: { sessionId: childID } });
    return exit;
  };

  return { root, hooks, identities, chat, dispatch, executeAttempt, startTask: planned.task,
    addAstra: () => { models = [...models, { providerID: "openai", id: "gpt-6-astra", enabled: true }]; },
    dispose: async () => rm(root, { recursive: true, force: true }) };
}

for (const actor of ["root", "coordinator"]) test(`parallel Scout diagnosis after failed remediation preserves Mission and hands off evidence: ${actor}`, async () => {
  const state = await fixture(false, actor);
  try {
    const first = await state.dispatch(state.startTask, "worker-first", "first-call");
    await state.executeAttempt("worker-first", "first-call", first.output, false);
    const retry = JSON.parse(await state.hooks.tool!.sortie_v010_retry_mission_unit.execute(
      { unit_id: "unit-1" }, { sessionID: actor }));
    const second = await state.dispatch(retry.task, "worker-retry", "retry-call");
    await state.executeAttempt("worker-retry", "retry-call", second.output, false);
    const missions = new OperatorMissionRuntime(state.root, V010_RUNTIME_PROFILE);
    const operators = new OperatorRuntime(state.root, V010_RUNTIME_PROFILE);
    const before = await missions.required("root"), runBefore = await operators.required("root");
    assert.equal(before.attempts?.at(-1)?.kind, "normal_remediation");
    assert.equal(runBefore.phase, "awaiting-decision");
    const ledgerPath = join(dirname(await durableScopeRoot(state.root)), V010_RUNTIME_PROFILE.flightDirectory,
      `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
    const budget = await RunFlightLedger.readGoalFile(ledgerPath);
    assert.equal(budget.state.consumed_units, 2);
    // Independent hypotheses may use the same existing evidence code; there are no mandatory roles.
    const questions = ["Does the fixture require a trailing newline?", "Does the check resolve result.txt from a different cwd?"];
    await Promise.all(questions.map(async (question, index) => {
      state.identities[`scout-${index}`] = { agent: "dog-scout-v010", parentID: actor, outcome: "succeeded",
        model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } };
      await state.hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: `diagnose-${index}` }, {
        args: { subagent_type: "dog-scout-v010", prompt: `missing_evidence_code: validation\nproject_root: ${state.root}\n` +
          `node check.mjs still exits 1 after correction. Expected fixed newline; observed missing result. ${question}` },
      });
    }));
    const findings = ["check.mjs:2 requires fixed\\n exactly; the fixture does not accept a missing file.",
      "check.mjs:2 reads relative to cwd. No evidence yet of a mismatched Worker cwd."];
    await Promise.all(findings.map(async (result, index) => {
      await state.chat(`scout-${index}`, `missing_evidence_code: validation\nproject_root: ${state.root}`);
      await state.hooks["tool.execute.before"]!({ tool: "read", sessionID: `scout-${index}`, callID: `read-${index}` },
        { args: { filePath: join(state.root, "check.mjs") } });
      await state.hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: `diagnose-${index}` },
        { output: result, metadata: { sessionId: `scout-${index}` } });
    }));
    const { consultations, ...after } = await missions.required("root");
    const { consultations: _previous, ...unchanged } = before;
    assert.deepEqual(after, unchanged, "diagnosis grants no writer, rescue, Review or acceptance");
    assert.deepEqual(await new OperatorRuntime(state.root, V010_RUNTIME_PROFILE).required("root"), runBefore);
    assert.deepEqual(await RunFlightLedger.readGoalFile(ledgerPath), budget, "consultations do not spend/reset implementation-unit budget");
    assert.equal(consultations?.length, 2);
    for (const item of consultations!) {
      assert.equal(item.outcome, "completed");
      assert.equal(item.observedModel, "openai/gpt-6-luna-fast");
      assert.ok(findings.includes(item.result!));
    }
    const planned = JSON.parse(await state.hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Repair the observed result",
      objective: "Write fixed with its newline per check.mjs:2; preserve the unresolved cwd question until validation.",
      read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }],
      reason: "Retained Scout evidence identifies missing output; no check change is needed.", handoff_context: findings.join("\n") },
    { sessionID: actor }));
    assert.ok(planned.task, JSON.stringify(planned));
    const next = await new OperatorRuntime(state.root, V010_RUNTIME_PROFILE).required("root");
    assert.notEqual(next.runID, runBefore.runID, JSON.stringify(planned));
    const handoff = JSON.parse(await readFile(next.units[0]!.handoffPath, "utf8"));
    for (const finding of findings) assert.ok(JSON.stringify(handoff.ext["sortie-dogs/mission-context"]).includes(JSON.stringify(finding).slice(1, -1)));
    assert.equal((await missions.required("root")).id, before.id);
    assert.deepEqual((await missions.required("root")).attempts, before.attempts, "replan retains failed remediation history");
  } finally { await state.dispose(); }
});

for (const rescueWorks of [false, true]) test(`current Mission Astra Rescue keeps terminal, validation and acceptance separate: ${rescueWorks ? "validated" : "failed"}`, async () => {
  const state = await fixture(rescueWorks);
  try {
    const start = await state.dispatch(state.startTask, "worker-first", "worker-first-call");
    await state.executeAttempt("worker-first", "worker-first-call", start.output, false);
    const missionRuntime = new OperatorMissionRuntime(state.root, V010_RUNTIME_PROFILE);
    const first = await missionRuntime.required("root");
    assert.equal(first.attempts?.[0]?.kind, "implementation");
    assert.equal(first.attempts?.[0]?.failure?.category, "implementation");
    assert.equal(first.attempts?.[0]?.nativeOutcome, "completed");
    await assert.rejects(state.hooks.tool!.sortie_v010_retry_mission_unit.execute(
      { unit_id: "unit-1" }, { sessionID: "root" }), /mission-remediation-coordinator-required/u,
    "root cannot take over a Coordinator-owned retry");
    const retry = JSON.parse(await state.hooks.tool!.sortie_v010_retry_mission_unit.execute(
      { unit_id: "unit-1" }, { sessionID: "coordinator" }));
    assert.equal(retry.status, "normal_remediation_prepared", JSON.stringify(retry));
    const second = await state.dispatch(retry.task, "worker-normal-retry", "worker-normal-retry-call");
    await state.executeAttempt("worker-normal-retry", "worker-normal-retry-call", second.output, false);
    const afterNormal = await missionRuntime.required("root");
    assert.equal(afterNormal.attempts?.[1]?.kind, "normal_remediation");
    assert.equal(afterNormal.attempts?.[1]?.failure?.category, "implementation");

    const unavailable = JSON.parse(await state.hooks.tool!.sortie_v010_rescue_mission_unit.execute(
      { unit_id: "unit-1" }, { sessionID: "coordinator" }));
    assert.equal(unavailable.status, "non_rescue");
    assert.equal(unavailable.run_status, "awaiting-decision");
    assert.equal(unavailable.rescue.status, "non_rescue");
    assert.equal(unavailable.rescue.reason, "target_unavailable");
    assert.equal((await new OperatorRuntime(state.root, V010_RUNTIME_PROFILE).required("root")).units[0]!.status, "failed",
      "model unavailability must not admit a Rescue Worker");

    state.addAstra();
    const prepared = JSON.parse(await state.hooks.tool!.sortie_v010_rescue_mission_unit.execute(
      { unit_id: "unit-1" }, { sessionID: "coordinator" }));
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.rescue.selected_model, "openai/gpt-6-astra");
    assert.deepEqual(prepared.rescue.obligations, ["stop_confirmed", "writer_exclusive", "final_validation", "final_review", "candidate_cas"]);

    const rescue = await state.dispatch(prepared.task, "worker-astra-rescue", "worker-astra-rescue-call", true);
    assert.equal(rescue.output.args.model, "openai/gpt-6-astra", "the admitted current-Mission Task must select the proved Astra route");
    assert.equal(rescue.message.message.model.modelID, "gpt-6-astra", "the child session observes the selected Rescue model");
    assert.match(String(rescue.message.parts[0]!.text), /terminal_rescue_attempt:/u);
    const beforeSettlement = await missionRuntime.required("root");
    assert.equal(beforeSettlement.rescue?.status, "prepared");
    assert.equal(beforeSettlement.attempts?.at(-1)?.kind, "astra_rescue");
    assert.equal(beforeSettlement.attempts?.at(-1)?.status, "dispatched");

    const exit = await state.executeAttempt("worker-astra-rescue", "worker-astra-rescue-call", rescue.output, rescueWorks);
    const afterSettlement = await missionRuntime.required("root");
    assert.equal(exit, rescueWorks ? 0 : 1);
    assert.equal(afterSettlement.rescue?.status, rescueWorks ? "succeeded" : "failed");
    assert.equal(afterSettlement.rescue?.observedModel, "openai/gpt-6-astra");
    assert.equal(afterSettlement.attempts?.at(-1)?.status, rescueWorks ? "succeeded" : "failed");
    const run = await new OperatorRuntime(state.root, V010_RUNTIME_PROFILE).required("root");
    assert.equal(run.phase, rescueWorks ? "awaiting-acceptance" : "awaiting-decision");
    assert.equal((await missionRuntime.required("root")).phase, "running",
      "even a Rescue validation pass still needs independent review, submission and root acceptance");
    assert.equal((await missionRuntime.required("root")).review, undefined);
    assert.equal(run.receipt, null);
  } finally { await state.dispose(); }
});

test("current Mission Rescue records a non-use reason for a host-classified process defect", async () => {
  const state = await fixture(false);
  try {
    const first = await state.dispatch(state.startTask, "worker-process-defect", "worker-process-defect-call");
    await state.executeAttempt("worker-process-defect", "worker-process-defect-call", first.output, false, true);
    const missionRuntime = new OperatorMissionRuntime(state.root, V010_RUNTIME_PROFILE);
    const settled = await missionRuntime.required("root");
    assert.equal(settled.attempts?.[0]?.resultClass, "process-defect");
    assert.equal(settled.attempts?.[0]?.failure?.category, "contract");

    const skipped = JSON.parse(await state.hooks.tool!.sortie_v010_rescue_mission_unit.execute(
      { unit_id: "unit-1" }, { sessionID: "coordinator" }));
    assert.equal(skipped.status, "non_rescue");
    assert.equal(skipped.run_status, "awaiting-decision");
    assert.equal(skipped.rescue.status, "non_rescue");
    assert.equal(skipped.rescue.reason, "normal_remediation_not_exhausted");
    const run = await new OperatorRuntime(state.root, V010_RUNTIME_PROFILE).required("root");
    assert.equal(run.units[0]!.status, "failed");
    assert.equal(run.units[0]!.normalRemediationUsed ?? false, false);
    assert.equal(run.units[0]!.terminalRescue, undefined);
  } finally { await state.dispose(); }
});
