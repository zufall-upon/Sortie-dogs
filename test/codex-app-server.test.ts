import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexAppServerHost, type CodexAppServerTransport } from "../dist/codex/app-server.js";

class FakeTransport implements CodexAppServerTransport {
  readonly sent: Record<string, unknown>[] = [];
  private queue: unknown[] = [];
  private waiting?: (value: IteratorResult<unknown>) => void;
  private ended = false;
  readonly messages: AsyncIterable<unknown> = { [Symbol.asyncIterator]: () => ({ next: () => {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.waiting = resolve; });
  } }) };
  send(message: Record<string, unknown>): void { this.sent.push(message); }
  push(message: unknown): void {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value: message, done: false }); }
    else this.queue.push(message);
  }
  async close(): Promise<void> { this.ended = true; this.waiting?.({ value: undefined, done: true }); }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("Codex app-server host initializes, runs one turn, and preserves authoritative completed items", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport, { clientVersion: "test" });
  const initialize = host.initialize();
  assert.equal(transport.sent[0]?.method, "initialize");
  transport.push({ id: 1, result: { userAgent: "codex" } });
  await initialize;
  assert.equal(transport.sent[1]?.method, "initialized");
  const thread = host.startThread({ cwd: "C:\\fixture", ephemeral: true });
  await tick();
  transport.push({ id: 2, result: { thread: { id: "thr_1" } } });
  assert.equal(await thread, "thr_1");
  const events: string[] = [];
  const run = host.runTurn("thr_1", "Make hello.txt", { cwd: "C:\\fixture",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["C:\\fixture"], networkAccess: false },
    onEvent: event => { events.push(event.method); } });
  await tick();
  transport.push({ id: 3, result: { turn: { id: "turn_1", status: "inProgress", items: [] } } });
  await tick();
  transport.push({ method: "item/completed", params: { threadId: "thr_1", turnId: "turn_1",
    item: { id: "cmd", type: "commandExecution", status: "completed", command: "write", exitCode: 0 } } });
  transport.push({ method: "item/completed", params: { threadId: "thr_1", turnId: "turn_1",
    item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "done" } } });
  transport.push({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } });
  const result = await run;
  assert.equal(result.status, "completed");
  assert.equal(result.finalResponse, "done");
  assert.equal(result.items.length, 2);
  assert.deepEqual(events, ["item/completed", "item/completed", "turn/completed"]);
  await host.close();
});

test("Codex app-server host declines approvals by default and can interrupt", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  const init = host.initialize();
  transport.push({ id: 1, result: {} });
  await init;
  const run = host.runTurn("thr_2", "Wait", { cwd: "C:\\fixture" });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_2", status: "inProgress" } } });
  await tick();
  transport.push({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "thr_2", turnId: "turn_2", itemId: "cmd" } });
  await tick();
  assert.deepEqual(transport.sent.at(-1), { id: 99, result: { decision: "decline" } });
  const interrupted = host.interrupt();
  await tick();
  const request = transport.sent.at(-1)!;
  assert.equal(request.method, "turn/interrupt");
  transport.push({ id: request.id, result: {} });
  await interrupted;
  transport.push({ method: "turn/completed", params: { threadId: "thr_2", turn: { id: "turn_2", status: "interrupted" } } });
  assert.equal((await run).status, "interrupted");
  await host.close();
});

test("Codex app-server event observers can interrupt without blocking the protocol pump", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  let interrupt: Promise<void> | undefined;
  const run = host.runTurn("thr_reentrant", "Wait", { cwd: "C:\\fixture", onEvent: event => {
    if (event.method === "item/started") interrupt ??= host.interrupt();
  } });
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_reentrant", status: "inProgress" } } });
  await tick();
  transport.push({ method: "item/started", params: { threadId: "thr_reentrant", turnId: "turn_reentrant",
    item: { id: "cmd", type: "commandExecution", status: "inProgress", command: "wait" } } });
  await tick();
  const request = transport.sent.at(-1)!;
  assert.equal(request.method, "turn/interrupt");
  transport.push({ id: request.id, result: {} });
  await tick();
  await interrupt;
  transport.push({ method: "turn/completed", params: { threadId: "thr_reentrant",
    turn: { id: "turn_reentrant", status: "interrupted" } } });
  assert.equal((await run).status, "interrupted");
  await host.close();
});

