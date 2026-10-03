import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";

import V2Plugin, {
  createSortieDogsV2Plugin,
  createV2ReturnReportFinalizer,
  type OpenCodeV2Context,
} from "../dist/plugin/v2.js";
import type { OpenCodeHooks, OpenCodePlugin } from "../dist/plugin/index.js";
import { collectRunMetrics } from "../dist/plugin/run-metrics.js";
import { buildDebrief, renderDebrief } from "../dist/plugin/sortie-debrief.js";
import { SortieDogsV010Plugin, terminalCancelledMissionChildren } from "../dist/plugin/profiled.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { missionProgressReader } from "../dist/plugin/mission-progress.js";
import { completedMissionReviewPrompts, observedMissionValidation } from "../dist/plugin/mission-review.js";
import { runtimeAssets } from "../dist/runtime-assets-v010.js";

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
    storage: (() => { const state = new Map<string, unknown>(); return {
      get: async (key: string) => structuredClone(state.get(key)),
      set: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); },
      remove: async (key: string) => { state.delete(key); },
    }; })(),
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

test("generated Mission Worker assets expose same-Task scope repair, not Coordinator controls", () => {
  for (const name of ["dog-worker-v010", "dog-luna-worker-v010"]) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.match(content, /sortie_v010_expand_unit: allow/);
    assert.match(content, /sortie_v010_expand_unit: true/);
    assert.doesNotMatch(content, /sortie_v010_(?:plan_units|complete_mission|cancel_operator): true/);
  }
});

test("V2 optional condition objects admit omission without manufacturing provenance or erasing fixed facts", async () => {
  const fixture = contextFixture();
  const received: unknown[] = [];
  const cleanup = await createSortieDogsV2Plugin(async () => ({ tool: { sortie_v010_conditions: {
    description: "condition fixture", args: { confirmed_conditions: { type: "object", "x-sortie-optional": true,
      required: ["source", "applies_to"], properties: { source: { type: "string" }, applies_to: { type: "string" } } } as never },
    execute: async args => { received.push(args); return JSON.stringify(args); },
  } } })).setup(fixture.context);
  try {
    const tool = fixture.tools.find(item => item.name === "sortie_v010_conditions") as any;
    assert.equal(tool.input.properties.confirmed_conditions.anyOf[0].type, "object");
    assert.deepEqual(tool.input.properties.confirmed_conditions.anyOf[1].enum, [""]);
    for (const confirmed_conditions of ["", {}, { source: "", applies_to: "" }]) await tool.execute({ confirmed_conditions }, { sessionID: "root" });
    const meaningful = { source: "User", applies_to: "original run" };
    await tool.execute({ confirmed_conditions: meaningful }, { sessionID: "root" });
    const invalid = { source: "", applies_to: "run", timeout_seconds: 0 };
    await tool.execute({ confirmed_conditions: invalid }, { sessionID: "root" });
    assert.deepEqual(received, [{}, {}, {}, { confirmed_conditions: meaningful }, { confirmed_conditions: invalid }]);
  } finally { cleanup?.(); }
});

test("V2 volatile host state is a current system update after history, not a changing absolute prefix", async () => {
  const fixture = contextFixture();
  let phase = 0;
  const live = () => [
    `SORTIE_GOAL_BOUND_STATE\n${JSON.stringify({ revision: phase, consumed_units: phase, receipt: phase === 2 ? { status: "succeeded" } : null })}`,
    `SORTIE_ACCEPTANCE_CONTINUITY_STATE\n${JSON.stringify({ latest_accepted_task_id: `task-${phase}` })}`,
    `SORTIE_PARALLEL_DISPATCH_STATE\n${JSON.stringify({ sequence: phase })}`,
    ...(phase === 0 ? [] : [`SORTIE_REVIEWER_CONTINUOUS_CONTEXT\n${JSON.stringify({ findings: phase === 1 ? "Medium one" : "Medium one\nAdditional Medium two", validation: ["go test ./..."], write: ["vm/**"] })}`]),
  ];
  const messages = [
    { role: "user", content: [{ type: "text", text: "Original requirements unchanged" }] },
    { role: "assistant", content: [{ type: "tool-call", id: "check", name: "shell", input: { command: "go test ./..." } }] },
    { role: "tool", content: [{ type: "tool-result", id: "check", name: "shell", result: { type: "json", value: { exit: 0, evidence: "sha256:check" } } }] },
    { role: "assistant", content: [{ type: "compaction", provider: "openai", encrypted: "native-checkpoint" }] },
    // A foreign system message with similar metadata must not be removed or mistaken for our projection.
    { role: "system", metadata: { "sortie-dogs/live-state": "request-only" }, content: [{ type: "text", text: "Another plugin's instruction" }] },
  ];
  const original = structuredClone(messages);
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async (_input, output) => { output.system = ["STATIC_POLICY", ...live(), "OTHER_STATIC_POLICY"]; },
  })).setup(fixture.context);
  try {
    for (phase = 0; phase < 3; phase++) {
      const event = { sessionID: "root", agent: "dog-operator", system: [{ type: "text", text: "NATIVE_PREFIX" }], messages, tools: {} };
      await fixture.sessionHooks.get("context")!(event);
      assert.deepEqual(event.system, ["NATIVE_PREFIX", "STATIC_POLICY", "OTHER_STATIC_POLICY"].map(text => ({ type: "text", text })), "state addition/change does not rewrite the prefix");
      assert.deepEqual(event.messages.slice(0, messages.length), messages, "history and native call/result pairs are intact");
      for (let i = 0; i < messages.length; i++) assert.equal(event.messages[i], messages[i]);
      const update = event.messages.at(-1)!;
      assert.equal(update.role, "system", "state does not become user input or a fabricated tool result");
      assert.deepEqual(update.content, live().map(text => ({ type: "text", text })), "every current field and retained finding is supplied verbatim");
      assert.deepEqual(messages, original, "request projection never mutates saved history");
      const once = structuredClone(event.messages);
      await fixture.sessionHooks.get("context")!(event);
      assert.deepEqual(event.messages, once, "reentrant projection does not accumulate unchanged state updates");
    }
    const legacy = { sessionID: "root", system: [] };
    await fixture.sessionHooks.get("context")!(legacy);
    assert(JSON.stringify(legacy.system).includes("SORTIE_GOAL_BOUND_STATE"), "a host without message projection retains state in system rather than losing it");
  } finally { cleanup?.(); }
});

