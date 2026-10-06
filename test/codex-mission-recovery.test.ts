import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CodexMissionSession } from "../dist/codex/mission-session.js";
import type { CodexAppServerTransport } from "../dist/codex/app-server.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

const exec = promisify(execFile);
type Json = Record<string, any>;
class ScriptedTransport implements CodexAppServerTransport {
  private queue: unknown[] = [];
  private waiting?: (value: IteratorResult<unknown>) => void;
  private ended = false;
  readonly failures = new Set<string>();
  readThread?: Json;
  dropCommands = false;
  turnStarts = 0;
  readonly turns: Json[] = [];
  readonly turnRequests: Json[] = [];
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
    else if (message.method === "thread/resume") this.push({ id: message.id, result: { thread: { id: this.id } } });
    else if (message.method === "thread/start") {
      assert.equal(message.params.ephemeral, false);
      assert(message.params.dynamicTools.some((tool: Json) => tool.name === "read"));
      this.push({ id: message.id, result: { thread: { id: this.id } } });
    } else if (message.method === "turn/start") {
      this.turnStarts++;
      this.turnRequests.push(message.params);
      this.currentTurnID = `turn-${this.turnStarts}`;
      this.currentTurn = { id: this.currentTurnID, status: "inProgress", itemsView: "full", startedAt: Date.now() / 1000,
        items: [{ type: "userMessage", id: `user-${this.turnStarts}`, clientId: message.params.clientUserMessageId, content: message.params.input }] };
      this.turns.push(this.currentTurn);
      this.push({ id: message.id, result: { turn: { id: this.currentTurnID } } });
      setImmediate(() => void this.script(this).then(text => {
        const item = { type: "agentMessage", text: text ?? "done", phase: null };
        Object.assign(this.currentTurn!, { status: "completed", completedAt: Date.now() / 1000 });
        this.currentTurn!.items.push(item);
        this.push({ method: "item/completed", params: { threadId: this.id, turnId: this.currentTurnID, item } });
        this.push({ method: "turn/completed", params: { threadId: this.id, turn: { id: this.currentTurnID, status: "completed" } } });
      }).catch(error => this.push({ id: message.id, error: { message: String(error) } })));
    } else if (message.method === "command/exec") {
      if (this.dropCommands) { void this.close(); return; }
      assert.deepEqual(message.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [message.params.cwd], networkAccess: false });
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
}


async function interruptedTask(directory: string, kind: "worker" | "coordinator") {
  let adapter: CodexMissionSession;
  let failure: unknown;
  const native = new ScriptedTransport("root", async host => {
    try {
      const unit = { title: "Validate", objective: "Validate result", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] };
      const started = await host.call("sortie_v010_start_mission", { requirements: ["Validate result"], ...(kind === "worker" ? { unit } : {}) });
      const args = started.task;
      assert(args, JSON.stringify(started));
      // Crash window: native call exists, admission completed, but no child was created.
      const callID = "not-started-call";
      native.turns.at(-1)!.items.push({ type: "dynamicToolCall", id: callID, tool: "task", arguments: args, status: "inProgress" });
      await (adapter as any).hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID }, { args: { ...args } });
    } catch (error) { failure = error; }
  });
  adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6.1-sol", transportFactory: () => native });
  await adapter.run("Validate result");
  if (failure) throw failure;
  native.turns.at(-1)!.status = "interrupted";
  const history = { id: "root", cwd: directory, modelProvider: "openai", model: "gpt-6.1-sol", turns: structuredClone(native.turns) };
  return { adapter, history };
}