test("Codex app-server keeps a completing turn closeable while its observer is pending", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const run = host.runTurn("thr_pending", "Wait", { cwd: "C:\\fixture", onEvent: event =>
    event.method === "turn/completed" ? pending : undefined });
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_pending", status: "inProgress" } } });
  await tick();
  transport.push({ method: "turn/completed", params: { threadId: "thr_pending",
    turn: { id: "turn_pending", status: "completed" } } });
  await tick();
  await assert.rejects(host.runTurn("thr_other", "No overlap", { cwd: "C:\\fixture" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "turn-active");
  await host.close();
  await assert.rejects(run, (error: unknown) => error instanceof Error && "code" in error && error.code === "server-closed");
  release();
});

test("Codex app-server host resumes exact thread identity", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  const resume = host.resumeThread("thr_existing");
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { thread: { id: "thr_existing" } } });
  await resume;
  assert.equal(transport.sent[2]?.method, "thread/resume");
  await host.close();
});

test("Codex app-server host replays events arriving immediately after turn/start response", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  const run = host.runTurn("thr_fast", "Fast", { cwd: "C:\\fixture" });
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_fast", status: "inProgress" } } });
  transport.push({ method: "item/completed", params: { threadId: "thr_fast", turnId: "turn_fast",
    item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "fast done" } } });
  transport.push({ method: "turn/completed", params: { threadId: "thr_fast", turn: { id: "turn_fast", status: "completed" } } });
  assert.equal((await run).finalResponse, "fast done");
  await host.close();
});

test("Codex app-server host reports authentication class without account secrets", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  const state = host.authenticationState();
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { account: { type: "chatgpt", email: "hidden@example.test", planType: "pro" }, requiresOpenaiAuth: true } });
  assert.deepEqual(await state, { type: "chatgpt", planType: "pro", requiresOpenaiAuth: true });
  await host.close();
});

test("Codex app-server host rejects active work when closed", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  const run = host.runTurn("thr_close", "Wait", { cwd: "C:\\fixture" });
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_close", status: "inProgress" } } });
  await tick();
  await host.close();
  await assert.rejects(run, (error: unknown) => error instanceof Error && "code" in error && error.code === "server-closed");
});

test("Codex app-server host declines when an approval handler fails and keeps pumping", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport, { approval: () => { throw new Error("handler failed"); } });
  const run = host.runTurn("thr_approval", "Wait", { cwd: "C:\\fixture" });
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_approval", status: "inProgress" } } });
  await tick();
  transport.push({ id: 50, method: "item/fileChange/requestApproval", params: { threadId: "thr_approval", turnId: "turn_approval" } });
  await tick();
  assert.deepEqual(transport.sent.at(-1), { id: 50, result: { decision: "decline" } });
  transport.push({ method: "turn/completed", params: { threadId: "thr_approval", turn: { id: "turn_approval", status: "completed" } } });
  assert.equal((await run).status, "completed");
  await host.close();
});

test("Codex app-server host declines an approval outside the active turn", async () => {
  const transport = new FakeTransport();
  let called = false;
  const host = new CodexAppServerHost(transport, { approval: () => { called = true; return "accept"; } });
  const run = host.runTurn("thr_scope", "Wait", { cwd: "C:\\fixture" });
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_scope", status: "inProgress" } } });
  await tick();
  transport.push({ id: 70, method: "item/commandExecution/requestApproval", params: {
    threadId: "other", turnId: "turn_scope", availableDecisions: ["accept", "decline"] } });
  await tick();
  assert.equal(called, false);
  assert.deepEqual(transport.sent.at(-1), { id: 70, result: { decision: "decline" } });
  transport.push({ method: "turn/completed", params: { threadId: "thr_scope", turn: { id: "turn_scope", status: "completed" } } });
  await run;
  await host.close();
});

test("Codex app-server host contains observer failure until turn completion", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport);
  const run = host.runTurn("thr_observer", "Wait", { cwd: "C:\\fixture", onEvent: () => { throw new Error("observer"); } });
  transport.push({ id: 1, result: {} });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn_observer", status: "inProgress" } } });
  await tick();
  transport.push({ method: "item/completed", params: { threadId: "thr_observer", turnId: "turn_observer",
    item: { id: "answer", type: "agentMessage", text: "done" } } });
  transport.push({ method: "turn/completed", params: { threadId: "thr_observer", turn: { id: "turn_observer", status: "completed" } } });
  await assert.rejects(run, /observer failed/u);
  await host.close();
});


