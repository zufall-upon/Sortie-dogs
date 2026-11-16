import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { MISSION_BEHAVIOR_REVIEW } from "../dist/runtime-mission-assets.js";
import { runtimeAssets } from "../dist/runtime-assets-v010.js";

const exec = promisify(execFile);

test("failed implementation then read-only validation and test-only replan keep mission-wide review on restart", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-review-replan-"));
  try {
    for (const args of [["init", "--quiet"], ["config", "user.name", "test"], ["config", "user.email", "test@example.invalid"]]) {
      await exec("git", args, { cwd: root });
    }
    await writeFile(join(root, "source.js"), "return oldValue;\n");
    await writeFile(join(root, "check.mjs"), "console.log('validation');\n");
    await mkdir(join(root, "test"));
    await writeFile(join(root, "test", "existing.test.mjs"), "assert.equal(value, 1);\nassert.equal(value, 1);\n");
    await exec("git", ["add", "--all"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    };
    const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
    } } } as never);
    const hooks = await create();
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }],
    });
    await chat("root", "Fix the source, validate and review it.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Fix the source"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const currentRun = () => new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
    const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
    for (const [index, write] of [["source.js"], [], ["test.js", "test/**"]].entries()) {
      const next = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: `Unit ${index}`, objective: "Finish the source candidate",
        read: index === 0 ? ["check.mjs", "test/existing.test.mjs"] : ["check.mjs"], write, validation: [`node check.mjs ${index}`] }], ...(index ? { reason: "Correct the previous unit and validate" } : {}) }, { sessionID: "coordinator" }));
      const worker = `worker-${index}`, callID = `worker-call-${index}`;
      identities[worker] = { agent: "dog-worker-v010", parentID: "coordinator" };
      const task = { args: structuredClone(next.task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID }, task);
      await chat(worker, task.args.prompt);
      const unit = (await currentRun()).units[0]!;
      assert.deepEqual(unit.unit.write, write, "retained review scope must not expand the new Worker grant");
      if (index === 0) {
        const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
        assert.equal(handoff.ext["sortie-dogs/mission-context"].test_debt_audit.signals[0].path, "test/existing.test.mjs");
        assert.match(handoff.ext["sortie-dogs/mission-context"].test_debt_audit.instruction, /do not modify unowned work/);
      }
      if (index === 2) {
        const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
        assert.equal(handoff.ext["sortie-dogs/mission-context"].test_debt_audit.signals[0].path, "test/existing.test.mjs",
          "a later planning milestone can re-evaluate a previously scheduled file");
        assert.equal((await missions.required("root")).testDebtSignals?.filter(signal => signal.path === "test/existing.test.mjs").length, 2);
      }
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: worker, callID: `handoff-${index}` }, { args: { filePath: unit.handoffPath } });
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: worker, callID: `handoff-${index}`, args: { filePath: unit.handoffPath } }, { output: "inspected" });
      await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: root, manifest_path: unit.manifestPath }, { sessionID: worker });
      if (index === 0) await writeFile(join(root, "source.js"), "return nilValue;\n");
      if (index === 2) await writeFile(join(root, "test.js"), "assert.equal(value, null);\n");
      await exec("git", ["add", "--", ...(write.length ? write : ["source.js"])], { cwd: root });
      if (write.length) await exec("git", ["commit", "--quiet", "-m", `candidate ${index}`], { cwd: root });
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: worker, callID: `validation-${index}` }, { args: { command: `node check.mjs ${index}` } });
      // Native exit 1 models the initial setup failure after implementation was committed.
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: worker, callID: `validation-${index}` }, { output: index ? "PASS" : "setup failed", metadata: { exit: index ? 0 : 1, status: "completed" } });
      identities[worker]!.outcome = "succeeded";
      const returned = { output: "returned", metadata: { sessionId: worker } };
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID }, returned);
      if (index === 0) assert.equal((await currentRun()).units[0]!.status, "failed", JSON.stringify(returned));
      if (index === 1) assert.deepEqual((await missions.required("root")).reviewScope?.write, ["source.js"]);
    }
    const cold = await create();
    await cold.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"], traces: ["Source corrected; checks passed"] }, { sessionID: "coordinator" });
    const mission = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
    assert.deepEqual(mission.reviewScope?.write, ["source.js", "test.js", "test/**"]);
    assert.match(mission.review!.task!.prompt, /changed: source\.js/);
    assert.match(mission.review!.task!.prompt, /return nilValue/);
    assert.match(mission.review!.task!.prompt, /changed: test\.js/);
    assert.ok(mission.review!.task!.prompt.includes(MISSION_BEHAVIOR_REVIEW));
    assert.match(mission.review!.task!.prompt, /compare relevant existing tests by inputs, boundaries, assertions and failure detection/);
    assert.match(mission.review!.task!.prompt, /duplication, weak or meaningless assertions, excessive mocks/);
    assert.ok(runtimeAssets.find(asset => asset.name === "dog-reviewer-v010")!.content.includes(MISSION_BEHAVIOR_REVIEW),
      "installed Reviewer and dispatched review use the same behavioral and workflow guidance");
    await missions.update("root", item => { item.review!.verdict = "PASS"; });
    await writeFile(join(root, "source.js"), "return stale;\n");
    await assert.rejects(cold.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "done" }, { sessionID: "coordinator" }), /mission-review-required-or-stale/);
    await missions.update("root", item => { item.phase = "completed"; });
    await missions.capture("root", { id: "new-request", text: "Independent mission" });
    assert.equal((await missions.start("root", ["Independent mission"])).reviewScope, undefined, "new missions start fresh");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("planning schedules an existing test signal for its writable unit, not an earlier reader", async () => {
  for (const scope of ["file", "directory", "absolute"] as const) {
    await mkdir(resolve("_testenv"), { recursive: true });
    const root = await mkdtemp(resolve("_testenv/mission-audit-owner-"));
    try {
      await mkdir(join(root, "test"));
      await writeFile(join(root, "source.mjs"), "export const value = 1;\n");
      const testFile = join(root, "test", "value.test.mjs");
      await writeFile(testFile, 'import assert from "node:assert/strict";\nassert.equal(1, 1);\nassert.equal(1, 1);\n');
      const identities: Record<string, { agent: string; parentID?: string }> = {
        root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      };
      const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
        children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
          .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
        messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
      } } } as never);
      const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent }, {
        message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "fixture" } }, parts: [{ type: "text", text }],
      });
      await chat("root", "Implement the calculation and improve its tests.");
      const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Implement the calculation and improve its tests"] }, { sessionID: "root" }));
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
      await chat("coordinator", started.task.prompt);
      const writerScope = scope === "file" ? "test/value.test.mjs" : scope === "directory" ? "test/**" : testFile;
      await hooks.tool!.sortie_v010_plan_units.execute({ units: [
        { title: "Implement calculation", objective: "Implement source only", read: scope === "directory" ? [] : ["test/value.test.mjs"],
          write: ["source.mjs"], validation: [scope === "directory" ? "node --check source.mjs --source" : "node test/value.test.mjs --source"] },
        { title: "Improve tests", objective: "Improve tests", read: ["source.mjs"], write: [writerScope], validation: ["node --check source.mjs"] },
      ] }, { sessionID: "coordinator" });
      const run = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
      const signal = (await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).testDebtSignals![0]!;
      assert.equal(signal.path, "test/value.test.mjs");
      assert.equal(signal.unit_id, run.units[1]!.unit.id, scope);
      assert.deepEqual(run.units[0]!.unit.write, ["source.mjs"], "assignment does not expand write scope");
      assert.deepEqual(run.units[1]!.unit.write, [writerScope]);
      const handoff = JSON.parse(await readFile(run.units[1]!.handoffPath, "utf8"));
      assert.equal(handoff.ext["sortie-dogs/mission-context"].test_debt_audit.signals[0].unit_id, run.units[1]!.unit.id);
      assert.match(handoff.ext["sortie-dogs/mission-context"].test_debt_audit.instruction, /Act only on signals for your own unit/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
