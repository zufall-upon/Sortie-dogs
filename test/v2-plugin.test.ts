import assert from "node:assert/strict";
import Ajv from "ajv";
import { legacyToolArgs } from "../dist/plugin/tool-schema.js";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { availableParallelism, tmpdir } from "node:os";
import test from "node:test";
import { createProjectPaths, createWriteGate } from "../dist/plugin/gate.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { copyManagedRouterFixture } from "./helpers/managed-router-fixture.ts";

import V2Plugin, {
  createSortieDogsV2Plugin,
  createV2ReturnReportFinalizer,
  nativeReviewerRoleRules,
  type OpenCodeV2Context,
} from "../dist/plugin/v2.js";
import type { OpenCodeHooks, OpenCodePlugin } from "../dist/plugin/index.js";
import { collectRunMetrics } from "../dist/plugin/run-metrics.js";
import { buildDebrief, renderDebrief } from "../dist/plugin/sortie-debrief.js";
import { applyPendingWork, cachedWorkProgress, observeActorWork, rememberWorkMission, workRootForActor } from "../dist/core/work-quantity-observations.js";
import { planWorkQuantity } from "../dist/core/work-quantity.js";
import { publishMissionProgress } from "../dist/plugin/mission-progress.js";
import { SortieDogsV010Plugin, terminalCancelledMissionChildren } from "../dist/plugin/profiled.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { OperatorMissionRuntime, missionPlan, missionAcceptanceSummary } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { ProjectMemory, projectMemoryFile } from "../dist/core/project-memory.js";
import { missionProgressReader } from "../dist/plugin/mission-progress.js";
import { completedMissionReviewPrompts, observedMissionValidation, observedMissionValidationSummary } from "../dist/plugin/mission-review.js";
import { runtimeAssets } from "../dist/runtime-assets-v010.js";
import { MISSION_RESULT_HOLD_POLICY, MISSION_REFLECTION_WORKFLOW, LEGACY_MISSION_REFLECTION_WORKFLOW } from "../dist/runtime-mission-assets.js";

test("V2 exposes opted-in Project Memory to existing controllers only and preserves off recall", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "v2-memory-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  let cleanup: (() => void) | undefined;
  try {
    const fixture = contextFixture();
    fixture.context.location.directory = root;
    fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator", model: { providerID: "openai", id: "gpt-6.1-sol" } });
    const memory = new ProjectMemory(await projectMemoryFile(root));
    await memory.configure(true);
    cleanup = await createSortieDogsV2Plugin(SortieDogsV010Plugin).setup(fixture.context) as () => void;
    assert.ok(fixture.tools.some(tool => tool.name === "sortie_v010_project_memory"));
    for (const agent of ["dog-operator", "dogs-coordinator", "dog-worker-v010", "dog-advisor-v010"]) {
      const event = { sessionID: "root", agent, system: [], messages: [], tools: { sortie_v010_project_memory: {} } };
      await fixture.sessionHooks.get("context")!(event);
      assert.equal(Object.hasOwn(event.tools, "sortie_v010_project_memory"), ["dog-operator", "dogs-coordinator"].includes(agent));
    }
    await memory.configure(false);
    const event = { sessionID: "root", agent: "dog-operator", system: [] as unknown[], messages: [] as unknown[], tools: {} };
    await fixture.sessionHooks.get("context")!(event);
    assert.doesNotMatch(JSON.stringify(event), /SORTIE_PROJECT_MEMORY \(/);
  } finally {
    cleanup?.();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("V2 Project Memory keeps inline image bytes out of recall and retrieves the original on demand", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "v2-memory-inline-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  let cleanup: (() => void) | undefined;
  try {
    const fixture = contextFixture();
    fixture.context.location.directory = root;
    fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator", model: { providerID: "openai", id: "gpt-6.1-sol" } });
    const memory = new ProjectMemory(await projectMemoryFile(root));
    await memory.configure(true);
    cleanup = await createSortieDogsV2Plugin(SortieDogsV010Plugin).setup(fixture.context) as () => void;
    const bytes = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/wAAAABJRU5ErkJggg==", "base64"), Buffer.alloc(3 * 1024 * 1024, 0xa5)]);
    const data = bytes.toString("base64"), source = "root:inline-reference";
    const originalText = "Use this original reference, not a generated replacement.\n" + "original detail ".repeat(200);
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "inline-reference",
      prompt: { text: originalText, files: [{ data, mime: "image/png", name: "reference.png" }] } });
    const pending = await memory.recall(root);
    assert.ok(JSON.stringify(pending).length < 16000, "automatic pending recall must not contain base64 image bytes");
    assert.equal(pending.pending[0].attachments[0].url, undefined);
    assert.equal(pending.pending[0].attachments[0].source, source);
    assert.equal(pending.pending[0].attachments[0].index, 0);
    const definition = fixture.tools.find(tool => tool.name === "sortie_v010_project_memory") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }>;
    };
    const executeMemory = async (request: object) => JSON.parse((await definition.execute(
      { request_json: JSON.stringify(request) }, { sessionID: "root" })).content);
    const original = await executeMemory({ action: "source", source });
    assert.equal(original.source.text, originalText, "full original text remains available without fetching base64 image payloads");
    assert.ok(JSON.stringify(original).length < 16000);
    assert.equal((await memory.source(source))!.attachments[0].url, `data:image/png;base64,${data}`, "projection must not rewrite the retained original");
    const image = await executeMemory({ action: "attachment", source, index: 0 });
    assert.equal(image.attachment.mime, "image/png");
    assert.deepEqual(await readFile(image.attachment.path), bytes, "native read gets the exact original bytes through an on-demand file reference");
    assert.equal((await executeMemory({ action: "attachment", source, index: 0 })).attachment.path, image.attachment.path);
    await executeMemory({ action: "apply", source, operation: "retain-reference", changes: [{ key: "original-reference", scope: "project", context: "project",
      kind: "constraint", status: "adopted", text: "Use the original reference", reason: "User requirement" }] });
    const processed = await new ProjectMemory(memory.file).recall(root);
    assert.ok(JSON.stringify(processed).length < 16000, "processed source projection must also omit base64");
    assert.equal(processed.sources![0].attachments[0].source, source);
    const event = { sessionID: "root", agent: "dog-operator", system: [] as any[], messages: [], tools: {} };
    await fixture.sessionHooks.get("context")!(event);
    const injection = event.system.find(part => part.text?.startsWith("SORTIE_PROJECT_MEMORY ("));
    assert.ok(injection && injection.text.length < 16000, "the real model system injection remains bounded for this image-bearing source");
    assert.ok(!injection.text.includes(data));
    await memory.configure(false);
    assert.deepEqual(await executeMemory({ action: "attachment", source, index: 0 }), { attachment: null }, "off must not expose retained image bytes");
  } finally {
    cleanup?.();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

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
      providerID: "openai", id: agentID === "dog-worker-v010" ? "gpt-6.1-terra" : "gpt-6-sol",
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

test("V2 validation join checks the original native shell permission and forwards cancellation", async () => {
  const fixture = contextFixture();
  const assertions: unknown[] = [];
  fixture.context.permission.assert = async input => { assertions.push(input); throw new Error("native permission denied"); };
  let authorize: NonNullable<Parameters<OpenCodePlugin>[0]["authorizeValidationJoin"]> | undefined;
  let observedSignal: AbortSignal | undefined;
  const factory: OpenCodePlugin = async input => {
    authorize = input.authorizeValidationJoin;
    return { "tool.execute.before": async request => { observedSignal = request.signal; } };
  };
  const cleanup = await createSortieDogsV2Plugin(factory).setup(fixture.context);
  try {
    assert.ok(authorize);
    await assert.rejects(authorize({ sessionID: "worker", agent: "dog-worker-v010", command: "node candidate.test.mjs",
      directory: "/project" }), /native permission denied/u);
    assert.deepEqual(assertions, [{ sessionID: "worker", agent: "dog-worker-v010", action: "shell",
      resources: ["node candidate.test.mjs"], save: ["node candidate.test.mjs"] }]);
    const controller = new AbortController();
    await fixture.toolHooks.get("execute.before")!({ tool: "shell", sessionID: "worker", id: "call",
      input: { command: "node candidate.test.mjs" }, signal: controller.signal });
    assert.equal(observedSignal, controller.signal);
  } finally { cleanup?.(); }
});

test("V2 native Grip hooks retain direction through context reload and preserve native question answer metadata", async () => {
  const directory = await mkdtemp(resolve("_testenv/v2-grip-"));
  let cleanup: (() => void) | void;
  try {
    const fixture = contextFixture(); fixture.context.location.directory = directory;
    fixture.context.session.get = async () => ({ id: "root", agent: "dog-operator" });
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "user", text: "Keep this user purpose unchanged." });
    await missions.start("root", ["Preserve direction"]);
    const factory: OpenCodePlugin = async () => ({ "tool.execute.before": async () => {}, "tool.execute.after": async () => {},
      "experimental.chat.system.transform": async () => {} });
    cleanup = await createSortieDogsV2Plugin(factory).setup(fixture.context);
    const before = fixture.toolHooks.get("execute.before")!, after = fixture.toolHooks.get("execute.after")!;
    const event = { tool: "question", id: "native-grip", sessionID: "root", agent: "dog-operator", input: {
      questions: [{ header: "Grip", question: "Which user-facing approach?\nWhy now: the UX will change.",
        options: [{ label: "A", description: "Small" }, { label: "B", description: "Broad" }] }] } };
    await before(event);
    assert.equal(event.input.questions[0]!.options.at(-1)!.label, "Revisit goal with outside advice");
    const result = { ...event, status: "completed", result: { content: "native answer", metadata: { answers: [["Revisit goal with outside advice"]] } } };
    await after(result);
    assert.match(result.result.content, /SORTIE_GRIP_HANDOFF/u);
    assert.deepEqual(result.result.metadata.answers, [["Revisit goal with outside advice"]]);
    const modelContext = { sessionID: "root", agent: "dog-operator", system: [] as unknown[], tools: {}, messages: [] };
    await fixture.sessionHooks.get("context")!(modelContext);
    assert.match(JSON.stringify(modelContext.system), /SORTIE_GRIP_HELD_DIRECTION/u);
    await assert.rejects(before({ tool: "sortie_v010_plan_units", id: "forbidden-plan", sessionID: "root", input: {} }), /mission-grip-needs-user-direction/u);
    // V2.2.2 Tool.snapshot's CodeModeTool.create callback runs beforeExecute for EACH
    // inner tool, using the outer context/session/call ID. Do not exempt that ID here.
    await before({ tool: "execute", id: "outer-code-mode", sessionID: "root", input: { code: "return await tools.shell(input)" } });
    let executed = 0;
    const inner = async (tool: string, input: Record<string, unknown>) => {
      await before({ tool, id: "outer-code-mode", sessionID: "root", input }); executed++;
    };
    await assert.rejects(inner("shell", { command: "printf changed > result.txt" }), /mission-grip-needs-user-direction/u);
    await assert.rejects(inner("sortie_v010_plan_units", {}), /mission-grip-needs-user-direction/u);
    assert.equal(executed, 0, "the normal inner tool executor is never reached");
    await inner("read", { path: "result.txt" }); assert.equal(executed, 1);
    await before({ tool: "sortie_v010_cancel_operator", id: "cancel", sessionID: "root", input: {} });
    assert.ok((await missions.required("root")).grip?.pending);
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

test("V2 legacy hooks can restrict native permission effects but cannot upgrade them", async () => {
  for (const native of ["allow", "ask", "deny"] as const) for (const legacy of ["allow", "ask", "deny"] as const) {
    const fixture = contextFixture();
    const cleanup = await createSortieDogsV2Plugin(async () => ({ "permission.ask": async (_request, output) => { output.status = legacy; } })).setup(fixture.context);
    try {
      const event = { sessionID: "root", action: "shell", resources: ["node --version"], effect: native as string };
      await fixture.permissionHooks.get("evaluate")!(event);
      assert.equal(event.effect, [native, legacy].includes("deny") ? "deny" : [native, legacy].includes("ask") ? "ask" : "allow");
    } finally { cleanup?.(); }
  }
});

test("V2 normal Mission producer supplies the vision through start/plan into public Grip and held context", async () => {
  const directory = await mkdtemp(resolve("_testenv/v2-grip-vision-")), fixture = contextFixture();
  let cleanup: (() => void) | void;
  try {
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: directory });
    fixture.history.length = 0;
    // Synthetic example only, not the purpose of the user's separate API-budget Mission.
    fixture.history.push({ id: "msg_vision_source", type: "user",
      text: "音声案内で、初めての利用者が手を止めず練習を続けられる姿を目指す。",
      files: [{ data: "AQID", mime: "image/png", name: "fixture.png", source: { type: "inline" } }] });
    fixture.context.location.directory = directory;
    fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator",
      model: { providerID: "openai", id: "gpt-6.1-sol" } });
    cleanup = await createSortieDogsV2Plugin(SortieDogsV010Plugin).setup({ ...fixture.context,
      message: { list: async () => ({ data: fixture.history, cursor: { next: null } }) } });
    const original = "Chatで相談した内容を参照しておいて\n  private fixture detail";
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_continuation", prompt: { text: original } });
    const call = async (name: string, input: Record<string, unknown>) => {
      const tool = fixture.tools.find(tool => tool.name === `sortie_v010_${name}`) as any;
      const args = { ...Object.fromEntries(Object.keys(tool.input.properties).map(key => [key, ""])), ...input };
      const validate = new Ajv({ strict: false }).compile(tool.input);
      assert.equal(validate(args), true, JSON.stringify(validate.errors));
      return JSON.parse((await tool.execute(args, { sessionID: "root", callID: `call_${name}` })).content);
    };
    const summary = "初めての利用者が音声案内で練習を続けられる。";
    await call("start_mission", { requirements: ["初めての利用者が音声案内で練習を続けられる状態にする。", "課金・API接続は別途の明示許可まで行わない。"],
      vision: { summary, source_refs: ["context:msg_vision_source", "requirement:R1"] } });
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE), started = await missions.required("root");
    assert.equal(started.vision!.summary, summary);
    assert.ok(started.context!.some(item => item.id === "msg_vision_source"));
    const source = started.continuity!.sources.flatMap(source => source.attachments ?? []).find(file => file.message_id === "msg_vision_source")!;
    assert.deepEqual(await readFile(source.path!), Buffer.from([1, 2, 3]), "original attachment bytes remain available");
    fixture.history.push({ id: "msg_later_vision_source", type: "assistant",
      content: [{ type: "text", text: "音声案内だけでなく、初回の操作に迷わず練習を続けられる姿として整理する。" }] });
    const continuedSummary = "初めての利用者が、操作に迷わず音声案内で練習を続けられる。";
    await call("start_mission", { requirements: started.requirements.map(item => item.text),
      vision: { summary: continuedSummary, source_refs: ["context:msg_later_vision_source", "requirement:R1"] } });
    const continued = await missions.required("root");
    assert.equal(continued.id, started.id);
    assert.equal(continued.vision!.summary, continuedSummary);
    assert.ok(continued.context!.some(item => item.id === "msg_later_vision_source"));
    assert.deepEqual(continued.context!.filter(item => item.id !== "msg_later_vision_source"), started.context);
    assert.deepEqual(continued.requests, started.requests);
    assert.deepEqual(continued.requirements, started.requirements);
    const plannedSummary = "初めての利用者が、操作に迷わず音声案内で練習を続けられる。";
    await call("plan_units", { executor: "self", vision: { summary: plannedSummary, source_refs: ["context:msg_vision_source", "requirement:R1"] },
      units: [{ title: "表示用fixture", objective: "Keep the fixture isolated", write: [], validation: ["node check.mjs"] }] });
    const before = fixture.toolHooks.get("execute.before")!, after = fixture.toolHooks.get("execute.after")!;
    const event = { tool: "question", id: "native-grip-vision", sessionID: "root", agent: "dog-operator", input: {
      questions: [{ header: "Grip", question: "今回判断との関係：音声案内が使えるか確かめる試験の範囲を決める。\n今回の判断：実AI試験のAPI料金の予算上限は？\nなぜ今：作業枠とAPI料金は別単位。ここで選んでもまだAPIには接続しない。",
        options: [{ label: "100円", description: "100円以内の試験案。課金・API接続はまだ許可しない。" },
          { label: "まだ課金を許可しない", description: "条件整理だけ進める。" }] }] } };
    const options = structuredClone(event.input.questions[0]!.options);
    await before(event);
    const text = event.input.questions[0]!.question;
    assert.ok(text.startsWith(`🎯【達成したい姿・AI整理】${plannedSummary} ┃ 🔗【今回判断との関係・AI整理】`));
    assert.match(text, /試験の範囲を決める。 ┃ ❓【今回の判断】実AI試験のAPI料金の予算上限は？ ┃ 💡【なぜ今】/u);
    assert.doesNotMatch(text, /Chatで相談|private fixture|原文抜粋|132円|data:image|context:msg_/u);
    assert.deepEqual(event.input.questions[0]!.options.slice(0, -1), options);
    // Retain the actual public-hook output for a zero-inference native Form visual check.
    await writeFile(resolve("_testenv/grip-vision-preview.json"), JSON.stringify(event.input, null, 2));
    const result = { ...event, status: "completed", result: { content: "native answer", metadata: { answers: [["目的に戻って外部相談"]] } } };
    await after(result);
    assert.deepEqual(result.result.metadata.answers, [["目的に戻って外部相談"]]);
    const context = { sessionID: "root", agent: "dog-operator", system: [] as unknown[], tools: {}, messages: [] };
    await fixture.sessionHooks.get("context")!(context);
    assert.match(JSON.stringify(context.system), /SORTIE_GRIP_HELD_DIRECTION/u);
    assert.match(JSON.stringify(context.system), /AI整理/u);
    await assert.rejects(before({ tool: "sortie_v010_plan_units", id: "held", sessionID: "root", input: { vision: null } }), /mission-grip-needs-user-direction/u);
    const current = await missions.required("root");
    assert.deepEqual(current.requests, started.requests);
    assert.equal(current.requests[0]!.text, original);
    assert.deepEqual(current.requirements, started.requirements);
    assert.deepEqual(current.launchConditions, started.launchConditions);
    assert.deepEqual(current.continuity!.sources.flatMap(source => source.attachments ?? []), started.continuity!.sources.flatMap(source => source.attachments ?? []));
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

test("generated Mission Worker assets expose same-Task scope repair, not Coordinator controls", () => {
  for (const name of ["dog-worker-v010", "dog-luna-worker-v010"]) {
    const content = runtimeAssets.find(asset => asset.name === name)!.content;
    assert.match(content, /sortie_v010_expand_unit: allow/);
    assert.match(content, /sortie_v010_expand_unit: true/);
    assert.doesNotMatch(content, /sortie_v010_(?:plan_units|complete_mission|cancel_operator): true/);
  }
});

test("V2 session deletion and plugin disposal release workload observations", async () => {
  const fixture = contextFixture(), directory = "fixture:v2-workload-cleanup";
  const cleanup = await createSortieDogsV2Plugin(async () => ({})).setup({ ...fixture.context, location: { directory } });
  const remember = (root: string) => rememberWorkMission(directory, { version: "0.12", id: root, root,
    phase: "running", runID: null, kind: "implementation", requirements: [{ id: "R1", text: "Result" }], attempts: [] } as never);
  try {
    remember("root"); assert.ok(cachedWorkProgress(directory, "root"));
    await fixture.emit({ type: "session.deleted", data: { sessionID: "root" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cachedWorkProgress(directory, "root"), undefined);
    remember("another-root"); assert.ok(cachedWorkProgress(directory, "another-root"));
    cleanup?.();
    assert.equal(cachedWorkProgress(directory, "another-root"), undefined);
  } finally { cleanup?.(); }
});

test("PR249 follow-up: disposing an overlapping V2 instance preserves the live instance's pending work", async () => {
  const directory = "fixture:v2-overlapping-workload", first = contextFixture(), second = contextFixture();
  const a = await createSortieDogsV2Plugin(async () => ({})).setup({ ...first.context, location: { directory } });
  const b = await createSortieDogsV2Plugin(async () => ({})).setup({ ...second.context, location: { directory } });
  const mission = { version: "0.12", id: "mission", root: "root", coordinator: "worker", phase: "running",
    runID: null, kind: "implementation", requirements: [{ id: "R1", text: "Result" }], attempts: [] } as never;
  const state = planWorkQuantity(mission, [{ title: "Result", read: [], write: ["src/a.ts"], validation: [] }]);
  try {
    rememberWorkMission(directory, { ...mission as object, workQuantity: state } as never);
    observeActorWork(directory, "worker", { kind: "change", paths: ["src/a.ts"] });
    a?.(); a?.();
    assert.equal(workRootForActor(directory, "worker"), "root");
    assert.equal(applyPendingWork(directory, "root", structuredClone(state)).items.find(item => item.id === "artifact:src/a.ts")?.fraction, 0.55);
    b?.();
    assert.equal(cachedWorkProgress(directory, "root"), undefined);
    assert.equal(workRootForActor(directory, "worker"), undefined);
  } finally { a?.(); b?.(); }
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
  const transforms: Array<Parameters<NonNullable<OpenCodeV2Context["agent"]>["transform"]>[0]> = [];
  let registry: Record<string, any>;
  const rebuild = () => {
    registry = { "dog-reviewer-v010": { permissions: [...nativeReviewerRoleRules] } };
    const editor = { get: (id: string) => registry[id], update: (id: string, update: (agent: any) => void) => update(registry[id] ??= {}) };
    for (const callback of transforms) callback(editor);
  };
  fixture.context.agent = {
    transform: async callback => {
      transforms.push(callback);
      return { dispose() { transforms.splice(transforms.indexOf(callback), 1); } };
    },
    get: async ({ agentID }) => { rebuild(); return registry[agentID]; },
  };
  let correcting = false;
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "dog-reviewer-v010",
    model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } });
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async (_input, output) => { output.system = ["STATIC_REVIEWER_ROLE"]; },
    reviewerCorrectionScope: async () => correcting ? { write: ["vm/**"], validation: ["go test ./..."], generation: 1 } : undefined,
  })).setup(fixture.context);
  const names = ["glob", "grep", "patch", "read", "shell", "skill", "sortie_v010_bind_write_gate",
    "sortie_v010_expand_unit", "sortie_v010_finish_direct_unit", "sortie_v010_operator_status", "sortie_v010_release_write_gate",
    "sortie_v010_repair_review", "websearch", "execute", "fh_docker_read", "fh_docker_exec"];
  const definitions = Object.fromEntries(names.map(name => [name, { description: name, input: { type: "object", properties: {} } }]));
  const event = (agent: string, order = names) => ({ sessionID: "review-author", agent, system: [], messages: [],
    tools: Object.fromEntries(order.map(name => [name, definitions[name]])) });
  try {
    const initial = event("dog-reviewer-v010");
    await fixture.sessionHooks.get("context")!(initial);
    assert.equal(initial.tools.shell, definitions.shell, "native shell observation is available before correction without replacement definitions");
    assert.equal(initial.tools.fh_docker_read, definitions.fh_docker_read);
    assert.ok(!Object.hasOwn(initial.tools, "fh_docker_exec"), "read-only Docker inspection is not author execution");
    for (const forbidden of ["patch", "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "sortie_v010_finish_direct_unit", "sortie_v010_operator_status", "sortie_v010_release_write_gate"]) {
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

for (const custom of [false, true]) test(`location-only candidate reconciles released Reviewer observation text without overwriting custom instructions: ${custom}`, async () => {
  const fixture = contextFixture();
  const current = runtimeAssets.find(asset => asset.name === "dog-reviewer-v010")!.content.split("---").slice(2).join("---");
  const observed = "Use the exposed read/search and native shell observations directly. Observe existing state without\n" +
    "mutating the candidate; actual correction uses repair_review in this same context. Native user permissions remain authoritative.";
  const legacy = "Use the exposed read/search tools directly. Shell is unavailable during the initial read-only phase;\n" +
    "do not enumerate the tool catalog to find an unavailable terminal. Correction uses native shell normally.";
  const system = current.replace(observed, legacy) + (custom ? "\nCustom instruction remains authoritative." : "");
  const reviewer = { system, permissions: [...nativeReviewerRoleRules], model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } };
  const web = reviewer.permissions.findIndex(rule => rule.action === "webfetch");
  reviewer.permissions.splice(web, 0, { action: "shell", resource: "*", effect: "deny" });
  const registry: Record<string, any> = { "dog-reviewer-v010": reviewer };
  fixture.context.agent!.transform = async callback => {
    callback({ get: id => registry[id], update: (id, update) => update(registry[id] ??= {}) });
    return { dispose() {} };
  };
  const cleanup = await createSortieDogsV2Plugin(async () => ({})).setup(fixture.context);
  try {
    assert.equal(reviewer.system, custom ? system : current);
    assert(!reviewer.permissions.some(rule => rule.action === "shell" && rule.effect === "deny"));
    assert.deepEqual(reviewer.model, { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
  } finally { cleanup?.(); }
});

for (const custom of [false, true]) test(`released Operator receives result-and-hold guidance only for the exact shipped body: ${custom}`, async () => {
  const fixture = contextFixture();
  const current = runtimeAssets.find(asset => asset.name === "dog-operator")!.content.split("---").slice(2).join("---");
  const legacy = current.replace(`${MISSION_RESULT_HOLD_POLICY}\n\n`, "")
    .replace(MISSION_REFLECTION_WORKFLOW, LEGACY_MISSION_REFLECTION_WORKFLOW);
  const operator = { system: legacy + (custom ? "\nKeep my custom policy." : ""), model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } };
  const original = operator.system;
  fixture.context.agent!.transform = async callback => {
    callback({ update: (id, update) => { if (id === "dog-operator") update(operator); } });
    return { dispose() {} };
  };
  const cleanup = await createSortieDogsV2Plugin(async () => ({})).setup(fixture.context);
  try {
    assert.equal(operator.system, custom ? original : current);
    assert.deepEqual(operator.model, { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
    assert.match(current, /result-and-hold checkpoint is not final acceptance/);
    assert.match(current, /reflection is optional checkpoint bookkeeping/);
    assert.match(current, /never create a reflection-only model turn/);
  } finally { cleanup?.(); }
});

for (const custom of [false, true]) test(`late native role materialization reconciles only the exact Operator model-input part: ${custom}`, async () => {
  const fixture = contextFixture();
  const current = runtimeAssets.find(asset => asset.name === "dog-operator")!.content.split("---").slice(2).join("---");
  const legacy = current.replace(`${MISSION_RESULT_HOLD_POLICY}\n\n`, "").replace(MISSION_REFLECTION_WORKFLOW, LEGACY_MISSION_REFLECTION_WORKFLOW);
  const role = { type: "text", text: legacy + (custom ? "\nMy custom instruction." : "") };
  const user = { type: "text", text: "Unrelated project instructions" };
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async () => {}, "experimental.session.compacting": async () => {},
  })).setup(fixture.context);
  try {
    for (const name of ["context", "compaction"]) {
      const event = { sessionID: "root", agent: "dog-operator", system: [role, user], messages: [], tools: {} };
      await fixture.sessionHooks.get(name)!(event);
      assert.equal(event.system[0]!.text, custom ? role.text : current);
      assert.equal(event.system[1], user);
      assert.equal(role.text, legacy + (custom ? "\nMy custom instruction." : ""), "saved role is not mutated");
    }
    const build = { sessionID: "root", agent: "build", system: [role], messages: [], tools: {} };
    await fixture.sessionHooks.get("context")!(build);
    assert.equal(build.system[0], role);
  } finally { cleanup?.(); }
});

test("background adapter retains rewritten host output for the real completion request and compaction, without another prompt", async () => {
  const fixture = contextFixture(), histories: Record<string, any[]> = { root: [], child: [] };
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: sessionID === "child" ? "dog-reviewer-v010" : "dog-operator",
    model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" }, ...(sessionID === "child" ? { parentID: "root" } : {}) });
  fixture.context.session.context = async ({ sessionID }) => histories[sessionID] ?? [];
  let settlements = 0;
  const factory: OpenCodePlugin = async () => ({
    "tool.execute.before": async () => {}, "chat.message": async () => {},
    "experimental.chat.system.transform": async () => {}, "experimental.session.compacting": async () => {},
    "tool.execute.after": async (_input, output) => {
      if ((output.metadata as any)?.status === "running") return;
      settlements++;
      output.output = JSON.stringify({ completion_receipt: { status: "review-correction-recorded", native_call: "call", independent: false },
        acceptance_summary: { original_requests: "full diagnostic detail" } });
    },
  });
  let cleanup = await createSortieDogsV2Plugin(factory).setup(fixture.context);
  try {
    const dispatch = { sessionID: "root", tool: "subagent", id: "call", input: { agent: "dog-reviewer-v010", prompt: "review", background: true } };
    await fixture.toolHooks.get("execute.before")!(dispatch);
    await fixture.sessionHooks.get("prompt")!({ sessionID: "child", messageID: "prompt", prompt: { text: "review" } });
    histories.child!.push({ id: "prompt", type: "user" });
    await fixture.toolHooks.get("execute.after")!({ ...dispatch, status: "completed", result: { content: "Job running", metadata: { status: "running", sessionID: "child" } } });
    histories.child!.push({ id: "terminal", type: "assistant", finish: "stop", content: [{ type: "text", text: "SELF_RECHECKED" }] });
    const text = '<subagent sessionID="child" state="completed">\nSELF_RECHECKED\n</subagent>';
    histories.root!.push({ type: "synthetic", text, time: { created: Date.now() }, metadata: { source: "subagent", childID: "child", state: "completed" } });
    const native = [{ role: "user", content: [{ type: "text", text }] }];
    for (const hook of ["context", "compaction"]) {
      const event = { sessionID: "root", system: [], messages: native, tools: {} };
      await fixture.sessionHooks.get(hook)!(event);
      assert.equal(event.messages.length, 2);
      assert.match(JSON.stringify(event.messages[1]), /review-correction-recorded/);
      assert.doesNotMatch(JSON.stringify(event.messages[1]), /full diagnostic detail/);
      assert.equal(event.messages[0], native[0]);
    }
    cleanup?.(); cleanup = await createSortieDogsV2Plugin(factory).setup(fixture.context);
    const event = { sessionID: "root", system: [], messages: native, tools: {} };
    await fixture.sessionHooks.get("context")!(event);
    assert.match(JSON.stringify(event.messages[1]), /review-correction-recorded/);
    assert.equal(settlements, 1); assert.equal(fixture.synthetic.length, 0);
  } finally { cleanup?.(); }
});

test("background settlement inspection failure leaves prompt, context and compaction usable without accepting or relaunching", async () => {
  const fixture = contextFixture(), histories: Record<string, any[]> = { root: [], child: [] };
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID,
    agent: sessionID === "child" ? "dog-worker-v010" : "dog-operator",
    ...(sessionID === "child" ? { parentID: "root" } : {}) });
  fixture.context.session.context = async ({ sessionID }) => histories[sessionID] ?? [];
  let broken = true, settlements = 0, admissions = 0;
  const factory: OpenCodePlugin = async () => ({
    "tool.execute.before": async () => { admissions++; }, "chat.message": async () => {},
    "experimental.chat.system.transform": async (_input, output) => { output.system = ["CURRENT_MISSION"]; },
    "experimental.session.compacting": async (_input, output) => { output.context = ["ORIGINAL_REQUIREMENTS_AND_SPEND"]; },
    "tool.execute.after": async (_input, output) => {
      if ((output.metadata as any)?.status === "running") return;
      if (broken) throw new Error("git ls-files: internal error - directory entry not superset of prefix");
      settlements++;
      output.output = "Saved native result; formal acceptance still pending";
    },
  });
  let cleanup = await createSortieDogsV2Plugin(factory).setup(fixture.context);
  try {
    const dispatch = { sessionID: "root", tool: "subagent", id: "call_inspection_failure",
      input: { agent: "dog-worker-v010", prompt: "publish once", background: true } };
    await fixture.toolHooks.get("execute.before")!(dispatch);
    await fixture.sessionHooks.get("prompt")!({ sessionID: "child", messageID: "prompt", prompt: { text: "publish once" } });
    histories.child!.push({ id: "prompt", type: "user" });
    await fixture.toolHooks.get("execute.after")!({ ...dispatch, status: "completed",
      result: { content: "Job running", metadata: { status: "running", sessionID: "child" } } });
    histories.child!.push({ id: "terminal", type: "assistant", finish: "stop", content: [{ type: "text", text: "Published once" }] });
    for (const reload of [false, true]) {
      if (reload) { cleanup?.(); cleanup = await createSortieDogsV2Plugin(factory).setup(fixture.context); }
      const prompt = { text: "Report the saved result without republishing" };
      await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "followup", prompt });
      assert.equal(prompt.text, "Report the saved result without republishing");
      for (const hook of ["context", "compaction"]) {
        const event = { sessionID: "root", agent: "dog-operator", system: [], messages: [], tools: {} };
        await fixture.sessionHooks.get(hook)!(event);
        assert.match(JSON.stringify(event.system), /SORTIE_BACKGROUND_RECONCILIATION_UNAVAILABLE/);
        assert.match(JSON.stringify(event.system), /directory entry not superset of prefix/);
        assert.match(JSON.stringify(event.system), /acceptance.*not.*proven/i);
        assert.match(JSON.stringify(event.system), hook === "context" ? /CURRENT_MISSION/ : /ORIGINAL_REQUIREMENTS_AND_SPEND/);
      }
      const saved = await fixture.context.storage!.get("v2-background-dispatches:root") as any[];
      assert.equal(saved[0].terminal, "succeeded", "native completion survives inspection failure");
      assert.notEqual(saved[0].settled, true, "inspection failure must remain recoverable, never a fabricated PASS");
      assert.equal(saved[0].result, undefined);
    }
    broken = false;
    for (let i = 0; i < 2; i++) {
      const event = { sessionID: "root", agent: "dog-operator", system: [], messages: [], tools: {} };
      await fixture.sessionHooks.get("context")!(event);
      assert.doesNotMatch(JSON.stringify(event.system), /SORTIE_BACKGROUND_RECONCILIATION_UNAVAILABLE/);
    }
    const saved = await fixture.context.storage!.get("v2-background-dispatches:root") as any[];
    assert.equal(saved[0].settled, true);
    assert.equal(saved[0].result, "Saved native result; formal acceptance still pending");
    assert.equal(settlements, 1); assert.equal(admissions, 1); assert.equal(fixture.synthetic.length, 0);
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

for (const heading of ["帰還報告", "Return Report"]) for (const format of ["legacy", "compact", "summary"]) test(`V2 final request retains the verbatim host return card (${heading}, ${format}); only compaction omits it without mutating history`, async () => {
  const fixture = contextFixture();
  const card = format === "legacy"
    ? `<details>\n<summary><strong>🐾 SORTIE DOGS — ${heading}</strong></summary>\n\nfull host metrics\n\n</details>`
    : `\`\`\`text\n🐾 SORTIE DOGS — ${heading}｜🟢 Complete\nsummary host metrics\n\`\`\`${format === "compact" ? `\n\n<details>\n<summary>📜 ${heading === "帰還報告" ? "詳細記録" : "Detailed record"}</summary>\n\nrecord\n\n</details>` : ""}`;
  const packet = { status: "succeeded", run_id: "run", acceptance_fingerprint: "sha256:accepted",
    receipt: { status: "succeeded", goal_id: "goal", evidence_refs: ["sha256:check"] },
    limitations: ["unknown usage"], return_report: card, return_report_instruction: "Append return_report verbatim once" };
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
    const pending = { sessionID: "root", agent: "dog-operator", system: [], messages, tools: {} };
    await fixture.sessionHooks.get("compaction")!(pending);
    assert.deepEqual(pending.messages, original, "compaction before final delivery must retain the current turn's exact card and instruction");
    for (const hook of ["context", "compaction"]) {
      const event = { sessionID: "root", agent: "dog-operator", system: [],
        messages: [...messages, { role: "user", content: [{ type: "text", text: "Next request" }] }], tools: {} };
      await fixture.sessionHooks.get(hook)!(event);
      assert.deepEqual(messages, original, "projection never changes saved messages or packet objects");
      for (const index of [2, 3, 4]) {
        const part = event.messages[index].content[0] as any;
        const projected = part.result.type === "json" ? part.result.value
          : JSON.parse(part.result.type === "text" ? part.result.value : part.result.value[0].text);
        if (hook === "context") {
          assert.deepEqual(projected, packet, "the actual final model request must contain the exact host metrics and delivery instruction");
          assert.equal(projected.return_report, card);
        } else {
          const { return_report: _card, return_report_instruction: _instruction, ...preserved } = packet;
          assert.deepEqual(projected, { ...preserved, return_report_retained: projected.return_report_retained,
            return_report_instruction: projected.return_report_instruction });
          assert.match(projected.return_report_retained, /saved in this tool result/);
          assert.match(projected.return_report_instruction, /Do not regenerate or repeat/);
          assert.equal(projected.return_report, undefined);
        }
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
    const nativeCall = history.find((message: any) => message.info.id === "msg_worker").parts[0];
    assert.equal(nativeCall.sessionID, "worker");
    assert.equal(nativeCall.callID, "call_build");
    assert.equal(nativeCall.state.input.command, "npm run build");
    assert.deepEqual(nativeCall.state.time, { start: 100, end: 200 },
      "the native V2 call ID, command, session owner and terminal times survive the existing adapter");
    assert.deepEqual(observedMissionValidation(["npm run build", "node check.mjs"], "worker", history), {
      attempts: [
        { command: "npm run build", exit_code: 0, started_ms: 100, completed_ms: 200 },
        { command: "node check.mjs", exit_code: 0, started_ms: 250, completed_ms: 300 },
      ], not_observed: [], omitted_attempts: 0,
    });
  } finally { cleanup?.(); }
});

test("V2 adapter retains Docker codemode command/result as native observation without inferring cwd", async () => {
  const fixture = contextFixture(), command = "python3 /app/verify.py";
  const code = `const r = await tools.fh.docker_exec({command:${JSON.stringify(command)}}); return r;`;
  fixture.history.push({ id: "msg_docker_worker", type: "assistant", agent: "dog-worker-v010", content: [{
    type: "tool", id: "call_docker_verify", name: "execute",
    state: { status: "completed", input: { code }, metadata: { toolCalls: [{ tool: "fh.docker_exec", status: "completed", input: { command } }] },
      content: [{ type: "text", text: "exit_code=0\nPASS\n" }] },
    time: { created: 99, ran: 100, completed: 110 },
  }], time: { created: 99, completed: 111 } });
  let client: any;
  const cleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    const history = (await client.session.messages({ path: { id: "worker" } })).data;
    const nativeCall = history.find((message: any) => message.info.id === "msg_docker_worker").parts[0];
    assert.equal(nativeCall.tool, "execute");
    assert.deepEqual(nativeCall.state.input, { code }, "the outer codemode call remains intact");
    assert.deepEqual(nativeCall.state.metadata.toolCalls, [{ tool: "fh.docker_exec", status: "completed", input: { command } }]);
    assert.equal(nativeCall.state.output, "exit_code=0\nPASS\n");
    assert.deepEqual(nativeCall.state.time, { start: 100, end: 110 });
    assert.deepEqual(await observedMissionValidationSummary([command], "worker", async () => ({ data: history }), 50), {
      commands: [{ command, directory_status: "unobserved", exit_code: 0, observed_attempts: 1,
        latest_started_ms: 100, latest_completed_ms: 110 }],
      not_observed: [], omitted_attempts: 0,
      details_ref: { method: "session.messages", session_id: "worker",
        omitted: "full native tool records and repeated attempts; summary contains only declared commands and observed exits" },
    });
  } finally { cleanup?.(); }
});

for (const interrupted of [false, true]) test(`V2 durable shell completion reconciles stale launch metadata only for the exact native invocation${interrupted ? " after interrupted launch" : ""}`, async () => {
  const fixture = contextFixture(), command = "node check.mjs";
  const launch = { id: "background-call", type: "tool", name: "shell", time: { created: 100, ran: 101, completed: 110 },
    state: { status: interrupted ? "error" : "completed", input: { command, background: true }, metadata: { ...(interrupted ? {} : { status: "running" }), shellID: "sh_exact" } } };
  const unproven = interrupted ? "unknown" : "running";
  fixture.history.push({ id: "background-message", type: "assistant", content: [launch] });
  const terminal = { id: "native-shell-end", type: "synthetic", description: command, time: { created: 105 },
    metadata: { source: "shell", shellID: "sh_exact", jobID: "sh_exact", state: "completed", exit: 7 },
    text: "Process failed; this text is not terminal authority." };
  let client: any;
  const cleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    const read = async () => (await client.session.messages({ path: { id: "root" } })).data
      .find((m: any) => m.info.id === "background-message").parts[0];
    assert.equal((await read()).state.metadata.status, unproven);
    for (const changed of [
      { metadata: { ...terminal.metadata, source: "subagent" } },
      { metadata: { ...terminal.metadata, shellID: "sh_other" } },
      { metadata: { ...terminal.metadata, jobID: "sh_other" } },
      { metadata: { ...terminal.metadata, state: "running" } },
      { description: "node other.mjs" }, { time: { created: 100 } }, { type: "user" }, { sessionID: "other" },
    ]) {
      fixture.history.push({ ...terminal, ...changed });
      assert.equal((await read()).state.metadata.status, unproven, JSON.stringify(changed));
      fixture.history.pop();
    }
    fixture.history.push(terminal, structuredClone(terminal));
    assert.equal((await read()).state.metadata.status, unproven, "ambiguous duplicate records do not release a writer");
    fixture.history.pop();
    const ended = await read();
    assert.equal(ended.state.metadata.status, "completed", "nonzero process exit still proves quiescence, not success");
    assert.equal(ended.state.metadata.exit, undefined, "no foreground validation exit is invented");
    assert.deepEqual(ended.state.time, { start: 101, end: 110 }, "launch time is not rewritten as process completion");
    assert.equal(launch.state.metadata.status, interrupted ? undefined : "running", "durable native source is never edited");
    for (const created of [101, 105, 200]) {
      fixture.history[fixture.history.length - 1] = { ...terminal, time: { created } };
      assert.equal((await read()).state.metadata.status, "completed", "a short job can finish before its launch tool ends");
    }
    assert.equal(observedMissionValidation([command], "root", (await client.session.messages({ path: { id: "root" } })).data).attempts[0]!.exit_code,
      null, "background lifecycle completion supplies no successful formal validation exit");
  } finally { cleanup?.(); }
});

