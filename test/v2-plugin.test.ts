import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import V2Plugin, {
  V2_RETURN_REPORT_METADATA_KEY,
  createSortieDogsV2Plugin,
  createV2ReturnReportPublisher,
  type OpenCodeV2Context,
} from "../dist/plugin/v2.js";
import type { OpenCodeHooks, OpenCodePlugin } from "../dist/plugin/index.js";

function contextFixture() {
  const history: Record<string, unknown>[] = [{
    id: "assistant-final",
    type: "assistant",
    agent: "dog-coordinator-v010",
    finish: "stop",
    time: { created: 1, completed: 2 },
    model: { providerID: "openai", id: "test-model" },
    content: [{ type: "text", text: "✅ **DONE** `v2-report` — complete\n\n**変更点:** fixed\n\n**確認結果:** PASS\n\n**次:** なし" }],
  }];
  const synthetic: Record<string, unknown>[] = [];
  const tools: Record<string, unknown>[] = [];
  const toolHooks = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>();
  const sessionHooks = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>();
  const permissionHooks = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>();
  const agentSwitches: Record<string, unknown>[] = [];
  const modelSwitches: Record<string, unknown>[] = [];
  const queued: Array<{ event: Record<string, unknown>; accepted(): void }> = [];
  const waiting: Array<(value: { event: Record<string, unknown>; accepted(): void } | undefined) => void> = [];
  let aborted = false;
  let failSynthetic = false;
  let failContext = false;
  const emit = (event: Record<string, unknown>) => new Promise<void>(accepted => {
    const item = { event, accepted };
    const waiter = waiting.shift();
    if (waiter) waiter(item); else queued.push(item);
  });
  const context: OpenCodeV2Context = {
    app: { version: "2.0.11" },
    location: { directory: process.cwd(), project: { id: "fixture" } },
    options: {},
    event: { subscribe: async function* ({ signal } = {}) {
      while (!signal?.aborted) {
        const item = queued.shift() ?? await new Promise<typeof queued[number] | undefined>(resolve => {
          const stop = () => { aborted = true; resolve(undefined); };
          if (signal?.aborted) stop();
          else { waiting.push(resolve); signal?.addEventListener("abort", stop, { once: true }); }
        });
        if (item === undefined) return;
        yield item.event;
        item.accepted();
      }
    } },
    tool: {
      transform: async callback => { callback({ add: tool => { tools.push(tool); } }); return { dispose() {} }; },
      hook: async (name, callback) => { toolHooks.set(name, callback); return { dispose() {} }; },
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, agent: "dog-coordinator-v010", model: { providerID: "openai", id: "test-model" } }),
      context: async () => {
        if (failContext) { failContext = false; throw new Error("context unavailable"); }
        return history;
      },
      prompt: async () => ({}),
      synthetic: async input => {
        if (failSynthetic) { failSynthetic = false; throw new Error("synthetic unavailable"); }
        const message = { id: input.id, type: "synthetic", text: input.text, metadata: input.metadata, time: { created: 3 } };
        history.push(message); synthetic.push(input); return message;
      },
      interrupt: async () => ({}),
      switchAgent: async input => { agentSwitches.push(input); return {}; },
      switchModel: async input => { modelSwitches.push(input); return {}; },
      hook: async (name, callback) => { sessionHooks.set(name, callback); return { dispose() {} }; },
    },
    permission: { hook: async (name, callback) => { permissionHooks.set(name, callback); return { dispose() {} }; } },
    provider: { list: async () => ({ data: [] }) },
    model: { list: async () => ({ data: [] }) },
  };
  return { context, history, synthetic, tools, toolHooks, sessionHooks, permissionHooks, agentSwitches, modelSwitches, emit,
    failNextSynthetic: () => { failSynthetic = true; }, failNextContext: () => { failContext = true; }, aborted: () => aborted };
}