test("V2 live-state boundaries persist across native turns and cold reload without cross-session state or evidence writes", async () => {
  const fixture = contextFixture();
  const systems = new Map([
    ["root", ["STATIC_ROLE", "SORTIE_WORKER_CONTEXT\noriginal assignment"]],
    ["other", ["STATIC_ROLE", "SORTIE_WORKER_CONTEXT\nother assignment"]],
  ]);
  const factory: OpenCodePlugin = async () => ({
    "experimental.chat.system.transform": async (input, output) => { output.system = systems.get(input.sessionID)!; },
  });
  let cleanup = await createSortieDogsV2Plugin(factory).setup(fixture.context);
  const user = { role: "user", content: [{ type: "text", text: "Original task" }] };
  const native = [user, { role: "assistant", content: [{ type: "text", text: "Native investigation" }] }];
  const event = (id: string, messages: unknown[]) => ({ sessionID: id, agent: "dog-worker-v010", system: [], messages, tools: {} });
  try {
    const first = event("root", [user]);
    await fixture.sessionHooks.get("context")!(first);
    const next = event("root", native);
    await fixture.sessionHooks.get("context")!(next);
    assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
    assert.equal(next.messages.at(-1), native.at(-1), "unchanged state does not move behind new native history");
    cleanup?.();
    const coldFixture = contextFixture();
    const coldContext = { ...coldFixture.context, storage: fixture.context.storage };
    cleanup = await createSortieDogsV2Plugin(factory).setup(coldContext);
    const cold = event("root", [...native, { role: "tool", content: [{ type: "text", text: "actual outcome" }] }]);
    await coldFixture.sessionHooks.get("context")!(cold);
    assert.deepEqual(cold.messages.slice(0, next.messages.length), next.messages, "cold restore uses durable projection boundaries");
    const other = event("other", [user]);
    await coldFixture.sessionHooks.get("context")!(other);
    assert(!JSON.stringify(other.messages).includes("original assignment"));
    await coldFixture.emit({ type: "session.deleted", data: { sessionID: "root" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(await fixture.context.storage!.get("v2-model-live-state:root"), undefined);
    assert.equal(fixture.synthetic.length, 0, "request projection never persists a synthetic outcome or new prompt");
    assert.equal(coldFixture.synthetic.length, 0);
  } finally { cleanup?.(); }
});

test("V2 cache-ledger storage failure preserves current state and in-process append continuity instead of blocking work", async () => {
  const fixture = contextFixture();
  const storage = fixture.context.storage!, get = storage.get, set = storage.set;
  storage.get = async key => { if (key.startsWith("v2-model-live-state:")) throw new Error("cache ledger unavailable"); return get(key); };
  storage.set = async (key, value) => { if (key.startsWith("v2-model-live-state:")) throw new Error("cache ledger unavailable"); return set(key, value); };
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async (_input, output) => { output.system = ["STATIC_ROLE", "SORTIE_WORKER_CONTEXT\noriginal assignment"]; },
  })).setup(fixture.context);
  try {
    const user = { role: "user", content: [{ type: "text", text: "Original task" }] };
    const first = { sessionID: "root", system: [], messages: [user], tools: {} };
    await fixture.sessionHooks.get("context")!(first);
    const second = { sessionID: "root", system: [], messages: [user, { role: "assistant", content: [{ type: "text", text: "Native progress" }] }], tools: {} };
    await fixture.sessionHooks.get("context")!(second);
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert(JSON.stringify(second.messages).includes("original assignment"));
  } finally { cleanup?.(); }
});

test("Reviewer model tool order keeps genuine read-only definitions as a deterministic prefix across correction admission", async () => {
  const fixture = contextFixture();
  let correcting = false;
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "dog-reviewer-v010",
    model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } });
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async (_input, output) => { output.system = ["STATIC_REVIEWER_ROLE"]; },
    reviewerCorrectionScope: async () => correcting ? { write: ["vm/**"], validation: ["go test ./..."], generation: 1 } : undefined,
  })).setup(fixture.context);
  const names = ["glob", "grep", "patch", "read", "shell", "skill", "sortie_v010_bind_write_gate",
    "sortie_v010_finish_direct_unit", "sortie_v010_operator_status", "sortie_v010_release_write_gate",
    "sortie_v010_repair_review", "websearch", "execute"];
  const definitions = Object.fromEntries(names.map(name => [name, { description: name, input: { type: "object", properties: {} } }]));
  const event = (agent: string, order = names) => ({ sessionID: "review-author", agent, system: [], messages: [],
    tools: Object.fromEntries(order.map(name => [name, definitions[name]])) });
  try {
    const initial = event("dog-reviewer-v010");
    await fixture.sessionHooks.get("context")!(initial);
    for (const forbidden of ["patch", "shell", "sortie_v010_bind_write_gate", "sortie_v010_finish_direct_unit", "sortie_v010_operator_status", "sortie_v010_release_write_gate"]) {
      assert(!Object.hasOwn(initial.tools, forbidden), `${forbidden} is not advertised before real correction admission`);
    }
    correcting = true;
    const corrected = event("dog-reviewer-correction-v010-0123456789abcdef");
    await fixture.sessionHooks.get("context")!(corrected);
    assert.deepEqual(Object.keys(corrected.tools).slice(0, Object.keys(initial.tools).length), Object.keys(initial.tools),
      "newly authorized tools append after every initial Reviewer definition rather than interleaving");
    assert.deepEqual(Object.keys(corrected.tools).toSorted(), names.toSorted(), "same genuine tool set, no invented hidden executor");
    for (const name of names) assert.equal(corrected.tools[name], definitions[name], "native definition/executor binding identity preserved");
    const shuffled = event("dog-reviewer-correction-v010-0123456789abcdef", [...names].reverse());
    await fixture.sessionHooks.get("context")!(shuffled);
    assert.deepEqual(Object.keys(shuffled.tools), Object.keys(corrected.tools), "same role/tool set has deterministic order independent of registry insertion");
    correcting = false;
    const restored = event("dog-reviewer-v010", [...names].reverse());
    await fixture.sessionHooks.get("context")!(restored);
    assert.deepEqual(Object.keys(restored.tools), Object.keys(initial.tools), "restored read-only role never keeps correction tools for cache");
    assert.equal(fixture.synthetic.length, 0);
  } finally { cleanup?.(); }
});

test("Reviewer model tool order never changes other agents' native tool set or insertion order", async () => {
  const fixture = contextFixture();
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async (_input, output) => { output.system = ["STATIC_ROLE"]; },
  })).setup(fixture.context);
  try {
    for (const agent of ["build", "dog-worker-v010", "dog-operator"]) {
      const definitions = { shell: { description: "shell" }, read: { description: "read" }, patch: { description: "patch" }, execute: { description: "execute" } };
      const event = { sessionID: agent, agent, system: [], messages: [], tools: { ...definitions } };
      await fixture.sessionHooks.get("context")!(event);
      assert.deepEqual(Object.keys(event.tools), Object.keys(definitions));
      for (const name of Object.keys(definitions)) assert.equal(event.tools[name as keyof typeof definitions], definitions[name as keyof typeof definitions]);
    }
  } finally { cleanup?.(); }
});

