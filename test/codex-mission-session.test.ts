import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CodexMissionSession } from "../dist/codex/mission-session.js";
import type { CodexAppServerTransport } from "../dist/codex/app-server.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { resolveCodexMissionShell } from "../dist/codex/mission-shell.js";

const exec = promisify(execFile);
type Json = Record<string, any>;
class ScriptedTransport implements CodexAppServerTransport {
  private queue: unknown[] = [];
  private waiting?: (value: IteratorResult<unknown>) => void;
  private ended = false;
  readonly failures = new Set<string>();
  readThread?: Json;
  resumeResult?: Json;
  dropCommands = false;
  commandExecutions = 0;
  turnStarts = 0;
  readonly turns: Json[] = [];
  readonly turnRequests: Json[] = [];
  readonly threadRequests: Json[] = [];
  readonly commandRequests: Json[] = [];
  private currentTurn?: Json;
  private currentTurnID = "turn";
  private sequence = 100;
  private calls = new Map<number, (value: Json) => void>();
  readonly messages: AsyncIterable<unknown> = { [Symbol.asyncIterator]: () => ({ next: () => {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.waiting = resolve; });
  } }) };
  readonly id: string;
  private readonly script: (transport: ScriptedTransport) => Promise<string | void>;
  constructor(id: string, script: (transport: ScriptedTransport) => Promise<string | void>) { this.id = id; this.script = script; }
  push(value: unknown): void {
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting({ value, done: false }); }
    else this.queue.push(value);
  }
  send(message: Json): void {
    if (!message.method) {
      const item = this.currentTurn?.items.find((value: Json) => value.id === `${this.id}-${message.id}`);
      if (item) Object.assign(item, { status: "completed", ...message.result });
      this.calls.get(message.id)?.(message.result); this.calls.delete(message.id); return;
    }
    if (message.method === "initialized") return;
    if (this.failures.has(message.method)) { this.push({ id: message.id, error: { message: "fixture prelaunch failure" } }); return; }
    if (message.method === "initialize") this.push({ id: message.id, result: {} });
    else if (message.method === "account/read") this.push({ id: message.id, result: { account: { type: "chatgpt" } } });
    else if (message.method === "thread/read") this.push({ id: message.id, result: { thread: this.readThread } });
    else if (message.method === "thread/resume") this.push({ id: message.id, result: { thread: { id: this.id }, ...this.resumeResult } });
    else if (message.method === "thread/start") {
      this.threadRequests.push(message.params);
      assert.equal(message.params.ephemeral, false);
      assert(message.params.dynamicTools.some((tool: Json) => tool.name === "read"));
      this.push({ id: message.id, result: { thread: { id: this.id } } });
    } else if (message.method === "turn/start") {
      assert.equal(message.params.sandboxPolicy, undefined, "turns retain native thread permissions");
      assert.equal(message.params.approvalPolicy, undefined);
      this.turnStarts++;
      this.turnRequests.push(message.params);
      this.currentTurnID = `turn-${this.turnStarts}`;
      this.currentTurn = { id: this.currentTurnID, status: "inProgress", itemsView: "full", startedAt: Date.now() / 1000,
        items: [{ type: "userMessage", id: `user-${this.turnStarts}`, clientId: message.params.clientUserMessageId, content: message.params.input }] };
      this.turns.push(this.currentTurn);
      this.push({ id: message.id, result: { turn: { id: this.currentTurnID } } });
      const turn = this.currentTurn;
      setImmediate(() => void this.script(this).then(text => {
        if (turn.status === "inProgress") this.finishTurn("completed", text ?? "done", turn);
      }).catch(error => this.push({ id: message.id, error: { message: String(error) } })));
    } else if (message.method === "command/exec") {
      this.commandExecutions++;
      this.commandRequests.push(message.params);
      if (this.dropCommands) { void this.close(); return; }
      assert.equal(message.params.sandboxPolicy, undefined, "standalone commands inherit native host permissions");
      const [command, ...args] = message.params.command;
      void exec(command, args, { cwd: message.params.cwd }).then(result => this.push({ id: message.id, result: { exitCode: 0, ...result } }),
        error => this.push({ id: message.id, result: { exitCode: error.code, stdout: error.stdout, stderr: error.stderr } }));
    } else throw new Error(`Unexpected request: ${message.method}`);
  }
  async call(tool: string, args: Json, success = true): Promise<Json> {
    const id = ++this.sequence;
    const result = new Promise<Json>(resolve => this.calls.set(id, resolve));
    this.currentTurn?.items.push({ type: "dynamicToolCall", id: `${this.id}-${id}`, tool, arguments: args, status: "inProgress" });
    this.push({ id, method: "item/tool/call", params: { threadId: this.id, turnId: this.currentTurnID, callId: `${this.id}-${id}`, tool, arguments: args } });
    const value = await result;
    assert.equal(value.success, success, JSON.stringify(value));
    if (!success) return { error: value.contentItems[0].text };
    return JSON.parse(value.contentItems[0].text);
  }
  async close(): Promise<void> { this.ended = true; this.waiting?.({ value: undefined, done: true }); }
  finishTurn(status = "completed", text = "Waiting for existing Task", turn = this.currentTurn!): void {
    const item = { type: "agentMessage", text, phase: null };
    Object.assign(turn, { status, completedAt: Date.now() / 1000 });
    turn.items.push(item);
    this.push({ method: "item/completed", params: { threadId: this.id, turnId: turn.id, item } });
    this.push({ method: "turn/completed", params: { threadId: this.id, turn: { id: turn.id, status } } });
  }
}