test("V2 return report uses one durable non-resuming synthetic card across replay and restart", async () => {
  const fixture = contextFixture();
  fixture.history.push(
    { id: "assistant-empty", type: "assistant", agent: "dog-coordinator-v010", finish: "stop",
      content: [{ type: "text", text: "   " }] },
    { id: "assistant-tools", type: "assistant", agent: "dog-coordinator-v010", finish: "tool-calls",
      content: [{ type: "text", text: "not terminal" }] },
  );
  const hooks: OpenCodeHooks = {
    "experimental.text.complete": async (_input, output) => {
      output.text += "\n\n<details>\n<summary><strong>🐾 SORTIE DOGS — 帰還報告</strong></summary>\n\nproof\n\n</details>";
    },
  };
  const publish = createV2ReturnReportPublisher(fixture.context, hooks);
  await Promise.all([publish("root"), publish("root")]);
  assert.equal(fixture.synthetic.length, 1);
  assert.equal(fixture.synthetic[0]!.resume, false);
  assert.equal(fixture.synthetic[0]!.delivery, "queue");
  assert.match(String(fixture.synthetic[0]!.text), /^<details>\r?\n<summary><strong>🐾 SORTIE DOGS — 帰還報告/u);
  const metadata = fixture.synthetic[0]!.metadata as Record<string, Record<string, unknown>>;
  assert.match(String(metadata[V2_RETURN_REPORT_METADATA_KEY]!.identity), /^[a-f0-9]{64}$/u);
  assert.equal(metadata[V2_RETURN_REPORT_METADATA_KEY]!.source_message_id, "assistant-final");

  await createV2ReturnReportPublisher(fixture.context, hooks)("root");
  assert.equal(fixture.synthetic.length, 1, "persisted metadata deduplicates after plugin restart");
});

test("V2 return report publishes nothing without a host-rendered succeeded receipt", async () => {
  const fixture = contextFixture();
  await createV2ReturnReportPublisher(fixture.context, {
    "experimental.text.complete": async () => {},
  })("root");
  assert.deepEqual(fixture.synthetic, []);
});

