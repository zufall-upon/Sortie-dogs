import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { missionExecutionStatus, missionExecutionRecoveryAction, missionPacket, missionOperationCommandMatch, missionOperationCommandDecorated,
  missionOperationCommandRebind, missionCommandOutcome,
  OperatorMissionRuntime, type OperatorMission } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

test("literal elapsed-time operation envelope preserves exact command identity", () => {
  const command = "/usr/bin/python3 -B tools/start.py --background > /tmp/result.json";
  const timed = `TIMEFORMAT='ELAPSED=%R'; time ${command}`;
  assert.equal(missionOperationCommandMatch(timed, [command], "/repo"), command);
  assert.equal(missionOperationCommandDecorated(timed, [command], "/repo"), false);
  assert.equal(missionOperationCommandMatch(timed, [timed, command], "/repo"), timed, "an exact declaration takes precedence");
  assert.equal(missionOperationCommandMatch(timed, [command], "C:\\repo"), undefined, "POSIX timing is not inferred for Windows operations");
  assert.equal(missionOperationCommandMatch(timed, [command, ` ${command} `], "/repo"), undefined, "ambiguous declarations cannot be recovered");
  for (const other of [timed.replace("start.py", "other.py"), timed.replace("result.json", "other.json"),
    `TIMEFORMAT='ELAPSED=$VALUE'; time ${command}`, `TIMEFORMAT='ELAPSED=%R'; time -p ${command}`,
    `TIMEFORMAT='ELAPSED=%R'; time ${command}; echo done`, timed.replace("tools/start.py --background", "tools/start.py\n--background")]) {
    assert.equal(missionOperationCommandMatch(other, [command], "/repo"), undefined, other);
  }
  assert.equal(missionOperationCommandDecorated(`${timed}; echo done`, [command], "/repo"), true);
  assert.equal(missionOperationCommandDecorated(timed, [timed], "/repo"), false);
  for (const suffix of ["; echo done", " && echo done", " | cat"]) {
    assert.equal(missionOperationCommandMatch(`${timed}${suffix}`, [timed], "/repo"), undefined);
    assert.equal(missionOperationCommandDecorated(`${timed}${suffix}`, [timed], "/repo"), true);
  }
});

test("elapsed operation rebind keeps directional binary proof and timing output stays command-bound", () => {
  const plain = "node check.mjs", timed = `TIMEFORMAT='ELAPSED=%R'; time ${plain}`;
  assert.equal(missionOperationCommandRebind(plain, [timed], "/repo"), timed);
  assert.equal(missionOperationCommandRebind(timed, [plain], "/repo"), plain);
  assert.equal(missionOperationCommandRebind(plain, ["/other/node check.mjs"], "/repo"), undefined);
  assert.equal(missionOperationCommandRebind("/actual/node check.mjs", [plain], "/repo"), plain,
    "an already pinned binary may still prove the less specific bare-node declaration");
  const output = "NO_START\nELAPSED=0.001\n";
  for (const command of [undefined, plain, timed.replace("ELAPSED", "OTHER")]) {
    assert.equal(missionCommandOutcome(output, 0, "completed", command).outcome, "executed",
      "unrelated output interpretation retains the established unstructured-exit contract");
  }
  assert.equal(missionCommandOutcome(output, 0, "completed", timed).outcome, "not-started");
  assert.equal(missionCommandOutcome("NO_STARTELAPSED=0.001\n", 0, "completed", timed).outcome, "not-started");
  assert.equal(missionCommandOutcome("NO_START\nOTHER=0.001\n", 0, "completed", timed).outcome, "executed");
});