test("V2 model context omits only the retained completion card, preserving receipt and native history", async () => {
  const fixture = contextFixture();
  const card = "<details>\n<summary><strong>🐾 SORTIE DOGS — 帰還報告</strong></summary>\n\nfull host metrics\n\n</details>";
  const packet = { status: "succeeded", run_id: "run", acceptance_fingerprint: "sha256:accepted",
    receipt: { status: "succeeded", goal_id: "goal", evidence_refs: ["sha256:check"] },
    limitations: ["unknown usage"], return_report: card, return_report_instruction: "do not transcribe" };
  const result = (name: string, value: unknown) => ({ type: "tool-result", id: name, name, result: value,
    metadata: { keep: true }, providerMetadata: { openai: { keep: true } } });
  const file = { type: "file", uri: "file:///saved-evidence", mime: "text/plain" };
  const messages = [
    { role: "user", content: [{ type: "text", text: JSON.stringify(packet) }] },
    { role: "assistant", content: [{ type: "text", text: card }] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "text", value: JSON.stringify(packet) })] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "json", value: packet })] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "content", value: [{ type: "text", text: JSON.stringify(packet) }, file] })] },
    { role: "tool", content: [result("other_tool", { type: "text", value: JSON.stringify(packet) })] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "error", value: JSON.stringify(packet) })] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "text", value: "malformed {" })] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "json", value: { ...packet, status: "blocked" } })] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "json", value: { ...packet, receipt: { status: "failed" } } })] },
    { role: "tool", content: [result("sortie_v010_complete_mission", { type: "json", value: { ...packet, return_report: "non-card evidence" } })] },
  ];
  const original = structuredClone(messages);
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async () => {}, "experimental.session.compacting": async () => {},
  })).setup(fixture.context);
  try {
    for (const hook of ["context", "compaction"]) {
      const event = { sessionID: "root", agent: "dog-operator", system: [], messages, tools: {} };
      await fixture.sessionHooks.get(hook)!(event);
      assert.deepEqual(messages, original, "projection never changes saved messages or packet objects");
      for (const index of [2, 3, 4]) {
        const part = event.messages[index].content[0] as any;
        const projected = part.result.type === "json" ? part.result.value
          : JSON.parse(part.result.type === "text" ? part.result.value : part.result.value[0].text);
        const { return_report: _card, ...preserved } = packet;
        assert.deepEqual(projected, { ...preserved, return_report_retained: projected.return_report_retained });
        assert.match(projected.return_report_retained, /saved in this tool result/);
        assert.equal(projected.return_report, undefined);
        assert.deepEqual(part.metadata, { keep: true });
        assert.deepEqual(part.providerMetadata, { openai: { keep: true } });
        assert.equal(Object.getPrototypeOf(event.messages[index]), Object.getPrototypeOf(messages[index]));
      }
      assert.equal((event.messages[4].content[0] as any).result.value[1], file);
      for (const index of [0, 1, 5, 6, 7, 8, 9, 10]) assert.equal(event.messages[index], messages[index]);
      const once = JSON.stringify(event.messages);
      await fixture.sessionHooks.get(hook)!(event);
      assert.equal(JSON.stringify(event.messages), once, "projection is idempotent");
    }
  } finally { cleanup?.(); }
});

test("V2 native shell results retain build→test exits and timestamps through the Review history adapter", async () => {
  const fixture = contextFixture();
  const tool = (id: string, command: string, ran: number, completed: number) => ({ type: "tool", id, name: "shell",
    state: { status: "completed", input: { command }, content: [], metadata: { status: "completed", exit: 0 } },
    time: { created: ran - 1, ran, completed } });
  fixture.history.push({ id: "msg_worker", type: "assistant", agent: "dog-worker-v010", content: [
    tool("call_build", "npm run build", 100, 200), tool("call_test", "node check.mjs", 250, 300),
  ], time: { created: 99, completed: 301 } });
  let client: any;
  const cleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    const history = (await client.session.messages({ path: { id: "worker" } })).data;
    assert.deepEqual(observedMissionValidation(["npm run build", "node check.mjs"], "worker", history), {
      attempts: [
        { command: "npm run build", exit_code: 0, started_ms: 100, completed_ms: 200 },
        { command: "node check.mjs", exit_code: 0, started_ms: 250, completed_ms: 300 },
      ], not_observed: [], omitted_attempts: 0,
    });
  } finally { cleanup?.(); }
});

for (const { legacy, commit, cancel } of [{ legacy: false, commit: false, cancel: false },
  { legacy: true, commit: false, cancel: false }, { legacy: false, commit: true, cancel: false },
  { legacy: false, commit: false, cancel: true }])