for (const mode of ["direct", "worker-advice", "handoff", "validated-handoff", "partial-check-handoff", "handoff-retry"] as const) test(`initial recommendation and autonomous Coordinator completion: ${mode}`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-advisory-route-"));
  const transports: ScriptedTransport[] = [];
  let adapter: CodexMissionSession | undefined, failure: unknown;
  let missionID: string | undefined, runID: string | undefined, taskID: string | undefined;
  const handoff = mode.includes("handoff");
  const unit = { title: "Complete result", objective: "Make result.txt fixed, validate and commit",
    read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs", ...(mode === "partial-check-handoff" ? ["node check.mjs --tail"] : [])] };
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await exec("git", ["config", "user.name", "Route fixture"], { cwd: directory });
    await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "import{readFileSync}from'node:fs';if(readFileSync('result.txt','utf8')!=='fixed')process.exit(7)");
    await exec("git", ["add", "check.mjs"], { cwd: directory });
    await exec("git", ["commit", "-qm", "fixture"], { cwd: directory });
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => {
      const id = ["root", "coordinator", "worker", "retry"][transports.length]!;
      const native = new ScriptedTransport(id, async host => {
        try {
          if (id === "root") {
            const started = await host.call("sortie_v010_start_mission", { requirements: [unit.objective],
              preferred_executor: mode === "worker-advice" ? "worker" : "coordinator",
              ...(mode === "worker-advice" ? {} : { unit }), handoff_context: "Use the supplied instruction; start useful work immediately." });
            assert.equal(started.task.subagent_type, "dogs-coordinator");
            assert.equal(host.commandExecutions, 0, "Operator does not investigate to recommend a route");
            missionID = started.mission_id;
            const state = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
            assert.equal(state.preferredExecutor, mode === "worker-advice" ? "worker" : "coordinator");
            assert.equal(state.runID, null, "known single-unit check does not pre-start Luna against recommendation");
            assert.match(new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).brief(state), /Operator recommendation \(advisory\)/);
            await host.call("task", started.task);
            if (failure) return;
            assert.equal((await host.call("sortie_v010_complete_mission", {})).status, "succeeded");
          } else if (id === "coordinator") {
            const started = await host.call("sortie_v010_plan_units", { executor: "self", units: [unit] });
            assert.equal(started.status, "direct-unit-running");
            runID = started.run_id;
            const before = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
            taskID = before.units[0]!.unit.id;
            await host.call("write", { filePath: "result.txt", content: mode === "handoff" ? "partial" : "fixed" });
            if (mode !== "handoff") assert.equal((await host.call("bash", { command: "node check.mjs" })).metadata.exit, 0);
            if (handoff) {
              const delegated = await host.call("sortie_v010_plan_units", { executor: "worker", handoff_context:
                mode === "handoff" ? "result.txt already exists with partial work; finish it, validate and commit." : "result.txt already passes the exact declared check; deliver its commit without repeating that check." });
              assert.equal(delegated.run_id, runID);
              assert.equal(delegated.task.subagent_type, "dog-worker-v010");
              const after = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
              assert.equal(after.units[0]!.unit.id, taskID);
              assert.equal(after.units[0]!.status, "pending");
              assert.equal(after.units[0]!.resultClass, null, "handoff is not fabricated success/failure");
              const duplicate = await host.call("sortie_v010_plan_units", { executor: "worker" });
              assert.deepEqual(duplicate.task, delegated.task, "lost-response replay retains exact pending Worker");
              const budget = (await host.call("sortie_v010_operator_status", {})).budget;
              assert.equal(budget.reserved_units, 1);
              assert.equal(budget.consumed_units, 0);
              await host.call("task", delegated.task);
              if (failure) return;
              if (mode === "handoff-retry") {
                const current = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
                assert.equal(current.units[0]!.status, "failed");
                const retry = await host.call("sortie_v010_retry_mission_unit", { unit_id: current.units[0]!.unit.id });
                assert.equal(retry.status, "normal_remediation_prepared");
                await host.call("task", retry.task);
                if (failure) return;
              }
            } else {
              await host.call("bash", { command: 'git add result.txt && git commit -m "Deliver result"' });
              await host.call("sortie_v010_finish_direct_unit", {});
            }
            const status = await host.call("sortie_v010_operator_status", {});
            assert.equal(status.budget.consumed_units, mode === "handoff-retry" ? 2 : 1, "handoff retains one reservation; actual remediation is another attempt");
            assert.equal(status.budget.reserved_units, 0);
            await host.call("sortie_v010_review_mission", { risk_tags: [] });
            await host.call("sortie_v010_submit_mission", { status: "ready", summary: "Implemented, validated and committed" });
          } else {
            assert.equal(await readFile(join(directory, "result.txt"), "utf8"), mode === "handoff" ? "partial" : "fixed");
            if (mode === "handoff-retry" && id === "worker") {
              await host.call("write", { filePath: "result.txt", content: "broken" });
              assert.equal((await host.call("bash", { command: "node check.mjs" })).metadata.exit, 7);
              await host.call("write", { filePath: "result.txt", content: "fixed" });
              return "FAILED: declared validation exited 7; retained original work for remediation";
            }
            if (mode === "handoff" || id === "retry") {
              await host.call("write", { filePath: "result.txt", content: "fixed" });
              assert.equal((await host.call("bash", { command: "node check.mjs" })).metadata.exit, 0);
            }
            if (mode === "partial-check-handoff") assert.equal((await host.call("bash", { command: "node check.mjs --tail" })).metadata.exit, 0);
            await host.call("bash", { command: 'git add result.txt && git commit -m "Deliver result"' });
            return "DONE: Existing result validated and committed";
          }
        } catch (error) { failure = error; }
      });
      transports.push(native); return native;
    } });
    const result = await adapter.run("Make result.txt fixed, validate with node check.mjs and commit. Use the existing context and complete the work.");
    if (failure) throw failure;
    assert.equal(result.accepted, true);
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(mission.id, missionID);
    assert.equal(mission.runID, runID);
    assert.equal(transports.length, mode === "handoff-retry" ? 4 : handoff ? 3 : 2);
    assert.equal(transports[1]!.threadRequests[0].model, "gpt-6.1-sol");
    if (handoff) {
      assert.equal(transports[2]!.threadRequests[0].model, "gpt-6.1-terra");
      assert.equal(transports[2]!.threadRequests[0].serviceTier, undefined);
      assert.equal(mission.attempts![0]!.status, "handed-off");
      // The public Mission budget above also proves the existing single reservation settled once.
      assert.equal(mission.attempts!.filter(item => item.status === "succeeded").length, 1);
    }
    const checkCommands = transports.flatMap(host => host.commandRequests).filter(request => JSON.stringify(request.command).includes("node check.mjs"));
    assert.equal(checkCommands.length, mode === "handoff-retry" ? 3 : mode === "partial-check-handoff" ? 2 : 1, "current checks are retained; a real failed attempt requires remediation validation");
    if (mode === "partial-check-handoff") {
      const state = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      const retained = state.units[0]!.evidence.flatMap(item => item.execution.command);
      assert.equal(state.units[0]!.directHandoffs![0]!.checks[0]!.command[0], "node check.mjs");
      assert(retained.includes("node check.mjs --tail"));
    }
    assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: directory })).stdout.trim(), "Deliver result");
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("early root response drains the existing Task then continues the same Mission to commit, review and acceptance", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-owned-task-"));
  let adapter: CodexMissionSession | undefined, failure: unknown, created = 0;
  let entered!: () => void, release!: () => void, rootEnded!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const terminal = new Promise<void>(resolve => { rootEnded = resolve; });
  const transports: ScriptedTransport[] = [];
  const events: Json[] = [];
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await exec("git", ["config", "user.name", "Lifecycle fixture"], { cwd: directory });
    await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "import{readFileSync}from'node:fs';if(readFileSync('result.txt','utf8')!=='fixed')process.exit(7)");
    adapter = await CodexMissionSession.create({ projectRoot: directory, onEvent: event => { events.push(event); }, transportFactory: () => {
      const root = created++ === 0;
      const native = new ScriptedTransport(root ? "root" : "coordinator", async host => {
        try {
          if (!root) {
            entered(); await pending;
            await host.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Fix result", objective: "Fix result and validate",
              read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
            await host.call("write", { filePath: "result.txt", content: "fixed" });
            await host.call("bash", { command: "node check.mjs" });
            await host.call("bash", { command: 'git add result.txt; git commit -m "Fix result"' });
            await host.call("sortie_v010_finish_direct_unit", {});
            await host.call("sortie_v010_review_mission", { risk_tags: [] });
            await host.call("sortie_v010_submit_mission", { status: "ready", summary: "Validated and committed existing result" });
            return "Existing Task completed validation, commit and review";
          }
          if (host.turnStarts === 1) {
            const started = await host.call("sortie_v010_start_mission", { requirements: ["Fix result and validate"] });
            const task = host.call("task", started.task);
            await entry;
            host.finishTurn(); rootEnded();
            await task;
          } else {
            assert.equal(host.turnStarts, 2);
            const text = host.turnRequests[1].input[0].text;
            assert.match(text, /Existing Task completed validation, commit and review/);
            assert(!text.includes("Original instruction"), "continuation does not resend the task");
            assert.equal((await host.call("sortie_v010_complete_mission", {})).status, "succeeded");
          }
        } catch (error) { failure = error; release(); }
      });
      transports.push(native); return native;
    } });
    let returned = false;
    const running = adapter.run("Original instruction: fix result and validate").then(result => { returned = true; return result; });
    await terminal; await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    assert.equal(transports[0].turnStarts, 1, "no inference while waiting for the existing child");
    const before = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    release();
    const result = await running;
    if (failure) throw failure;
    const after = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(after.id, before.id);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.lifecycle, { root_turn_terminal: true, owned_tasks_settled: true, mission_phase: "completed", mission_accepted: true });
    assert.equal(created, 2, "no replacement child");
    assert.equal(transports[1].turnStarts, 1);
    assert.equal(events.filter(event => event.method === "sortie/continuation").length, 1);
    assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: directory })).stdout.trim(), "Fix result");
    const missionDirectory = join(directory, V010_RUNTIME_PROFILE.stateDirectory, "missions");
    const captures = (await readdir(missionDirectory)).filter(name => name.endsWith(".request.json"));
    assert.equal(captures.length, 1);
    assert.equal(JSON.parse(await readFile(join(missionDirectory, captures[0]), "utf8")).text, "Original instruction: fix result and validate",
      "host continuation is not captured as a new user request");
  } finally { release(); await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const initialExit of [0, 7]) test(`owned Worker continues its admitted Task after an early native response and delayed command exit ${initialExit}`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-owned-worker-continuation-"));
  let adapter: CodexMissionSession | undefined, failure: unknown;
  let entered!: () => void, release!: () => void, ended!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const terminal = new Promise<void>(resolve => { ended = resolve; });
  const transports: ScriptedTransport[] = [], events: Json[] = [];
  let delayed = false;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await exec("git", ["config", "user.name", "Lifecycle fixture"], { cwd: directory });
    await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: directory });
    await writeFile(join(directory, "result.txt"), initialExit === 0 ? "fixed" : "broken");
    await writeFile(join(directory, "check.mjs"), "import{readFileSync}from'node:fs';console.log('retained command result');process.exit(readFileSync('result.txt','utf8')==='fixed'?0:7)");
    adapter = await CodexMissionSession.create({ projectRoot: directory,
      onEvent: event => { events.push(event); if (event.method === "turn/completed" && event.threadId === "worker") ended(); },
      executeCommand: async request => {
        if (!delayed) { delayed = true; entered(); await pending; }
        try { return { status: "completed", exitCode: 0, ...await exec(request.command[0], request.command.slice(1), { cwd: request.cwd }) }; }
        catch (error: any) { return { status: "completed", exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
      }, transportFactory: () => {
        const root = transports.length === 0;
        const native = new ScriptedTransport(root ? "root" : "worker", async host => {
          try {
            if (root) {
              const started = await host.call("sortie_v010_start_mission", { requirements: ["Fix result and validate"], unit: {
                title: "Fix result", objective: "Fix result and validate", read: ["check.mjs", "result.txt"], write: ["result.txt"], validation: ["node check.mjs"] } });
              const task = await host.call("task", started.task);
              assert.equal(task.metadata.status, "completed");
              const status = await host.call("sortie_v010_operator_status", {});
              assert.equal(status.budget.consumed_units, 1);
              assert.equal(status.budget.reserved_units, 0);
              await host.call("sortie_v010_review_mission", { risk_tags: [] });
              assert.equal((await host.call("sortie_v010_complete_mission", {})).status, "succeeded");
              return;
            }
            if (host.turnStarts === 1) {
              const command = host.call("bash", { command: "node check.mjs" });
              await entry;
              host.finishTurn("completed", "Waiting for the existing command");
              assert.equal((await command).metadata.exit, initialExit);
              return;
            }
            assert.equal(host.turnStarts, 2);
            const text = host.turnRequests[1].input[0].text;
            assert.match(text, /retained command result/);
            assert(text.includes(`\\"exit\\":${initialExit}`), "continuation preserves the actual command exit");
            assert(!text.includes("Original instruction"), "internal continuation does not resend the Task");
            if (initialExit !== 0) await host.call("write", { filePath: "result.txt", content: "fixed" });
            assert.equal((await host.call("bash", { command: "node check.mjs" })).metadata.exit, 0);
            await host.call("bash", { command: 'git add result.txt; git commit -m "Fix retained Worker result"' });
            return "DONE: Existing Task validated and committed";
          } catch (error) { failure = error; release(); }
        });
        transports.push(native); return native;
      } });
    let returned = false;
    const running = adapter.run("Original instruction: fix result and validate").then(value => { returned = true; return value; });
    const observed = running.then(value => ({ value }), error => ({ error }));
    await Promise.race([terminal, observed.then(value => { throw failure ?? ("error" in value ? value.error : new Error("Worker terminal not reached")); })]);
    assert.equal(returned, false);
    assert.equal(transports[1].turnStarts, 1, "no inference while the command is pending");
    const before = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    release();
    const result = await running;
    if (failure) throw failure;
    const after = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(after.id, before.id);
    assert.equal(after.codexOwner?.generation, before.codexOwner?.generation);
    assert.equal(after.attempts?.length, 1, "same Task reservation, no replacement author");
    assert.equal(after.attempts?.[0]?.childSessionID, "worker");
    assert.equal(result.accepted, true);
    assert.equal(result.lifecycle.owned_tasks_settled, true);
    assert.equal(transports.length, 2);
    assert.equal(transports[0].turnStarts, 1);
    assert.equal(transports[1].turnStarts, 2);
    for (const setting of ["model", "effort", "serviceTier"]) assert.equal(transports[1].turnRequests[1][setting], transports[1].turnRequests[0][setting],
      `continuation retains the admitted Worker's ${setting}`);
    assert.equal(events.filter(event => event.method === "sortie/continuation").length, 1);
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "fixed");
    assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: directory })).stdout.trim(), "Fix retained Worker result");
  } finally { release(); await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const delegated of [false, true]) test(`large literal writes retain ${delegated ? "host" : "native"} execution and clean their transport payload`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex literal write 日本語 "));
  const content = "日本語 ' \" $${notExpanded} \u0000\r\n".repeat(8000);
  let adapter: CodexMissionSession | undefined, failure: unknown;
  const requests: Json[] = [];
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "process.exit(0)");
    const native = new ScriptedTransport("root", async host => {
      try {
        await host.call("sortie_v010_start_mission", { requirements: ["Write literal content"] });
        await host.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Write", objective: "Write literal content",
          read: ["check.mjs"], write: ["literal file.txt"], validation: ["node check.mjs"] }] });
        const result = await host.call("write", { filePath: "literal file.txt", content });
        assert.equal(result.metadata.exit, 0);
        assert.equal(result.metadata.executor, delegated ? "host" : "native");
      } catch (error) { failure = error; }
    });
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => native,
      ...(delegated ? { executeCommand: async (request: any) => {
        requests.push(request);
        assert.equal(request.tool, "write");
        // Existing argv-only executors need no new capability or stdin implementation.
        return { status: "completed" as const, exitCode: 0, ...await exec(request.command[0], request.command.slice(1), { cwd: request.cwd }) };
      } } : {}) });
    assert.equal((await adapter.run("Write literal content")).accepted, false, "a write alone is not Mission acceptance");
    if (failure) throw failure;
    assert.equal(await readFile(join(directory, "literal file.txt"), "utf8"), content);
    const commands = delegated ? requests : native.commandRequests;
    assert.equal(commands.length, 1);
    assert(commands[0].command.every((arg: string) => arg.length < 1024), "file content never occupies argv");
    await assert.rejects(readFile(commands[0].command.at(-1)), { code: "ENOENT" });
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const outcome of ["denied", "not-started", "unknown"] as const) test(`write payload is cleaned after host ${outcome} without writing or fallback`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex write receipt "));
  let adapter: CodexMissionSession | undefined, failure: unknown, payloadPath = "";
  let calls = 0;
  const native = new ScriptedTransport("root", async host => {
    try {
      await host.call("sortie_v010_start_mission", { requirements: ["Write result"] });
      await host.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Write", objective: "Write result",
        read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
      await host.call("write", { filePath: "result.txt", content: "x".repeat(100000) }, false);
    } catch (error) { failure = error; }
  });
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "process.exit(0)");
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => native,
      executeCommand: async request => {
        calls++;
        payloadPath = request.command.at(-1)!;
        assert.equal(await readFile(payloadPath, "utf8"), "x".repeat(100000));
        await assert.rejects(readFile(join(directory, "result.txt")), { code: "ENOENT" });
        return { status: outcome, reason: "fixture receipt" };
      } });
    if (outcome === "unknown") { await assert.rejects(adapter.run("Write result"), /closed/); await adapter.close(); }
    else { assert.equal((await adapter.run("Write result")).accepted, false); if (failure) throw failure; }
    assert.equal(calls, 1);
    assert.equal(native.commandExecutions, 0);
    await assert.rejects(readFile(payloadPath), { code: "ENOENT" });
    await assert.rejects(readFile(join(directory, "result.txt")), { code: "ENOENT" });
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("status observations finish during an active Task while condition registration stays queued", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex live status "));
  let adapter: CodexMissionSession | undefined, failure: unknown, created = 0, registered = false;
  let entered!: () => void, release!: () => void;
  const childEntered = new Promise<void>(resolve => { entered = resolve; });
  const childRelease = new Promise<void>(resolve => { release = resolve; });
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "process.exit(0)");
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => {
      if (created++ !== 0) return new ScriptedTransport("worker", async () => { entered(); await childRelease; return "Unfinished fixture task"; });
      return new ScriptedTransport("root", async host => {
        try {
          await host.call("sortie_v010_start_mission", { requirements: ["Observe active child"] });
          const planned = await host.call("sortie_v010_plan_units", { units: [{ title: "Observe", objective: "Observe active child",
            read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
          const task = host.call("task", planned.task);
          await childEntered;
          for (const args of [{}, { view: "full", confirmed_conditions: "" }, { view: "progress", confirmed_conditions: {} }]) {
            const status = await host.call("sortie_v010_operator_status", args);
            assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).phase, "running");
            assert(status && !status.task, "observation cannot offer a replacement Task while the child is active");
            assert.equal(registered, false);
          }
          const conditions = host.call("sortie_v010_operator_status", { confirmed_conditions: { source: "fixture" } });
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(registered, false, "condition registration cannot overtake Task execution");
          release();
          await task;
          await conditions;
          assert.equal(registered, true);
        } catch (error) { failure = error; release(); }
      });
    } });
    const status = (adapter as any).hooks.tool.sortie_v010_operator_status;
    const execute = status.execute;
    status.execute = async (args: Json, context: Json) => {
      if (args.confirmed_conditions !== undefined) { registered = true; return JSON.stringify({ registered }); }
      return execute(args, context);
    };
    assert.equal((await adapter.run("Observe active child")).accepted, false);
    if (failure) throw failure;
  } finally { release(); await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Codex transport reuses Mission failure correction and root acceptance", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-mission-session-"));
  let adapter: CodexMissionSession | undefined;
  let failure: unknown;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "result.txt"), "broken");
    await writeFile(join(directory, "check.mjs"), "import{readFileSync}from'node:fs';process.exit(readFileSync('result.txt','utf8')==='fixed'?0:7)");
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => new ScriptedTransport("root", async native => {
      try {
        await native.call("sortie_v010_start_mission", { requirements: ["Fix result.txt and validate"] });
        const planned = await native.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Fix result", objective: "Fix result.txt and validate",
          read: ["check.mjs", "result.txt"], write: ["result.txt"], validation: ["node check.mjs"] }] });
        assert.equal(planned.status, "direct-unit-running");
        assert.equal((await native.call("bash", { command: "node check.mjs" })).metadata.exit, 7);
        assert.equal((await native.call("sortie_v010_finish_direct_unit", {})).status, "direct-unit-awaits-validation");
        await native.call("write", { filePath: "result.txt", content: "fixed" });
        assert.equal((await native.call("bash", { command: "node check.mjs" })).metadata.exit, 0);
        await native.call("sortie_v010_finish_direct_unit", {});
        assert.equal((await native.call("sortie_v010_review_mission", { risk_tags: [] })).status, "skipped-low-risk");
        assert.equal((await native.call("sortie_v010_complete_mission", {})).status, "succeeded");
      } catch (error) { failure ??= error; }
    }) });
    const result = await adapter.run("Fix result.txt and validate with node check.mjs.");
    if (failure) throw failure;
    assert.equal(result.accepted, true);
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "fixed");
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(mission.phase, "completed");
    assert.equal(mission.attempts?.length, 1, "same native author and shared attempt, no adapter-owned execution ledger");
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Codex Mission CLI accepts natural-language input without exposing an unverified success", async () => {
  const result = await exec(process.execPath, ["dist/cli/main.js", "codex", "mission", "--help"]);
  assert.match(result.stdout, /codex mission --prompt/);
  await assert.rejects(exec(process.execPath, ["dist/cli/main.js", "codex", "mission", "--manifest", "unused.json"]),
    (error: any) => error.code === 2);
});