for (const { legacy, commit, cancel, fabric, permission, directRecovery, interruptedLaunch, join: joinScenario, reviewJoin, managed: managedScenario, objectRestore, nestedBackground } of [
  ...["replan", "handoff"].flatMap(directRecovery => [false, true].map(interruptedLaunch =>
    ({ legacy: false, commit: false, cancel: false, directRecovery, interruptedLaunch }))),
  ...["allow", "deny", "ask", "cancel", "deny-retry", "ask-retry", "retry-denied", "v1", "v1-no-exit", "v1-cancelled"]
    .map(permission => ({ legacy: false, commit: false, cancel: false, fabric: true, permission })),
  { legacy: false, commit: false, cancel: false }, { legacy: false, commit: false, cancel: false, join: true },
  ...["passed", "failed", "source-changed", "environment-changed", "source-before", "environment-before", "permission-denied",
    "owner-cancelled", "waiter-cancelled", "required-occurrence", "timeout-mismatch", "background-mismatch", "environment-mismatch"]
    .map(reviewJoin => ({ legacy: false, commit: false, cancel: false, reviewJoin })),
  { legacy: false, commit: false, cancel: false, managed: true },
  { legacy: false, commit: false, cancel: false, managed: "required" },
  { legacy: false, commit: false, cancel: false, managed: "focused" },
  { legacy: false, commit: false, cancel: false, managed: "pytest-nodeid" },
  { legacy: false, commit: false, cancel: false, managed: "router" },
  { legacy: false, commit: false, cancel: false, managed: "router-required" },
  { legacy: false, commit: false, cancel: false, objectRestore: true },
  { legacy: false, commit: false, cancel: false, nestedBackground: "cold" },
  { legacy: false, commit: false, cancel: false, nestedBackground: "storage-error" },
  ...["idle-pass", "idle-failed-check", "idle-failed-native", "idle-later-turn"].map(nestedBackground =>
    ({ legacy: false, commit: false, cancel: false, nestedBackground })),
  ...["foreground-cold-pass", "foreground-cold-fail", "foreground-settlement-error"].map(nestedBackground =>
    ({ legacy: false, commit: false, cancel: false, nestedBackground })),
  { legacy: true, commit: false, cancel: false }, { legacy: false, commit: true, cancel: false },
  { legacy: false, commit: "linked-identity", cancel: false },
  { legacy: false, commit: false, cancel: true }])