test("V2 server plugin registers tools and translates public hooks without changing the V1 entry", async () => {
  const fixture = contextFixture();
  let beforeInput: unknown;
  let afterOutput: unknown;
  const legacy: OpenCodePlugin = async () => ({
    tool: {
      sortie_v010_fixture: {
        description: "fixture",
        args: { required: { type: "string" }, optional: { type: "string", "x-sortie-optional": true } },
        execute: async args => JSON.stringify(args),
      },
    },
    "tool.execute.before": async (input, output) => { beforeInput = { input, output: structuredClone(output) }; },
    "tool.execute.after": async (_input, output) => { afterOutput = structuredClone(output); output.output = "repaired"; },
    "chat.message": async (_input, output) => {
      (output.parts[0] as { text: string }).text += "-mapped";
      output.message.agent = "dog-worker-v010";
      output.message.model = { providerID: "openai", modelID: "changed-model", variant: "high" };
    },
    "experimental.chat.system.transform": async (_input, output) => { (output.system ??= []).push("V2_SYSTEM"); },
    "experimental.session.compacting": async (_input, output) => { (output.context ??= []).push("V2_COMPACTION"); },
    "permission.ask": async (_input, output) => { output.status = "deny"; },
  });
  const plugin = createSortieDogsV2Plugin(legacy);
  const cleanup = await plugin.setup(fixture.context);
  assert.equal(plugin.id, "sortie-dogs.v010");
  assert.equal(fixture.tools.length, 1);
  const registered = fixture.tools[0] as { input: { required: string[] }; execute(input: unknown, context: unknown): Promise<{ content: string }> };
  assert.deepEqual(registered.input.required, ["required"]);
  assert.equal((await registered.execute({ required: "yes" }, { sessionID: "root", agent: "dog-coordinator-v010" })).content, '{"required":"yes"}');

  const before = fixture.toolHooks.get("execute.before")!;
  const subagent = { tool: "subagent", sessionID: "root", agent: "dog-coordinator-v010", id: "call", input: { agent: "dog-worker-v010", prompt: "work" } };
  await before(subagent);
  assert.deepEqual((beforeInput as { output: { args: Record<string, unknown> } }).output.args,
    { subagent_type: "dog-worker-v010", prompt: "work" });
  assert.deepEqual(subagent.input, { agent: "dog-worker-v010", prompt: "work" });

  const resumed = { tool: "subagent", sessionID: "root", agent: "dog-coordinator-v010", id: "resume-call",
    input: { agent: "dog-worker-v010", prompt: "continue", sessionID: "child-session" } };
  await before(resumed);
  assert.deepEqual((beforeInput as { output: { args: Record<string, unknown> } }).output.args,
    { subagent_type: "dog-worker-v010", prompt: "continue", task_id: "child-session" });
  assert.deepEqual(resumed.input, { agent: "dog-worker-v010", prompt: "continue", sessionID: "child-session" });

  const after = fixture.toolHooks.get("execute.after")!;
  const completed = { tool: "shell", sessionID: "root", id: "shell-call", status: "completed", result: { content: "original" } };
  await after(completed);
  assert.equal((afterOutput as { output: string }).output, "original");
  assert.deepEqual(completed.result, { content: "repaired" });

  const prompt = { sessionID: "root", messageID: "user-1", prompt: { text: "hello" } };
  await fixture.sessionHooks.get("prompt")!(prompt);
  assert.equal(prompt.prompt.text, "hello-mapped");
  assert.deepEqual(fixture.agentSwitches, [{ sessionID: "root", agent: "dog-worker-v010" }]);
  assert.deepEqual(fixture.modelSwitches, [{ sessionID: "root",
    model: { providerID: "openai", id: "changed-model", variant: "high" } }]);
  const system = { sessionID: "root", system: [] as unknown[] };
  await fixture.sessionHooks.get("context")!(system);
  assert.deepEqual(system.system, [{ type: "text", text: "V2_SYSTEM" }]);
  const compaction = { sessionID: "root", system: [] as unknown[] };
  await fixture.sessionHooks.get("compaction")!(compaction);
  assert.deepEqual(compaction.system, [{ type: "text", text: "V2_COMPACTION" }]);
  const permission = { sessionID: "root", action: "edit", resources: ["file.txt"], effect: "ask" };
  await fixture.permissionHooks.get("evaluate")!(permission);
  assert.equal(permission.effect, "deny");
  cleanup?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.aborted(), true);
});

test("V2 child prompt adapter removes only the native subagent envelope before strict Sortie claiming", async () => {
  const fixture = contextFixture();
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, parentID: "root", agent: "dogs-coordinator",
    model: { providerID: "openai", id: "test-model" } });
  const observed: string[] = [];
  const plugin = createSortieDogsV2Plugin(async () => ({
    "chat.message": async (_input, output) => {
      const part = output.parts[0] as { text: string };
      observed.push(part.text);
      if (part.text === "SORTIE_OPERATOR_PROPOSAL_TASK_REF fixture") part.text = "canonical proposal task";
    },
  }));
  const cleanup = await plugin.setup(fixture.context);
  try {
    const promptHook = fixture.sessionHooks.get("prompt")!;
    const claimed = { sessionID: "child", messageID: "user-1",
      prompt: { text: "You are a subagent spawned by another session.\nSORTIE_OPERATOR_PROPOSAL_TASK_REF fixture" } };
    await promptHook(claimed);
    assert.equal(observed[0], "SORTIE_OPERATOR_PROPOSAL_TASK_REF fixture");
    assert.equal(claimed.prompt.text, "canonical proposal task");

    const ordinary = { sessionID: "child", messageID: "user-2",
      prompt: { text: "You are a subagent spawned by another session.\nordinary task" } };
    await promptHook(ordinary);
    assert.equal(observed[1], "ordinary task");
    assert.equal(ordinary.prompt.text, "You are a subagent spawned by another session.\nordinary task");
  } finally {
    cleanup?.();
  }
});

