import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { missionExecutionStatus, OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE, profileAgent } from "../dist/core/runtime-profile.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

for (const variant of ["exact", "no-reference", "wrong-command", "wrong-cwd", "missing-cwd", "foreign-owner", "wrong-run", "history-unavailable", "missing-exit", "failed-result", "conflicting-result", "time-conflict", "competing-call", "after-settlement", "declaration-race"] as const)
test(`corrected operation recovers only the settled same-Mission Worker native call: ${variant}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-predecessor-operation-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await mkdir(join(root, "build"));
    await writeFile(join(root, "check.mjs"), 'console.log("auxiliary check");\n');
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string; time?: { created: number } }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: "coordinator", time: { created: Date.now() - 10_000 } },
    };
    const history: Record<string, Record<string, unknown>[]> = {};
    let unavailable = false;
    let duringHistory: (() => Promise<void>) | undefined;
    const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
    const hooks = await SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => {
        if (unavailable && path.id === "worker") throw new Error("native history unavailable");
        return { data: { id: path.id, ...identities[path.id] } };
      },
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async ({ path }: { path: { id: string } }) => {
        if (path.id === "worker" && duringHistory) { const transition = duringHistory; duringHistory = undefined; await transition(); }
        return { data: history[path.id] ?? [] };
      },
      abort: async () => { throw new Error("recovery must not abort or rerun the operation"); },
    } } } as never);
    let turn = 0;
    const chat = (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-${++turn}`, agent: identities[id]!.agent }, {
      message: { id: `${id}-${turn}`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text }],
    });
    const tool = async (name: string, id: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: id }));
    const build = "TMPDIR=/fixture/tmp XDG_CACHE_HOME=/fixture/cache /usr/bin/cmake --build build --target vdm_linux_readonly --parallel 4";
    const initialBuild = build.replace("vdm_linux_readonly --parallel", "vdm_linux_readonly linux_readonly_test --parallel");
    const launch = "node launch.mjs";
    const declaration = { title: "Build and launch", objective: "Build the requested target and launch it once", read: ["check.mjs"],
      write: ["build/**"], validation: ["node check.mjs"] };
    await chat("root", "Build and launch the requested target once without replay.");
    const started = await tool("start_mission", "root", { requirements: ["Build and launch the requested target once"], kind: "operation" });
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const first = await tool("plan_units", "coordinator", { units: [declaration], execution: { commands: [initialBuild, launch], directory: root } });
    const workerTask = { args: structuredClone(first.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, workerTask);
    await chat("worker", workerTask.args.prompt);
    const operators = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
    const original = await operators.required("root"), unit = original.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { output: "inspected" });
    await tool("bind_write_gate", "worker", { project_root: root, manifest_path: unit.manifestPath });

    // The original Worker did a single-target native shell call, not the two-target declaration.
    // This is fixture history: neither CMake nor the GUI is started by the regression.
    const actualStart = Date.now();
    const part = { type: "tool", tool: "shell", callID: "original-build", state: { status: "completed",
      input: { command: variant === "wrong-command" ? `${build} extra` : build,
        workdir: variant === "wrong-cwd" ? join(root, "other") : root, timeout: 240_000 },
      output: "[100%] Built target vdm_linux_readonly", metadata: { status: "completed", ...(variant === "missing-exit" ? {} : { exit: variant === "failed-result" ? 1 : 0 }) },
      time: { start: actualStart, end: actualStart } } };
    history.worker = [{ info: { role: "assistant", sessionID: "worker" }, parts: [part] }];
    if (variant === "missing-cwd") delete (part.state.input as { workdir?: string }).workdir;
    if (variant === "time-conflict") part.state.time.end = actualStart - 1;
    await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "original-launch" }, { args: { command: launch, workdir: root } });
    await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "original-launch" },
      { output: "launched", metadata: { status: "completed", exit: 0 } });
    await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "auxiliary-check" }, { args: { command: "node check.mjs", workdir: root } });
    const checked = await exec(process.execPath, ["check.mjs"], { cwd: root });
    await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "auxiliary-check" },
      { output: checked.stdout, metadata: { status: "completed", exit: 0 } });
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" },
      { output: "completed", metadata: { sessionId: "worker" } });
    assert.equal((await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root")).units[0]!.status, "succeeded");
    const before = (await tool("operator_status", "root")).acceptance_summary.operation;
    assert.equal(before.status, "not-started");
    assert.deepEqual(before.observations.map((item: { callID: string }) => item.callID), ["original-launch"]);

    const corrected = await tool("plan_units", "coordinator", { executor: "self", units: [{ ...declaration, title: "Correct the declaration",
      objective: "Recover the existing call without starting the operation again" }],
      execution: { commands: [build, launch], directory: root }, reason: "The actual build used only the GUI target" });
    assert.equal(corrected.status, "direct-unit-running");
    const budgetBefore = (await tool("operator_status", "root")).budget;
    if (variant === "foreign-owner") identities.worker!.parentID = "another-coordinator";
    if (variant === "history-unavailable") unavailable = true;
    if (variant === "declaration-race") duringHistory = async () => { await missions.update("root", current => {
      current.execution!.commands = [`${build} changed`, launch];
    }); };
    if (variant === "after-settlement") {
      const settled = (await missions.required("root")).progress.find(item => item.unit === `${original.runID}/unit-1`)!;
      part.state.time = { start: Date.parse(settled.at) + 100, end: Date.parse(settled.at) + 100 };
    }
    if (variant === "conflicting-result") {
      const contradiction = structuredClone(part);
      contradiction.state.metadata.exit = 1;
      (history.worker![0]!.parts as unknown[]).push(contradiction);
    }
    if (variant === "competing-call") {
      const competitor = structuredClone(part);
      competitor.callID = "another-build";
      (history.worker![0]!.parts as unknown[]).push(competitor);
    }
    if (variant !== "no-reference") {
      if (variant === "exact") await assert.rejects(tool("plan_units", "root", { execution: {
        commands: [`${build} changed`, launch], directory: root, recover_call: { run_id: original.runID,
          unit_id: "unit-1", session_id: "worker", call_id: "original-build" } } }), /mission-operation-recovery-declaration-mismatch/u);
      const recovery = await tool("plan_units", "root", { execution: { commands: [build, launch], directory: root, recover_call: {
        run_id: variant === "wrong-run" ? "foreign-run" : original.runID,
        unit_id: "unit-1", session_id: "worker", call_id: "original-build" } } });
      assert.equal(recovery.status, "operation-reconciled");
      assert.equal(recovery.run_id, corrected.run_id, "recover in the current run without creating another unit");
      assert.deepEqual(recovery.budget, budgetBefore, "native result recovery spends no new unit");
    }
    const observed = (await tool("operator_status", "root")).acceptance_summary.operation;
    const expected = variant === "exact" ? "executed" : variant === "failed-result" ? "execution-failed"
      : ["history-unavailable", "wrong-command", "wrong-cwd", "missing-cwd", "foreign-owner", "wrong-run", "after-settlement", "declaration-race"].includes(variant) ? "recovery-unavailable"
      : ["missing-exit", "conflicting-result", "time-conflict", "competing-call"].includes(variant) ? "recovery-blocked" : "not-started";
    assert.equal(observed.status, expected);
    const result = observed.observations.find((item: { callID: string }) => item.callID === "original-build");
    if (["exact", "failed-result", "missing-exit", "conflicting-result", "time-conflict", "competing-call"].includes(variant)) {
      assert.equal(result.sourceRunID, original.runID);
      assert.equal(result.sourceUnitID, "unit-1");
      assert.equal(result.sessionID, "worker");
      assert.equal(result.nativeTimeoutMs, 240_000);
      assert.equal(result.nativeStartedAt, new Date(actualStart).toISOString());
      assert.equal(result.completedAt, new Date(actualStart - (variant === "time-conflict" ? 1 : 0)).toISOString());
    } else assert.equal(result, undefined);
    const repeated = (await tool("operator_status", "root")).acceptance_summary.operation;
    assert.equal(repeated.status, expected);
    assert.equal(repeated.observations.filter((item: { callID: string }) => item.callID === "original-build").length,
      result ? 1 : 0, "reconciliation is idempotent and does not launch a new call");
    if (variant === "exact") {
      await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "coordinator", callID: "duplicate-build" },
        { args: { command: build, workdir: root } }), /mission-operation-already-admitted/u);
      assert.equal((await tool("operator_status", "root")).acceptance_summary.operation.status, "executed",
        "a refused duplicate does not replace the original terminal result");
      part.state.input.timeout = 180_000;
      const changedInput = (await tool("operator_status", "root")).acceptance_summary.operation;
      assert.equal(changedInput.status, "recovery-blocked", "a later conflicting native timeout cannot replace the original call");
      assert.equal(changedInput.observations.find((item: { callID: string }) => item.callID === "original-build").nativeTimeoutMs, 240_000,
        "the original per-call timeout remains unchanged");
    }
    assert.notEqual((await missions.required("root")).phase, "completed", "operation recovery is not formal validation or acceptance");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const owner of ["ended", "live", "unknown", "background-tool"] as const)
