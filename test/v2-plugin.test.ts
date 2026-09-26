import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

import V2Plugin, {
  createSortieDogsV2Plugin,
  createV2ReturnReportFinalizer,
  type OpenCodeV2Context,
} from "../dist/plugin/v2.js";
import type { OpenCodeHooks, OpenCodePlugin } from "../dist/plugin/index.js";
import { collectRunMetrics } from "../dist/plugin/run-metrics.js";
import { terminalCancelledMissionChildren } from "../dist/plugin/profiled.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { missionProgressReader } from "../dist/plugin/mission-progress.js";

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
    agent: { transform: async () => ({ dispose() {} }), get: async ({ agentID }) => ({ model: {
      providerID: "openai", id: agentID === "dog-worker-v010" ? "gpt-6-luna-fast" : "gpt-6-sol",
      variant: agentID === "dog-worker-v010" ? "max" : "xhigh",
    } }) },
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
        assert.match(String(input.id), /^msg_/, "V2 session.synthetic rejects IDs outside the native message namespace");
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

test("V2 Task recovers durable progress without a live settlement sink and retains it at native completion", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(resolve("_testenv/v2-progress-"));
  const fixture = contextFixture();
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "user", text: "Run benchmark" });
  await missions.start("root", ["Run benchmark"]);
  await missions.update("root", mission => { mission.callID = "call"; mission.phase = "running"; });
  const updates: Record<string, unknown>[] = [];
  let sawFailed!: () => void;
  let deadline: ReturnType<typeof setTimeout>;
  const failed = new Promise<void>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("durable progress was not delivered")), 3000);
    sawFailed = () => { clearTimeout(deadline); resolve(); };
  });
  const nativeOutput = { sessionID: "coordinator", status: "completed", output: "Infrastructure failed" };
  const native = { execute: async (_input: unknown, execution: Record<string, unknown>) => {
    await (execution.progress as (x: unknown) => Promise<void>)({ sessionID: "coordinator", status: "running" });
    // Another instance writes the mission. No publishMissionProgress call occurs in this process.
    const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await cold.update("root", mission => { mission.progress.push({ unit: "run/unit-1", title: "Model route failed; inference 0",
      status: "failed", at: new Date().toISOString() }); });
    await failed;
    return { output: nativeOutput, content: "failed", metadata: { sessionID: "coordinator", status: "completed" } };
  } };
  const context: OpenCodeV2Context = { ...fixture.context, location: { directory }, tool: { ...fixture.context.tool,
    transform: async callback => { callback({ add() {}, update: (id, update) => { if (id === "subagent") update(native); } }); return { dispose() {} }; },
  } };
  const cleanup = await createSortieDogsV2Plugin(async () => ({})).setup(context);
  try {
    const result = await native.execute({ agent: "dogs-coordinator" }, { sessionID: "root", id: "call",
      progress: async (value: Record<string, unknown>) => {
        updates.push(value);
        if ((value.sortie_progress as { status?: string } | undefined)?.status === "failed") sawFailed();
      } });
    assert.ok(updates.some(value => value.sessionID === "coordinator" && /failed/.test(String(value.description))));
    assert.equal((result.metadata as Record<string, unknown>).sessionID, "coordinator");
    assert.equal((result.metadata as Record<string, unknown>).status, "completed");
    assert.equal(((result.metadata as Record<string, unknown>).sortie_progress as { accepted: boolean }).accepted, false);
    assert.deepEqual(result.output, nativeOutput, "preserve native success output schema");
    assert.equal(fixture.synthetic.length, 0, "progress must not queue new model work");
  } finally { clearTimeout(deadline!); cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

test("progress observes unit admission after reading the prepared run, rather than retaining its cached state", async () => {
  const directory = await mkdtemp(resolve("_testenv/v2-progress-state-"));
  try {
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "u1", text: "Fix result" });
    const mission = await missions.start("root", ["Fix result"]);
    const run = await operators.prepareMission("root", missionPlan(mission, [{ title: "Fix result", objective: "Fix result",
      read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }]));
    await missions.update("root", state => { state.callID = "call"; state.runID = run.runID; });
    const observe = missionProgressReader(directory, "root", "call");
    assert.equal((await observe())?.sortie_progress.unit, null);
    await operators.admitWorker("root", "root", "worker-call", operators.nextWorkerTask(run));
    await operators.claimAdmittedWorkerPrompt("root", "root", "worker", operators.nextWorkerTask(run).prompt);
    const running = (await observe())!.sortie_progress;
    assert.equal(running.status, "running");
    assert.equal(running.child_session_id, "worker");
    assert.equal(await missionProgressReader(directory, "root", "foreign-call")(), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("V2 operator dispatch rejects background before admission and accepts explicit foreground", async () => {
  const fixture = contextFixture();
  const seen: Record<string, unknown>[] = [];
  const context: OpenCodeV2Context = { ...fixture.context, agent: {
    transform: async () => ({ dispose() {} }),
    get: async () => ({ model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" } }),
  } };
  const dispose = await createSortieDogsV2Plugin(async () => ({
    "tool.execute.before": async (_request, output) => { seen.push(output.args); },
  })).setup(context);
  try {
    for (const prompt of ["SORTIE_OPERATOR_DELEGATE_REF {}", "SORTIE_OPERATOR_TASK_REF {}", "SORTIE_OPERATOR_PROPOSAL_TASK_REF {}"]) {
      const input = { agent: "dogs-coordinator", description: "exact", prompt, background: true };
      await assert.rejects(async () => fixture.toolHooks.get("execute.before")!({ tool: "subagent", input, sessionID: "root", id: "call" }),
        /operator-background-dispatch-not-supported: retry the same exact Task with background omitted or false/);
      assert.equal(seen.length, 0, "rejected transport must not reach admission or reserve budget");
    }
    const event = { tool: "subagent", input: { agent: "dogs-coordinator", description: "exact",
      prompt: "SORTIE_OPERATOR_DELEGATE_REF {}", background: false }, sessionID: "root", id: "call" };
    await fixture.toolHooks.get("execute.before")!(event);
    assert.deepEqual(seen, [{ subagent_type: "dogs-coordinator", description: "exact", prompt: "SORTIE_OPERATOR_DELEGATE_REF {}" }]);
    assert.deepEqual(event.input, { agent: "dogs-coordinator", description: "exact", prompt: "SORTIE_OPERATOR_DELEGATE_REF {}" });
  } finally { if (typeof dispose === "function") dispose(); }
});

test("V2 legacy history retains each turn's agent after switching from Sortie to Build", async () => {
  const fixture = contextFixture();
  fixture.history.splice(0, fixture.history.length,
    { id: "old-user", type: "user", text: "Old mission", metadata: { agent: "dog-operator" }, time: { created: 1 } },
    { id: "new-user", type: "user", text: "Independent Build task", metadata: { agent: "build" }, time: { created: 2 } });
  const observed: string[] = [];
  const context: OpenCodeV2Context = { ...fixture.context, session: { ...fixture.context.session,
    get: async () => ({ id: "root", agent: "build" }),
  } };
  const dispose = await createSortieDogsV2Plugin(async input => ({
    "experimental.chat.system.transform": async () => {
      const messages = await (input.client!.session as { messages(request: unknown): Promise<{ data: { info: { agent: string } }[] }> })
        .messages({ path: { id: "root" } });
      observed.push(...messages.data.map(message => message.info.agent));
    },
  })).setup(context);
  try {
    await fixture.sessionHooks.get("context")!({ sessionID: "root", agent: "build", system: [] });
    assert.deepEqual(observed, ["dog-operator", "build"]);
  } finally { if (typeof dispose === "function") dispose(); }
});

test("V2 role defaults preserve explicit agent models and keep review separate from workers", async () => {
  const fixture = contextFixture();
  const models = new Map<string, { providerID: string; id: string; variant?: string } | undefined>([
    ["dog-operator", undefined], ["dogs-coordinator", undefined],
    ["dog-worker-v010", undefined], ["dog-reviewer-v010", undefined],
    ["dog-scout-v010", { providerID: "anthropic", id: "custom", variant: "high" }],
  ]);
  const context: OpenCodeV2Context = { ...fixture.context, agent: { transform: async callback => {
    callback({ update: (id, update) => {
      if (!models.has(id)) return;
      const agent = { model: models.get(id) };
      update(agent);
      models.set(id, agent.model);
    } });
    return { dispose() {} };
  } } };
  const dispose = await createSortieDogsV2Plugin(async () => ({})).setup(context);
  try {
    assert.deepEqual(models.get("dog-operator"), { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dogs-coordinator"), { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dog-worker-v010"), { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" });
    assert.deepEqual(models.get("dog-reviewer-v010"), { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dog-scout-v010"), { providerID: "anthropic", id: "custom", variant: "high" });
  } finally { if (typeof dispose === "function") dispose(); }
});

test("V2 subagent dispatch leaves role defaults structured and preserves explicit Task models", async () => {
  const fixture = contextFixture();
  const context: OpenCodeV2Context = { ...fixture.context, agent: {
    transform: async () => ({ dispose() {} }),
    get: async ({ agentID }) => ({ data: { model: agentID === "dog-worker-v010"
      ? { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" }
      : { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" } } }),
  } };
  const dispose = await createSortieDogsV2Plugin(async () => ({
    "tool.execute.before": async () => {},
  })).setup(context);
  try {
    const worker = { tool: "subagent", input: { agent: "dog-worker-v010", prompt: "approved" }, sessionID: "root", id: "call-1" };
    await fixture.toolHooks.get("execute.before")!(worker);
    assert.equal(worker.input.model, undefined);
    const reviewer = { tool: "subagent", input: { agent: "dog-reviewer-v010", prompt: "review",
      model: "anthropic/custom#high" }, sessionID: "root", id: "call-2" };
    await fixture.toolHooks.get("execute.before")!(reviewer);
    assert.equal(reviewer.input.model, "anthropic/custom#high");
  } finally { if (typeof dispose === "function") dispose(); }
});

test("V2 native subagent executor preserves host input and explicit Task models", async () => {
  const fixture = contextFixture();
  const received: unknown[] = [];
  const native = { execute: async (input: unknown) => { received.push(input); return { content: "ok" }; } };
  const context: OpenCodeV2Context = { ...fixture.context, tool: {
    ...fixture.context.tool,
    transform: async callback => {
      callback({ add() {}, update: (_id, update) => { update(native); } });
      return { dispose() {} };
    },
  } };
  const dispose = await createSortieDogsV2Plugin(async () => ({ "tool.execute.before": async () => {} })).setup(context);
  try {
    await fixture.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "root", id: "call-1",
      input: { agent: "dog-worker-v010", prompt: "approved" } });
    await native.execute({ agent: "dog-worker-v010", prompt: "approved", model: "openai/gpt-6-sol#medium" }, { sessionID: "root" });
    await fixture.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "root", id: "call-2",
      input: { agent: "dog-worker-v010", prompt: "custom", model: "anthropic/custom#high" } });
    await native.execute({ agent: "dog-worker-v010", prompt: "custom", model: "anthropic/custom#high" }, { sessionID: "root" });
    assert.deepEqual(received, [
      { agent: "dog-worker-v010", prompt: "approved", model: "openai/gpt-6-sol#medium" },
      { agent: "dog-worker-v010", prompt: "custom", model: "anthropic/custom#high" },
    ]);
  } finally { if (typeof dispose === "function") dispose(); }
});

test("V2 terminal reporting never enqueues model input across replay and restart", async () => {
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
  const finalize = createV2ReturnReportFinalizer(fixture.context, hooks);
  await Promise.all([finalize("root"), finalize("root")]);
  await createV2ReturnReportFinalizer(fixture.context, hooks)("root");
  assert.deepEqual(fixture.synthetic, [], "resume=false still creates durable input consumed by the next real turn");
});

test("V2 return report publishes nothing without a host-rendered succeeded receipt", async () => {
  const fixture = contextFixture();
  await createV2ReturnReportFinalizer(fixture.context, {
    "experimental.text.complete": async () => {},
  })("root");
  assert.deepEqual(fixture.synthetic, []);
});

test("V2 report accounting traverses native pages and retains child model, tool and timing evidence", async () => {
  const fixture = contextFixture();
  const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } };
  const tool = (name: string, input: unknown, metadata: unknown) => ({ type: "tool", id: `call-${name}`, name,
    time: { created: 2, ran: 3, completed: 4 }, state: { status: "completed", input, metadata,
      content: [{ type: "text", text: "native output" }] } });
  const message = (id: string, agent: string, content: unknown[]) => ({ id, type: "assistant", agent, finish: "stop",
    time: { created: 1, completed: 5 }, model: { providerID: "openai", id: "gpt-5.6-sol" }, tokens, cost: 0, content });
  const native = {
    root: [message("root-message", "dog-coordinator", [tool("subagent", { agent: "dog-worker", prompt: "work" }, { sessionID: "child-1" })]),
      { id: "old-report-input", type: "synthetic", text: "old queued report", time: { created: 6 } }],
    "child-1": [message("child-1-message", "dog-worker", [tool("patch", { patchText: "diff" }, { files: [{ patch: "+new\n-old" }] })])],
    "child-2": [message("child-2-message", "dog-worker", [tool("shell", { command: "node check.mjs" }, { exit: 0 })])],
  };
  const pages: string[] = [];
  fixture.context.session.context = async () => []; // active context can have been compacted away
  fixture.context.session.list = async input => {
    if (input.cursor) assert.equal(input.order, undefined, "native API rejects cursor combined with order");
    pages.push(`${input.parentID}:${input.cursor ?? "first"}`);
    return input.parentID !== "root" ? { data: [], cursor: {} }
      : input.cursor ? { data: [{ id: "child-2", parentID: "root" }], cursor: {} }
        : { data: [{ id: "child-1", parentID: "root" }], cursor: { next: "children-2" } };
  };
  const context: OpenCodeV2Context = { ...fixture.context, message: { list: async input => ({
    data: native[input.sessionID as keyof typeof native], cursor: {},
  }) } };
  let client: Parameters<typeof collectRunMetrics>[0];
  const cleanup = await createSortieDogsV2Plugin(async input => {
    assert.equal(input.returnReportTransport, "tool-result");
    client = input.client;
    return {};
  }).setup(context);
  try {
    const history = await client!.session!.messages!({ path: { id: "root" } }) as { data: Array<{ info: { role: string }; parts: Array<{ synthetic?: boolean }> }> };
    assert.equal(history.data.at(-1)?.info.role, "user");
    assert.equal(history.data.at(-1)?.parts[0]?.synthetic, true, "legacy root recovery must skip queued inputs without treating them as real goal turns");
    const metrics = await collectRunMetrics(client, "root");
    assert.equal(metrics?.sessions, 3);
    assert.equal(metrics?.tokens, 54);
    assert.deepEqual(pages, ["root:first", "root:children-2", "child-1:first", "child-2:first"]);
    assert.equal(metrics?.debrief?.sessions[0]?.models["openai/gpt-5.6-sol"], 18);
    assert.deepEqual(metrics?.debrief?.sessions[0]?.tasks, ["child-1"]);
    assert.deepEqual(metrics?.debrief?.sessions[1]?.mutations, [{ start: 3, end: 4 }]);
    assert.equal(metrics?.debrief?.sessions[2]?.checks[0]?.passed, true);
    assert.equal(metrics?.debrief?.complete, true);
    fixture.context.session.list = async () => { throw new Error("history unavailable"); };
    const incomplete = await collectRunMetrics(client, "root");
    assert.equal(incomplete?.tokens, undefined, "a missing hierarchy must never report a root-only total as complete");
    assert.equal(incomplete?.debrief?.complete, false);
  } finally { cleanup?.(); }
});

async function registeredHost(run: (host: { requests: URL[]; pid: number; repeated: boolean; malformed: boolean;
  fail: boolean; noRegistration(): Promise<void>; register(pid: number): Promise<void> }) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const area = await mkdtemp(resolve("_testenv/v2-native-history-"));
  const prior = process.env.XDG_STATE_HOME;
  const requests: URL[] = [];
  const host = { requests, pid: process.pid, repeated: false, malformed: false, fail: false,
    noRegistration: () => rm(join(area, "opencode/service.json")), register: async (pid: number) => {
      const address = server.address() as { port: number };
      await writeFile(join(area, "opencode/service.json"), JSON.stringify({ id: "fixture", version: "2.0.18",
        pid, url: `http://127.0.0.1:${address.port}`, password: "fixture-password" }));
    } };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(url);
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`) {
      response.writeHead(401).end(); return;
    }
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/info") { response.end(JSON.stringify({ pid: host.pid, version: "2.0.18" })); return; }
    if (host.fail) { response.writeHead(503).end(JSON.stringify({ message: "unavailable" })); return; }
    if (host.malformed) { response.end(JSON.stringify({ data: [] })); return; }
    const parent = url.searchParams.get("parentID"), cursor = url.searchParams.get("cursor");
    const ids = parent !== "ses_coordinator" ? [] : cursor === null ? ["ses_worker"] : cursor === "page-2" ? ["ses_reviewer"] : [];
    response.end(JSON.stringify({ data: ids.map(id => ({ id, parentID: parent })),
      cursor: { next: parent !== "ses_coordinator" ? null : host.repeated || cursor === null ? "page-2" : cursor === "page-2" ? "end" : null } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    await mkdir(join(area, "opencode"));
    await host.register(process.pid);
    process.env.XDG_STATE_HOME = area;
    await run(host);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior;
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(area, { recursive: true, force: true });
  }
}

test("V2 plugin without session.list proves terminal lineage through its owning service", async () => registeredHost(async host => {
  const fixture = contextFixture();
  const sessions = {
    ses_coordinator: { id: "ses_coordinator", parentID: "ses_root", agent: "dogs-coordinator", outcome: "succeeded" },
    ses_worker: { id: "ses_worker", parentID: "ses_coordinator", agent: "dog-worker-v010", outcome: "succeeded" },
    ses_reviewer: { id: "ses_reviewer", parentID: "ses_coordinator", agent: "dog-reviewer-v010", outcome: "succeeded" },
  };
  fixture.context.session.get = async ({ sessionID }) => sessions[sessionID as keyof typeof sessions];
  let client: any;
  const cleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    const proof = () => terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "ses_root",
      { operatorSessionID: "ses_coordinator", units: [{ childSessionID: "ses_worker" }] } as never,
      { reserved_units: 0 }, { get: async id => (await client.session.get({ path: { id } })).data,
        children: async id => (await client.session.children({ path: { id } })).data });
    assert.deepEqual(await proof(), ["ses_worker"]);
    const pages = host.requests.filter(url => url.pathname === "/api/session" && url.searchParams.get("parentID") === "ses_coordinator");
    assert.deepEqual(pages.map(url => url.searchParams.get("cursor")), [null, "page-2", "end"]);
    assert.equal(pages[0]!.searchParams.get("order"), "asc");
    assert.equal(pages[1]!.searchParams.get("order"), null);
    sessions.ses_reviewer.outcome = "running";
    await assert.rejects(proof(), /mission-superseded-worker-not-terminal/);
    host.repeated = true;
    await assert.rejects(proof(), /v2-history-cursor-repeated/);
    host.repeated = false; host.malformed = true;
    await assert.rejects(proof());
    host.malformed = false; host.fail = true;
    await assert.rejects(proof());
  } finally { cleanup?.(); }
}));

test("V2 child history refuses missing or foreign service registrations", async () => registeredHost(async host => {
  let client: any;
  const fixture = contextFixture();
  const cleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    host.pid = process.pid + 1;
    await host.register(host.pid);
    await assert.rejects(client.session.children({ path: { id: "ses_parent" } }), /v2-history-owning-service-unavailable/);
    assert.equal(host.requests.some(url => url.pathname === "/api/session"), false);
    await host.noRegistration();
    await assert.rejects(client.session.children({ path: { id: "ses_parent" } }), /v2-history-owning-service-unavailable/);
  } finally { cleanup?.(); }
}));

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
  const registered = fixture.tools[0] as { input: { required: string[]; properties: Record<string, { description?: string }> }; execute(input: unknown, context: unknown): Promise<{ content: string }> };
  assert.deepEqual(registered.input.required, ["required", "optional"]);
  assert.match(registered.input.properties.optional!.description!, /empty string to omit/u);
  assert.equal((await registered.execute({ required: "yes" }, { sessionID: "root", agent: "dog-coordinator-v010" })).content, '{"required":"yes"}');
  assert.equal((await registered.execute({ required: "yes", optional: "" }, { sessionID: "root", agent: "dog-coordinator-v010" })).content, '{"required":"yes"}');
  assert.equal((await registered.execute({ required: "yes", optional: "detail" }, { sessionID: "root", agent: "dog-coordinator-v010" })).content, '{"required":"yes","optional":"detail"}');

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

test("V2 compaction excludes Sortie schemas even when it bypasses the normal context filter", async () => {
  const fixture = contextFixture();
  const cleanup = await V2Plugin.setup(fixture.context);
  try {
    const exposed = Object.fromEntries(fixture.tools.map(tool => [tool.name, tool]));
    const compaction = { sessionID: "build-session", agent: "build", system: [] as unknown[],
      tools: { ...exposed, read: { name: "read" } } };
    assert.ok("sortie_v010_check_contract" in compaction.tools);
    assert.ok("sortie_v010_reflection" in compaction.tools);
    await fixture.sessionHooks.get("compaction")!(compaction);
    assert.deepEqual(Object.keys(compaction.tools), ["read"]);
  } finally { cleanup?.(); }
});

test("V2 Worker can observe status without acquiring Coordinator control tools", async () => {
  const fixture = contextFixture();
  const cleanup = await V2Plugin.setup(fixture.context);
  try {
    const exposed = Object.fromEntries(fixture.tools.map(tool => [tool.name, tool]));
    for (const agent of ["dog-worker-v010", "dog-luna-worker-v010"]) {
      const event = { sessionID: "worker", agent, system: [], tools: { ...exposed, read: {} } };
      await fixture.sessionHooks.get("context")!(event);
      assert.deepEqual(Object.keys(event.tools).sort(), ["read", "sortie_v010_bind_write_gate", "sortie_v010_operator_status", "sortie_v010_release_write_gate"]);
    }
  } finally { cleanup?.(); }
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

test("V2 child prompt uses its role model before the first request but preserves an explicit Task model", async () => {
  const fixture = contextFixture();
  fixture.history.length = 0;
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, parentID: "root", agent: "dog-worker-v010",
    model: { providerID: "openai", id: "gpt-6-sol", variant: "medium" } });
  const plugin = createSortieDogsV2Plugin(async () => ({ "chat.message": async () => {},
    "tool.execute.before": async () => {} }));
  const cleanup = await plugin.setup(fixture.context);
  try {
    await fixture.sessionHooks.get("prompt")!({ sessionID: "child-one", messageID: "user-1",
      prompt: { text: "You are a subagent spawned by another session.\nfirst task" } });
    assert.deepEqual(fixture.modelSwitches, [{ sessionID: "child-one",
      model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } }]);
    await fixture.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "root", id: "call-2",
      input: { agent: "dog-worker-v010", prompt: "explicit task", model: "anthropic/custom#high" } });
    await fixture.sessionHooks.get("prompt")!({ sessionID: "child-two", messageID: "user-2",
      prompt: { text: "You are a subagent spawned by another session.\nexplicit task" } });
    assert.equal(fixture.modelSwitches.length, 1, "explicit subagent model must remain selected by the host");
  } finally { cleanup?.(); }
});

test("V2 six child roles preserve structured defaults and explicit choices through hot and cold resumes", async () => {
  const roles = ["dogs-coordinator", "dog-advisor-v010", "dog-reviewer-v010", "dog-scout-v010", "dog-luna-worker-v010", "dog-worker-v010"];
  for (const role of roles) for (const wrapped of [false, true]) for (const explicit of [false, true]) {
    const fixture = contextFixture();
    fixture.history.length = 0;
    const configured = { providerID: "openai", id: `${role}-configured`, variant: "high" };
    const native = { providerID: "anthropic", id: "user-selected", variant: "max" };
    let selected = { ...native };
    fixture.context.agent!.get = async () => wrapped ? { data: { model: configured } } : { model: configured };
    fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, parentID: "parent", agent: role, model: selected });
    fixture.context.session.switchModel = async input => {
      fixture.modelSwitches.push(input); selected = input.model as typeof selected; return {};
    };
    const legacy: OpenCodePlugin = async () => ({ "tool.execute.before": async () => {},
      "chat.message": async (_input, output) => { output.message.model = { providerID: "legacy", modelID: "forced" }; } });
    let dispose = await createSortieDogsV2Plugin(legacy).setup(fixture.context);
    try {
      const input = { agent: role, prompt: "same request", ...(explicit ? { model: "anthropic/user-selected#max" } : {}) };
      const event = { tool: "subagent", sessionID: "parent", id: "initial-call", input: structuredClone(input) };
      await fixture.toolHooks.get("execute.before")!(event);
      assert.deepEqual(event.input, input, role);
      const prompt = { sessionID: "child", messageID: "initial-user", prompt: { text: "You are a subagent spawned by another session.\nsame request" } };
      await fixture.sessionHooks.get("prompt")!(structuredClone(prompt));
      assert.deepEqual(selected, explicit ? native : configured, `${role}: first prompt`);
      const count = fixture.modelSwitches.length;
      // A user can change the native model after the first turn. A resume is not fresh role selection.
      selected = { ...native };
      fixture.history.push({ id: "prior-user", type: "user", text: "same request" });
      await fixture.sessionHooks.get("prompt")!({ ...prompt, messageID: "hot-user" });
      assert.deepEqual(selected, native, `${role}: hot resume`);
      dispose?.();
      dispose = await createSortieDogsV2Plugin(legacy).setup(fixture.context);
      await fixture.sessionHooks.get("prompt")!({ ...prompt, messageID: "cold-user" });
      assert.deepEqual(selected, native, `${role}: cold resume`);
      assert.equal(fixture.modelSwitches.length, count, `${role}: no resume override`);
    } finally { dispose?.(); }
  }
});

test("V2 primary Operator retains its native model and registry overrides", async () => {
  const fixture = contextFixture();
  const model = { providerID: "anthropic", id: "operator-custom", variant: "high" };
  const configured = { model: { ...model } };
  fixture.context.agent!.transform = async callback => {
    callback({ update: (id, update) => { if (id === "dog-operator") update(configured); } }); return { dispose() {} };
  };
  fixture.context.session.get = async () => ({ id: "root", agent: "dog-operator", model });
  const dispose = await createSortieDogsV2Plugin(async () => ({ "chat.message": async () => {} })).setup(fixture.context);
  try {
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "user", prompt: { text: "original goal" } });
    assert.deepEqual(configured.model, model);
    assert.deepEqual(fixture.modelSwitches, []);
  } finally { dispose?.(); }
});

test("V2 rejected explicit dispatch does not poison a later default-model admission", async () => {
  const fixture = contextFixture(); fixture.history.length = 0;
  fixture.context.session.get = async () => ({ id: "child", parentID: "parent", agent: "dog-worker-v010",
    model: { providerID: "openai", id: "parent-model" } });
  let deny = true;
  const dispose = await createSortieDogsV2Plugin(async () => ({ "chat.message": async () => {},
    "tool.execute.before": async () => { if (deny) throw new Error("admission-denied"); } })).setup(fixture.context);
  try {
    const event = { tool: "subagent", sessionID: "parent", id: "call", input: { agent: "dog-worker-v010", prompt: "same", model: "anthropic/custom#high" } };
    await assert.rejects(async () => fixture.toolHooks.get("execute.before")!(event), /admission-denied/);
    deny = false;
    await fixture.toolHooks.get("execute.before")!({ ...event, input: { agent: "dog-worker-v010", prompt: "same" } });
    await fixture.sessionHooks.get("prompt")!({ sessionID: "child", messageID: "user", prompt: { text: "You are a subagent spawned by another session.\nsame" } });
    assert.equal(fixture.modelSwitches.length, 1);
  } finally { dispose?.(); }
});

test("V2 child model correction fails closed when native context is unavailable", async () => {
  const fixture = contextFixture();
  fixture.context.session.get = async () => ({ id: "child", parentID: "parent", agent: "dog-worker-v010",
    model: { providerID: "anthropic", id: "selected" } });
  fixture.context.session.context = async () => ({ unavailable: true });
  const dispose = await createSortieDogsV2Plugin(async () => ({ "chat.message": async () => {} })).setup(fixture.context);
  try {
    await assert.rejects(async () => fixture.sessionHooks.get("prompt")!({ sessionID: "child", messageID: "user", prompt: { text: "continue" } }),
      /sortie-v010-child-history-unavailable/);
    assert.deepEqual(fixture.modelSwitches, []);
  } finally { dispose?.(); }
});

test("V2 queued explicit selection survives reload before the first context message", async () => {
  const fixture = contextFixture(); fixture.history.length = 0;
  const model = { providerID: "anthropic", id: "explicit", variant: "high" };
  const storage = new Map<string, unknown>([["userKey", "keep"]]);
  fixture.context.session.get = async () => ({ id: "child", parentID: "parent", agent: "dog-reviewer-v010", model });
  const context = { ...fixture.context, storage: { get: async (key: string) => storage.get(key),
    set: async (key: string, value: unknown) => { storage.set(key, value); } } };
  const legacy: OpenCodePlugin = async () => ({ "tool.execute.before": async () => {}, "chat.message": async () => {} });
  let dispose = await createSortieDogsV2Plugin(legacy).setup(context);
  try {
    await fixture.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "parent", id: "call", input: {
      agent: "dog-reviewer-v010", prompt: "queued", model: "anthropic/explicit#high",
    } });
    const prompt = { sessionID: "child", messageID: "user", prompt: { text: "You are a subagent spawned by another session.\nqueued" } };
    await fixture.sessionHooks.get("prompt")!(prompt);
    assert.equal(storage.get("userKey"), "keep");
    dispose?.();
    dispose = await createSortieDogsV2Plugin(legacy).setup(context);
    await fixture.sessionHooks.get("prompt")!(prompt);
    assert.deepEqual(fixture.modelSwitches, []);
  } finally { dispose?.(); }
});

test("V2 status reports the loaded adapter snapshot rather than replacement bytes on disk", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const area = await mkdtemp(resolve("_testenv/v2-loaded-identity-"));
  try {
    await cp(resolve("dist"), join(area, "dist"), { recursive: true });
    const path = join(area, "dist/plugin/v2.js"), bytes = await readFile(path);
    const implementationPath = join(area, "dist/plugin/index.js"), implementationBytes = await readFile(implementationPath);
    const { createSortieDogsV2Plugin: create } = await import(pathToFileURL(path).href);
    const fixture = contextFixture();
    const dispose = await create(async () => ({ tool: { sortie_v010_operator_status: {
      description: "status", args: {}, execute: async () => JSON.stringify({ status: "idle", budget: { consumed_units: 25 } }),
    } } })).setup(fixture.context);
    try {
      await writeFile(path, Buffer.concat([bytes, Buffer.from("\n// replaced after module evaluation\n")]));
      await writeFile(implementationPath, Buffer.concat([implementationBytes, Buffer.from("\n// implementation replacement\n")]));
      const tool = fixture.tools.find(tool => tool.name === "sortie_v010_operator_status") as {
        execute(input: unknown, execution: unknown): Promise<{ content: string }>; };
      const packet = JSON.parse((await tool.execute({}, { sessionID: "root" })).content);
      assert.equal(packet.status, "idle");
      assert.equal(packet.budget.consumed_units, 25);
      assert.equal(packet.runtime.adapter_url, pathToFileURL(path).href);
      assert.equal(packet.runtime.adapter_sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.notEqual(packet.runtime.adapter_sha256, createHash("sha256").update(await readFile(path)).digest("hex"));
      assert.equal(packet.runtime.implementation_sha256["index.js"], createHash("sha256").update(implementationBytes).digest("hex"));
      assert.notEqual(packet.runtime.implementation_sha256["index.js"], createHash("sha256").update(await readFile(implementationPath)).digest("hex"));
      assert.equal(typeof packet.runtime.runtime_asset_version, "string");
      assert.equal(packet.runtime.pid, process.pid);
      assert.equal(packet.runtime.host_version, fixture.context.app!.version);
    } finally { dispose?.(); }
  } finally { await rm(area, { recursive: true, force: true }); }
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
    fixture.failNextContext();
    await fixture.emit({ type: "session.execution.succeeded", data: { sessionID: "root" } });
    await fixture.emit({ type: "session.idle", data: { sessionID: "root" } });
    await fixture.emit({ type: "session.compaction.ended", data: { sessionID: "root" } });
    await fixture.emit({ type: "filesystem.changed", data: { file: "changed.txt", event: "change" } });
    assert.equal(fixture.synthetic.length, 0);
    assert.ok(warnings.some(values => values[0] === "[sortie-dogs-v010] V2 event handling failed" && values[1] === "context unavailable"));
    assert.equal(warnings.filter(values => values[0] === "[sortie-dogs-v010] V2 event handling failed").length, 2);
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

test("the package name installed by init resolves to the V2 plugin definition", async () => {
  const entry = await import("sortie-dogs");
  assert.equal(entry.default.id, V2Plugin.id);
  assert.equal(entry.default.setup, V2Plugin.setup);
  assert.equal(typeof entry.SortieDogsPlugin, "function");
  const fixture = contextFixture();
  const cleanup = await entry.default.setup(fixture.context);
  try {
    assert.ok(fixture.tools.some(tool => (tool as { name?: string }).name === "sortie_v010_start_mission"));
  } finally { cleanup?.(); }
});

test("the package plugin entry chosen by OpenCode V2 exports a default definition", async () => {
  const entry = await import("sortie-dogs/plugin");
  assert.equal(entry.default.id, "sortie-dogs.v010");
  assert.equal(typeof entry.default.setup, "function");
  assert.equal(typeof entry.SortieDogsPlugin, "function");
  const fixture = contextFixture();
  const cleanup = await entry.default.setup(fixture.context);
  try {
    assert.ok(fixture.tools.some(tool => (tool as { name?: string }).name === "sortie_v010_start_mission"));
  } finally { cleanup?.(); }
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
    const revise = tools.find(tool => tool.name === "sortie_v010_revise_operator_proposal")!;
    const check = tools.find(tool => tool.name === "sortie_v010_check_contract")!;
    assert.deepEqual(prepare.input.required, ["plan_json"]);
    assert.match(prepare.input.properties.plan_json!.description!, /plan_json must encode the exact operator plan object/u);
    assert.deepEqual(cancel.input.required, ["reason"]);
    assert.deepEqual(begin.input.required, ["intent_json"]);
    assert.deepEqual(revise.input.required, ["revision_json"]);
    assert.match(revise.input.properties.revision_json!.description!, /proposal_id:string,revision:positive integer,content_hash:string/);
    assert.match(revise.input.properties.revision_json!.description!, /No reads or execution units are granted or restored/);
    assert.match(begin.input.properties.intent_json!.description!, /intent_json must encode exactly this JSON object/u);
    assert.deepEqual(check.input.required, ["handoff_path", "task_prompt"]);
    const expand = tools.find(tool => tool.name === "sortie_v010_expand_unit")!;
    const shape = expand.input.properties.paths as { minItems: number; maxItems: number; items: { minLength: number; maxLength: number } };
    assert.deepEqual([shape.minItems, shape.maxItems, shape.items.minLength, shape.items.maxLength], [0, 4096, 0, 65535]);
    const reflection = tools.find(tool => tool.name === "sortie_v010_reflection")!;
    assert.deepEqual(reflection.input.required, Object.keys(reflection.input.properties));
    assert.match(reflection.input.properties.scope!.description!, /empty string to omit/u);
    for (const tool of tools) assert.deepEqual(tool.input.required, Object.keys(tool.input.properties), `${tool.name} cannot expose optional top-level properties`);
    for (const tool of tools) {
      const numeric = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, entry] of Object.entries(value)) {
          if (["minLength", "maxLength", "minItems", "maxItems"].includes(key)) assert.ok(Number.isInteger(entry), `${tool.name}.${key} must be an integer`);
          numeric(entry);
        }
      };
      numeric(tool.input);
    }
    const modelTools = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    modelTools.read = { name: "read" };
    await fixture.sessionHooks.get("context")!({ sessionID: "ordinary-build", agent: "build", system: [], tools: modelTools });
    assert.deepEqual(Object.keys(modelTools), ["read"], "non-Sortie agents cannot receive registered Sortie tool schemas");
    const missionTools = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    await fixture.sessionHooks.get("context")!({ sessionID: "mission-root", agent: "dog-operator", system: [], tools: missionTools });
    assert.ok(missionTools.sortie_v010_expand_unit);
    assert.equal(missionTools.sortie_v010_approve_operator_proposal, undefined);
  } finally {
    cleanup?.();
  }
});

test("V2 lowers installed V1 Zod optional strings before provider submission and restores omission on execution", async () => {
  const fixture = contextFixture();
  const seen: Record<string, string>[] = [];
  // With @opencode-ai/plugin installed, V1's tool.schema.string().optional()
  // exposes Zod's enumerable def and reports type="optional" on the value.
  const required = { "~standard": { vendor: "zod", version: 1 }, def: { type: "string" }, type: "string",
    minLength: null, maxLength: null };
  const optional = { "~standard": { vendor: "zod", version: 1 }, def: { type: "optional", innerType: required },
    type: "optional" };
  const cleanup = await createSortieDogsV2Plugin(async () => ({ tool: {
    sortie_v010_reflection: { description: "reflection", args: { action: required, scope: optional },
      execute: async args => { seen.push(args); return "done"; } },
  } })).setup(fixture.context);
  try {
    const tool = fixture.tools.find(value => value.name === "sortie_v010_reflection") as {
      input: { properties: Record<string, unknown>; required: string[] };
      execute: (input: Record<string, string>, execution: { sessionID: string }) => Promise<unknown>;
    };
    assert.deepEqual(tool.input.required, ["action", "scope"]);
    assert.deepEqual(tool.input.properties.action, { type: "string", minLength: 0, maxLength: 65535 });
    assert.deepEqual(tool.input.properties.scope, { type: "string", minLength: 0, maxLength: 65535,
      description: "Pass an empty string to omit this argument." });
    await tool.execute({ action: "record", scope: "" }, { sessionID: "root" });
    assert.deepEqual(seen, [{ action: "record" }]);
  } finally { cleanup?.(); }
});