for (const delegated of [false, true]) test(`Codex read discovers directories without a shell (${delegated ? "host" : "native"} executor)`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-read-directory-"));
  let adapter: CodexMissionSession | undefined;
  let failure: unknown;
  let hostCommands = 0;
  const native = new ScriptedTransport("root", async host => {
    try {
      const listed = await host.call("read", { filePath: "source files" });
      assert.equal(listed.metadata.exit, 0);
      assert.equal(listed.output, "a note.txt\nsub/\nzulu.go\n名前.go\n");
      const file = await host.call("read", { filePath: "source files/a note.txt" });
      assert.equal(file.metadata.exit, 0);
      assert.equal(file.output, "literal UTF-8 日本語\r\nsecond line\n");
      assert.notEqual((await host.call("read", { filePath: "source files/missing.go" })).metadata.exit, 0);
    } catch (error) { failure = error; }
  });
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await mkdir(join(directory, "source files", "sub"), { recursive: true });
    await writeFile(join(directory, "source files", "a note.txt"), "literal UTF-8 日本語\r\nsecond line\n");
    await writeFile(join(directory, "source files", "zulu.go"), "package example\n");
    await writeFile(join(directory, "source files", "名前.go"), "package example\n");
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => native,
      ...(delegated ? { executeCommand: async (request: any) => {
        assert.equal(request.tool, "read");
        hostCommands++;
        const [command, ...args] = request.command;
        try { return { status: "completed" as const, exitCode: 0, ...await exec(command, args, { cwd: request.cwd }) }; }
        catch (error: any) { return { status: "completed" as const, exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
      } } : {}) });
    assert.equal((await adapter.run("Inspect the source directory using read; do not guess filenames.")).accepted, false);
    if (failure) throw failure;
    assert.equal(native.commandExecutions, delegated ? 0 : 3);
    assert.equal(hostCommands, delegated ? 3 : 0);
    const declaration = native.threadRequests[0].dynamicTools.find((tool: Json) => tool.name === "read");
    assert.match(declaration.description, /list a directory/);
    assert.equal(/Native apply_patch still uses the native sandbox/.test(native.threadRequests[0].developerInstructions), delegated);
    assert.equal(await readFile(join(directory, "source files", "a note.txt"), "utf8"), "literal UTF-8 日本語\r\nsecond line\n");
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const cold of [false, true]) test(`Codex Reviewer repairs and self-rechecks before ${cold ? "cold" : "live"} root acceptance`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-review-repair-"));
  let adapter: CodexMissionSession | undefined;
  let failure: unknown;
  let created = 0;
  const recorded: ScriptedTransport[] = [];
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "result.txt"), "fixed");
    await writeFile(join(directory, "check.mjs"), "import{readFileSync}from'node:fs';process.exit(readFileSync('result.txt','utf8').startsWith('fixed')?0:7)");
    adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6.1-sol", effort: "medium", transportFactory: () => {
      const root = created++ === 0;
      const transport = new ScriptedTransport(root ? "root" : "reviewer", async native => {
        try {
          if (!root) {
            const correction = await native.call("sortie_v010_repair_review", { findings: "Medium: result.txt omits the required exclamation mark. Current broad check passes but the explicit requirement is unmet." });
            assert.equal(correction.status, "correction-running");
            await native.call("write", { filePath: "result.txt", content: "fixed!" });
            assert.equal((await native.call("bash", { command: "node check.mjs" })).metadata.exit, 0);
            await native.call("bash", { command: "node check.mjs" });
            await native.call("sortie_v010_finish_direct_unit", {});
            return 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}\nVerified required exclamation mark, inherited checks and unchanged scope.';
          }
          await native.call("sortie_v010_start_mission", { requirements: ["Make result.txt exactly fixed! and independently review the result"] });
          await native.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Fix result", objective: "Make result.txt exactly fixed!",
            read: ["check.mjs", "result.txt"], write: ["result.txt"], validation: ["node check.mjs", "node check.mjs"] }] });
          await native.call("bash", { command: "node check.mjs" });
          await native.call("bash", { command: "node check.mjs" });
          await native.call("sortie_v010_finish_direct_unit", {});
          const review = await native.call("sortie_v010_review_mission", { risk_tags: ["public-logic"] });
          await native.call("task", review.task);
          if (!cold) assert.equal((await native.call("sortie_v010_complete_mission", {})).status, "succeeded");
        } catch (error) { failure ??= error; }
      });
      recorded.push(transport);
      return transport;
    } });
    let result = await adapter.run("Make result.txt exactly fixed! and independently review the result.");
    if (failure) throw failure;
    if (cold) {
      assert.equal(result.accepted, false);
      await adapter.close();
      let restores = 0;
      adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6-astra", effort: "low", transportFactory: () => {
        const old = recorded[restores++];
        assert(old, "restore uses only the existing root and reviewer");
        const native = new ScriptedTransport(old.id, async resumed => {
          try { assert.equal((await resumed.call("sortie_v010_complete_mission", {})).status, "succeeded"); }
          catch (error) { failure ??= error; }
        });
        native.readThread = { id: old.id, cwd: directory, modelProvider: "openai", model: "gpt-6.1-sol", reasoningEffort: "medium", turns: old.turns };
        return native;
      } });
      result = await adapter.run("Continue to final acceptance using the existing checks and review.");
      if (failure) throw failure;
      assert.equal(restores, 2);
      assert(result.sessions.every(session => (session.model as Json).modelID === "gpt-6-astra" && (session.model as Json).variant === "low"));
    }
    assert.equal(result.accepted, true);
    assert.equal(created, 2, "the initial independent reviewer also owns correction and self-recheck");
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "fixed!");
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(mission.corrections?.[0]?.author, "reviewer");
    assert.equal(mission.corrections?.[0]?.selfRecheck?.nativeOutcome, "completed");
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Codex Task prelaunch failure releases the existing reservation for same-Mission correction", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-prelaunch-"));
  let adapter: CodexMissionSession | undefined;
  let failure: unknown, created = 0;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "result.txt"), "fixed");
    await writeFile(join(directory, "check.mjs"), "import{readFileSync}from'node:fs';process.exit(readFileSync('result.txt','utf8')==='fixed'?0:7)");
    const unit = { title: "Fix result", objective: "Fix result.txt", read: ["check.mjs", "result.txt"], write: ["result.txt"], validation: ["node check.mjs"] };
    adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6.1-sol", transportFactory: () => {
      const index = created++;
      if (index === 1) { const failed = new ScriptedTransport("worker", async () => { throw new Error("must not execute"); }); failed.failures.add("thread/start"); return failed; }
      if (index === 2) return new ScriptedTransport("coordinator", async native => {
        try {
          await native.call("sortie_v010_plan_units", { executor: "self", reason: "Continue the same requirement after prelaunch rejection", units: [{ ...unit, objective: "Recover the prelaunch failure and verify result.txt with the existing check" }] });
          await native.call("bash", { command: "node check.mjs" });
          await native.call("sortie_v010_finish_direct_unit", {});
          await native.call("sortie_v010_review_mission", { risk_tags: [] });
          await native.call("sortie_v010_submit_mission", { status: "ready", summary: "Existing result validated after prelaunch recovery" });
        } catch (error) { failure ??= error; }
      });
      return new ScriptedTransport("root", async native => {
        try {
          const started = await native.call("sortie_v010_start_mission", { requirements: ["Fix result.txt"], unit });
          assert.match((await native.call("task", started.task, false)).error, /prelaunch failure/);
          const status = await native.call("sortie_v010_operator_status", { view: "full" });
          assert.equal(status.budget.reserved_units, 0);
          await native.call("task", status.task);
          assert.equal((await native.call("sortie_v010_complete_mission", {})).status, "succeeded");
        } catch (error) { failure ??= error; }
      });
    } });
    const result = await adapter.run("Fix result.txt and validate with node check.mjs.");
    if (failure) throw failure;
    assert.equal(result.accepted, true);
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Codex command transport loss stops resends and cold recovery preserves unknown execution", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-unknown-"));
  let adapter: CodexMissionSession | undefined, recovered: CodexMissionSession | undefined;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "process.exit(0)");
    const native = new ScriptedTransport("root", async host => {
      await host.call("sortie_v010_start_mission", { requirements: ["Validate existing result"] });
      await host.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Validate", objective: "Validate existing result",
        read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
      await host.call("bash", { command: "node check.mjs" });
    });
    native.dropCommands = true;
    adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6.1-sol", transportFactory: () => native });
    await assert.rejects(adapter.run("Validate existing result with node check.mjs."), /stream ended|closed/);
    await adapter.close();
    await assert.rejects(adapter.run("Continue"), /closed/);
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(mission.phase, "running");
    const cold = new ScriptedTransport("root", async () => { throw new Error("must not resend"); });
    cold.readThread = { id: "root", cwd: directory, turns: [{ id: "turn", status: "interrupted", itemsView: "full",
      items: [{ type: "dynamicToolCall", tool: "bash", status: "inProgress" }] }] };
    recovered = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => cold });
    await assert.rejects(recovered.run("Continue"), /unresolved tool execution; no resend/);
    assert.equal(cold.turnStarts, 0);
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).phase, "running");
  } finally { await adapter?.close(); await recovered?.close(); await rm(directory, { recursive: true, force: true }); }
});