test(`Operator method correction reaches only the ended retained direct owner: ${owner}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-strategy-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), 'import {readFileSync} from "node:fs"; if (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n');
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    };
    const aborted: string[] = [];
    const history: Record<string, Record<string, unknown>[]> = {};
    const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      abort: async ({ path }: { path: { id: string } }) => { aborted.push(path.id); return { data: true }; },
    } } } as never);
    const chat = async (id: string, messageID: string, text: string) => hooks["chat.message"]!({
      sessionID: id, messageID, agent: identities[id]!.agent,
    }, { message: { id: messageID, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
      parts: [{ type: "text", text }] });
    const requirements = ["Deliver a validated ready result"];
    await chat("root", "request", "Deliver a validated ready result without repeating a stalled approach.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" },
      { args: structuredClone(started.task) });
    await chat("coordinator", "coordinator-request", started.task.prompt);
    const declaration = { title: "Create ready result", objective: "Write the result and validate it", read: ["check.mjs"],
      write: ["result.txt"], validation: ["node check.mjs"] };
    await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [declaration] },
    { sessionID: "coordinator" });
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE), operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    if (owner !== "live") {
      if (owner !== "unknown") identities.coordinator!.outcome = "interrupted";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" },
        { status: "error", output: "Method stalled; the direct unit is retained", metadata: { sessionId: "coordinator" } });
    }
    if (owner === "background-tool") history.coordinator = [{ info: { role: "assistant", sessionID: "coordinator" }, parts: [{
      type: "tool", tool: "shell", callID: "unresolved-background", state: { status: "completed", metadata: { status: "running" } },
    }] }];
    const prior = await missions.required("root"), run = await operators.required("root");
    const budget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "progress" }, { sessionID: "root" })).budget;
    const proposed = { ...declaration, objective: "Use the existing result directly instead of rebuilding an unnecessary helper" };
    const reason = "The selected helper stalled; use the already available source to finish the same result";
    const notes = "Keep node check.mjs mandatory. Do not repeat the stalled helper or restart the operation.";
    const correction = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [proposed],
      reason, handoff_context: notes }, { sessionID: "root" }));
    assert.equal(correction.status, owner === "ended" ? "mission-coordinator-required" : "mission-coordinator-active");
    assert.deepEqual(await operators.required("root"), run, "proposing a different method does not admit its contract or replace the retained run");
    assert.deepEqual(await missions.required("root"), prior, "no logging-only state change or fabricated terminal");
    assert.deepEqual(aborted, [], "a strategy proposal never stops an owner");
    const afterProposal = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "progress" }, { sessionID: "root" })).budget;
    for (const key of ["consumed_units", "reserved_units", "remaining_units", "settled_time_ms", "settled_cost_usd"])
      assert.equal(afterProposal[key], budget[key], `proposing a method preserves ${key}`);
    if (owner !== "ended") {
      assert.equal(correction.task, undefined, "live, unknown and background-tool ownership cannot produce a duplicate continuation");
      return;
    }
    assert.equal(correction.task.task_id, "coordinator");
    assert.equal(correction.task.subagent_type, "dogs-coordinator");
    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.match(status.next_action, /compare the original goal, actual result and concrete unmet work/u);
    assert.match(status.next_action, /plan_units with proposed units, reason and handoff_context/u);
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "method-continuation" },
      { args: structuredClone(correction.task) });
    const resumed = { message: { id: "method-input", agent: "dogs-coordinator" }, parts: [{ type: "text", text: correction.task.prompt }] };
    await hooks["chat.message"]!({ sessionID: "coordinator", messageID: "method-input", agent: "dogs-coordinator" }, resumed);
    assert.ok(resumed.parts[0]!.text.includes(proposed.objective), "the actual resumed author's input contains the concrete alternative");
    assert.ok(resumed.parts[0]!.text.includes(reason));
    assert.ok(resumed.parts[0]!.text.includes(notes), "retained mandatory check and no-replay boundary reach the author, not only storage");
    assert.deepEqual((await operators.required("root")).units, run.units, "continuation does not start a second unit");
    const write = { filePath: join(directory, "result.txt"), content: "ready\n" };
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "coordinator", callID: "write" }, { args: write });
    await writeFile(write.filePath, write.content);
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "coordinator", callID: "write", args: write }, { output: "written" });
    const check = { command: "node check.mjs", workdir: directory };
    const checkStart = Date.now();
    await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "coordinator", callID: "check" }, { args: check });
    await exec(process.execPath, ["check.mjs"], { cwd: directory });
    history.coordinator = [{ info: { role: "assistant", sessionID: "coordinator" }, parts: [{ type: "tool", tool: "shell", callID: "check",
      state: { status: "completed", input: check, metadata: { exit: 0 }, time: { start: checkStart, end: Date.now() } } }] }];
    await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "coordinator", callID: "check", args: check },
      { output: "", metadata: { exit: 0, status: "completed" } });
    const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: "coordinator" }));
    assert.equal(finished.status, "awaiting-acceptance", JSON.stringify(finished));
    const after = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "progress" }, { sessionID: "root" }));
    assert.equal(after.mission_id, prior.id);
    assert.equal(after.run_id, run.runID);
    assert.equal(after.budget.consumed_units, 1, "the original admission settles once after its real check");
    assert.equal(after.budget.reserved_units, 0);
    assert.equal(finished.units.length, 1);
    assert.ok(finished.units[0].evidence.some((proof: any) => proof.execution.exit_code === 0 &&
      proof.execution.command.includes("node check.mjs")), "finish records the actual canonical check for the retained admission");
    assert.notEqual((await missions.required("root")).phase, "completed", "method guidance and a unit check are not Mission acceptance");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function assertStatusOrder(packet: Record<string, unknown>): void {
  const keys = Object.keys(packet), summary = keys.indexOf("acceptance_summary"), units = keys.indexOf("units");
  assert.equal(keys[0], "mission_id", "status leads with actionable identity, not bulky acceptance evidence");
  for (const key of ["status", "budget", "attempts", "next_action", "completion"]) {
    assert.ok(keys.indexOf(key) >= 0 && keys.indexOf(key) < summary, `${key} precedes acceptance evidence`);
  }
  assert.ok(summary >= 0 && units > summary, "acceptance summary still precedes the full authority packet");
}

for (const mode of ["implementation", "executed", "live-history-clock", "execution-failed", "fast-lane-failure", "registered-operation", "failed-result-validation", "NO_START", "legacy-background", "missing-foreground-exit", "missing-error-exit"] as const) test(`mission completion keeps checks, review and operation outcomes separate: ${mode}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-completion-"));
  const failure = ["execution-failed", "fast-lane-failure", "registered-operation", "failed-result-validation"].includes(mode);
  const fast = mode === "fast-lane-failure" || mode === "registered-operation";
  const dispatcher = fast ? "root" : "coordinator";
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.name", "test"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    const validator = 'import { readFileSync, writeFileSync } from "node:fs";\n' +
      (mode === "implementation" || failure ? '' : 'writeFileSync("result.txt", "ready\\n");\n') +
      'if (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n' +
      (failure ? `const operation = JSON.parse(readFileSync("operation.json", "utf8"));\nif (operation.attempts !== 1 || operation.exit !== ${mode === "failed-result-validation" ? 0 : 1}) process.exit(1);\n` : '') +
      `console.log(JSON.stringify(${JSON.stringify({ status: mode, attempts: mode === "NO_START" ? 0 : 1, reward: 0 })}));\n`;
    const reference = "Public result contract: ready followed by a newline.\n";
    await writeFile(join(root, "reference.md"), reference);
    await writeFile(join(root, "check.mjs"), validator);
    if (failure) await writeFile(join(root, "run.mjs"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("result.txt", "ready\\n");\n' +
      'const result = {status: "execution-failed", attempts: 1, reward: 0, exit: 1};\n' +
      'writeFileSync("operation.json", JSON.stringify(result));\nconsole.log(JSON.stringify(result));\nprocess.exitCode = 1;\n');
    await exec("git", ["add", "check.mjs"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "validator"], { cwd: root });
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string; time?: { created: number } }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: dispatcher, ...(mode === "live-history-clock" ? { time: { created: Date.now() } } : {}) },
      reviewer: { agent: "dog-reviewer-v010", parentID: dispatcher },
    };
    const nativeHistory: Record<string, Record<string, unknown>[]> = {};
    let latestSession: Record<string, unknown>;
    const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: latestSession = {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: nativeHistory[path.id] ?? [] }), abort: async () => ({ data: true }),
    } } } as never);
    const hooks = await create();
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text }],
    });
    await chat("root", mode === "failed-result-validation" ? "Run successfully once and validate the successful outcome. Do not accept a failed operation."
      : failure ? "Run once and collect its result, even on failure. Do not retry or fix it. Validate collected evidence, then review and accept it."
      : "Write and validate a ready result, then review and accept it.");
    const plannedUnit = { title: "Validated result", objective: mode === "failed-result-validation" ? "Run once and validate successful exit; failure must remain unaccepted"
      : failure ? "Run once and validate collected result; do not retry or fix the failed operation" : "Write result and validate it",
      read: ["check.mjs", ".sortie-dogs-v010/missions", ...(failure ? ["run.mjs"] : [])], write: ["result.txt", ...(failure ? ["operation.json"] : [])], validation: ["node check.mjs"] };
    const execution = { commands: mode === "implementation" ? [] : [failure ? "node run.mjs" : "node check.mjs"], directory: root };
    const requirements = [mode === "failed-result-validation" ? "Run successfully and validate successful execution"
      : failure ? "Run once and collect its result" : "Create a validated result"];
    let started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements,
      kind: mode === "implementation" ? "implementation" : "operation", ...(fast ? { execution,
        ...(mode === "registered-operation" ? {} : { unit: plannedUnit }) } : {}) }, { sessionID: "root" }));
    if (mode === "registered-operation") {
      const registered = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.deepEqual(registered.execution, { ...execution, observations: [] }, "execution without a unit is retained, not silently discarded");
      const previous = started.mission_id;
      started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements, unit: plannedUnit }, { sessionID: "root" }));
      assert.equal(started.mission_id, previous, "a known unit reuses the already registered command in the same Mission");
    }
    const baseline = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewBaseline, baseline);
    if (!fast) {
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
      await chat("coordinator", started.task.prompt);
    } else assert.equal(started.task.subagent_type, profileAgent(V010_RUNTIME_PROFILE, "dog-worker"), "known operation and result check dispatch directly without a Coordinator");
    if (mode === "executed") await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ units: [{
      title: "Incomplete operation", objective: "Run the operation", write: ["result.txt"], validation: ["node check.mjs"],
    }], execution: { commands: [], directory: root } }, { sessionID: "coordinator" }), /mission-operation-input/);
    const next = fast ? started : JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [plannedUnit], execution }, { sessionID: dispatcher }));
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewBaseline, baseline);
    if (mode === "implementation") assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).kind, "implementation");
    if (mode === "implementation") {
      const before = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
      const active = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [plannedUnit], executor: "self",
        reason: "Correct a verification recipe" }, { sessionID: "root" }));
      assert.equal(active.status, "mission-coordinator-active");
      assert.equal(active.task, undefined, "an admitted Coordinator must not acquire a duplicate continuation Task");
      assert.match(active.next_action, /wait|owning session/iu);
      assert.deepEqual(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root"), before,
        "routing advice must not replan or spend another unit");
    }
    assert.deepEqual((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewScope?.write,
      failure ? ["operation.json", "result.txt"] : ["result.txt"]);
    const worker = { args: structuredClone(next.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: dispatcher, callID: "worker-call" }, worker);
    await chat("worker", worker.args.prompt);
    const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE), state = await runtime.required("root");
    const unit = state.units[0]!;
    const clock = Date.now;
    try {
      if (mode === "executed") { const aged = clock() + 31 * 60_000; Date.now = () => aged; }
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } }, { output: "inspected" });
      const binding = JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: root, manifest_path: unit.manifestPath }, { sessionID: "worker" }));
      assert.equal(binding.status, "bound", JSON.stringify(binding));
    } finally { Date.now = clock; }
    if (mode === "legacy-background" || mode.startsWith("missing-")) {
      // V2 returns a completed tool call for a launched background shell, with no process exit.
      // This is the metadata captured by the real Anko run, not an operation result.
      await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "background-launch" },
        { args: { command: "node check.mjs", workdir: root } });
      await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "background-launch" },
        { output: "", ...(mode === "missing-error-exit" ? { status: "error" } : {}),
          metadata: mode === "legacy-background" ? { status: "running", shellID: "sh_anko" } : { status: mode === "missing-error-exit" ? "error" : "completed" } });
      const observed = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.equal(observed.execution?.observations[0]?.outcome, undefined, "without a process exit there is no successful/failed process outcome");
      if (mode === "legacy-background") assert.equal(observed.execution?.observations[0]?.completedAt, undefined,
        "a background launch must not be recorded as a terminal failure or success");
      assert.equal(observed.execution?.observations[0]?.status, mode === "legacy-background" ? "running" : mode === "missing-error-exit" ? "error" : "completed");
      const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "launched" },
        { sessionID: "coordinator" }));
      assert.equal(submitted.status, "operation-incomplete");
      assert.equal(submitted.operation.status, mode === "legacy-background" ? "running" : "recovery-blocked");
      if (mode === "legacy-background") assert.match(submitted.next_action, /do not (?:relaunch|start another)/iu);
      else assert.match(submitted.next_action, /do not replay or rerun/iu);
      return;
    }
    if (mode === "implementation") await writeFile(join(root, "result.txt"), "ready\n");
    if (mode === "executed") {
      await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "background-operation" },
        { args: { command: "node check.mjs", workdir: root, background: true, timeout: 0 } }),
      /mission-operation-background: run the declared command in foreground/);
      for (const command of ["node check.mjs | tee result.txt", "node check.mjs > result.txt",
        "node check.mjs 2> result.txt", "node check.mjs && echo done",
        "$ErrorActionPreference='Stop'; node check.mjs; echo done",
        `& '${process.execPath}' '${join(root, "check.mjs")}' > result.txt`]) {
        await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: `decorated-${command}` },
          { args: { command } }), /mission-operation-command-not-observed: run the declared operation command exactly/);
      }
      assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).execution?.observations.length, 0,
        "a decorated operation is corrected before it starts, without a second Worker or plan");
      await assert.rejects(readFile(join(root, "result.txt"), "utf8"), { code: "ENOENT" });
    }
    if (failure) {
      await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "operation" },
        { args: { command: "node run.mjs", workdir: root } });
      const failed = await exec(process.execPath, ["run.mjs"], { cwd: root }).then(() => assert.fail("operation must fail"),
        error => error as { code: number; stdout: string });
      assert.equal(failed.code, 1);
      await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "operation" },
        { output: failed.stdout, metadata: { exit: failed.code, status: "completed" } });
    }
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, { args: { command: "node check.mjs" } });
    const validationStarted = Date.now();
    const checked = await exec(process.execPath, ["check.mjs"], { cwd: root }).catch(error => {
      if (mode !== "failed-result-validation") throw error;
      assert.equal(error.code, 1);
      return { stdout: error.stdout };
    });
    (nativeHistory.worker ??= []).push({ info: { role: "assistant", sessionID: "worker" }, parts: [{ type: "tool", tool: "bash", callID: "validate",
      state: { status: "completed", input: { command: "node check.mjs" }, metadata: { exit: mode === "failed-result-validation" ? 1 : 0 },
        time: { start: validationStarted, end: Date.now() } } }] });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validate" },
      { output: checked.stdout, metadata: { exit: mode === "failed-result-validation" ? 1 : 0, status: "completed" } });
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: dispatcher, callID: "worker-call" }, { output: "validated", metadata: { sessionId: "worker" } });
    if (mode === "failed-result-validation") {
      assert.notEqual((await runtime.required("root")).units[0]!.status, "succeeded", "a terminal operation result never bypasses failed formal validation");
      await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "collected failure" },
        { sessionID: dispatcher }), /mission-units-incomplete/u);
      await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review-required-or-stale/u);
      assert.equal((await runtime.required("root")).receipt, null);
      const mission = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.equal(mission.execution!.observations.length, 1);
      assert.equal(mission.execution!.observations[0]!.exit, 1);
      return;
    }
    if (mode === "live-history-clock") {
      const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
      const live = structuredClone((await missions.required("root")).execution!.observations[0]!);
      // The hook admission clock precedes the native part's actual execution clock.
      const nativeStart = Date.parse(live.startedAt) + 1;
      const nativeEnd = Date.parse(live.completedAt!);
      const record = { info: { role: "assistant", sessionID: "worker" }, parts: [{ type: "tool", tool: "shell", callID: live.callID,
        state: { status: "completed", input: { command: "node check.mjs", workdir: root }, output: checked.stdout,
          metadata: { exit: 0, status: "completed" }, time: { start: nativeStart, end: nativeEnd } } }] };
      nativeHistory.worker = [record];
      const status = async () => JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
      const recovered = (await status()).acceptance_summary.operation;
      assert.equal(recovered.status, "executed", "admission and execution clocks are not contradictory native starts");
      assert.equal(recovered.observations[0].conflicting, undefined);
      assert.equal(recovered.observations[0].startedAt, live.startedAt, "retain the original live observation");
      assert.equal(recovered.observations[0].nativeStartedAt, new Date(nativeStart).toISOString());
      assert.equal((await status()).acceptance_summary.operation.status, "executed", "an identical native read is idempotent");
      record.parts[0]!.state.time = { start: nativeStart + 20_000, end: nativeEnd + 20_000 };
      const conflict = (await status()).acceptance_summary.operation;
      assert.equal(conflict.status, "recovery-blocked", "a second, contradictory actual native start still invalidates completion");
      assert.equal(conflict.terminal_complete, false);
      assert.equal(conflict.observations[0].nativeStartedAt, new Date(nativeStart).toISOString());
      assert.equal(conflict.observations[0].latestConflictingStartedAt, new Date(nativeStart + 20_000).toISOString());
      return;
    }
    const validatedUnits = structuredClone((await runtime.required("root")).units);
    const purpose = { decision: "REUSE", requirement_ids: ["R1"], observed_outcome: "Existing unit validation is complete",
      unmet_work: ["Review and final acceptance"], reason: "Reuse the completed check, not a logging-only plan",
      evidence_refs: [], next_action: "Review the current candidate" };
    const missionRuntime = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
    const beforeReview = await missionRuntime.required("root");
    await assert.rejects(hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["not-a-risk"], purpose_decision: purpose },
      { sessionID: dispatcher }), /mission-review-input/);
    assert.deepEqual((await missionRuntime.required("root")).purposeDecisions, beforeReview.purposeDecisions, "refused Review cannot save a decision");
    if (fast) {
      const lowRisk = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: [], purpose_decision: purpose }, { sessionID: dispatcher }));
      assert.equal(lowRisk.status, "skipped-low-risk");
      assert.equal(lowRisk.task, undefined, "recording a purpose note does not elevate a legitimate low-risk skip");
      assert.deepEqual((await runtime.required("root")).units, validatedUnits);
    }
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      purpose_decision: purpose,
      traces: ["check.mjs observed ready result, exit 0"], evidence: [{ path: "reference.md", offset: 1, limit: 1 }] }, { sessionID: dispatcher }));
    const recordedDecision = (await missionRuntime.required("root")).purposeDecisions!.at(-1)!;
    assert.equal(recordedDecision.decision, "REUSE");
    const reviewer = { args: structuredClone(review.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: dispatcher, callID: "reviewer-call" }, reviewer);
    if (mode === "implementation") {
      // The Reviewer can outlive its parent Coordinator Task. Its pending review still
      // owns the candidate even when the normal dispatch packet offers a continuation.
      identities.coordinator!.outcome = "interrupted";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" },
        { status: "error", output: "Coordinator interrupted while Reviewer remains active", metadata: { sessionId: "coordinator" } });
      const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
      const before = await runtime.required("root"), missionBefore = await missions.required("root");
      assert.equal(missionBefore.dispatchOpen, false);
      assert.equal(missionBefore.review!.verdict, "pending");
      const pending = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [plannedUnit], executor: "self",
        reason: "Correct the verification recipe after the parent Task ended" }, { sessionID: "root" }));
      assert.equal(pending.status, "mission-coordinator-active");
      assert.equal(pending.task, undefined, "a dispatch packet must not leak a Coordinator Task while its Reviewer is pending");
      assert.match(pending.next_action, /wait for that Reviewer/u);
      assert.deepEqual(await runtime.required("root"), before, "pending review routing cannot admit another writer or spend a unit");
      assert.deepEqual(await missions.required("root"), missionBefore, "retain the pending review and closed parent dispatch");
    }
    if (mode === "fast-lane-failure") {
      const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
      const before = await runtime.required("root"), missionBefore = await missions.required("root");
      const pending = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [plannedUnit,
        { ...plannedUnit, title: "Related result", validation: ["node check.mjs && git diff --check"] }], executor: "self" },
      { sessionID: "root" }));
      assert.equal(pending.status, "mission-coordinator-active");
      assert.equal(pending.task, undefined, "a pending Reviewer must not acquire a concurrent Coordinator writer");
      assert.match(pending.next_action, /wait for that Reviewer/u);
      assert.deepEqual(await runtime.required("root"), before);
      assert.deepEqual(await missions.required("root"), missionBefore);
    }
    assert.match(reviewer.args.prompt, /host observes this invocation's native outcome after your terminal/u);
    assert.match(reviewer.args.prompt, /final acceptance is separate.*authorized by the current user request/u);
    assert.match(reviewer.args.prompt, /result-and-hold checkpoint does not require it/u);
    assert.doesNotMatch(reviewer.args.prompt, /List those as deferred Operator checks/u);
    assert.match(reviewer.args.prompt, /Public result contract: ready followed by a newline/u);
    assert.deepEqual((await runtime.required("root")).units, validatedUnits,
      "attaching undeclared project context does not replan, rerun validation, or dispatch another Worker");
    identities.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: dispatcher, callID: "reviewer-call" }, { output: "PASS\nThe result is validated.", metadata: { sessionId: "reviewer" } });
    const sameReview = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"], purpose_decision: purpose }, { sessionID: dispatcher }));
    assert.equal(sameReview.status, "review-recorded");
    assert.equal((await missionRuntime.required("root")).purposeDecisions!.length, 1, "same decision does not replan, dispatch or duplicate");
    assert.equal((await missionRuntime.required("root")).purposeDecisions![0].id, recordedDecision.id);
    if (mode === "implementation") {
      delete identities.coordinator!.outcome;
      const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-after-review" },
        { args: missions.task(await missions.required("root")) });
      await chat("coordinator", "Continue the same Mission after the Reviewer completed.");
    }
    if (mode === "NO_START") {
      const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
      await missions.update("root", mission => { mission.review!.verdict = "evidence-gaps"; mission.review!.evidenceGapReviews = 1; });
      const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "auxiliary check passed" }, { sessionID: "coordinator" }));
      assert.equal(submitted.status, "operation-incomplete");
      const cold = await create();
      const completed = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
      assert.equal(completed.status, "not-ready");
      assert.equal(completed.operation_status, "not-started");
      assert.equal((await runtime.required("root")).receipt, null);
      return;
    }
    await writeFile(join(root, "reference.md"), reference + "changed after review\n");
    if (!fast) await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "ready" },
      { sessionID: dispatcher }), /mission-review-required-or-stale/);
    await writeFile(join(root, "reference.md"), reference);
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).coordinator, fast ? null : "coordinator");
    const submittedText = fast ? await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })
      : await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "Validated result, reviewed independently" }, { sessionID: dispatcher });
    assert.notEqual(JSON.parse(submittedText).status, "operation-incomplete", "a terminal failure can be submitted as a collected result");
    if (fast) assertStatusOrder(JSON.parse(submittedText));
    else assert.equal(Object.keys(JSON.parse(submittedText))[0], "acceptance_summary", "submission summary precedes the full authority packet");
    if (failure) {
      const submitted = JSON.parse(submittedText);
      if (fast) {
        assert.equal(submitted.task, undefined, "a collected failure must not trigger an unnecessary Coordinator redispatch");
        assert.match(submitted.next_action, /complete_mission/u);
      }
      const operation = submitted.acceptance_summary.operation;
      assert.equal(operation.status, "execution-failed");
      assert.equal(operation.terminal_complete, true);
      assert.equal(operation.process_succeeded, false);
      assert.equal(operation.observations[0].exit, 1);
    }
    if (!fast) {
      identities.coordinator!.outcome = "succeeded";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: mode === "implementation" ? "coordinator-after-review" : "coordinator-call" },
        { output: "ready", metadata: { sessionId: "coordinator" } });
    }
    const cold = await create();
    const status = async () => JSON.parse(await cold.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal((await status()).completion.ready, true);
    assertStatusOrder(await status());
    if (mode === "implementation") {
      const before = await runtime.required("root");
      const missionBefore = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      const continuation = JSON.parse(await cold.tool!.sortie_v010_plan_units.execute({ units: [{ ...plannedUnit,
        validation: ["node check.mjs && git diff --check"] }], executor: "self",
        reason: "Correct a verification recipe without changing the candidate",
        handoff_context: "Use the corrected verification command, not the previous recipe." }, { sessionID: "root" }));
      assert.equal(continuation.status, "mission-coordinator-required");
      assert.equal(continuation.task.task_id, "coordinator", "resume the actual author, not a new controller");
      assert.equal(continuation.task.subagent_type, "dogs-coordinator");
      assert.match(continuation.next_action, /same.*Coordinator/iu);
      assert.deepEqual(await runtime.required("root"), before, "the proposed replacement is not admitted by routing advice");
      assert.deepEqual(await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root"), missionBefore,
        "preserve the existing submission, requirements, checks and receipt state");
      await assert.rejects(cold.tool!.sortie_v010_plan_units.execute({ units: [plannedUnit], executor: "self" },
        { sessionID: "reviewer" }), /mission-controller-required/u, "unrelated actors gain no continuation authority");
      const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
      // Model the durable admission left behind by a missed execute.after, then reload.
      await missions.update("root", mission => { mission.dispatchOpen = true; });
      nativeHistory.root = [{ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "task",
        callID: "coordinator-after-review", state: { status: "completed", input: { ...started.task, task_id: "coordinator" } } }] }];
      const reloaded = await create();
      const recovered = JSON.parse(await reloaded.tool!.sortie_v010_plan_units.execute({ units: [plannedUnit], executor: "self",
        reason: "Resume after a missed Task completion hook" }, { sessionID: "root" }));
      assert.equal(recovered.status, "mission-coordinator-required", "native terminal wins over a stale admission after restart");
      assert.equal(recovered.task.task_id, "coordinator");
      assert.equal((await missions.required("root")).dispatchOpen, false);
      await reloaded["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "correction-continuation" },
        { args: structuredClone(continuation.task) });
      const resumed = { message: { id: "coordinator-correction", agent: "dogs-coordinator" },
        parts: [{ type: "text", text: continuation.task.prompt }] };
      await reloaded["chat.message"]!({ sessionID: "coordinator", messageID: "coordinator-correction", agent: "dogs-coordinator" }, resumed);
      assert.match(resumed.parts[0]!.text, /node check\.mjs && git diff --check/u);
      assert.match(resumed.parts[0]!.text, /Correct a verification recipe without changing the candidate/u);
      assert.match(resumed.parts[0]!.text, /Use the corrected verification command, not the previous recipe/u);
      await reloaded.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "Continuation received the correction" },
        { sessionID: "coordinator" });
      await reloaded["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "correction-continuation" },
        { output: "ready", metadata: { sessionId: "coordinator" } });
      const emptyNative = (await status()).acceptance_summary.native_declared_validation[0];
      assert.equal(emptyNative.status, "recorded-formal-evidence");
      assert.ok(emptyNative.evidence_ids.length);
      for (const historyMode of ["missing", "error", "invalid"] as const) {
        // Root role is already observed in this live instance. Change only the summary reader's API
        // availability; a cold root with no recovery API is a different existing host contract.
        const normalMessages = latestSession!.messages;
        if (historyMode === "missing") delete latestSession!.messages;
        else latestSession!.messages = async () => historyMode === "error"
          ? { data: undefined, error: { message: "unavailable" } } : { data: {} };
        const observed = await status();
        latestSession!.messages = normalMessages;
        assert.equal(observed.completion.ready, true, "history display failure adds no acceptance gate");
        assert.deepEqual(observed.acceptance_summary.native_declared_validation[0], emptyNative,
          "settled proof does not depend on refetching native history for display");
      }
    }
    // The oracle is read-only and therefore outside the review diff. Completion must still name it.
    await writeFile(join(root, "check.mjs"), validator + "// changed after validation\n");
    const blocked = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(blocked.status, "awaiting-evidence");
    assert.equal(blocked.receipt, null);
    assert.equal(blocked.completion.blockers[0].reason, "source-changed");
    assert.ok(blocked.completion.blockers[0].source_paths.includes("check.mjs"));
    const stale = await status();
    assert.deepEqual(stale.completion, blocked.completion);
    if (fast) assert.ok(stale.next_action.endsWith(blocked.next_action), "Fast-lane adds its direct source-reconciliation guidance");
    else assert.equal(stale.next_action, blocked.next_action, "status must not blindly send the root back to the same refused completion");
    await writeFile(join(root, "check.mjs"), validator);
    if (mode === "implementation") {
      await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).update("root", mission => {
        mission.review!.verdict = "evidence-gaps";
        mission.review!.evidenceGapReviews = 1;
        mission.review!.result = "EVIDENCE_GAPS\nThe decisive return line is not visible.\n\n" +
          "<details><summary>HTML example</summary>\n\n```html\n</details>\n```\n\n</details>";
      });
    }
    const completed = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal(completed.receipt.status, "succeeded");
    assert.equal(typeof completed.return_report, "string", "the real profiled completion transport must still deliver the host panel");
    assert.match(completed.return_report_instruction, /Append return_report verbatim once/u);
    assert.match(completed.return_report_instruction, /unknown values and caveats/u);
    const delivered = { text: `Result collected.\n\n${completed.return_report}` };
    await cold["experimental.text.complete"]!({ sessionID: "root", messageID: "operator-final", partID: "operator-text" }, delivered);
    assert.equal(delivered.text, `Result collected.\n\n${completed.return_report}`,
      "the tool-result transport must not append a second host panel to the Operator's final reply");
    if (failure) {
      assert.equal(completed.operation.status, "execution-failed", "Mission receipt success is not operation success");
      assert.equal(completed.operation.process_succeeded, false);
      assert.equal(completed.operation.observations[0].exit, 1);
      assert.match(completed.return_report, /execution-failed/u);
      assert.match(completed.return_report, /process did not succeed/u);
      const visible = { text: "✅ **DONE** — collected operation result\n\n**次:** なし" };
      await cold["experimental.text.complete"]!({ sessionID: "root", messageID: "final-failure", partID: "final-text" }, visible);
      assert.match(visible.text, /execution-failed/u, "the final user-facing renderer must not imply operation success");
      assert.match(visible.text, /process did not succeed/u);
    }
    if (mode === "implementation") {
      assert.match(completed.review_evidence_gaps, /decisive return line is not visible/u);
      assert.match(completed.return_report, /SourceReview\s+🟡 補足あり（非ブロッキング・PASSではない）/u);
      assert.match(completed.return_report, /レビュー補足\s+The decisive return line is not visible/u);
      assert.match(completed.return_report, /➡️ NEXT\n\nなし/u);
      const visible = { text: `✅ **DONE** — validated result\n\n**次:** なし\n\n${completed.return_report}` };
      await cold["experimental.text.complete"]!({ sessionID: "root", messageID: "final", partID: "final-text" }, visible);
      assert.match(visible.text, /SourceReview\s+🟡 補足あり（非ブロッキング・PASSではない）/u,
        "the final user-facing renderer must retain the native Review verdict, not only the completion tool result");
      assert.match(visible.text, /レビュー補足\s+The decisive return line is not visible/u);
      assert.doesNotMatch(visible.text, /SourceReview\s+未記録/u);
      assert.match(visible.text, /\*\*次:\*\* なし/u);
    }
    if (mode === "executed") {
      const visible = { text: "✅ **DONE** — validated operation\n\n**次:** なし" };
      await cold["experimental.text.complete"]!({ sessionID: "root", messageID: "final-pass", partID: "final-text" }, visible);
      assert.match(visible.text, /SourceReview\s+🟢 PASS（独立Reviewer）/u);
      assert.doesNotMatch(visible.text, /EVIDENCE_GAPS/u);
    }
    const final = await status();
    assert.equal(final.phase, "completed");
    if (failure) {
      assert.equal(final.operation.status, "execution-failed");
      assert.equal(final.operation.observations.length, 1, "result collection never reruns the failed operation");
    }
    assert.match(final.next_action, /no further dispatch or completion/);
    const key = createHash("sha256").update("v010\0root").digest("hex");
    const ledger = await (await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`))).readGoal();
    assert.equal(ledger.state.consumed_units, 1);
    assert.equal(ledger.state.outstanding_reservations.length, 0);
    assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.admission").length, 1, "review and acceptance must not require a second successful check");
    assert.equal(await readFile(join(root, "result.txt"), "utf8"), "ready\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const recoveryMode of ["saved", "missing-exit", "missing-error-exit", "missing-terminal-time", "conflicting-terminals", "conflict-after-recovery",
  "older-after-failure", "older-after-running", "newer-unseen-conflict", "newer-unseen-input-conflict", "newer-unseen-reversed-input-conflict", "newer-unseen-status-conflict", "delegated-after-completion",
  "conflicting-starts", "conflicting-starts-reversed", "conflicting-starts-partial", "conflicting-starts-after-recovery",
  "persisted-command-conflict", "persisted-cwd-conflict", "persisted-unmatched-input-conflict",
  "history-unavailable", "history-error-envelope", "history-invalid", "history-api-missing", "history-owner-unavailable",
  "history-unavailable-after-recovery", "history-unavailable-after-failure", "history-unavailable-after-running",
  "direct-before-admission", "direct-after-admission", "cancel-during-recovery", "complete-during-recovery"] as const)
test(`saved native operation calls recover through Mission APIs without replay or acceptance: ${recoveryMode}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-native-operation-recovery-"));
  const rootID = "ses_eea93a19dffdxZz9nRa10N2N3R", coordinator = "ses_ec815701fffeFp40d2WOjl6yU8";
  const worker = "ses_ec823140dffeGYr1ZirFUyDC6Z";
  const direct = recoveryMode.startsWith("direct-");
  const nativeOwner = direct ? coordinator : worker;
  const identities: Record<string, { agent: string; parentID?: string; outcome?: string; time?: { created: number } }> = {
    [rootID]: { agent: "dog-operator" },
    [coordinator]: { agent: "dogs-coordinator", parentID: rootID },
    [worker]: { agent: "dog-worker-v010", parentID: coordinator, outcome: "succeeded", time: { created: Date.now() - 10_000 } },
  };
  const history: Record<string, Record<string, unknown>[]> = {};
  let historyFailure: "throw" | "error" | "invalid" | "missing" | "owner" | undefined;
  let duringRecoveryRead: (() => Promise<void>) | undefined;
  const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
    get: async ({ path }: { path: { id: string } }) => {
      if (path.id === nativeOwner && historyFailure === "owner") throw new Error("native-session-service-unavailable");
      return { data: { id: path.id, ...identities[path.id] } };
    },
    children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
      .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
    ...(historyFailure === "missing" ? {} : { messages: async ({ path }: { path: { id: string } }) => {
      if (path.id === nativeOwner && historyFailure === "throw") throw new Error("native-history-service-unavailable");
      if (path.id === nativeOwner && historyFailure === "error") return { error: { message: "native-history-service-unavailable" } };
      if (path.id === nativeOwner && historyFailure === "invalid") return { data: {} };
      if (path.id === nativeOwner && duringRecoveryRead) {
        const transition = duringRecoveryRead; duringRecoveryRead = undefined;
        await transition();
      }
      return { data: history[path.id] ?? [] };
    } }), abort: async () => ({ data: true }),
  } } } as never);
  let hooks: Awaited<ReturnType<typeof create>>;
  let turn = 0;
  const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user-${++turn}`, agent: identities[id]!.agent }, {
    message: { id: `${id}-user-${turn}`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
    parts: [{ type: "text", text }],
  });
  const tool = async (name: string, id: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: id }));
  const before = (id: string, callID: string, task: object) => hooks["tool.execute.before"]!({ tool: "task", sessionID: id, callID }, { args: structuredClone(task) });
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "check.mjs"), 'console.log("PASS");\n');
    hooks = await create();
    const declaredCommands = ["git pull --ff-only origin main", "node 'apply.mjs' 'plan.json'"];
    await chat(rootID, "Run the registered release operation once and report its result.");
    const started = await tool("start_mission", rootID, { requirements: ["Run the registered release operation once and report its result"],
      kind: "operation", execution: { commands: declaredCommands, directory: root } });
    await before(rootID, "coordinator-call", started.task);
    await chat(coordinator, started.task.prompt);
    const planned = await tool("plan_units", coordinator, { ...(direct ? { executor: "self" } : {}), units: [{ title: "Collect operation result", objective: "Record the run result",
      read: ["check.mjs"], write: ["result.json"], validation: ["node check.mjs"] }] });
    if (!direct) {
      await before(coordinator, "call_9bf3a49fc67c463f98b241ede95a5cbc", planned.task);
      await chat(worker, planned.task.prompt);
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: coordinator, callID: "call_9bf3a49fc67c463f98b241ede95a5cbc" },
        { output: "completed", metadata: { sessionId: worker } });
    }

    const nativePull = "$ErrorActionPreference='Stop'; git pull --ff-only origin main";
    const nativeApply = `$ErrorActionPreference='Stop'; & ${quote(process.execPath)} ${quote(join(root, "apply.mjs"))} ${quote(join(root, "plan.json"))}`;
    const start = Date.now() - (recoveryMode === "direct-before-admission" ? 4_000 : 0);
    history[nativeOwner] = [
      { info: { role: "assistant", sessionID: nativeOwner, time: { created: start } }, parts: [{ type: "tool", tool: "bash",
        callID: "call_7c9218e8ae644cec9bfd4125081d2d16", state: { status: "completed", input: { command: nativePull, workdir: root },
          output: "Already up to date.", metadata: { exit: 0, status: "completed" }, time: { start, end: start + 1_812 } } }] },
      { info: { role: "assistant", sessionID: nativeOwner, time: { created: start + 10 } }, parts: [{ type: "tool", tool: "bash",
        callID: "call_c2320cce5c63457eae3553a5ab6d1f1c", state: { status: "completed", input: { command: nativeApply, workdir: root },
          output: "applied-and-matched", metadata: { exit: 0, status: "completed" }, time: { start: start + 10, end: start + 11_378 } } }] },
      { info: { role: "assistant", sessionID: nativeOwner, time: { created: start + 20 } }, parts: [{ type: "tool", tool: "bash",
        callID: "call_foreign_owner", sessionID: "ses_other_worker", state: { status: "completed",
          input: { command: nativeApply, workdir: root }, output: "not-this-session", metadata: { exit: 0, status: "completed" },
          time: { start: start + 20, end: start + 21 } } }] },
    ];
    const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
    const beforeRecovery = await missions.required(rootID);
    assert.deepEqual(beforeRecovery.execution!.observations, [], "legacy state lacks the exact-match observations");
    assert.equal(missionExecutionStatus(beforeRecovery), "not-started");

    if (recoveryMode === "delegated-after-completion") {
      // Disposable legacy state models a completed reusable correction admission;
      // its original native calls precede settlement, but a later turn shares the actor.
      const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE), run = await runtime.required(rootID);
      run.units[0]!.reviewerCorrection = { author: worker, reviewIdentity: "fixture-review", writeUnion: [],
        admittedAt: run.createdAt, promptID: "fixture-prompt" };
      await writeFile(runtime.statePath(rootID), JSON.stringify(run));
      await missions.update(rootID, current => {
        current.progress.at(-1)!.at = new Date(start + 12_000).toISOString();
      });
      history[worker]!.push({ info: { role: "assistant", sessionID: worker }, parts: [{ type: "tool", tool: "bash",
        callID: "later-self-recheck", state: { status: "completed", input: { command: nativeApply, workdir: root },
          metadata: { exit: 1, status: "completed" }, time: { start: start + 20_000, end: start + 20_001 } } }] });
      const laterInputConflict = structuredClone(history[worker]![1]!);
      const laterPart = (laterInputConflict as { parts: { state: { input: { command: string }; time: { start: number; end: number } } }[] }).parts[0]!;
      laterPart.state.input.command += " later-turn";
      laterPart.state.time = { start: start + 20_000, end: start + 20_001 };
      history[worker]!.push(laterInputConflict);
    }

    hooks = await create();
    if (recoveryMode === "cancel-during-recovery" || recoveryMode === "complete-during-recovery") {
      duringRecoveryRead = async () => {
        if (recoveryMode === "cancel-during-recovery") await tool("cancel_operator", rootID, { reason: "plain" });
        // Fault injection models the same phase write made by concurrent successful completion.
        else await missions.update(rootID, current => { current.phase = "completed"; });
      };
      await tool("operator_status", rootID);
      const terminal = await missions.required(rootID);
      assert.equal(terminal.phase, recoveryMode === "cancel-during-recovery" ? "cancelled" : "completed");
      assert.deepEqual(terminal.execution!.observations, [], "a late history response cannot rewrite a terminal Mission");
      return;
    }
    type NativeFixtureRecord = { parts: { state: { metadata: { exit?: number } } }[] };
    if (recoveryMode.startsWith("history-")) {
      const alreadyRecovered = recoveryMode.includes("after-");
      const expectedStatus = recoveryMode === "history-unavailable-after-failure" ? "execution-failed"
        : recoveryMode === "history-unavailable-after-running" ? "running" : "executed";
      if (recoveryMode === "history-unavailable-after-failure") (history[worker]![1] as NativeFixtureRecord).parts[0]!.state.metadata.exit = 1;
      if (recoveryMode === "history-unavailable-after-running") Object.assign((history[worker]![1] as NativeFixtureRecord).parts[0]!.state, { status: "running" });
      if (alreadyRecovered) assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, expectedStatus);
      historyFailure = recoveryMode === "history-error-envelope" ? "error" : recoveryMode === "history-invalid" ? "invalid"
        : recoveryMode === "history-api-missing" ? "missing" : recoveryMode === "history-owner-unavailable" ? "owner" : "throw";
      if (historyFailure === "missing") hooks = await create();
      const unavailable = alreadyRecovered ? (await tool("operator_status", rootID)).acceptance_summary
        : await tool("submit_mission", coordinator, { status: "ready", summary: "Recorded calls completed; history cannot currently be read." });
      const operation = unavailable.operation;
      assert.equal(operation.status, alreadyRecovered ? expectedStatus : "recovery-unavailable");
      assert.equal(operation.terminal_complete, alreadyRecovered && expectedStatus !== "running");
      assert.equal(operation.process_succeeded, alreadyRecovered && expectedStatus !== "running" ? expectedStatus === "executed" : null);
      assert.equal(operation.recovery.status, "unavailable");
      assert.equal(operation.recovery.errors[0].sessionID, worker);
      if (!alreadyRecovered) assert.match(unavailable.next_action, /do not replay or rerun/iu, "history unavailability is not permission to repeat the operation");
      historyFailure = undefined;
      hooks = await create();
      const recovered = (await tool("operator_status", rootID)).acceptance_summary.operation;
      assert.equal(recovered.status, alreadyRecovered ? expectedStatus : "executed", "restored history recovers without another operation run");
      assert.equal(recovered.recovery, undefined, "clear the transient reader diagnostic after a successful read");
      assert.equal(recovered.observations.length, 2);
      return;
    }
    if (recoveryMode.startsWith("persisted-")) {
      assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed");
      const first = history[worker]![0] as { parts: { state: { input: { command: string; workdir: string }; time: { start: number; end: number } } }[] };
      if (recoveryMode === "persisted-command-conflict") first.parts[0]!.state.input.command = nativeApply;
      else if (recoveryMode === "persisted-cwd-conflict") first.parts[0]!.state.input.workdir = join(root, "other-directory");
      else first.parts[0]!.state.input.command += " unexpected";
      first.parts[0]!.state.time = { start: start + 20_000, end: start + 20_010 };
    }
    if (recoveryMode === "missing-exit" || recoveryMode === "missing-error-exit") {
      delete (history[nativeOwner]![1] as NativeFixtureRecord).parts[0]!.state.metadata.exit;
      if (recoveryMode === "missing-error-exit") Object.assign((history[nativeOwner]![1] as NativeFixtureRecord).parts[0]!.state, { status: "error" });
    }
    if (recoveryMode === "missing-terminal-time") delete (history[nativeOwner]![1] as { parts: { state: { time: { end?: number } } }[] }).parts[0]!.state.time.end;
    if (recoveryMode === "conflict-after-recovery") {
      assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed");
    }
    if (recoveryMode === "conflicting-terminals" || recoveryMode === "conflict-after-recovery") {
      const failed = structuredClone(history[nativeOwner]![1]) as NativeFixtureRecord;
      failed.parts[0]!.state.metadata.exit = 1;
      history[nativeOwner]!.splice(1, 0, failed);
    }
    if (recoveryMode === "older-after-failure" || recoveryMode === "older-after-running") {
      await missions.update(rootID, current => { current.execution!.observations.push({ command: declaredCommands[1]!, directory: root,
        callID: "later-native-call", sessionID: nativeOwner, startedAt: new Date(start + 20_000).toISOString(),
        ...(recoveryMode === "older-after-failure" ? { completedAt: new Date(start + 21_000).toISOString(),
          status: "completed" as const, exit: 1, outcome: "execution-failed" as const } : { status: "running" as const }) }); });
    }
    if (recoveryMode.startsWith("newer-unseen-")) {
      const later = structuredClone(history[worker]![1]!) as { parts: { callID: string; state: { status: string; input: { command: string }; metadata: { exit: number; status: string }; time: { start: number; end: number } } }[] };
      later.parts[0]!.callID = recoveryMode;
      later.parts[0]!.state.time = { start: start + 20_000, end: start + 20_100 };
      if (recoveryMode === "newer-unseen-status-conflict") {
        later.parts[0]!.state.status = "error";
        later.parts[0]!.state.metadata.status = "running";
        history[worker]!.push(later);
      } else {
        const failed = structuredClone(later); failed.parts[0]!.state.metadata.exit = 1;
        if (recoveryMode.includes("input-conflict")) failed.parts[0]!.state.input.command += " unexpected";
        history[worker]!.push(...(recoveryMode === "newer-unseen-reversed-input-conflict" ? [failed, later] : [later, failed]));
      }
    }
    if (recoveryMode.startsWith("conflicting-starts")) {
      const earlier = structuredClone(history[worker]![1]!) as { parts: { callID: string; state: { metadata: { exit: number }; time: { start: number; end: number } } }[] };
      earlier.parts[0]!.callID = "conflicting-native-start";
      earlier.parts[0]!.state.time = { start: start + 5, end: start + 6 };
      const later = structuredClone(earlier);
      later.parts[0]!.state.metadata.exit = 1;
      later.parts[0]!.state.time = { start: start + 20_000, end: start + 20_100 };
      if (recoveryMode === "conflicting-starts-after-recovery") {
        history[worker]!.push(earlier);
        assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed");
        history[worker]!.pop();
        history[worker]!.push(later);
      } else {
        history[worker]!.push(...(recoveryMode === "conflicting-starts-reversed" ? [later, earlier] : [earlier, later]));
      }
    }
    const submitted = await tool("submit_mission", coordinator, { status: "blocked", summary: "Existing native operation completed; other evidence remains separate." });
    if (recoveryMode.startsWith("persisted-")) {
      const operation = submitted.acceptance_summary.operation;
      assert.equal(operation.status, "recovery-blocked", "a persisted same-call input contradiction cannot be silently filtered");
      assert.equal(operation.terminal_complete, false);
      assert.equal(operation.process_succeeded, null);
      const conflict = operation.observations.find((item: { callID: string }) => item.callID === "call_7c9218e8ae644cec9bfd4125081d2d16");
      assert.equal(conflict.conflicting, true);
      assert.equal(conflict.command, declaredCommands[0]);
      assert.equal(conflict.startedAt, new Date(start).toISOString());
      assert.equal(conflict.latestConflictingStartedAt, new Date(start + 20_000).toISOString());
      assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.terminal_complete, false);
      return;
    }
    if (recoveryMode === "direct-before-admission") {
      assert.equal(submitted.acceptance_summary.operation.status, "not-started", "boundary-page calls before direct admission belong to earlier work");
      assert.deepEqual((await missions.required(rootID)).execution!.observations, []);
      return;
    }
    if (recoveryMode.startsWith("newer-unseen-")) {
      assert.equal(submitted.acceptance_summary.operation.status, "recovery-blocked", "a newer ambiguous call must not fall back to old success");
      assert.equal(submitted.acceptance_summary.operation.terminal_complete, false);
      const conflict = submitted.acceptance_summary.operation.observations.find((item: { callID: string }) => item.callID === recoveryMode);
      assert.equal(conflict?.conflicting, true, "retain previously unseen contradictory native records");
      return;
    }
    if (recoveryMode.startsWith("conflicting-starts")) {
      const operation = submitted.acceptance_summary.operation;
      assert.equal(operation.status, "recovery-blocked", "a later conflicting native start cannot be hidden by another successful call");
      assert.equal(operation.terminal_complete, false);
      assert.equal(operation.process_succeeded, null);
      const conflict = operation.observations.find((item: { callID: string }) => item.callID === "conflicting-native-start");
      assert.equal(conflict.conflicting, true);
      assert.equal(conflict.startedAt, new Date(start + (recoveryMode === "conflicting-starts-reversed" ? 20_000 : 5)).toISOString(),
        "the original observed start is retained, not rewritten");
      assert.equal(conflict.latestConflictingStartedAt, new Date(start + 20_000).toISOString());
      if (recoveryMode === "conflicting-starts-partial") {
        history[worker]!.pop(); // A later read exposes only the older conflicting fragment.
        const partial = (await tool("operator_status", rootID)).acceptance_summary.operation;
        assert.equal(partial.status, "recovery-blocked", "partial history cannot regress the saved latest conflicting bound");
        assert.equal(partial.observations.find((item: { callID: string }) => item.callID === "conflicting-native-start").latestConflictingStartedAt,
          new Date(start + 20_000).toISOString());
      }
      return;
    }
    if (["missing-exit", "missing-error-exit", "missing-terminal-time", "conflicting-terminals", "conflict-after-recovery"].includes(recoveryMode)) {
      const operation = submitted.acceptance_summary.operation;
      assert.equal(operation.status, "recovery-blocked", "missing or contradictory native exits cannot establish terminal completion");
      assert.match(submitted.next_action, /do not replay or rerun/iu);
      assert.equal(operation.terminal_complete, false);
      assert.equal(operation.process_succeeded, null);
      const repeated = await tool("operator_status", rootID);
      assert.equal(repeated.acceptance_summary.operation.status, "recovery-blocked");
      assert.match(repeated.next_action, /do not replay or rerun/iu);
      if (recoveryMode === "missing-exit") {
        const incomplete = operation.observations.find((item: { callID: string }) => item.callID === "call_c2320cce5c63457eae3553a5ab6d1f1c");
        assert.equal(incomplete?.outcome, undefined, "no exit is not a real execution-failed outcome");
        (history[nativeOwner]![1] as NativeFixtureRecord).parts[0]!.state.metadata.exit = 0;
        assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed",
          "retrieving an actual exit completes the same call without a retry or false conflict");
      }
      return;
    }
    if (recoveryMode === "older-after-failure" || recoveryMode === "older-after-running") {
      assert.equal(submitted.acceptance_summary.operation.status, recoveryMode === "older-after-failure" ? "execution-failed" : "running",
        "an older recovered success cannot replace a newer native failure or live process");
      assert.ok((await missions.required(rootID)).execution!.observations.some(item => item.callID === "later-native-call"), "retain the original native record");
      return;
    }
    assert.equal(submitted.acceptance_summary.operation.status, "executed");
    assert.equal(submitted.acceptance_summary.operation.process_succeeded, true);
    assert.deepEqual(submitted.acceptance_summary.operation.observations.map((item: { callID: string }) => item.callID), [
      "call_7c9218e8ae644cec9bfd4125081d2d16", "call_c2320cce5c63457eae3553a5ab6d1f1c",
    ]);
    assert.ok(submitted.acceptance_summary.operation.observations.every((item: { sessionID: string; exit: number }) => item.sessionID === nativeOwner && item.exit === 0));
    assert.equal((await missions.required(rootID)).execution!.observations.length, 2);

    const recovered = await tool("operator_status", rootID);
    const repeated = await tool("operator_status", rootID);
    assert.equal(recovered.acceptance_summary.operation.status, "executed");
    assert.deepEqual(repeated.budget, recovered.budget, "read-only recovery consumes no unit or additional budget");
    assert.equal((await missions.required(rootID)).execution!.observations.length, 2, "native call IDs prevent duplicate records");
    assert.notEqual(recovered.phase, "completed", "operation recovery is not formal validation, Review or acceptance");
    if (recoveryMode === "delegated-after-completion") {
      assert.equal(recovered.acceptance_summary.operation.status, "executed");
      assert.equal(recovered.acceptance_summary.operation.observations.some((item: { callID: string }) => item.callID === "later-self-recheck"), false);
      return;
    }
    if (direct) return;
    history[worker]!.push(structuredClone(history[worker]![1]!));
    assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed", "identical terminal records are not contradictory");

    const nativeRecord = (callID: string, status: string, exit: number | undefined, at: number, resultStatus = status, background = false) => ({
      info: { role: "assistant", sessionID: worker, time: { created: at } },
      parts: [{ type: "tool", tool: "bash", callID, state: { status,
        input: { command: nativeApply, workdir: root, ...(background ? { background: true } : {}) }, output: exit === undefined ? "still running" : "apply result",
        metadata: { ...(exit === undefined ? {} : { exit }), status: resultStatus },
        time: { start: at, ...(status === "running" ? {} : { end: at + 5 }) } } }],
    });
    const runningAt = start + 20_000;
    history[worker]!.push(nativeRecord("call_running", "completed", undefined, runningAt, "running", true));
    const running = await tool("operator_status", rootID);
    assert.equal(running.acceptance_summary.operation.status, "running", "a later native launch stays running, not completed");
    assert.equal(running.acceptance_summary.operation.observations.at(-1).callID, "call_running");

    const foregroundAt = runningAt + 1;
    history[worker]!.push(nativeRecord("call_foreground", "running", undefined, foregroundAt));
    assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "running");
    history[worker]!.push(nativeRecord("call_foreground", "completed", 0, foregroundAt));
    assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed", "normal running-to-terminal transition is not a conflict");

    const failedAt = runningAt + 10;
    history[worker]!.push(nativeRecord("call_failed", "completed", 1, failedAt));
    const failed = await tool("operator_status", rootID);
    assert.equal(failed.acceptance_summary.operation.status, "execution-failed", "a later nonzero native exit stays failed");
    assert.equal(failed.acceptance_summary.operation.observations.at(-1).callID, "call_failed");
    assert.equal(failed.acceptance_summary.operation.observations.at(-1).exit, 1);

    const conflictingAt = failedAt + 10;
    history[worker]!.push(nativeRecord("call_conflict", "error", undefined, conflictingAt, "running"));
    const conflicting = await tool("operator_status", rootID);
    assert.equal(conflicting.acceptance_summary.operation.status, "recovery-blocked", "the newer contradictory native call cannot fall back to an earlier result");
    assert.equal(conflicting.acceptance_summary.operation.observations.find((item: { callID: string }) => item.callID === "call_conflict")?.conflicting, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional mission consultations record bounded use and skip reasons with native model and outcome", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-consultation-"));
  try {
    const rootRole = profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator");
    const identities: Record<string, Record<string, unknown>> = {
      root: { agent: rootRole },
      coordinator: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-operator"), parentID: "root" },
      advisor: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-advisor"), parentID: "coordinator",
        model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" }, outcome: "succeeded" },
      scout: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-scout"), parentID: "coordinator",
        model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" }, outcome: "succeeded" },
    };
    const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
    } } } as never);
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent as string }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text }],
    });
    await chat("root", "Implement this change and consult only for concrete gaps.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute(
      { requirements: ["Complete the requested change"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);

    const skipped = JSON.parse(await hooks.tool!.sortie_v010_skip_mission_consultation.execute(
      { role: "advisor", reason: "The acceptance and implementation path are already explicit; no material choice remains." },
      { sessionID: "coordinator" }));
    assert.equal(skipped.status, "recorded");
    const scoutSkipped = JSON.parse(await hooks.tool!.sortie_v010_skip_mission_consultation.execute(
      { role: "scout", reason: "The declared validator and its invocation were already observed directly." },
      { sessionID: "coordinator" }));
    assert.equal(scoutSkipped.status, "recorded");
    const advisorPrompt = "strategy_trigger: architecture-choice\nShould the existing parser remain the entrypoint? The current call sites show no alternate route.";
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "advisor-call" }, { args: {
      subagent_type: profileAgent(V010_RUNTIME_PROFILE, "dog-advisor"), description: "Bounded architecture question", prompt: advisorPrompt,
    } });
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "advisor-call" },
      { output: "Keep the parser as the entrypoint.", metadata: { sessionId: "advisor" } });

    const scoutPrompt = `missing_evidence_code: validation\nproject_root: ${root}\nknown_paths: ["check.mjs"]\nWhich exact command is the declared validator?`;
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "scout-call" }, { args: {
      subagent_type: profileAgent(V010_RUNTIME_PROFILE, "dog-scout"), description: "One missing validation fact", prompt: scoutPrompt,
    } });
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "scout-call" },
      { output: "The declared command is node check.mjs.", metadata: { sessionId: "scout" } });

    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.deepEqual(status.consultations.map((entry: Record<string, unknown>) => [entry.role, entry.disposition]), [
      ["advisor", "skipped"], ["scout", "skipped"], ["advisor", "dispatched"], ["scout", "dispatched"],
    ]);
    assert.match(status.consultations[0].reason, /no material choice remains/u);
    assert.match(status.consultations[1].reason, /validator.*observed directly/u);
    assert.equal(status.consultations[2].trigger, "architecture-choice");
    assert.match(status.consultations[2].question, /Should the existing parser/u);
    assert.equal(status.consultations[2].observedModel, "openai/gpt-6-sol");
    assert.equal(status.consultations[2].observedVariant, "xhigh");
    assert.equal(status.consultations[2].outcome, "completed");
    assert.equal(status.consultations[3].trigger, "validation");
    assert.equal(status.consultations[3].observedModel, "openai/gpt-6-luna-fast");
    assert.equal(status.consultations[3].outcome, "completed");
    assert.equal(status.phase, "running", "optional consultations do not block or accept the mission");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const actor of ["root", "coordinator"] as const) test(`early parallel Scout discoveries survive the Mission handoff: ${actor}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-discovery-"));
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "test"));
    await writeFile(join(directory, "src/caller.mjs"), "// existing source\n".repeat(159) + "export const publicCaller = value => String(value);\n");
    await writeFile(join(directory, "test/caller.test.mjs"), "import assert from 'node:assert/strict'; import { publicCaller } from '../src/caller.mjs'; assert.equal(publicCaller(3), '3');\n");
    const gaps = ["manifest", "validation", "owner-risk"];
    const identities: Record<string, Record<string, unknown>> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      ...Object.fromEntries(gaps.map(gap => [`scout-${gap}`, { agent: "dog-scout-v010", parentID: actor,
        model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" }, outcome: "succeeded" }])),
    };
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      messages: async () => ({ data: [] }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
    } } } as never);
    const hooks = await create();
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-request`,
      agent: identities[id]!.agent as string }, { message: { id: `${id}-request`, agent: identities[id]!.agent,
        model: { providerID: "openai", modelID: id.startsWith("scout-") ? "gpt-6-luna-fast" : "gpt-6.1-sol" } },
      parts: [{ type: "text", text }] });
    await chat("root", "Locate the public caller, its meaningful check and adjacent risk before implementing; reuse the discoveries.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute(
      { requirements: ["Find the caller, validation and relevant risk without changing source"] }, { sessionID: "root" }));
    if (actor === "coordinator") {
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" },
        { args: structuredClone(started.task) });
      await chat("coordinator", started.task.prompt);
    }
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    const before = await missions.required("root");
    const ledgerPath = join(directory, ".sortie-dogs-v010/run-flight", `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
    const budget = await RunFlightLedger.readGoalFile(ledgerPath);
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "invalid-gap" }, {
      args: { subagent_type: "dog-scout-v010", prompt: "Explore everything" },
    }), /SCOUT_GAP_REQUIRED/u);
    // Admit independent questions together, not three sequential Scout/result turns.
    await Promise.all(gaps.map(gap => hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: `call-${gap}` }, {
      args: { subagent_type: "dog-scout-v010", description: `Find ${gap}`, prompt:
        `missing_evidence_code: ${gap}\nproject_root: ${directory}\nknown_paths: ["src"]\nQuestion: Find the ${gap} evidence in relevant callers and tests.`,
      },
    })));
    assert.deepEqual((await missions.required("root")).consultations?.map(item => item.trigger).sort(), gaps.slice().sort());
    const result = (gap: string) => JSON.stringify({ missing_evidence_code: gap, facts: "Public caller handles the input at src/caller.mjs:160.",
      evidence_paths: ["src/caller.mjs:160", "test/caller.test.mjs:1"], risks: gap === "owner-risk" ? "One adjacent error case remains unverified." : "none observed" });
    await Promise.all(gaps.map(async gap => {
      await chat(`scout-${gap}`, `missing_evidence_code: ${gap}\nproject_root: ${directory}\nknown_paths: ["src"]`);
      for (const [tool, args] of [["glob", { pattern: "**/*caller*", path: directory }],
        ["grep", { pattern: "publicCaller", path: directory }],
        ["read", { filePath: join(directory, "src/caller.mjs"), offset: 150, limit: 40 }]] as const) {
        await hooks["tool.execute.before"]!({ tool, sessionID: `scout-${gap}`, callID: `${gap}-${tool}` }, { args: { ...args } });
      }
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: `call-${gap}` },
        { output: result(gap), metadata: { sessionId: `scout-${gap}` } });
    }));
    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(status.consultations.length, 3);
    for (const item of status.consultations) {
      assert.equal(item.role, "scout");
      assert.equal(item.outcome, "completed");
      assert.equal(item.observedModel, "openai/gpt-6-luna-fast");
      assert.equal(item.observedVariant, "max");
      assert.equal(item.result, result(item.trigger), "preserve exact source pointers and unresolved risk, not a guessed PASS");
    }
    const after = await missions.required("root");
    const { consultations: _beforeConsultations, ...beforeState } = before;
    const { consultations: _afterConsultations, ...afterState } = after;
    assert.deepEqual(afterState, beforeState, "discovery changes no requirements, ownership or lifecycle");
    assert.equal(await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).read("root"), undefined, "no preparation/Worker unit is required");
    assert.deepEqual(await RunFlightLedger.readGoalFile(ledgerPath), budget, "Scout admission does not reset/spend Worker budget or generate acceptance");
    // A fresh plugin reads the same retained results without redispatching a Scout.
    const restored = await create();
    const reloaded = JSON.parse(await restored.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.deepEqual(reloaded.consultations, status.consultations);
    const context = status.consultations.map((item: { result: string }) => item.result).join("\n");
    await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Check the discovered public caller", objective:
      "Reuse Scout's src/caller.mjs:160 discovery; check the public result and retain its unverified adjacent case.",
      read: ["src/caller.mjs", "test/caller.test.mjs"], write: [], validation: ["node --test test/caller.test.mjs"] }],
      handoff_context: context }, { sessionID: actor });
    const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
    const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
    for (const gap of gaps) assert.ok(JSON.stringify(handoff.ext["sortie-dogs/mission-context"]).includes(result(gap).replaceAll('"', '\\"')),
      `the existing Worker handoff carries ${gap} facts and unresolved risks`);
    assert.match(handoff.task.objective, /src\/caller\.mjs:160/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