for (const declaration of ["plain", "timed"] as const) for (const mode of ["success", "no-start", "structured-failure"] as const) test(`live timed operation records its actual terminal without accepting extra commands: ${declaration}, ${mode}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/operation-timed-live-"));
  const identities = { root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root", time: { created: Date.now() } } };
  const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
    get: async ({ path }: { path: { id: keyof typeof identities } }) => ({ data: { id: path.id, ...identities[path.id] } }),
    messages: async () => ({ data: [] }), children: async () => ({ data: [] }), abort: async () => ({ data: true }),
  } } } as never);
  const chat = (id: keyof typeof identities, text: string) => hooks["chat.message"]!({ sessionID: id, agent: identities[id].agent, messageID: `${id}-prompt` }, {
    message: { id: `${id}-prompt`, agent: identities[id].agent, model: { providerID: "openai", modelID: "fixture" } }, parts: [{ type: "text", text }],
  });
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    const script = mode === "no-start" ? 'console.log("NO_START");\n' : mode === "structured-failure"
      ? 'console.log(JSON.stringify({status:"setup-failed",attempts:1}, null, 2));\n' : 'console.log("PASS");\n';
    await writeFile(join(directory, "check.mjs"), script);
    await chat("root", "Run once and retain its native operation result.");
    const command = "TIMEFORMAT='ELAPSED=%R'; time node check.mjs";
    const declared = declaration === "timed" ? command : "node check.mjs";
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Collect operation result"], kind: "operation",
      execution: { commands: [declared], directory }, unit: { title: "Operation", objective: "Collect result",
        read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] } }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, { args: structuredClone(started.task) });
    await chat("worker", started.task.prompt);
    const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
    const read = { tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } };
    await hooks["tool.execute.before"]!(read, { args: read.args });
    await hooks["tool.execute.after"]!(read, { output: "inspected" });
    await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: directory, manifest_path: unit.manifestPath }, { sessionID: "worker" });
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "extra" },
      { args: { command: `${command}; echo extra`, workdir: directory } }), /mission-operation-command-not-observed/);
    const request = { tool: "shell", sessionID: "worker", callID: "timed", args: { command, workdir: directory } };
    await hooks["tool.execute.before"]!(request, { args: request.args });
    const mission = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    assert.equal((await mission.required("root")).execution!.observations[0]!.command, declared);
    const result = await exec("bash", ["-c", command], { cwd: directory });
    await hooks["tool.execute.after"]!(request, { output: result.stdout + result.stderr, metadata: { exit: 0, status: "completed" } });
    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    const expected = mode === "no-start" ? "not-started" : mode === "structured-failure" ? "execution-failed" : "executed";
    assert.equal(status.acceptance_summary.operation.status, expected);
    assert.equal(status.acceptance_summary.operation.process_succeeded, mode === "no-start" ? null : mode === "success");
    assert.equal(status.acceptance_summary.operation.observations.length, 1);
    assert.equal(status.acceptance_summary.operation.observations[0].callID, "timed");
    assert.equal(status.acceptance_summary.operation.observations[0].exit, 0, "the actual native exit is retained even for a structured failure");
    if (mode === "structured-failure") assert.deepEqual(status.acceptance_summary.operation.observations[0].result,
      { status: "setup-failed", attempts: 1 });
    assert.equal(status.phase, "running", "operation observation is not Mission acceptance");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("PR250 review follow-up: Windows absolute arguments retain drive and UNC path identity", () => {
  for (const [declared, actual] of [["M:\\Work\\plan.json", "m:/work/PLAN.json"],
    ["\\\\NAS\\Share\\Work\\plan.json", "\\\\nas\\share\\work\\PLAN.json"]]) {
    const command = `node apply.mjs '${declared}'`;
    assert.equal(missionOperationCommandMatch(`& 'M:/Tools/node.exe' 'M:/Work/Repo/apply.mjs' '${actual}'`, [command], "M:\\Work\\Repo"), command);
    assert.equal(missionOperationCommandMatch(`node apply.mjs '${actual!.replace("PLAN", "OTHER")}'`, [command], "M:\\Work\\Repo"), undefined);
  }
  assert.equal(missionOperationCommandMatch("node /repo/apply.mjs /route", ["node apply.mjs /Route"], "/repo"), undefined);
  assert.equal(missionOperationCommandMatch("node /repo/apply.mjs tenant/b", ["node apply.mjs tenant/a/../b"], "/repo"), undefined);
});

test("PR250 review follow-up: ambiguous observed calls block recovery without permitting replay", () => {
  const observation = { command: "node check.mjs", directory: "/repo", callID: "native-call", sessionID: "worker",
    startedAt: "2026-10-14T00:00:00Z", completedAt: "2026-10-14T00:00:01Z", status: "completed" as const };
  for (const patch of [{}, { status: "error" as const }, { completedAt: undefined },
    { conflicting: true, exit: 0, outcome: "executed" as const }]) {
    const mission = { version: "0.12", id: "mission", kind: "operation", root: "root", phase: "running", runID: null, requests: [], progress: [], requirements: [],
      attempts: [], execution: { commands: [observation.command], directory: observation.directory, observations: [{ ...observation, ...patch }] } } as unknown as OperatorMission;
    assert.equal(missionExecutionStatus(mission), "recovery-blocked");
    assert.match(missionExecutionRecoveryAction(mission)!, /do not replay or rerun/iu);
    assert.match(String(missionPacket(mission, undefined, false).next_action), /do not replay or rerun/iu);
    mission.execution!.observations[0]!.outcome = "not-started";
    delete mission.execution!.observations[0]!.conflicting;
    if (mission.execution!.observations[0]!.completedAt) assert.equal(missionExecutionStatus(mission), "not-started", "explicit NO_START is not unknown execution");
  }
});

for (const shell of ["powershell", "pwsh", "powershell_exec", "PWSH-run"]) {
  for (const route of ["live", "saved"] as const) test(`PR250 review follow-up: ${shell} operation ${route} observation`, async () => {
    await mkdir(resolve("_testenv"), { recursive: true });
    const directory = await mkdtemp(resolve("_testenv/operation-shell-review-"));
    const identities = { root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root", time: { created: Date.now() } } };
    const history: object[] = [];
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: keyof typeof identities } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: path.id === "worker" ? history : [] }),
      children: async () => ({ data: [] }), abort: async () => ({ data: true }),
    } } } as never);
    let hooks = await create();
    const chat = (id: keyof typeof identities, text: string) => hooks["chat.message"]!({ sessionID: id, agent: identities[id].agent, messageID: `${id}-prompt` }, {
      message: { id: `${id}-prompt`, agent: identities[id].agent, model: { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }],
    });
    try {
      await exec("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(join(directory, "check.mjs"), 'console.log("PASS");\n');
      await chat("root", "Run once and retain its native operation result.");
      const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Collect operation result"], kind: "operation",
        execution: { commands: ["node check.mjs"], directory }, unit: { title: "Operation", objective: "Collect native result", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] } }, { sessionID: "root" }));
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, { args: structuredClone(started.task) });
      await chat("worker", started.task.prompt);
      const run = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), unit = run.units[0]!;
      const read = { tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } };
      await hooks["tool.execute.before"]!(read, { args: read.args });
      await hooks["tool.execute.after"]!(read, { output: "inspected" });
      await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: directory, manifest_path: unit.manifestPath }, { sessionID: "worker" });
      const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
      const request = { tool: shell, sessionID: "worker", callID: "native-operation", args: { command: "node check.mjs", workdir: directory } };
      if (route === "live") {
        await hooks["tool.execute.before"]!(request, { args: request.args });
        assert.equal((await missions.required("root")).execution!.observations.length, 1);
      }
      const start = Date.now(), checked = await exec(process.execPath, ["check.mjs"], { cwd: directory }), end = Date.now();
      if (route === "live") await hooks["tool.execute.after"]!(request, { output: checked.stdout, metadata: { exit: 0, status: "completed" } });
      else history.push({ info: { role: "assistant", sessionID: "worker" }, parts: [{ type: "tool", tool: shell, sessionID: "worker", callID: request.callID,
        state: { status: "completed", input: request.args, metadata: { exit: 0, status: "completed" }, output: checked.stdout, time: { start, end } } }] });
      hooks = await create();
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
      assert.equal(status.acceptance_summary.operation.status, "executed");
      assert.equal(status.acceptance_summary.operation.observations[0].callID, request.callID);
      assert.equal(status.phase, "running", "operation observation is not Mission acceptance");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