test("concurrent Codex close callers wait for the same transport cleanup", async () => {
  const transport = new FakeTransport();
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const original = transport.close.bind(transport);
  transport.close = async () => { await cleanup; await original(); };
  const host = new CodexAppServerHost(transport);
  let first = false, second = false;
  const a = host.close().then(() => { first = true; });
  const b = host.close().then(() => { second = true; });
  await tick();
  assert.equal(first, false); assert.equal(second, false);
  release(); await Promise.all([a, b]);
  assert.equal(first, true); assert.equal(second, true);
});

test("Codex dynamic tools can call native command/exec without blocking responses", async () => {
  const transport = new FakeTransport();
  const host = new CodexAppServerHost(transport, { dynamicTool: async call => {
    assert.equal(call.tool, "bash");
    const result = await host.executeCommand(["/bin/bash", "-lc", "false"], "/fixture");
    return JSON.stringify(result);
  } });
  const run = host.runTurn("thread", "Check", { cwd: "/fixture" });
  assert.deepEqual((transport.sent[0]?.params as Record<string, unknown>).capabilities, { experimentalApi: true });
  transport.push({ id: 1, result: {} }); await tick();
  transport.push({ id: 2, result: { turn: { id: "turn" } } }); await tick();
  transport.push({ id: "dynamic-call", method: "item/tool/call", params: { threadId: "thread", turnId: "turn", callId: "call", tool: "bash", arguments: {} } });
  await tick();
  const command = transport.sent.at(-1)!;
  assert.equal(command.method, "command/exec");
  assert.deepEqual(command.params, { command: ["/bin/bash", "-lc", "false"], cwd: "/fixture", timeoutMs: 120000 });
  transport.push({ id: command.id, result: { exitCode: 1, stdout: "", stderr: "failed" } }); await tick();
  assert.deepEqual(transport.sent.at(-1), { id: "dynamic-call", result: { contentItems: [{ type: "inputText", text: JSON.stringify({ exitCode: 1, stdout: "", stderr: "failed" }) }], success: true } });
  transport.push({ id: 99, method: "item/tool/call", params: { threadId: "other", turnId: "turn", callId: "other", tool: "bash", arguments: {} } }); await tick();
  assert.equal((transport.sent.at(-1)!.result as {success:boolean}).success, false);
  transport.push({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  assert.equal((await run).status, "completed");
  await host.close();
});

test("Codex dynamic tool completion after close does not write to the closed transport", async () => {
  const transport = new FakeTransport();
  let finish!: (value: string) => void;
  const host = new CodexAppServerHost(transport, { dynamicTool: () => new Promise(resolve => { finish = resolve; }) });
  const run = host.runTurn("thread", "Check", { cwd: "/fixture" });
  const rejected = assert.rejects(run, /closed/);
  transport.push({ id: 1, result: {} }); await tick();
  transport.push({ id: 2, result: { turn: { id: "turn" } } }); await tick();
  transport.push({ id: 99, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", callId: "call", tool: "bash", arguments: {} } }); await tick();
  await host.close(); await rejected;
  const count = transport.sent.length;
  finish("late"); await tick();
  assert.equal(transport.sent.length, count);
});


test("native permission requests reach the host and preserve its scoped response", async () => {
  const transport = new FakeTransport();
  const requests: unknown[] = [];
  const granted = { permissions: { fileSystem: { write: ["/approved/output"] } }, scope: "turn" as const, strictAutoReview: true };
  const host = new CodexAppServerHost(transport, { permissionsApproval: request => { requests.push(request); return granted; } });
  const init = host.initialize();
  transport.push({ id: 1, result: {} });
  await init;
  const run = host.runTurn("thread", "Continue", { cwd: "/repo" });
  await tick();
  transport.push({ id: 2, result: { turn: { id: "turn" } } });
  await tick();
  const params = { threadId: "thread", turnId: "turn", itemId: "permission", permissions: { fileSystem: { write: ["/approved/output"] } } };
  transport.push({ id: 3, method: "item/permissions/requestApproval", params });
  await tick();
  assert.deepEqual(requests, [{ method: "item/permissions/requestApproval", params }]);
  assert.deepEqual(transport.sent.at(-1), { id: 3, result: granted });
  transport.push({ id: 4, method: "item/permissions/requestApproval", params: { ...params, turnId: "other" } });
  await tick();
  assert.equal(requests.length, 1);
  assert.deepEqual(transport.sent.at(-1), { id: 4, result: { permissions: {}, scope: "turn" } });
  transport.push({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  await run;
  await host.close();
});