test(`V2 ${cancel ? "cancelled Worker cannot reactivate" : commit ? "auto-bound commit and independent review" : legacy ? "saved absolute" : "relative"} mission controls survive Operator correction and cold resume`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/swebench-night-long-project-root-"));
  const exec = promisify(execFile);
  const history: Record<string, Record<string, unknown>[]> = {};
  const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
    root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    first: { agent: "dog-worker-v010", parentID: "coordinator" }, second: { agent: "dog-worker-v010", parentID: "coordinator" },
    reviewer: { agent: "dog-reviewer-v010", parentID: "coordinator" },
    unrelated: { agent: "build", parentID: "root" },
  };
  let fixture = contextFixture(), cleanup: (() => void) | void, counter = 0;
  let projectionRace: { path: string; source: string } | undefined;
  const start = async () => {
    fixture = contextFixture();
    cleanup = await createSortieDogsV2Plugin(async (input, options) => {
      const hooks = await SortieDogsV010Plugin(input, options);
      const after = hooks["tool.execute.after"];
      hooks["tool.execute.after"] = async (request, output) => {
        if (projectionRace && request.tool === "read" && request.nativeReadHash) {
          const race = projectionRace; projectionRace = undefined;
          await writeFile(race.path, race.source);
        }
        await after?.(request, output);
      };
      return hooks;
    }).setup({ ...fixture.context, location: { directory },
      session: { ...fixture.context.session,
        list: async ({ parentID }) => ({ data: Object.entries(agents).filter(([, info]) => info.parentID === parentID)
          .map(([id, info]) => ({ id, ...info })), cursor: { next: null } }),
        get: async ({ sessionID }) => ({ id: sessionID, ...agents[sessionID], model: { providerID: "openai",
          id: agents[sessionID]?.agent === "dog-worker-v010" ? "gpt-6-luna-fast" : "gpt-6-sol", variant: "max" } }),
        context: async ({ sessionID }) => history[sessionID] ?? [],
      } });
  };
  const prompt = async (sessionID: string, text: string) => {
    const messageID = `msg_${++counter}`;
    const event = { sessionID, messageID, prompt: { text: sessionID === "root" ? text : `You are a subagent spawned by another session.\n${text}` } };
    await fixture.sessionHooks.get("prompt")!(event);
    (history[sessionID] ??= []).push({ id: messageID, type: "user", text: event.prompt.text, time: { created: Date.now() } });
    return event.prompt.text;
  };
  const before = async (sessionID: string, tool: string, input: Record<string, unknown>) => {
    const event = { sessionID, agent: agents[sessionID]!.agent, tool, id: `call_${++counter}`, input };
    await fixture.toolHooks.get("execute.before")!(event);
    return event;
  };
  const after = async (event: Record<string, unknown>, content: string, metadata: Record<string, unknown> = {}) => {
    const sessionID = String(event.sessionID), now = Date.now();
    (history[sessionID] ??= []).push({ id: `msg_${++counter}`, type: "assistant", agent: agents[sessionID]!.agent,
      finish: "tool-calls", time: { created: now, completed: now }, content: [{ type: "tool", name: event.tool, id: event.id,
        state: { status: "completed", input: event.input, content: [{ type: "text", text: content }], metadata },
        time: { created: now, ran: now, completed: now } }] });
    const completed = { ...event, status: "completed", result: { content, metadata } };
    await fixture.toolHooks.get("execute.after")!(completed);
    return completed.result.content;
  };
  const tool = async (sessionID: string, name: string, input: Record<string, unknown> = {}) => {
    const fullName = `sortie_v010_${name}`;
    const event = await before(sessionID, fullName, input);
    const definition = fixture.tools.find(tool => tool.name === fullName) as { execute(input: unknown, context: unknown): Promise<{ content: string }> };
    const result = await definition.execute(event.input, { sessionID, agent: agents[sessionID]!.agent });
    await after(event, result.content);
    return JSON.parse(result.content);
  };
  const nativeTask = (task: Record<string, unknown>) => ({ agent: task.subagent_type, prompt: task.prompt,
    description: task.description, ...(task.task_id ? { sessionID: task.task_id } : {}) });
  try {
    assert.notEqual(directory, process.cwd(), "control resolution must use the Location, not the service cwd");
    await exec("git", ["init", "--quiet", "--initial-branch=base"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"), 'import assert from "node:assert/strict";\nimport {readFileSync} from "node:fs";\n' +
      'const value = readFileSync("result.txt", "utf8");\nassert.ok(value.length);\nif (process.argv[2] === "ready") assert.equal(value, "ready\\n");\nconsole.log("PASS");\n');
    await start();
    if (commit) {
      await exec("git", ["config", "user.name", "Fixture User"], { cwd: directory });
      await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: directory });
      await writeFile(join(directory, ".gitignore"), ".sortie-dogs-v010/\n");
      await exec("git", ["add", ".gitignore", "check.mjs"], { cwd: directory });
      await exec("git", ["commit", "-m", "fixture base"], { cwd: directory });
    }
    const original = `Create result.txt containing ready, and ${commit ? "commit the change" : "leave an uncommitted diff"}.`;
    const objective = `${original} Keep this example text verbatim: handoff_path: /external/example.json`;
    await prompt("root", original);
    const mission = await tool("root", "start_mission", { requirements: [original] });
    let dispatch = await before("root", "subagent", nativeTask(mission.task));
    await prompt("coordinator", String(dispatch.input.prompt));
    let firstRun: string | undefined;
    let budget: { max_units: number; consumed_units: number } | undefined;
    let retiredHandoff: string | undefined;
    for (const [index, child] of (commit ? ["first"] : ["first", "second"]).entries()) {
      const finalCandidate = commit || index === 1;
      const command = `node check.mjs ${finalCandidate ? "ready" : "present"}`;
      const plan = await tool("coordinator", "plan_units", { units: [{ title: "Write result", objective,
        read: ["check.mjs"], write: ["result.txt"], validation: [command] }],
        ...(index === 1 ? { reason: "Operator rejected the partial output; preserve the original requirement and correct it" } : {}) });
      let runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
      let state = await runtime.required("root");
      let task = nativeTask(plan.task);
      if (legacy && index === 0) {
        // Recreate a pre-change saved mission, including its exact old Task reference/hash.
        state.units[0]!.task.prompt = state.units[0]!.task.prompt.replace(/^(handoff_path|goal_declaration_path): (.+)$/gm,
          (_line, name: string, path: string) => `${name}: ${resolve(directory, path)}`)
          .replace(/^acceptance: handoff\..*\nvalidation: handoff\.verification\n/m, "")
          .replace("contract_reference: handoff\n", `acceptance:\n  - ${original}\nvalidation:\n  - ${command}\n`) + `\n${objective}`;
        const file = join(directory, ".sortie-dogs-v010/operators", `${createHash("sha256").update("root").digest("hex")}.json`);
        await writeFile(file, JSON.stringify(state));
        runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
        task = nativeTask(runtime.nextWorkerTask(await runtime.required("root")) as unknown as Record<string, unknown>);
        cleanup?.(); await start();
      }
      const unit = state.units[0]!;
      if (retiredHandoff) {
        const stale = await after({ sessionID: "first", tool: "read", id: `call_${++counter}`, input: { path: retiredHandoff } },
          await readFile(resolve(directory, retiredHandoff), "utf8"));
        assert.doesNotMatch(stale, /SORTIE_WORKER_ACTIVATION/, "old child cannot activate the replanned Mission grant");
      }
      if (index === 0) firstRun = state.runID;
      else { assert.notEqual(state.runID, firstRun); assert.deepEqual(state.acceptance, [original]); }
      const reference = task.prompt;
      const manifestTime = new Date();
      await utimes(unit.manifestPath, manifestTime, manifestTime);
      const worker = await before("coordinator", "subagent", task);
      assert.equal(worker.input.prompt, reference, "native delegation keeps the exact opaque reference");
      const expanded = await prompt(child, String(reference));
      if (legacy && index === 0) assert.ok(expanded.endsWith(objective), "legacy projection must not rewrite task data below the generated header");
      else assert.ok(!expanded.includes(objective), "new Mission Tasks use the existing required handoff, not a repeated objective");
      const handoff = /^handoff_path: (.+)$/m.exec(expanded)![1]!;
      const declaration = /^goal_declaration_path: (.+)$/m.exec(expanded)![1]!;
      assert.equal(isAbsolute(handoff), false);
      assert.equal(isAbsolute(declaration), false);
      assert.equal(resolve(directory, handoff), unit.handoffPath);
      assert.equal(JSON.parse(await readFile(resolve(directory, declaration), "utf8")).delivery_intent, "implementation");
      // V2 native read(path) reaches the shared engine as filePath without rewriting its target.
      const read = await before(child, "read", { path: handoff, limit: 2000 });
      assert.equal(read.input.path, handoff);
      const handoffSource = await readFile(resolve(directory, String(read.input.path)), "utf8");
      assert.equal(JSON.parse(handoffSource).task.objective, objective, "original objective and embedded example remain verbatim");
      if (!legacy && !commit && index === 0) {
        const unrelated = await after({ sessionID: "unrelated", tool: "read", id: `call_${++counter}`, input: { path: handoff } }, handoffSource);
        assert.doesNotMatch(unrelated, /SORTIE_WORKER_ACTIVATION/, "an unrelated native child cannot use a Mission grant");
        const retainedBinding = async () => assert.equal((await tool(child, "expand_unit", {
          unit_id: unit.unit.id, paths: ["result.txt"], reason: "Observe whether a binding exists",
        })).status, "scope-updated", "Read failure/partial content does not revoke the exact already-claimed admission");
        for (const status of ["error", "cancelled"]) {
          const failed = { ...read, status, result: { content: "read failed" } };
          await fixture.toolHooks.get("execute.after")!(failed);
          assert.equal(failed.result.content, "read failed");
          await retainedBinding();
        }
        for (const args of [{ path: handoff, offset: 2, limit: 1 }, { path: "check.mjs" }]) {
          const partial = await before(child, "read", args);
          const content = await after(partial, "partial / unrelated content");
          assert.doesNotMatch(content, /SORTIE_WORKER_ACTIVATION/);
          await retainedBinding();
        }
        // The exact view and inspection must not activate a different registered identity.
        const changed = JSON.parse(handoffSource);
        changed.task.objective += " changed after native read";
        await writeFile(unit.handoffPath, JSON.stringify(changed));
        const raced = await after(read, handoffSource);
        assert.match(raced, /SORTIE_WORKER_ACTIVATION: .*"status":"denied".*"reason":"handoff-mismatch"/);
        await writeFile(unit.handoffPath, handoffSource);
        const manifestSource = await readFile(unit.manifestPath, "utf8");
        const changedManifest = JSON.parse(manifestSource);
        changedManifest.write.push("unregistered.txt");
        await writeFile(unit.manifestPath, JSON.stringify(changedManifest));
        const manifestRace = await after(read, handoffSource);
        assert.match(manifestRace, /"status":"denied".*"reason":"binding-replay"/,
          "native Read cannot activate a different manifest than the admitted grant");
        await writeFile(unit.manifestPath, manifestSource);
        // Restore this fixture's exact original pin as well as its bytes after the tamper test.
        // Production still refuses changed mtime; no in-flight reservation/adapter is replaced.
        await utimes(unit.manifestPath, manifestTime, manifestTime);
        projectionRace = { path: unit.handoffPath, source: JSON.stringify(changed) };
        const snapshotRace = await after(read, handoffSource);
        assert.match(snapshotRace, /"status":"denied"/);
        assert.match(snapshotRace, /handoff_read_identity_changed/,
          "a change between exact view and core inspection must not bind a different identity");
        assert.ok(snapshotRace.includes(objective), "the returned exact view is the observed snapshot, not the changed source");
        await writeFile(unit.handoffPath, handoffSource);
      }
      const ready = await after(read, handoffSource);
      assert.match(ready, /SORTIE_EXACT_CONTRACT_VIEW/);
      assert.match(ready, /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/);
      assert.ok(ready.includes(objective), "host activation must retain the original exact view");
      if (cancel) {
        agents[child]!.outcome = "interrupted";
        await tool("root", "cancel_operator", { reason: "Cancel the current fixture Worker" });
        const cancelledRead = await after(read, handoffSource);
        assert.doesNotMatch(cancelledRead, /SORTIE_WORKER_ACTIVATION/,
          "a successful delayed Read after real cancellation cannot reactivate the old grant");
        assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).phase, "cancelled");
        return;
      }
      const manifest = /^operation_manifest: (.+)$/m.exec(expanded)![1]!;
      const reread = async () => after(await before(child, "read", { path: handoff }), await readFile(unit.handoffPath, "utf8"));
      if (legacy || !commit && index === 0) {
        const manual = await tool(child, "bind_write_gate", { project_root: directory, manifest_path: manifest });
        assert.equal(manual.status, "bound");
        assert.equal(manual.idempotent, true, "manual/auto overlap uses the existing binding");
        assert.match(await reread(), /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/);
        await tool(child, "release_write_gate");
        assert.match(await reread(), /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/,
          "repeat full Read reactivates the existing released binding");
      }
      if (index === 1) {
        assert.equal((await tool(child, "expand_unit", { unit_id: unit.unit.id, paths: ["node_modules/**"],
          reason: "Same-Task dependency output repair" })).status, "scope-updated");
        assert.match(await reread(), /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/,
          "scope expansion retains its current binding identity");
        // The real V2 Worker linked a project-local dependency environment before native shell validation.
        await mkdir(join(directory, ".sortie-env/node_modules/pkg"), { recursive: true });
        await writeFile(join(directory, ".sortie-env/node_modules/pkg/index.js"), "dependency");
        await symlink(".sortie-env/node_modules", join(directory, "node_modules"), "dir");
      }
      const recovery = { sessionID: child, agent: "dog-worker-v010", system: [] as { text: string }[], tools: {} };
      await fixture.sessionHooks.get("context")!(recovery);
      const retained = recovery.system.find(part => part.text.startsWith("SORTIE_WORKER_CONTEXT\n"))!.text;
      const paths = JSON.parse(retained.split("\n")[1]!);
      assert.equal(paths.handoff_path, relative(directory, unit.handoffPath).replaceAll("\\", "/"));
      assert.equal(paths.operation_manifest, manifest);
      const patchText = index === 0 ? `*** Begin Patch\n*** Add File: result.txt\n+${finalCandidate ? "ready" : "partial"}\n*** End Patch`
        : "*** Begin Patch\n*** Update File: result.txt\n@@\n-partial\n+ready\n*** End Patch";
      const patch = await before(child, "patch", { patchText });
      await writeFile(join(directory, "result.txt"), finalCandidate ? "ready\n" : "partial\n");
      await after(patch, "Updated result.txt");
      if (commit) {
        for (const args of [["add", "--", "result.txt"], ["commit", "-m", "Implement result"]]) {
          const gitCommand = args[0] === "add" ? "git add -- result.txt" : 'git commit -m "Implement result"';
          const operation = await before(child, "shell", { command: gitCommand });
          const executed = await exec("git", args, { cwd: directory });
          await after(operation, executed.stdout, { exit: 0 });
        }
      }
      const validation = await before(child, "shell", { command });
      const checked = await exec(process.execPath, ["check.mjs", finalCandidate ? "ready" : "present"], { cwd: directory });
      await after(validation, checked.stdout, { exit: 0 });
      agents[child]!.outcome = "succeeded";
      await after(worker, "Validation passed", { sessionID: child });
      const review = await tool("coordinator", "review_mission", { risk_tags: commit ? ["public-logic"] : [], traces: [`R1: result.txt checked using ${command}`] });
      if (commit) {
        const reviewTask = await before("coordinator", "subagent", nativeTask(review.task));
        await prompt("reviewer", String(reviewTask.input.prompt));
        agents.reviewer!.outcome = "succeeded";
        await after(reviewTask, "PASS\nCommitted result matches the original request and real validation.", { sessionID: "reviewer" });
        assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: directory })).stdout.trim(), "Implement result");
        assert.equal((await exec("git", ["status", "--porcelain"], { cwd: directory })).stdout, "");
      }
      await tool("coordinator", "submit_mission", { status: "ready", summary: "Candidate for Operator acceptance" });
      agents.coordinator!.outcome = "succeeded";
      await after(dispatch, "Candidate ready", { sessionID: "coordinator" });
      const status = await tool("root", "operator_status");
      assert.equal(status.budget.consumed_units, index + 1);
      assert.equal(status.budget.reserved_units, 0);
      if (budget) assert.equal(status.budget.max_units, budget.max_units);
      budget = status.budget;
      assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).receipt, null);
      if (index === 0 && !commit) {
        retiredHandoff = handoff;
        cleanup?.(); await start(); // Same durable mission/Coordinator; no additional user turn.
        delete agents.coordinator!.outcome;
        dispatch = await before("root", "subagent", { agent: "dogs-coordinator", sessionID: "coordinator",
          description: "Correct incomplete candidate", prompt: "The original request requires ready; replace partial and verify the actual value." });
        await prompt("coordinator", String(dispatch.input.prompt));
      }
    }
    assert.equal((await tool("root", "complete_mission")).status, "succeeded");
    const final = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(final.id, mission.mission_id);
    assert.equal(final.coordinator, "coordinator");
    assert.equal(final.requests.length, 1, "Operator correction does not need another user instruction");
    assert.equal(final.requests[0]!.text, original);
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "ready\n");
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

