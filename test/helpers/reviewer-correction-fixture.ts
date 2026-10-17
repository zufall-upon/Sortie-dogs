import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after } from "node:test";
import { createSortieDogsV2Plugin, type OpenCodeV2Context } from "../../dist/plugin/v2.js";
import { Agent } from "@opencode/schema/agent";
import { convertedAssetPermissions, evaluate, type Rule } from "../fixtures/native-v2-2018-contract.ts";
import { SortieDogsV010Plugin } from "../../dist/plugin/profiled.js";
import { OperatorMissionRuntime } from "../../dist/core/operator-mission.js";
import { OperatorRuntime } from "../../dist/core/operator-runtime.js";
import { RunFlightLedger } from "../../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../../dist/core/runtime-profile.js";
import { runtimeAssets } from "../../dist/runtime-assets-v010.js";
import type { OpenCodeHooks } from "../../dist/plugin/index.js";

export const exec = promisify(execFile);

export type ObjectValue = Record<string, any>;

// Only the plain committed repository is reused, never a Mission, native history,
// plugin instance or ledger. Every fixture gets its own checkout, index and objects.
let repositorySeed: Promise<string> | undefined;
async function createRepositorySeed(): Promise<string> {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/reviewer-correction-base-"));
  try {
    for (const args of [["init", "--quiet", "--initial-branch=base"], ["config", "user.name", "test"], ["config", "user.email", "test@example.invalid"]]) {
      await exec("git", args, { cwd: directory });
    }
    await writeFile(join(directory, ".gitignore"), ".sortie-dogs-v010/\n.cache/\n");
    await writeFile(join(directory, "result.txt"), "old\n");
    await writeFile(join(directory, "check.mjs"), 'import { readFileSync } from "node:fs"; if (!readFileSync("result.txt", "utf8").trim()) process.exit(1);\n');
    await writeFile(join(directory, "required-test.mjs"), 'import { readFileSync } from "node:fs"; if (readFileSync("result.txt", "utf8").trim() === "bad-required") process.exit(1);\n');
    await writeFile(join(directory, "generate.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("result.txt", "ready generated\\n");\n');
    await writeFile(join(directory, "format.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("result.txt", "ready formatted\\n");\n');
    await writeFile(join(directory, "operation.mjs"), 'console.log(JSON.stringify({ status: "executed", attempts: 1 }));\n');
    await exec("git", ["add", "--all"], { cwd: directory });
    await exec("git", ["commit", "--quiet", "-m", "base"], { cwd: directory });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
after(async () => {
  const directory = await repositorySeed?.catch(() => undefined);
  if (directory) await rm(directory, { recursive: true, force: true });
});

export async function fixture(options: { permissionsUnavailable?: boolean; contextWindow?: number; compactedHistory?: boolean } = {}) {
  const seed = await (repositorySeed ??= createRepositorySeed());
  const directory = await mkdtemp(resolve("_testenv/reviewer-correction-"));
  try {
    // cp creates independent files without clone's new origin/upstream config.
    await cp(seed, directory, { recursive: true });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const agents: Record<string, ObjectValue> = { root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
    author: { agent: "dog-reviewer-v010", parentID: "root" }, final: { agent: "dog-reviewer-v010", parentID: "root" } };
  const history: Record<string, ObjectValue[]> = {}, storage = new Map<string, unknown>(), rules: ObjectValue[] = [], switches: ObjectValue[] = [];
  const globalRules: Rule[] = [];
  const agentRules: Record<string, Rule[]> = {};
  let registry: Record<string, ObjectValue>;
  let tools: ObjectValue[], toolHooks: Map<string, Function>, sessionHooks: Map<string, Function>, permissionHook: Function, hooks: OpenCodeHooks;
  let cleanup: (() => void) | void, counter = 0;
  const nativeLaunches: ObjectValue[] = [];
  const compaction = { start: null as number | null };
  const projection = { failGrant: false, failRestore: false, failRestorationLookup: false };
  const start = async () => {
    cleanup?.(); tools = [{ name: "subagent", execute: async (input: ObjectValue) => {
      nativeLaunches.push(input); return { content: "Native launch", metadata: {} };
    } }]; toolHooks = new Map(); sessionHooks = new Map();
    const transforms: Function[] = [];
    const rebuild = () => {
      const next: Record<string, ObjectValue> = Object.fromEntries(runtimeAssets.filter(asset => asset.installPath.startsWith("agent/")).map(asset =>
        [asset.name, { ...Agent.Info.default(asset.name as never), system: asset.content.split("---").slice(2).join("---"),
          permissions: [...Agent.Info.default(asset.name as never).permissions, ...globalRules, ...convertedAssetPermissions(asset.content), ...(agentRules[asset.name] ?? [])] }]));
      const editor = { get: (id: string) => next[id], update: (id: string, update: Function) => {
        if (id.startsWith("dog-reviewer-correction-") && projection.failGrant) { projection.failGrant = false; throw new Error("native-permission-storage-failed"); }
        update(next[id] ??= { ...Agent.Info.default(id as never) });
      } };
      for (const transform of transforms) transform(editor);
      registry = next;
      for (const [id, info] of Object.entries(registry)) if (id.startsWith("dog-reviewer-correction-")) rules.push({ agent: id, permissions: structuredClone(info.permissions) });
    };
    rebuild();
    const context: OpenCodeV2Context = {
      location: { directory }, storage: { get: async key => structuredClone(storage.get(key)),
        set: async (key, value) => { storage.set(key, structuredClone(value)); }, remove: async key => { storage.delete(key); },
        scan: async ({ prefix }) => ({ entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }) },
      ...(!options.permissionsUnavailable ? { agent: { transform: async (callback: Function) => {
        transforms.push(callback);
        try { rebuild(); } catch (error) { transforms.pop(); throw error; }
        return { dispose() { transforms.splice(transforms.indexOf(callback), 1); rebuild(); } };
      }, get: async ({ agentID }: { agentID: string }) => ({ ...registry[agentID], model: registry[agentID]?.model ?? {
        providerID: "openai", id: agentID === "dog-worker-v010" ? "gpt-6-luna-fast" : "gpt-6.1-sol", variant: agentID === "dog-worker-v010" ? "max" : "xhigh" } }) } } : {}),
      event: { subscribe: async function* () {} },
      tool: { transform: async callback => { callback({ add: tool => tools.push(tool),
        update: (name, update) => { const tool = tools.find(tool => tool.name === name); if (tool) update(tool as never); } }); return { dispose() {} }; },
        hook: async (name, callback) => { toolHooks.set(name, callback); return { dispose() {} }; } },
      session: { get: async ({ sessionID }) => {
        if (!agents[sessionID]) throw { _tag: "SessionNotFoundError", sessionID };
        if (sessionID === "author" && agents.author!.outcome === "interrupted" && projection.failRestorationLookup) {
          throw new Error("native-session-lookup-transient");
        }
        return { id: sessionID, model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" }, ...agents[sessionID] };
      },
        context: async ({ sessionID }) => options.contextWindow ? (history[sessionID] ?? []).slice(-options.contextWindow) : history[sessionID] ?? [],
        list: async ({ parentID }) => ({ data: Object.entries(agents).filter(([, info]) => info.parentID === parentID).map(([id, info]) => ({ id, ...info })), cursor: {} }),
        prompt: async () => ({}), synthetic: async () => ({}), interrupt: async ({ sessionID }) => { agents[String(sessionID)]!.outcome = "interrupted"; return { interrupted: true }; },
        switchAgent: async input => {
          if (input.agent === "dog-reviewer-v010" && projection.failRestore) { projection.failRestore = false; throw new Error("native-switch-transient"); }
          switches.push(input); agents[String(input.sessionID)]!.agent = input.agent;
        },
        switchModel: async input => { switches.push(input); agents[String(input.sessionID)]!.model = input.model; },
        hook: async (name, callback) => { sessionHooks.set(name, callback); return { dispose() {} }; } },
      permission: { hook: async (_name, callback) => { permissionHook = callback; return { dispose() {} }; } }, // NO rules API.
      message: { list: async ({ sessionID, order }) => ({
        data: order === "desc" ? [...(history[String(sessionID)] ?? [])].reverse() : history[String(sessionID)] ?? [], cursor: {},
      }) },
      provider: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
    };
    cleanup = await createSortieDogsV2Plugin(async (input, pluginOptions) => {
      if (options.compactedHistory) {
        const session = (input.client as ObjectValue).session, messages = session.messages;
        // Match hosts where messages exposes only the compacted context, while
        // reviewMessages retains the public paginated native admission history.
        session.messages = async (request: ObjectValue) => {
          const result = await messages(request);
          return request.path?.id === "author" && compaction.start !== null
            ? { ...result, data: result.data.slice(compaction.start) } : result;
        };
      }
      hooks = await SortieDogsV010Plugin(input, pluginOptions); return hooks;
    }).setup(context);
  };
  const permission = async (sessionID: string, action: string, resource: string | string[], savedAllow = false, callID?: string) => {
    // Permission.evaluateInput: configured deny is terminal before saved allow and hook.
    const resources = typeof resource === "string" ? [resource] : resource;
    const effects = resources.map(resource => evaluate(action, resource, registry[agents[sessionID]!.agent]!.permissions, agents[sessionID]!.permissions ?? []).effect);
    if (effects.includes("deny")) return "deny";
    const configured = effects.includes("ask") ? "ask" : "allow";
    const event = { sessionID, agent: agents[sessionID]!.agent, action, resources, effect: savedAllow ? "allow" : configured,
      ...(callID ? { source: { type: "tool", id: callID } } : {}) };
    await permissionHook(event);
    return event.effect;
  };
  const before = async (sessionID: string, tool: string, input: ObjectValue) => {
    const event = { sessionID, agent: agents[sessionID]!.agent, tool, id: `call_${++counter}`, input: structuredClone(input) };
    await toolHooks.get("execute.before")!(event);
    if (tool === "subagent" && event.input.sessionID && event.input.agent === "dog-reviewer-v010" && !hooks.nativeTaskJoin?.(event.id, false)) {
      // Pinned SubagentTool: resolve/assert ORIGINAL target, then compare existing.agent, then
      // prompt. The real prompt hook activates its alias only AFTER this native permission step.
      assert.notEqual(await permission(sessionID, "subagent", event.input.agent), "deny");
      assert.equal(agents[event.input.sessionID]!.agent, event.input.agent);
    }
    if (tool === "shell" && agents[sessionID]!.agent.startsWith("dog-reviewer-correction-")) {
      // Independent pinned scanLegacy command-node fixtures, NOT a production permission helper.
      const resources = input.command === "node required-test.mjs; node check.mjs"
        ? ["node required-test.mjs", "node check.mjs"] : input.command.split(" && ");
      assert.notEqual(await permission(sessionID, "shell", resources, false, event.id), "deny", "native permission denied shell");
    }
    return event;
  };
  const after = async (event: ObjectValue, content: string, metadata: ObjectValue = {}, status = "completed") => {
    const now = Date.now();
    (history[event.sessionID] ??= []).push({ id: `msg_${++counter}`, type: "assistant", agent: agents[event.sessionID]!.agent,
      model: { providerID: "openai", id: "gpt-6.1-sol" }, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "tool-calls", time: { created: now, completed: now }, content: [{ type: "tool", name: event.tool, id: event.id,
        state: { status, input: event.input, content: [{ type: "text", text: content }], metadata }, time: { created: now, ran: now, completed: now } }] });
    const completed = { ...event, status, result: { content, metadata } };
    await toolHooks.get("execute.after")!(completed); return completed.result.content;
  };
  const prompt = async (sessionID: string, text: string, messageID = `msg_${++counter}`) => {
    delete agents[sessionID]!.outcome;
    const event = { sessionID, messageID, prompt: { text: sessionID === "root" ? text : `You are a subagent spawned by another session.\n${text}` } };
    await sessionHooks.get("prompt")!(event);
    if (!(history[sessionID] ??= []).some(message => message.id === messageID)) history[sessionID]!.push({ id: event.messageID, type: "user", text: event.prompt.text, time: { created: Date.now() } });
    return event.prompt.text;
  };
  const tool = async (sessionID: string, name: string, input: ObjectValue = {}) => {
    const event = await before(sessionID, `sortie_v010_${name}`, input);
    const result = await tools.find(item => item.name === event.tool)!.execute(event.input, { sessionID, agent: agents[sessionID]!.agent });
    await after(event, result.content); return JSON.parse(result.content);
  };
  const task = (task: ObjectValue) => ({ agent: task.subagent_type, description: task.description, prompt: task.prompt,
    ...(task.task_id ? { sessionID: task.task_id } : {}) });
  const run = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const bind = async (child: string) => {
    const unit = (await run()).units[0]!;
    const read = await before(child, "read", { path: unit.handoffPath });
    assert.match(await after(read, await readFile(unit.handoffPath, "utf8")), /SORTIE_WORKER_ACTIVATION: \{"status":"ready"\}/);
  };
  const edit = async (child: string, value: string) => {
    const patch = await before(child, "patch", { patchText: `*** Begin Patch\n*** Update File: result.txt\n@@\n-${(await readFile(join(directory, "result.txt"), "utf8")).trim()}\n+${value}\n*** End Patch` });
    await writeFile(join(directory, "result.txt"), value + "\n"); await after(patch, "Updated result.txt");
  };
  const shell = async (child: string, command: string, exit = 0, workdir?: string) => {
    const event = await before(child, "shell", { command, ...(workdir ? { workdir } : {}) });
    const output = await exec("bash", ["-c", event.input.command], { cwd: resolve(directory, workdir ?? ".") }).catch(error => ({ stdout: error.stdout, code: error.code }));
    await after(event, output.stdout, { exit: "code" in output ? output.code : exit });
  };
  const terminal = (child: string, text: string, failed = false) => {
    agents[child]!.outcome = failed ? "failed" : "succeeded";
    (history[child] ??= []).push({ id: `msg_${++counter}`, type: "assistant", agent: agents[child]!.agent, finish: "stop",
      model: { providerID: "openai", id: "gpt-6.1-sol" }, tokens: { input: 100, output: 20, cache: { read: 0, write: 0 }, reasoning: 0 },
      ...(failed ? { error: { name: "NativeTaskError" } } : {}),
      time: { created: Date.now(), completed: Date.now() }, content: [{ type: "text", text }] });
  };
  const finish = async (event: ObjectValue, child: string, text: string) => {
    terminal(child, text);
    return after(event, text, { sessionID: child });
  };
  const ledger = async () => {
    const key = createHash("sha256").update("v010\0root").digest("hex");
    const candidates = [join(directory, ".git", "sortie-dogs", "run-flight-v010", `${key}.json`),
      join(directory, ".git", "run-flight-v010", `${key}.json`), join(directory, ".sortie-dogs-v010", "run-flight", `${key}.json`)];
    for (const path of candidates) {
      try { return await RunFlightLedger.readGoalFile(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    throw new Error("fixture-goal-ledger-missing");
  };
  await start();
  return { directory, agents, history, storage, rules, switches, projection, compaction, globalRules, agentRules, registry: () => registry, start, before, after, prompt, tool, task, run, missions, bind, edit, shell, finish, terminal, ledger, permission, nativeLaunches,
    launch: (event: ObjectValue) => tools.find(tool => tool.name === "subagent")!.execute(event.input, { id: event.id, sessionID: event.sessionID }),
    hooks: () => hooks, context: (event: ObjectValue) => sessionHooks.get("context")!(event),
    dispose: async () => { cleanup?.(); await rm(directory, { recursive: true, force: true }); } };
}

export async function initial(f: Awaited<ReturnType<typeof fixture>>, options: { readonly?: boolean; operation?: boolean; skipOperation?: boolean; validation?: string[]; original?: string; write?: string[]; keepReviewOpen?: boolean; backgroundReview?: boolean } = {}) {
  const original = options.original ?? "Produce ready output, validate, commit it, preserve all constraints and independently review.";
  await f.prompt("root", original);
  await f.tool("root", "start_mission", { requirements: ["Output must be ready", "Validate and commit; independent review"], ...(options.operation ? { kind: "operation" } : {}) });
  const plan = await f.tool("root", "plan_units", { units: [{ title: "Ready output", objective: "Produce ready output",
     read: ["check.mjs", "required-test.mjs", "generate.mjs", "format.mjs"], write: options.readonly ? [] : options.write ?? ["result.txt"], validation: options.validation ?? ["node check.mjs"] }],
     ...(options.operation ? { execution: { commands: ["node operation.mjs"], directory: f.directory } } : {}) });
  assert(plan.task, JSON.stringify(plan));
  const worker = await f.before("root", "subagent", f.task(plan.task));
  await f.prompt("worker", worker.input.prompt); await f.bind("worker");
  if (!options.readonly) { await f.edit("worker", "wrong"); await f.shell("worker", "git add -- result.txt"); await f.shell("worker", "git commit -m candidate"); }
  for (const command of options.validation ?? ["node check.mjs"]) await f.shell("worker", command);
  if (options.operation && !options.skipOperation) await f.shell("worker", "node operation.mjs");
  await f.finish(worker, "worker", "Implemented");
  const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
  const dispatch = await f.before("root", "subagent", { ...f.task(review.task), ...(options.backgroundReview ? { background: true } : {}) });
  await f.prompt("author", dispatch.input.prompt);
   if (!options.keepReviewOpen) await f.finish(dispatch, "author", "FINDINGS\nMedium: result.txt is wrong rather than ready; correct its content.\nMedium: preserve the ready output contract.\nMedium: keep required validation and clean commit semantics.");
   return { original, dispatch, run: await f.run(), mission: await f.missions.required("root") };
}

export async function stagedInitial(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(f.directory, "README.md"), "draft\n");
  await writeFile(join(f.directory, "greet.mjs"), 'export const greet = name => `Hello, ${name.replace(/[^\\x00-\\x7f]/g, "")}!`;\n');
  await writeFile(join(f.directory, "check.mjs"), 'import assert from "node:assert/strict"; import { greet } from "./greet.mjs"; assert.equal(greet("Ada"), "Hello, Ada!");\n');
  await exec("git", ["add", "README.md", "greet.mjs", "check.mjs"], { cwd: f.directory });
  await exec("git", ["commit", "-m", "staged fixture baseline"], { cwd: f.directory });
  const original = "First Worker changes only the README release label, validates and commits. Complete delivery must preserve Unicode names exactly. After initial Review, the SAME Reviewer may correct source/tests with regression coverage, fresh node check.mjs, a real commit and clean source, then SELF_RECHECKED. Do not modify settings or contracts.";
  await f.prompt("root", original);
  await f.tool("root", "start_mission", { requirements: ["Stage one changes only README.md from draft to ready", "Complete delivery preserves Unicode names; SAME Reviewer corrects source/tests, validates and commits"],
    prohibited_write: ["settings.json", ".opencode/**", ".sortie-dogs-v010/**"] });
  const plan = await f.tool("root", "plan_units", { units: [{ title: "Stage one release label", objective: "Change only README.md from draft to ready",
    read: ["README.md", "greet.mjs", "check.mjs"], write: ["README.md"], validation: ["node check.mjs"] }] });
  const worker = await f.before("root", "subagent", f.task(plan.task));
  await f.prompt("worker", worker.input.prompt); await f.bind("worker");
  await f.shell("worker", "git switch -c stage-one/readme");
  const patch = await f.before("worker", "patch", { patchText: "*** Begin Patch\n*** Update File: README.md\n@@\n-draft\n+ready\n*** End Patch" });
  await writeFile(join(f.directory, "README.md"), "ready\n"); await f.after(patch, "Updated README.md");
  await f.shell("worker", "node check.mjs"); await f.shell("worker", "git add README.md && git commit -m stage-one");
  await f.finish(worker, "worker", "Stage one committed and checked, clean source");
  const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
  const dispatch = await f.before("root", "subagent", f.task(review.task));
  await f.prompt("author", dispatch.input.prompt);
  await f.finish(dispatch, "author", "FINDINGS\nMedium: greet.mjs deletes non-ASCII characters, violating exact-name preservation. Correct source and add Unicode regressions to check.mjs.");
  return { original, run: await f.run(), mission: await f.missions.required("root") };
}

export const unicodeCorrection = {
  "greet.mjs": 'export const greet = name => `Hello, ${name}!`;\n',
  "check.mjs": 'import assert from "node:assert/strict"; import { greet } from "./greet.mjs"; assert.equal(greet("Ada"), "Hello, Ada!"); assert.equal(greet("Zoë"), "Hello, Zoë!"); assert.equal(greet("あい"), "Hello, あい!");\n',
};

export async function correctUnicode(f: Awaited<ReturnType<typeof fixture>>) {
  const sections = await Promise.all(Object.entries(unicodeCorrection).map(async ([path, content]) =>
    `*** Update File: ${join(f.directory, path)}\n@@\n-${(await readFile(join(f.directory, path), "utf8")).trimEnd()}\n+${content.trimEnd()}`));
  const patch = await f.before("author", "patch", { patchText: `*** Begin Patch\n${sections.join("\n")}\n*** End Patch` });
  for (const [path, content] of Object.entries(unicodeCorrection)) await writeFile(join(f.directory, path), content);
  await f.after(patch, "Updated greet.mjs and check.mjs");
}

export async function correctionReady(f: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await f.tool("root", "repair_review");
  const dispatch = await f.before("root", "subagent", f.task(prepared.task));
  await f.prompt("author", dispatch.input.prompt); await f.bind("author");
  await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
  await f.shell("author", "node check.mjs");
  await f.finish(dispatch, "author", "CORRECTION_READY\nAll retained findings corrected and declared checks/commit passed.");
}

export const inlineReport = (unresolved: string[] = [], residual: unknown = null, candidate = "current-validated") =>
  `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate, unresolved_findings: unresolved, residual_major: residual })}\nCompared every original requirement, all retained findings, corrected source and relevant impact against actual fresh formal checks and clean commit.`;

export async function selfRecheck(f: Awaited<ReturnType<typeof fixture>>, residual: unknown = null, unresolved: string[] = []) {
  const review = await f.tool("root", "review_mission", { risk_tags: [] });
  assert.equal(review.status, "self-recheck-required");
  const dispatch = await f.before("root", "subagent", f.task(review.task));
  await f.prompt("author", dispatch.input.prompt);
  const admitted = (await f.missions.required("root")).review!;
  assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-api"] })).status, "review-running");
  assert.equal((await f.missions.required("root")).review!.promptID, admitted.promptID, "active self-recheck preserves exact prompt generation");
  const candidate = admitted.source;
  const text = `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate, unresolved_findings: unresolved, residual_major: residual })}\nCompared original requirements, all prior findings, correction and relevant impact with actual successful checks.`;
  return { dispatch, text, candidate };
}