test("explicit Codex model and effort survive shared Task routing", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-model-override-"));
  let adapter: CodexMissionSession | undefined;
  const transports: ScriptedTransport[] = [];
  let failure: unknown;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6.1-sol", effort: "low", transportFactory: () => {
      const root = transports.length === 0;
      const transport = new ScriptedTransport(root ? "root" : "worker", async native => {
        if (!root) return "Worker finished";
        try {
          const started = await native.call("sortie_v010_start_mission", { requirements: ["Validate existing result"],
            unit: { title: "Validate", objective: "Validate existing result", read: ["result.txt"], write: ["result.txt"], validation: ["node check.mjs"] } });
          await native.call("task", { ...started.task, model: "openai/gpt-6-astra", variant: "high" });
        } catch (error) { failure = error; }
      });
      transports.push(transport);
      return transport;
    } });
    await adapter.run("Validate existing result");
    if (failure) throw failure;
    assert.equal(transports.length, 2);
    for (const transport of transports) {
      assert.equal(transport.threadRequests[0].model, "gpt-6.1-sol");
      assert.equal(transport.turnRequests[0].model, "gpt-6.1-sol");
      assert.equal(transport.turnRequests[0].effort, "low");
      assert.equal(transport.threadRequests[0].serviceTier, undefined);
      assert.equal(transport.turnRequests[0].serviceTier, undefined);
    }
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const unit of [false, true]) test(`packaged Codex ${unit ? "worker" : "coordinator"} route keeps native model and speed separate`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-role-"));
  const transports: ScriptedTransport[] = [];
  let adapter: CodexMissionSession | undefined, failure: unknown;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => {
      const root = transports.length === 0;
      const native = new ScriptedTransport(root ? "root" : "child", async host => {
        if (!root) return "Task returned";
        try {
          const started = await host.call("sortie_v010_start_mission", { requirements: ["Validate result"],
            ...(unit ? { unit: { title: "Validate", objective: "Validate result", read: ["result.txt"], write: ["result.txt"], validation: ["node check.mjs"] } } : {}) });
          await host.call("task", started.task);
        } catch (error) { failure = error; }
      });
      transports.push(native); return native;
    } });
    const result = await adapter.run("Validate result");
    if (failure) throw failure;
    assert.equal(transports.length, 2);
    const child = transports[1];
    assert.equal(transports[0].threadRequests[0].model, "gpt-6.1-sol");
    assert.equal(transports[0].turnRequests[0].effort, "xhigh");
    assert.equal(transports[0].turnRequests[0].serviceTier, undefined);
    assert.equal(child.threadRequests[0].model, unit ? "gpt-6.1-terra" : "gpt-6.1-sol");
    assert.equal(child.turnRequests[0].model, unit ? "gpt-6.1-terra" : "gpt-6.1-sol");
    assert.equal(child.turnRequests[0].effort, unit ? "max" : "xhigh");
    assert.equal(child.threadRequests[0].serviceTier, undefined);
    assert.equal(child.turnRequests[0].serviceTier, undefined);
    assert.equal((result.sessions[1].model as Json).serviceTier, undefined);
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const override of [false, true]) test(`cold native resume ${override ? "keeps speed independent of a model override" : "preserves Luna Fast"}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-speed-resume-"));
  let adapter: CodexMissionSession | undefined, recovered: CodexMissionSession | undefined;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    const initial = new ScriptedTransport("root", async native => { await native.call("sortie_v010_start_mission", { requirements: ["Validate result"] }); });
    adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6-luna-fast#max", transportFactory: () => initial });
    await adapter.run("Validate result"); await adapter.close();
    const cold = new ScriptedTransport("root", async () => "Continue same Mission");
    // thread/read need not carry the model/tier; thread/resume is authoritative.
    cold.readThread = { id: "root", cwd: directory, modelProvider: "openai", turns: initial.turns };
    cold.resumeResult = { model: "gpt-6-luna", serviceTier: "priority", reasoningEffort: "max" };
    recovered = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => cold,
      ...(override ? { model: "gpt-6.1-sol", effort: "low" } : {}) });
    await recovered.run("Continue");
    assert.equal(cold.threadRequests.length, 0, "resume does not create replacement work");
    assert.equal(cold.turnRequests[0].model, override ? "gpt-6.1-sol" : "gpt-6-luna");
    assert.equal(cold.turnRequests[0].effort, override ? "low" : "max");
    assert.equal(cold.turnRequests[0].serviceTier, "priority");
  } finally { await adapter?.close(); await recovered?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cold native resume defaults do not resurrect stale thread/read speed or effort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-default-resume-"));
  let adapter: CodexMissionSession | undefined, recovered: CodexMissionSession | undefined;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    const initial = new ScriptedTransport("root", async native => { await native.call("sortie_v010_start_mission", { requirements: ["Validate result"] }); });
    adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6-luna-fast#max", transportFactory: () => initial });
    await adapter.run("Validate result"); await adapter.close();
    const cold = new ScriptedTransport("root", async () => "Continue same Mission");
    cold.readThread = { id: "root", cwd: directory, modelProvider: "openai", model: "gpt-6-luna",
      serviceTier: "priority", reasoningEffort: "low", turns: initial.turns };
    cold.resumeResult = { model: "gpt-6-luna", serviceTier: null, reasoningEffort: null };
    recovered = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => cold });
    await recovered.run("Continue");
    assert.equal(cold.threadRequests.length, 0, "continue the exact root, without replacement work");
    assert.equal(cold.turnRequests[0].serviceTier, undefined, "resume's native Standard overrides stale Fast history");
    assert.equal(cold.turnRequests[0].effort, "xhigh", "use the packaged role default, not stale effort history");
  } finally { await adapter?.close(); await recovered?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const item of [
  { type: "commandExecution", status: "inProgress" },
  { type: "fileChange", status: "inProgress" },
  { type: "mcpToolCall", status: "inProgress" },
  { type: "mcpToolCall" },
  { type: "collabAgentToolCall", status: "completed", receiverThreadIds: ["untracked-child"] },
]) test(`cold resume refuses unproven native ${item.type} (${item.status ?? "missing"})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-unknown-"));
  let adapter: CodexMissionSession | undefined, recovered: CodexMissionSession | undefined;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    const initial = new ScriptedTransport("root", async native => {
      await native.call("sortie_v010_start_mission", { requirements: ["Validate existing result"] });
    });
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => initial });
    await adapter.run("Validate existing result");
    await adapter.close();
    const cold = new ScriptedTransport("root", async () => { throw new Error("must not resend"); });
    cold.readThread = { id: "root", cwd: directory, turns: [{ id: "interrupted", status: "interrupted", itemsView: "full", items: [item] }] };
    recovered = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => cold });
    await assert.rejects(recovered.run("Continue"), /unresolved native execution; no resend/);
    assert.equal(cold.turnStarts, 0);
  } finally { await adapter?.close(); await recovered?.close(); await rm(directory, { recursive: true, force: true }); }
});


