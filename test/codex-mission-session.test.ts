import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CodexMissionSession } from "../dist/codex/mission-session.js";
import type { CodexAppServerTransport } from "../dist/codex/app-server.js";
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