test("V2 interrupted Coordinator Task reconciles its native error despite a live dispatch owner", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-interrupted-dispatch-"));
  const fixture = contextFixture();
  const history: Record<string, unknown[]> = { root: [] };
  const context: OpenCodeV2Context = { ...fixture.context, location: { directory },
    session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID, agent: sessionID === "root" ? "dog-operator" : "dogs-coordinator",
        ...(sessionID === "root" ? {} : { parentID: "root" }), model: { providerID: "openai", id: "gpt-6-sol" } }),
      context: async ({ sessionID }) => history[sessionID] ?? [],
    } };
  const cleanup = await V2Plugin.setup(context);
  try {
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "msg_request", text: "Complete the existing run and report its result" });
    const mission = await missions.start("root", ["Complete the existing run and report its result"]);
    const task = missions.task(mission);
    const first = { sessionID: "root", agent: "dog-operator", tool: "subagent", id: "call_interrupted",
      input: { agent: task.subagent_type, description: task.description, prompt: task.prompt } };
    await fixture.toolHooks.get("execute.before")!(first);
    await fixture.sessionHooks.get("prompt")!({ sessionID: "coordinator", messageID: "msg_child",
      prompt: { text: `You are a subagent spawned by another session.\n${task.prompt}` } });
    const status = fixture.tools.find(tool => tool.name === "sortie_v010_operator_status") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }>;
    };
    const readStatus = async () => JSON.parse((await status.execute({}, { sessionID: "root", agent: "dog-operator" })).content);
    assert.equal((await readStatus()).coordinator_dispatch, "active", "a running Task cannot be redispatched");
    history.root!.push({ id: "msg_other", type: "assistant", agent: "dog-operator", content: [{
      type: "tool", id: "call_other", name: "subagent", state: { status: "error", input: first.input },
    }] });
    assert.equal((await readStatus()).coordinator_dispatch, "active", "a different terminal call cannot release this Task");
    history.root!.push({ id: "msg_interrupted", type: "assistant", agent: "dog-operator", content: [{
      type: "tool", id: first.id, name: "subagent", state: { status: "error", input: first.input,
        error: { type: "aborted", message: "Tool execution interrupted" } },
    }] });
    const reconciled = await readStatus();
    assert.equal(reconciled.coordinator_dispatch, "resumable");
    assert.equal(reconciled.task.task_id, "coordinator", "reuse the same child and original Mission");
    assert.equal((await missions.required("root")).dispatchOpen, false);
    const resumed = { sessionID: "root", agent: "dog-operator", tool: "subagent", id: "call_resumed",
      input: { agent: task.subagent_type, sessionID: "coordinator", description: "Continue existing run", prompt: "Recover results" } };
    await fixture.toolHooks.get("execute.before")!(resumed);
    assert.equal((await missions.required("root")).callID, "call_resumed");
    assert.equal((await readStatus()).coordinator_dispatch, "active", "the new live Task remains protected");
    await assert.rejects(fixture.toolHooks.get("execute.before")!({ ...resumed, id: "call_duplicate" }), /mission-dispatch-not-authorized/u);
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

