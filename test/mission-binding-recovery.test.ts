import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

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