for (const outcome of ["approved", "failed", "denied", "not-started", "interrupted", "invalid", "throw", "abort", "close-race"] as const)
test(`host executor preserves Mission evidence for ${outcome}`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-host-executor-"));
  let adapter: CodexMissionSession | undefined;
  let failure: unknown;
  let dispatched = 0, executions = 0, closeCalls = 0;
  let closing: Promise<void> | undefined;
  const beforeCalls: string[] = [], afterReceipts: Json[] = [];
  let entered!: () => void, authorize!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const approval = new Promise<void>(resolve => { authorize = resolve; });
  const events: Json[] = [];
  const unknown = ["interrupted", "invalid", "throw", "abort", "close-race"].includes(outcome);
  const native = new ScriptedTransport("root", async host => {
    try {
      await host.call("sortie_v010_start_mission", { requirements: ["Validate existing result"] });
      await host.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Validate", objective: "Validate existing result",
        read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
      const receipt = await host.call("bash", { command: "node check.mjs" }, !["denied", "not-started"].includes(outcome));
      if (outcome === "approved" || outcome === "failed") {
        assert.equal(receipt.metadata.exit, outcome === "approved" ? 0 : 7);
        assert.equal(receipt.metadata.executor, "host");
      } else assert.match(receipt.error, new RegExp(`Host command ${outcome}`));
      const finished = await host.call("sortie_v010_finish_direct_unit", {});
      if (outcome === "approved") {
        await host.call("sortie_v010_review_mission", { risk_tags: [] });
        assert.equal((await host.call("sortie_v010_complete_mission", {})).status, "succeeded");
      } else assert.equal(finished.status, "direct-unit-awaits-validation");
    } catch (error) { failure = error; }
  });
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), `process.exit(${outcome === "failed" ? 7 : 0})`);
    adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => native,
      onEvent: event => { events.push(event); }, executeCommand: async request => {
        dispatched++;
        try {
        assert.deepEqual(request.command, (await resolveCodexMissionShell()).command("node check.mjs"));
        assert.equal(request.cwd, directory);
        assert.equal(request.threadId, "root");
        assert.equal(request.tool, "bash");
        assert(request.callId && request.turnId);
        assert.deepEqual(beforeCalls, [request.callId], "shared before hook precedes host dispatch");
        } catch (error) { failure = error; throw error; }
        entered();
        await approval;
        if (outcome === "abort") {
          assert.equal(request.signal.aborted, true);
          return { status: "completed", exitCode: 0, stdout: "late result must not validate", stderr: "" };
        }
        if (outcome === "close-race") {
          closing = adapter!.close();
          // Observe rejection now, then join the original Promise in finally after this callback unwinds.
          void closing.catch(() => {});
          return { status: "completed", exitCode: 0, stdout: "raced result", stderr: "" };
        }
        if (outcome === "throw") throw new Error("Host connection lost");
        if (outcome === "invalid") return { status: "completed", exitCode: undefined, stdout: "approved only", stderr: "" } as any;
        if (["denied", "not-started", "interrupted"].includes(outcome)) return { status: outcome as "denied" | "not-started" | "interrupted", reason: "fixture host decision" };
        executions++;
        try {
          const result = await exec(request.command[0], request.command.slice(1), { cwd: request.cwd });
          return { status: "completed", exitCode: 0, ...result };
        } catch (error: any) { return { status: "completed", exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
      } });
    const close = adapter.close.bind(adapter);
    adapter.close = () => { closeCalls++; return close(); };
    const hooks = (adapter as any).hooks;
    const before = hooks["tool.execute.before"], after = hooks["tool.execute.after"];
    hooks["tool.execute.before"] = async (input: Json, output: Json) => {
      await before(input, output);
      if (input.tool === "bash") beforeCalls.push(input.callID);
    };
    hooks["tool.execute.after"] = async (input: Json, output: Json) => {
      if (input.tool === "bash") afterReceipts.push(structuredClone(output));
      await after(input, output);
    };
    const running = adapter.run("Validate existing result");
    const observed = running.then(value => ({ value }), error => ({ error }));
    await Promise.race([entry, observed.then(result => { throw failure ?? ("error" in result ? result.error : new Error("host not reached")); })]);
    assert.equal(executions, 0, "waiting for host approval does not execute or validate");
    assert.equal(afterReceipts.length, 0, "approval alone is not validation evidence");
    if (outcome === "abort") await adapter.close();
    authorize();
    const result = await observed;
    if (unknown) {
      assert("error" in result, JSON.stringify(result));
      await assert.rejects(adapter.run("retry"), /closed/);
    } else {
      if (failure) throw failure;
      assert("value" in result, JSON.stringify(result));
      assert.equal(result.value.accepted, outcome === "approved");
    }
    assert.equal(dispatched, 1);
    assert.equal(native.commandExecutions, 0, "never fall back after host dispatch or denial");
    assert.equal(executions, outcome === "approved" || outcome === "failed" ? 1 : 0);
    assert(events.some(event => event.method === "sortie/commandExecution" && event.params.executor === "host"));
    if (outcome !== "approved") {
      const state = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.notEqual(state.phase, "completed");
      assert.equal(afterReceipts[0]?.metadata?.exit, outcome === "failed" ? 7 : undefined);
      if (unknown) {
        assert.equal(afterReceipts.length, 0, "unknown execution never produces terminal evidence");
        assert(events.some(event => event.method === "sortie/commandExecution" && event.params.status === "unknown" && event.params.cwd === directory && event.params.reason));
      }
    }
  } finally {
    authorize(); await (closing ?? adapter?.close());
    await rm(directory, { recursive: true, force: true });
    if (outcome === "close-race") assert.equal(closeCalls, 1, "join the original owned close rather than start a second teardown");
  }
});