test("V2 aborted Worker Task exposes the native error and interrupt acknowledgement to recovery", async () => {
  const fixture = contextFixture();
  const interrupted: string[] = [];
  const history = [{ id: "msg_aborted_worker", type: "assistant", agent: "dogs-coordinator", content: [{
    type: "tool", id: "call_worker", name: "subagent", state: { status: "error",
      input: { agent: "dog-worker-v010", prompt: "SORTIE_MISSION_TASK_REF" },
      error: { type: "aborted", message: "Tool execution interrupted: subagent" } },
    time: { created: 1, ran: 2, completed: 3 },
  }] }];
  const context: OpenCodeV2Context = { ...fixture.context, session: { ...fixture.context.session,
    get: async ({ sessionID }) => ({ id: sessionID, agent: sessionID === "worker" ? "dog-worker-v010" : "dogs-coordinator",
      ...(sessionID === "worker" ? { parentID: "coordinator" } : {}) }),
    context: async () => history,
    interrupt: async ({ sessionID }) => { interrupted.push(sessionID); return { interrupted: true }; },
  } };
  const cleanup = await createSortieDogsV2Plugin(async input => {
    const legacy = input.client!.session!;
    const messages = (await legacy.messages!({ path: { id: "coordinator" } }) as { data: Record<string, unknown>[] }).data;
    const part = (messages[0]!.parts as Record<string, unknown>[])[0]!;
    assert.equal(part.tool, "task");
    assert.equal(part.callID, "call_worker");
    assert.deepEqual((part.state as { status: string; error: unknown }).error,
      { type: "aborted", message: "Tool execution interrupted: subagent" });
    assert.deepEqual(await legacy.abort!({ path: { id: "worker" } }), { interrupted: true });
    return {};
  }).setup(context);
  try { assert.deepEqual(interrupted, ["worker"]); }
  finally { cleanup?.(); }
});

