import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

for (const actor of ["root", "coordinator"]) for (const mode of ["correction", "cancel", "non-git", "non-git-root", "junction", "replan", "cold-replan", "external-cwd", "registration"] as const) test(`${actor} direct execution: ${mode}`, async t => {
  const cancel = mode === "cancel", nonGit = mode.startsWith("non-git");
  const external = ["external-cwd", "registration"].includes(mode);
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(nonGit ? join(tmpdir(), "mission-direct-") : resolve("_testenv/mission-direct-"));
  const externalDirectory = external ? await mkdtemp(join(tmpdir(), "mission-direct-external-")) : undefined;
  const product = externalDirectory ?? (nonGit ? join(directory, "product") : directory);
  const resultPath = externalDirectory ? join(externalDirectory, "result.txt") : nonGit ? "product/result.txt" : "result.txt";
  try {
    await mkdir(product, { recursive: true });
    await exec("git", ["init", "--quiet"], { cwd: product });
    if (mode === "junction") {
      const target = join(directory, "profile", "IE"), alias = join(directory, "profile", "Content.IE5");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "cached.txt"), "old profile data");
      await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
      const original = fs.readdir;
      t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
        if (resolve(String(args[0])) === alias) throw Object.assign(new Error("alias enumeration denied"), { code: "EPERM" });
        return Reflect.apply(original, fs, args);
      });
      syncBuiltinESMExports();
    }
    await writeFile(join(directory, "check.mjs"), `import {readFileSync} from "node:fs";\nif (readFileSync(${JSON.stringify(resultPath)},"utf8") !== "fixed\\n") process.exit(1);\n`);
    if (externalDirectory) await writeFile(join(externalDirectory, "check.mjs"), await readFile(join(directory, "check.mjs")));
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator", outcome: "running" },
      coordinator: { agent: "dogs-coordinator", parentID: "root", outcome: "running" },
      reviewer: { agent: "dog-reviewer-v010", parentID: actor },
    };
    const history: Record<string, Record<string, unknown>[]> = {};
    const aborted: string[] = [];
    let historyAvailable = true;
    let historyBarrier: (() => Promise<void>) | undefined;
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      messages: async ({ path }: { path: { id: string } }) => { await historyBarrier?.(); return historyAvailable ? ({ data: history[path.id] ?? [] }) : undefined; },
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
    const declaration = { title: "Fix result", objective: "Create result.txt accepted by check.mjs",
      read: ["check.mjs", ...(externalDirectory ? [join(externalDirectory, "check.mjs")] : []), ...(mode === "junction" ? ["profile/**"] : [])],
      write: mode === "non-git-root" ? [directory + "/**"] : [resultPath, "reports/**", ...(mode === "junction" ? ["profile/**"] : [])],
      validation: [mode.endsWith("replan") ? "node check.mjs (workdir: project root)" : "node check.mjs"],
      ...(mode === "external-cwd" ? { validation_cwd: { "node check.mjs": externalDirectory! } } : {}) };
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [declaration] }, { sessionID: actor }));
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
    const write = async (content: string, path = resultPath) => {
      const callID = `write-${++counter}`, args = { filePath: resolve(directory, path), content };
      await hooks["tool.execute.before"]!({ tool: "write", sessionID: actor, callID }, { args });
      await writeFile(args.filePath, content);
      (history[actor] ??= []).push({ info: { id: callID, role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "write", callID,
        state: { status: "completed", input: args, time: { end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "write", sessionID: actor, callID, args }, { output: "written" });
    };
    const check = async (cwd = externalDirectory ?? directory) => {
      const callID = `check-${++counter}`, args = { command: "node check.mjs", workdir: cwd }, start = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: actor, callID }, { args });
      let exit = 0;
      try { await exec(process.execPath, ["check.mjs"], { cwd }); } catch { exit = 1; }
      (history[actor] ??= []).push({ info: { id: callID, role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: args, metadata: { exit }, time: { start, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: actor, callID, args }, { output: exit ? "FAIL" : "PASS", metadata: { exit, status: "completed" } });
      return exit;
    };
    if (mode.endsWith("replan")) {
      const replacement = { executor: "self", reason: "Remove the invalid prose directory annotation; retain requirements",
        units: [{ title: "Fix result", objective: "Create result.txt accepted by check.mjs", read: ["check.mjs"],
          write: [resultPath, "reports/**"], validation: ["node check.mjs"] }] };
      const plan = () => hooks.tool!.sortie_v010_plan_units.execute(replacement as never, { sessionID: actor, callID: "current-plan" });
      await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ ...replacement, reason: "" } as never, { sessionID: actor }), /reason-required/);
      const invalid = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ ...replacement,
        units: [{ ...replacement.units[0], validation: ["Check: node check.mjs"] }] } as never, { sessionID: actor }));
      assert.equal(invalid.status, "invalid-plan");
      assert.equal((await readRun()).runID, before.runID);
      assert.equal((await readRun()).units[0]!.status, "running");
      if (mode === "cold-replan") hooks = await create();
      await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" });
      historyAvailable = false;
      assert.match(JSON.parse(await plan()).status, /tool_terminal_records_unavailable/);
      assert.equal((await readRun()).units[0]!.status, "running");
      historyAvailable = true;
      for (const malformed of [{ parts: [] }, { info: { sessionID: actor } }, { info: { sessionID: "other" }, parts: [] }]) {
        (history[actor] ??= []).push(malformed);
        assert.match(JSON.parse(await plan()).status, /tool_terminal_records_unavailable/);
        assert.equal((await readRun()).units[0]!.status, "running");
        history[actor]!.pop();
      }
      const unfinished = { info: { id: "unfinished", role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "bash", callID: "unfinished",
        state: { status: "running", input: { command: "node check.mjs" }, metadata: { status: "running" } } }] };
      (history[actor] ??= []).push(unfinished);
      assert.match(JSON.parse(await plan()).status, /tool_dispatch_active_or_unproven/);
      unfinished.parts[0]!.state.status = "completed";
      assert.match(JSON.parse(await plan()).status, /tool_dispatch_active_or_unproven/, "background launch completion is not process completion");
      unfinished.parts[0]!.state.metadata.status = "completed";
      (history[actor] ??= []).push({ info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "sortie_v010_plan_units",
        callID: "other-plan", state: { status: "running" } }] });
      assert.match(JSON.parse(await plan()).status, /tool_dispatch_active_or_unproven/, "only the exact current planner is excluded");
      history[actor]!.pop();
      (history[actor] ??= []).push({ info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "sortie_v010_plan_units",
        callID: "current-plan", state: { status: "running" } }] });
      let corrected: { status: string };
      if (mode === "replan") {
        let entered!: () => void, release!: () => void;
        const enteredHistory = new Promise<void>(resolve => { entered = resolve; });
        const holdHistory = new Promise<void>(resolve => { release = resolve; });
        historyBarrier = async () => { entered(); await holdHistory; };
        const planning = plan();
        await enteredHistory;
        let admitted = false;
        const concurrentArgs = { filePath: join(directory, "check.mjs") };
        const concurrent = hooks["tool.execute.before"]!({ tool: "read", sessionID: actor, callID: "concurrent-read" }, { args: concurrentArgs })
          .then(() => { admitted = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(admitted, false, "ordinary tool admission waits for the whole replan transition");
        historyBarrier = undefined; release();
        corrected = JSON.parse(await planning);
        await concurrent;
        await hooks["tool.execute.after"]!({ tool: "read", sessionID: actor, callID: "concurrent-read", args: concurrentArgs }, { output: "inspected" });
      } else corrected = JSON.parse(await plan());
      assert.equal(corrected.status, "direct-unit-running", JSON.stringify(corrected));
      history[actor]!.pop();
      const revised = await readRun();
      assert.notEqual(revised.runID, before.runID);
      assert.deepEqual(revised.acceptance, before.acceptance);
      const retained = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(retained.id, started.mission_id);
      assert.equal(retained.attempts?.length, 2);
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
      assert.equal(status.budget.consumed_units, 1, JSON.stringify(status.budget));
      assert.equal(status.budget.reserved_units, 1);
    }
    await write("broken\n");
    assert.equal(await check(), 1);
    const failed = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.equal(failed.status, "direct-unit-awaits-validation");
    assert.equal((await readRun()).units[0]!.status, "running", "failure remains with the same author");
    hooks = await create();
    await write("fixed\n");
    if (mode === "registration") {
      assert.equal(await check(), 0);
      const old = await readRun(), budget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(old.units[0]!.directExecution!.checks.length, 0, "external diagnostic has no retroactive formal binding");
      const missing = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
      assert.equal(missing.status, "direct-unit-awaits-validation");
      const corrected = { ...declaration, validation_cwd: { "node check.mjs": externalDirectory! } };
      for (const delta of [{ objective: "Different work" },
        { validation: ["node other.mjs"], validation_cwd: { "node other.mjs": externalDirectory! } }, { write: ["other.txt"] }]) {
        await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", reason: "cwd registration", units: [{ ...corrected, ...delta }] },
          { sessionID: actor }), /contract-mismatch/);
      }
      const registration = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", reason: "cwd registration", units: [corrected] }, { sessionID: actor }));
      assert.equal(registration.status, "direct-unit-registration-corrected", JSON.stringify(registration));
      assert.equal(registration.task, undefined);
      const kept = await readRun();
      assert.equal(kept.runID, old.runID);
      assert.equal(kept.units[0]!.callID, old.units[0]!.callID);
      assert.deepEqual(kept.units[0]!.hashes, old.units[0]!.hashes);
      assert.equal(kept.units[0]!.directExecution!.startedAt, old.units[0]!.directExecution!.startedAt);
      assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, budget);
      assert.equal(JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor })).status,
        "direct-unit-awaits-validation", "registration does not manufacture a check/terminal");
      const register = async (unit: typeof corrected | typeof declaration) => JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({
        executor: "self", reason: "cwd registration", units: [unit] }, { sessionID: actor }));
      await register(corrected);
      assert.deepEqual((await readRun()).units[0]!.directExecution!.validationRegisteredAt, kept.units[0]!.directExecution!.validationRegisteredAt,
        "identical registration is idempotent");
      assert.equal((await register(declaration)).status, "direct-unit-registration-corrected", "returning to original cwd is still an in-place correction");
      assert.deepEqual((await readRun()).units[0]!.directExecution!.validationCwd, {});
      assert.equal((await register(corrected)).status, "direct-unit-registration-corrected");
      assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, budget);
      hooks = await create();
    }
    assert.equal(await check(), 0);
    if (externalDirectory) {
      const count = (await readRun()).units[0]!.directExecution!.checks.length;
      assert.equal(await check(directory), 0, "same-text diagnostic also succeeds against a different cwd");
      assert.equal((await readRun()).units[0]!.directExecution!.checks.length, count, "wrong cwd is not formal evidence");
    }
    await write("stale\n");
    const stale = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.equal(stale.status, "direct-unit-awaits-validation");
    await write("fixed\n");
    assert.equal(await check(), 0); // Real native write history requires a check after this edit.
    const checked = (await readRun()).units[0]!.directExecution!.checks;
    if (externalDirectory) assert.equal(checked.at(-1)!.directory, externalDirectory);
    if (mode === "non-git-root") {
      assert.equal(checked.at(-1)!.binding.validation_policy, undefined,
        "a whole-root grant without a concrete output inventory retains full-candidate freshness");
    } else {
      assert.equal(checked.at(-1)!.binding.validation_policy, "inputs-and-concrete-outputs-v1",
        "non-generating native checks retain input/source bindings through final acceptance");
      await mkdir(join(directory, "reports"));
      await write("Actual native check passed.\n", "reports/result.md");
    }
    hooks = await create(); // The saved native checks, not live hook memory, authorize finish.
    const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.notEqual(finished.status, "direct-unit-awaits-validation", JSON.stringify(finished));
    const done = await readRun();
    assert.equal(done.phase, "awaiting-acceptance", JSON.stringify(done));
    assert.ok(done.units[0]!.evidence.length);
    assert.equal(done.units[0]!.directExecution!.checks.length, checked.length, "finish preserves observed validation without reruns");
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(mission.id, started.mission_id);
    assert.equal(mission.attempts?.length, mode.endsWith("replan") ? 2 : 1);
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
    assert.equal(await readFile(resolve(directory, resultPath), "utf8"), "fixed\n");
    assert.equal((await readRun()).units[0]!.directExecution?.actor, actor, "recovery and acceptance retain the same author without a user turn");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true });
    if (externalDirectory) await rm(externalDirectory, { recursive: true, force: true }); }
});