for (const kind of ["worker", "coordinator"] as const) test(`closed adapter recovers exact unstarted ${kind} through shared status, twice`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-not-started-"));
  let adapter: CodexMissionSession | undefined;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "process.exit(0)");
    const initial = await interruptedTask(directory, kind);
    adapter = initial.adapter;
    await adapter.close();
    let firstBudget: unknown;
    for (let repetition = 0; repetition < 2; repetition++) {
      let failure: unknown;
      const cold = new ScriptedTransport("root", async host => {
        try {
          if (kind === "worker") assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0].status,
            "failed", "host reconciles before this new model turn or its status request");
          const status = await host.call("sortie_v010_operator_status", { view: "full" });
          if (kind === "worker") {
            assert.equal(status.budget.reserved_units, 0);
            const counters = { consumed: status.budget.consumed_units, reserved: status.budget.reserved_units };
            if (!repetition) firstBudget = counters;
            else assert.deepEqual(counters, firstBudget);
          }
        } catch (error) { failure = error; }
      });
      cold.readThread = structuredClone(initial.history);
      adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => cold });
      await adapter.run("Continue the same Mission");
      if (failure) throw failure;
      const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(mission.codexNotStarted?.length, 1);
      if (kind === "coordinator") assert.equal(mission.dispatchOpen, false);
      await adapter.close();
    }
    if (kind === "coordinator") {
      const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
      const before = await missions.required("root");
      await missions.update("root", current => { current.phase = "completed"; });
      await missions.capture("root", { id: "next-request", text: "Perform the next Mission" });
      const next = await missions.start("root", ["Perform the next Mission"], false, { executionHost: "codex" });
      assert.notEqual(next.id, before.id);
      assert.deepEqual(next.codexNotStarted, before.codexNotStarted);
      const native = new ScriptedTransport("root", async () => "Next Mission retains the exact prior native reconciliation");
      native.readThread = structuredClone(initial.history);
      adapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => native });
      await adapter.run("Continue next Mission");
      assert.equal(native.turnStarts, 1);
    }
  } finally { await adapter?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("live prior adapter and ambiguous or changed native call never authorize recovery", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-live-owner-"));
  let adapter: CodexMissionSession | undefined, coldAdapter: CodexMissionSession | undefined;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "process.exit(0)");
    const initial = await interruptedTask(directory, "worker");
    adapter = initial.adapter;
    for (const variant of ["live", "changed", "duplicate"] as const) {
      if (variant !== "live") await adapter.close();
      const native = new ScriptedTransport("root", async () => { throw new Error("must not dispatch"); });
      native.readThread = structuredClone(initial.history);
      const items = native.readThread.turns[0].items;
      const pending = items.find((item: Json) => item.id === "not-started-call");
      if (variant === "changed") pending.arguments.prompt = "different request";
      if (variant === "duplicate") items.push(structuredClone(pending));
      coldAdapter = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => native });
      await assert.rejects(coldAdapter.run("Continue"), /unresolved tool execution; no resend/);
      assert.equal(native.turnStarts, 0);
      await coldAdapter.close();
    }
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).codexNotStarted, undefined);
  } finally { await adapter?.close(); await coldAdapter?.close(); await rm(directory, { recursive: true, force: true }); }
});


test("recovery lock serializes processes and reclaims a killed owner", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-recovery-lock-"));
  try {
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "u1", text: "Keep one recovery owner" });
    await missions.start("root", ["Keep one recovery owner"]);
    const moduleURL = new URL("../dist/core/operator-mission.js", import.meta.url).href;
    const profileURL = new URL("../dist/core/runtime-profile.js", import.meta.url).href;
    const prefix = `import {OperatorMissionRuntime} from ${JSON.stringify(moduleURL)};import {V010_RUNTIME_PROFILE} from ${JSON.stringify(profileURL)};import{appendFile}from'node:fs/promises';const missions=new OperatorMissionRuntime(${JSON.stringify(directory)},V010_RUNTIME_PROFILE);`;
    await Promise.all(Array.from({ length: 4 }, (_, index) => exec(process.execPath, ["--input-type=module", "-e", prefix +
      `await missions.codexRecovery('root',async()=>{await appendFile(${JSON.stringify(join(directory, "order"))},'start${index}\\n');await new Promise(r=>setTimeout(r,30));await appendFile(${JSON.stringify(join(directory, "order"))},'end${index}\\n');});`])));
    const entries = (await readFile(join(directory, "order"), "utf8")).trim().split("\n");
    assert.equal(entries.length, 8);
    for (let index = 0; index < entries.length; index += 2) assert.equal(entries[index + 1], entries[index]!.replace("start", "end"));
    await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", prefix +
      "await missions.codexRecovery('root',async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});});"]));
    assert.equal(await missions.codexRecovery("root", async () => "reclaimed"), "reclaimed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("closing during new child creation preserves exact not-started proof after reservation settlement", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-close-prelaunch-"));
  let adapter: CodexMissionSession | undefined, recovered: CodexMissionSession | undefined;
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), "process.exit(0)");
    let childStarted!: () => void;
    const creating = new Promise<void>(resolve => { childStarted = resolve; });
    const root = new ScriptedTransport("root", async host => {
      const started = await host.call("sortie_v010_start_mission", { requirements: ["Validate"], unit: {
        title: "Validate", objective: "Validate", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] } });
      await host.call("task", started.task);
    });
    class DelayedChild extends ScriptedTransport {
      override send(message: Json) {
        if (message.method === "thread/start") { childStarted(); return; }
        super.send(message);
      }
    }
    let created = 0;
    adapter = await CodexMissionSession.create({ projectRoot: directory, model: "gpt-6.1-sol", transportFactory: () =>
      created++ === 0 ? root : new DelayedChild("child", async () => { throw new Error("must not dispatch"); }) });
    const run = assert.rejects(adapter.run("Validate"), /closed/);
    await creating;
    await adapter.close();
    await run;
    root.turns[0].status = "interrupted";
    const state = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(state.codexOwner?.closed, true);
    assert.equal(state.codexNotStarted?.length, 1);
    const cold = new ScriptedTransport("root", async () => "resumed without resending the failed Task");
    cold.readThread = { id: "root", cwd: directory, modelProvider: "openai", model: "gpt-6.1-sol", turns: structuredClone(root.turns) };
    recovered = await CodexMissionSession.create({ projectRoot: directory, transportFactory: () => cold });
    await recovered.run("Continue");
    assert.equal(cold.turnStarts, 1);
  } finally { await adapter?.close(); await recovered?.close(); await rm(directory, { recursive: true, force: true }); }
});