test("V2 event failures warn per event and keep lifecycle translation active", async () => {
  const fixture = contextFixture();
  const observed: string[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values); };
  const legacy: OpenCodePlugin = async () => ({
    "experimental.text.complete": async (_input, output) => {
      output.text += "\n\n<details>\n<summary><strong>🐾 SORTIE DOGS — 帰還報告</strong></summary>\n\nproof\n\n</details>";
    },
    event: async ({ event }) => { observed.push(`${event.type}:${String(event.properties?.file ?? event.properties?.sessionID ?? "")}`); },
  });
  const cleanup = await createSortieDogsV2Plugin(legacy).setup(fixture.context);
  try {
    fixture.failNextContext();
    await fixture.emit({ type: "session.execution.succeeded", data: { sessionID: "root" } });
    fixture.failNextSynthetic();
    await fixture.emit({ type: "session.execution.succeeded", data: { sessionID: "root" } });
    await fixture.emit({ type: "session.idle", data: { sessionID: "root" } });
    await fixture.emit({ type: "session.compaction.ended", data: { sessionID: "root" } });
    await fixture.emit({ type: "filesystem.changed", data: { file: "changed.txt", event: "change" } });
    assert.equal(fixture.synthetic.length, 0);
    assert.ok(warnings.some(values => values[0] === "[sortie-dogs-v010] V2 event handling failed" && values[1] === "context unavailable"));
    assert.ok(warnings.some(values => values[0] === "[sortie-dogs-v010] V2 event handling failed" && values[1] === "synthetic unavailable"));
    assert.deepEqual(observed, ["session.idle:root", "session.compacted:root", "file.edited:changed.txt"]);
  } finally {
    console.warn = originalWarn;
    cleanup?.();
  }
});

test("package server export resolves to the V2 default definition", async () => {
  assert.equal(V2Plugin.id, "sortie-dogs.v010");
  assert.equal(typeof V2Plugin.setup, "function");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(packageJson.exports["./server"], { types: "./dist/plugin/v2.d.ts", import: "./dist/plugin/v2.js" });
});

test("V1 preview and stable package entries remain callable", async () => {
  const preview = await import("sortie-dogs/plugin");
  const stable = await import("sortie-dogs/plugin/stable");
  assert.equal(typeof preview.SortieDogsPlugin, "function");
  assert.equal(typeof stable.SortieDogsPlugin, "function");
});

test("actual v0.10 tools preserve required, optional, and described schemas through V2", async () => {
  const fixture = contextFixture();
  const cleanup = await V2Plugin.setup(fixture.context);
  try {
    const tools = fixture.tools as Array<{ name: string; input: { required: string[]; properties: Record<string, { description?: string }> } }>;
    const prepare = tools.find(tool => tool.name === "sortie_v010_prepare_operator")!;
    const cancel = tools.find(tool => tool.name === "sortie_v010_cancel_operator")!;
    const begin = tools.find(tool => tool.name === "sortie_v010_begin_operator_proposal")!;
    const check = tools.find(tool => tool.name === "sortie_v010_check_contract")!;
    assert.deepEqual(prepare.input.required, ["plan_json"]);
    assert.match(prepare.input.properties.plan_json!.description!, /plan_json must encode the exact operator plan object/u);
    assert.deepEqual(cancel.input.required, ["reason"]);
    assert.deepEqual(begin.input.required, ["intent_json"]);
    assert.match(begin.input.properties.intent_json!.description!, /intent_json must encode exactly this JSON object/u);
    assert.deepEqual(check.input.required, ["handoff_path"]);
  } finally {
    cleanup?.();
  }
});
