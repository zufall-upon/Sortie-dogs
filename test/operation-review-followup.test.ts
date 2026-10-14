import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { missionExecutionStatus, missionExecutionRecoveryAction, missionPacket, missionOperationCommandMatch,
  OperatorMissionRuntime, type OperatorMission } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

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