for (const delegated of [false, true]) test(`bash workdir matches shared validation identity through ${delegated ? "host" : "native"} executor`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-workdir-"));
  const nested = join(directory, "package with spaces");
  let adapter: CodexMissionSession | undefined, failure: unknown;
  let hostCalls = 0;
  const events: Json[] = [];
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await mkdir(nested);
    await writeFile(join(directory, "check.mjs"), "process.exit(7)");
    await writeFile(join(nested, "check.mjs"), "console.log(process.cwd())");
    const native = new ScriptedTransport("root", async host => {
      try {
        await host.call("sortie_v010_start_mission", { requirements: ["Fix root check"] });
        await host.call("sortie_v010_plan_units", { executor: "self", units: [{ title: "Fix root", objective: "Fix root check",
          read: ["check.mjs", "package with spaces/check.mjs"], write: ["check.mjs"], validation: ["node check.mjs"] }] });
        for (const workdir of ["package with spaces", nested]) {
          const result = await host.call("bash", { command: "node check.mjs", workdir });
          assert.equal(result.metadata.exit, 0);
          assert.equal(result.output.trim(), nested);
          assert.equal(result.metadata.cwd, nested);
          assert.equal((await host.call("sortie_v010_finish_direct_unit", {})).status, "direct-unit-awaits-validation",
            "same command in a different directory is not the declared root validation");
        }
        assert.equal((await host.call("bash", { command: "node check.mjs" })).metadata.exit, 7);
        await host.call("write", { filePath: "check.mjs", content: "process.exit(0)" });
        assert.equal((await host.call("bash", { command: "node check.mjs" })).metadata.exit, 0);
        await host.call("sortie_v010_finish_direct_unit", {});
        await host.call("sortie_v010_review_mission", { risk_tags: [] });
        await host.call("sortie_v010_complete_mission", {});
      } catch (error) { failure = error; }
    });
    adapter = await CodexMissionSession.create({ projectRoot: directory, permissions: ":workspace", transportFactory: () => native,
      onEvent: event => { events.push(event); }, ...(delegated ? { executeCommand: async (request: any) => {
        hostCalls++;
        try { const result = await exec(request.command[0], request.command.slice(1), { cwd: request.cwd }); return { status: "completed" as const, exitCode: 0, ...result }; }
        catch (error: any) { return { status: "completed" as const, exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
      } } : {}) });
    const result = await adapter.run("Fix root check");
    if (failure) throw failure;
    assert.equal(result.accepted, true);
    assert.equal(native.threadRequests[0].permissions, ":workspace");
    assert(native.commandRequests.every(request => request.permissionProfile === ":workspace"));
    const bash = native.threadRequests[0].dynamicTools.find((tool: Json) => tool.name === "bash");
    assert.equal(bash.inputSchema.properties.workdir.type, "string");
    assert(events.some(event => event.method === "sortie/commandExecution" && event.params.cwd === nested));
    assert.equal(hostCalls, delegated ? 5 : 0);
    assert.equal(native.commandExecutions, delegated ? 0 : 5);
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});