test("V2 review recovery pages past bounded context to a completed initial Reviewer", async () => {
  const fixture = contextFixture();
  const initial = "candidate_id: mission-current\nreview_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [public-logic]\nrevision: first";
  const verification = initial.replace("review_phase: initial", "review_phase: verification").replace("first", "fixed");
  const reference = `SORTIE_MISSION_REVIEW_REF ${JSON.stringify({ r: "root", m: "mission-current", n: "old-run",
    h: createHash("sha256").update(initial).digest("hex") })}`;
  const history: Record<string, unknown[]> = {
    coordinator: [{ id: "old-review", type: "assistant", agent: "dogs-coordinator", content: [{ type: "tool", name: "subagent",
      state: { status: "completed", input: { agent: "dog-reviewer-v010", prompt: reference },
        metadata: { sessionID: "reviewer" } } }] },
    { id: "middle", type: "assistant", content: [] }, { id: "recent", type: "assistant", content: [] }],
    reviewer: [{ id: "reviewer-user", type: "user", text: `You are a subagent spawned by another session.\n${initial}` },
      { id: "reviewer-reply", type: "assistant", content: [{ type: "text", text: "FINDINGS" }] }],
  };
  const pages: string[] = [];
  const context: OpenCodeV2Context = { ...fixture.context,
    session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID,
        agent: sessionID === "reviewer" ? "dog-reviewer-v010" : "dogs-coordinator",
        parentID: sessionID === "coordinator" ? "root" : sessionID === "reviewer" ? "coordinator" : undefined }),
      context: async ({ sessionID }) => (history[sessionID] ?? []).slice(-1),
    },
    message: { list: async ({ sessionID, cursor }) => {
      const offset = Number(cursor ?? 0), items = history[String(sessionID)] ?? [];
      pages.push(`${sessionID}:${offset}`);
      return { data: items.slice(offset, offset + 2), cursor: { next: offset + 2 < items.length ? String(offset + 2) : null } };
    } },
  };
  const cleanup = await createSortieDogsV2Plugin(async input => {
    assert.equal((await context.session.context({ sessionID: "coordinator" }) as unknown[]).length, 1,
      "V2 context contains only the recent window");
    const session = input.client!.session! as typeof input.client.session & { reviewMessages: typeof input.client.session.messages };
    const full = (await session.messages!({ path: { id: "coordinator" } }) as { data: unknown[] }).data;
    assert.equal(full.length, 3);
    const mission = { id: "mission-current", root: "root", phase: "running", coordinator: "coordinator",
      review: { task: { prompt: verification } } } as never;
    const prompts = await completedMissionReviewPrompts(mission, V010_RUNTIME_PROFILE, "root", verification, {
      get: async id => (await session.get!({ path: { id } }) as { data: unknown }).data,
      messages: async id => (await session.reviewMessages!({ path: { id } }) as { data: Record<string, unknown>[] }).data,
    });
    assert.deepEqual(prompts, [initial]);
    return {};
  }).setup(context);
  try { assert.ok(pages.includes("coordinator:2"), "older completed reviews need a second page"); }
  finally { cleanup?.(); }
});

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
    assert.equal(running.run_created_at, run.createdAt);
    assert.equal(running.last_transition_at, null, "running alone is not a settled transition or heartbeat");
    await missions.update("root", state => { state.progress.push({ unit: `${run.runID}/unit-1`, title: "Fix result",
      status: "failed", at: "2026-09-27T12:00:00.000Z" }); });
    assert.equal((await observe())!.sortie_progress.last_transition_at, "2026-09-27T12:00:00.000Z");
    assert.equal(await missionProgressReader(directory, "root", "foreign-call")(), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("V2 missing child-list API recovers nested model gauges from native Task history in one message pass", async () => {
  const fixture = contextFixture();
  const identities = { root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    worker: { agent: "dog-worker-v010", parentID: "coordinator" }, foreign: { agent: "build", parentID: "another-root" } };
  const native = (id: string, model: string, children: string[] = []) => ({ id: `message-${id}`, type: "assistant",
    agent: identities[id as keyof typeof identities].agent, model: { providerID: "openai", id: model },
    time: { created: 1, completed: 9 }, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    content: children.map((child, index) => ({ type: "tool", name: "subagent", id: `call-${id}-${index}`,
      time: { created: 2, completed: 8 }, state: { status: "completed", input: { agent: "dog-worker-v010" },
        metadata: { sessionID: child }, content: [] } })) });
  const histories = { root: [native("root", "gpt-6-sol", ["coordinator", "coordinator", "foreign"])],
    coordinator: [native("coordinator", "gpt-6-sol", ["worker"])], worker: [native("worker", "gpt-6-luna-fast")] };
  const reads: string[] = [];
  let metrics: Awaited<ReturnType<typeof collectRunMetrics>>;
  const cleanup = await createSortieDogsV2Plugin(async input => {
    metrics = await collectRunMetrics(input.client, "root", undefined, 10);
    return {};
  }).setup({ ...fixture.context, session: { ...fixture.context.session,
    list: async () => { throw new Error("session.list unavailable in private V2 facade"); },
    get: async ({ sessionID }) => ({ id: sessionID, ...identities[sessionID as keyof typeof identities] }),
    context: async ({ sessionID }) => { reads.push(sessionID); return histories[sessionID as keyof typeof histories]; },
  } });
  try {
    assert.deepEqual(reads, ["root", "coordinator", "worker"]);
    assert.equal(metrics!.tokens, undefined, "recorded dispatches do not prove exhaustive host coverage");
    const debrief = buildDebrief({ goal_id: "g", evidence_refs: [], session_ids: [], status: "stopped" } as never, null, metrics!.debrief);
    assert.deepEqual(debrief.mixCoverage, { complete: false, observedTokens: 36 });
    assert.match(renderDebrief(debrief).join("\n"), /🐕 openai\/gpt-6-luna-fast ▌\s+4\.8% · \$0\.000004 · 12 tokens/u);
  } finally { cleanup?.(); }
});

test("V2 operator references admit native background and preserve explicit foreground compatibility", async () => {
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
      await fixture.toolHooks.get("execute.before")!({ tool: "subagent", input, sessionID: "root", id: prompt });
      assert.equal(seen.at(-1)!.background, true, "native admission retains the Job flag");
    }
    seen.length = 0;
    const event = { tool: "subagent", input: { agent: "dogs-coordinator", description: "exact",
      prompt: "SORTIE_OPERATOR_DELEGATE_REF {}", background: false }, sessionID: "root", id: "call" };
    await fixture.toolHooks.get("execute.before")!(event);
    assert.deepEqual(seen, [{ subagent_type: "dogs-coordinator", description: "exact", prompt: "SORTIE_OPERATOR_DELEGATE_REF {}" }]);
    assert.deepEqual(event.input, { agent: "dogs-coordinator", description: "exact", prompt: "SORTIE_OPERATOR_DELEGATE_REF {}" });
  } finally { if (typeof dispose === "function") dispose(); }
});