test(nestedBackground?.startsWith("idle-") ? `V2 nested Worker ${nestedBackground} reconciles the native idle history` :
  nestedBackground?.startsWith("foreground-") ? `V2 nested Worker ${nestedBackground} preserves exact checks and accounting` :
  nestedBackground === "storage-error" ? "V2 Coordinator settles a Worker whose background admission fails before launch" :
  nestedBackground ? "V2 Coordinator reconciles an implicitly background Worker with a failed check" :
  objectRestore ? "V2 Worker restores a scoped Git commit object with quoted Python display data" :
  commit === "linked-identity" ? "V2 direct Coordinator permits scoped linked worktree identity and unsigned commit" :
  managedScenario === "router-required" ? "V2 formally required project router full is not deferred" :
  managedScenario === "router" ? "V2 project router defers covered full after real focused failure" :
  managedScenario === "required" ? "V2 formally required full execution survives an unresolved focused failure" :
  managedScenario === "pytest-nodeid" ? "V2 obsolete pytest node ID permits the native full run" :
  managedScenario === "focused" ? "V2 registered focused failure defers undeclared full until a fresh native retry" :
  managedScenario ? "V2 undeclared full runner preserves each native execution in a normal Mission" :
  `V2 ${reviewJoin ? `controller joins Worker validation ${reviewJoin}` : directRecovery ? `interrupted direct ${directRecovery}${interruptedLaunch ? " with shell progress only" : ""}` : fabric ? `parallel native validation ${permission}` : cancel ? "cancelled Worker cannot reactivate" : joinScenario ? "joined native check" : commit ? "auto-bound commit and independent review" : legacy ? "saved absolute" : "relative"} mission controls survive Operator correction and cold resume`,
{ skip: process.platform === "win32" && (objectRestore || managedScenario === "router" || managedScenario === "router-required") }, async (context) => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/swebench-night-long-project-root-"));
  const exec = promisify(execFile);
  const history: Record<string, Record<string, unknown>[]> = {};
  const logs: Record<string, Record<string, unknown>[]> = {};
  const agents: Record<string, { agent: string; parentID?: string; outcome?: string; time?: { busy: number; idle: number } }> = {
    root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    first: { agent: "dog-worker-v010", parentID: "coordinator" }, second: { agent: "dog-worker-v010", parentID: "coordinator" },
    reviewer: { agent: "dog-reviewer-v010", parentID: "coordinator" },
    unrelated: { agent: "build", parentID: "root" },
  };
  let fixture = contextFixture(), cleanup: (() => void) | void, counter = 0;
  let failBackgroundWrite = false;
  let failForegroundAfter = false;
  const storage = fixture.context.storage!;
  const retainedStorage = { ...storage, set: async (key: string, value: unknown) => {
    if (failBackgroundWrite && key === "v2-background-dispatches:coordinator") {
      failBackgroundWrite = false;
      throw new Error("fixture background storage unavailable");
    }
    await storage.set(key, value);
  } };
  const originalPath = process.env.PATH;
  const originalRouterEnvironment = { HOME: process.env.HOME, npm_config_userconfig: process.env.npm_config_userconfig,
    npm_config_globalconfig: process.env.npm_config_globalconfig };
  let joinedPermission!: () => void;
  const joinPermitted = new Promise<void>(resolve => { joinedPermission = resolve; });
  let loseNextAfter = false;
  let projectionRace: { path: string; source: string } | undefined;
  const start = async () => {
    fixture = contextFixture();
    if (joinScenario || reviewJoin) fixture.context.permission.assert = async request => {
      assert.equal(request.action, "shell"); assert.match(request.resources[0]!, /^node check\.mjs /u);
      if (reviewJoin) assert.equal(request.sessionID, "root");
      joinedPermission();
      if (reviewJoin === "permission-denied") throw new Error("native permission denied");
    };
    cleanup = await createSortieDogsV2Plugin(async (input, options) => {
      const hooks = await SortieDogsV010Plugin(input, options);
      const after = hooks["tool.execute.after"];
      hooks["tool.execute.after"] = async (request, output) => {
        if (failForegroundAfter && request.tool === "task" && request.sessionID === "coordinator") {
          failForegroundAfter = false;
          throw new Error("fixture foreground accounting unavailable");
        }
        if (permission?.startsWith("v1") && request.sessionID === "coordinator" && ["bash", "shell"].includes(request.tool)) {
          delete output.status;
          if (permission === "v1-no-exit") delete output.metadata?.exit;
          if (permission === "v1-cancelled") output.metadata = { ...output.metadata, status: "cancelled" };
          assert.equal(output.status, undefined, "exercise the raw V1 after-hook contract");
          await after?.({ ...request, tool: "bash" }, output);
          return;
        }
        if (projectionRace && request.tool === "read" && request.nativeReadHash) {
          const race = projectionRace; projectionRace = undefined;
          await writeFile(race.path, race.source);
        }
        await after?.(request, output);
      };
      return hooks;
    }).setup({ ...fixture.context, location: { directory }, ...(nestedBackground ? { storage: retainedStorage } : {}),
      ...(directRecovery ? { message: { list: async ({ sessionID }: { sessionID: string }) =>
        ({ data: history[sessionID] ?? [], cursor: {} }) } } : {}),
      ...(fabric ? { agent: { ...fixture.context.agent, get: async () => ({ model: {
        providerID: "openai", id: "gpt-6-luna-fast", variant: "max",
      } }) } } : {}),
      session: { ...fixture.context.session,
        active: async () => ({}),
        interrupt: async () => ({ interrupted: false }),
        list: async ({ parentID }) => ({ data: Object.entries(agents).filter(([, info]) => info.parentID === parentID)
          .map(([id, info]) => ({ id, ...info })), cursor: { next: null } }),
        get: async ({ sessionID }) => ({ id: sessionID, ...agents[sessionID], model: { providerID: "openai",
          id: agents[sessionID]?.agent === "dog-worker-v010" ? "gpt-6-luna-fast" : "gpt-6-sol", variant: "max" } }),
        context: async ({ sessionID }) => history[sessionID] ?? [],
        ...(nestedBackground ? { log: async function* ({ sessionID }: { sessionID: string }) {
          for (const event of logs[sessionID] ?? []) yield event;
        } } : {}),
      }, message: { list: async ({ sessionID, order }) => ({
        data: order === "desc" ? [...(history[sessionID] ?? [])].reverse() : history[sessionID] ?? [], cursor: {},
      }) } });
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
    if (loseNextAfter) { loseNextAfter = false; return content; }
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
    if (reviewJoin) await writeFile(join(directory, "check.mjs"), `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync('.git/sortie-dogs/join-count', 'run\\n'); process.stdout.write('started\\n');
const deadline = Date.now() + 15000;
while (!existsSync('.git/sortie-dogs/join-release') && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
process.exit(existsSync('.git/sortie-dogs/join-release') ? ${reviewJoin === "failed" ? 7 : 0} : 124);\n`);
    await start();
    if (fabric) {
      await writeFile(join(directory, "check.mjs"), 'import {readFileSync} from "node:fs"; if(readFileSync(`${process.argv[2]}.txt`, "utf8") !== "ready\\n") process.exit(1); console.log("PASS");\n');
      await exec("git", ["add", "check.mjs"], { cwd: directory });
      await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
        "commit", "-qm", "base"], { cwd: directory });
      const original = "Create independent first.txt and second.txt in parallel managed worktrees";
      await prompt("root", original);
      const mission = await tool("root", "start_mission", { requirements: ["Create first.txt", "Create second.txt"] });
      const coordinator = await before("root", "subagent", nativeTask(mission.task));
      await prompt("coordinator", String(coordinator.input.prompt));
      const plan = await tool("coordinator", "plan_units", { parallel: true, executor: "worker", units: ["first", "second"].map((name, i) => ({
        title: name, objective: `Create ${name}.txt`, read: ["check.mjs"], write: [`${name}.txt`],
        validation: [`node check.mjs ${name}`], requirement_ids: [`R${i + 1}`],
      })) });
      assert.equal(plan.tasks?.length, 2, JSON.stringify({ plan, state: await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root") }));
      const calls = await Promise.all(plan.tasks.map((task: Record<string, unknown>) => before("coordinator", "subagent",
        { ...nativeTask(task), model: task.model })));
      assert.ok(calls.every(call => call.input.model === "openai/gpt-6-luna-fast#max"));
      for (const i of [1, 0]) {
        const child = ["first", "second"][i]!;
        const expanded = await prompt(child, String(calls[i]!.input.prompt));
        const state = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        const unit = state.units[i]!;
        const handoff = /^handoff_path: (.+)$/m.exec(expanded)![1]!;
        assert.equal(handoff, unit.handoffPath, "managed-root handoff stays absolute across outward and cold prompt projection");
        assert.ok(isAbsolute(handoff));
        const read = await before(child, "read", { path: handoff, limit: 2000 });
        assert.match(await after(read, await readFile(handoff, "utf8")), /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/);
        const recovery = { sessionID: child, agent: "dog-worker-v010", system: [] as { text: string }[], tools: {} };
        await fixture.sessionHooks.get("context")!(recovery);
        const context = JSON.parse(recovery.system.find(part => part.text.startsWith("SORTIE_WORKER_CONTEXT\n"))!.text.split("\n")[1]!);
        assert.equal(context.project_root, unit.fabricRoot);
        assert.equal(context.handoff_path, handoff);
      }
      for (const [i, child] of ["first", "second"].entries()) {
        const state = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), unit = state.units[i]!;
        const target = join(unit.fabricRoot!, `${child}.txt`);
        const patch = await before(child, "patch", { patchText: `*** Begin Patch\n*** Add File: ${target}\n+ready\n*** End Patch` });
        await writeFile(target, "ready\n"); await after(patch, "Created file");
        const check = await before(child, "shell", { command: `node check.mjs ${child}`, workdir: unit.fabricRoot });
        await exec(process.execPath, ["check.mjs", child], { cwd: unit.fabricRoot });
        await after(check, "PASS", { exit: 0 });
        agents[child]!.outcome = "succeeded";
        const settled = await after(calls[i]!, "Validation passed", { sessionID: child });
        assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[i]!.status, "succeeded", settled);
      }
      const reviewInput = { risk_tags: ["public-logic"], traces: ["R1: first.txt checked", "R2: second.txt checked"] };
      for (const child of ["first", "second"]) {
        const pending = await tool("coordinator", "review_mission", reviewInput);
        assert.equal(pending.status, "awaiting-native-validation");
        assert.equal(pending.native_tool, "shell");
        assert.equal(pending.input.command, `node check.mjs ${child}`);
        await assert.rejects(readFile(join(directory, "first.txt")), /ENOENT/, "Review preparation cannot run or apply checks itself");
        let check = await before("coordinator", "shell", pending.input);
        const recovering = ["deny-retry", "ask-retry", "retry-denied"].includes(permission!);
        const effect = recovering && child === "second" ? "allow" : permission?.startsWith("ask") ? "ask"
          : permission?.startsWith("deny") || permission === "retry-denied" ? "deny" : "allow";
        const permissionEvent = { sessionID: "coordinator", action: "shell", resources: [pending.input.command], effect };
        await fixture.permissionHooks.get("evaluate")!(permissionEvent);
        assert.equal(permissionEvent.effect, effect, "existing native ask/deny is never upgraded");
        if (effect !== "allow" || permission === "cancel") {
          if (permission === "cancel") await tool("root", "cancel_operator", { reason: "Cancel pending combined validation" });
          const failed = { ...check, status: "error", error: { message: "Native permission rejected or pending ask cancelled" } };
          await fixture.toolHooks.get("execute.after")!(failed);
          const runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE), state = await runtime.required("root");
          assert.equal(state.fabric!.nativeCall, undefined);
          assert.equal(state.fabric!.phase, "validating");
          if (permission === "cancel") assert.equal(state.phase, "cancelled");
          assert.equal(state.dispatched, 2);
          if (permission !== "cancel") {
            const retry = await tool("coordinator", "review_mission", reviewInput);
            assert.equal(retry.status, "awaiting-native-validation");
            assert.equal(retry.retry_of, `fabric-native:coordinator:${check.id}`);
            assert.deepEqual(retry.input, pending.input);
          }
          const ledger = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
            `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
          assert.equal(ledger.state.validation_budget.reservations.length, 0);
          const settled = ledger.records.filter(({ event }) => event.kind === "validation.settled").at(-1)!.event as any;
          assert.equal(settled.exit_code, null);
          await assert.rejects(readFile(join(directory, "first.txt")), /ENOENT/);
          if (!recovering) return;
          const consumed = ledger.state.validation_budget.consumed;
          cleanup?.(); await start();
          check = await before("coordinator", "shell", pending.input);
          const permitted = { sessionID: "coordinator", action: "shell", resources: [pending.input.command],
            effect: permission === "retry-denied" ? "deny" : "allow" };
          await fixture.permissionHooks.get("evaluate")!(permitted);
          assert.equal(permitted.effect, permission === "retry-denied" ? "deny" : "allow");
          const retryLedger = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
            `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
          assert.equal(retryLedger.state.validation_budget.consumed, consumed + 1);
          assert.equal(retryLedger.state.validation_budget.reservations.length, 1);
          await assert.rejects(before("coordinator", "shell", pending.input), /not-ready/);
          if (permission === "retry-denied") {
            await fixture.toolHooks.get("execute.after")!({ ...check, status: "error", error: { message: "Native denial retained" } });
            await assert.rejects(tool("coordinator", "review_mission", reviewInput), /native-validation-interrupted/);
            await assert.rejects(before("coordinator", "shell", pending.input), /duplicate-evidence/);
            await assert.rejects(readFile(join(directory, "first.txt")), /ENOENT/);
            return;
          }
        }
        await exec(process.execPath, ["check.mjs", child], { cwd: pending.input.workdir });
        cleanup?.(); await start();
        loseNextAfter = child === "first" && !permission?.startsWith("v1");
        await after(check, "PASS", { exit: 0 });
        if (["v1-no-exit", "v1-cancelled"].includes(permission!)) {
          const ledger = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
            `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
          const settled = ledger.records.filter(({ event }) => event.kind === "validation.settled").at(-1)!.event as any;
          assert.equal(settled.outcome, permission === "v1-no-exit" ? "interrupted" : "cancelled");
          assert.equal(ledger.state.validation_budget.reservations.length, 0);
          await assert.rejects(readFile(join(directory, "first.txt")), /ENOENT/);
          return;
        }
      }
      const review = await tool("coordinator", "review_mission", reviewInput);
      assert.ok(review.task, JSON.stringify(review));
      assert.equal(await readFile(join(directory, "first.txt"), "utf8"), "ready\n");
      const final = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(final.fabric!.checks.length, 2);
      assert.equal(final.fabric!.phase, "applied");
      assert.ok(final.fabric!.checks.every(check => check.authority === "native-shell-v1"));
      assert.equal(final.dispatched, 2);
      const ledger = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
        `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
      assert.equal(ledger.state.validation_budget.consumed, permission?.endsWith("-retry") ? 5 : 4);
      assert.equal(ledger.state.validation_budget.reservations.length, 0);
      return;
    }
    if (commit === "linked-identity") {
      await writeFile(join(directory, ".gitignore"), ".sortie-dogs-v010/\n");
      await exec("git", ["add", ".gitignore", "check.mjs"], { cwd: directory });
      await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-m", "fixture base"], { cwd: directory });
      await exec("git", ["worktree", "add", "--detach", join(directory, "linked"), "HEAD"], { cwd: directory });
      await mkdir(join(directory, "linked", "src"));
      await writeFile(join(directory, "linked", "src/allowed.txt"), "allowed\n");
      await writeFile(join(directory, "linked", "src/outside.txt"), "outside\n");
    } else if (commit) {
      await exec("git", ["config", "user.name", "Fixture User"], { cwd: directory });
      await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: directory });
      await writeFile(join(directory, ".gitignore"), ".sortie-dogs-v010/\n");
      await exec("git", ["add", ".gitignore", "check.mjs"], { cwd: directory });
      await exec("git", ["commit", "-m", "fixture base"], { cwd: directory });
    }
    if (managedScenario === "router" || managedScenario === "router-required") {
      const project = process.cwd(), pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
      const tools = join(directory, ".git/sortie-dogs/tools");
      process.env.PATH = `${tools}${delimiter}${resolve(project, "node_modules/.bin")}${delimiter}${originalPath ?? ""}`;
      process.env.HOME = join(directory, ".git/sortie-dogs/home");
      process.env.npm_config_userconfig = join(process.env.HOME, ".npmrc");
      process.env.npm_config_globalconfig = join(process.env.HOME, "global.npmrc");
      await mkdir(tools, { recursive: true });
      await mkdir(process.env.HOME, { recursive: true });
      await copyManagedRouterFixture(project, directory);
      await mkdir(join(directory, "src/cli"), { recursive: true });
      await writeFile(join(directory, ".gitignore"), "dist/\n_testenv/\nnode_modules/\n");
      await mkdir(join(directory, "node_modules/@types/node"), { recursive: true });
      await writeFile(join(directory, "node_modules/@types/node/index.d.ts"), "export {};\n");
      await writeFile(join(directory, "src/cli/main.ts"), "export const fixture = true;\n");
      await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", scripts: pkg.scripts }));
      await mkdir(join(directory, "_testenv"), { recursive: true });
      await writeFile(join(directory, "test/fixture.test.ts"),
        `import { appendFileSync, readFileSync } from 'node:fs'; import { test } from 'node:test'; import assert from 'node:assert/strict';\ntest('managed', () => { appendFileSync('.git/sortie-dogs/managed-count', 'run\\n'); assert.notEqual(readFileSync('result.txt', 'utf8'), 'broken\\n'); });\n`);
      for (const name of ["a", "b"]) await writeFile(join(directory, `test/concurrent-${name}.test.ts`),
        `import { existsSync, rmSync, writeFileSync } from 'node:fs'; import { test } from 'node:test'; import assert from 'node:assert/strict';
test('requires exclusive execution', async () => {
  const mine = '.git/sortie-dogs/active-${name}', peer = '.git/sortie-dogs/active-${name === "a" ? "b" : "a"}';
  writeFileSync(mine, 'active');
  try {
    const deadline = Date.now() + 1000;
    while (!existsSync(peer) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.equal(existsSync(peer), false);
  } finally { rmSync(mine, { force: true }); }
});\n`);
      await exec("npm", ["run", "build"], { cwd: directory });
    } else if (managedScenario) {
      await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: {
        all: "npm run suite", suite: "node --test", release: "echo release && node --test",
      } }));
      await writeFile(join(directory, "fixture.test.mjs"),
        `import { appendFileSync, readFileSync } from 'node:fs'; import { test } from 'node:test'; import assert from 'node:assert/strict';\ntest('managed', () => { appendFileSync('.git/sortie-dogs/managed-count', 'run\\n'); assert.notEqual(readFileSync('result.txt', 'utf8'), 'broken\\n'); });\n`);
      if (managedScenario === "pytest-nodeid") await writeFile(join(directory, "test_example.py"), "def test_before():\n    assert False\n");
    }
    const original = `Create result.txt containing ready, and ${commit ? "commit the change" : "leave an uncommitted diff"}.`;
    const objective = `${original} Keep this example text verbatim: handoff_path: /external/example.json`;
    await prompt("root", original);
    const mission = await tool("root", "start_mission", { requirements: [original],
      ...(objectRestore ? { prohibited_write: ["outside.txt"] } : {}) });
    let dispatch = await before("root", "subagent", { ...nativeTask(mission.task), ...(reviewJoin ? { background: true } : {}) });
    await prompt("coordinator", String(dispatch.input.prompt));
    if (reviewJoin) {
      assert.equal(dispatch.input.background, true, "the root retains the normal native background Coordinator launch");
      await after(dispatch, "Coordinator running", { sessionID: "coordinator", status: "running" });
    }
    if (nestedBackground) {
      const command = "node check.mjs ready";
      const plan = await tool("coordinator", "plan_units", { units: [{
        title: "Check fixture", objective: "Check the fixture without erasing failure",
        read: ["check.mjs"], write: ["result.txt"], validation: [command],
      }] });
      const runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
      const unit = (await runtime.required("root")).units[0]!;
      if (nestedBackground === "storage-error") {
        failBackgroundWrite = true;
        await assert.rejects(before("coordinator", "subagent", nativeTask(plan.task)), /fixture background storage unavailable/u);
        const settled = await runtime.required("root");
        assert.equal(settled.units[0]!.status, "failed");
        assert.equal(settled.receipt, null);
        assert.equal(history.first, undefined, "native Worker launch never happened");
        const packet = await tool("coordinator", "operator_next");
        assert.equal(packet.budget.reserved_units, 0);
        assert.equal(packet.budget.consumed_units, 1);
        return;
      }
      const worker = await before("coordinator", "subagent", nativeTask(plan.task));
      assert.equal(worker.input.background, undefined, "use the observed implicit native Job invocation");
      const foreground = nestedBackground.startsWith("foreground-");
      const idleHistory = nestedBackground.startsWith("idle-");
      const succeeds = (foreground && nestedBackground !== "foreground-cold-fail") ||
        nestedBackground === "idle-pass" || nestedBackground === "idle-failed-native" || nestedBackground === "idle-later-turn";
      if (!foreground) await after(worker, "Native Job running", { sessionID: "first", status: "running" });
      const expanded = await prompt("first", String(worker.input.prompt));
      const promptID = String(history.first!.at(-1)!.id);
      const handoff = /^handoff_path: (.+)$/m.exec(expanded)![1]!;
      const read = await before("first", "read", { path: handoff });
      assert.match(await after(read, await readFile(unit.handoffPath, "utf8")), /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/u);
      const value = succeeds ? "ready" : "broken";
      const patch = await before("first", "patch", { patchText: `*** Begin Patch\n*** Add File: result.txt\n+${value}\n*** End Patch` });
      await writeFile(join(directory, "result.txt"), `${value}\n`); await after(patch, "Updated result.txt");
      const validation = await before("first", "shell", { command });
      const checked = await exec(process.execPath, ["check.mjs", "ready"], { cwd: directory })
        .then(result => ({ code: 0, output: result.stdout }), error => ({ code: error.code, output: String(error.stderr) }));
      assert.equal(checked.code, succeeds ? 0 : 1);
      await after(validation, checked.output, { exit: checked.code });
      const beforeTerminal = await runtime.required("root");
      assert.equal(beforeTerminal.units[0]!.status, "running");
      assert.equal(beforeTerminal.units[0]!.validationRegistration!.checks[0]!.exitCode, checked.code);
      if (idleHistory) {
        const pending = await tool("coordinator", "operator_next");
        assert.equal((await runtime.required("root")).units[0]!.status, "running");
        const status = await tool("coordinator", "operator_status");
        assert.equal(status.attempts[0].status, "dispatched");
        await assert.rejects(before("coordinator", "subagent", { ...nativeTask(plan.task), sessionID: "first" }),
          /operator-unit-not-authorized/);
        const now = Date.now();
        const outcome = nestedBackground === "idle-failed-native" ? "failed" : "succeeded";
        if (nestedBackground === "idle-later-turn") history.first!.push(
          { id: `msg_${++counter}`, type: "idle", outcome: "failed", time: { created: now - 2 } },
          { id: `msg_${++counter}`, type: "synthetic", text: "Native follow-up", time: { created: now - 1 } });
        history.first!.push({ id: `msg_${++counter}`, type: "assistant", agent: "dog-worker-v010", finish: "stop",
          time: { created: now, completed: now }, content: [{ type: "text", text: "Worker finished" }] },
        { id: `msg_${++counter}`, type: "idle", outcome, time: { created: now + 1 } });
        agents.first!.outcome = outcome;
        agents.first!.time = { busy: now, idle: now + 1 };
        cleanup?.(); await start();
        const packet = await tool("coordinator", "operator_next");
        const settled = await runtime.required("root");
        if (nestedBackground === "idle-later-turn") {
          assert.equal(settled.units[0]!.status, "running", "a later successful turn cannot settle the original failed Job");
          assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.callID, validation.id);
          assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.exitCode, 0);
          assert.equal(settled.receipt, null);
          const saved = await retainedStorage.get("v2-background-dispatches:coordinator") as Array<Record<string, unknown>>;
          const original = saved.find(dispatch => dispatch.callID === worker.id)!;
          assert.equal(original.terminal, undefined);
          assert.notEqual(original.settled, true, "ambiguous native turns retain the original owner");
          assert.deepEqual(packet.budget, pending.budget);
          const status = await tool("coordinator", "operator_status");
          assert.equal(status.attempts[0].status, "dispatched");
          await assert.rejects(before("coordinator", "subagent", { ...nativeTask(plan.task), sessionID: "first" }),
            /operator-unit-not-authorized/);
          assert.deepEqual((await tool("coordinator", "operator_next")).budget, packet.budget);
          return;
        }
        assert.equal(settled.units[0]!.status, nestedBackground === "idle-pass" ? "succeeded" : "failed", JSON.stringify(packet));
        assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.callID, validation.id);
        assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.exitCode, checked.code);
        assert.equal(settled.receipt, null);
        assert.equal(packet.budget.reserved_units, 0);
        assert.equal(packet.budget.consumed_units, 1);
        assert.deepEqual((await tool("coordinator", "operator_next")).budget, packet.budget);
        return;
      }
      if (foreground) {
        agents.first!.outcome = "succeeded";
        if (nestedBackground === "foreground-settlement-error") {
          failForegroundAfter = true;
          await assert.rejects(after(worker, "Native foreground Worker ended", { sessionID: "first" }),
            /fixture foreground accounting unavailable/u);
          const saved = await retainedStorage.get("v2-background-dispatches:coordinator") as Array<Record<string, unknown>>;
          assert.notEqual(saved.find(dispatch => dispatch.callID === worker.id)!.settled, true,
            "a failed settlement must retain the exact owner and terminal for cold retry");
          assert.equal((await runtime.required("root")).units[0]!.status, "running");
        }
        cleanup?.(); await start();
        if (nestedBackground !== "foreground-settlement-error") {
          await after(worker, "Native foreground Worker ended", { sessionID: "first" });
        }
        const packet = await tool("coordinator", "operator_next");
        const settled = await runtime.required("root");
        assert.equal(settled.units[0]!.status, succeeds ? "succeeded" : "failed", JSON.stringify(packet));
        assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.callID, validation.id);
        assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.exitCode, checked.code);
        if (succeeds) assert.ok(settled.units[0]!.evidence.length > 0, "cold foreground settlement retains native formal evidence");
        assert.equal(settled.receipt, null);
        assert.equal(packet.budget.reserved_units, 0);
        assert.equal(packet.budget.consumed_units, 1);
        const repeated = await tool("coordinator", "operator_next");
        assert.deepEqual(repeated.budget, packet.budget, "repeated reconciliation cannot consume the Worker twice");
        return;
      }
      cleanup?.(); await start();
      const now = Date.now();
      history.first!.push({ id: `msg_${++counter}`, type: "assistant", agent: "dog-worker-v010", finish: "stop",
        time: { created: now, completed: now }, content: [{ type: "text", text: "PROCESS_DEFECT: local: fixture stopped after a failed check" }] });
      agents.first!.outcome = "succeeded";
      // An unrelated earlier terminal cannot settle the admitted prompt.
      logs.first = [{ type: "session.execution.succeeded", created: now - 1, data: { sessionID: "first" } }];
      await fixture.emit({ type: "session.execution.succeeded", created: now, data: { sessionID: "first" } });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await runtime.required("root")).units[0]!.status, "running");
      logs.first.push({ type: "session.inbox.delivered", created: now, data: { sessionID: "first", inboxID: promptID } },
        { type: "session.execution.succeeded", created: now + 1, data: { sessionID: "first" } });
      await fixture.emit({ type: "session.execution.succeeded", created: now + 1, data: { sessionID: "first" } });
      await new Promise<void>(resolve => setImmediate(resolve));
      const packet = await tool("coordinator", "operator_next");
      const settled = await runtime.required("root");
      assert.equal(settled.units[0]!.status, "failed", JSON.stringify(packet));
      assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.exitCode, 1,
        "native success means the Worker ended, not that the failed check passed");
      assert.equal(settled.receipt, null);
      assert.notEqual(packet.units?.[0]?.status, "running");
      assert.equal(packet.budget.reserved_units, 0);
      assert.equal(packet.budget.consumed_units, 1);
      return;
    }
    if (objectRestore) {
      // Mirror the incident: a shallow main repository with a linked worktree and
      // a separate single-branch shared clone under the candidate directory.
      const origin = join(directory, "origin"), controller = join(directory, "controller");
      const linked = join(directory, "controller-linked"), candidate = join(directory, "oracle/candidate-fixed/service-checkout");
      await mkdir(origin);
      await exec("git", ["init", "--quiet", "--initial-branch=master"], { cwd: origin });
      for (const text of ["base\n", "controller\n"]) {
        await writeFile(join(origin, "source.txt"), text);
        await exec("git", ["add", "--", "source.txt"], { cwd: origin });
        await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
          "-c", "commit.gpgsign=false", "commit", "-qm", text.trim()], { cwd: origin });
      }
      await exec("git", ["clone", "--depth=1", "--branch", "master", "--quiet", "--", pathToFileURL(origin).href, controller]);
      assert.equal((await exec("git", ["rev-parse", "--is-shallow-repository"], { cwd: controller })).stdout.trim(), "true");
      const alternates = join(controller, ".git/objects/info/alternates");
      await writeFile(alternates, `${join(origin, ".git/objects")}\n`);
      await exec("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: controller });
      assert.match(await readFile(join(linked, ".git"), "utf8"), /^gitdir: /u);
      await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "linked controller"], { cwd: linked });
      await mkdir(join(directory, "oracle/candidate-fixed"), { recursive: true });
      await exec("git", ["-c", "maintenance.auto=false", "clone", "--shared", "--single-branch", "--branch", "master",
        "--no-checkout", "--no-tags", "--quiet", "--", controller, candidate]);
      const git = async (cwd: string, ...args: string[]) => (await exec("git", ["--no-optional-locks", ...args], { cwd })).stdout;
      const linkedHead = (await git(linked, "rev-parse", "HEAD")).trim();
      await exec("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", candidate, "fetch",
        "--no-tags", "--no-write-fetch-head", "--depth=1", "--update-shallow", "--quiet", linked, linkedHead]);
      await exec("git", ["-c", "maintenance.auto=false", "-C", candidate, "checkout", "--quiet", "--detach", linkedHead]);
      assert.equal((await git(candidate, "rev-parse", "--is-shallow-repository")).trim(), "true");
      assert.equal((await git(candidate, "rev-parse", "HEAD")).trim(), linkedHead);
      const parent = (await git(controller, "rev-parse", "HEAD")).trim();
      const tree = (await git(controller, "rev-parse", "HEAD^{tree}")).trim();
      const sourceState = () => Promise.all([
        git(controller, "rev-parse", "HEAD"), git(controller, "ls-files", "--stage", "-z"),
        git(controller, "for-each-ref"), git(linked, "rev-parse", "HEAD"), git(linked, "ls-files", "--stage", "-z"),
        readFile(join(controller, ".git", "index")), readFile(join(controller, ".git", "shallow")), readFile(alternates),
      ]);
      const originalState = await sourceState();
      const body = `tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\n` +
        `committer Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture product\n`;
      const sha = createHash("sha1").update(`commit ${Buffer.byteLength(body)}\0`).update(body).digest("hex");
      await assert.rejects(git(candidate, "cat-file", "-e", `${sha}^{commit}`));
      const command = `/usr/bin/python3 -B - <<'PY'\n` +
        `import base64, hashlib, os, subprocess\n` +
        `sha=${JSON.stringify(sha)}\ncandidate=${JSON.stringify(candidate)}\n` +
        `body=base64.b64decode(${JSON.stringify(Buffer.from(body).toString("base64"))})\n` +
        `assert hashlib.sha1(b'commit '+str(len(body)).encode()+b'\\0'+body).hexdigest()==sha\n` +
        `env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}\n` +
        `env.update(GIT_NO_LAZY_FETCH='1',GIT_NO_REPLACE_OBJECTS='1',GIT_TERMINAL_PROMPT='0',GIT_OPTIONAL_LOCKS='0')\n` +
        `w=subprocess.run(['git','--no-optional-locks','-C',candidate,'hash-object','-w','-t','commit','--stdin'],input=body,capture_output=True,env=env)\n` +
        `assert w.returncode==0 and w.stdout.strip().decode()==sha\n` +
        `print('exact metadata candidates=1; commit bytes=${Buffer.byteLength(body)}; SHA-1='+sha+'; private Git object written')\nPY`;
      const plan = await tool("coordinator", "plan_units", { units: [{
        title: "Restore fixture object", objective: "Restore only the candidate commit object",
        read: ["check.mjs"], write: ["oracle/candidate-fixed/**", "result.txt"], validation: ["node check.mjs ready"],
      }] });
      const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
      const worker = await before("coordinator", "subagent", nativeTask(plan.task));
      const expanded = await prompt("first", String(worker.input.prompt));
      const handoff = /^handoff_path: (.+)$/m.exec(expanded)![1]!;
      const read = await before("first", "read", { path: handoff });
      assert.match(await after(read, await readFile(unit.handoffPath, "utf8")), /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/u);
      const gate = await createWriteGate(await createProjectPaths(directory), JSON.parse(await readFile(unit.manifestPath, "utf8")), directory);
      const request = { tool: "shell", sessionID: "first", callID: "fixture-mode" };
      await assert.rejects(gate.check(request, { args: { command } }, { investigativeShell: false }), /unclassified command/u);
      await gate.check(request, { args: { command } }, { investigativeShell: true });
      for (const effect of ["deny", "ask", "allow"]) {
        const permission = { sessionID: "first", action: "shell", resources: [command], effect };
        await fixture.permissionHooks.get("evaluate")!(permission);
        assert.equal(permission.effect, effect, "the plugin does not upgrade native permissions");
      }
      // A real commit, including one in the same Python-heredoc representation,
      // remains ambiguous rather than becoming an unchecked index mutation.
      const unsafe = command.replace(
        "w=subprocess.run(['git','--no-optional-locks','-C',candidate,'hash-object','-w','-t','commit','--stdin'],input=body,capture_output=True,env=env)",
        "w=subprocess.run([ 'git' , 'commit' , '--all' , '-m' , 'outside' ],capture_output=True,env=env)");
      await assert.rejects(before("first", "shell", { command: unsafe, timeout: 30000 }), /Write denied/u);
      const unsafeString = command.replace(
        "w=subprocess.run(['git','--no-optional-locks','-C',candidate,'hash-object','-w','-t','commit','--stdin'],input=body,capture_output=True,env=env)",
        "w=__import__('os').system(' git commit -m outside')");
      await assert.rejects(before("first", "shell", { command: unsafeString, timeout: 30000 }), /Write denied/u);
      const unsafePrint = command.replace(
        "w=subprocess.run(['git','--no-optional-locks','-C',candidate,'hash-object','-w','-t','commit','--stdin'],input=body,capture_output=True,env=env)",
        "print=__import__('os').system\nprint(' git commit -m outside')");
      await assert.rejects(before("first", "shell", { command: unsafePrint, timeout: 30000 }), /Write denied/u);
      await assert.rejects(before("first", "shell", { command: "git -C elsewhere commit -m outside" }), /Write denied/u);
      await assert.rejects(before("first", "shell", { command: "printf forbidden > outside.txt" }), /mission-explicit-write-prohibition/u);
      await assert.rejects(git(candidate, "cat-file", "-e", `${sha}^{commit}`));
      const operation = await before("first", "shell", { command, timeout: 30000 });
      assert.equal(operation.input.command, command, "the admitted V2 shell receives the original heredoc");
      const executed = await exec(command, { cwd: directory, shell: "/bin/bash", timeout: 30000 });
      assert.match(executed.stdout, new RegExp(sha, "u"));
      await after(operation, executed.stdout, { exit: 0 });
      assert.equal(await git(candidate, "cat-file", "commit", sha), body);
      assert.equal((await git(candidate, "rev-parse", `${sha}^{tree}`)).trim(), tree);
      assert.equal((await git(candidate, "show", "-s", "--format=%P", sha)).trim(), parent);
      assert.deepEqual(await sourceState(), originalState, "candidate object restoration must not change the original Git state");
      const patch = await before("first", "patch", { patchText: "*** Begin Patch\n*** Add File: result.txt\n+ready\n*** End Patch" });
      await writeFile(join(directory, "result.txt"), "ready\n"); await after(patch, "Updated result.txt");
      const validation = await before("first", "shell", { command: "node check.mjs ready" });
      const checked = await exec(process.execPath, ["check.mjs", "ready"], { cwd: directory });
      await after(validation, checked.stdout, { exit: 0 });
      agents.first!.outcome = "succeeded";
      await after(worker, "Fixture object restored and validation passed", { sessionID: "first" });
      const settled = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(settled.units[0]!.status, "succeeded");
      assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.callID, validation.id);
      assert.equal(settled.units[0]!.validationRegistration!.checks[0]!.exitCode, 0);
      assert.equal(settled.receipt, null, "a Worker result does not accept the Mission");
      return;
    }
    if (commit === "linked-identity") {
      const workdir = join(directory, "linked");
      const command = "git -c user.name='OpenCode AI assistant' -c user.email=opencode-ai@localhost -c commit.gpgsign=false commit -m 'Bind JointAUTO candidate inputs and artifact verification'";
      assert.match(await readFile(join(workdir, ".git"), "utf8"), /^gitdir: /u, "Git created a linked worktree, not a clone");
      const globalConfig = join(directory, "fixture-global.gitconfig");
      await writeFile(globalConfig, "[commit]\n\tgpgsign = true\n");
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
      const planned = await tool("coordinator", "plan_units", { executor: "self", units: [{
        title: "Commit scoped source", objective: "Commit the scoped source in the linked worktree",
        read: ["check.mjs"], write: ["linked/src/allowed.txt"], validation: ["node check.mjs ready"],
      }] });
      assert.equal(planned.status, "direct-unit-running");
      const originalHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: workdir })).stdout.trim();
      const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
      const stage = await before("coordinator", "shell", { command: "git add -- src/allowed.txt", workdir });
      const added = await exec("git", ["add", "--", "src/allowed.txt"], { cwd: workdir });
      await after(stage, added.stdout, { exit: 0 });
      const index = async () => (await exec("git", ["ls-files", "--stage", "-z"], { cwd: workdir })).stdout;
      const originalIndex = await index();
      for (const effect of ["deny", "ask", "allow"]) {
        const permission = { sessionID: "coordinator", action: "shell", resources: [command], effect };
        await fixture.permissionHooks.get("evaluate")!(permission);
        assert.equal(permission.effect, effect, "the plugin cannot upgrade a native denial or ask");
      }
      for (const rejected of [
        command.replace("-c commit.gpgsign=false", "-c core.hooksPath=elsewhere"),
        command.replace("-c commit.gpgsign=false", "-c commit.gpgsign=true"),
        command.replace("git -c", "git -C elsewhere -c"),
        command.replace("commit -m", "commit --all -m"),
      ]) {
        await assert.rejects(before("coordinator", "shell", { command: rejected, workdir }), /Write denied/u, rejected);
      }
      await exec("git", ["add", "--", "src/outside.txt"], { cwd: workdir });
      const outsideIndex = await index();
      await assert.rejects(before("coordinator", "shell", { command, workdir }), /cached/u);
      assert.equal(await index(), outsideIndex, "denial does not change the staged index");
      assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: workdir })).stdout.trim(), originalHead);
      await exec("git", ["reset", "-q", "HEAD", "--", "src/outside.txt"], { cwd: workdir });
      assert.equal(await index(), originalIndex);
      assert.equal((await exec("git", ["config", "--get", "commit.gpgsign"], { cwd: workdir, env: gitEnv })).stdout.trim(), "true");
      assert.equal((await exec("git", ["-c", "commit.gpgsign=false", "config", "--get", "commit.gpgsign"],
        { cwd: workdir, env: gitEnv })).stdout.trim(), "false");
      const operation = await before("coordinator", "shell", { command, workdir });
      assert.equal(operation.input.command, command, "public hook retains the exact command and option order");
      const committed = await exec(command, { cwd: workdir, env: gitEnv, shell: true });
      await after(operation, committed.stdout, { exit: 0 });
      assert.equal((await exec("git", ["config", "--get", "commit.gpgsign"], { cwd: workdir, env: gitEnv })).stdout.trim(), "true",
        "the invocation-local override does not alter the configured setting");
      for (const key of ["user.name", "user.email", "commit.gpgsign"]) await assert.rejects(
        exec("git", ["config", "--local", "--get", key], { cwd: workdir, env: gitEnv }),
        (error: any) => error.code === 1, `${key} is not persisted to the repository`);
      assert.equal((await exec("git", ["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%s"], { cwd: workdir })).stdout.trim(),
        "OpenCode AI assistant <opencode-ai@localhost>\nOpenCode AI assistant <opencode-ai@localhost>\nBind JointAUTO candidate inputs and artifact verification");
      assert.equal((await exec("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: workdir })).stdout.trim(), "src/allowed.txt");
      assert.equal((await exec("git", ["rev-parse", "HEAD^"], { cwd: workdir })).stdout.trim(), originalHead);
      assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: workdir })).stdout, "");
      assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim(), baseHead,
        "the separate main worktree HEAD is untouched");
      assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: directory })).stdout, "",
        "the separate main worktree index is untouched");
      return;
    }
    if (directRecovery) {
      const unit = { title: "Ready result", objective: "Create ready result", read: ["check.mjs"], write: ["result.txt"],
        validation: ["node check.mjs ready"] };
      const initial = await tool("coordinator", "plan_units", { executor: "self", units: [unit] });
      assert.equal(initial.status, "direct-unit-running");
      const readRun = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), originalRun = await readRun();
      // The interrupted execution never delivered execute.after; only native history survives.
      const patch = await before("coordinator", "patch", { patchText: "*** Begin Patch\n*** Add File: result.txt\n+ready\n*** End Patch" });
      loseNextAfter = true; await after(patch, "Tool execution interrupted");
      ((history.coordinator!.at(-1)!.content as any[])[0].state).status = "error";
      const shell = await before("coordinator", "shell", { command: "node --version", workdir: directory, background: true });
      loseNextAfter = true; await after(shell, "Background launched", { shellID: "sh_retained", ...(interruptedLaunch ? {} : { status: "running" }) });
      const launch = (history.coordinator!.at(-1)!.content as any[])[0];
      launch.time.completed = launch.time.ran + 100;
      if (interruptedLaunch) {
        // Native interruption snapshots progress({shellID}) before the independent Job returns its launch result.
        const state = (history.coordinator!.at(-1)!.content as any[])[0].state;
        state.status = "error"; state.error = { type: "aborted", message: "Tool execution interrupted" };
      }
      const request = () => tool("coordinator", "plan_units", directRecovery === "handoff"
        ? { executor: "worker", handoff_context: "Continue this same result after the interrupted command." }
        : { executor: "self", units: [{ ...unit, objective: "Finish the existing ready result directly" }], reason: "Retain result, correct the method" });
      await assert.rejects(request(), /mission-direct-tools-running/);
      assert.equal((await readRun()).units[0]!.status, "running");
      if (interruptedLaunch) {
        cleanup?.(); await start();
        const waiting = await request();
        assert.match(waiting.status, /terminal-unreconciled:tool_dispatch_active_or_unproven|direct-handoff-awaits-tools/);
        assert.equal((await readRun()).runID, originalRun.runID, "cold recovery cannot replace an unproven shell writer");
      }
      history.coordinator!.push({ id: "shell-terminal", type: "synthetic", description: "node --version", time: { created: launch.time.ran + 1 },
        metadata: { source: "shell", shellID: "sh_retained", jobID: "sh_retained", state: "completed", exit: 1 }, text: "Native shell ended" });
      const recovered = await request();
      if (interruptedLaunch) {
        const native = history.coordinator!.flatMap(message => message.content as any[] ?? []).find(part => part.id === shell.id);
        assert.equal(native.state.metadata.status, undefined, "recovery only projects lifecycle; native progress stays unchanged");
      }
      if (directRecovery === "replan") assert.equal(recovered.status, "direct-unit-running", JSON.stringify(recovered));
      const current = await readRun();
      assert.deepEqual(current.acceptance, originalRun.acceptance);
      assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).id, mission.mission_id);
      assert.equal(current.units[0]!.evidence.length, 0, "quiescence never manufactures successful validation");
      if (directRecovery === "handoff") {
        assert.equal(current.runID, originalRun.runID);
        assert.equal(current.units[0]!.directHandoffs?.length, 1, JSON.stringify({ recovered, current }));
        assert.ok(recovered.task, "the normal Worker handoff, not a new Mission, owns the remaining result");
      } else assert.notEqual(current.runID, originalRun.runID, JSON.stringify({ recovered, current }));
      return;
    }
    let firstRun: string | undefined;
    let budget: { max_units: number; consumed_units: number } | undefined;
    let retiredHandoff: string | undefined;
    for (const [index, child] of (commit ? ["first"] : ["first", "second"]).entries()) {
      const finalCandidate = commit || index === 1;
      const command = managedScenario === "router-required" ? "npm run test:full" : managedScenario === "router"
        ? "npm run test:targeted -- test/fixture.test.ts" : managedScenario === "required" ? "node --test" : managedScenario === "pytest-nodeid"
        ? "pytest test_example.py::test_before -q" : managedScenario === "focused"
        ? "node --test fixture.test.mjs" : `node check.mjs ${finalCandidate ? "ready" : "present"}`;
      const plan = await tool("coordinator", "plan_units", { units: [{ title: "Write result", objective,
        read: managedScenario ? [directory] : ["check.mjs"],
        write: managedScenario === "router" || managedScenario === "router-required" ? ["result.txt", "dist/**", "_testenv/**"] :
          managedScenario === "pytest-nodeid" ? ["result.txt", "test_example.py"] : ["result.txt"],
        validation: reviewJoin === "required-occurrence" ? [command, command] : [command] }],
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
      if (managedScenario) {
        if (managedScenario === "pytest-nodeid") {
          const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" };
          const available = await exec("pytest", ["--version"], { cwd: directory, env: environment }).then(() => true, error => {
            if (error.code === "ENOENT") return false;
            throw error;
          });
          if (!available) context.diagnostic("pytest unavailable: exercising hook routing with a simulated terminal only");
          const native = async (args: string[]) => exec("pytest", args, { cwd: directory, env: environment })
            .then(result => ({ output: result.stdout + result.stderr, code: 0 }), error => {
              if (typeof error.code !== "number") throw error;
              return { output: String(error.stdout) + String(error.stderr), code: error.code };
            });
          const failed = await before(child, "shell", { command, workdir: directory });
          const initial = available ? await native(["test_example.py::test_before", "-q"]) : { output: "simulated native terminal", code: 1 };
          assert.equal(initial.code, 1);
          await after(failed, initial.output, { exit: initial.code });
          const unknown = await before(child, "shell", { command: "pytest -q", workdir: directory });
          assert.equal(unknown.input.command, "pytest -q", "an unverified node ID cannot force a focused retry even while its file exists");
          await after(unknown, "not started", { status: "cancelled" });
          const change = await before(child, "patch", { patchText: "*** Begin Patch\n*** Update File: test_example.py\n@@\n-def test_before():\n-    assert False\n+def test_after():\n+    assert True\n*** End Patch" });
          await writeFile(join(directory, "test_example.py"), "def test_after():\n    assert True\n");
          await after(change, "Updated test_example.py");
          if (available) {
            const stale = await before(child, "shell", { command, workdir: directory });
            const missing = await native(["test_example.py::test_before", "-q"]);
            assert.equal(missing.code, 4); assert.match(missing.output, /not found/u);
            await after(stale, missing.output, { exit: missing.code });
            const checks = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!.validationRegistration!.checks;
            assert.ok(checks.some(check => check.callID === stale.id && check.exitCode === 4), "the missing selector failure remains recorded");
          }
          const full = await before(child, "shell", { command: "pytest -q", workdir: directory });
          assert.equal(full.input.command, "pytest -q");
          if (available) {
            const result = await native(["-q"]);
            assert.equal(result.code, 0); assert.match(result.output, /1 passed/u);
            await after(full, result.output, { exit: result.code });
          } else await after(full, "not started: pytest unavailable", { status: "cancelled" });
          const checks = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!.validationRegistration!.checks;
          assert.ok(checks.some(check => check.callID === failed.id && check.exitCode === 1), "the registered failure remains recorded");
          assert.ok(!checks.some(check => check.callID === failed.id && check.exitCode === 0), "the old failure is not converted into a pass");
          return;
        }
        if (managedScenario === "router" || managedScenario === "router-required") {
          const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
          const edit = async (from: string, to: string) => {
            const change = await before(child, "patch", { patchText: `*** Begin Patch\n*** Update File: result.txt\n@@\n-${from}\n+${to}\n*** End Patch` });
            await writeFile(join(directory, "result.txt"), `${to}\n`); await after(change, "Updated result.txt");
          };
          const focusedCommand = "npm run test:targeted -- test/fixture.test.ts";
          await edit("partial", "broken");
          if (managedScenario === "router") {
            const directCommand = "node --test test/fixture.test.ts";
            const direct = await before(child, "shell", { command: directCommand, workdir: directory });
            const result = await exec(process.execPath, ["--test", "test/fixture.test.ts"], { cwd: directory, env: environment })
              .then(() => { throw new Error("direct fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
            assert.equal(result.code, 1); await after(direct, result.stdout, { exit: result.code });
            const different = await before(child, "shell", { command: "npm run test:full", workdir: directory });
            assert.equal(different.input.command, "npm run test:full", "a different runner/setup is not the same selection");
            await after(different, "not started", { status: "cancelled" });
            await context.test("a concurrent targeted selection is not a serial full failure", { skip: availableParallelism() < 2 }, async () => {
              const paths = ["test/concurrent-a.test.ts", "test/concurrent-b.test.ts"];
              const multiple = `npm run test:targeted -- ${paths.join(" ")}`;
              const multi = await before(child, "shell", { command: multiple, workdir: directory });
              const failed = await exec("npm", ["run", "test:targeted", "--", ...paths], { cwd: directory, env: environment })
                .then(() => { throw new Error("fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
              assert.equal(failed.code, 1); await after(multi, failed.stdout, { exit: failed.code });
              // These are the full helper's actual per-file arguments, not a full launch.
              for (const path of paths) await exec(process.execPath,
                ["--experimental-strip-types", "--import", "./test/setup.ts", "--test", "--test-concurrency=1", path],
                { cwd: directory, env: environment });
              const full = await before(child, "shell", { command: "npm run test:full", workdir: directory });
              assert.equal(full.input.command, "npm run test:full");
              await after(full, "not started", { status: "cancelled" });
            });
          }
          const focused = await before(child, "shell", { command: focusedCommand, workdir: directory });
          const failed = await exec("npm", ["run", "test:targeted", "--", "test/fixture.test.ts"], { cwd: directory, env: environment })
            .then(() => { throw new Error("fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
          assert.equal(failed.code, 1); await after(focused, failed.stdout, { exit: failed.code });
          if (managedScenario === "router-required") {
            const full = await before(child, "shell", { command, workdir: directory });
            assert.equal(full.input.command, command, "registered full keeps its execution obligation");
            await after(full, "not started", { status: "cancelled" });
          } else {
            await assert.rejects(before(child, "shell", { command: "npm run test:full", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED.*test:targeted/u);
            for (const kind of ["userconfig", "globalconfig"]) await context.test(`${kind} npm effects remain native with an existing focused failure`, async () => {
              const config = process.env[`npm_config_${kind}`]!, shell = join(directory, ".git/sortie-dogs/tools/script-shell");
              await writeFile(shell, "#!/bin/sh\nprintf 'called\\n' >> .git/sortie-dogs/shell-count\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
              await writeFile(config, `script-shell=${shell}\n`);
              try {
                assert.equal((await exec("npm", ["config", "get", "script-shell"], { cwd: directory })).stdout.trim(), shell);
                const full = await before(child, "shell", { command: "npm run test:full", workdir: directory });
                assert.equal(full.input.command, "npm run test:full");
                await after(full, "not started", { status: "cancelled" });
                assert.equal(await readFile(config, "utf8"), `script-shell=${shell}\n`, "client-owned configuration is not rewritten");
              } finally { await rm(config, { force: true }); }
            });
            await context.test("an external compiler fallback is not suppressed", async () => {
              const compiler = join(directory, "node_modules/.bin/tsc"), wrapper = join(directory, ".git/sortie-dogs/tools/tsc");
              await rm(compiler);
              await writeFile(wrapper, "#!/bin/sh\nprintf 'called\\n' >> .git/sortie-dogs/compiler-count\nexit 0\n", { mode: 0o755 });
              try {
                const full = await before(child, "shell", { command: "npm run test:full", workdir: directory });
                assert.equal(full.input.command, "npm run test:full");
                await after(full, "not started", { status: "cancelled" });
              } finally { await symlink("../typescript/bin/tsc", compiler); }
            });
            const router = join(directory, "scripts/test-router.mjs"), originalRouter = await readFile(router, "utf8");
            await writeFile(router, `${originalRouter}\n// changed\n`);
            const changed = await before(child, "shell", { command: "npm run test:full", workdir: directory });
            assert.equal(changed.input.command, "npm run test:full", "changed runner is not suppressed");
            await after(changed, "not started", { status: "cancelled" });
            await writeFile(router, originalRouter);
            const packagePath = join(directory, "package.json"), originalPackage = await readFile(packagePath, "utf8");
            const withLifecycle = JSON.parse(originalPackage); withLifecycle.scripts["pretest:full"] = "node prepare.mjs";
            await writeFile(packagePath, JSON.stringify(withLifecycle));
            const lifecycle = await before(child, "shell", { command: "npm run test:full", workdir: directory });
            assert.equal(lifecycle.input.command, "npm run test:full", "unknown lifecycle effects are not suppressed");
            await after(lifecycle, "not started", { status: "cancelled" });
            await writeFile(packagePath, originalPackage);
            const changedFocus = JSON.parse(originalPackage); changedFocus.scripts["test:targeted"] = "node --test";
            await writeFile(packagePath, JSON.stringify(changedFocus));
            const staleFocus = await before(child, "shell", { command: "npm run test:full", workdir: directory });
            assert.equal(staleFocus.input.command, "npm run test:full", "the recorded focused command is no longer the same executable selection");
            await after(staleFocus, "not started", { status: "cancelled" });
            await writeFile(packagePath, originalPackage);
            const oldOptions = process.env.NODE_OPTIONS;
            try {
              process.env.NODE_OPTIONS = "--trace-warnings";
              const alteredEnvironment = await before(child, "shell", { command: "npm run test:full", workdir: directory });
              assert.equal(alteredEnvironment.input.command, "npm run test:full");
              await after(alteredEnvironment, "not started", { status: "cancelled" });
            } finally {
              if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
            }
            await edit("broken", "ready");
            const retry = await before(child, "shell", { command: focusedCommand, workdir: directory });
            const result = await exec("npm", ["run", "test:targeted", "--", "test/fixture.test.ts"], { cwd: directory, env: environment });
            await after(retry, result.stdout, { exit: 0 });
            const full = await before(child, "shell", { command: "npm run test:full", workdir: directory });
            assert.equal(full.input.command, "npm run test:full", "fresh focused success removes the deferral, not a full-test PASS");
            // Exercise the full runner's output format as a synthetic failed hook event.
            // The actual full command is deliberately not launched in this test.
            const fullOutput = `SORTIE_FULL_FILE_OUTPUT ${JSON.stringify({ phase: "nonintegration", path: "test/fixture.test.ts", line: "not ok 1 - managed" })}`;
            await after(full, fullOutput, { exit: 1 });
            await assert.rejects(before(child, "shell", { command: "npm run test:full", workdir: directory }),
              /SORTIE_FULL_TEST_DEFERRED.*test:targeted/u, "a reported file failure produces a covered focused retry");
            const retryAgain = await before(child, "shell", { command: focusedCommand, workdir: directory });
            const retried = await exec("npm", ["run", "test:targeted", "--", "test/fixture.test.ts"], { cwd: directory, env: environment });
            await after(retryAgain, retried.stdout, { exit: 0 });
            const allowed = await before(child, "shell", { command: "npm run test:full", workdir: directory });
            assert.equal(allowed.input.command, "npm run test:full");
            await after(allowed, "not started", { status: "cancelled" });
          }
          assert.equal(await readFile(join(directory, ".git/sortie-dogs/managed-count"), "utf8"),
            managedScenario === "router" ? "run\nrun\nrun\nrun\n" : "run\n", "the full command was never started");
          return;
        }
        if (managedScenario === "focused") {
          const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
          const edit = async (from: string, to: string) => {
            const change = await before(child, "patch", { patchText: `*** Begin Patch\n*** Update File: result.txt\n@@\n-${from}\n+${to}\n*** End Patch` });
            await writeFile(join(directory, "result.txt"), `${to}\n`); await after(change, "Updated result.txt");
          };
          await edit("partial", "broken");
          const focused = await before(child, "shell", { command, workdir: directory });
          const failed = await exec(process.execPath, ["--test", "fixture.test.mjs"], { cwd: directory, env: environment })
            .then(() => { throw new Error("fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
          assert.equal(failed.code, 1); await after(focused, failed.stdout, { exit: failed.code });
          await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u);
          const fixturePath = join(directory, "fixture.test.mjs"), source = await readFile(fixturePath);
          await rename(join(directory, "fixture.test.mjs"), join(directory, "renamed.test.mjs"));
          try {
            if (process.platform !== "win32") {
              await context.test("a dangling in-scope selection remains unavailable when omitted from the snapshot", async () => {
                const control = join(directory, ".opencode"), link = join(control, "focused.test.mjs"), target = join(control, "target.test.mjs");
                await mkdir(control, { recursive: true });
                await writeFile(target, source);
                await symlink("target.test.mjs", link);
                try {
                  const selected = "node --test .opencode/focused.test.mjs";
                  const attempt = await before(child, "shell", { command: selected, workdir: directory });
                  const failure = await exec(process.execPath, ["--test", ".opencode/focused.test.mjs"], { cwd: directory, env: environment })
                    .then(() => { throw new Error("linked fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
                  assert.equal(failure.code, 1); await after(attempt, failure.stdout, { exit: failure.code });
                  await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u);
                  await rm(target);
                  const full = await before(child, "shell", { command: "npm run all", workdir: directory });
                  assert.equal(full.input.command, "npm run all", "the removed in-scope target cannot be retried");
                  await after(full, "not started", { status: "cancelled" });
                  const checks = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!.validationRegistration!.checks;
                  const recordedAttempt = history[child]!.flatMap(message => (message.content as any[]) ?? []).find(part => part.id === attempt.id);
                  assert.equal(recordedAttempt?.state.metadata.exit, 1, "the native failed attempt remains in history");
                  assert.ok(checks.some(check => check.callID === focused.id && check.exitCode === 1));
                  assert.ok(!checks.some(check => check.exitCode === 0), "absence does not create a passing check");
                  await rm(link);
                  await symlink("../../outside.test.mjs", link);
                  await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u,
                    "an out-of-scope target is not proof of absence");
                  await rm(link);
                  await symlink("unresolved/../missing.test.mjs", link);
                  await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u,
                    "an embedded parent in a dangling link is ambiguous");
                } finally { await rm(link, { force: true }); await rm(target, { force: true }); }
              });
              await symlink("renamed.test.mjs", fixturePath);
              try {
                await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u,
                  "an existing symlink is not proof the focused selection is missing");
              } finally { await rm(fixturePath); }
              await symlink("missing.test.mjs", fixturePath);
              try {
                const missingTarget = await before(child, "shell", { command: "npm run all", workdir: directory });
                assert.equal(missingTarget.input.command, "npm run all", "a missing in-scope symlink target is unavailable");
                await after(missingTarget, "not started", { status: "cancelled" });
              } finally { await rm(fixturePath); }
            }
            const full = await before(child, "shell", { command: "npm run all", workdir: directory });
            assert.equal(full.input.command, "npm run all", "the obsolete retry does not block the full command");
            const result = await exec("npm", ["run", "all"], { cwd: directory, env: environment })
              .then(() => { throw new Error("renamed fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
            assert.equal(result.code, 1); assert.match(result.stdout, /not ok/u);
            await after(full, result.stdout, { exit: result.code });
          } finally {
            await rename(join(directory, "renamed.test.mjs"), join(directory, "fixture.test.mjs"));
          }
          await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u,
            "restoring the failed selection restores its deferral");
          await rm(fixturePath);
          try {
            const full = await before(child, "shell", { command: "npm run all", workdir: directory });
            assert.equal(full.input.command, "npm run all", "a deleted selection does not block the full command");
            await after(full, "not started", { status: "cancelled" });
            const checks = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!.validationRegistration!.checks;
            assert.ok(checks.some(check => check.callID === focused.id && check.exitCode === 1));
            assert.ok(!checks.some(check => check.exitCode === 0), "absence does not turn a previous failure into a pass");
          } finally { await writeFile(fixturePath, source); }
          await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u);
          const nested = join(directory, "nested");
          await mkdir(nested);
          for (const selection of ["../fixture.test.mjs", "../nested/../fixture.test.mjs"]) {
            const relativeAttempt = await before(child, "shell", { command: `node --test ${selection}`, workdir: nested });
            const relativeFailure = await exec(process.execPath, ["--test", selection], { cwd: nested, env: environment })
              .then(() => { throw new Error("nested fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
            assert.equal(relativeFailure.code, 1); assert.match(relativeFailure.stdout, /ENOENT/u);
            await after(relativeAttempt, relativeFailure.stdout, { exit: relativeFailure.code });
          }
          await assert.rejects(before(child, "shell", { command: "node --test", workdir: nested }), /SORTIE_FULL_TEST_DEFERRED/u);
          await rename(fixturePath, join(directory, "renamed.test.mjs"));
          try {
            const full = await before(child, "shell", { command: "node --test", workdir: nested });
            assert.equal(full.input.command, "node --test", "a parent-relative selection can also disappear");
            await after(full, "not started", { status: "cancelled" });
          } finally { await rename(join(directory, "renamed.test.mjs"), fixturePath); }
          await edit("broken", "ready");
          const retry = await before(child, "shell", { command, workdir: directory });
          const result = await exec(process.execPath, ["--test", "fixture.test.mjs"], { cwd: directory, env: environment });
          await after(retry, result.stdout, { exit: 0 });
          const full = await before(child, "shell", { command: "node --test", workdir: directory });
          const fullResult = await exec(process.execPath, ["--test"], { cwd: directory, env: environment });
          await after(full, fullResult.stdout, { exit: 0 });
          assert.equal(await readFile(join(directory, ".git/sortie-dogs/managed-count"), "utf8"),
            process.platform === "win32" ? "run\nrun\nrun\nrun\n" : "run\nrun\nrun\nrun\nrun\n");
          const unitAfter = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
          assert.ok(unitAfter.validationRegistration!.checks.some(check => check.callID === focused.id && check.exitCode === 1));
          assert.ok(unitAfter.validationRegistration!.checks.some(check => check.callID === retry.id && check.exitCode === 0));
          for (const selection of [
            { runner: "pytest", path: "test_removed.py", focused: "python3 -m pytest test_removed.py -q", full: "python3 -m pytest -q", directory: false },
            { runner: "go", path: "removed-package", focused: "go test ./removed-package", full: "go test ./...", directory: true },
          ]) await context.test(`obsolete ${selection.runner} literal selection does not permanently defer full`, async () => {
            const path = join(directory, selection.path), moved = `${path}.saved`;
            if (selection.directory) await mkdir(path);
            await writeFile(selection.directory ? join(path, "failure_test.go") : path, "retained failing input\n");
            const failed = await before(child, "shell", { command: selection.focused, workdir: directory });
            // Supply the native terminal through the public adapter; this checks routing,
            // not pytest/Go installation or the runner's own failure detection.
            await after(failed, "retained native failure", { exit: 1 });
            await assert.rejects(before(child, "shell", { command: selection.full, workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u);
            await rename(path, moved);
            try {
              const full = await before(child, "shell", { command: selection.full, workdir: directory });
              assert.equal(full.input.command, selection.full, "the obsolete literal selection cannot require a successful retry");
              await after(full, "not started", { status: "cancelled" });
              const ledger = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
                `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
              const terminals = ledger.records.flatMap(({ event }) => event.kind === "validation.settled" && event.operation_id === failed.id ? [event] : []);
              assert.deepEqual(terminals.map(event => [event.outcome, event.exit_code]), [["failed", 1]],
                "allowing full neither settles the old failure again nor turns it into PASS");
            } finally { await rename(moved, path); }
            await assert.rejects(before(child, "shell", { command: selection.full, workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u,
              "restoring the original selection restores focused priority");
            if (selection.runner === "go") {
              const pattern = await before(child, "shell", { command: "go test ./.../subpackage", workdir: directory });
              await after(pattern, "retained native pattern failure", { exit: 1 });
              await rename(path, moved);
              try {
                await assert.rejects(before(child, "shell", { command: selection.full, workdir: directory }), /SORTIE_FULL_TEST_DEFERRED/u,
                  "a Go package pattern is not a missing literal directory");
              } finally { await rename(moved, path); }
            }
          });
          return;
        }
        if (managedScenario === "required") {
          const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
          const operation = await before(child, "patch", { patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-partial\n+broken\n*** End Patch" });
          await writeFile(join(directory, "result.txt"), "broken\n"); await after(operation, "Updated result.txt");
          const focused = await before(child, "shell", { command: "node --test fixture.test.mjs", workdir: directory });
          const failed = await exec(process.execPath, ["--test", "fixture.test.mjs"], { cwd: directory, env: environment })
            .then(() => { throw new Error("fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
          assert.equal(failed.code, 1); await after(focused, failed.stdout, { exit: failed.code });
          const required = await before(child, "shell", { command: "node --test", workdir: directory });
          assert.equal(required.input.command, "node --test", "a registered occurrence must not be deferred or replaced");
          const full = await exec(process.execPath, ["--test"], { cwd: directory, env: environment })
            .then(() => { throw new Error("fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
          assert.equal(full.code, 1); await after(required, full.stdout, { exit: full.code });
          assert.equal(await readFile(join(directory, ".git/sortie-dogs/managed-count"), "utf8"), "run\nrun\n");
          const retained = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
            `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
          assert.ok(retained.records.some(({ event }) => event.kind === "validation.settled" && event.operation_id === required.id &&
            event.outcome === "failed" && event.exit_code === 1));
          return;
        }
        const first = await before(child, "shell", { command: "node --test", workdir: directory });
        assert.equal(first.input.command, "node --test");
        const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
        const checked = await exec(process.execPath, ["--test"], { cwd: directory, env: environment });
        await after(first, checked.stdout, { exit: 0 });
        const repeat = await before(child, "shell", { command: "node --test", workdir: directory });
        assert.equal(repeat.input.command, "node --test", "the Mission has no equivalence contract for this undeclared test");
        const repeated = await exec(process.execPath, ["--test"], { cwd: directory, env: environment });
        await after(repeat, repeated.stdout, { exit: 0 });
        assert.equal(await readFile(join(directory, ".git/sortie-dogs/managed-count"), "utf8"), "run\nrun\n");
        const unitAfter = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
        assert.equal(unitAfter.validationRegistration!.checks.length, 0, "informal observation is not formal validation");
        const ledger = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
          `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
        assert.deepEqual(ledger.records.filter(({ event }) => event.kind === "validation.admission").map(({ event }) =>
          event.kind === "validation.admission" && event.decision), ["ALLOW", "ALLOW"]);
        const terminals = ledger.records.filter(({ event }) => event.kind === "validation.settled").map(({ event }) =>
          event.kind === "validation.settled" && { callID: event.operation_id, outcome: event.outcome, exit: event.exit_code });
        assert.deepEqual(terminals, [{ callID: first.id, outcome: "passed", exit: 0 }, { callID: repeat.id, outcome: "passed", exit: 0 }]);

        // A genuine failed full run identifies a focused retry; neither the failed run nor
        // the deferral is turned into a PASS. The npm script is resolved from this project.
        const edit = async (from: string, to: string) => {
          const operation = await before(child, "patch", { patchText: `*** Begin Patch\n*** Update File: result.txt\n@@\n-${from}\n+${to}\n*** End Patch` });
          await writeFile(join(directory, "result.txt"), `${to}\n`); await after(operation, "Updated result.txt");
        };
        await edit("partial", "broken");
        const failure = await before(child, "shell", { command: "node --test", workdir: directory });
        const failed = await exec(process.execPath, ["--test"], { cwd: directory, env: environment })
          .then(() => { throw new Error("fixture was expected to fail"); }, error => ({ stdout: String(error.stdout), code: error.code }));
        assert.equal(failed.code, 1);
        await after(failure, failed.stdout, { exit: failed.code });
        for (const command of ["node --test", "npm run all"]) await assert.rejects(
          before(child, "shell", { command, workdir: directory }), /SORTIE_FULL_TEST_DEFERRED:.*node --test fixture\.test\.mjs/u);
        await rename(join(directory, "fixture.test.mjs"), join(directory, "renamed.test.mjs"));
        try {
          const withoutOldSelection = await before(child, "shell", { command: "npm run all", workdir: directory });
          assert.equal(withoutOldSelection.input.command, "npm run all", "a full-output-derived retry also becomes unavailable");
          await after(withoutOldSelection, "not started", { status: "cancelled" });
        } finally { await rename(join(directory, "renamed.test.mjs"), join(directory, "fixture.test.mjs")); }
        await assert.rejects(before(child, "shell", { command: "npm run all", workdir: directory }),
          /SORTIE_FULL_TEST_DEFERRED:.*node --test fixture\.test\.mjs/u);
        const unrelated = await before(child, "shell", { command: "npm run release", workdir: directory });
        assert.equal(unrelated.input.command, "npm run release", "opaque release operations are not silently suppressed");
        await after(unrelated, "not started", { status: "cancelled" });
        const otherRunner = await before(child, "shell", { command: "cargo test --workspace", workdir: directory });
        assert.equal(otherRunner.input.command, "cargo test --workspace", "a Node failure is not evidence of a Cargo failure");
        await after(otherRunner, "not started", { status: "cancelled" });
        await edit("broken", "ready");
        const focused = await before(child, "shell", { command: "node --test fixture.test.mjs", workdir: directory });
        const repaired = await exec(process.execPath, ["--test", "fixture.test.mjs"], { cwd: directory, env: environment });
        await after(focused, repaired.stdout, { exit: 0 });
        await edit("ready", "partial");
        await assert.rejects(before(child, "shell", { command: "node --test", workdir: directory }),
          /SORTIE_FULL_TEST_DEFERRED:.*node --test fixture\.test\.mjs/u, "an older focused pass does not clear a changed candidate");
        const refreshed = await before(child, "shell", { command: "node --test fixture.test.mjs", workdir: directory });
        const refreshedResult = await exec(process.execPath, ["--test", "fixture.test.mjs"], { cwd: directory, env: environment });
        await after(refreshed, refreshedResult.stdout, { exit: 0 });
        const admitted = await before(child, "shell", { command: "node --test", workdir: directory });
        assert.equal(admitted.input.command, "node --test", "focused success is not substituted for the required full run");
        const full = await exec(process.execPath, ["--test"], { cwd: directory, env: environment });
        await after(admitted, full.stdout, { exit: 0 });
        assert.equal(await readFile(join(directory, ".git/sortie-dogs/managed-count"), "utf8"), "run\nrun\nrun\nrun\nrun\nrun\n");
        const afterFailure = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
          `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
        assert.ok(afterFailure.records.some(({ event }) => event.kind === "validation.settled" && event.operation_id === failure.id &&
          event.outcome === "failed" && event.exit_code === 1));
        return;
      }
      if (commit) {
        for (const args of [["add", "--", "result.txt"], ["commit", "-m", "Implement result"]]) {
          const gitCommand = args[0] === "add" ? "git add -- result.txt" : 'git commit -m "Implement result"';
          const operation = await before(child, "shell", { command: gitCommand });
          const executed = await exec("git", args, { cwd: directory });
          await after(operation, executed.stdout, { exit: 0 });
        }
      }
      const validation = await before(child, "shell", { command, ...(reviewJoin === "timeout-mismatch" ? { timeout: 10000 } : {}) });
      if (reviewJoin && index === 0) {
        const owner = spawn(process.execPath, ["check.mjs", "present"], { cwd: directory });
        const ended = new Promise<number | null>((resolve, reject) => { owner.once("error", reject); owner.once("close", resolve); });
        const previousEnvironment = process.env.SORTIE_JOIN_FIXTURE_SETTING;
        try {
          await new Promise<void>((resolve, reject) => { owner.stdout.once("data", () => resolve()); owner.once("error", reject); });
          const ledgerPath = join(directory, ".git/sortie-dogs/run-flight-v010",
            `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`);
          if (["timeout-mismatch", "background-mismatch", "environment-mismatch"].includes(reviewJoin)) {
            if (reviewJoin === "environment-mismatch") process.env.SORTIE_JOIN_FIXTURE_SETTING = "changed";
            await assert.rejects(before(child, "shell", { command, ...(reviewJoin === "timeout-mismatch" ? { timeout: 20000 } : {}),
              ...(reviewJoin === "background-mismatch" ? { background: true } : {}) }), /duplicate-evidence/u);
            if (previousEnvironment === undefined) delete process.env.SORTIE_JOIN_FIXTURE_SETTING;
            else process.env.SORTIE_JOIN_FIXTURE_SETTING = previousEnvironment;
            await writeFile(join(directory, ".git/sortie-dogs/join-release"), "release");
            assert.equal(await ended, 0);
            await after(validation, "actual owner terminal", { exit: 0 });
            assert.equal(await readFile(join(directory, ".git/sortie-dogs/join-count"), "utf8"), "run\n");
            const ledger = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
            assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.joined").length, 0);
            assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.settled").length, 1);
            return;
          }
          if (reviewJoin === "source-before") await writeFile(join(directory, "check.mjs"), "// changed before join\n");
          if (reviewJoin === "environment-before") process.env.SORTIE_JOIN_FIXTURE_SETTING = "changed";
          if (reviewJoin === "passed") await assert.rejects(before("unrelated", "sortie_v010_review_mission", { risk_tags: [], traces: [] }),
            /runtime-profile-session-inactive/u, "an unrelated session cannot join this Mission");
          const controller = new AbortController();
          const reviewEvent = await before("root", "sortie_v010_review_mission", { risk_tags: [], traces: [] });
          const definition = fixture.tools.find(tool => tool.name === "sortie_v010_review_mission") as {
            execute(input: unknown, context: unknown): Promise<{ content: string }> };
          const waiting = definition.execute(reviewEvent.input, { sessionID: "root", agent: "dog-operator",
            id: reviewEvent.id, signal: controller.signal }).then(result => ({ result }), error => ({ error }));
          if (["required-occurrence", "source-before", "environment-before"].includes(reviewJoin)) {
            const result = await waiting;
            assert.ok("error" in result);
            assert.match(String(result.error), /mission-review-terminal-unreconciled/u);
          } else await Promise.race([joinPermitted, waiting.then(value => { if ("error" in value) throw value.error; })]);
          assert.equal(owner.exitCode, null, "the real Worker process is running when the other Agent joins");
          if (!["permission-denied", "required-occurrence", "source-before", "environment-before"].includes(reviewJoin)) {
            const deadline = Date.now() + 5000;
            while (!(await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records.some(({ event }) =>
              event.kind === "validation.joined") && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
            assert.ok((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records.some(({ event }) =>
              event.kind === "validation.joined"), "the waiter is admitted before changing or cancelling either side");
          }
          if (reviewJoin === "waiter-cancelled") controller.abort();
          if (reviewJoin === "source-changed") await writeFile(join(directory, "check.mjs"), "// changed during native validation\n");
          if (reviewJoin === "environment-changed") process.env.SORTIE_JOIN_FIXTURE_SETTING = "changed";
          if (reviewJoin === "owner-cancelled") owner.kill("SIGTERM");
          else await writeFile(join(directory, ".git/sortie-dogs/join-release"), "release");
          const exit = await ended;
          assert.equal(exit, reviewJoin === "owner-cancelled" ? null : reviewJoin === "failed" ? 7 : 0);
          await after(validation, "actual owner terminal", reviewJoin === "owner-cancelled" ? { status: "cancelled" } : { exit });
          const result = await waiting;
          if (["source-changed", "environment-changed", "source-before", "environment-before", "permission-denied", "waiter-cancelled", "required-occurrence"].includes(reviewJoin)) {
            assert.ok("error" in result, JSON.stringify(result));
            assert.match(String(result.error), ["required-occurrence", "source-before", "environment-before"].includes(reviewJoin) ? /mission-review-terminal-unreconciled/u :
              reviewJoin === "permission-denied" ? /native permission denied/u :
              reviewJoin === "waiter-cancelled" ? /waiter cancelled/u : /JOINED_OWNER_STALE/u);
          } else {
            assert.ok("result" in result, JSON.stringify(result));
            const packet = JSON.parse(result.result.content);
            assert.equal(packet.status, reviewJoin === "passed" ? "validation-joined" : "validation-owner-not-passed");
            assert.equal(packet.validation.owner_session_id, child);
            assert.equal(packet.validation.owner_call_id, validation.id);
            assert.equal(packet.validation.outcome, reviewJoin === "passed" ? "passed" : reviewJoin === "failed" ? "failed" : "cancelled");
            assert.equal(packet.validation.evidence_ids.length > 0, reviewJoin === "passed");
            assert.match(packet.next_action, /not a second execution or a Review/u);
            const beforeReview = (await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).review;
            await after(reviewEvent, result.result.content);
            assert.deepEqual((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).review,
              beforeReview, "the wait is not a Review or an acceptance decision");
          }
          assert.equal(await readFile(join(directory, ".git/sortie-dogs/join-count"), "utf8"), "run\n");
          const unitAfter = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
          assert.equal(unitAfter.validationRegistration!.checks.length, 1, "only the Worker's actual shell is registered");
          assert.equal(unitAfter.validationRegistration!.checks[0]!.callID, validation.id);
          if (["source-changed", "environment-changed", "source-before", "environment-before"].includes(reviewJoin)) {
            assert.equal(unitAfter.validationRegistration!.checks[0]!.fresh, false, "changed owner inputs cannot become fresh proof");
          }
          const ledger = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
          assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.joined").length,
            ["permission-denied", "required-occurrence", "source-before", "environment-before"].includes(reviewJoin) ? 0 : 1);
          assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.settled").length, 1);
          if (reviewJoin === "required-occurrence") {
            const second = await before(child, "shell", { command });
            assert.equal(second.input.command, command, "the other required occurrence is not substituted");
            const actual = await exec(process.execPath, ["check.mjs", "present"], { cwd: directory });
            await after(second, actual.stdout, { exit: 0 });
            assert.equal(await readFile(join(directory, ".git/sortie-dogs/join-count"), "utf8"), "run\nrun\n");
            const registered = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!.validationRegistration!.checks;
            assert.deepEqual(registered.map(item => item.callID), [validation.id, second.id]);
            assert.equal((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records
              .filter(({ event }) => event.kind === "validation.settled").length, 2);
          }
          if (reviewJoin === "passed") {
            agents[child]!.outcome = "succeeded";
            const workerResult = await after(worker, "Validation passed", { sessionID: child });
            assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!.status,
              "succeeded", workerResult);
            const review = await tool("coordinator", "review_mission", { risk_tags: [], traces: [] });
            assert.notEqual(review.status, "validation-joined", "the normal post-Worker Review path remains reachable");
          }
          return;
        } finally {
          if (previousEnvironment === undefined) delete process.env.SORTIE_JOIN_FIXTURE_SETTING;
          else process.env.SORTIE_JOIN_FIXTURE_SETTING = previousEnvironment;
          if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGTERM"); await ended; }
        }
      }
      let waiter: { sessionID: string; agent: string; tool: string; id: string; input: { command: string } } | undefined;
      let joined: Promise<void> | undefined;
      if (joinScenario && index === 0) {
        waiter = { sessionID: child, agent: agents[child]!.agent, tool: "shell", id: `call_${++counter}`, input: { command } };
        joined = Promise.resolve(fixture.toolHooks.get("execute.before")!(waiter));
        await Promise.race([joinPermitted, joined]);
        const readWhileWaiting = await before(child, "read", { path: "check.mjs" });
        await after(readWhileWaiting, await readFile(join(directory, "check.mjs"), "utf8"));
      }
      const checked = await exec(process.execPath, ["check.mjs", finalCandidate ? "ready" : "present"], { cwd: directory });
      await after(validation, checked.stdout, { exit: 0 });
      if (waiter && joined) {
        await joined;
        assert.match(waiter.input.command, /SORTIE_VALIDATION_JOINED/u);
        await after(waiter, "SORTIE_VALIDATION_JOINED", { exit: 0 });
        const recorded = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"))
          .units[0]!.validationRegistration!.checks.find(check => check.callID === waiter!.id);
        assert.ok(recorded?.reusedEvidenceIDs?.length, "the waiter retains the owner's proof identity, not a new native execution");
        const joinedLedger = await (await RunFlightLedger.openGoal(join(directory, ".git/sortie-dogs/run-flight-v010",
          `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`))).readGoal();
        assert.equal(joinedLedger.records.filter(({ event }) => event.kind === "validation.joined").length, 1);
        assert.equal(joinedLedger.records.filter(({ event }) => event.kind === "validation.settled").length, 1);
      }
      agents[child]!.outcome = "succeeded";
      await after(worker, "Validation passed", { sessionID: child });
      const review = await tool("coordinator", "review_mission", { risk_tags: commit ? ["public-logic"] : [], traces: [`R1: result.txt checked using ${command}`] });
      if (commit) {
        const reviewTask = await before("coordinator", "subagent", nativeTask(review.task));
        await prompt("reviewer", String(reviewTask.input.prompt));
        agents.reviewer!.outcome = "succeeded";
        const report = "PASS\nCommitted result matches the original request and real validation.", now = Date.now();
        history.reviewer!.push({ id: `msg_${++counter}`, type: "assistant", agent: "dog-reviewer-v010", finish: "stop",
          time: { created: now, completed: now }, content: [{ type: "text", text: report }] });
        await after(reviewTask, report, { sessionID: "reviewer" });
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
  } finally {
    cleanup?.();
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    for (const [key, value] of Object.entries(originalRouterEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [request, quote] of [
  ["Use the same author for new work", "same author"],
  ["Have the same author implement the change.", "same author"],
  ["Have the same author review code.", "same author"],
  ["Have the same author review source code.", "same author"],
  ["Have the same author review available source code.", "same author"],
  ["Have the same author implement the change and do not have a different author implement the follow-up.", "same author"],
  ["Have the same author implement the change and do not have the same reviewer review it.", "same author"],
  ["Have the same author implement the change and have the same reviewer review notes available.", "same author"],
  ["Use the same author again.", "same author"],
  ["Use the same author now.", "same author"],
  ["You have to use the same author for this change.", "same author"],
  ["You need to use the same author for this change.", "same author"],
  ["You may use the same author, but you must use the same author for this change.", "same author"],
  ["You may use the same author, but retain the same author for this change.", "same author"],
  ["Use the same author but you may use the same reviewer for this work.", "same author"],
  ["You may use the same reviewer and you must retain the same author for this change.", "same author"],
  ["You don't have to use the same reviewer and you must retain the same author for this change.", "same author"],
  ["You don't have to use the same author, but you must retain the same author for this change.", "same author"],
  ["The same author is not required, but you must use the same author for this change.", "same author"],
  ["Continue with the previous developer immediately.", "previous developer"],
  ["Continue with the previous developer for new work", "previous developer"],
  ["Keep the same developer for new work", "same developer"],
  ["Keep the same author and the same reviewer tools for new work.", "same author"],
  ["Use the same author and do not change the existing API.", "same author"],
  ["Do not change the existing API, use the same author.", "same author"],
  ["Use the same author and do not use a different author.", "same author"],
  ["Use the same author and do not automatically select a different author.", "same author"],
  ["Use the same author and you don't have to use a different author.", "same author"],
  ["Use the same author and you may use a different author.", "same author"],
  ["Use the same author and you don't have to use the same author's API.", "same author"],
  ["Use the same author and you do not need to use the same reviewer.", "same author"],
  ["Use the same author, but you may use the same reviewer for this work.", "same author"],
  ["Use the same author, but you can have the same reviewer review the change.", "same author"],
  ["Use a different author. Actually, use the same author for this work.", "same author"],
  ["Use the same author. Do not change the existing API.", "same author"],
  ["Use the same author and the same reviewer. Actually, select a different reviewer.", "same author"],
  ["前回の実装担当で続けて", "前回の実装担当"],
  ["前回の実装担当に修正を依頼して。", "前回の実装担当"],
  ["同じ作者を使い、既存のAPIを変更する。", "同じ作者"],
  ["同じ作者で続けて、別の担当のAPIを使って。", "同じ作者"],
  ["同じ作者で続けて、別の担当に修正を依頼しないで。", "同じ作者"],
  ["同じ実装担当が担当する。", "同じ実装担当"],
  ["同じ実装担当が担当すること。", "同じ実装担当"],
]) test(`V2 new Mission retains an explicit author choice without transferring authority: ${request}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-prior-coordinator-"));
  const fixture = contextFixture();
  const history: Record<string, unknown[]> = { root: [], previous: [] };
  const context: OpenCodeV2Context = { ...fixture.context, location: { directory },
    session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID, agent: sessionID === "root" ? "dog-operator" : "dogs-coordinator",
        ...(sessionID === "root" ? {} : { parentID: "root" }), model: { providerID: "openai", id: "gpt-6-sol" } }),
      context: async ({ sessionID }) => history[sessionID] ?? [],
    } };
  const cleanup = await V2Plugin.setup(context);
  try {
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "msg_previous", text: "Complete the prior work" });
    const previous = await missions.start("root", ["Complete the prior work"]);
    await missions.update("root", state => { state.coordinator = "previous"; state.phase = "completed"; state.dispatchOpen = false; });
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_request",
      prompt: { text: request } });
    const start = fixture.tools.find(tool => tool.name === "sortie_v010_start_mission") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }>;
    };
    const packet = JSON.parse((await start.execute({ requirements: [request],
      preferred_executor: "coordinator" }, { sessionID: "root", agent: "dog-operator", callID: "call_start" })).content);
    assert.notEqual(packet.mission_id, previous.id);
    assert.equal(packet.status, "mission-author-continuation-unavailable");
    assert.equal(packet.reason, "explicit_author_continuation_input_required");
    assert.equal(packet.task, undefined, "the explicit author restriction must not offer a substitute Task");
    const task = missions.task(await missions.required("root"));
    assert.equal(task.task_id, undefined);
    const dispatch = { sessionID: "root", agent: "dog-operator", tool: "subagent", id: "call_old_author",
      input: { agent: task.subagent_type, description: task.description,
        prompt: task.prompt, sessionID: "previous" } };
    await assert.rejects(fixture.toolHooks.get("execute.before")!(dispatch),
      /mission-dispatch-not-authorized: this location owns Coordinator not yet claimed, not previous/u);
    await assert.rejects(fixture.toolHooks.get("execute.before")!({ ...dispatch, id: "call_substitute",
      input: { agent: task.subagent_type, description: task.description, prompt: task.prompt } }),
    /mission-author-continuation-not-authorized/u);
    const current = await missions.required("root");
    assert.equal(current.coordinator, null);
    assert.equal(current.dispatchOpen, false);
    const unproven = JSON.parse((await start.execute({ requirements: [request],
      preferred_executor: "coordinator", author_continuation: { request_quote: quote, work_directory: directory } },
    { sessionID: "root", agent: "dog-operator", callID: "call_start_continuation" })).content);
    assert.equal(unproven.status, "mission-author-continuation-unavailable");
    assert.equal(unproven.reason, "completed_predecessor_run_unavailable");
    assert.equal(unproven.task, undefined);
    if (request === "Have the same author implement the change and do not have the same reviewer review it." ||
        request === "Use the same author and you do not need to use the same reviewer." ||
        request === "Use the same author, but you may use the same reviewer for this work." ||
        request === "Use the same author, but you can have the same reviewer review the change." ||
        request === "Have the same author implement the change and have the same reviewer review notes available." ||
        request === "Use the same author and the same reviewer. Actually, select a different reviewer.") {
      const rejectedReviewer = JSON.parse((await start.execute({ requirements: [request],
        author_continuation: { request_quote: quote, reviewer_quote: "same reviewer", work_directory: directory } },
      { sessionID: "root", agent: "dog-operator", callID: "call_negated_reviewer" })).content);
      assert.equal(rejectedReviewer.reason, "user_intent_quote_unavailable");
      assert.equal(rejectedReviewer.task, undefined);
    }
    const invalid = JSON.parse((await start.execute({ requirements: [request],
      author_continuation: { request_quote: "not the user's choice", work_directory: directory } },
    { sessionID: "root", agent: "dog-operator", callID: "call_invalid_quote" })).content);
    assert.equal(invalid.reason, "user_intent_quote_unavailable");
    const retained = JSON.parse((await start.execute({ requirements: [request] },
      { sessionID: "root", agent: "dog-operator", callID: "call_omit_invalid_quote" })).content);
    assert.equal(retained.mission_id, packet.mission_id);
    assert.equal(retained.task, undefined, "rejecting a caller quote cannot clear the user's genuine author restriction");
    assert.equal((await missions.required("root")).authorContinuation!.quote, quote);
    if (request === "Use the same author for new work") {
      await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_narrow",
        prompt: { text: "Limit the files; keep the other requirements unchanged." } });
      const replacement = JSON.parse((await start.execute({ intent: "replace", requirements: [request, "Limit the files"] },
        { sessionID: "root", agent: "dog-operator", callID: "call_replace_unproven" })).content);
      assert.equal(replacement.task, undefined, "a scope replacement cannot erase an unproven user selection");
      assert.equal(replacement.reason, "completed_predecessor_run_unavailable");
      assert.equal((await missions.required("root")).authorContinuation!.quote, quote);
      const retried = JSON.parse((await start.execute({ requirements: [request, "Limit the files"],
        author_continuation: { request_quote: quote, work_directory: directory } },
      { sessionID: "root", agent: "dog-operator", callID: "call_retry_original_quote" })).content);
      assert.equal(retried.reason, "completed_predecessor_run_unavailable", "the earlier real quote remains usable after narrowing");
      assert.equal(retried.task, undefined);
    }
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

for (const request of [
  "Keep the same authorization checks while fixing this bug.",
  "Keep the same developer experience while fixing the bug.",
  "Use the same developer tools to fix the bug.",
  "Use the same developer documentation to fix the bug.",
  "Keep the same developer workflow while fixing the bug.",
  "Have the same author implementation notes available for the change.",
  "Have the same author review notes available for the change.",
  "Have the same author review notes ready for the change.",
  "Use the same author and reviewer tools to fix the bug.",
  "Use the same reviewer and author tools to fix the bug.",
  "The previous developer left a bug; fix it.",
  "Use the API written by the previous developer.",
  "Use the previous developer's API to fix the bug.",
  "Keep the original author’s tests passing.",
  "Use the same author and reviewer’s API to fix the bug.",
  "Use the same reviewer and author's API to fix the bug.",
  "Fix the same bug reported by the developer.",
  "前回の実装担当の引継ぎが止まった原因を調べて。",
  "前回の実装担当が担当したAPIを使って修正して。",
  "同じ実装担当が担当しているAPIを使って修正して。",
  "同じ実装担当が担当するAPIを使って修正して。",
  "同じ実装担当が担当することになっているAPIを使って修正して。",
  "前回の実装担当に修正を依頼したAPIを使って修正して。",
  "Do not automatically select the same author for new work.",
  "You don't have to use the same author for this change.",
  "You do not need to use the same author for this change.",
  "You may use the same author for this change, but it is not required",
  "You may reuse the same author and retain the same reviewer, but neither is required.",
  "You may retain the same reviewer and reuse the same author, but neither is required.",
  "You don't have to use the same author and retain the same reviewer, but neither is required.",
  "You do not need to retain the same reviewer and use the same author for this change.",
  "You can use the same author for this change.",
  "You may have the same author implement the change.",
  "You are allowed to use the same author for this change.",
  "You may use the same developer documentation to fix the bug.",
  "You may not use the same author for this change.",
  "Do not have the same author implement the change.",
  "Have the same author not implement the change.",
  "Do not have the same author review source code.",
  "Have the same author not review source code.",
  "前回の実装担当に修正を依頼しないで。",
  "Use the same author. Actually, select a different author for this work.",
  "Use the same author. Do not use the same author for this work.",
  "同じ作者で続けて。別の担当に修正を依頼して。",
]) test(`V2 ordinary Mission does not infer an author restriction: ${request}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-author-no-restriction-")), fixture = contextFixture();
  const cleanup = await V2Plugin.setup({ ...fixture.context, location: { directory },
    session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator", location: { directory } }) } });
  try {
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_request", prompt: { text: request } });
    const start = fixture.tools.find(tool => tool.name === "sortie_v010_start_mission") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }> };
    const packet = JSON.parse((await start.execute({ requirements: [request], preferred_executor: "coordinator" },
      { sessionID: "root", agent: "dog-operator", callID: "call_start" })).content);
    assert.ok(packet.task, "a description of earlier work or authorization is not a same-author instruction");
    assert.equal(packet.task.task_id, undefined);
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    assert.equal((await missions.required("root")).authorContinuation, undefined);
    const rejected = JSON.parse((await start.execute({ requirements: [request],
      author_continuation: { request_quote: "same author", work_directory: directory } },
    { sessionID: "root", agent: "dog-operator", callID: "call_invalid_choice" })).content);
    const optionalAuthor = [
      "You don't have to use the same author for this change.",
      "You do not need to use the same author for this change.",
      "You may use the same author for this change, but it is not required",
      "You may reuse the same author and retain the same reviewer, but neither is required.",
      "You may retain the same reviewer and reuse the same author, but neither is required.",
      "You don't have to use the same author and retain the same reviewer, but neither is required.",
      "You do not need to retain the same reviewer and use the same author for this change.",
      "You can use the same author for this change.",
      "You may have the same author implement the change.",
      "You are allowed to use the same author for this change.",
    ].includes(request);
    assert.equal(rejected.reason, optionalAuthor ? "completed_predecessor_run_unavailable" : "user_intent_quote_unavailable");
    assert.equal(rejected.task, undefined);
    assert.equal((await missions.required("root")).authorContinuation, undefined,
      "an unproven optional choice must not create a mandatory restriction");
    const corrected = JSON.parse((await start.execute({ requirements: [request], preferred_executor: "coordinator" },
      { sessionID: "root", agent: "dog-operator", callID: "call_corrected_choice" })).content);
    assert.equal(corrected.mission_id, packet.mission_id, "correcting an invalid option does not replace the Mission");
    assert.deepEqual(corrected.budget, packet.budget, "no admission or replacement changes accounting");
    assert.ok(corrected.task, "a rejected caller option cannot create a restriction absent from the user request");
    assert.equal(corrected.task.task_id, undefined);
    const current = await missions.required("root");
    assert.equal(current.authorContinuation, undefined);
    assert.equal(current.coordinator, null);
    assert.equal(current.runID, null);
    assert.equal(current.dispatchOpen, false);
    if (request === "Keep the same authorization checks while fixing this bug.") {
      // Reproduce the old persisted rejection, not an authorization or an active owner.
      await missions.update("root", state => {
        state.authorContinuation = { requestID: "msg_request", quote: "same author", directory,
          blocked: "user_intent_quote_unavailable" };
      });
      const recovered = JSON.parse((await start.execute({ requirements: [request] },
        { sessionID: "root", agent: "dog-operator", callID: "call_recover_old_rejection" })).content);
      assert.equal(recovered.mission_id, packet.mission_id);
      assert.ok(recovered.task, "an older unadmitted invalid quote can be corrected without cancelling its Mission");
      assert.deepEqual(recovered.budget, packet.budget);
      assert.equal((await missions.required("root")).authorContinuation, undefined);
    }
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

for (const [request, reason] of [
  ["You may use the same author, but you must use the same reviewer.", "explicit_author_continuation_input_required"],
  ["You may use the same author or select a different author, but use the same reviewer.", "explicit_author_continuation_input_required"],
  ["You may use the same author for implementation while the coordinator must fix the bug and retain the same reviewer.", "explicit_author_continuation_input_required"],
  ["You may use the same author while the coordinator must implement the fix and retain the same reviewer.", "explicit_author_continuation_input_required"],
  ["Do not use the same author, but use the same reviewer.", "requested_author_reviewer_lineage_conflict"],
]) test(`V2 preserves a required reviewer when the author's choice is not mandatory: ${request}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-optional-author-reviewer-")), fixture = contextFixture();
  const cleanup = await V2Plugin.setup({ ...fixture.context, location: { directory },
    session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator", location: { directory } }) } });
  try {
    const start = fixture.tools.find(tool => tool.name === "sortie_v010_start_mission") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }> };
    const prompt = (messageID: string, text: string) =>
      fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID, prompt: { text } });
    const call = async (callID: string) => JSON.parse((await start.execute(
      { requirements: [request], preferred_executor: "coordinator" },
      { sessionID: "root", agent: "dog-operator", callID })).content);
    await prompt("msg_request", request);
    const held = await call("call_start");
    assert.equal(held.reason, reason);
    assert.equal(held.task, undefined);
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    assert.equal((await missions.required("root")).authorContinuation!.blocked, reason);
    if (reason === "requested_author_reviewer_lineage_conflict") {
      await prompt("msg_allow_author", "You may use the same author for this work.");
      const corrected = await call("call_allow_author");
      assert.equal(corrected.mission_id, held.mission_id);
      assert.equal(corrected.reason, "explicit_author_continuation_input_required");
      assert.equal(corrected.task, undefined);
    }
    await prompt("msg_allow_reviewer", "You may use the same reviewer for this work.");
    const released = await call("call_allow_reviewer");
    assert.equal(released.mission_id, held.mission_id);
    assert.ok(released.task, "releasing both choices must restore an ordinary Task");
    assert.equal(released.task.task_id, undefined);
    const status = fixture.tools.find(tool => tool.name === "sortie_v010_operator_status") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }> };
    const observed = JSON.parse((await status.execute({ view: "progress" },
      { sessionID: "root", agent: "dog-operator", callID: "call_status" })).content);
    assert.deepEqual(observed.budget, held.budget);
    const current = await missions.required("root");
    assert.equal(current.authorContinuation, undefined);
    assert.equal(current.coordinator, null);
    assert.equal(current.runID, null);
    assert.equal(current.dispatchOpen, false);
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

for (const [request, quote] of [
  ["Do not use the same author for this new work.", "same author"],
  ["You may not use the same author for this change.", "same author"],
  ["Do not automatically select the same author for new work.", "same author"],
  ["Do not have the same author implement the change.", "same author"],
  ["Do not have the same author review source code.", "same author"],
  ["Have the same author implement the change, but the same author should not implement it.", "same author"],
  ["Have the same author implement the change, but have a different author implement the follow-up.", "same author"],
  ["Use the same author and do not use the same author.", "same author"],
  ["Use the same author, but the same author should not be used.", "same author"],
  ["Use the same author, but the same author is unnecessary.", "same author"],
  ["Use the same author and select a different author.", "same author"],
  ["同じ作者を使って、同じ作者を使わない。", "同じ作者"],
  ["前回の実装担当に修正を依頼しないで。", "前回の実装担当"],
  ["前回の実装担当に修正を任せないで。", "前回の実装担当"],
  ["同じ作者で続けて、別の担当に修正を依頼して。", "同じ作者"],
  ["Use the same author. Actually, select a different author for this work.", "same author"],
  ["Use the same author. Do not use the same author for this work.", "same author"],
  ["同じ作者で続けて。別の担当に修正を依頼して。", "同じ作者"],
]) test(`V2 author continuation cannot use a quote that negates the user's instruction: ${request}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-author-intent-")), fixture = contextFixture();
  const cleanup = await V2Plugin.setup({ ...fixture.context, location: { directory },
    session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator", location: { directory } }) } });
  try {
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_request",
      prompt: { text: request } });
    const start = fixture.tools.find(tool => tool.name === "sortie_v010_start_mission") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }> };
    const packet = JSON.parse((await start.execute({ requirements: ["Use a different author"],
      author_continuation: { request_quote: quote, work_directory: directory } },
    { sessionID: "root", agent: "dog-operator", callID: "call_start" })).content);
    assert.equal(packet.status, "mission-author-continuation-unavailable");
    assert.equal(packet.reason, "user_intent_quote_unavailable");
    assert.equal(packet.task, undefined);
    const state = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(state.coordinator, null);
    assert.equal(state.dispatchOpen, false);
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

for (const [request, requestQuote, reviewerQuote, workspace] of [
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git"],
  ["Use the same author and the same reviewer, but you may select a different reviewer.", "same author", "same reviewer", "git"],
  ["You may use the same author, but you must use the same reviewer for the new result.", "same author", "same reviewer", "git-optional-author-required-reviewer"],
  ["You may use the same author or select a different author, but use the same reviewer for the new result.", "same author", "same reviewer", "git-optional-author-required-reviewer"],
  ["You may use the same author for implementation while the coordinator must fix the bug and retain the same reviewer.", "same author", "same reviewer", "git-optional-author-required-reviewer"],
  ["You may use the same author while the coordinator must implement the fix and retain the same reviewer.", "same author", "same reviewer", "git-optional-author-required-reviewer"],
  ["You may use the same author for the new result, but it is not required.", "same author", undefined, "git-optional-author-selected"],
  ["Have the same author implement the change, and have the same reviewer review it.", "same author", "same reviewer", "git"],
  ["Have the same author implement the change, and have the same reviewer review code.", "same author", "same reviewer", "git"],
  ["Have the same author implement the change, and have the same reviewer review source code.", "same author", "same reviewer", "git"],
  ["Have the same author and reviewer review the change.", "same author", "same author and reviewer", "git"],
  ["Use the same author and reviewer for the new result.", "same author", "same author and reviewer", "git"],
  ["前回の実装担当・Reviewerで続けて。", "前回の実装担当", "前回の実装担当・Reviewer", "git"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-readonly-read"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-readonly-execution"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-glob-all"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-glob-ts"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-running"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-change"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-reviewer-change"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-author-change"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-reviewer-change"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-author-optional"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-author-optional-declarative"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-author-optional-permission"],
  ["Use the same author for the new result.", "same author", undefined, "git-replace-earlier-author-optional-alone"],
  ["Use the same author for the new result.", "same author", undefined, "git-replace-earlier-author-optional-alone-permission"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-author-conflict"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-reviewer-optional"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-replace-earlier-reviewer-permission"],
  ["Use the same author for the new result.", "same author", undefined, "git-permission-author-no-replace"],
  ["Use the same author and the same reviewer for the new result.", "same author", "same reviewer", "git-permission-reviewer-no-replace"],
  ["Use the same author for the new result.", "same author", undefined, "git-add-reviewer"],
  ["Use the same author for the new result.", "same author", undefined, "git-add-reviewer-replace"],
  ["Use the same author and reviewer and do not change the existing API.", "same author", "same author and reviewer", "non-git-default"],
  ["Use the same author and reviewer and you do not need to change the existing API.", "same author", "same author and reviewer", "non-git-default"],
  ["Use the same author and reviewer for the new result.", "same author", "same author and reviewer", "non-git-registered-default"],
  ["Use the same author and reviewer for the new result.", "same author", "same author and reviewer", "non-git-registered-other"],
  ["Use the same author and reviewer for the new result.", "same author", "same author and reviewer", "non-git-partial-cwd"],
]) test(`V2 explicitly continues the completed actual author and reviews the new candidate without old authority: ${request} (${workspace})`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(workspace === "git" ? resolve("_testenv/v2-author-continuation-")
    : join(tmpdir(), "v2-author-continuation-"));
  const otherCwd = join(directory, "checks");
  const resultFile = workspace === "git-glob-ts" ? "result.ts" : "result.txt";
  const fixture = contextFixture(), exec = promisify(execFile);
  const history: Record<string, Record<string, unknown>[]> = {};
  const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
    root: { agent: "dog-operator" }, author: { agent: "dogs-coordinator", parentID: "root" },
    reviewer: { agent: "dog-reviewer-v010", parentID: "author" },
  };
  let active: Record<string, unknown> | undefined = {}, inbox: Record<string, unknown[]> = {}, counter = 0, duplicateChildren = false;
  const cleanup = await V2Plugin.setup({ ...fixture.context, location: { directory },
    session: { ...fixture.context.session, active: async () => active,
      inbox: { list: async ({ sessionID }) => inbox[sessionID] ?? [] },
      list: async ({ parentID }) => {
        const children = Object.entries(agents).filter(([, info]) => info.parentID === parentID).map(([id, info]) => ({ id, ...info }));
        return { data: duplicateChildren && parentID === "author" ? [...children, ...children] : children, cursor: {} };
      },
      get: async ({ sessionID }) => ({ id: sessionID, ...agents[sessionID], location: { directory },
        model: { providerID: "openai", id: "fixture" } }),
      context: async ({ sessionID }) => history[sessionID] ?? [] },
    message: { list: async ({ sessionID, order }) => ({ data: order === "desc" ? [...(history[sessionID] ?? [])].reverse()
      : history[sessionID] ?? [], cursor: {} }) } });
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
    await fixture.toolHooks.get("execute.after")!({ ...event, status: "completed", result: { content, metadata } });
  };
  const tool = async (sessionID: string, name: string, input: Record<string, unknown> = {}) => {
    const event = await before(sessionID, `sortie_v010_${name}`, input);
    const definition = fixture.tools.find(item => item.name === `sortie_v010_${name}`) as {
      execute(input: unknown, context: unknown): Promise<{ content: string }> };
    const result = await definition.execute(event.input, { sessionID, agent: agents[sessionID]!.agent, callID: event.id });
    await after(event, result.content);
    return JSON.parse(result.content);
  };
  const nativeTask = (task: Record<string, unknown>) => ({ agent: task.subagent_type, prompt: task.prompt,
    description: task.description, ...(task.task_id ? { sessionID: task.task_id } : {}) });
  const edit = async (from: string | undefined, to: string) => {
    const patchText = from === undefined ? `*** Begin Patch\n*** Add File: ${resultFile}\n+${to}\n*** End Patch`
      : `*** Begin Patch\n*** Update File: ${resultFile}\n@@\n-${from}\n+${to}\n*** End Patch`;
    const event = await before("author", "patch", { patchText });
    await writeFile(join(directory, resultFile), `${to}\n`);
    await after(event, "updated");
  };
  const validate = async (expected: string, readOnly = false) => {
    const cwd = readOnly || workspace === "non-git-registered-other" && expected === "first" ? otherCwd : directory;
    const checks = [{ cwd, suffix: "" }, ...(readOnly && workspace === "git-readonly-execution"
      ? [{ cwd: directory, suffix: " --secondary" }]
      : workspace === "non-git-partial-cwd" && expected === "first" ? [{ cwd: otherCwd, suffix: " --secondary" }] : [])];
    for (const check of checks) {
      const event = await before("author", "shell", { command: `node check.mjs ${expected}${check.suffix}`, workdir: check.cwd });
      const result = await exec(process.execPath, ["check.mjs", expected, ...(check.suffix ? ["--secondary"] : [])], { cwd: check.cwd });
      await after(event, result.stdout, { exit: 0 });
    }
  };
  try {
    if (workspace.startsWith("git")) await exec("git", ["init", "--quiet"], { cwd: directory });
    else await assert.rejects(exec("git", ["rev-parse", "--show-toplevel"], { cwd: directory }), "the workspace must actually be outside Git");
    await writeFile(join(directory, "check.mjs"), `import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; assert.equal(readFileSync(${JSON.stringify(resultFile)},"utf8").trim(),process.argv[2]);`);
    if (workspace.startsWith("non-git-registered") || workspace === "non-git-partial-cwd") {
      await mkdir(otherCwd);
      await writeFile(join(otherCwd, "check.mjs"), 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; assert.equal(readFileSync("../result.txt","utf8").trim(),process.argv[2]);');
    }
    await prompt("root", "Create the first result and review it.");
    const old = await tool("root", "start_mission", { requirements: ["Create the first result"], preferred_executor: "coordinator" });
    const firstDispatch = await before("root", "subagent", nativeTask(old.task));
    await prompt("author", String(firstDispatch.input.prompt));
    const unit = (expected: string) => ({ title: "Result", objective: `Write ${expected}`, read: ["check.mjs"],
      write: workspace === "git-glob-all" ? expected === "first" ? ["**"] : [join(dirname(directory), "unrelated", "**"), "**"]
        : [workspace === "git-glob-ts" ? "*.ts" : "result.txt"], validation: [`node check.mjs ${expected}`,
        ...(workspace === "non-git-partial-cwd" && expected === "first" ? [`node check.mjs ${expected} --secondary`] : [])],
      ...(workspace === "non-git-registered-default" && expected === "first"
        ? { validation_cwd: { [`node check.mjs ${expected}`]: otherCwd } }
        : workspace === "non-git-partial-cwd" && expected === "first"
          ? { validation_cwd: { [`node check.mjs ${expected} --secondary`]: otherCwd } } : {}) });
    const originalUnit = unit("first");
    await tool("author", "plan_units", { executor: "self", units: [originalUnit] });
    if (workspace.startsWith("non-git-registered")) {
      const { validation_cwd: _initialCwd, ...withoutCwd } = originalUnit;
      const corrected = workspace === "non-git-registered-default" ? withoutCwd
        : { ...withoutCwd, validation_cwd: { "node check.mjs first": otherCwd } };
      const registered = await tool("author", "plan_units", { executor: "self", units: [corrected], reason: "Correct the validation directory" });
      assert.equal(registered.status, "direct-unit-registration-corrected");
    }
    await edit(undefined, "first");
    await validate("first");
    assert.match((await tool("author", "finish_direct_unit")).next_action, /This direct unit is validated/u);
    const authorBackground = await before("author", "shell", { command: "node retained-writer.mjs", background: true });
    await after(authorBackground, "Background process running", { status: "running" });
    const authorTool = (history.author!.at(-1)!.content as Record<string, unknown>[])[0]!;
    const oldReview = await tool("author", "review_mission", { risk_tags: ["public-logic"], traces: [] });
    const firstReview = await before("author", "subagent", nativeTask(oldReview.task));
    await prompt("reviewer", String(firstReview.input.prompt));
    const reviewerBackground = await before("reviewer", "shell", { command: "git status --short", background: true });
    await after(reviewerBackground, "Background process running", { status: "running" });
    const reviewerTool = (history.reviewer!.at(-1)!.content as Record<string, unknown>[])[0]!;
    agents.reviewer!.outcome = "succeeded";
    const oldReport = "PASS\nThe first candidate is correct.", now = Date.now();
    (history.reviewer ??= []).push({ id: `msg_${++counter}`, type: "assistant", agent: "dog-reviewer-v010",
      finish: "stop", time: { created: now, completed: now }, content: [{ type: "text", text: oldReport }] });
    await after(firstReview, oldReport, { sessionID: "reviewer" });
    // Native background launch metadata is historical; the exact child terminal
    // must allow recovery without requiring edits to that launch record.
    const completedReviewTool = (history.author!.at(-1)!.content as Record<string, unknown>[])[0]!;
    (completedReviewTool.state as Record<string, unknown>).metadata = { sessionID: "reviewer", status: "running" };
    await tool("author", "submit_mission", { status: "ready", summary: "First result ready" });
    agents.author!.outcome = "succeeded";
    await after(firstDispatch, "First result ready", { sessionID: "author" });
    assert.equal((await tool("root", "complete_mission")).status, "succeeded");
    const oldRun = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(oldRun.phase, "completed");
    if (workspace === "git-glob-ts") assert.ok(oldRun.units[0]!.unit.write.includes("*.ts"));
    if (workspace === "non-git-registered-default") {
      assert.deepEqual(oldRun.units[0]!.unit.validation_cwd, { "node check.mjs first": otherCwd });
      assert.deepEqual(oldRun.units[0]!.directExecution!.validationCwd, {});
    } else if (workspace === "non-git-registered-other") {
      assert.equal(oldRun.units[0]!.unit.validation_cwd, undefined);
      assert.deepEqual(oldRun.units[0]!.directExecution!.validationCwd, { "node check.mjs first": otherCwd });
    } else if (workspace === "non-git-partial-cwd") {
      assert.deepEqual(oldRun.units[0]!.unit.validation_cwd, { "node check.mjs first --secondary": otherCwd });
      assert.equal(oldRun.units[0]!.directExecution!.validationCwd, undefined);
    }

    await prompt("root", request);
    const requirements = [reviewerQuote ? "Use the same author and reviewer to write the new result"
      : "Use the same author to write the new result"];
    const selection = { request_quote: requestQuote, reviewer_quote: reviewerQuote, work_directory: directory };
    const start = (choice = selection) => tool("root", "start_mission", {
      requirements, preferred_executor: "coordinator", author_continuation: choice });
    const wrongQuote = await start({ ...selection, request_quote: "different author" });
    assert.equal(wrongQuote.status, "mission-author-continuation-unavailable");
    assert.equal(wrongQuote.reason, "user_intent_quote_unavailable");
    assert.equal(wrongQuote.task, undefined);
    if (workspace === "git-optional-author-selected") {
      assert.ok((await tool("root", "operator_status")).task, "an invalid optional choice cannot block ordinary work");
    } else {
      assert.equal((await tool("root", "operator_status")).task, undefined);
      await assert.rejects(before("root", "patch", { patchText: "*** Begin Patch\n*** Add File: substitute.txt\n+wrong author\n*** End Patch" }),
        /mission-author-continuation-author-required/u);
    }
    if (reviewerQuote) assert.equal((await tool("root", "start_mission", { requirements, preferred_executor: "coordinator",
      author_continuation: { request_quote: requestQuote, work_directory: directory } })).reason,
    "explicit_reviewer_continuation_input_required", "an explicit same-Reviewer request cannot become a silent substitution");
    if (workspace !== "git-optional-author-selected") {
      await assert.rejects(tool("root", "plan_units", { executor: "self", units: [unit("second")] }),
        /mission-author-continuation-author-required/u);
    }
    assert.equal((await start({ ...selection, work_directory: join(directory, "missing") })).reason, "work_directory_unavailable_or_changed");
    assert.equal((await start({ ...selection, work_directory: dirname(directory) })).reason, "predecessor_native_write_unproven",
      "a common ancestor is not the actual repository where the prior author wrote");
    if (workspace === "non-git-default" || workspace.startsWith("git-glob-")) {
      const index = history.author!.findIndex(message => Array.isArray(message.content) &&
        message.content.some((part: { name?: string }) => part.name === "patch"));
      assert.notEqual(index, -1);
      const [write] = history.author!.splice(index, 1);
      const held = await start();
      assert.equal(held.reason, "predecessor_native_write_unproven", "the default cwd alone cannot replace native write proof");
      assert.equal(held.task, undefined);
      history.author!.splice(index, 0, write!);
    }
    if (workspace === "non-git-registered-other") {
      const held = await start();
      assert.equal(held.reason, "predecessor_native_write_unproven", "an explicitly registered different validation directory is not the default");
      assert.equal(held.task, undefined);
      const state = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(state.coordinator, null);
      assert.equal(state.dispatchOpen, false);
      return;
    }
    agents.author!.parentID = "other-root";
    assert.match((await start()).reason, /native_lineage/u);
    agents.author!.parentID = "root";
    delete agents.author!.outcome;
    assert.equal((await start()).reason, "native_terminal_unknown");
    agents.author!.outcome = "succeeded";
    // A terminal session can still own an unfinished background process. Check the
    // current native tool state for each owner independently: another pending
    // process must not mask a missing check for the selected owner.
    for (const part of [authorTool, reviewerTool]) (part.state as Record<string, unknown>).metadata = { status: "completed", exit: 0 };
    for (const part of [authorTool, reviewerTool]) {
      for (const status of ["running", "pending", "unknown"]) {
        (part.state as Record<string, unknown>).metadata = { status };
        assert.match((await start()).reason, /native_tools_active_or_unproven/u);
      }
      // The native completion updates this same call, rather than fabricating a
      // new owner or treating its successful launch as process completion.
      (part.state as Record<string, unknown>).metadata = { status: "completed", exit: 0 };
    }
    active = undefined;
    assert.equal((await start()).reason, "native_activity_unavailable");
    active = { author: { type: "running" } };
    assert.equal((await start()).reason, "native_session_active");
    active = {};
    duplicateChildren = true;
    assert.equal((await start()).reason, "native_lineage_duplicate_or_too_large");
    duplicateChildren = false;
    inbox.author = [{ id: "queued" }];
    assert.equal((await start()).reason, "native_inbox_not_empty");
    inbox = {};
    let second = await start();
    if (workspace.startsWith("git-add-reviewer")) {
      const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
      const selected = await missions.required("root");
      assert.equal(second.task.task_id, "author");
      assert.equal(selected.authorContinuation!.reviewerQuote, undefined);
      const budget = (await tool("root", "operator_status", { view: "progress" })).budget;
      await prompt("root", "Use the same reviewer for this work as well.");
      const reviewerRequestID = history.root!.at(-1)!.id;
      requirements.push("Use the same reviewer");
      const adopted = await tool("root", "start_mission", { requirements });
      assert.equal(adopted.reason, "explicit_reviewer_continuation_input_required");
      assert.equal(adopted.task, undefined, "an unquoted newly adopted Reviewer choice must not offer an unusable Task");
      assert.equal(adopted.mission_id, second.mission_id);
      if (workspace === "git-add-reviewer-replace") {
        await prompt("root", "Limit the implementation to result.txt; keep the other requirements unchanged.");
        requirements.unshift("Only change result.txt");
        const narrowed = await tool("root", "start_mission", { intent: "replace", requirements });
        assert.equal(narrowed.reason, "explicit_reviewer_continuation_input_required");
        assert.equal(narrowed.task, undefined);
        assert.notEqual(narrowed.mission_id, second.mission_id);
      }
      const held = await missions.required("root");
      assert.equal(held.authorContinuation!.child, "author");
      assert.equal(held.runID, null);
      const invalid = await start({ ...selection, reviewer_quote: "not the user's choice" });
      assert.equal(invalid.reason, "user_intent_quote_unavailable");
      assert.equal(invalid.task, undefined);
      const rejected = await missions.required("root");
      assert.deepEqual(rejected.authorContinuation, held.authorContinuation,
        "an invalid additional quote cannot change the selected author or Reviewer");
      assert.deepEqual([rejected.id, rejected.coordinator, rejected.runID, rejected.dispatchOpen],
        [held.id, held.coordinator, held.runID, held.dispatchOpen]);
      await assert.rejects(start({ ...selection, work_directory: dirname(directory), reviewer_quote: "same reviewer" }),
        /mission-author-continuation-selection-frozen/u, "adding a Reviewer cannot change the selected work location");
      Object.assign(selection, { reviewer_quote: "same reviewer" });
      active = { reviewer: { type: "running" } };
      const busy = await start();
      assert.equal(busy.reason, "native_session_active");
      assert.equal(busy.task, undefined, "a later Reviewer selection still requires its current native idle proof");
      active = {};
      second = await start();
      const updated = await missions.required("root");
      assert.equal(second.task.task_id, "author");
      assert.equal(updated.id, held.id);
      assert.equal(updated.authorContinuation!.requestID, selected.authorContinuation!.requestID);
      assert.equal(updated.authorContinuation!.reviewerRequestID, reviewerRequestID);
      assert.equal(updated.authorContinuation!.reviewer, "reviewer");
      assert.equal(updated.coordinator, null);
      assert.equal(updated.runID, null);
      assert.equal(updated.review, undefined);
      await assert.rejects(start({ ...selection, reviewer_quote: undefined }),
        /mission-author-continuation-selection-frozen/u, "a successfully added Reviewer choice cannot be silently removed");
      assert.deepEqual((await tool("root", "operator_status", { view: "progress" })).budget, budget,
        "adding a user restriction does not admit work or import earlier accounting");
    }
    assert.notEqual(second.mission_id, old.mission_id);
    assert.equal(second.task.task_id, "author");
    const state = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(state.coordinator, null, "the new Task has not been claimed or granted an old write scope");
    assert.equal(state.runID, null);
    assert.equal(state.review, undefined, "the prior Review verdict is not transferred");
    if (workspace === "git-optional-author-selected") {
      const retained = await tool("root", "start_mission", { requirements });
      assert.equal(retained.mission_id, second.mission_id);
      assert.equal(retained.task.task_id, "author", "an explicit optional choice remains usable on a later call");
      assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).authorContinuation!.child, "author");
    }
    if (workspace === "git-permission-author-no-replace" || workspace === "git-permission-reviewer-no-replace") {
      const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
      const beforeBudget = (await tool("root", "operator_status", { view: "progress" })).budget;
      await prompt("root", workspace === "git-permission-author-no-replace"
        ? "You may use the same author for this change, but it is not required."
        : "You may use the same reviewer for this change, but it is not required.");
      const updated = await tool("root", "start_mission", { requirements });
      const current = await missions.required("root");
      assert.equal(updated.mission_id, second.mission_id);
      assert.equal(current.coordinator, null);
      assert.equal(current.runID, null);
      assert.equal(current.dispatchOpen, false);
      assert.deepEqual((await tool("root", "operator_status", { view: "progress" })).budget, beforeBudget);
      if (workspace === "git-permission-author-no-replace") {
        assert.equal(current.authorContinuation, undefined);
        assert.equal(updated.task.task_id, undefined, "the newly optional author must not be fixed");
        return;
      }
      assert.equal(current.authorContinuation!.child, "author");
      assert.equal(current.authorContinuation!.reviewer, undefined);
      assert.equal(current.authorContinuation!.reviewerQuote, undefined);
      assert.equal(updated.task.task_id, "author");
      second = updated;
    }
    if (workspace.startsWith("git-replace")) {
      const optionalAuthor = workspace.startsWith("git-replace-earlier-author-optional");
      const optionalReviewer = workspace === "git-replace-earlier-reviewer-optional" || workspace === "git-replace-earlier-reviewer-permission";
      const authorReviewerConflict = workspace === "git-replace-earlier-author-conflict";
      const changedAuthor = workspace === "git-replace-change" || workspace === "git-replace-earlier-author-change" ||
        optionalAuthor && !reviewerQuote;
      const changedReviewer = workspace === "git-replace-reviewer-change" || workspace === "git-replace-earlier-reviewer-change" || optionalReviewer;
      if (workspace === "git-replace-running") {
        const activeDispatch = await before("root", "subagent", nativeTask(second.task));
        delete agents.author!.outcome;
        await prompt("author", String(activeDispatch.input.prompt));
        await tool("author", "plan_units", { executor: "self", units: [unit("second")] });
        await prompt("root", "Limit the implementation to result.txt; keep the other requirements unchanged.");
        const beforeHold = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        const beforeRun = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        const beforeBudget = (await tool("root", "operator_status", { view: "progress" })).budget;
        const busy = await tool("root", "start_mission", { intent: "replace",
          requirements: ["Only change result.txt", ...requirements] });
        assert.equal(busy.status, "mission-coordinator-active");
        assert.equal(busy.task, undefined);
        assert.deepEqual(await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root"), beforeHold);
        assert.deepEqual(await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), beforeRun);
        assert.deepEqual((await tool("root", "operator_status", { view: "progress" })).budget, beforeBudget);
        await after(activeDispatch, "Interrupted before replacement", { sessionID: "author" });
        const unknown = await tool("root", "start_mission", { intent: "replace",
          requirements: ["Only change result.txt", ...requirements] });
        assert.equal(unknown.status, "mission-coordinator-active");
        assert.equal(unknown.reason, "native_terminal_unknown");
        assert.equal(unknown.task, undefined);
        agents.author!.outcome = "interrupted";
      }
      if (workspace.startsWith("git-replace-earlier-")) {
        await prompt("root", workspace === "git-replace-earlier-author-optional-declarative" ? "The same author is not required for this change."
          : workspace === "git-replace-earlier-author-optional-permission" || workspace === "git-replace-earlier-author-optional-alone-permission"
            ? "You may use the same author for this change, but it is not required."
          : workspace === "git-replace-earlier-reviewer-permission" ? "You may use the same reviewer for this change, but it is not required."
          : optionalAuthor ? "You don't have to use the same author for this change."
          : optionalReviewer ? "You do not need to use the same reviewer for this change."
          : authorReviewerConflict ? "Actually, select a different author for this work."
          : changedAuthor ? "Actually, select a different author for this work. You do not need to use the same reviewer."
          : "Actually, select a different reviewer for this work.");
        await tool("root", "start_mission", { requirements });
      }
      const previousBudget = (await tool("root", "operator_status", { view: "progress" })).budget;
      await prompt("root", workspace === "git-replace-change"
        ? "Actually, select a different author for this work. You do not need to use the same reviewer."
        : workspace === "git-replace-reviewer-change" ? "Actually, select a different reviewer for this work."
        : "Limit the implementation to result.txt; keep the other requirements unchanged.");
      const changedRequirements = ["Only change result.txt", ...(optionalAuthor ? [reviewerQuote
        ? "The same author is optional; retain the same reviewer" : "The same author is not required"]
        : optionalReviewer ? ["Use the same author; the same reviewer is not required"]
        : authorReviewerConflict ? ["Use a different author and retain the same reviewer"]
        : changedAuthor ? ["Use a different author"]
        : changedReviewer ? ["Use the same author and a different reviewer"] : requirements)];
      if (workspace === "git-replace") active = { author: { type: "running" } };
      let replaced = await tool("root", "start_mission", { intent: "replace", requirements: changedRequirements });
      assert.notEqual(replaced.mission_id, second.mission_id);
      if (workspace === "git-replace") {
        assert.equal(replaced.reason, "native_session_active");
        assert.equal(replaced.task, undefined, "replacement must re-prove the selected author's current native state");
        active = {};
        const recovered = await tool("root", "start_mission", { requirements: changedRequirements });
        assert.equal(recovered.mission_id, replaced.mission_id);
        replaced = recovered;
      }
      const replacement = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(replacement.runID, null);
      assert.equal(replacement.review, undefined);
      const replacementBudget = (await tool("root", "operator_status", { view: "progress" })).budget;
      assert.equal(replacementBudget.consumed_units,
        previousBudget.consumed_units + (workspace === "git-replace-running" ? 1 : 0),
        "a stopped admitted unit is settled, not refunded or reused");
      assert.equal(replacementBudget.max_units, previousBudget.max_units);
      if (authorReviewerConflict) {
        assert.equal(replaced.status, "mission-author-continuation-unavailable");
        assert.equal(replaced.reason, "requested_author_reviewer_lineage_conflict");
        assert.equal(replaced.task, undefined, "an excluded author and their required native Reviewer cannot be silently replaced");
        assert.equal(replacement.authorContinuation!.reviewer, "reviewer");
        assert.equal(replacement.coordinator, null);
        assert.equal(replacement.dispatchOpen, false);
        const held = await tool("root", "operator_status");
        assert.equal(held.task, undefined);
        assert.match(held.next_action, /do not reparent/u);
        await assert.rejects(before("root", "subagent", nativeTask(second.task)),
          /mission-author-continuation-not-authorized:requested_author_reviewer_lineage_conflict/u);
        await prompt("root", "Use the same author and the same reviewer after all.");
        replaced = await tool("root", "start_mission", { intent: "replace",
          requirements: ["Only change result.txt", "Use the same author and the same reviewer"] });
        const recovered = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        assert.equal(replaced.task.task_id, "author");
        assert.equal(recovered.authorContinuation!.reviewer, "reviewer");
        assert.equal(recovered.coordinator, null);
        assert.equal(recovered.runID, null);
        assert.equal(recovered.review, undefined);
      }
      if (changedAuthor) {
        assert.equal(replacement.authorContinuation, undefined);
        assert.equal(replaced.task.task_id, undefined);
        return;
      }
      assert.equal(replaced.task.task_id, "author", "narrowing the same work must retain the user's selected author");
      if (optionalAuthor && reviewerQuote) {
        assert.equal(replacement.authorContinuation!.reviewerQuote, reviewerQuote,
          "releasing only the author obligation cannot release the still-required same Reviewer");
        assert.equal(replacement.authorContinuation!.reviewer, "reviewer");
        assert.ok(replacement.requests.some(item => item.text === request));
      }
      assert.equal(replacement.authorContinuation!.reviewer, changedReviewer ? undefined : "reviewer");
      assert.equal(replacement.coordinator, null);
      assert.equal(replacement.dispatchOpen, false);
      second = replaced;
    }
    const interruptedDispatch = await before("root", "subagent", nativeTask(second.task));
    const terminal = (callID: string, input: Record<string, unknown>) => ({
      id: `msg_${++counter}`, type: "assistant", agent: "dog-operator", content: [{
        type: "tool", id: callID, name: "subagent", state: { status: "error", input,
          error: { type: "aborted", message: "Interrupted before claim; after-hook was lost" } },
      }],
    });
    assert.equal((await tool("root", "operator_status")).coordinator_dispatch, "active");
    history.root!.push(terminal("other-call", interruptedDispatch.input),
      terminal(interruptedDispatch.id, { ...interruptedDispatch.input, sessionID: "wrong" }),
      terminal(interruptedDispatch.id, { ...interruptedDispatch.input, prompt: "wrong reference" }));
    assert.equal((await tool("root", "operator_status")).coordinator_dispatch, "active",
      "unrelated terminals cannot release a newly authorized unclaimed Task");
    history.root!.push(terminal(interruptedDispatch.id, interruptedDispatch.input));
    const recovered = await tool("root", "operator_status");
    assert.equal(recovered.coordinator_dispatch, "resumable", "the exact native terminal recovers a lost after-hook before claim");
    assert.equal(recovered.task.task_id, "author");
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).coordinator, null);
    const bad = nativeTask(second.task);
    await assert.rejects(before("root", "subagent", { ...bad, sessionID: "wrong" }), /mission-author-continuation-not-authorized|mission-coordinator-location-mismatch/u);
    history.author!.push({ id: `msg_${++counter}`, type: "assistant", content: [{
      type: "tool", name: "shell", id: `call_${++counter}`, state: { status: "completed",
        input: { command: "node retained-writer.mjs", background: true }, metadata: { status: "running" } },
    }] });
    await assert.rejects(before("root", "subagent", nativeTask(second.task)),
      /mission-author-continuation-not-authorized:native_tools_active_or_unproven/u,
      "recheck tool ownership between preparation and actual admission");
    const held = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(held.dispatchOpen, false);
    assert.equal(held.coordinator, null, "a rejected dispatch cannot claim the old author");
    const pendingPart = (history.author!.at(-1)!.content as Record<string, unknown>[])[0]!;
    (pendingPart.state as Record<string, unknown>).metadata = { status: "completed", exit: 0 };
    active = { author: { type: "running" } };
    await assert.rejects(before("root", "subagent", nativeTask(second.task)), /mission-author-continuation-not-authorized:native_session_active/u);
    active = {};
    const dispatch = await before("root", "subagent", nativeTask(second.task));
    await assert.rejects(before("root", "subagent", nativeTask(second.task)), /mission-dispatch-not-authorized/u);
    delete agents.author!.outcome;
    await prompt("author", String(dispatch.input.prompt));
    const claimed = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(claimed.coordinator, "author");
    await assert.rejects(before("author", "subagent", { agent: "dog-worker-v010", description: "other writer", prompt: "Implement" }),
      /mission-author-continuation-author-required/u);
    await assert.rejects(tool("author", "plan_units", { executor: "worker", units: [unit("second")] }),
      /mission-author-continuation-author-required/u);
    if (workspace.startsWith("git-readonly-")) {
      // This directory is a different repository, not merely a subdirectory of
      // the selected work location. Its command still reads the selected result.
      await mkdir(otherCwd);
      await exec("git", ["init", "--quiet"], { cwd: otherCwd });
      await writeFile(join(otherCwd, "check.mjs"), 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; assert.equal(readFileSync("../result.txt","utf8").trim(),process.argv[2]);');
      const readOnly = { title: "Verify result", objective: "Verify the retained result without editing",
        read: workspace === "git-readonly-read" ? ["result.txt"] : [], write: [],
        validation: ["node check.mjs first", ...(workspace === "git-readonly-execution" ? ["node check.mjs first --secondary"] : [])],
        validation_cwd: { "node check.mjs first": otherCwd } };
      const priorMission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      const priorRun = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      const priorBudget = (await tool("root", "operator_status", { view: "progress" })).budget;
      const outside = { ...readOnly, read: [join(dirname(directory), "unrelated.txt")],
        validation_cwd: Object.fromEntries(readOnly.validation.map(command => [command, dirname(directory)])) };
      await assert.rejects(tool("author", "plan_units", { executor: "self", units: [outside] }),
        /mission-author-continuation-work-location-mismatch/u);
      const nested = { ...readOnly, read: [join(otherCwd, "check.mjs")],
        validation_cwd: Object.fromEntries(readOnly.validation.map(command => [command, otherCwd])) };
      await assert.rejects(tool("author", "plan_units", { executor: "self", units: [nested] }),
        /mission-author-continuation-work-location-mismatch/u);
      const missingCwd = { ...readOnly, read: [],
        validation_cwd: Object.fromEntries(readOnly.validation.map(command => [command, join(directory, "missing")])) };
      await assert.rejects(tool("author", "plan_units", { executor: "self", units: [missingCwd] }),
        /mission-author-continuation-work-location-mismatch/u);
      await assert.rejects(tool("author", "plan_units", { executor: "self", units: [{ ...readOnly,
        read: ["result.txt"], write: [join(otherCwd, "unrelated.txt")] }] }),
      /mission-author-continuation-work-location-mismatch/u,
      "a matching read or execution cwd must not relax the existing write destination check");
      assert.deepEqual(await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root"), priorMission);
      assert.deepEqual(await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), priorRun);
      assert.deepEqual((await tool("root", "operator_status", { view: "progress" })).budget, priorBudget);
      const direct = await tool("author", "plan_units", { executor: "self", units: [readOnly] });
      assert.equal(direct.status, "direct-unit-running");
      assert.notEqual(direct.run_id, oldRun.runID);
      if (workspace === "git-readonly-execution") {
        const running = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        const budget = (await tool("root", "operator_status", { view: "progress" })).budget;
        await assert.rejects(tool("author", "plan_units", { executor: "self", units: [{ ...readOnly,
          validation_cwd: Object.fromEntries(readOnly.validation.map(command => [command, otherCwd])) }],
          reason: "Propose a different validation directory" }), /mission-author-continuation-work-location-mismatch/u);
        assert.deepEqual(await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), running,
          "a correction uses its own effective cwd and cannot replace the admitted registration on rejection");
        assert.deepEqual((await tool("root", "operator_status", { view: "progress" })).budget, budget);
      }
      await validate("first", true);
      await tool("author", "finish_direct_unit");
      const newRun = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.deepEqual(newRun.units[0]!.unit.write, []);
      assert.equal(newRun.units[0]!.directExecution!.actor, "author");
      assert.deepEqual(newRun.units[0]!.directExecution!.checks.map(check => check.command), readOnly.validation.map(command => [command]));
      assert.ok(newRun.units[0]!.evidence.length > 0);
      const review = await tool("author", "review_mission", { risk_tags: ["public-logic"], traces: [] });
      assert.equal(review.task.task_id, "reviewer", "the retained independent reviewer reviews this new read-only unit");
      const reviewDispatch = await before("author", "subagent", nativeTask(review.task));
      delete agents.reviewer!.outcome;
      await prompt("reviewer", String(reviewDispatch.input.prompt));
      agents.reviewer!.outcome = "succeeded";
      const report = "PASS\nThe current read-only verification is correct.", end = Date.now();
      history.reviewer!.push({ id: `msg_${++counter}`, type: "assistant", agent: "dog-reviewer-v010", finish: "stop",
        time: { created: end, completed: end }, content: [{ type: "text", text: report }] });
      await after(reviewDispatch, report, { sessionID: "reviewer" });
      const current = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(current.review!.child, "reviewer");
      assert.equal(current.review!.result, report);
      assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "first\n");
      await tool("author", "submit_mission", { status: "ready", summary: "Read-only verification ready" });
      agents.author!.outcome = "succeeded";
      await after(dispatch, "Read-only verification ready", { sessionID: "author" });
      assert.equal((await tool("root", "complete_mission")).status, "succeeded");
      await prompt("root", "Use the same author and the same reviewer for another verification.");
      const thirdStart = () => tool("root", "start_mission", {
        requirements: ["Verify once more with the same author and reviewer"], author_continuation: selection });
      const archive = new OperatorRuntime(directory, V010_RUNTIME_PROFILE).replanArchivePath(oldRun);
      await rename(archive, `${archive}.held`);
      try {
        const missing = await thirdStart();
        assert.equal(missing.reason, "predecessor_work_location_unproven");
        assert.equal(missing.task, undefined, "the continuation link cannot replace the original run's provenance");
      } finally { await rename(`${archive}.held`, archive); }
      if (workspace === "git-readonly-read") {
        const sequence = oldRun.sequence + 1;
        const conflicting = new OperatorRuntime(directory, V010_RUNTIME_PROFILE).replanArchivePath({ ...oldRun, sequence });
        try {
          for (const invalid of [{ rootSessionID: "other-root" }, { runID: "other-run" },
            { operatorSessionID: "other-author" }, { phase: "running" }]) {
            await writeFile(conflicting, JSON.stringify({ ...oldRun, sequence, ...invalid }));
            const held = await thirdStart();
            assert.equal(held.reason, "predecessor_work_location_unproven");
            assert.equal(held.task, undefined, "a newer mismatched archive cannot grant recovery or fall back to old proof");
          }
        } finally { await rm(conflicting, { force: true }); }
      }
      const writeIndex = history.author!.findIndex(message => Array.isArray(message.content) &&
        message.content.some((part: { name?: string }) => part.name === "patch"));
      assert.notEqual(writeIndex, -1);
      const [nativeWrite] = history.author!.splice(writeIndex, 1);
      try {
        const missing = await thirdStart();
        assert.equal(missing.reason, "predecessor_native_write_unproven");
        assert.equal(missing.task, undefined, "read-only continuity still rechecks the actual writer's native history");
      } finally { history.author!.splice(writeIndex, 0, nativeWrite!); }
      active = { author: { type: "running" } };
      const busy = await thirdStart();
      assert.equal(busy.reason, "native_session_active");
      assert.equal(busy.task, undefined);
      active = {};
      const third = await thirdStart();
      assert.equal(third.task.task_id, "author", "a completed read-only continuation must not strand the proven actual author");
      assert.notEqual(third.mission_id, second.mission_id);
      const thirdMission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(thirdMission.authorContinuation!.predecessorRunID, newRun.runID);
      assert.equal(thirdMission.authorContinuation!.reviewer, "reviewer");
      assert.equal(thirdMission.coordinator, null);
      assert.equal(thirdMission.runID, null);
      assert.equal(thirdMission.review, undefined, "only authorship, not an old Review or checks, survives the read-only link");
      const thirdDispatch = await before("root", "subagent", nativeTask(third.task));
      delete agents.author!.outcome;
      await prompt("author", String(thirdDispatch.input.prompt));
      await tool("author", "plan_units", { executor: "self", units: [readOnly] });
      const thirdRun = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.notEqual(thirdRun.runID, newRun.runID);
      assert.notEqual(thirdRun.runID, oldRun.runID);
      assert.deepEqual(thirdRun.units[0]!.directExecution!.checks, []);
      assert.deepEqual(thirdRun.units[0]!.evidence, [], "the new admission must earn its own evidence");
      return;
    }
    const direct = await tool("author", "plan_units", { executor: "self", units: [unit("second")] });
    assert.notEqual(direct.run_id, oldRun.runID, "the new work has a new contract and accounting");
    assert.equal(direct.status, "direct-unit-running");
    const proposed = { ...unit("second"), objective: "Use the current result to produce second without repeating setup" };
    const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const missionsForProposal = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    const assertProposal = async (status: string) => {
      const priorRun = await operators.required("root"), priorMission = await missionsForProposal.required("root");
      const budget = (await tool("root", "operator_status", { view: "progress" })).budget;
      const proposal = await tool("root", "plan_units", { executor: "self", units: [proposed],
        reason: "Recover the retained same author's method", handoff_context: "Keep the existing check and cumulative budget." });
      assert.equal(proposal.status, status);
      assert.deepEqual(await operators.required("root"), priorRun, "root only forwards the proposal; it cannot admit a replacement contract");
      assert.deepEqual(await missionsForProposal.required("root"), priorMission);
      assert.deepEqual((await tool("root", "operator_status", { view: "progress" })).budget, budget);
      return proposal;
    };
    assert.equal((await assertProposal("mission-coordinator-active")).task, undefined);
    await after(dispatch, "Interrupted with the direct unit retained", { sessionID: "author" });
    assert.equal((await assertProposal("mission-coordinator-active")).task, undefined, "an unknown native outcome is not idle proof");
    agents.author!.outcome = "interrupted";
    history.author!.push({ id: "pending-shell", type: "assistant", content: [{
      type: "tool", id: "call_pending_shell", name: "shell", state: { status: "completed", metadata: { status: "running" } },
    }] });
    assert.equal((await assertProposal("mission-coordinator-active")).task, undefined, "a background tool still prevents duplicate continuation");
    history.author!.pop();
    active = { reviewer: { type: "running" } };
    assert.equal((await assertProposal("mission-coordinator-active")).task, undefined, "a historical Task's live child remains protected");
    active = {};
    delete agents.reviewer!.outcome;
    assert.equal((await assertProposal("mission-coordinator-active")).task, undefined, "an unproven Task terminal is not recovery proof");
    agents.reviewer!.outcome = "succeeded";
    const proposal = await assertProposal("mission-coordinator-required");
    assert.equal(proposal.task.task_id, "author");
    const methodDispatch = await before("root", "subagent", nativeTask(proposal.task));
    delete agents.author!.outcome;
    assert.match(await prompt("author", String(methodDispatch.input.prompt)), /Use the current result to produce second/u);
    await edit("first", "second");
    await validate("second");
    await tool("author", "finish_direct_unit");
    const newRun = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.deepEqual(newRun.units[0]!.directExecution!.checks.map(check => check.command), [["node check.mjs second"]]);
    assert.ok(newRun.units[0]!.evidence.length > 0, "the new check has its own current evidence");
    assert.notDeepEqual(newRun.units[0]!.evidence, oldRun.units[0]!.evidence);
    if (workspace === "git-replace-reviewer-change" || workspace === "git-replace-earlier-reviewer-change" ||
        workspace === "git-replace-earlier-reviewer-optional" || workspace === "git-replace-earlier-reviewer-permission" ||
        workspace === "git-permission-reviewer-no-replace" || workspace === "git-optional-author-selected") {
      agents.otherReviewer = { agent: "dog-reviewer-v010", parentID: "author", outcome: "succeeded" };
      const review = await tool("author", "review_mission", { risk_tags: ["public-logic"], traces: [], reviewer_session_id: "otherReviewer" });
      assert.equal(review.task.task_id, "otherReviewer", "a genuine reviewer change removes the old selection, not the author's");
      await before("author", "subagent", nativeTask(review.task));
      return;
    }
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.update("root", current => { current.sourceAuthors = [...(current.sourceAuthors ?? []), "reviewer"]; });
    await assert.rejects(tool("author", "review_mission", { risk_tags: ["public-logic"], traces: [] }),
      /mission-review-requested-reviewer-not-independent/u);
    await missions.update("root", current => { current.sourceAuthors = current.sourceAuthors!.filter(id => id !== "reviewer"); });
    active = { reviewer: { type: "running" } };
    await assert.rejects(tool("author", "review_mission", { risk_tags: ["public-logic"], traces: [] }),
      /mission-review-requested-reviewer-unavailable:native_session_active/u);
    active = {};
    const review = await tool("author", "review_mission", { risk_tags: ["public-logic"], traces: [] });
    assert.equal(review.status, "review-required");
    assert.equal(review.task.task_id, "reviewer");
    if (workspace === "git" && request === "Use the same author and the same reviewer for the new result.") {
      agents.otherReviewer = { agent: "dog-reviewer-v010", parentID: "author", outcome: "succeeded" };
      const beforeSubstitution = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      await assert.rejects(before("author", "subagent", { ...nativeTask(review.task), sessionID: "otherReviewer" }),
        /mission-review-requested-reviewer-unavailable/u, "a different owned independent Reviewer cannot replace the user's selection");
      assert.deepEqual(await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root"), beforeSubstitution);
    }
    const reviewDispatch = await before("author", "subagent", nativeTask(review.task));
    delete agents.reviewer!.outcome;
    assert.match(await prompt("reviewer", String(reviewDispatch.input.prompt)), /second/u,
      "the current candidate, not the prior verdict, is reviewed");
    agents.reviewer!.outcome = "succeeded";
    const report = "PASS\nThe second candidate and its current check are correct.", end = Date.now();
    history.reviewer!.push({ id: `msg_${++counter}`, type: "assistant", agent: "dog-reviewer-v010", finish: "stop",
      time: { created: end, completed: end }, content: [{ type: "text", text: report }] });
    await after(reviewDispatch, report, { sessionID: "reviewer" });
    const current = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(current.review!.child, "reviewer");
    assert.equal(current.review!.result, report);
    assert.notEqual(current.review!.runID, oldRun.runID);
    assert.equal(await readFile(join(directory, resultFile), "utf8"), "second\n");
    if (workspace === "git-glob-all" || workspace === "git-optional-author-required-reviewer" || workspace.startsWith("git-add-reviewer") ||
        workspace.startsWith("git-replace-earlier-author-optional") || workspace === "git-replace-earlier-author-conflict") {
      await tool("author", "submit_mission", { status: "ready", summary: "Current result reviewed and ready" });
      agents.author!.outcome = "succeeded";
      await after(methodDispatch, "Current result ready", { sessionID: "author" });
      assert.equal((await tool("root", "complete_mission")).status, "succeeded");
    }
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

for (const phase of ["cancelled", "completed"] as const) for (const reload of [false, true]) {
  test(`V2 ${phase} background Coordinator completion leaves Build usable${reload ? " after reload" : ""}`, async () => {
    await mkdir(resolve("_testenv"), { recursive: true });
    const directory = await mkdtemp(resolve("_testenv/mission-terminal-background-"));
    const fixture = contextFixture();
    const history: Record<string, Record<string, unknown>[]> = { root: [], coordinator: [] };
    let rootAgent = "dog-operator";
    const interrupted: string[] = [];
    const context: OpenCodeV2Context = { ...fixture.context, location: { directory },
      session: { ...fixture.context.session,
        get: async ({ sessionID }) => ({ id: sessionID, agent: sessionID === "root" ? rootAgent : "dogs-coordinator",
          ...(sessionID === "root" ? {} : { parentID: "root" }), model: { providerID: "openai", id: "gpt-6-sol" } }),
        context: async ({ sessionID }) => history[sessionID] ?? [],
        interrupt: async ({ sessionID }) => { interrupted.push(sessionID); return { interrupted: true }; },
      } };
    let cleanup = await V2Plugin.setup(context);
    try {
      const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
      await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_original",
        prompt: { text: "Complete the original request" } });
      const mission = await missions.start("root", ["Complete the original request"]);
      const task = missions.task(mission);
      const dispatch = { sessionID: "root", agent: "dog-operator", tool: "subagent", id: "call_background",
        input: { agent: task.subagent_type, description: task.description, prompt: task.prompt, background: true } };
      await fixture.toolHooks.get("execute.before")!(dispatch);
      await fixture.sessionHooks.get("prompt")!({ sessionID: "coordinator", messageID: "msg_child",
        prompt: { text: task.prompt } });
      history.coordinator!.push({ id: "msg_child", type: "user" });
      await fixture.toolHooks.get("execute.after")!({ ...dispatch, status: "completed",
        result: { content: "Job running", metadata: { sessionID: "coordinator", status: "running" } } });
      if (phase === "completed") await missions.update("root", state => { state.phase = "completed"; state.dispatchOpen = false; });
      rootAgent = "build";
      await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_build",
        prompt: { text: "Continue independently in Build" } });
      const terminal = await missions.required("root");
      assert.equal(terminal.phase, phase);
      if (phase === "cancelled") assert.ok(interrupted.includes("coordinator"));
      history.coordinator!.push({ id: "msg_terminal", type: "assistant", error: { message: "Interrupted" } });
      if (reload) { cleanup?.(); cleanup = await V2Plugin.setup(context); }
      for (let attempt = 0; attempt < 2; attempt++) {
        await fixture.sessionHooks.get("context")!({ sessionID: "root", agent: "build", system: [], tools: {} });
        await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: `msg_followup_${attempt}`,
          prompt: { text: "Recovery check only" } });
      }
      const saved = await context.storage!.get("v2-background-dispatches:root") as { settled?: boolean; terminal?: string }[];
      assert.equal(saved[0]!.settled, true, "the historical native completion must not retry at every prompt");
      assert.equal(saved[0]!.terminal, "failed", "settlement must not turn interruption into success");
      assert.deepEqual(await missions.required("root"), terminal, "late completion cannot revive or rewrite a terminal Mission");
    } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
  });
}

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

test("V2 direct recovery reads its native admission window beyond a 100-page controller history", async () => {
  const fixture = contextFixture(), pages: Record<string, unknown>[] = [];
  const history = Array.from({ length: 10_050 }, (_, index) => ({ id: `message-${index}`, type: "assistant", agent: "dog-operator",
    time: { created: index, completed: index + 1 }, content: [] }));
  const context: OpenCodeV2Context = { ...fixture.context,
    session: { ...fixture.context.session, get: async () => ({ id: "root", agent: "dog-operator" }), context: async () => history.slice(-1) },
    message: { list: async request => {
      pages.push(request);
      if (request.cursor) assert.equal(request.order, undefined);
      else assert.equal(request.order, "desc", "start at the current unit, not the first controller turn");
      const offset = Number(request.cursor ?? 0), newest = [...history].reverse();
      return { data: newest.slice(offset, offset + 100), cursor: { next: offset + 100 < newest.length ? String(offset + 100) : null } };
    } },
  };
  const cleanup = await createSortieDogsV2Plugin(async input => {
    const session = input.client!.session! as typeof input.client.session & { reviewMessages: typeof input.client.session.messages };
    const request = { path: { id: "root" }, query: { notBefore: new Date(10_025).toISOString() } };
    const retained = (await session.reviewMessages!(request) as { data: { info: { id: string } }[] }).data;
    assert.equal(retained.length, 100, "keep the boundary message/page for tools that ran after its creation");
    assert.equal(retained[0]!.info.id, "message-9950");
    assert.equal(retained.at(-1)!.info.id, "message-10049", "return chronological native history");
    assert.equal(pages.length, 1, "do not traverse the unrelated 10,000-message prefix or trip its page cap");
    return {};
  }).setup(context);
  cleanup?.();
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

test("native fast-lane Worker Task carries whole-request progress without a new observer or model/status request", async () => {
  const directory = await mkdtemp(resolve("_testenv/v2-worker-progress-")), fixture = contextFixture();
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "user", text: "Implement result" });
  const mission = await missions.start("root", ["Implement result"]);
  rememberWorkMission(directory, mission);
  const updates: Record<string, unknown>[] = [];
  const native = { execute: async () => {
    await publishMissionProgress("root", { description: "全体作業量 20/100（概算）", sortie_progress: { work_quantity: { n: 20, denominator: 100 } } });
    return { content: "Native output", output: { answer: "unchanged" }, metadata: { sessionID: "worker", status: "completed" } };
  } };
  const context: OpenCodeV2Context = { ...fixture.context, location: { directory }, tool: { ...fixture.context.tool,
    transform: async callback => { callback({ add() {}, update: (id, update) => { if (id === "subagent") update(native); } }); return { dispose() {} }; },
  } };
  const cleanup = await createSortieDogsV2Plugin(async () => ({})).setup(context);
  try {
    const result = await native.execute({ agent: "dog-worker-v010" }, { sessionID: "root", id: "worker-call",
      progress: async (value: Record<string, unknown>) => { updates.push(value); } });
    assert.ok(updates.some(update => /20\/100/.test(String(update.description))));
    assert.equal(result.content, "Native output");
    assert.deepEqual(result.output, { answer: "unchanged" });
    assert.equal(fixture.synthetic.length, 0);
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
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
    ["dog-worker-v010", undefined], ["dog-luna-worker-v010", undefined], ["dog-reviewer-v010", undefined], ["dog-advisor-v010", undefined],
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
    assert.deepEqual(models.get("dogs-coordinator"), { providerID: "openai", id: "gpt-6.1-terra", variant: "xhigh" });
    assert.deepEqual(models.get("dog-worker-v010"), { providerID: "openai", id: "gpt-6.1-terra", variant: "max" });
    assert.deepEqual(models.get("dog-luna-worker-v010"), { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" });
    assert.deepEqual(models.get("dog-reviewer-v010"), { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dog-advisor-v010"), { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" });
    assert.deepEqual(models.get("dog-scout-v010"), { providerID: "anthropic", id: "custom", variant: "high" });
  } finally { if (typeof dispose === "function") dispose(); }
});

test("V2 Coordinator explicit models survive registry initialization", async () => {
  for (const selected of [
    { providerID: "openai", id: "gpt-6.1-terra", variant: "xhigh" },
    { providerID: "anthropic", id: "custom", variant: "high" },
  ]) {
    const fixture = contextFixture();
    const models = new Map<string, typeof selected>([["dogs-coordinator", structuredClone(selected)]]);
    const context: OpenCodeV2Context = { ...fixture.context, agent: { transform: async callback => {
      callback({ update: (id, update) => {
        if (!models.has(id)) return;
        const agent = { model: models.get(id) };
        update(agent);
        models.set(id, agent.model!);
      } });
      return { dispose() {} };
    } } };
    const dispose = await createSortieDogsV2Plugin(async () => ({})).setup(context);
    try { assert.deepEqual(models.get("dogs-coordinator"), selected); }
    finally { if (typeof dispose === "function") dispose(); }
  }
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

test("V2 native image results survive after hooks and reach model context without replacing pixels with success text", async () => {
  const image = { type: "file", mime: "image/png", uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/wAAAABJRU5ErkJggg==", name: "screenshot.png" };
  const pdf = { type: "file", mime: "application/pdf", uri: "data:application/pdf;base64,JVBERg==", name: "reference.pdf" };
  for (const rewrite of [false, true]) {
    const fixture = contextFixture();
    const cleanup = await createSortieDogsV2Plugin(async () => ({
      "tool.execute.after": async (_input, output) => { if (rewrite) output.output = "Updated report"; },
      "experimental.chat.system.transform": async () => {},
    })).setup(fixture.context);
    try {
      for (const tool of ["read", "execute"]) {
        const content = [{ type: "text", text: "Image read successfully" }, image, pdf, { type: "text", text: "native detail" }];
        const metadata = { truncated: false, native: "preserve" };
        const original = structuredClone(content);
        const result = { content, metadata };
        const event = { tool, sessionID: "root", id: `image-${tool}`, status: "completed", input: {}, result };
        await fixture.toolHooks.get("execute.after")!(event);
        assert.deepEqual(content, original, "do not mutate the native result while adapting the textual report");
        assert.equal(event.result.metadata, metadata);
        assert.deepEqual(event.result.content.filter(part => part.type === "file"), [image, pdf]);
        for (const file of [image, pdf]) assert(event.result.content.includes(file), "preserve original file blocks, metadata and order");
        if (!rewrite) assert.equal(event.result, result, "unchanged text must leave the whole multimodal result untouched");
        else assert.deepEqual(event.result.content, [{ type: "text", text: "Updated report" }, image, pdf]);
        const messages = [{ role: "tool", content: [{ type: "tool-result", id: event.id, name: tool,
          result: { type: "content", value: event.result.content } }] }];
        const request = { sessionID: "root", agent: "dog-operator", system: [], messages, tools: {} };
        await fixture.sessionHooks.get("context")!(request);
        assert.deepEqual(request.messages[0], messages[0], "the outgoing context retains the image-bearing native result");
      }
      const filesOnly = { tool: "read", sessionID: "root", id: "files-only", status: "completed", input: {}, result: { content: [image] } };
      await fixture.toolHooks.get("execute.after")!(filesOnly);
      assert.deepEqual(filesOnly.result.content, rewrite ? [image, { type: "text", text: "Updated report" }] : [image]);
      const textOnly = { tool: "read", sessionID: "root", id: "text-only", status: "completed", input: {}, result: { content: "plain text" } };
      await fixture.toolHooks.get("execute.after")!(textOnly);
      assert.equal(textOnly.result.content, rewrite ? "Updated report" : "plain text");
    } finally { cleanup?.(); }
  }
});

test("V2 original files reach Mission handoff and acceptance with bytes/order, not prose-only visual claims", async () => {
  const fixture = contextFixture();
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-original-files-"));
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/wAAAABJRU5ErkJggg==", "base64");
  const data = image.toString("base64");
  const original = "Compare the attached reference with the actual desktop/mobile screens.";
  const files = [{ data, mime: "image/png", source: { type: "inline" }, name: "reference.png" },
    { data: Buffer.from("original text").toString("base64"), mime: "text/plain", source: { type: "uri", uri: "file:///expired-note.txt" }, name: "note.txt" }];
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator" });
  const messages = [{ id: "original", type: "user", text: original, files },
    { id: "image-only", type: "user", files: [files[0]] },
    { id: "worker-result", type: "assistant", content: [{ type: "text", text: "Functional checks PASS; original visual comparison unverified." }] }];
  fixture.context.message = { list: async () => ({ data: messages, cursor: {} }) };
  let client: any, admitted: any;
  const cleanup = await createSortieDogsV2Plugin(async input => {
    client = input.client;
    return { "chat.message": async (_chat, output) => { admitted = output; } };
  }).setup(fixture.context);
  try {
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "original", prompt: { text: original, files } });
    assert.equal(admitted.parts[1].url, `data:image/png;base64,${data}`);
    const history = (await client.session.messages({ path: { id: "root" } })).data;
    assert.equal(history[0].parts[2].filename, "note.txt");
    const runtime = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await runtime.capture("root", { id: "original", text: original });
    await runtime.start("root", [original], false);
    const state = await runtime.retainContext("root", "root", history);
    const handoff = await runtime.handoffContext(state) as any;
    const refs = handoff.continuity.sources[0].attachments;
    assert.deepEqual(refs.map((ref: any) => [ref.message_id, ref.index]), [["original", 0], ["original", 1], ["image-only", 0]]);
    assert.deepEqual(await readFile(refs[0].path), image);
    assert.equal(await readFile(refs[1].path, "utf8"), "original text", "use resolved bytes, not the expired source URI");
    assert.match(runtime.brief(state), new RegExp(refs[0].sha256), "Coordinator's initial brief includes the original read reference");
    const summary = await missionAcceptanceSummary(state, undefined, new OperatorRuntime(directory, V010_RUNTIME_PROFILE)) as any;
    assert.deepEqual(summary.original_requests, [{ id: "original", text: original }]);
    assert.deepEqual(summary.original_attachments, refs.map((ref: any) => ({ session_id: "root", ...ref })));
    assert.match(JSON.stringify(handoff), /visual comparison unverified/);
    assert.match(summary.interpretation, /does not establish a required visual comparison/);
    assert.match(summary.interpretation, /continue authorized retrieval, inspection or correction without waiting for the user/);
    assert.match(summary.interpretation, /valid alternative checks and reusable evidence need not block acceptance/);
    assert.equal(summary.independent_review, null, "attachment transport does not add a Reviewer or fabricate verification");
    assert.equal(state.phase, "open", "neither retained attachments nor an honest caveat establish completion");
    assert.deepEqual(messages[0].files, files, "the native message is unchanged");
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
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

test("V2 reconciles the explicitly selected predecessor shell after a corrected operation declaration", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-predecessor-operation-"));
  const fixture = contextFixture();
  const identities: Record<string, { agent: string; parentID?: string; outcome?: string; time?: { created: number } }> = {
    root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    worker: { agent: "dog-worker-v010", parentID: "coordinator", time: { created: Date.now() - 10_000 } },
  };
  const history: Record<string, Record<string, unknown>[]> = {};
  let hooks!: Awaited<ReturnType<typeof SortieDogsV010Plugin>>;
  const cleanup = await createSortieDogsV2Plugin(async input => { hooks = await SortieDogsV010Plugin(input); return {}; }).setup({
    ...fixture.context, location: { directory }, session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID, ...identities[sessionID] }),
      list: async ({ parentID }) => ({ data: Object.entries(identities).filter(([, info]) => info.parentID === parentID)
        .map(([id, info]) => ({ id, ...info })), cursor: {} }),
      context: async ({ sessionID }) => history[sessionID] ?? [] },
    message: { list: async ({ sessionID, order }) => ({ data: order === "desc" ? [...(history[sessionID] ?? [])].reverse()
      : history[sessionID] ?? [], cursor: {} }) },
  });
  let turn = 0;
  const chat = async (sessionID: string, text: string) => hooks["chat.message"]!(
    { sessionID, messageID: `${sessionID}-${++turn}`, agent: identities[sessionID]!.agent },
    { message: { id: `${sessionID}-${turn}`, agent: identities[sessionID]!.agent,
      model: { providerID: "openai", modelID: "fixture" } }, parts: [{ type: "text", text }] });
  const tool = async (name: string, sessionID: string, input: object = {}) =>
    JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(input, { sessionID }));
  try {
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: directory });
    await mkdir(join(directory, "build"));
    await writeFile(join(directory, "check.mjs"), 'console.log("auxiliary");\n');
    const build = "TMPDIR=/fixture/tmp XDG_CACHE_HOME=/fixture/cache /usr/bin/cmake --build build --target vdm_linux_readonly --parallel 4";
    const initialBuild = build.replace("vdm_linux_readonly --parallel", "vdm_linux_readonly linux_readonly_test --parallel");
    const launch = "node launch.mjs";
    const unit = { title: "Build and launch", objective: "Build the requested target and launch once",
      read: ["check.mjs"], write: ["build/**"], validation: ["node check.mjs"] };
    await chat("root", "Build and launch once; retain the real result without replay.");
    const started = await tool("start_mission", "root", { requirements: ["Build and launch once"], kind: "operation" });
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const planned = await tool("plan_units", "coordinator", { units: [unit], execution: { commands: [initialBuild, launch], directory } });
    const workerTask = { args: structuredClone(planned.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, workerTask);
    await chat("worker", workerTask.args.prompt);
    const original = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), worker = original.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: worker.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { output: "inspected" });
    await tool("bind_write_gate", "worker", { project_root: directory, manifest_path: worker.manifestPath });
    const ran = Date.now();
    history.worker = [{ id: "msg_original", type: "assistant", agent: "dog-worker-v010", time: { created: ran, completed: ran },
      content: [{ type: "tool", id: "call_original_build", name: "shell", time: { created: ran, ran, completed: ran },
        state: { status: "completed", input: { command: build, workdir: directory, timeout: 240_000 },
          metadata: { status: "completed", exit: 0 }, content: [{ type: "text", text: "[100%] Built target vdm_linux_readonly" }] } }] }];
    // Only synthetic host events represent the build/launch; no CMake or GUI process is started.
    await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "launch" }, { args: { command: launch, workdir: directory } });
    await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "launch" }, { output: "launched", metadata: { status: "completed", exit: 0 } });
    await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "check" }, { args: { command: "node check.mjs", workdir: directory } });
    const checked = await promisify(execFile)(process.execPath, ["check.mjs"], { cwd: directory });
    await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "check" }, { output: checked.stdout, metadata: { status: "completed", exit: 0 } });
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, { output: "done", metadata: { sessionId: "worker" } });
    assert.equal((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!.status, "succeeded");
    assert.equal((await tool("operator_status", "root")).acceptance_summary.operation.status, "not-started");
    const corrected = await tool("plan_units", "coordinator", { executor: "self", reason: "Correct the target without replay",
      units: [{ ...unit, title: "Retain native result", objective: "Reconcile the existing call" }],
      execution: { commands: [build, launch], directory } });
    const recovery = await tool("plan_units", "root", { execution: { commands: [build, launch], directory,
      recover_call: { run_id: original.runID, unit_id: "unit-1", session_id: "worker", call_id: "call_original_build" } } });
    assert.equal(recovery.status, "operation-reconciled");
    assert.equal(recovery.run_id, corrected.run_id);
    const recovered = (await tool("operator_status", "root")).acceptance_summary.operation;
    assert.equal(recovered.status, "executed");
    const observation = recovered.observations.find((item: { callID: string }) => item.callID === "call_original_build");
    assert.equal(observation.sourceRunID, original.runID);
    assert.equal(observation.sessionID, "worker");
    assert.equal(observation.nativeTimeoutMs, 240_000);
    assert.equal(observation.nativeStartedAt, new Date(ran).toISOString());
    assert.equal(observation.exit, 0);
    assert.equal((await tool("operator_status", "root")).acceptance_summary.operation.observations.length, 2);
    assert.notEqual((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).phase, "completed");
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

for (const variant of ["verified", "legacy-receipt", "omitted-cwd", "omitted-cwd-changed-timeout",
  "direct-replan", "direct-replan-omitted-cwd", "direct-replan-changed-timeout", "direct-replan-process", "direct-replan-running",
  "multiple-first", "multiple-last", "multiple-omitted-cwd", "multiple-missing-history", "multiple-missing-receipt", "multiple-changed-timeout",
  "multiple-process", "multiple-running", "multiple-completed-metadata", "multiple-duplicate-mismatch", "multiple-other-executed",
  "changed-input", "changed-timeout", "process-evidence", "active-owner", "unknown-owner",
  "failed-terminal", "task-failed-child-completed", "failed-terminal-active", "failed-terminal-active-descendant",
  "failed-terminal-unknown", "failed-terminal-changed-input", "failed-terminal-process", "failed-terminal-missing-receipt",
  "failed-terminal-conflicting-outcome", "failed-terminal-invalid-terminal", "failed-terminal-missing-terminal"] as const)
test(`V2 recovers a failed predecessor's exact prelaunch rejection without replay: ${variant}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-failed-prelaunch-"));
  const fixture = contextFixture();
  const identities: Record<string, { agent: string; parentID?: string; outcome?: string; time?: { created: number } }> = {
    root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    worker: { agent: "dog-worker-v010", parentID: "coordinator", time: { created: Date.now() - 10_000 } },
  };
  const history: Record<string, Record<string, unknown>[]> = {};
  let active: Record<string, unknown> = {};
  const failedTerminal = variant.startsWith("failed-terminal");
  if (variant === "failed-terminal-active-descendant") identities.descendant = {
    agent: "dog-worker-v010", parentID: "worker", outcome: "failed", time: { created: Date.now() - 5_000 },
  };
  let hooks!: Awaited<ReturnType<typeof SortieDogsV010Plugin>>;
  const cleanup = await createSortieDogsV2Plugin(async input => { hooks = await SortieDogsV010Plugin(input); return {}; }).setup({
    ...fixture.context, location: { directory }, session: { ...fixture.context.session,
      get: async ({ sessionID }) => ({ id: sessionID, ...identities[sessionID] }),
      active: async () => active,
      list: async ({ parentID }) => ({ data: Object.entries(identities).filter(([, info]) => info.parentID === parentID)
        .map(([id, info]) => ({ id, ...info })), cursor: {} }),
      context: async ({ sessionID }) => history[sessionID] ?? [] },
    message: { list: async ({ sessionID, order }) => ({ data: order === "desc" ? [...(history[sessionID] ?? [])].reverse()
      : history[sessionID] ?? [], cursor: {} }) },
  });
  let turn = 0;
  const chat = async (sessionID: string, text: string) => hooks["chat.message"]!(
    { sessionID, messageID: `${sessionID}-${++turn}`, agent: identities[sessionID]!.agent },
    { message: { id: `${sessionID}-${turn}`, agent: identities[sessionID]!.agent,
      model: { providerID: "openai", modelID: "fixture" } }, parts: [{ type: "text", text }] });
  const tool = async (name: string, sessionID: string, input: object = {}) =>
    JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(input, { sessionID }));
  try {
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: directory });
    await mkdir(join(directory, "output"));
    await writeFile(join(directory, "launch.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync("output/runs.txt", "started\\n");\n');
    const command = "node launch.mjs", args = { command,
      ...(variant.startsWith("omitted-cwd") || variant === "multiple-omitted-cwd" || variant === "direct-replan-omitted-cwd" ? {} : { workdir: directory }), timeout: 120_000 };
    const unit = { title: "Start once", objective: "Retain the prior result and start once after the host refusal",
      read: ["launch.mjs"], write: ["output/**"], validation: [command] };
    await chat("root", "Start the requested operation once; keep all prior work and accounting.");
    const started = await tool("start_mission", "root", { requirements: ["Start the requested operation once"], kind: "operation" });
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const planned = await tool("plan_units", "coordinator", { units: [unit], execution: { commands: [command], directory } });
    const workerTask = { args: structuredClone(planned.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, workerTask);
    await chat("worker", workerTask.args.prompt);
    const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const original = await operators.required("root"), worker = original.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: worker.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { output: "inspected" });
    await tool("bind_write_gate", "worker", { project_root: directory, manifest_path: worker.manifestPath });
    // As in the real receipt, the host admits the shell but its registered snapshot
    // fails before the process starts. This fixture never starts the rejected call.
    const broken = join(directory, "output", "broken");
    await symlink(join(directory, "missing"), broken);
    const ran = Date.now();
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "rejected-call" }, { args: { ...args } }),
      /mission-validation-snapshot-unavailable/u);
    const multiple = variant.startsWith("multiple-");
    const peerRan = Date.now();
    if (multiple) await assert.rejects(hooks["tool.execute.before"]!(
      { tool: "shell", sessionID: "worker", callID: "other-refusal" }, { args: { ...args } }),
    /mission-validation-snapshot-unavailable|repeated-command/u);
    await assert.rejects(readFile(join(directory, "output", "runs.txt")), { code: "ENOENT" });
    const nativeInput = { ...args };
    const nativeState: any = { status: "error", input: nativeInput,
      error: { type: "unknown", message: "mission-validation-snapshot-unavailable" } };
    const peerInput = { ...args };
    const peerState: any = { status: "error", input: peerInput,
      error: { type: "unknown", message: "mission-validation-snapshot-unavailable" } };
    const nativeParts = [{ type: "tool", id: "rejected-call", name: "shell", time: { created: ran, ran, completed: Date.now() }, state: nativeState },
      ...(multiple ? [{ type: "tool", id: "other-refusal", name: "shell", time: { created: peerRan, ran: peerRan, completed: Date.now() }, state: peerState }] : [])];
    history.worker = [{ id: "msg_refusal", type: "assistant", agent: "dog-worker-v010", time: { created: ran, completed: Date.now() },
      content: nativeParts }];
    identities.worker!.outcome = failedTerminal ? "failed" : "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" },
      { ...(variant === "task-failed-child-completed" ? { status: "error" } : {}),
        output: "PROCESS_DEFECT: local: registered snapshot unavailable before launch", metadata: { sessionId: "worker" } });
    const failed = await operators.required("root");
    assert.equal(failed.units[0]!.status, "failed");
    assert.equal(failed.units[0]!.resultClass, "process-defect");
    const missionRuntime = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    const before = await missionRuntime.required("root");
    assert.equal(before.execution!.observations[0]!.prelaunchRejection!.runID, original.runID);
    assert.equal(before.execution!.observations[0]!.exit, undefined);
    const originalAttempt = before.attempts!.find(item => item.runID === original.runID)!;
    assert.equal(originalAttempt.nativeOutcome, failedTerminal ? "failed" : "completed");
    assert.equal(originalAttempt.terminal!.outcome, failedTerminal || variant === "task-failed-child-completed" ? "failed" : "completed");
    if (variant === "failed-terminal-active-descendant") assert.deepEqual(originalAttempt.terminal!.descendants, ["descendant"]);
    if (multiple) {
      assert.equal(before.execution!.observations.length, 2);
      assert.ok(before.execution!.observations.every(item => item.prelaunchRejection?.runID === original.runID && item.outcome === "not-started"));
    }
    if (variant === "legacy-receipt") await missionRuntime.update("root", current => {
      // The released host's receipt predates the optional full-input hash.
      delete current.execution!.observations[0]!.nativeExecutionHash;
      delete current.execution!.observations[0]!.nativeCallHash;
    });
    await rm(broken);
    const corrected = await tool("plan_units", "coordinator", { executor: "self", reason: "Correct the unavailable snapshot scope",
      units: [{ ...unit, title: "Continue retained operation" }], execution: { commands: [command], directory } });
    const directReplan = variant.startsWith("direct-replan");
    let directRunID: string | undefined, directState: any;
    if (directReplan) {
      directRunID = corrected.run_id;
      const directRan = Date.now();
      await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "coordinator", callID: "direct-refusal" }, { args }),
        /mission-operation-already-admitted/u);
      directState = { status: "error", input: { ...args }, error: { type: "unknown", message: "mission-operation-already-admitted" } };
      history.coordinator = [{ id: "msg_direct_refusal", type: "assistant", agent: "dogs-coordinator", time: { created: directRan, completed: Date.now() },
        content: [{ type: "tool", id: "direct-refusal", name: "shell", time: { created: directRan, ran: directRan, completed: Date.now() }, state: directState }] }];
      const continued = await tool("plan_units", "coordinator", { executor: "self", reason: "Continue after the direct prelaunch refusal",
        units: [{ ...unit, title: "Continue after direct refusal" }], execution: { commands: [command], directory } });
      corrected.run_id = continued.run_id;
      assert.notEqual(corrected.run_id, directRunID);
      // The same Coordinator is executing its next admission, not a terminal session.
      active = { coordinator: { type: "busy" } };
    }
    const budget = (await tool("operator_status", "root")).budget;
    if (variant === "failed-terminal-missing-receipt") await missionRuntime.update("root", current => {
      delete current.execution!.observations[0]!.prelaunchRejection;
    });
    if (variant === "failed-terminal-invalid-terminal") await missionRuntime.update("root", current => {
      // A failed child cannot have produced a successful aggregate Task terminal.
      current.attempts!.find(item => item.runID === original.runID)!.terminal = { ...originalAttempt.terminal!, outcome: "completed" };
    });
    if (variant === "failed-terminal-missing-terminal") await missionRuntime.update("root", current => {
      delete current.attempts!.find(item => item.runID === original.runID)!.terminal;
    });
    const originalAttempts = (await missionRuntime.required("root")).attempts!.filter(item => item.runID === original.runID);
    if (variant === "changed-input" || variant === "failed-terminal-changed-input") nativeInput.command += " --different";
    if (variant === "changed-timeout" || variant === "omitted-cwd-changed-timeout") nativeInput.timeout = 60_000;
    if (variant === "process-evidence" || variant === "failed-terminal-process") nativeState.metadata = { exit: 1 };
    if (variant === "active-owner" || variant === "failed-terminal-active") active = { worker: { type: "busy" } };
    if (variant === "failed-terminal-active-descendant") active = { descendant: { type: "busy" } };
    if (variant === "unknown-owner" || variant === "failed-terminal-unknown") delete identities.worker!.outcome;
    if (variant === "failed-terminal-conflicting-outcome") identities.worker!.outcome = "succeeded";
    if (variant === "multiple-missing-history") nativeParts.pop();
    if (variant === "multiple-missing-receipt") await missionRuntime.update("root", current => {
      delete current.execution!.observations.find(item => item.callID === "other-refusal")!.prelaunchRejection;
    });
    if (variant === "multiple-changed-timeout") peerInput.timeout = 60_000;
    if (variant === "multiple-process") peerState.metadata = { exit: 0 };
    if (variant === "multiple-running") peerState.status = "running";
    if (variant === "multiple-completed-metadata") peerState.metadata = { status: "completed" };
    if (variant === "multiple-duplicate-mismatch") nativeParts.push({ ...nativeParts[1]!,
      state: { ...peerState, input: { command: `${command} --different`, timeout: args.timeout } } });
    if (variant === "multiple-other-executed") nativeParts.push({ ...nativeParts[1]!, id: "other-executed",
      state: { status: "completed", input: { ...args }, metadata: { exit: 0 },
        content: [{ type: "text", text: "A different native call already ran." }] } });
    const selectedCall = variant === "multiple-last" ? "other-refusal" : "rejected-call";
    let recovered = await tool("plan_units", "root", { execution: { commands: [command], directory,
      recover_call: { run_id: original.runID, unit_id: "unit-1", session_id: "worker", call_id: selectedCall } } });
    if (directReplan) {
      if (variant === "direct-replan-changed-timeout") directState.input.timeout = 60_000;
      if (variant === "direct-replan-process") directState.metadata = { exit: 0 };
      if (variant === "direct-replan-running") directState.status = "running";
      const attempts = (await missionRuntime.required("root")).attempts;
      recovered = await tool("plan_units", "root", { execution: { commands: [command], directory,
        recover_call: { run_id: directRunID, unit_id: "unit-1", session_id: "coordinator", call_id: "direct-refusal" } } });
      assert.deepEqual((await missionRuntime.required("root")).attempts, attempts, "recovery never re-settles a direct admission or changes its accounting");
      assert.deepEqual(recovered.budget, budget);
    }
    assert.equal(recovered.status, "operation-reconciled");
    assert.equal(recovered.run_id, corrected.run_id);
    assert.deepEqual(recovered.budget, budget);
    const after = await missionRuntime.required("root");
    assert.equal(after.id, before.id);
    assert.deepEqual(after.requests, before.requests);
    assert.deepEqual(after.requirements, before.requirements);
    assert.deepEqual(after.attempts!.filter(item => item.runID === original.runID), originalAttempts);
    const observation = after.execution!.observations.find(item => item.callID === "rejected-call")!;
    if (variant !== "failed-terminal-missing-receipt")
      assert.equal(observation.prelaunchRejection!.runID, original.runID, "the receipt is never reassigned to the current run");
    assert.equal(observation.exit, undefined);
    const verified = ["verified", "legacy-receipt", "omitted-cwd", "multiple-first", "multiple-last", "multiple-omitted-cwd",
      "direct-replan", "direct-replan-omitted-cwd", "failed-terminal", "task-failed-child-completed"].includes(variant);
    if (!verified) {
      assert.ok(["recovery-unavailable", "recovery-blocked"].includes(recovered.operation.status), JSON.stringify(recovered.operation));
      await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "coordinator", callID: "unsafe-retry" }, { args }),
        /mission-operation-(?:recovery-unavailable|already-admitted)/u);
      await assert.rejects(readFile(join(directory, "output", "runs.txt")), { code: "ENOENT" });
      if (variant === "multiple-running") {
        peerState.status = "error";
        const restored = (await tool("operator_status", "root")).acceptance_summary.operation;
        assert.equal(restored.status, "not-started", "a later proven native refusal resolves an unknown envelope");
        assert.deepEqual((await tool("operator_status", "root")).budget, budget);
      }
      return;
    }
    assert.equal(recovered.operation.status, "not-started", JSON.stringify(recovered.operation));
    assert.equal(observation.sourceRunID, original.runID);
    assert.equal(observation.sourceUnitID, "unit-1");
    assert.equal(observation.nativeTimeoutMs, 120_000);
    assert.ok(observation.nativeExecutionHash);
    assert.ok(observation.nativeCallHash);
    const observations = (await tool("operator_status", "root")).acceptance_summary.operation.observations;
    assert.equal(observations.length, multiple || directReplan ? 2 : 1);
    if (directReplan) {
      const direct = observations.find((item: { callID: string }) => item.callID === "direct-refusal");
      assert.equal(direct.sourceRunID, directRunID);
      assert.equal(direct.sourceUnitID, "unit-1");
      assert.equal(direct.prelaunchRejection.runID, directRunID);
      assert.equal(direct.outcome, "not-started");
      assert.ok(direct.nativeInputHash && direct.nativeCallHash && direct.nativeExecutionHash);
    }
    if (multiple) for (const item of observations) {
      assert.equal(item.sourceRunID, original.runID);
      assert.equal(item.sourceUnitID, "unit-1");
      assert.equal(item.prelaunchRejection.runID, original.runID);
      assert.equal(item.outcome, "not-started");
      assert.ok(item.nativeInputHash && item.nativeCallHash && item.nativeExecutionHash);
    }
    await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "coordinator", callID: "real-once" }, { args });
    await promisify(execFile)(process.execPath, ["launch.mjs"], { cwd: directory });
    await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "coordinator", callID: "real-once" },
      { output: "", metadata: { status: "completed", exit: 0 } });
    assert.equal(await readFile(join(directory, "output", "runs.txt"), "utf8"), "started\n");
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "coordinator", callID: "duplicate" }, { args }),
      /mission-operation-already-admitted/u);
    assert.equal(await readFile(join(directory, "output", "runs.txt"), "utf8"), "started\n");
    assert.notEqual((await missionRuntime.required("root")).phase, "completed");
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

for (const mode of ["success", "failure", "no-start", "structured-failure", "command-mismatch", "cwd-mismatch", "foreign-owner", "before-admission",
  "redeclared-run", "redeclared-failure", "redeclared-mismatch", "redeclared-cwd", "redeclared-ambiguous", "redeclared-node-pin", "unobserved-redeclared-run"] as const) {
  test(`V2 timed native operation recovery through Mission APIs: ${mode}`, async () => {
    await mkdir(resolve("_testenv"), { recursive: true });
    const directory = await mkdtemp(resolve("_testenv/v2-timed-operation-"));
    const fixture = contextFixture();
    const identities: Record<string, { agent: string; parentID?: string; time?: { created: number } }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: "coordinator", time: { created: Date.now() - 10_000 } },
      former: { agent: "dog-worker-v010", parentID: "coordinator", time: { created: Date.now() - 20_000 } },
    };
    const history: Record<string, Record<string, unknown>[]> = {};
    const requested: string[] = [];
    let hooks!: Awaited<ReturnType<typeof SortieDogsV010Plugin>>;
    let client: any;
    const cleanup = await createSortieDogsV2Plugin(async input => {
      client = input.client;
      hooks = await SortieDogsV010Plugin(input);
      return {};
    }).setup({ ...fixture.context, location: { directory },
      session: { ...fixture.context.session, get: async ({ sessionID }) => ({ id: sessionID, ...identities[sessionID] }),
        list: async ({ parentID }) => ({ data: Object.entries(identities).filter(([, info]) => info.parentID === parentID)
          .map(([id, info]) => ({ id, ...info })), cursor: {} }),
        context: async ({ sessionID }) => history[sessionID] ?? [] },
      message: { list: async ({ sessionID, order }) => {
        requested.push(sessionID);
        const messages = history[sessionID] ?? [];
        return { data: order === "desc" ? [...messages].reverse() : messages, cursor: {} };
      } },
    });
    const chat = async (sessionID: string, text: string) => hooks["chat.message"]!(
      { sessionID, messageID: `${sessionID}-prompt`, agent: identities[sessionID]!.agent },
      { message: { id: `${sessionID}-prompt`, agent: identities[sessionID]!.agent,
        model: { providerID: "openai", modelID: "fixture" } }, parts: [{ type: "text", text }] });
    const tool = async (name: string, sessionID: string, input: object = {}) =>
      JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(input, { sessionID }));
    try {
      await promisify(execFile)("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(join(directory, "check.mjs"), 'console.log("PASS");\n');
      const command = mode === "redeclared-node-pin" ? "node check.mjs" : "/usr/bin/python3 -B tools/start.py --background > /tmp/result.json";
      const timed = `TIMEFORMAT='ELAPSED=%R'; time ${command}`;
      const failed = mode === "failure" || mode === "redeclared-failure";
      const expected = mode === "no-start" ? "not-started" : mode === "structured-failure" || failed ? "execution-failed" : "executed";
      const output = (mode === "no-start" ? "NO_START\n" : mode === "structured-failure"
        ? JSON.stringify({ status: "setup-failed", attempts: 1 }, null, 2) + "\n" : "") + "ELAPSED=0.284\n";
      await chat("root", "Collect the already executed operation result without replay.");
      const mission = await tool("start_mission", "root", { requirements: ["Collect the operation result"], kind: "operation",
        execution: { commands: [mode === "foreign-owner" ? timed : command], directory } });
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(mission.task) });
      await chat("coordinator", mission.task.prompt);
      const plan = await tool("plan_units", "coordinator", { units: [{ title: "Collect result", objective: "Collect native result",
        read: ["check.mjs"], write: ["result.json"], validation: ["node check.mjs"] }] });
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, { args: structuredClone(plan.task) });
      await chat("worker", plan.task.prompt);
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" },
        { output: "completed", metadata: { sessionId: "worker" } });
      const run = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      const started = mode === "before-admission" ? Date.parse(run.createdAt) - 1_000 : Date.now() + 10;
      const native = { id: "msg_native", type: "assistant", agent: "dog-worker-v010", time: { created: started - 100, completed: started + 350 },
        content: [{ type: "tool", id: "call_native", name: "shell", time: { created: started - 265, ran: started, completed: started + 350 },
          state: { status: "completed", input: { command: mode === "redeclared-node-pin" ? "/actual/node check.mjs"
            : mode === "command-mismatch" ? timed.replace("start.py", "other.py") : timed,
            workdir: mode === "cwd-mismatch" ? join(directory, "other") : directory },
          metadata: { exit: failed ? 1 : 0 }, content: [{ type: "text", text: output }] } }] };
      if (mode !== "unobserved-redeclared-run") history[mode === "foreign-owner" ? "former" : "worker"] = [native, structuredClone(native)];
      if (mode === "success") {
        const projected = (await client.session.reviewMessages({ path: { id: "worker" }, query: { notBefore: run.createdAt } })).data[0].parts[0];
        assert.equal(projected.tool, "bash");
        assert.equal(projected.callID, "call_native");
        assert.equal(projected.state.input.command, timed);
        assert.equal(projected.state.time.start, started);
        assert.equal(projected.state.time.end, started + 350);
        assert.equal(projected.state.output, "ELAPSED=0.284\n");
        assert.equal(projected.state.metadata.exit, 0);
      }
      const operation = (await tool("operator_status", "root")).acceptance_summary.operation;
      if (mode === "success" || mode === "failure" || mode === "no-start" || mode === "structured-failure" || mode.startsWith("redeclared-")) {
        assert.equal(operation.status, expected);
        assert.equal(operation.process_succeeded, expected === "not-started" ? null : expected === "executed");
        assert.equal(operation.observations.length, 1, "duplicate native records do not duplicate observations");
        assert.equal(operation.observations[0].callID, "call_native");
        assert.equal(operation.observations[0].exit, failed ? 1 : 0);
        if (mode === "structured-failure") assert.deepEqual(operation.observations[0].result, { status: "setup-failed", attempts: 1 });
        const submitted = await tool("submit_mission", "coordinator", { status: "blocked", summary: "The native result was collected; acceptance remains separate." });
        assert.equal(submitted.acceptance_summary.operation.status, operation.status);
        assert.equal((await tool("operator_status", "root")).acceptance_summary.operation.observations.length, 1);
      } else {
        assert.equal(operation.status, "not-started");
        assert.equal(operation.process_succeeded, null);
        assert.deepEqual(operation.observations, []);
        if (mode === "foreign-owner") assert.equal(requested.includes("former"), false, "a new owner cannot search the prior author's session");
      }
      if (mode.startsWith("redeclared-") || mode === "unobserved-redeclared-run") {
        const replanned = await tool("plan_units", "coordinator", { executor: "self", reason: "Collect the existing native result with its literal timing spelling, without replay.",
          execution: { commands: mode === "redeclared-node-pin" ? ["/other/node check.mjs"]
            : mode === "redeclared-ambiguous" ? [timed, timed.replace("ELAPSED", "OTHER")]
            : [mode === "redeclared-mismatch" ? timed.replace("result.json", "other.json") : timed],
            directory: mode === "redeclared-cwd" ? join(directory, "other") : directory }, units: [{ title: "Retain result", objective: "Read-only result collection",
            read: ["check.mjs"], write: [], validation: ["node check.mjs"] }] });
        assert.notEqual(replanned.run_id, run.runID, "the collector has a different run and author");
        // The known predecessor may still be read for native terminal/accounting
        // reconciliation. Those reads must not import an unobserved operation.
        if (mode === "unobserved-redeclared-run") history.worker = [native];
        const retained = (await tool("operator_status", "root")).acceptance_summary.operation;
        const equivalent = mode === "redeclared-run" || mode === "redeclared-failure";
        assert.equal(retained.status, equivalent ? failed ? "execution-failed" : "executed" : "not-started",
          "only a unique equivalent declaration retains the already admitted native result");
        assert.equal(retained.process_succeeded, equivalent ? !failed : null);
        assert.equal(retained.observations.length, mode === "unobserved-redeclared-run" ? 0 : 1);
        if (retained.observations.length) {
          assert.equal(retained.observations[0].callID, "call_native");
          assert.equal(retained.observations[0].sessionID, "worker", "the original author is not reassigned to the collector");
          assert.equal(retained.observations[0].command, equivalent ? timed : command);
          assert.equal(retained.observations[0].exit, failed ? 1 : 0);
        }
      }
      assert.notEqual((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).phase, "completed");
    } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
  });
}

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
    if (url.pathname === "/api/session/active") { response.end(JSON.stringify({ data: { ses_live: { type: "running" } } })); return; }
    if (url.pathname === "/api/session/ses_previous/inbox") { response.end(JSON.stringify({ data: [] })); return; }
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
    const proof = (reviewerCorrection = false) => terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "ses_root",
      { operatorSessionID: "ses_coordinator", units: [{ childSessionID: "ses_worker" },
        ...(reviewerCorrection ? [{ childSessionID: "ses_reviewer", reviewerCorrection: {
          author: "ses_reviewer", reviewIdentity: "prior-review", writeUnion: ["src/**"],
        } }] : [])] } as never,
      { reserved_units: 0 }, { get: async id => (await client.session.get({ path: { id } })).data,
        children: async id => (await client.session.children({ path: { id } })).data });
    assert.deepEqual(await proof(), ["ses_worker"]);
    const pages = host.requests.filter(url => url.pathname === "/api/session" && url.searchParams.get("parentID") === "ses_coordinator");
    assert.deepEqual(pages.map(url => url.searchParams.get("cursor")), [null, "page-2", "end"]);
    assert.equal(pages[0]!.searchParams.get("order"), "asc");
    assert.equal(pages[1]!.searchParams.get("order"), null);
    assert.deepEqual(await proof(true), ["ses_worker", "ses_reviewer"], "a recorded correction retains its native Reviewer identity");
    sessions.ses_reviewer.outcome = "running";
    await assert.rejects(proof(true), /mission-superseded-worker-not-terminal/);
    host.repeated = true;
    await assert.rejects(proof(), /v2-history-cursor-repeated/);
    host.repeated = false; host.malformed = true;
    await assert.rejects(proof());
    host.malformed = false; host.fail = true;
    await assert.rejects(proof());
  } finally { cleanup?.(); }
}));

test("V2 activity fallback reads only the exact registered owning service", async () => registeredHost(async host => {
  const fixture = contextFixture();
  let client: any;
  const cleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    assert.deepEqual(await client.session.active(), { data: { ses_live: { type: "running" } } });
    assert.ok(host.requests.some(url => url.pathname === "/api/session/active"));
    assert.deepEqual(await client.session.inbox({ path: { id: "ses_previous" } }), { data: [] });
    assert.ok(host.requests.some(url => url.pathname === "/api/session/ses_previous/inbox"));
  } finally { cleanup?.(); }
  host.pid = process.pid + 1;
  await host.register(host.pid);
  const foreignCleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    const before = host.requests.length;
    await assert.rejects(client.session.active(), /v2-history-owning-service-unavailable/);
    await assert.rejects(client.session.inbox({ path: { id: "ses_previous" } }), /v2-history-owning-service-unavailable/);
    assert.ok(!host.requests.slice(before).some(url => url.pathname === "/api/session/active"));
    assert.ok(!host.requests.slice(before).some(url => url.pathname === "/api/session/ses_previous/inbox"));
  } finally { foreignCleanup?.(); }
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

test("V2 exposes the fixed Docker task tool only to its schema-authorized Worker role", async () => {
  const fixture = contextFixture();
  const cleanup = await V2Plugin.setup(fixture.context);
  try {
    const exposed = Object.fromEntries(fixture.tools.map(tool => [tool.name, tool]));
    const visibleTools = async (sessionID: string, agent: string) => {
      const event = { sessionID, agent, system: [], tools: { ...exposed, read: {}, fh_docker_exec: { name: "fh_docker_exec" }, fh_docker_read: { name: "fh_docker_read" } } };
      await fixture.sessionHooks.get("context")!(event);
      return event.tools;
    };
    const workerTools = await visibleTools("worker", "dog-worker-v010");
    assert.ok(Object.hasOwn(workerTools, "fh_docker_exec"));
    assert.ok(Object.hasOwn(await visibleTools("reviewer", "dog-reviewer-v010"), "fh_docker_read"));
    for (const [session, agent] of [["root", "dog-operator"], ["coordinator", "dogs-coordinator"], ["reviewer", "dog-reviewer-v010"]]) {
      assert.equal(Object.hasOwn(await visibleTools(session, agent), "fh_docker_exec"), false,
        `${agent} must not inherit the Worker-only Docker task tool`);
    }
  } finally { cleanup?.(); }
});

test("V2 exposes the approved cumulative Mission budget extension to root Operator, not its delegated Coordinator", async () => {
  const fixture = contextFixture();
  const cleanup = await V2Plugin.setup(fixture.context);
  try {
    const exposed = Object.fromEntries(fixture.tools.map(tool => [tool.name, tool]));
    const visibleTools = async (sessionID: string, agent: string) => {
      const event = { sessionID, agent, system: [], tools: { ...exposed, read: {} } };
      await fixture.sessionHooks.get("context")!(event);
      return event.tools;
    };
    const name = "sortie_v010_extend_mission_budget";
    const rootTools = await visibleTools("root", "dog-operator");
    assert.equal(rootTools[name], exposed[name], "the actual registered native tool is available in the root Operator's request");
    assert.equal(typeof (rootTools[name] as { execute?: unknown }).execute, "function");
    assert.deepEqual((rootTools[name] as { options?: unknown }).options, { codemode: true },
      "execute/search can discover the registered increase, not just the direct model-tool fixture");
    for (const [other, tool] of Object.entries(exposed)) if (other !== name) {
      assert.deepEqual((tool as { options?: unknown }).options, { codemode: false },
        `${other} retains its existing direct entrypoint`);
    }

    const coordinatorTools = await visibleTools("coordinator", "dogs-coordinator");
    assert.equal(Object.hasOwn(coordinatorTools, name), false, "the root-only tool is not exposed to the delegated Coordinator");
  } finally { cleanup?.(); }
});

for (const mode of ["native", "legacy-history", "synthetic-only", "switched-build"] as const) test(`V2 cold resume ignores completion authors when resolving session identity: ${mode}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-resume-identity-"));
  const fixture = contextFixture();
  const nativeAgent = mode === "switched-build" ? "build" : mode === "legacy-history" ? undefined : "dog-operator";
  fixture.history.splice(0, fixture.history.length,
    ...(mode === "synthetic-only" ? [] : [{ id: "original-user", type: "user", text: "Keep the original request",
      metadata: { agent: "dog-operator" }, time: { created: 1 } }]),
    { id: "restart-notice", type: "synthetic", text: "The server restarted", metadata: { notice: "restart" }, time: { created: 2 } },
    { id: "review-completed", type: "synthetic", text: "Original Review finding remains unresolved",
      metadata: { source: "subagent", childID: "reviewer", agent: "dog-reviewer-v010", state: "completed" }, time: { created: 3 } },
  );
  fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: nativeAgent,
    model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } });
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  if (mode !== "switched-build") await missions.capture("root", { id: "diagnostic-request", text: "Keep the same diagnostic Mission" });
  const mission = mode === "switched-build" ? undefined : await missions.start("root", ["Keep the same diagnostic Mission"]);
  let historyReads = 0;
  let hooks: OpenCodeHooks;
  const cleanup = await createSortieDogsV2Plugin(async (input, options) => {
    hooks = await SortieDogsV010Plugin(input, options); return hooks;
  }).setup({ ...fixture.context, location: { directory }, message: { list: async input => {
    historyReads += 1;
    return input.cursor ? { data: fixture.history.slice(1), cursor: {} }
      : { data: fixture.history.slice(0, 1), cursor: { next: "completion-page" } };
  } } });
  try {
    await hooks!.reviewerCorrectionScope!("root");
    if (mode !== "legacy-history") assert.equal(historyReads, 0, "identity resolution needs no full transcript reread");
    // A host inbox completion resumes without a new real prompt; process-local selection is empty.
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "review-completed",
      prompt: fixture.history.at(-1), metadata: fixture.history.at(-1)!.metadata });
    const before = fixture.toolHooks.get("execute.before")!;
    for (const [tool, input] of [["read", { path: "result.txt" }], ["shell", { command: "node --version" }],
      ["execute", { code: 'return search({query:"sortie",limit:10});' }]] as const) {
      await before({ sessionID: "root", agent: nativeAgent, tool, id: `call-${tool}`, input });
    }
    const status = fixture.tools.find(tool => tool.name === "sortie_v010_operator_status") as {
      execute(input: unknown, context: unknown): Promise<{ content: string }>;
    };
    if (mode === "switched-build") {
      await assert.rejects(status.execute({}, { sessionID: "root" }), /runtime-profile-session-inactive/u);
    } else if (mode !== "legacy-history") {
      assert.equal(JSON.parse((await status.execute({}, { sessionID: "root" })).content).mission_id, mission!.id);
      assert.equal((await missions.required("root")).id, mission!.id);
    }
    assert.equal(fixture.history.at(-1)!.metadata && (fixture.history.at(-1)!.metadata as any).agent, "dog-reviewer-v010");
    assert.deepEqual(fixture.agentSwitches, []);
    assert.deepEqual(fixture.modelSwitches, []);
    assert.equal(fixture.synthetic.length, 0);
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

test("V2 logical Reviewer identity retains the native correction alias and model", async () => {
  const fixture = contextFixture();
  const native = { id: "reviewer", parentID: "root", agent: "dog-reviewer-correction-v010-0123456789abcdef",
    model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } };
  fixture.context.session.get = async () => native;
  let client: Parameters<OpenCodePlugin>[0]["client"];
  const cleanup = await createSortieDogsV2Plugin(async input => { client = input.client; return {}; }).setup(fixture.context);
  try {
    const projected = await client!.session!.get!({ path: { id: "reviewer" } }) as { data: typeof native };
    assert.deepEqual(projected.data, { ...native, agent: "dog-reviewer-v010" });
    assert.equal((await fixture.context.session.get({ sessionID: "reviewer" })).agent, native.agent);
    assert.deepEqual(fixture.agentSwitches, []);
    assert.deepEqual(fixture.modelSwitches, []);
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
      model: { providerID: "openai", id: "gpt-6.1-terra", variant: "max" } }]);
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
    const configured = role === "dogs-coordinator"
      ? { providerID: "openai", id: "gpt-6.1-terra", variant: "xhigh" }
      : { providerID: "openai", id: `${role}-configured`, variant: "high" };
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

test("V2 status decoration keeps actionable lines before full proof and reports the loaded adapter snapshot", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const area = await mkdtemp(resolve("_testenv/v2-loaded-identity-"));
  try {
    await cp(resolve("dist"), join(area, "dist"), { recursive: true });
    const path = join(area, "dist/plugin/v2.js"), bytes = await readFile(path);
    const implementationPath = join(area, "dist/plugin/index.js"), implementationBytes = await readFile(implementationPath);
    const { createSortieDogsV2Plugin: create } = await import(pathToFileURL(path).href);
    const fixture = contextFixture();
    const original = { units: [{ evidence: "protected-source".repeat(20000) }], status: "idle", budget: { consumed_units: 25,
      settled_cost_usd: 0.04769424, cost_scope: "worker-only", cost_status: "settled" }, attempts: [{
      selectedModel: "openai/gpt-6-luna-fast#max", observedModel: "openai/gpt-6-luna-fast", observedVariant: "max" }],
      next_action: "Compare original requirements before acceptance.",
      completion: { ready: false, blockers: [{ source_paths: Array.from({ length: 5000 }, (_, index) => `src/proof-${index}.ts`) }] } };
    const dispose = await create(async () => ({ tool: { sortie_v010_operator_status: {
      description: "status", args: {}, execute: async () => JSON.stringify(original),
    } } })).setup(fixture.context);
    try {
      await writeFile(path, Buffer.concat([bytes, Buffer.from("\n// replaced after module evaluation\n")]));
      await writeFile(implementationPath, Buffer.concat([implementationBytes, Buffer.from("\n// implementation replacement\n")]));
      const tool = fixture.tools.find(tool => tool.name === "sortie_v010_operator_status") as {
        execute(input: unknown, execution: unknown): Promise<{ content: string }>; };
      const output = (await tool.execute({}, { sessionID: "root" })).content;
      assert.ok(output.includes("\n"), "V2 decoration must not collapse the status back into one giant line");
      const visible: string[] = [];
      let visibleBytes = 0;
      for (const line of output.split("\n").slice(0, 2000)) {
        const bytes = Buffer.byteLength(line) + (visible.length ? 1 : 0);
        if (visibleBytes + bytes > 51200) break;
        visible.push(line); visibleBytes += bytes;
      }
      const prefix = visible.join("\n");
      assert.ok(Buffer.byteLength(prefix) < 51200);
      for (const fact of ["openai/gpt-6-luna-fast#max", '"observedVariant":"max"', '"settled_cost_usd":0.04769424',
        '"cost_scope":"worker-only"', original.next_action]) assert.ok(prefix.includes(fact), fact);
      const packet = JSON.parse(output);
      const { runtime: _runtime, model_observations: models, ...withoutRuntime } = packet;
      assert.deepEqual(models, { recent_attempts: original.attempts, omitted_attempts: 0 });
      assert.deepEqual(withoutRuntime, original, "explicit full records survive decoration without loss");
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
    const plan = tools.find(tool => tool.name === "sortie_v010_plan_units")!;
    const validate = new Ajv({ strict: false }).compile(plan.input);
    const capturedHandoff = { units: "", work_quantities: "", parallel: "", execution: "", handoff_context: "Continue the already-edited result", reason: "", executor: "worker", purpose_decision: "", vision: "" };
    assert.equal(validate(capturedHandoff), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...capturedHandoff, parallel: true }), true);
    assert.equal(validate({ ...capturedHandoff, parallel: false }), true);
    assert.equal(validate({ ...capturedHandoff, parallel: "true" }), false);
    assert.equal(validate({ ...capturedHandoff, units: "invented-plan" }), false);
    assert.equal(validate({ ...capturedHandoff, units: [] }), false, "empty units cannot masquerade as a new plan");
    const execution = { commands: ["cmake --build build --target gui"], directory: "/fixture" };
    assert.equal(validate({ ...capturedHandoff, execution }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...capturedHandoff, execution: { ...execution, recover_call: {
      run_id: "previous-run", unit_id: "unit-1", session_id: "worker", call_id: "call-build" } } }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...capturedHandoff, execution: { ...execution, recover_call: {
      run_id: "previous-run", unit_id: "unit-1", session_id: "worker" } } }), false, "a partial native call reference is not a recovery proof");
    const review = tools.find(tool => tool.name === "sortie_v010_review_mission")!;
    const validateReview = new Ajv({ strict: false }).compile(review.input);
    const capturedReview = { risk_tags: [], mode: "", reviewer_session_id: "", evidence: "", traces: "", purpose_decision: "" };
    assert.equal(validateReview(capturedReview), true, "optional purpose note uses the existing V2 omission sentinel");
    const purpose = { decision: "REUSE", requirement_ids: ["R1"], observed_outcome: "Current checks passed",
      unmet_work: ["Review"], reason: "Reuse existing evidence", evidence_refs: [], next_action: "Review the candidate" };
    assert.equal(validateReview({ ...capturedReview, purpose_decision: purpose }), true, JSON.stringify(validateReview.errors));
    assert.equal(validateReview({ ...capturedReview, purpose_decision: { decision: "REUSE" } }), false,
      "provider schema still rejects incomplete decision records");
    const start = tools.find(tool => tool.name === "sortie_v010_start_mission")!;
    assert.equal(new Ajv({ strict: false }).compile(start.input.properties.preferred_executor)(""), true);
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

test("V2 omission sentinel reaches the legacy handoff executor without a replacement plan", async () => {
  const fixture = contextFixture();
  const received: unknown[] = [];
  const args = { units: { type: "array", minItems: 1, items: { type: "object" }, "x-sortie-optional": true },
    executor: { type: "string", enum: ["self", "worker"], "x-sortie-optional": true } };
  const cleanup = await createSortieDogsV2Plugin(async () => ({ tool: {
    sortie_v010_plan_units: { description: "handoff", args, execute: async input => { received.push(input); return "continued"; } },
  } }) as never).setup(fixture.context);
  try {
    const tool = fixture.tools.find(value => value.name === "sortie_v010_plan_units") as {
      execute(input: unknown, context: { sessionID: string }): Promise<unknown>;
    };
    await tool.execute({ units: "", executor: "worker" }, { sessionID: "root" });
    assert.deepEqual(received, [{ executor: "worker" }]);
    assert.deepEqual(legacyToolArgs({ units: [{ title: "new" }], executor: "" }, args), { units: [{ title: "new" }] });
  } finally { cleanup?.(); }
});

test("documented V2 worker handoff passes the actual schema and transfers the real direct admission", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v2-direct-handoff-")), fixture = contextFixture();
  let cleanup: (() => void) | void;
  try {
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: directory });
    await mkdir(join(directory, "test"));
    const testText = 'import assert from "node:assert/strict";\nassert.equal(1, 1);\nassert.equal(1, 1);\n';
    await writeFile(join(directory, "seed.mjs"), testText);
    fixture.history.length = 0;
    fixture.context.location.directory = directory;
    fixture.context.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "dog-operator",
      model: { providerID: "openai", id: "gpt-6.1-sol" } });
    cleanup = await createSortieDogsV2Plugin(SortieDogsV010Plugin).setup({ ...fixture.context,
      message: { list: async () => ({ data: fixture.history, cursor: { next: null } }) } });
    await fixture.sessionHooks.get("prompt")!({ sessionID: "root", messageID: "msg_request", prompt: { text: "Create result.txt and validate it." } });
    const call = async (name: string, input: Record<string, unknown>) => {
      const tool = fixture.tools.find(tool => tool.name === `sortie_v010_${name}`) as any;
      const args = { ...Object.fromEntries(Object.keys(tool.input.properties).map(key => [key, ""])), ...input };
      const validate = new Ajv({ strict: false }).compile(tool.input);
      assert.equal(validate(args), true, JSON.stringify(validate.errors));
      return JSON.parse((await tool.execute(args, { sessionID: "root", callID: `call_${name}` })).content);
    };
    await call("start_mission", { requirements: ["Validated result.txt"] });
    const direct = await call("plan_units", { executor: "self", units: [{ title: "Result", objective: "Create and validate result.txt",
      read: ["seed.mjs"], write: ["result.txt", "test/**"], validation: ["node check.mjs"] }] });
    assert.equal(direct.status, "direct-unit-running");
    const shell = { tool: "shell", sessionID: "root", id: "audit-error-shell",
      input: { command: "cp seed.mjs test/native.test.mjs && false", workdir: directory } };
    await fixture.toolHooks.get("execute.before")!(shell);
    await assert.rejects(promisify(execFile)("sh", ["-c", shell.input.command], { cwd: directory }));
    const nativeError = { ...shell, status: "error", error: { exit: 1, status: "completed" } };
    await fixture.toolHooks.get("execute.after")!(nativeError);
    assert.deepEqual(nativeError.error, { exit: 1, status: "completed" }, "the V2 error stays an error");
    assert.equal("result" in nativeError, false, "no successful native result is manufactured");
    assert.equal(await readFile(join(directory, "test/native.test.mjs"), "utf8"), testText);
    assert.ok((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).testDebtSignals
      ?.some(signal => signal.path === "test/native.test.mjs"));
    const runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE), before = await runtime.required("root");
    const plan = fixture.tools.find(tool => tool.name === "sortie_v010_plan_units") as any;
    assert.match(plan.input.properties.executor.description, /units=\"\" in V2/);
    const handed = await call("plan_units", { executor: "worker", units: "", handoff_context: "Continue the same unit." });
    const after = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.ok(handed.task);
    assert.equal(after.runID, before.runID);
    assert.equal(after.units[0]!.status, "pending", JSON.stringify(handed));
    assert.equal(after.units[0]!.callID, before.units[0]!.callID, "reservation anchor is retained");
    assert.equal(after.units[0]!.directHandoffs!.length, 1);
    assert.equal(after.dispatched, 0, "handoff returns a Task; it does not fabricate its admission");
    const continuation = JSON.parse(/^direct_handoff: (.+)$/mu.exec(after.units[0]!.task.prompt)![1]!);
    assert.ok(continuation.test_debt_audit.signals.some((signal: { path: string }) => signal.path === "test/native.test.mjs"));
  } finally { cleanup?.(); await rm(directory, { recursive: true, force: true }); }
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
