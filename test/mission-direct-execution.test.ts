import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

for (const actor of ["root", "coordinator"]) for (const cancel of [false, true]) test(`${actor} direct execution: ${cancel ? "cold cancellation and replacement" : "correction, fresh checks and independent Review"}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-direct-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), 'import {readFileSync} from "node:fs";\nif (readFileSync("result.txt","utf8") !== "fixed\\n") process.exit(1);\n');
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator", outcome: "running" },
      coordinator: { agent: "dogs-coordinator", parentID: "root", outcome: "running" },
      reviewer: { agent: "dog-reviewer-v010", parentID: actor },
    };
    const history: Record<string, Record<string, unknown>[]> = {};
    const aborted: string[] = [];
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents).filter(([, item]) => item.parentID === path.id)
        .map(([id, item]) => ({ id, ...item })) }),
      abort: async ({ path }: { path: { id: string } }) => { aborted.push(path.id); agents[path.id]!.outcome = "interrupted"; return { data: true }; },
    } } } as never);
    let hooks = await create();
    const prompt = async (id: string, text: string) => {
      await hooks["chat.message"]!({ sessionID: id, messageID: `${id}-prompt`, agent: agents[id]!.agent }, {
        message: { id: `${id}-prompt`, agent: agents[id]!.agent, model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
        parts: [{ type: "text", text }],
      });
    };
    await prompt("root", "Make result.txt fixed and run node check.mjs; independent review required.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed result"] }, { sessionID: "root" }));
    if (actor === "coordinator") {
      const task = { args: structuredClone(started.task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, task);
      await prompt(actor, task.args.prompt);
    }
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [{ title: "Fix result",
      objective: "Create result.txt accepted by check.mjs", read: ["check.mjs"], write: ["result.txt", "reports/**"], validation: ["node check.mjs"] }] }, { sessionID: actor }));
    assert.equal(planned.status, "direct-unit-running", JSON.stringify(planned));
    assert.equal(planned.task, undefined, "direct author receives no Worker handoff");
    const readRun = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    const before = await readRun();
    assert.equal(before.units[0]!.directExecution?.actor, actor);
    assert.equal(before.dispatched, 0, "no native Worker Task was dispatched");
    if (cancel) {
      hooks = await create();
      await hooks.tool!.sortie_v010_cancel_operator.execute({ reason: "plain" }, { sessionID: "root" });
      assert(!aborted.includes("root"), "cancelling direct work never aborts its root caller");
      assert.equal((await readRun()).units[0]!.status, "cancelled");
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
      assert.equal(status.budget.reserved_units, 0, JSON.stringify(status));
      if (actor === "coordinator") delete agents.reviewer; // No Reviewer Task exists in this branch.
      hooks = await create();
      await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed result"] }, { sessionID: "root" });
      const replacement = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [{ title: "Resume result",
        objective: "Create result.txt accepted by check.mjs", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] }, { sessionID: "root" }));
      assert.equal(replacement.status, "direct-unit-running", JSON.stringify(replacement));
      return;
    }
    let counter = 0;
    const write = async (content: string, path = "result.txt") => {
      const callID = `write-${++counter}`, args = { filePath: join(directory, path), content };
      await hooks["tool.execute.before"]!({ tool: "write", sessionID: actor, callID }, { args });
      await writeFile(args.filePath, content);
      (history[actor] ??= []).push({ info: { id: callID, role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "write", callID,
        state: { status: "completed", input: args, time: { end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "write", sessionID: actor, callID, args }, { output: "written" });
    };
    const check = async () => {
      const callID = `check-${++counter}`, args = { command: "node check.mjs" }, start = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: actor, callID }, { args });
      let exit = 0;
      try { await exec(process.execPath, ["check.mjs"], { cwd: directory }); } catch { exit = 1; }
      (history[actor] ??= []).push({ info: { id: callID, role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: args, metadata: { exit }, time: { start, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: actor, callID, args }, { output: exit ? "FAIL" : "PASS", metadata: { exit, status: "completed" } });
      return exit;
    };
    await write("broken\n");
    assert.equal(await check(), 1);
    const failed = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.equal(failed.status, "direct-unit-awaits-validation");
    assert.equal((await readRun()).units[0]!.status, "running", "failure remains with the same author");
    hooks = await create();
    await write("fixed\n");
    assert.equal(await check(), 0);
    await write("stale\n");
    const stale = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.equal(stale.status, "direct-unit-awaits-validation");
    await write("fixed\n");
    assert.equal(await check(), 0); // Real native write history requires a check after this edit.
    const checked = (await readRun()).units[0]!.directExecution!.checks;
    assert.equal(checked.at(-1)!.binding.validation_policy, "inputs-and-concrete-outputs-v1",
      "non-generating native checks retain input/source bindings through final acceptance");
    await mkdir(join(directory, "reports"));
    await write("Actual native check passed.\n", "reports/result.md");
    hooks = await create(); // The saved native checks, not live hook memory, authorize finish.
    const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.notEqual(finished.status, "direct-unit-awaits-validation", JSON.stringify(finished));
    const done = await readRun();
    assert.equal(done.phase, "awaiting-acceptance", JSON.stringify(done));
    assert.ok(done.units[0]!.evidence.length);
    assert.equal(done.units[0]!.directExecution!.checks.length, checked.length, "report creation does not rerun validation");
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(mission.id, started.mission_id);
    assert.equal(mission.attempts?.length, 1);
    assert.equal(mission.attempts?.[0]?.kind, "direct_execution");
    assert.equal(mission.attempts?.[0]?.terminal, undefined, "active parent is not a native child terminal");
    await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review/);
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"] }, { sessionID: actor }));
    const task = { args: structuredClone(review.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "review-call" }, task);
    agents.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: "review-call" }, { output: "PASS\nResult and actual check agree.", metadata: { sessionId: "reviewer" } });
    if (actor === "coordinator") await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "Direct correction validated and independently reviewed" }, { sessionID: actor });
    const completed = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "fixed\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