for (const role of ["dogs-coordinator", "dog-worker-v010", "dog-reviewer-v010"]) test(`V2 native ${role} running launch returns original ack; completion calls existing after exactly once`, async () => {
  const fixture = contextFixture();
  const childHistory: Record<string, unknown>[] = [];
  const seen: string[] = [];
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  let restored = false;
  const context: OpenCodeV2Context = { ...fixture.context, session: { ...fixture.context.session,
    get: async ({ sessionID }) => ({ id: sessionID, agent: sessionID === "root" ? "dog-operator" : role,
      ...(sessionID === "root" ? {} : { parentID: "root" }) }),
    context: async ({ sessionID }) => sessionID === "root" ? [] : childHistory,
  } };
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    backgroundOwner: (_call, restore) => { if (restore) restored = true; return { role, generation: 1 }; },
    "tool.execute.before": async () => {},
    "tool.execute.after": async (_request, output) => {
      seen.push(String((output.metadata as Record<string, unknown>).status));
      output.output = "accounted terminal text";
      if ((output.metadata as Record<string, unknown>).status === "succeeded") complete();
    },
  })).setup(context);
  try {
    const input = { agent: role, prompt: "exact reference", description: "useful work", background: true };
    await fixture.toolHooks.get("execute.before")!({ tool: "subagent", id: "call", sessionID: "root", input });
    const result = { status: "running", content: "Native Job running", metadata: { sessionID: "child", status: "running" } };
    const launch = { tool: "subagent", id: "call", sessionID: "root", input, status: "completed", result };
    await fixture.toolHooks.get("execute.after")!(launch);
    assert.equal(launch.result, result, "native running result is not replaced by a Mission terminal packet");
    assert.deepEqual(seen, ["running"]);
    childHistory.push({ id: "final", type: "assistant", finish: "stop", content: [{ type: "text", text: "actual result" }], time: { created: Date.now() } });
    await fixture.emit({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "child" } });
    await completed;
    await fixture.emit({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "child" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(seen, ["running", "succeeded"]);
    assert.equal(restored, true, "the durable owner snapshot is supplied to the existing terminal path");
    assert.equal(fixture.synthetic.length, 0, "Sortie never creates a second completion prompt");
  } finally { cleanup?.(); }
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
    ["dog-worker-v010", undefined], ["dog-reviewer-v010", undefined], ["dog-advisor-v010", undefined],
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
    assert.deepEqual(models.get("dog-operator"), { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dogs-coordinator"), { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dog-worker-v010"), { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" });
    assert.deepEqual(models.get("dog-reviewer-v010"), { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dog-advisor-v010"), { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
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

test("V2 read result projection exposes full original requirements on the native hook path", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-contract-view-"));
  const fixture = contextFixture();
  const path = ".sortie-dogs-v010/contracts/handoff.native.json";
  await mkdir(join(directory, ".sortie-dogs-v010/contracts"), { recursive: true });
  const requirement = "Context. ".repeat(300) + "\nError text must contain type error and <nil>.";
  const instruction = "Unit details. ".repeat(260) + "\nPreserve the exact original API.";
  const source = JSON.stringify({ task: { objective: "typed bindings" },
    ext: { "sortie-dogs/mission-context": { original_requests: [{ text: requirement }], unit_instruction: instruction } } });
  await writeFile(join(directory, path), source);
  const cleanup = await createSortieDogsV2Plugin(async () => ({})).setup({ ...fixture.context, location: { directory } });
  try {
    const after = fixture.toolHooks.get("execute.after")!;
    const nativeResult = { content: [{ type: "text", text: `1: ${source.slice(0, 2000)}` }], metadata: { truncated: false } };
    const completed = { tool: "read", input: { path }, status: "completed", result: nativeResult };
    await after(completed);
    assert(completed.result.content[0]!.text.includes(requirement));
    assert(completed.result.content[0]!.text.includes(instruction), "overflow instructions remain native-visible, not clipped or summarized");
    assert.deepEqual(completed.result.metadata, { truncated: false });
    assert.equal(await readFile(join(directory, path), "utf8"), source);
    const failed = { tool: "read", input: { path }, status: "error", result: nativeResult };
    await after(failed);
    assert.equal(failed.result, nativeResult, "failed native reads must not be replaced with successful content");
    const ordinary = { tool: "read", input: { path: "user.json" }, status: "completed", result: nativeResult };
    await after(ordinary);
    assert.equal(ordinary.result.content[0]!.text, nativeResult.content[0]!.text);
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
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

test("V2 Worker can observe status and repair its scope without acquiring Coordinator control tools", async () => {
  const fixture = contextFixture();
  const cleanup = await V2Plugin.setup(fixture.context);
  try {
    const exposed = Object.fromEntries(fixture.tools.map(tool => [tool.name, tool]));
    for (const agent of ["dog-worker-v010", "dog-luna-worker-v010"]) {
      const event = { sessionID: "worker", agent, system: [], tools: { ...exposed, read: {} } };
      await fixture.sessionHooks.get("context")!(event);
      assert.deepEqual(Object.keys(event.tools).sort(), ["read", "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "sortie_v010_operator_status", "sortie_v010_release_write_gate"]);
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
  const waiters: Array<() => void> = [];
  console.warn = (...values: unknown[]) => { warnings.push(values); waiters.shift()?.(); };
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
    if (warnings.length < 1) await new Promise<void>(resolve => { waiters.push(resolve); });
    fixture.failNextContext();
    await fixture.emit({ type: "session.execution.succeeded", data: { sessionID: "root" } });
    if (warnings.length < 2) await new Promise<void>(resolve => { waiters.push(resolve); });
    await fixture.emit({ type: "session.idle", data: { sessionID: "root" } });
    await fixture.emit({ type: "session.compaction.ended", data: { sessionID: "root" } });
    await fixture.emit({ type: "filesystem.changed", data: { file: "changed.txt", event: "change" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fixture.synthetic.length, 0);
    assert.ok(warnings.some(values => values[0] === "[sortie-dogs-v010] V2 event handling failed" && values[1] === "context unavailable"));
    assert.equal(warnings.filter(values => values[0] === "[sortie-dogs-v010] V2 event handling failed").length, 2);
    assert.deepEqual(observed.filter(value => !value.startsWith("file.")), ["session.idle:root", "session.compacted:root"]);
    assert.ok(observed.includes("file.edited:changed.txt"), "different sessions/filesystem events need not wait for the root lane");
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
