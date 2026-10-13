import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import test from "node:test";
import { createHash } from "node:crypto";
import { missionPacket, OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";

const exec = promisify(execFile);

const directModes = ["correction", "cancel", "non-git", "non-git-root", "junction", "replan", "cold-replan", "external-cwd", "registration", "large-source", "blocked", "needs-decision", "parent-interrupted", "parent-cancelled", "parent-failed", "parent-completed", "parent-unset", "finish-cancelled", "recovery", "recovery-failed", "recovery-stale", "recovery-latest-failure", "recovery-missing-finish", "recovery-explicit-cancel", "recovery-crash", "recovery-projection-crash", "recovery-pending", "recovery-pending-projection-crash", "recovery-normal-succeeded", "recovery-boundary", "recovery-paginated"] as const;
for (const actor of ["root", "coordinator"]) for (const mode of directModes.filter(mode =>
  actor === "coordinator" || !mode.includes("pending") && mode !== "recovery-normal-succeeded")) test(`${actor} direct execution: ${mode}`, async t => {
  const cancel = mode === "cancel", nonGit = mode.startsWith("non-git");
  const incomplete = mode === "blocked" || mode === "needs-decision";
  const external = ["external-cwd", "registration"].includes(mode);
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(nonGit ? join(tmpdir(), "mission-direct-") : resolve("_testenv/mission-direct-"));
  const externalDirectory = external ? await mkdtemp(join(tmpdir(), "mission-direct-external-")) : undefined;
  const product = externalDirectory ?? (nonGit ? join(directory, "product") : directory);
  const resultPath = externalDirectory ? join(externalDirectory, "result.txt") : nonGit ? "product/result.txt" : "result.txt";
  try {
    await mkdir(product, { recursive: true });
    await exec("git", ["init", "--quiet"], { cwd: product });
    if (mode === "large-source") {
      await mkdir(join(product, "context"));
      // Keep the raw packet over 32 KB even with shorter POSIX paths; the size
      // precondition must not depend on the host's checkout path length.
      await Promise.all(Array.from({ length: 400 }, (_, i) => writeFile(join(product, "context", `protected-source-${i}.txt`), "protected source\n")));
      await exec("git", ["add", "--", "context"], { cwd: product });
      await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture protected inputs"], { cwd: product });
    }
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
    if (incomplete) await writeFile(join(directory, "check.mjs"), "process.exit(4);\n");
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
      messages: async ({ path }: { path: { id: string } }) => {
        await historyBarrier?.();
        if (historyAvailable) return { data: history[path.id] ?? [] };
        return mode === "recovery-paginated" ? { data: (history[path.id] ?? []).map(message => ({ ...message,
          parts: (message.parts as { tool?: string }[] ?? []).filter(part => part.tool !== "sortie_v010_finish_direct_unit") })) } : undefined;
      },
      ...(mode === "recovery-paginated" ? { reviewMessages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }) } : {}),
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
    let coordinatorOwner: Record<string, unknown> | undefined;
    if (actor === "coordinator") {
      const task = { args: structuredClone(started.task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, task);
      coordinatorOwner = hooks.backgroundOwner!("coordinator-call");
      await prompt(actor, task.args.prompt);
    }
    const declaration = { title: "Fix result", objective: "Create result.txt accepted by check.mjs",
      read: ["check.mjs", ...(externalDirectory ? [join(externalDirectory, "check.mjs")] : []), ...(mode === "junction" ? ["profile/**"] : [])],
      write: mode === "non-git-root" ? [directory + "/**"] : [resultPath, "reports/**", ...(mode === "junction" ? ["profile/**"] : [])],
      validation: [mode.endsWith("replan") ? "node check.mjs (workdir: project root)" : "node check.mjs"],
      ...(mode === "external-cwd" ? { validation_cwd: { "node check.mjs": externalDirectory! } } : {}) };
    const multi = mode.includes("pending") || mode === "recovery-normal-succeeded";
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [declaration,
      ...(multi ? [{ ...declaration, title: "Second planned result", objective: "Validate the second planned result",
        validation: ["node check.mjs --second"] }] : [])] }, { sessionID: actor }));
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
    const check = async (cwd = externalDirectory ?? directory, command = "node check.mjs") => {
      const callID = `check-${++counter}`, args = { command, workdir: cwd }, start = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: actor, callID }, { args });
      let exit = 0;
      try { await exec(process.execPath, ["check.mjs", ...(command.endsWith(" --second") ? ["--second"] : [])], { cwd }); } catch (error) { exit = Number((error as { code?: unknown }).code) || 1; }
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
    assert.equal(await check(), incomplete ? 4 : 1);
    const failed = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.equal(failed.status, "direct-unit-awaits-validation");
    assert.equal((await readRun()).units[0]!.status, "running", "failure remains with the same author");
    hooks = await create();
    if (incomplete) {
      const active = await readRun(), checks = active.units[0]!.directExecution!.checks;
      const budget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(budget.reserved_units, 1);
      const summary = "Original required native check exits 4; retain the patch and report incomplete, not success.";
      await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary }, { sessionID: actor }), /mission-units-incomplete/);
      const args = { filePath: join(directory, "check.mjs") }, callID = "active-read";
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: actor, callID }, { args });
      await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: mode, summary }, { sessionID: actor }), /mission-direct-tools-running/);
      assert.equal((await readRun()).units[0]!.status, "running", "submitted blocker cannot release an active native tool");
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: actor, callID, args }, { output: "process.exit(4);" });
      const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_mission.execute({ status: mode, summary }, { sessionID: actor }));
      const stopped = await readRun();
      assert.equal(submitted.phase, "submitted");
      assert.deepEqual(submitted.submission, { status: mode, summary });
      assert.equal(submitted.execution_summary.accepted, false);
      assert.equal(stopped.phase, "awaiting-decision");
      assert.equal(stopped.runID, active.runID);
      assert.equal(stopped.units[0]!.callID, active.units[0]!.callID);
      assert.equal(stopped.units[0]!.status, "failed");
      assert.deepEqual(stopped.units[0]!.failure, { command: ["node check.mjs"], outcome: "fail", exitCode: 4 });
      assert.ok(stopped.units[0]!.directExecution!.finishedAt);
      assert.deepEqual(stopped.units[0]!.directExecution!.checks, checks, "failed native checks remain historical, never rerun or rewritten");
      assert.deepEqual(stopped.units[0]!.evidence, [], "failed delivery contributes no successful evidence");
      const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(mission.attempts?.length, 1);
      assert.equal(mission.attempts?.[0]?.status, "failed");
      assert.equal(mission.attempts?.[0]?.terminal, undefined, "stopping direct work never fabricates a native child terminal");
      assert.equal(mission.review, undefined);
      await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
      const settledBudget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(settledBudget.reserved_units, 0);
      assert.equal(settledBudget.consumed_units, budget.consumed_units + 1);
      await hooks.tool!.sortie_v010_submit_mission.execute({ status: mode, summary }, { sessionID: actor });
      assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, settledBudget,
        "repeated submission does not reserve or settle another unit");
      assert.equal(await readFile(join(directory, resultPath), "utf8"), "broken\n");
      assert.deepEqual(aborted, [], "failure disposition does not interrupt its controller or dispatch a replacement");
      if (coordinatorOwner) {
        hooks.backgroundOwner!("coordinator-call", coordinatorOwner);
        const returned = { output: summary, metadata: { sessionID: actor, status: "succeeded" } };
        await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, returned);
        const packet = JSON.parse(returned.output);
        assert.equal(packet.coordinator_report, summary);
        assert.equal(packet.status, "awaiting-decision");
        assert.deepEqual(packet.submission, { status: mode, summary });
        assert.equal(packet.execution_summary.accepted, false, "successful native delivery does not accept incomplete work");
        assert.deepEqual(packet.units[0].failure, { outcome: "fail", exit_code: 4 });
        assert.deepEqual(packet.units[0].evidence, []);
        assert.equal((await readRun()).units[0]!.status, "failed");
      }
      return;
    }
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
    if (mode.startsWith("recovery") || mode === "finish-cancelled") {
      if (mode === "recovery-normal-succeeded") {
        await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor });
        assert.equal((await readRun()).units[0]!.status, "succeeded");
        await hooks.tool!.sortie_v010_start_direct_unit.execute({}, { sessionID: actor });
        assert.equal(await check(directory, "node check.mjs --second"), 0);
      }
      if (mode === "recovery-latest-failure") {
        await write("bad\n"); assert.equal(await check(), 1); await writeFile(join(directory, resultPath), "fixed\n");
      }
      const state = await readRun(), unitIndex = mode === "recovery-normal-succeeded" ? 1 : 0, unit = state.units[unitIndex]!, direct = unit.directExecution!;
      const key = createHash("sha256").update("v010\u0000root").digest("hex");
      const ledger = await RunFlightLedger.openGoal(join(directory, ".git", "sortie-dogs", V010_RUNTIME_PROFILE.flightDirectory, `${key}.json`));
      const before = await ledger.readGoal(), reservation = before.state.outstanding_reservations[0]!;
      assert.equal(reservation.unit_id, /^task_id: (.+)$/mu.exec(unit.task.prompt)![1]);
      const failed = mode === "recovery-failed", at = new Date().toISOString();
      const receipt = goalFingerprint({ call_id: unit.callID,
        output: "Host-observed direct unit finished; controller session remains active." });
      await ledger.appendGoal({ kind: "unit.settled", at, goal_id: before.state.goal_id!, reservation_id: reservation.reservation_id,
        receipt_id: receipt, unit_id: reservation.unit_id, disposition: failed ? "failed" : "cancelled",
        result_class: failed ? "acceptance" : "interrupted", evidence: [], progress_fingerprint: null, elapsed_ms: 12, cost_usd: 0.7,
        native_session_id: actor, native_started_at: direct.startedAt });
      if (mode === "finish-cancelled") {
        const result = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
        assert.equal(result.units[0].status, "cancelled"); assert.equal(result.direct_settlement.disposition, "cancelled");
        assert.match(result.next_action, /not validated/); assert.doesNotMatch(result.next_action, /This direct unit is validated/);
        assert.equal((await readRun()).units[0]!.evidence.length, 0); return;
      }
      await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).settled({ rootSessionID: "root", callID: unit.callID!,
        unitID: reservation.unit_id, childSessionID: actor, disposition: failed ? "failed" : "cancelled",
        resultClass: failed ? "acceptance" : "interrupted", evidence: [], nativeOutcome: "failed" });
      await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).update("root", mission => {
        const attempt = mission.attempts!.find(attempt => attempt.callID === unit.callID)!;
        attempt.status = failed ? "failed" : "cancelled"; attempt.resultClass = failed ? "acceptance" : "interrupted";
        attempt.failure = { category: "cancellation", code: "native-task-cancelled" };
        mission.progress.push({ unit: `${state.runID}/${unit.unit.id}`, title: unit.unit.title, status: attempt.status, at });
      });
      if (mode !== "recovery-missing-finish") (history[actor] ??= []).push({
        info: { role: "assistant", sessionID: actor, finish: "stop", time: { created: Date.parse(at) - 1, completed: Date.parse(at) + 1 } },
        parts: [{ type: "tool", tool: "sortie_v010_finish_direct_unit", callID: "historical-finish", state: {
          status: "completed", input: {}, time: { start: Date.parse(at) - 1, end: Date.parse(at) + 1 },
          output: JSON.stringify({ run_id: state.runID, status: "awaiting-decision", next_action: "This direct unit is validated" }) } }],
      });
      const broken = await readRun(), spent = (await ledger.readGoal()).state;
      assert.equal(broken.units[unitIndex]!.evidence.length, 0);
      assert.equal(broken.phase, "awaiting-decision");
      if (mode === "recovery-stale") await writeFile(join(directory, resultPath), "changed after validation\n");
      agents[actor]!.outcome = failed ? "failed" : "interrupted";
      if (mode === "recovery-paginated") historyAvailable = false;
      hooks = await create();
      if (mode === "recovery-explicit-cancel") {
        await hooks.tool!.sortie_v010_cancel_operator.execute({ run_id: state.runID, reason: "Explicit user cancellation" }, { sessionID: "root" });
      }
      const recover = () => hooks.tool!.sortie_v010_resume_operator.execute({ run_id: state.runID,
        acceptance_fingerprint: state.acceptanceFingerprint }, { sessionID: "root" });
      if (mode === "recovery-boundary") t.mock.method(OperatorRuntime.prototype, "gitAcceptanceReadiness", () => "operator-post-commit-validation-required");
      if (["recovery-stale", "recovery-latest-failure", "recovery-missing-finish", "recovery-explicit-cancel"].includes(mode)) {
        await assert.rejects(recover, /operator-(?:resume|recovery)/u);
        assert.equal((await readRun()).units[unitIndex]!.evidence.length, 0);
        assert.equal((await ledger.readGoal()).records.filter(record => record.event.kind === "unit.evidence-reconciled").length, 0);
      } else {
        if (mode === "recovery-crash") {
          const fault = t.mock.method(OperatorRuntime.prototype, "resume", async () => { throw new Error("fixture crash after ledger append"); });
          await assert.rejects(recover, /fixture crash/);
          fault.mock.restore(); hooks = await create();
          assert.equal((await readRun()).units[unitIndex]!.evidence.length, 0);
          assert.equal((await ledger.readGoal()).records.filter(record => record.event.kind === "unit.evidence-reconciled").length, 1);
        }
        if (mode.includes("projection-crash")) {
          const fault = t.mock.method(OperatorMissionRuntime.prototype, "update", async () => { throw new Error("fixture crash after operator save"); });
          await assert.rejects(recover, /fixture crash after operator save/);
          fault.mock.restore(); hooks = await create();
          assert.equal((await readRun()).units[unitIndex]!.status, "succeeded");
          assert.ok((await readRun()).units[unitIndex]!.directExecution!.registrationRecovery);
        }
        const restored = JSON.parse(await recover()), done = await readRun();
        assert.equal(done.phase, mode.includes("pending") ? "prepared" : mode === "recovery-boundary" ? "awaiting-decision" : "awaiting-acceptance"); assert.equal(done.units[unitIndex]!.status, "succeeded");
        assert.ok(done.units[unitIndex]!.evidence.length); assert.equal(done.units[unitIndex]!.callID, unit.callID);
        const { registrationRecovery, ...retainedDirect } = done.units[unitIndex]!.directExecution!;
        assert.deepEqual(retainedDirect, broken.units[unitIndex]!.directExecution);
        assert.equal(registrationRecovery!.previousStatus, failed ? "failed" : "cancelled");
        assert.match(restored.next_action, /not acceptance, Go or completion/);
        const recoveredMission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        assert.equal(recoveredMission.attempts![unitIndex]!.status, "succeeded");
        assert.equal(recoveredMission.attempts![unitIndex]!.registrationRecovery!.previousStatus, failed ? "failed" : "cancelled");
        if (multi || mode === "recovery-boundary") assert.equal(restored.task, undefined, "registration recovery does not generate a replacement Task");
        if (mode === "recovery-boundary") {
          assert.equal(restored.decision, "operator-post-commit-validation-required");
          assert.match(restored.next_action, /recorded boundary decision remains pending/);
        }
        const eventCount = (await ledger.readGoal()).records.length;
        hooks = await create(); await recover();
        assert.equal((await ledger.readGoal()).records.length, eventCount, "cold replay does not append evidence again");
        assert.equal((await readRun()).generation, done.generation, "replay does not resume the run twice");
      }
      const after = (await ledger.readGoal()).state;
      for (const field of ["consumed_units", "consumed_time_ms", "consumed_cost_usd", "validation_budget", "outstanding_reservations"] as const) {
        assert.deepEqual(after[field], spent[field], `${field} is unchanged by recovery`);
      }
      if (mode !== "recovery-explicit-cancel") assert.equal(aborted.length, 0, "direct recovery never interrupts the retained conversation");
      return;
    }
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
    if (mode.startsWith("parent-")) {
      const previousOutcome = mode.slice("parent-".length);
      if (previousOutcome === "unset") delete agents[actor]!.outcome;
      else agents[actor]!.outcome = previousOutcome;
    }
    const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.notEqual(finished.status, "direct-unit-awaits-validation", JSON.stringify(finished));
    const done = await readRun();
    assert.equal(done.phase, "awaiting-acceptance", JSON.stringify(done));
    assert.ok(done.units[0]!.evidence.length);
    assert.equal(done.units[0]!.directExecution!.checks.length, checked.length, "finish preserves observed validation without reruns");
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    if (mode === "large-source") {
      const rawBytes = Buffer.byteLength(JSON.stringify(missionPacket(mission, done)));
      const finishBytes = Buffer.byteLength(JSON.stringify(finished));
      t.diagnostic(JSON.stringify({ raw_packet_bytes: rawBytes, finish_packet_bytes: finishBytes }));
      assert.ok(rawBytes > 32_000, "tracked inputs reproduce a large one-line finish packet");
      assert.ok(finishBytes < 16_000, "successful transition and next action fit without protected arrays");
      assert.ok(rawBytes - finishBytes > 20_000);
    }
    assert.equal(finished.status, done.phase);
    assert.equal(finished.units[0].status, "succeeded");
    assert.equal(finished.execution_summary.accepted, false, "unit validation is not Mission acceptance");
    assert.match(finished.next_action, /do not repeat passed checks or finish this settled unit again/);
    assert.match(finished.next_action, /Independent Review and Operator final acceptance remain required/);
    const full = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
    assert.deepEqual(full.units[0].evidence, done.units[0]!.evidence, "full diagnostics retain authoritative proof");
    for (const [index, proof] of done.units[0]!.evidence.entries()) {
      const { protected_binding, ...measured } = proof;
      const compact = finished.units[0].evidence[index];
      assert.deepEqual(compact, { ...measured, ...(protected_binding ? { protected_binding_ref: {
        manifest_path: protected_binding.manifest_path, manifest_hash: protected_binding.manifest_hash,
        source_policy: protected_binding.source_policy,
      } } : {}) }, "finish keeps command, exit, timing, identity and proof scope without snapshot arrays");
    }
    assert.deepEqual(finished.units[0].evidence_details_ref, {
      path: new OperatorRuntime(directory, V010_RUNTIME_PROFILE).statePath("root"), run_id: done.runID,
      unit_id: done.units[0]!.unit.id, field: "units[].evidence",
      omitted: "host snapshot recipe: source/candidate paths and freshness environment",
    });
    assert.deepEqual((await readRun()).units[0]!.evidence, done.units[0]!.evidence, "response projection never rewrites saved validation");
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
    if (actor === "coordinator") {
      for (const status of mode === "large-source" ? ["blocked", "needs-decision", "ready"] : ["ready"]) {
        const summary = "Direct correction validated and independently reviewed";
        const submittedText = await hooks.tool!.sortie_v010_submit_mission.execute({ status, summary }, { sessionID: actor });
        const submitted = JSON.parse(submittedText);
        assert.equal(Object.keys(submitted)[0], "acceptance_summary");
        assert.equal(submitted.phase, "submitted");
        assert.deepEqual(submitted.submission, { status, summary });
        assert.equal(submitted.execution_summary.accepted, false, "submission still requires Operator acceptance");
        assert.deepEqual(submitted.acceptance_summary.original_requests, mission.requests);
        assert.deepEqual(submitted.acceptance_summary.requirements, mission.requirements);
        assert.equal(submitted.acceptance_summary.independent_review.verdict, "PASS");
        assert.equal(submitted.acceptance_summary.independent_review.independent, true);
        if (status === "ready") {
          assert.match(submitted.next_action, /Compare the original requests with the candidate and actual evidence/);
          assert.match(submitted.next_action, /complete_mission receipt/);
        } else assert.match(submitted.next_action, /incomplete delivery, not acceptance/);
        if (mode === "large-source") {
          const rawText = JSON.stringify({ acceptance_summary: submitted.acceptance_summary,
            ...missionPacket(await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root"), done),
            next_action: submitted.next_action });
          t.diagnostic(JSON.stringify({ submission_status: status, raw_submission_bytes: Buffer.byteLength(rawText),
            submission_bytes: Buffer.byteLength(submittedText) }));
          assert.ok(Buffer.byteLength(rawText) > 32_000, "protected inputs reproduce the oversized submission");
          assert.ok(Buffer.byteLength(submittedText) < 16_000, "submission acknowledgement and next action remain visible");
          assert.deepEqual(submitted.units[0].evidence, finished.units[0].evidence, "reuse measured evidence without protected arrays");
          assert.deepEqual(submitted.units[0].evidence_details_ref, finished.units[0].evidence_details_ref);
          assert.deepEqual((await readRun()).units[0]!.evidence, done.units[0]!.evidence, "submission projection preserves durable proof");
          const fullSubmitted = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
          assert.deepEqual(fullSubmitted.units[0].evidence, done.units[0]!.evidence, "explicit full status retains complete evidence");
          assert.deepEqual(fullSubmitted.acceptance_summary, submitted.acceptance_summary, "submission retains the full original acceptance summary");
        }
      }
      if (mode === "large-source") {
        hooks.backgroundOwner!("coordinator-call", coordinatorOwner!);
        const beforeReturn = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        const returned = { output: "Ready for root acceptance; concrete review gaps retained.",
          metadata: { sessionID: actor, status: "succeeded" } };
        await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, returned);
        const packet = JSON.parse(returned.output);
        const returnBytes = Buffer.byteLength(returned.output);
        t.diagnostic(JSON.stringify({ coordinator_return_bytes: returnBytes }));
        assert.ok(returnBytes < 16_000, "native completion must not inject the full protected snapshot into the root model context");
        assert.equal(packet.coordinator_report, "Ready for root acceptance; concrete review gaps retained.");
        assert.equal(packet.phase, "submitted");
        assert.equal(packet.status, "awaiting-acceptance");
        assert.equal(packet.execution_summary.accepted, false);
        assert.deepEqual(packet.requirements, beforeReturn.requirements);
        assert.deepEqual(packet.submission, beforeReturn.submission);
        assert.deepEqual(packet.review, missionPacket(beforeReturn, done).review);
        assert.deepEqual(packet.units[0].evidence, finished.units[0].evidence, "return keeps exact measured command, exit, coverage and identities");
        assert.deepEqual(packet.units[0].evidence_details_ref, finished.units[0].evidence_details_ref);
        assert.deepEqual((await readRun()).units[0]!.evidence, done.units[0]!.evidence, "native completion projection never changes saved proof");
        const afterReturn = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        assert.deepEqual(afterReturn, { ...beforeReturn, dispatchOpen: false }, "only the existing Coordinator dispatch is closed");
        const fullReturn = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
        assert.deepEqual(fullReturn.units[0].evidence, done.units[0]!.evidence, "explicit full status still exposes authoritative snapshot details");
      }
    }
    const completed = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal(await readFile(resolve(directory, resultPath), "utf8"), "fixed\n");
    assert.equal((await readRun()).units[0]!.directExecution?.actor, actor, "recovery and acceptance retain the same author without a user turn");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true });
    if (externalDirectory) await rm(externalDirectory, { recursive: true, force: true }); }
});
