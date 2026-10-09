import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createSortieDogsV2Plugin, nativeReviewerRoleRules, type OpenCodeV2Context } from "../dist/plugin/v2.js";
import { Agent } from "@opencode/schema/agent";
import { OpenCode } from "@opencode/client";
import { convertedAssetPermissions, evaluate, whollyDisabled, type Rule } from "./fixtures/native-v2-2018-contract.ts";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { OperatorMissionRuntime, missionPlan, missionReviewIndependent } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { runtimeAssets } from "../dist/runtime-assets-v010.js";
import { canonicalDeclaredValidationMembers } from "../dist/plugin/gate.js";
import type { OpenCodeHooks } from "../dist/plugin/index.js";

const exec = promisify(execFile);
type ObjectValue = Record<string, any>;

async function fixture(options: { permissionsUnavailable?: boolean } = {}) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/reviewer-correction-"));
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
  const agents: Record<string, ObjectValue> = { root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
    author: { agent: "dog-reviewer-v010", parentID: "root" }, final: { agent: "dog-reviewer-v010", parentID: "root" } };
  const history: Record<string, ObjectValue[]> = {}, storage = new Map<string, unknown>(), rules: ObjectValue[] = [], switches: ObjectValue[] = [];
  const globalRules: Rule[] = [];
  const agentRules: Record<string, Rule[]> = {};
  let registry: Record<string, ObjectValue>;
  let tools: ObjectValue[], toolHooks: Map<string, Function>, sessionHooks: Map<string, Function>, permissionHook: Function, hooks: OpenCodeHooks;
  let cleanup: (() => void) | void, counter = 0;
  const projection = { failGrant: false, failRestore: false, failRestorationLookup: false };
  const start = async () => {
    cleanup?.(); tools = []; toolHooks = new Map(); sessionHooks = new Map();
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
      tool: { transform: async callback => { callback({ add: tool => tools.push(tool) }); return { dispose() {} }; },
        hook: async (name, callback) => { toolHooks.set(name, callback); return { dispose() {} }; } },
      session: { get: async ({ sessionID }) => {
        if (!agents[sessionID]) throw { _tag: "SessionNotFoundError", sessionID };
        if (sessionID === "author" && agents.author!.outcome === "interrupted" && projection.failRestorationLookup) {
          throw new Error("native-session-lookup-transient");
        }
        return { id: sessionID, model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" }, ...agents[sessionID] };
      },
        context: async ({ sessionID }) => history[sessionID] ?? [],
        list: async ({ parentID }) => ({ data: Object.entries(agents).filter(([, info]) => info.parentID === parentID).map(([id, info]) => ({ id, ...info })), cursor: {} }),
        prompt: async () => ({}), synthetic: async () => ({}), interrupt: async ({ sessionID }) => { agents[String(sessionID)]!.outcome = "interrupted"; return { interrupted: true }; },
        switchAgent: async input => {
          if (input.agent === "dog-reviewer-v010" && projection.failRestore) { projection.failRestore = false; throw new Error("native-switch-transient"); }
          switches.push(input); agents[String(input.sessionID)]!.agent = input.agent;
        },
        switchModel: async input => { switches.push(input); agents[String(input.sessionID)]!.model = input.model; },
        hook: async (name, callback) => { sessionHooks.set(name, callback); return { dispose() {} }; } },
      permission: { hook: async (_name, callback) => { permissionHook = callback; return { dispose() {} }; } }, // NO rules API.
      provider: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
    };
    cleanup = await createSortieDogsV2Plugin(async (input, options) => { hooks = await SortieDogsV010Plugin(input, options); return hooks; }).setup(context);
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
    if (tool === "subagent" && input.sessionID && event.input.agent === "dog-reviewer-v010") {
      // Pinned SubagentTool: resolve/assert ORIGINAL target, then compare existing.agent, then
      // prompt. The real prompt hook activates its alias only AFTER this native permission step.
      assert.notEqual(await permission(sessionID, "subagent", event.input.agent), "deny");
      assert.equal(agents[input.sessionID]!.agent, event.input.agent);
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
  const shell = async (child: string, command: string, exit = 0) => {
    const event = await before(child, "shell", { command });
    const output = await exec("bash", ["-c", event.input.command], { cwd: directory }).catch(error => ({ stdout: error.stdout, code: error.code }));
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
  return { directory, agents, history, storage, rules, switches, projection, globalRules, agentRules, registry: () => registry, start, before, after, prompt, tool, task, run, missions, bind, edit, shell, finish, terminal, ledger, permission,
    hooks: () => hooks, context: (event: ObjectValue) => sessionHooks.get("context")!(event),
    dispose: async () => { cleanup?.(); await rm(directory, { recursive: true, force: true }); } };
}

async function initial(f: Awaited<ReturnType<typeof fixture>>, options: { readonly?: boolean; operation?: boolean; skipOperation?: boolean; validation?: string[]; original?: string; write?: string[]; keepReviewOpen?: boolean; backgroundReview?: boolean } = {}) {
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

for (const operation of [false, true]) test(`initial Reviewer records findings, corrects and validates in one native Task without a handoff reread: ${operation ? "operation" : "implementation"}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { operation, keepReviewOpen: true, validation: ["node required-test.mjs", "node check.mjs"] });
    const promptID = started.mission.review!.promptID;
    const investigatedSystem = { sessionID: "author", agent: f.agents.author!.agent, tools: { read: {}, grep: {}, sortie_v010_repair_review: {} }, system: [], messages: [] };
    await f.context(investigatedSystem);
    const findings = "FINDINGS\nMedium: result.txt is wrong rather than ready; preserve result, checks and clean delivery.";
    const begun = await f.tool("author", "repair_review", { findings });
    assert.equal(begun.execution, "same-native-task");
    assert.match(begun.next_action, /Run inherited formal commands in order as exact separate foreground native shell calls/);
    assert.match(begun.next_action, /Run formatting and diagnostics separately; do not append undeclared shell commands, tee, redirect or wrapper/);
    assert.equal(begun.findings, findings);
    assert.equal(begun.task, undefined);
    const active = await f.run();
    assert.equal(active.units[0]!.directExecution?.actor, "author");
    assert.equal(active.units[0]!.reviewerCorrection?.promptID, promptID);
    const handoff = JSON.parse(await readFile(active.units[0]!.handoffPath, "utf8"));
    assert.equal(handoff.ext["sortie-dogs/mission-context"].correction_context.findings, findings);
    assert.equal(handoff.ext["sortie-dogs/mission-context"].correction_context.initialPrompt, undefined);
    assert.equal((await f.tool("author", "repair_review", { findings })).status, "correction-running");
    assert.equal((await f.missions.required("root")).corrections!.length, 1);
    const available = ["read", "shell", "patch", "sortie_v010_repair_review", "sortie_v010_finish_direct_unit", "sortie_v010_bind_write_gate"];
    assert(available.every(name => !whollyDisabled(name === "patch" ? "edit" : name, f.registry()[f.agents.author!.agent]!.permissions)), "controls survive the real native snapshot");
    const system = { sessionID: "author", agent: f.agents.author!.agent, tools: Object.fromEntries(available.map(name => [name, {}])), system: [], messages: [] };
    await f.context(system);
    assert.deepEqual(system.system, investigatedSystem.system, "repair admission does not replace the absolute instruction prefix; tool permissions still change normally");
    assert.doesNotMatch(JSON.stringify(system.system), /SORTIE_REVIEWER_CONTINUOUS_CONTEXT/);
    assert.match(JSON.stringify(system.messages), /SORTIE_REVIEWER_CONTINUOUS_CONTEXT/);
    assert.doesNotMatch(JSON.stringify(system), /SORTIE_WORKER_CONTEXT|Read the retained handoff/);
    assert.deepEqual(Object.keys(system.tools).sort(), available.sort());
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
    await f.edit("author", "ready corrected");
    await f.shell("author", "node required-test.mjs");
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add -- result.txt");
    await f.shell("author", "git commit -m correction");
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "correction-validated");
    const validatedSystem = { ...system, system: [] };
    await f.context(validatedSystem);
    assert.deepEqual(validatedSystem.system, system.system, "stable prefix remains through final self-recheck, without changing counters or phase");
    assert.deepEqual(validatedSystem.messages, system.messages, "current assignment/findings remain through final self-recheck");
    await assert.rejects(f.edit("author", "not allowed after settlement"), /mission-reviewer-readonly/);
    assert.equal((await f.missions.required("root")).review!.verdict, "findings", "finish tool is not a native terminal or approval");
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review-required-or-stale/);
    const self = 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}\nCompared the original requirements, retained defect and impacted results with actual checks and clean commit; author self-recheck, not independent approval.';
    const returned = JSON.parse(await f.finish(started.dispatch, "author", self));
    assert.equal(returned.status, "review-correction-recorded");
    assert.equal(returned.independent, false);
    assert(returned.acceptance_summary);
    assert.match(returned.next_action, /no routine operator_status/);
    const done = await f.missions.required("root");
    assert.equal(done.review!.verdict, "self-rechecked");
    assert.equal(done.review!.selfRecheck!.callID, started.dispatch.id);
    assert.equal(done.review!.selfRecheck!.promptID, promptID);
    assert.equal(done.corrections![0]!.inlineReview!.callID, started.dispatch.id);
    assert.deepEqual(done.execution, started.mission.execution, "correction retains the operation result without replaying it");
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
    const unit = (await f.run()).units[0]!;
    assert(unit.directExecution!.finishedAt);
    assert.equal(done.attempts!.at(-1)!.kind, "direct_execution");
    assert.equal(done.attempts!.at(-1)!.terminal, undefined, "no fabricated second native Task terminal");
    assert.equal(unit.reviewerCorrection!.checks!.length, 2);
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const mode of ["live", "cold-reload"] as const) test(`continuous findings update retains complete correction assignment: ${mode}`, async () => {
  const f = await fixture();
  try {
    const original = "Original unchanged contract sentinel: preserve requested delivery and public behavior.";
    await initial(f, { keepReviewOpen: true, original, validation: ["node required-test.mjs", "node check.mjs"] });
    const first = "FINDINGS\nMedium: first exact retained defect.";
    await f.tool("author", "repair_review", { findings: first });
    const native: ObjectValue[] = [{ role: "user", content: [{ type: "text", text: "Independent initial Task" }] }];
    const context = () => ({ sessionID: "author", agent: f.agents.author!.agent, tools: {}, system: [], messages: [...native] });
    const before = context();
    await f.context(before);
    assert(JSON.stringify(before.messages).includes(original));
    const prior = structuredClone(before.messages);
    native.push({ role: "assistant", content: [{ type: "text", text: "New independent correction-impact observation" }] });
    if (mode === "cold-reload") await f.start();
    const extra = "FINDINGS\nMedium: second exact retained defect with newline\nand quoted \"detail\".";
    await f.tool("author", "repair_review", { findings: extra });
    const after = context();
    await f.context(after);
    assert.deepEqual(after.system, before.system, "stable role policy unaffected by new findings");
    assert.deepEqual(after.messages.slice(0, prior.length), prior, "previously sent state remains at its native boundary");
    assert.equal(after.messages[prior.length], native[1], "native message identity and ordering preserved");
    const latest = after.messages.at(-1) as ObjectValue;
    assert.equal(latest.role, "system");
    assert(JSON.stringify(latest).includes(original), "current state includes the complete original requirements");
    const text = latest.content.find((part: ObjectValue) => part.text.startsWith("SORTIE_REVIEWER_CONTINUOUS_CONTEXT\n"))?.text;
    assert(text, "assignment and exact cumulative findings share one current host-state block");
    assert.deepEqual(JSON.parse(text.split("\n")[1]).validation, ["node required-test.mjs", "node check.mjs"]);
    assert.equal(JSON.parse(text.split("\n")[1]).findings, `${first}\n\n${extra}`);
    const ledger = f.storage.get("v2-model-live-state:author") as ObjectValue;
    assert.equal(ledger.updates.flatMap((update: ObjectValue) => update.text).filter((text: string) => text.includes(original)).length, 2);
    const correction = (await f.missions.required("root")).corrections![0]!;
    assert.equal(correction.findings, `${first}\n\n${extra}`, "authoritative Mission findings not summarized or replaced");
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
  } finally { await f.dispose(); }
});

for (const mode of ["live", "cold-reload", "failed-native-recovery"] as const) test(`running continuous correction retains additional findings without redispatch: ${mode}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, backgroundReview: mode === "cold-reload",
      validation: ["node required-test.mjs", "node check.mjs"] });
    if (mode === "cold-reload") await f.after(started.dispatch, "Native Review Job running", { sessionID: "author", status: "running" });
    const first = "FINDINGS\nMedium: result must be ready; preserve the initial investigation.";
    const extra = "FINDINGS\nAdditional Medium: ready output loses callback errors; preserve the independently reproduced behavior.";
    await f.tool("author", "repair_review", { findings: first });
    const originalContext = { sessionID: "author", agent: f.agents.author!.agent, tools: {}, system: [], messages: [] };
    await f.context(originalContext);
    await f.edit("author", "ready initial correction");
    await f.shell("author", "node required-test.mjs");
    const before = await f.run(), budget = (await f.ledger()).state;
    const handoff = await readFile(before.units[0]!.handoffPath, "utf8");
    if (mode === "cold-reload") await f.start();
    const continued = await f.tool("author", "repair_review", { findings: extra });
    assert.equal(continued.execution, "same-native-task");
    assert(continued.findings.includes(extra), "the real repeated native tool call must retain and return the new finding");
    await f.tool("author", "repair_review", { findings: extra });
    await f.tool("author", "repair_review", { findings: extra.replace(/^FINDINGS\n/u, "") });
    await f.tool("author", "repair_review");
    const mission = await f.missions.required("root"), after = await f.run();
    const correction = mission.corrections![0]!;
    assert.equal(mission.corrections!.length, 1);
    assert.equal(correction.findings, `${first}\n\n${extra}`, "exact retained submissions, idempotent header/no-header retries");
    assert.equal(mission.review!.result, first, "do not relabel a later author finding as the independent initial report");
    assert.equal(correction.reviewIdentity, before.units[0]!.reviewerCorrection!.reviewIdentity);
    assert.equal(after.runID, before.runID);
    assert.deepEqual(after.units[0]!.directExecution, before.units[0]!.directExecution);
    assert.deepEqual(after.units[0]!.reviewerCorrection, before.units[0]!.reviewerCorrection);
    assert.equal(await readFile(after.units[0]!.handoffPath, "utf8"), handoff, "immutable original handoff/check contract");
    assert.equal((await f.ledger()).state.consumed_units, budget.consumed_units);
    assert.equal((await f.ledger()).state.outstanding_reservations.length, budget.outstanding_reservations.length);
    const context = { sessionID: "author", agent: f.agents.author!.agent, tools: {}, system: [], messages: [] };
    await f.context(context);
    assert.deepEqual(context.system, originalContext.system, "additional findings and cold reconstruction preserve the original correction prefix");
    assert(JSON.stringify(context.messages).includes("Additional Medium"), "outgoing chronological system update reconstructs all known findings from durable state");
    assert(!JSON.stringify(context.system).includes("Additional Medium"), "new findings never rewrite the absolute system prefix");
    if (mode === "failed-native-recovery") {
      f.terminal("author", "Native correction failed before remaining formal checks", true);
      await f.after(started.dispatch, "Native correction failed", { sessionID: "author", status: "failed" }, "error");
      const recovery = await f.tool("root", "repair_review");
      const resumed = await f.before("root", "subagent", f.task(recovery.task));
      await f.prompt("author", resumed.input.prompt); await f.bind("author");
      const recovered = await f.missions.required("root"), unit = (await f.run()).units[0]!;
      assert.equal(recovered.corrections!.at(-1)!.findings, correction.findings);
      assert.equal(JSON.parse(await readFile(unit.handoffPath, "utf8")).ext["sortie-dogs/mission-context"].correction_context.findings, correction.findings);
      await f.edit("author", "ready all findings corrected");
      await f.shell("author", "git add -- result.txt && git commit -m all-findings-correction");
      await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
      await f.finish(resumed, "author", inlineReport());
    } else {
      await f.edit("author", "ready all findings corrected");
      assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation", "added defects do not waive source freshness");
      await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
      await f.shell("author", "git add -- result.txt && git commit -m all-findings-correction");
      await f.tool("author", "finish_direct_unit");
      await f.finish(started.dispatch, "author", inlineReport());
      assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
      assert.equal((await f.ledger()).state.consumed_units, 2);
    }
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

test("additional continuous findings are serialized, original-author and generation bound", async () => {
  const f = await fixture();
  try {
    await initial(f, { keepReviewOpen: true });
    const first = "Medium: retain the original ready result contract.";
    await f.tool("author", "repair_review", { findings: first });
    const extra = ["Medium: callback errors are lost.", "Medium: reflected interface values are rejected."];
    await Promise.all(extra.map(findings => f.tool("author", "repair_review", { findings })));
    const mission = await f.missions.required("root");
    const findings = mission.corrections![0]!.findings.split("\n\n");
    assert.equal(findings.shift(), `FINDINGS\n${first}`);
    assert.deepEqual(findings.sort(), [...extra].sort(), "concurrent arrivals retain each complete finding once, irrespective of arrival order");
    const retained = structuredClone(mission.corrections);
    await assert.rejects(f.tool("final", "repair_review", { findings: "Medium: wrong actor" }), /mission-review-correction-reviewer-not-current/);
    assert.deepEqual((await f.missions.required("root")).corrections, retained);
    const promptID = mission.review!.promptID;
    await f.missions.update("root", item => { item.review!.promptID = "different-native-generation"; });
    await assert.rejects(f.tool("author", "repair_review", { findings: "Medium: stale generation" }), /mission-review-correction-generation-stale/);
    assert.deepEqual((await f.missions.required("root")).corrections, retained);
    await f.missions.update("root", item => { item.review!.promptID = promptID; });
    await f.tool("author", "repair_review", { findings: "FINDINGS\n" });
    await f.tool("author", "repair_review", { findings: " \n" });
    assert.deepEqual((await f.missions.required("root")).corrections, retained);
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
    assert.equal((await f.missions.required("root")).review!.result, `FINDINGS\n${first}`);
  } finally { await f.dispose(); }
});

test("inline correction keeps the actual Reviewer and current source binding", async () => {
  const f = await fixture();
  try {
    await initial(f, { keepReviewOpen: true });
    const findings = "FINDINGS\nMedium: result must be ready.";
    await assert.rejects(f.tool("final", "repair_review", { findings }), /mission-review-correction-reviewer-not-current/);
    await writeFile(join(f.directory, "result.txt"), "changed outside review\n");
    await assert.rejects(f.tool("author", "repair_review", { findings }), /mission-review-correction-source-stale/);
    assert.equal((await f.missions.required("root")).corrections, undefined);
  } finally { await f.dispose(); }
});

test("an unfinished inline correction cannot borrow a native terminal and releases its reserved direct unit", async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true });
    await f.tool("author", "repair_review", { findings: "FINDINGS\nMedium: result must be ready." });
    const returned = JSON.parse(await f.finish(started.dispatch, "author", 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}'));
    assert.equal(returned.status, "review-correction-incomplete");
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal((await f.run()).units[0]!.status, "failed");
    await assert.rejects(f.tool("root", "complete_mission"));
    const recovered = await f.tool("root", "repair_review");
    assert.equal(recovered.task.task_id, "author", "only actual incomplete terminal needs a continuation Task");
    const resumed = await f.before("root", "subagent", f.task(recovered.task));
    await f.prompt("author", resumed.input.prompt); await f.bind("author");
    await f.edit("author", "ready resumed");
    await f.shell("author", "git add -- result.txt && git commit -m resumed-correction");
    await f.shell("author", "node check.mjs");
    await f.finish(resumed, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 3);
  } finally { await f.dispose(); }
});

test("continuous Reviewer background Task survives cold reload before and after direct validation", async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, backgroundReview: true });
    await f.after(started.dispatch, "Native Review Job running", { sessionID: "author", status: "running" });
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    await f.start();
    await f.edit("author", "ready continuous");
    await f.shell("author", "git add -- result.txt && git commit -m continuous-correction");
    await f.shell("author", "node check.mjs");
    await f.tool("author", "finish_direct_unit");
    await f.start();
    assert.match(f.agents.author!.agent, /^dog-reviewer-correction-/);
    assert.equal((await f.missions.required("root")).review!.verdict, "findings");
    f.terminal("author", inlineReport());
    await f.tool("root", "operator_status");
    const done = await f.missions.required("root");
    assert.equal(done.review!.verdict, "self-rechecked");
    assert.equal(done.review!.selfRecheck!.callID, started.dispatch.id);
    assert.equal(done.review!.selfRecheck!.promptID, started.mission.review!.promptID);
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const mode of ["failed-check", "changed-source", "unresolved-medium", "native-failure", "missing-self-report", "cancel"] as const) test(`continuous Reviewer preserves formal validation and actual terminal: ${mode}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, validation: ["node required-test.mjs", "node check.mjs"] });
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    await f.edit("author", "ready corrected");
    await f.shell("author", "node required-test.mjs", mode === "failed-check" ? 1 : 0);
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add -- result.txt && git commit -m continuous-guard");
    if (mode === "changed-source") await f.edit("author", "ready changed after checks");
    if (mode === "cancel") {
      await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      assert.equal((await f.missions.required("root")).corrections![0]!.status, "cancelled");
      assert.equal(f.agents.author!.outcome, "interrupted", "cancellation stops the actual still-running native Review, not only its direct grant");
    } else if (["changed-source", "failed-check"].includes(mode)) {
      assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
      await f.finish(started.dispatch, "author", inlineReport());
      assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
    } else {
      await f.tool("author", "finish_direct_unit");
      if (mode === "native-failure") {
        f.terminal("author", inlineReport(), true);
        await f.after(started.dispatch, inlineReport(), { sessionID: "author", status: "failed" }, "error");
      } else if (mode === "missing-self-report") await f.finish(started.dispatch, "author", "Correction done, no actual self-recheck report.");
      else await f.finish(started.dispatch, "author", inlineReport(["Medium: original ready requirement remains wrong."]));
    }
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    if (mode === "cancel") assert.notEqual((await f.tool("root", "complete_mission")).status, "succeeded");
    else await assert.rejects(f.tool("root", "complete_mission"));
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    if (mode === "native-failure" || mode === "missing-self-report") {
      const formalCalls = f.history.author!.flatMap(message => message.content ?? []).filter(part => part.type === "tool" &&
        ["node required-test.mjs", "node check.mjs"].includes(part.state.input.command)).length;
      assert.equal(formalCalls, 2);
      const fallback = await f.tool("root", "review_mission", { risk_tags: [] });
      assert.equal(fallback.status, "self-recheck-required");
      assert.equal(fallback.task.task_id, "author");
      const resumed = await f.before("root", "subagent", f.task(fallback.task));
      await f.prompt("author", resumed.input.prompt);
      await assert.rejects(f.edit("author", "read-only fallback"), /mission-reviewer-readonly/);
      await f.finish(resumed, "author", inlineReport([], null, (await f.missions.required("root")).review!.source));
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      assert.equal((await f.ledger()).state.consumed_units, 2, "only missing self-recheck, no new correction/validation unit");
    }
  } finally { await f.dispose(); }
});

test("cancellation after continuous validation still stops the actual native self-recheck", async () => {
  const f = await fixture();
  try {
    await initial(f, { keepReviewOpen: true });
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    await f.edit("author", "ready corrected");
    await f.shell("author", "git add -- result.txt && git commit -m continuous-cancel");
    await f.shell("author", "node check.mjs");
    await f.tool("author", "finish_direct_unit");
    await f.start();
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.equal(f.agents.author!.outcome, "interrupted");
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal((await f.missions.required("root")).phase, "cancelled");
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "cancelled");
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

async function stagedInitial(f: Awaited<ReturnType<typeof fixture>>) {
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

const unicodeCorrection = {
  "greet.mjs": 'export const greet = name => `Hello, ${name}!`;\n',
  "check.mjs": 'import assert from "node:assert/strict"; import { greet } from "./greet.mjs"; assert.equal(greet("Ada"), "Hello, Ada!"); assert.equal(greet("Zoë"), "Hello, Zoë!"); assert.equal(greet("あい"), "Hello, あい!");\n',
};

async function correctUnicode(f: Awaited<ReturnType<typeof fixture>>) {
  const sections = await Promise.all(Object.entries(unicodeCorrection).map(async ([path, content]) =>
    `*** Update File: ${join(f.directory, path)}\n@@\n-${(await readFile(join(f.directory, path), "utf8")).trimEnd()}\n+${content.trimEnd()}`));
  const patch = await f.before("author", "patch", { patchText: `*** Begin Patch\n${sections.join("\n")}\n*** End Patch` });
  for (const [path, content] of Object.entries(unicodeCorrection)) await writeFile(join(f.directory, path), content);
  await f.after(patch, "Updated greet.mjs and check.mjs");
}

test("claimed Mission correction activates before limit-bearing Read or shell, without manual binding", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    const unit = (await f.run()).units[0]!;
    const read = await f.before("author", "read", { path: unit.handoffPath, limit: 2000 });
    const clipped = 'Read file, lines 1-1\n1: ' + (await readFile(unit.handoffPath, "utf8")).slice(0, 2000) + '... (line truncated to 2000 chars)';
    assert.match(await f.after(read, clipped, { truncated: false }), /SORTIE_EXACT_CONTRACT_VIEW/u,
      "limit is a line count; a full-file request receives exact values despite native line clipping");
    const partial = await f.before("author", "read", { path: unit.handoffPath, offset: 2, limit: 1 });
    assert.equal(await f.after(partial, "partial line", { truncated: false }), "partial line",
      "a true partial range does not acquire a full projection");
    await f.shell("author", "node check.mjs");
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks;
    assert.equal(checks?.length, 1, "exact admission must bind before a model-chosen Read or its first actual formal check");
    assert.equal(checks![0]!.fresh, true); assert.equal(checks![0]!.dispatchCallID, dispatch.id);
    await correctUnicode(f);
    const expanded = (await f.run()).units[0]!;
    assert.deepEqual(expanded.unit.write, ["README.md", "greet.mjs", "check.mjs"]);
    assert.deepEqual(expanded.reviewerCorrection!.writeUnion, expanded.unit.write);
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add greet.mjs check.mjs && git commit -m admitted-unicode");
    const current = (await f.run()).units[0]!, evidence = structuredClone(current.reviewerCorrection!.checks), budget = await f.ledger();
    await Promise.all([f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID),
      f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID)]);
    assert.deepEqual((await f.run()).units[0]!.unit.write, current.unit.write, "duplicate hook retains CURRENT expanded scope");
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, evidence, "activation does not create or replace execution proof");
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    assert.equal((await exec("git", ["status", "--short"], { cwd: f.directory })).stdout, "");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.missions.required("root")).review!.verdict, "self-rechecked");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 2, "one Worker and one correction, no activation unit");
    assert.equal((await f.missions.required("root")).corrections!.length, 1);
    assert.equal(f.history.author!.some(message => message.content?.some((part: ObjectValue) => part.name === "sortie_v010_bind_write_gate")), false);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
  } finally { await f.dispose(); }
});

test("admission activation and legacy bind retries retain expanded correction scope and check occurrences", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await correctUnicode(f); await f.shell("author", "node check.mjs");
    const current = (await f.run()).units[0]!, checks = structuredClone(current.reviewerCorrection!.checks), budget = await f.ledger();
    await f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID);
    for (let retry = 0; retry < 2; retry++) {
      const bound = await f.tool("author", "bind_write_gate", { project_root: f.directory, manifest_path: current.manifestPath });
      assert.equal(bound.idempotent, true); assert.equal(bound.manifest_hash, current.hashes[1]);
    }
    await f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, checks);
    assert.deepEqual((await f.run()).units[0]!.unit.write, current.unit.write);
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("ordinary Reviewer and an unclaimed copied correction Task cannot acquire admission authority", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review");
    await f.prompt("author", prepared.task.prompt);
    await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: greet.mjs\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
    assert.equal((await f.run()).phase, "prepared");
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.promptID, undefined);
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal((await f.ledger()).state.consumed_units, 1);
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.shell("author", "node check.mjs");
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks!.length, 1, "only the actual native admission activates it");
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("cancelled admission cannot reactivate a saved correction prompt or settle its unit twice", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    const unit = (await f.run()).units[0]!;
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    const settled = (await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled");
    await f.prompt("author", unit.task.prompt, unit.reviewerCorrection!.promptID);
    await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: greet.mjs\n+x\n*** End Patch" }), /mission-reviewer-readonly|session-inactive/);
    await f.after(dispatch, "Duplicate old native cancellation", { sessionID: "author", status: "cancelled" }, "cancelled");
    assert.deepEqual((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled"), settled);
    assert.equal((await f.run()).phase, "cancelled");
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010"); assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
  } finally { await f.dispose(); }
});

for (const mode of ["handoff", "manifest", "copied-child", "wrong-reference", "wrong-parent", "prompt-generation"] as const) {
  test(`admission-owned activation does not authorize a changed or foreign identity: ${mode}`, async () => {
    const f = await fixture();
    try {
      await stagedInitial(f);
      const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
      const unit = (await f.run()).units[0]!;
      if (mode === "handoff" || mode === "manifest") {
        const path = mode === "handoff" ? unit.handoffPath : unit.manifestPath;
        const source = await readFile(path, "utf8"), changed = JSON.parse(source);
        if (mode === "handoff") changed.task.objective += " unauthorized replacement";
        else changed.write.push("settings.json");
        await writeFile(path, JSON.stringify(changed));
        await assert.rejects(f.prompt("author", dispatch.input.prompt), /Handoff denied|contract-invalid|mission-activation/);
        await writeFile(path, source);
      } else if (mode === "copied-child") {
        f.agents.final!.agent = "dog-worker-v010";
        await assert.rejects(f.prompt("final", dispatch.input.prompt), /worker-child-mismatch/);
        assert.equal((await f.run()).units[0]!.childSessionID, "author");
      } else if (mode === "wrong-reference") {
        await assert.rejects(f.prompt("author", dispatch.input.prompt + " altered"), /task-reference-mismatch/);
      } else if (mode === "wrong-parent") {
        await assert.rejects(new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE).claimAdmittedWorkerPrompt("root", "final", "author", dispatch.input.prompt), /parent-mismatch/);
      } else {
        await f.prompt("author", dispatch.input.prompt);
        const admitted = (await f.run()).units[0]!.reviewerCorrection!;
        await assert.rejects(f.prompt("author", unit.task.prompt), /prompt-generation-mismatch/);
        assert.equal((await f.run()).units[0]!.reviewerCorrection!.promptID, admitted.promptID);
      }
      f.terminal("author", "FINDINGS\nNative admission stopped; candidate unchanged.", true);
      await f.after(dispatch, "Native prompt failed", { sessionID: "author", status: "failed" }, "error");
      assert.equal((await f.run()).units[0]!.status, "failed");
      assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
      assert.equal((await f.ledger()).state.consumed_units, 2);
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: settings.json\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
    } finally { await f.dispose(); }
  });
}

test("staged native correction repairs source/test scope in the SAME admitted Reviewer and completes a fresh receipt", async () => {
  const f = await fixture();
  try {
    const previous = await stagedInitial(f);
    assert.deepEqual(previous.run.units[0]!.unit.write, ["README.md"]);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    const before = await f.run(), unit = before.units[0]!, budget = await f.ledger(), switches = f.switches.length;
    await f.shell("author", "node check.mjs");
    const oldChecks = structuredClone((await f.run()).units[0]!.reviewerCorrection!.checks);
    await correctUnicode(f);
    const expanded = await f.run(), next = expanded.units[0]!;
    assert.deepEqual(next.unit.write, ["README.md", "greet.mjs", "check.mjs"]);
    assert.deepEqual(next.reviewerCorrection!.writeUnion, next.unit.write);
    assert.equal(next.callID, dispatch.id); assert.equal(next.childSessionID, "author");
    assert.equal(next.reviewerCorrection!.promptID, unit.reviewerCorrection!.promptID);
    assert.equal(next.reviewerCorrection!.reviewIdentity, unit.reviewerCorrection!.reviewIdentity);
    assert.equal(next.reviewerCorrection!.admittedAt, unit.reviewerCorrection!.admittedAt);
    assert.equal(expanded.generation, before.generation); assert.equal(expanded.dispatched, before.dispatched);
    assert.notEqual(next.hashes[1], unit.hashes[1]); assert.equal(next.hashes[0], unit.hashes[0]);
    assert.deepEqual(next.reviewerCorrection!.checks, oldChecks, "scope repair retains historical proof, never relabels it");
    assert.equal(f.switches.length, switches, "scope repair changes no model, native role or prompt generation");
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    const manifest = await readFile(next.manifestPath, "utf8"), checks = structuredClone(next.reviewerCorrection!.checks);
    await f.tool("root", "expand_unit", { unit_id: next.unit.id, paths: ["greet.mjs", "check.mjs"], reason: "Already covered correction outputs" });
    assert.equal(await readFile(next.manifestPath, "utf8"), manifest, "covered expansion is a no-op");
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, checks);
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add greet.mjs check.mjs && git commit -m unicode-correction");
    assert.equal((await exec("git", ["status", "--short"], { cwd: f.directory })).stdout, "");
    await f.finish(dispatch, "author", inlineReport());
    const mission = await f.missions.required("root");
    assert.equal(mission.review!.verdict, "self-rechecked"); assert.equal(mission.review!.selfRecheck!.promptID, unit.reviewerCorrection!.promptID);
    assert.equal(mission.review!.selfRecheck!.author, "author"); assert.equal(missionReviewIndependent(mission, "author"), false);
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    const settled = (await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled");
    await f.after(dispatch, inlineReport(), { sessionID: "author" });
    assert.deepEqual((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled"), settled);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010"); assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
  } finally { await f.dispose(); }
});

test("staged correction literal shell scope reconciles the original command without a new admission", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    const command = "printf 'regression diagnostic' > correction.txt";
    const run = await f.run(), budget = await f.ledger();
    await f.shell("author", command);
    const unit = (await f.run()).units[0]!;
    assert.ok(unit.unit.write.includes("correction.txt"));
    assert.deepEqual(unit.reviewerCorrection!.writeUnion, unit.unit.write);
    assert.equal(unit.reviewerCorrection!.promptID, run.units[0]!.reviewerCorrection!.promptID);
    assert.equal(unit.reviewerCorrection!.checks, undefined, "diagnostics are not formal proof");
    assert.equal(await readFile(join(f.directory, "correction.txt"), "utf8"), "regression diagnostic");
    assert.equal((await f.run()).units[0]!.callID, dispatch.id); assert.equal((await f.run()).generation, run.generation);
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("expanded correction cannot accept old-scope checks after actual source/test changes", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author"); await f.shell("author", "node check.mjs");
    await correctUnicode(f); await f.shell("author", "git add greet.mjs check.mjs && git commit -m unvalidated-correction");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    await assert.rejects(f.tool("root", "complete_mission"), /validation|incomplete/);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010"); assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    const retry = await f.tool("root", "repair_review");
    assert.equal(retry.task.task_id, "author");
    assert.deepEqual((await f.run()).units[0]!.unit.write, ["README.md", "greet.mjs", "check.mjs"]);
    const admitted = await f.before("root", "subagent", f.task(retry.task));
    await f.prompt("author", admitted.input.prompt); await f.bind("author"); await f.shell("author", "node check.mjs");
    await f.finish(admitted, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 3, "failed and fresh same-owner correction settle once each");
  } finally { await f.dispose(); }
});

test("failed narrow correction restores read-only, repairs its scope and retries only the SAME native owner", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), failed = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", failed.input.prompt); await f.bind("author");
    await f.finish(failed, "author", "FINDINGS\nRetained Unicode defect unresolved; no correction validation or commit occurred.");
    const old = await f.run(), oldLedger = await f.ledger();
    assert.equal(old.units[0]!.status, "failed"); assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
    const scope = await f.tool("root", "expand_unit", { unit_id: "unit-1", paths: ["greet.mjs", "check.mjs"], reason: "Original post-Review source/test correction, not a new user requirement" });
    assert.equal(scope.status, "scope-updated"); assert.equal(scope.task, undefined);
    assert.equal((await f.run()).runID, old.runID); assert.equal((await f.run()).units[0]!.callID, failed.id);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.writeUnion, ["README.md", "greet.mjs", "check.mjs"]);
    assert.deepEqual((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled"), oldLedger.records.filter(({ event }) => event.kind === "unit.settled"));
    await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: greet.mjs\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
    const retry = await f.tool("root", "repair_review");
    assert.equal(retry.task.task_id, "author");
    const admitted = await f.before("root", "subagent", f.task(retry.task));
    await f.prompt("author", admitted.input.prompt); await f.bind("author"); await correctUnicode(f);
    await f.shell("author", "node check.mjs"); await f.shell("author", "git add greet.mjs check.mjs && git commit -m recovered-unicode");
    await f.finish(admitted, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    await f.after(failed, "Duplicate old failed terminal", { sessionID: "author", status: "failed" }, "error");
    assert.equal((await f.ledger()).state.consumed_units, 3); assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
  } finally { await f.dispose(); }
});

for (const mode of ["settings", "contracts", "outside-shell", "traversal", "wrong-owner", "stale-owner", "native-deny", "native-ask"] as const) {
  test(`staged correction scope repair preserves existing boundaries: ${mode}`, async () => {
    const f = await fixture();
    try {
      await stagedInitial(f);
      const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      const before = await f.run(), unit = before.units[0]!, manifest = await readFile(unit.manifestPath, "utf8");
      if (mode === "settings" || mode === "contracts") {
        const path = mode === "settings" ? "settings.json" : ".sortie-dogs-v010/contracts/forbidden.json";
        await assert.rejects(f.tool("root", "expand_unit", { unit_id: "unit-1", paths: [path], reason: "Forbidden output" }), /mission-explicit-write-prohibition/);
        await assert.rejects(f.before("author", "patch", { patchText: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` }), /mission-explicit-write-prohibition/);
      } else if (mode === "outside-shell") {
        await assert.rejects(f.before("author", "shell", { command: `printf x > ${join(f.directory, "../outside.txt")}` }), /project-root-relative path required/);
      } else if (mode === "traversal" || mode === "wrong-owner") {
        await assert.rejects(new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE).expandMissionWriteScope("root", mode === "wrong-owner" ? "final" : "author",
          /^task_id: (.+)$/mu.exec(unit.task.prompt)![1]!, [mode === "traversal" ? "../outside.txt" : "greet.mjs"], async () => async () => {}),
        mode === "traversal" ? /traversal/ : /current-task-required/);
      } else if (mode === "stale-owner") {
        f.terminal("author", "FINDINGS\nCorrection failed without current validation.", true);
        await f.after(dispatch, "Correction failed", { sessionID: "author", status: "failed" }, "error");
        await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Update File: greet.mjs\n@@\n-old\n+new\n*** End Patch" }), /mission-reviewer-readonly/);
        await f.tool("root", "operator_status");
        assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
        assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      } else {
        const effect = mode === "native-deny" ? "deny" : "ask";
        const prior = [{ action: "edit", resource: "*greet.mjs", effect }];
        f.agents.author!.permissions = prior;
        await f.tool("root", "expand_unit", { unit_id: "unit-1", paths: ["greet.mjs"], reason: "Original source correction" });
        assert.equal(await f.permission("author", "edit", join(f.directory, "greet.mjs"), effect === "deny"), effect);
        assert.deepEqual(f.agents.author!.permissions, prior);
        assert.equal(await readFile(join(f.directory, "greet.mjs"), "utf8"), 'export const greet = name => `Hello, ${name.replace(/[^\\x00-\\x7f]/g, "")}!`;\n');
      }
      if (!["native-deny", "native-ask"].includes(mode)) assert.equal(await readFile(unit.manifestPath, "utf8"), manifest);
      await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    } finally { await f.dispose(); }
  });
}

test("correction commits only actual changed outputs despite unchanged exact permission and deleted scratch", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "untouched.txt"), "unchanged");
    await exec("git", ["add", "untouched.txt"], { cwd: f.directory });
    await exec("git", ["commit", "-m", "fixture unchanged input"], { cwd: f.directory });
    await initial(f, { write: ["result.txt", "untouched.txt", "scratch.tmp"] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready");
    await f.shell("author", "printf scratch > scratch.tmp"); await f.shell("author", "rm scratch.tmp");
    await f.shell("author", "node check.mjs");
    assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: f.directory })).stdout, "");
    await f.shell("author", "git add result.txt && git diff --cached --stat && git commit -m correction-subset");
    assert.equal((await exec("git", ["status", "--short"], { cwd: f.directory })).stdout, "");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.missions.required("root")).review!.verdict, "self-rechecked");
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const mode of ["outside-index", "prohibited-index", "prohibited-add"] as const) test(`correction add then commit preserves actual index and prohibited glob: ${mode}`, async () => {
  const f = await fixture();
  try {
    await initial(f, { write: ["result.txt", "nested/**"] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.missions.update("root", state => { state.prohibitedWrite = ["nested/forbidden/**"]; });
    await f.edit("author", "ready"); await f.shell("author", "node check.mjs");
    const path = mode === "outside-index" ? "outside.txt" : "nested/forbidden/file.txt";
    await mkdir(join(f.directory, "nested/forbidden"), { recursive: true }); await writeFile(join(f.directory, path), "forbidden");
    if (mode !== "prohibited-add") await exec("git", ["add", path], { cwd: f.directory });
    const indexBefore = (await exec("git", ["diff", "--cached", "--name-only"], { cwd: f.directory })).stdout;
    if (mode !== "prohibited-add") await assert.rejects(f.before("author", "shell", { command: "git commit -m forbidden" }),
      mode === "outside-index" ? /cached/ : /mission-explicit-write-prohibition/);
    await assert.rejects(f.before("author", "shell", { command: `git add result.txt${mode === "prohibited-add" ? ` ${path}` : ""} && git commit -m forbidden` }),
      mode === "outside-index" ? /cached/ : /mission-explicit-write-prohibition/);
    assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: f.directory })).stdout, indexBefore, "denied preflight leaves the actual index unchanged");
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

async function correctionReady(f: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await f.tool("root", "repair_review");
  const dispatch = await f.before("root", "subagent", f.task(prepared.task));
  await f.prompt("author", dispatch.input.prompt); await f.bind("author");
  await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
  await f.shell("author", "node check.mjs");
  await f.finish(dispatch, "author", "CORRECTION_READY\nAll retained findings corrected and declared checks/commit passed.");
}

const inlineReport = (unresolved: string[] = [], residual: unknown = null, candidate = "current-validated") =>
  `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate, unresolved_findings: unresolved, residual_major: residual })}\nCompared every original requirement, all retained findings, corrected source and relevant impact against actual fresh formal checks and clean commit.`;

for (const mode of ["missing-add", "failed-commit"] as const) test(`failed native correction after actual add then commit failure cannot produce receipt: ${mode}`, async () => {
  const f = await fixture();
  try {
    await initial(f, { write: ["result.txt", "missing.txt"] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "node check.mjs");
    const evidenceBefore = structuredClone((await f.run()).units[0]!.reviewerCorrection!.checks);
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout;
    if (mode === "failed-commit") {
      const hook = join(f.directory, ".git/hooks/pre-commit");
      await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
    }
    await f.shell("author", `git add ${mode === "missing-add" ? "missing.txt" : "result.txt"} && git commit -m failed-chain`);
    const native = f.history.author!.at(-1)!.content[0];
    assert.notEqual(native.state.metadata.exit, 0, "real Git failure is recorded, not prospective success");
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout, headBefore);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, evidenceBefore, "Git preflight never manufactures formal evidence");
    f.terminal("author", "Requested Git delivery failed", true);
    await f.after(dispatch, "Requested Git delivery failed", { sessionID: "author", status: "failed" }, "error");
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
    await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|required|incomplete/);
    assert.equal((await f.ledger()).state.consumed_units, 2, "failed correction settles once");
  } finally { await f.dispose(); }
});

for (const mode of ["foreground", "background-cold", "synthetic-notification", "medium", "major", "missing", "PASS", "old-report", "nonterminal", "old-terminal", "failed-check", "edited-after-check", "native-failed", "missing-prompt", "later-prompt"] as const) {
  test(`inline correction native self-recheck: ${mode}`, async () => {
    const f = await fixture();
    try {
      const previous = await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
      const prepared = await f.tool("root", "repair_review");
      assert.match((await f.run()).units[0]!.unit.objective, /in this Task/);
      assert.match((await f.run()).units[0]!.unit.objective, /current-validated/);
      const dispatch = await f.before("root", "subagent", { ...f.task(prepared.task), ...(["background-cold", "missing-prompt"].includes(mode) ? { background: true } : {}) });
      await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      const unit = (await f.run()).units[0]!;
      assert.equal(unit.reviewerCorrection!.promptID, f.history.author!.filter(message => message.type === "user").at(-1)!.id);
      const authorTaskCount = () => f.history.root!.flatMap(message => message.content ?? []).filter(part => part.type === "tool" && part.name === "subagent" && part.state.input.sessionID === "author").length;
      if (mode === "missing-prompt") await f.after(dispatch, "Native Job running", { sessionID: "author", status: "running" });
      if (mode === "background-cold") {
        await f.after(dispatch, "Native Job running", { sessionID: "author", status: "running" });
        await f.start();
        await f.bind("author"); // Existing cold binding recovery, not a new Task or validation.
        assert.equal((await f.run()).units[0]!.reviewerCorrection!.promptID, unit.reviewerCorrection!.promptID);
        assert.equal((await f.ledger()).state.outstanding_reservations.length, 1);
      }
      await f.edit("author", mode === "failed-check" ? "bad-required" : "ready");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m inline-correction");
      await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
      if (mode === "edited-after-check") await f.edit("author", "ready but unvalidated edit");
      if (mode === "missing-prompt") {
        const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE), state = await f.run();
        delete state.units[0]!.reviewerCorrection!.promptID;
        await writeFile(runtime.statePath("root"), JSON.stringify(state));
        await f.start();
      }
      if (mode === "later-prompt") f.history.author!.push({ id: "unowned-later-user", type: "user", text: "Different prompt", time: { created: Date.now() } });
      if (mode === "synthetic-notification") f.history.author!.push({ id: "native-shell-job-completion", type: "synthetic",
        text: "Background command completed (shell ID: diagnostic-shell). Exit code: 0", time: { created: Date.now() } });
      const text = mode === "missing" ? "CORRECTION_READY" : mode === "PASS" ? "PASS" :
        inlineReport(mode === "medium" ? ["Medium: retained output behavior remains broken"] : [],
          mode === "major" ? { reachable_path: "caller retries an unsuccessful transaction", consequence: "persisted state corruption across retries" } : null,
          mode === "old-report" ? previous.mission.review!.source : "current-validated");
      if (mode === "nonterminal" || mode === "old-terminal") {
        if (mode === "nonterminal") f.history.author!.push({ id: "still-tool-calls", type: "assistant", finish: "tool-calls", time: { created: Date.now(), completed: Date.now() }, content: [{ type: "text", text }] });
        await f.after(dispatch, text, { sessionID: "author" });
      } else if (mode === "native-failed") {
        f.terminal("author", text, true); await f.after(dispatch, text, { sessionID: "author", status: "failed" }, "error");
      } else if (mode === "background-cold" || mode === "missing-prompt") {
        f.terminal("author", text); await f.start(); await f.tool("root", "operator_status");
      } else await f.finish(dispatch, "author", text);
      const mission = await f.missions.required("root"), settledRun = await f.run();
      if (["foreground", "background-cold", "synthetic-notification", "medium", "major"].includes(mode)) {
        const proof = mission.review!.selfRecheck!;
        assert(proof, "actual correction terminal records self-recheck without another author Task");
        assert.equal(mission.review!.mode, "self-recheck"); assert.equal(proof.callID, dispatch.id);
        assert.equal(proof.promptID, unit.reviewerCorrection!.promptID); assert.equal(proof.runID, settledRun.runID);
        assert.equal(proof.author, "author"); assert.equal(proof.nativeOutcome, "completed");
        assert.equal(proof.messageID, f.history.author!.filter(message => message.type === "assistant" && message.finish === "stop").at(-1)!.id);
        assert.notEqual(proof.source, previous.mission.review!.source, "HOST binds post-edit source, never the old prompt hash");
        assert.equal(missionReviewIndependent(mission, "author"), false);
        assert.equal(mission.corrections![0]!.selfRecheck!.messageID, proof.messageID);
        if (mode === "medium") {
          await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
          await assert.rejects(f.tool("root", "review_mission", { risk_tags: [] }), /known-findings-require-correction/);
          const retry = await f.tool("root", "repair_review");
          assert.equal(retry.status, "correction-required"); assert.equal(retry.task.task_id, "author");
        } else if (mode === "major") {
          await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
          const second = await f.tool("root", "review_mission", { risk_tags: [] });
          assert.equal(second.status, "review-required"); assert.equal(second.task.task_id, undefined);
        } else {
          await f.start();
          assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-api"] })).status, "review-recorded");
          const acceptance = (await f.tool("root", "operator_status")).acceptance_summary;
          const count = authorTaskCount(), receipt = await f.tool("root", "complete_mission");
          assert.equal(receipt.status, "succeeded"); assert.equal(acceptance.independent_review.independent, false);
          assert.equal(acceptance.independent_review.verdict, "self-rechecked");
          assert.equal(authorTaskCount(), count, "root receipt adds NO second author Task");
          const beforeDuplicate = await f.ledger();
          await f.after(dispatch, text, { sessionID: "author" });
          const ledger = await f.ledger();
          assert.equal(ledger.state.consumed_units, 2); assert.equal(ledger.state.outstanding_reservations.length, 0);
          assert.deepEqual(ledger.records.filter(item => item.event.kind === "unit.settled"), beforeDuplicate.records.filter(item => item.event.kind === "unit.settled"));
          const spend = ledger.records.filter(item => item.event.kind === "unit.settled").at(-1)!.event.cost_usd!;
          assert(Math.abs(spend - (mode === "background-cold" ? 0.0032 : 0.0028)) < 1e-12, "owned correction native requests charged once; no self-recheck round spend");
          assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
          await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-ready\n+changed\n*** End Patch" }), /mission-reviewer-readonly/);
        }
      } else {
        assert.notEqual(mission.review!.verdict, "self-rechecked");
        await assert.rejects(f.tool("root", "complete_mission"), /mission-review|validation|incomplete|unit-validation/);
        if (["missing", "PASS", "old-report", "missing-prompt", "later-prompt"].includes(mode)) {
          assert.equal(settledRun.phase, "awaiting-acceptance", "successful formal unit alone cannot certify missing native self-recheck proof");
          const fallback = await f.tool("root", "review_mission", { risk_tags: [] });
          assert.equal(fallback.status, "self-recheck-required"); assert.equal(fallback.task.task_id, "author");
        }
      }
    } finally { await f.dispose(); }
  });
}

async function selfRecheck(f: Awaited<ReturnType<typeof fixture>>, residual: unknown = null, unresolved: string[] = []) {
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

test("native residual concrete Major alone triggers second Review; newer findings return to original correction owner", async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, { reachable_path: "caller consumes ready output after a failed transaction", consequence: "persisted state can be corrupted across transactions" });
    await f.finish(self.dispatch, "author", self.text);
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
    assert.match((await f.tool("root", "operator_status")).next_action, /DIFFERENT Reviewer/);
    const second = await f.tool("root", "review_mission", { risk_tags: [] });
    assert.equal(second.status, "review-required");
    const dispatch = await f.before("root", "subagent", f.task(second.task));
    assert.equal(dispatch.input.sessionID, undefined);
    assert.match(dispatch.input.prompt, /residual_major:.*persisted state/);
    assert.match(dispatch.input.prompt, /author_self_recheck:/);
    await f.prompt("final", dispatch.input.prompt);
    await f.finish(dispatch, "final", "FINDINGS\nMedium: ready output has a newly detected concrete formatting defect; fix result.txt.");
    const newCorrection = await f.tool("root", "repair_review");
    assert.equal(newCorrection.status, "correction-required", "new generation is not the old settled idempotent Task");
    assert.equal(newCorrection.task.task_id, "author", "second-side finding returns to the ORIGINAL correction owner, not second Reviewer");
    assert.equal((await f.missions.required("root")).corrections!.length, 2);
  } finally { await f.dispose(); }
});

test("concrete residual Major independent PASS can accept after current native self-recheck", async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, { reachable_path: "failed public transaction retry", consequence: "wide contract break for callers" });
    await f.finish(self.dispatch, "author", self.text);
    const second = await f.tool("root", "review_mission", { risk_tags: [] });
    const dispatch = await f.before("root", "subagent", f.task(second.task));
    await f.prompt("final", dispatch.input.prompt); await f.finish(dispatch, "final", "PASS\nRelevant retry state inspected: no remaining concrete defect.");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal(missionReviewIndependent(await f.missions.required("root"), "final"), true);
  } finally { await f.dispose(); }
});

for (const mode of ["medium", "absent", "stale", "stale-report", "nonterminal", "tag-only", "old-terminal", "failed", "cancelled"] as const) test(`native self-recheck rejects ${mode} without independent approval`, async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, mode === "tag-only" ? "public-api" : null,
      mode === "medium" ? ["Medium: ready output still violates a required behavior"] : []);
    if (mode === "stale") await writeFile(join(f.directory, "result.txt"), "changed after self-recheck admission\n");
    if (mode === "nonterminal" || mode === "old-terminal") {
      if (mode === "nonterminal") f.history.author!.push({ id: "unfinished", type: "assistant", finish: "tool-calls", content: [{ type: "text", text: self.text }], time: { created: Date.now(), completed: Date.now() } });
      await f.after(self.dispatch, self.text, { sessionID: "author" });
    } else if (mode === "failed" || mode === "cancelled") {
      f.terminal("author", self.text, true);
      if (mode === "cancelled") f.agents.author!.outcome = "interrupted";
      await f.after(self.dispatch, self.text, { sessionID: "author", status: mode });
    } else if (mode === "stale") {
      await assert.rejects(f.finish(self.dispatch, "author", self.text), /mission-review-correction-validation-stale/);
    } else await f.finish(self.dispatch, "author", mode === "absent" ? "CORRECTION_READY\nFixed" : mode === "stale-report" ? self.text.replace(self.candidate, "old-candidate") : self.text);
    const mission = await f.missions.required("root");
    assert.notEqual(mission.review!.verdict, "self-rechecked");
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review|validation-stale/);
    if (mode === "medium") {
      assert.match((await f.tool("root", "operator_status")).next_action, /known Major\/Medium|Known Major\/Medium/);
      await assert.rejects(f.tool("root", "review_mission", { risk_tags: ["public-api"] }), /known-findings-require-correction/);
      assert.equal((await f.tool("root", "repair_review")).task.task_id, "author");
    }
  } finally { await f.dispose(); }
});

test("native Reviewer gets verbatim full original request outside source excerpts", async () => {
  const f = await fixture();
  try {
    const original = "  Original task and acceptance constraints\r\n" + "Preserve unchanged requirement text. ".repeat(800) + "\nEND original  ";
    await initial(f, { original });
    const prompt = f.history.author!.find(message => message.type === "user")!.text;
    assert(prompt.includes(original));
    assert.match(prompt, /Verbatim original user requests \(complete, outside the source-excerpt budget/);
    assert.match(prompt, /Major AND Medium/);
  } finally { await f.dispose(); }
});

for (const residual of [false, true]) test(`evidence refresh ${residual ? "invalidates old Major report" : "after acceptance is presentation only"} stays in the SAME author`, async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, residual ? { reachable_path: "failed transaction retry", consequence: "state corruption" } : null);
    await f.finish(self.dispatch, "author", self.text);
    const before = await f.run(), prior = (await f.missions.required("root")).review!;
    const refreshed = await f.tool("root", "review_mission", { risk_tags: ["public-api"], evidence: [{ path: "result.txt", offset: 1, limit: 1 }] });
    if (!residual) {
      assert.equal(refreshed.status, "review-recorded", "unchanged candidate/semantics need no extra author Task for optional presentation");
      assert.deepEqual((await f.missions.required("root")).review, prior, "accepted source/evidence pin remains unchanged");
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      return;
    }
    assert.equal(refreshed.status, "self-recheck-required");
    assert.equal(refreshed.task.task_id, "author", "excerpt/hash changes cannot purchase a second Reviewer");
    assert.equal((await f.missions.required("root")).review!.mode, "self-recheck");
    assert.notEqual((await f.missions.required("root")).review!.source, prior.source);
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
    const dispatch = await f.before("root", "subagent", f.task(refreshed.task));
    await f.prompt("author", dispatch.input.prompt);
    await f.after(dispatch, self.text, { sessionID: "author" }); // Older terminal cannot certify this prompt.
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
    const retry = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
    assert.equal(retry.status, "self-recheck-required");
    assert.equal(retry.task.task_id, "author");
    const final = await f.before("root", "subagent", f.task(retry.task));
    await f.prompt("author", final.input.prompt);
    const candidate = (await f.missions.required("root")).review!.source;
    await f.finish(final, "author", `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate, unresolved_findings: [], residual_major: null })}\nCompared refreshed evidence, original requirements and corrected findings with the same actual checks.`);
    assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-api"] })).status, "review-recorded", "omitting evidence retains its current pin");
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, before.units[0]!.reviewerCorrection!.checks, "read-only refresh reruns no unchanged check");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false);
  } finally { await f.dispose(); }
});

for (const effect of ["allow", "ask"] as const) test(`native correction dispatch admits wildcard deny then original-target ${effect} without alias grants`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const rules: Rule[] = [{ action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "dog-reviewer-v010", effect }];
    f.agents.root!.permissions = rules;
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    assert.equal(dispatch.input.agent, "dog-reviewer-v010");
    assert.equal(await f.permission("root", "subagent", dispatch.input.agent), effect);
    await f.prompt("author", dispatch.input.prompt);
    assert.match(f.agents.author!.agent, /^dog-reviewer-correction-/);
    assert.equal(await f.permission("root", "subagent", f.agents.author!.agent), "deny", "native alias would be denied before evaluate, so it is NEVER the dispatch target");
    assert.deepEqual(f.agents.root!.permissions, rules);
    assert.equal(f.registry()["dog-operator"]!.permissions.some((rule: Rule) => rule.resource.startsWith("dog-reviewer-correction-")), false);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const mode of ["validation", "native"] as const) test(`terminal ${mode} correction failure continues the SAME author in a fresh exact admission`, async () => {
  const f = await fixture();
  try {
    await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
    f.agents.author!.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" };
    const prepared = await f.tool("root", "repair_review");
    const failed = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", failed.input.prompt); await f.bind("author");
    await f.edit("author", "bad-required");
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m failed-correction");
    await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
    if (mode === "native") {
      f.terminal("author", "Native correction failed", true);
      await f.after(failed, "Native correction failed", { sessionID: "author", status: "failed" }, "error");
    } else await f.finish(failed, "author", "CORRECTION_READY");
    const failedRun = await f.run(), failedMission = await f.missions.required("root"), failedLedger = await f.ledger();
    assert.equal(failedRun.phase, "awaiting-decision");
    assert.equal(failedMission.corrections![0]!.status, "failed");
    assert.match((await f.tool("root", "operator_status")).next_action, /repair_review.*SAME original Reviewer/);
    await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|required|incomplete/);
    const raw = missionPlan(failedMission, [{ title: "Wrong fresh repair", objective: "Fix own regression", write: ["result.txt"], validation: ["node required-test.mjs", "node check.mjs"] }], f.directory);
    await assert.rejects(new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE).replanMission("root", failedRun.runID, raw), /correction-owner-continuation-required/);
    const replan = await f.tool("root", "plan_units", { units: raw.units, reason: "Fix validation failure" });
    assert.equal(replan.status, "correction-owner-continuation-required"); assert.equal(replan.task, undefined);
    await f.start();
    const nativeOutcome = f.agents.author!.outcome;
    delete f.agents.author!.outcome;
    await assert.rejects(f.tool("root", "repair_review"), /reviewer-not-terminal/);
    assert.equal((await f.run()).runID, failedRun.runID);
    f.agents.author!.outcome = nativeOutcome;
    const recovered = await f.tool("root", "repair_review");
    assert.equal(recovered.status, "correction-required"); assert.equal(recovered.task.task_id, "author");
    assert.notEqual((await f.run()).runID, failedRun.runID);
    assert.deepEqual((await f.run()).acceptance, failedRun.acceptance);
    assert.deepEqual((await f.run()).units[0]!.unit.validation, failedRun.units[0]!.unit.validation);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "prior failed logs are not current evidence");
    assert.equal((await f.missions.required("root")).corrections![1]!.findings, failedMission.corrections![0]!.findings);
    assert.deepEqual((await f.tool("root", "repair_review")).task, recovered.task);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    const retry = await f.before("root", "subagent", f.task(recovered.task));
    await f.prompt("author", retry.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m recovered-correction");
    await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
    await f.finish(retry, "author", "CORRECTION_READY");
    await f.after(retry, "Duplicate terminal", { sessionID: "author" });
    const ledger = await f.ledger(), status = await f.tool("root", "operator_status");
    assert.equal(ledger.state.consumed_units, 3); assert.equal(ledger.state.outstanding_reservations.length, 0);
    const settlements = ledger.records.map(record => record.event).filter(event => event.kind === "unit.settled");
    assert.equal(settlements.length, 3); assert.equal(settlements[1]!.disposition, "failed");
    assert.equal(settlements[2]!.disposition, "succeeded");
    assert(Math.abs(settlements[2]!.cost_usd! - 0.0028) < 1e-12, "new admission charges its seven native requests only, not old review/failed correction history");
    const priorCost = failedLedger.records.map(record => record.event).filter(event => event.kind === "unit.settled")
      .reduce((total, event) => total + (event.cost_usd ?? 0), 0);
    assert(Math.abs(status.budget.settled_cost_usd - priorCost - 0.0028) < 1e-12);
    assert.deepEqual(f.agents.author!.model, { providerID: "openai", id: "gpt-6.1-sol", variant: "high" });
    assert.equal((await f.missions.required("root")).corrections!.length, 2);
    const self = await selfRecheck(f); await f.finish(self.dispatch, "author", self.text);
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

test("declared composite validation is atomic before chain decomposition", () => {
  const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
  assert.deepEqual(canonicalDeclaredValidationMembers(C, new Set([C, A, B])), [C]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, new Set([C])), [C, C]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${A}`, new Set([C, A])), [C, A]);
  assert.equal(canonicalDeclaredValidationMembers(A, new Set([C])), undefined);
  assert.equal(canonicalDeclaredValidationMembers(`${C} && printf x > undeclared.txt`, [C]), undefined);
  assert.equal(canonicalDeclaredValidationMembers(`${C}; printf x > result.txt`, [C]), undefined);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [A, B, C]), [A, B, C]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [C, A, B]), [C, A, B]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [A, B, A, B]), [A, B, A, B]);
  assert.deepEqual(canonicalDeclaredValidationMembers(C, [A, B, C]), [C], "exact WHOLE declaration wins before occurrence-aware coalescing");
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [A, B, C], 2), [C, A, B], "current occurrence, not longest Set match");
});

for (const order of ["A,B,C", "C,A,B", "A,B,A,B", "C,C", "A,B,C,A,B,C"] as const) for (const failed of [false, true]) {
  test(`mixed coalesced validation ${order} ${failed ? "failed chain" : "success"} binds execution/history identically`, async () => {
    const f = await fixture();
    try {
      const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
      const map = { A, B, C }, validation = order.split(",").map(key => map[key as keyof typeof map]);
      await initial(f, { validation });
      const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      await f.edit("author", failed ? "bad-required" : "ready");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m ordered-composite");
      await f.shell("author", validation.join(" && "));
      const check = (await f.run()).units[0]!.reviewerCorrection!.checks!.at(-1)!;
      assert.deepEqual(check.command, validation); assert.equal(check.dispatchCallID, dispatch.id);
      assert.equal(check.exitCode, failed ? 1 : 0);
      await f.finish(dispatch, "author", inlineReport());
      assert.equal((await f.missions.required("root")).corrections![0]!.status, failed ? "failed" : "ready");
      if (failed) await assert.rejects(f.tool("root", "complete_mission"), /validation|incomplete/);
      else assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    } finally { await f.dispose(); }
  });
}

test("ordered mixed composite uses progress from preceding actual calls and retains call/member/occurrence binding", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
    await initial(f, { validation: [A, B, C] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m occurrence-position");
    await f.shell("author", A);
    await f.shell("author", `${B} && ${C}`);
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
    assert.deepEqual(checks.map(check => check.command), [[A], [B, C]]);
    assert.notEqual(checks[0]!.callID, checks[1]!.callID);
    const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE), state = await f.run();
    state.units[0]!.reviewerCorrection!.checks![1]!.command = [C, B];
    await writeFile(runtime.statePath("root"), JSON.stringify(state));
    await f.start();
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed", "different saved call-member decomposition cannot certify actual history");
  } finally { await f.dispose(); }
});

test("semicolon declaration uses independent native parsed resources, one atomic formal check, and unchanged explicit deny/ask", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A}; ${B}`;
    await initial(f, { validation: [C] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m semicolon-declaration");
    for (const effect of ["deny", "ask"] as const) {
      f.agents.author!.permissions = [{ action: "shell", resource: B, effect }];
      assert.equal(await f.permission("author", "shell", [A, B]), effect);
      if (effect === "deny") await assert.rejects(f.before("author", "shell", { command: C }), /native permission denied shell/);
    }
    delete f.agents.author!.permissions;
    await f.shell("author", A); await f.shell("author", B);
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "standalone resources are diagnostics, not the composite declaration");
    await f.shell("author", C);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks!.map(check => check.command), [[C]]);
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

for (const effect of ["allow", "ask", "deny"] as const) test(`native configured order: historical wildcard deny then Reviewer-specific ${effect}, including cold reload`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    f.globalRules.push({ action: "shell", resource: "*", effect: "deny" });
    f.agentRules["dog-reviewer-v010"] = [{ action: "shell", resource: "node check.mjs", effect },
      ...(effect === "deny" ? [{ action: "shell", resource: "node check.mjs", effect: "allow" as const }, { action: "shell", resource: "node check.mjs", effect }] : [])];
    await f.start();
    const original = evaluate("shell", "node check.mjs", f.registry()["dog-reviewer-v010"]!.permissions).effect;
    const workerOriginal = evaluate("shell", "node check.mjs", f.registry()["dog-worker-v010"]!.permissions).effect;
    assert.equal(original, effect);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    for (const cold of [false, true]) {
      if (cold) await f.start();
      assert.equal(await f.permission("author", "shell", "node check.mjs"), original);
      assert.equal(await f.permission("author", "shell", "node required-test.mjs"), "deny");
      assert.equal(f.registry()["dog-reviewer-v010"]!.permissions.some((rule: Rule) => rule.action === "edit" && rule.effect === "deny"), true);
      assert.equal(await f.permission("worker", "shell", "node check.mjs"), workerOriginal, "unrelated Worker registry is unchanged");
      if (effect === "deny") await assert.rejects(f.before("author", "shell", { command: "node check.mjs" }), /native permission denied shell/);
      else await f.before("author", "shell", { command: "node check.mjs" });
    }
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("correction execution permits focused tests/formatter/generator; formal proof and known output/prohibition gates remain", async () => {
  const f = await fixture();
  try {
    await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
    await f.missions.update("root", state => { state.prohibitedWrite = ["check.mjs"]; });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    for (const command of ["go test ./vm -run '^TestTypedBindings$' -count=1", "gofmt -w result.txt", "node generate.mjs", "node format.mjs"]) {
      const event = await f.before("author", "shell", { command });
      await f.after(event, "Focused diagnostic/formatter admitted under native policy", { exit: 0 });
    }
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "focused execution NEVER substitutes for formal inherited checks");
    await f.shell("author", "node generate.mjs"); await f.shell("author", "node format.mjs");
    await f.shell("author", "printf 'ready\\n' > result.txt");
    await assert.rejects(f.before("author", "shell", { command: "printf x > check.mjs" }), /mission-explicit-write-prohibition/);
    const output = await f.before("author", "shell", { command: "printf x > outside.txt" });
    assert.ok((await f.run()).units[0]!.reviewerCorrection!.writeUnion.includes("outside.txt"));
    await f.after(output, "Literal output reconciled without executing or creating formal evidence", { exit: 0 });
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined);
    await assert.rejects(f.before("author", "shell", { command: "printf x > ../outside.txt" }), /repository-relative path without traversal/);
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m diagnostics-then-formal");
    await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal(whollyDisabled("shell", f.registry()["dog-reviewer-v010"]!.permissions), true, "ordinary Reviewer snapshot stays read-only after restoration");
  } finally { await f.dispose(); }
});

for (const effect of ["allow", "ask", "deny"] as const) test(`correction shell sink keeps native ${effect}, Reviewer read-only and real output prohibitions`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const sink = process.platform === "win32" ? "NUL" : "/dev/null";
    const command = `printf diagnostic 2>${sink}`;
    await assert.rejects(f.before("author", "shell", { command }), /mission-reviewer-readonly/);
    f.agentRules["dog-reviewer-v010"] = [{ action: "shell", resource: command, effect }];
    await f.start();
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    assert.equal(await f.permission("author", "shell", command), effect, "sink classification never grants native allow over ask/deny");
    if (effect === "deny") await assert.rejects(f.before("author", "shell", { command }), /native permission denied shell/);
    else await f.shell("author", command);
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "a sink diagnostic is not inherited formal proof");
    await f.missions.update("root", state => { state.prohibitedWrite = ["result.txt"]; });
    await assert.rejects(f.before("author", "shell", { command: `printf forbidden > result.txt 2>${sink}` }), /mission-explicit-write-prohibition/);
    assert.equal(await readFile(join(f.directory, "result.txt"), "utf8"), "wrong\n");
    await assert.rejects(f.tool("root", "complete_mission"), /incomplete|validation/);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const absolute of [false, true]) for (const declared of [false, true]) test(`correction known outputs use native ${absolute ? "absolute" : "relative"} shell workdir for prohibitions and write union: ${declared ? "declared text in other cwd" : "diagnostic"}`, async () => {
  const f = await fixture();
  try {
    const command = declared ? "node generate.mjs > result.txt" : "printf overwritten > result.txt";
    await initial(f, declared ? { validation: [command, "node check.mjs"] } : {});
    await mkdir(join(f.directory, "nested"));
    await writeFile(join(f.directory, "nested", "result.txt"), "protected nested output\n");
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    const input = { command, workdir: absolute ? join(f.directory, "nested") : "nested" };
    const reconciled = await f.before("author", "shell", input);
    assert.ok((await f.run()).units[0]!.reviewerCorrection!.writeUnion.includes("nested/result.txt"),
      "reconcile the actual native nested destination, not the same-named root file");
    await f.after(reconciled, "Correct directory observed; output not actually executed", { exit: 0 });
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined,
      "matching command text in a different cwd is still not inherited formal proof");
    await f.missions.update("root", state => { state.prohibitedWrite = ["nested/result.txt"]; });
    await assert.rejects(f.before("author", "shell", input), /mission-explicit-write-prohibition/,
      "prohibition checks inspect the same destination native shell would write");
    assert.equal(await readFile(join(f.directory, "nested", "result.txt"), "utf8"), "protected nested output\n");
    const scoped = await f.before("author", "shell", { command: "printf 'ready\\n' > result.txt", workdir: f.directory });
    await exec("bash", ["-c", scoped.input.command], { cwd: scoped.input.workdir });
    await f.after(scoped, "Known root output executed", { exit: 0 });
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "diagnostic writes are not formal check evidence");
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const mode of ["wrong-only", "diagnostic-before", "diagnostic-after"] as const) test(`correction formal proof binds native check directory: ${mode}`, async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
    const validation = [A, B, C];
    await initial(f, { validation });
    const other = join(f.directory, ".cache", "other");
    await mkdir(other, { recursive: true });
    for (const name of ["required-test.mjs", "check.mjs"]) await writeFile(join(other, name), await readFile(join(f.directory, name)));
    await writeFile(join(other, "result.txt"), "ready\n");
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", mode === "wrong-only" ? "bad-required" : "ready");
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m directory-binding");
    let diagnostic = 0;
    const elsewhere = async (command: string) => {
      const event = await f.before("author", "shell", { command, workdir: diagnostic++ % 2 ? other : ".cache/other" });
      const result = await exec("bash", ["-c", event.input.command], { cwd: resolve(f.directory, event.input.workdir) })
        .catch(error => ({ stdout: error.stdout, code: error.code }));
      await f.after(event, result.stdout, { exit: "code" in result ? result.code : 0 });
    };
    if (mode === "wrong-only") {
      for (const command of validation) await elsewhere(command);
      assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined,
        "checks of another directory never acquire the root candidate binding");
    } else {
      await f.shell("author", A);
      if (mode === "diagnostic-before") await elsewhere(`${B} && ${C}`);
      const formal = await f.before("author", "shell", { command: `${B} && ${C}`, workdir: mode === "diagnostic-after" ? f.directory : "." });
      const output = await exec("bash", ["-c", formal.input.command], { cwd: resolve(f.directory, formal.input.workdir) });
      await f.after(formal, output.stdout, { exit: 0 });
      if (mode === "diagnostic-after") {
        await writeFile(join(other, "result.txt"), "bad-required\n");
        for (const command of validation) await elsewhere(command);
      }
      assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks!.map(check => check.command), [[A], [B, C]],
        "other-directory diagnostics do not alter ordered formal progress or call-member bindings");
    }
    await f.finish(dispatch, "author", inlineReport());
    if (mode === "wrong-only") {
      assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
      await assert.rejects(f.tool("root", "complete_mission"), /validation|incomplete/);
      const summary = (await f.tool("root", "operator_status")).acceptance_summary.native_declared_validation.find((item: ObjectValue) => !item.historical);
      assert.deepEqual(summary.observations.not_observed, validation);
    } else assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

test("atomic composite shell admission preserves native parsed-member and whole-command deny/ask", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
    await initial(f, { validation: [C] });
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    for (const resource of [A, C]) for (const effect of ["deny", "ask"] as const) {
      f.agents.author!.permissions = [{ action: "shell", resource, effect }];
      assert.equal(await f.permission("author", "shell", resource), effect, "real configured rule keeps its native effect");
      if (effect === "deny" && resource === A) await assert.rejects(f.before("author", "shell", { command: C }), /native permission denied shell/);
      else {
        const shell = await f.before("author", "shell", { command: C });
        assert.equal(await f.permission("author", "shell", [A, B], false, shell.id), resource === A ? effect : "allow", "ACTUAL parsed resources, not invented whole-command projection");
      }
    }
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const failed of [false, true]) test(`native exact composite required check ${failed ? "failure" : "success"} retains one atomic call binding`, async () => {
  const f = await fixture();
  try {
    const C = "node required-test.mjs && node check.mjs";
    await initial(f, { validation: [C, C] });
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", failed ? "bad-required" : "ready");
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m composite-correction");
    await f.shell("author", "node required-test.mjs"); // Diagnostic, never partial composite proof.
    await f.shell("author", C); await f.shell("author", C);
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
    assert.equal(checks.length, 2);
    assert(checks.every(check => JSON.stringify(check.command) === JSON.stringify([C])));
    assert.notEqual(checks[0]!.callID, checks[1]!.callID);
    assert(checks.every(check => check.dispatchCallID === dispatch.id && check.exitCode === (failed ? 1 : 0)));
    await f.finish(dispatch, "author", "CORRECTION_READY");
    assert.equal((await f.missions.required("root")).corrections![0]!.status, failed ? "failed" : "ready");
    if (failed) await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|incomplete/);
    else {
      const self = await selfRecheck(f); await f.finish(self.dispatch, "author", self.text);
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    }
  } finally { await f.dispose(); }
});

for (const mode of ["foreground", "background-restart", "failure", "self-review"] as const) {
  test(`native Reviewer correction lifecycle: ${mode}`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
      const previous = await initial(f);
      const priorModelSwitches = f.switches.length;
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: other\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
      const prepared = await f.tool("root", "repair_review");
      assert.equal(prepared.task.task_id, "author"); assert.equal(prepared.task.subagent_type, "dog-reviewer-v010");
      assert.deepEqual((await f.run()).acceptance, previous.run.acceptance);
      assert.deepEqual((await f.run()).acceptanceProof, previous.run.acceptanceProof);
      assert.deepEqual((await f.run()).sourceRefs, previous.run.sourceRefs);
      const declaration = (run: ObjectValue) => /^goal_declaration_path: (.+)$/mu.exec(run.units[0].task.prompt)![1]!;
      assert.equal(await readFile(declaration(await f.run()), "utf8"), await readFile(declaration(previous.run), "utf8"));
      assert.deepEqual((await f.run()).units[0]!.unit.write, previous.run.units[0]!.unit.write);
      assert.deepEqual((await f.run()).units[0]!.unit.validation, previous.run.units[0]!.unit.validation);
      assert.deepEqual((await f.tool("root", "repair_review")).task, prepared.task, "prepare is idempotent, not another unit/model run");
      const correction = await f.before("root", "subagent", { ...f.task(prepared.task), ...(mode === "background-restart" ? { background: true } : {}) });
       assert.equal(correction.input.sessionID, "author"); assert.equal(correction.input.agent, "dog-reviewer-v010");
      assert.equal((await f.tool("root", "operator_status")).budget.reserved_units, 1);
      await f.prompt("author", correction.input.prompt);
      if (mode === "background-restart") {
        await f.after(correction, "Native Job running", { sessionID: "author", status: "running" });
        const ack = { text: "⚠️ **INTERRUPTED** — launch returned\nTRUE_INTERRUPTION: internal: background acknowledgement" };
        await f.hooks()["experimental.text.complete"]!({ sessionID: "root", messageID: "ack" }, ack);
        assert.doesNotMatch(ack.text, /INTERRUPTED/);
        assert.equal((await f.ledger()).state.receipt, null, "background ack cannot create a Mission receipt");
        await f.start();
        assert.equal((await f.tool("root", "operator_status")).budget.reserved_units, 1);
      }
      await f.bind("author");
       assert.match(f.agents.author!.agent, /^dog-reviewer-correction-v010-/);
      assert.equal(f.switches.filter(input => "agent" in input).length, 1, "only the same author's scoped profile is selected, never Worker");
      assert.equal(f.switches.filter(input => "model" in input).length, priorModelSwitches, "same-child correction retains the native Sol model and variant too");
      const grants = f.rules.at(-1)!.permissions;
       assert.equal(evaluate("edit", "result.txt", grants).effect, "allow", "existing implementation defaults, not generated scope grants");
       assert.equal(grants.some((rule: ObjectValue) => rule.action === "shell" && rule.effect === "deny"), false, "only shipped shell role deny removed");
      const context = { sessionID: "author", agent: f.agents.author!.agent, tools: Object.fromEntries(["read", "patch", "write", "shell",
        "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "sortie_v010_review_mission"].filter(name =>
          !whollyDisabled(["patch", "write"].includes(name) ? "edit" : name,
            [...f.registry()[f.agents.author!.agent]!.permissions, ...(f.agents.author!.permissions ?? [])]))
        .map(name => [name, { description: name, input: {} }])), system: [] };
      await f.context(context);
      assert.deepEqual(Object.keys(context.tools).sort(), ["patch", "read", "shell", "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "write"].sort());
      const scopeBefore = await f.tool("root", "operator_status");
      assert.equal(evaluate("sortie_v010_expand_unit", "*", grants).effect, "allow",
        "admitted correction exposes the same existing scope-repair control as Worker");
      const expanded = await f.tool("author", "expand_unit", { unit_id: (await f.run()).units[0]!.unit.id,
        paths: ["generated-regression.txt"], reason: "Necessary in-request regression output discovered during correction" });
      assert.equal(expanded.status, "scope-updated");
      assert.equal(expanded.child_session_id, "author", "scope update retains the original Reviewer session");
      assert.deepEqual((await f.tool("root", "operator_status")).budget, scopeBefore.budget,
        "scope correction neither redispatches nor reserves another unit");
      await f.missions.update("root", mission => { mission.prohibitedWrite = ["undeclared.txt"]; });
      await assert.rejects(f.tool("author", "expand_unit", { unit_id: (await f.run()).units[0]!.unit.id,
        paths: ["undeclared.txt"], reason: "Explicit prohibition is not an estimate" }), /mission-explicit-write-prohibition/);
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: undeclared.txt\n+x\n*** End Patch" }), /mission-explicit-write-prohibition/);
       await assert.rejects(f.before("author", "shell", { command: "printf x > undeclared.txt" }), /mission-explicit-write-prohibition/);
       const knownWrite = await f.before("author", "shell", { command: "printf x > result.txt" });
       await f.after(knownWrite, "Known scoped diagnostic allowed", { exit: 0 });
      await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      await f.shell("author", "node check.mjs", mode === "failure" ? 1 : 0);
      if (mode === "background-restart") {
        f.terminal("author", "CORRECTION_READY\nFixed the retained finding and ran its exact validation.");
        await f.tool("root", "operator_status");
      } else await f.finish(correction, "author", "CORRECTION_READY\nFixed the retained finding and ran its exact validation.");
      const corrected = await f.missions.required("root"), status = await f.tool("root", "operator_status");
      assert.equal(status.budget.reserved_units, 0); assert.equal(status.budget.consumed_units, 2);
      assert.deepEqual(f.agents.author!.permissions, undefined, "native session rules are never changed");
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010", "terminal restores Reviewer immediately");
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
       assert(Math.abs(status.budget.settled_cost_usd - 0.0056) < 1e-12, "initial Worker and eight correction requests are each priced exactly once");
      const settled = (await f.ledger()).records.map(record => record.event).filter(event => event.kind === "unit.settled");
      assert.equal(settled.length, 2);
      const correctionSettlement = settled.find(event => event.native_session_id === "author")!;
       assert(Math.abs(correctionSettlement.cost_usd! - 0.0032) < 1e-12, "same-child review history is excluded from correction spend; scope repair is priced once");
      assert(correctionSettlement.native_started_at);
      assert.equal(corrected.corrections![0]!.author, "author");
      assert.equal(corrected.corrections![0]!.status, mode === "failure" ? "failed" : "ready");
      assert.equal(corrected.review!.verdict, "findings", "correction is NEVER a self PASS");
      await assert.rejects(f.tool("root", "complete_mission"), /mission-review|required|incomplete/);
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-ready\n+wrong\n*** End Patch" }), /mission-reviewer-readonly/);
      if (mode === "failure") return;
      await f.start();
      const finalReview = await f.tool("root", "review_mission", { risk_tags: [] });
       assert.equal(finalReview.status, "self-recheck-required", "correction cannot low-risk skip explicit self-recheck");
       const finalDispatch = await f.before("root", "subagent", { ...f.task(finalReview.task), ...(mode === "background-restart" ? { background: true } : {}) });
       assert.equal(finalDispatch.input.sessionID, "author", "explicit self-recheck continues the SAME native child");
       const readonlyContext = { sessionID: "author", agent: f.agents.author!.agent, system: [], tools: { read: {}, grep: {}, patch: {}, shell: {} } };
       await f.context(readonlyContext);
       assert.deepEqual(Object.keys(readonlyContext.tools).sort(), ["grep", "read"]);
       assert.match(JSON.stringify(readonlyContext.system), /Native tools actually available in this request: grep, read/);
       assert.match(finalDispatch.input.prompt, /review_phase: verification/);
       assert.match(finalDispatch.input.prompt, /review_mode: self-recheck/);
       assert(finalDispatch.input.prompt.includes(previous.original), "verbatim original text is directly supplied");
       assert.match(finalDispatch.input.prompt, /prior_findings_ref:/);
       assert.match(finalDispatch.input.prompt, /Changed since correction baseline/);
       await f.prompt("author", finalDispatch.input.prompt);
       if (mode === "self-review") {
        await f.finish(finalDispatch, "author", "PASS\nMy own correction is fine");
        assert.equal((await f.missions.required("root")).review!.verdict, "findings");
        assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false);
        await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
        return;
      }
       const source = (await f.missions.required("root")).review!.source;
       const selfText = `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate: source, unresolved_findings: [], residual_major: null })}\nAll original requirements and three Medium findings compared with correction and actual checks; resolved.`;
       if (mode === "background-restart") {
         await f.after(finalDispatch, "Native self-recheck Job running", { sessionID: "author", status: "running" });
         assert.equal((await f.ledger()).state.receipt, null);
         await f.start();
         f.terminal("author", selfText);
         await f.tool("root", "operator_status");
       } else await f.finish(finalDispatch, "author", selfText);
       const selfchecked = await f.missions.required("root");
       assert.equal(selfchecked.review!.verdict, "self-rechecked");
       assert.equal(missionReviewIndependent(selfchecked, "author"), false);
       assert.equal(f.switches.filter(input => "model" in input).length, priorModelSwitches, "same-author self-recheck never replaces model/variant");
       await f.start();
       assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false, "reload cannot make the author independent");
       assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-logic", "public-api"] })).status, "review-recorded", "tags alone cannot trigger a second Reviewer");
       assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      const completed = await f.missions.required("root");
      assert.deepEqual(completed.requirements, previous.mission.requirements);
      assert.equal(completed.requests[0]!.text, previous.original);
       assert.equal(completed.review!.child, "author"); assert.equal((await f.run()).receipt!.status, "succeeded");
       assert.equal(f.history.final, undefined, "three Medium findings need ZERO second Reviewer children");
      assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.directory })).stdout, "");
      assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: f.directory })).stdout.trim(), "correction");
      assert.equal((await f.tool("root", "operator_status")).budget.consumed_units, 2, "review and receipt cannot spend the correction twice");
    } finally { await f.dispose(); }
  });
}

for (const mode of ["readonly", "stale"] as const) test(`Reviewer correction does not broaden mission semantics: ${mode}`, async () => {
  const f = await fixture();
  try {
    await initial(f, { readonly: mode === "readonly" });
    if (mode === "stale") await writeFile(join(f.directory, "result.txt"), "changed outside review\n");
    await assert.rejects(f.tool("root", "repair_review"), /mission-review-correction-unavailable|mission-review-correction-source-stale/);
    assert.equal((await f.missions.required("root")).corrections, undefined);
    assert.equal(f.rules.length, 0, "ordinary reviews never receive writer permissions");
    assert.equal((await f.tool("root", "operator_status")).budget.consumed_units, 1);
  } finally { await f.dispose(); }
});

for (const skipOperation of [false, true]) test(`operation correction recovers the same Reviewer after reload without repeating execution: ${skipOperation ? "not-started" : "executed"}`, async () => {
  const f = await fixture();
  try {
    const previous = await initial(f, { operation: true, skipOperation });
    await f.start();
    const prepared = await f.tool("root", "repair_review");
    assert.equal(prepared.task.task_id, "author");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    // The admitted operation correction activates normally, without another handoff read.
    await f.edit("author", "ready");
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add -- result.txt");
    await f.shell("author", "git commit -m operation-correction");
    await f.finish(dispatch, "author", 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}\nCompared original requirements and retained findings; corrected records do not imply operation success.');
    const corrected = await f.missions.required("root");
    assert.deepEqual(corrected.execution, previous.mission.execution);
    assert.deepEqual(corrected.requirements, previous.mission.requirements);
    assert.equal(corrected.review!.verdict, "self-rechecked");
    assert.equal(corrected.review!.child, "author");
    assert.equal(missionReviewIndependent(corrected, "author"), false);
    assert.equal(f.history.final, undefined, "no second Reviewer or replacement Worker");
    const status = await f.tool("root", "operator_status");
    assert.equal(status.budget.consumed_units, 2);
    assert.equal(status.budget.reserved_units, 0);
    assert.equal(status.operation.status, skipOperation ? "not-started" : "executed");
    const completed = await f.tool("root", "complete_mission");
    if (skipOperation) {
      assert.equal(completed.status, "not-ready");
      assert.equal(completed.operation_status, "not-started");
      assert.equal((await f.run()).receipt, null, "self-recheck cannot accept an unexecuted operation");
    } else assert.equal(completed.status, "succeeded");
  } finally { await f.dispose(); }
});

test("shipped Reviewer remains read-only and retains Sol/xhigh", () => {
  const asset = runtimeAssets.find(item => item.name === "dog-reviewer-v010")!.content;
  assert.match(asset, /model: openai\/gpt-6\.1-sol#xhigh/);
  assert.match(asset, /edit: deny/); assert.match(asset, /bash: false/);
  assert.match(asset, /CORRECTION_READY/);
  assert.deepEqual(convertedAssetPermissions(asset), nativeReviewerRoleRules, "native role-block projection is grounded in the actual shipped header");
});

test("correction admission cannot bypass an original Reviewer parent-session deny", async () => {
  const f = await fixture();
  try {
    await initial(f);
    f.agents.root!.permissions = [{ action: "subagent", resource: "dog-reviewer-v010", effect: "deny" }];
    const prepared = await f.tool("root", "repair_review");
    await assert.rejects(f.before("root", "subagent", f.task(prepared.task)), /native-reviewer-correction-parent-permission-denied/);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled").length, 2);
  } finally { await f.dispose(); }
});

for (const role of ["dog-operator", "dogs-coordinator"]) test(`original-target native admission uses the actual ${role} caller and last-match semantics`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    assert.equal(dispatch.input.agent, "dog-reviewer-v010", "native admission never asserts the correction alias");
    await f.prompt("author", dispatch.input.prompt);
    const alias = f.agents.author!.agent;
    f.agents.root!.agent = role;
    f.agents.unrelated = { agent: role };
    const rule = (effect: Rule["effect"]): Rule => ({ action: "subagent", resource: "dog-reviewer-v010", effect });
    const wildcard: Rule = { action: "subagent", resource: "*", effect: "deny" };
    for (const permissions of [[rule("deny")], [rule("ask")], [wildcard, rule("allow")], [wildcard, rule("ask")],
      [rule("deny"), rule("allow")], [rule("allow"), rule("ask")], [rule("allow"), wildcard]]) {
      f.agents.root!.permissions = permissions;
      const expected = permissions.at(-1)!.effect;
      assert.equal(await f.permission("root", "subagent", dispatch.input.agent), expected, "configured deny precedes the hook; specific allow/ask survives wildcard deny");
      assert.equal(await f.permission("unrelated", "subagent", dispatch.input.agent), "allow", "no per-session rule leaks into the shared parent role");
      assert.equal(f.registry()[role]!.permissions.some((item: Rule) => item.resource === alias), false, "no shared parent alias grant");
    }
    f.agents.root!.agent = "dog-operator";
    (f.agentRules[role] ??= []).push(rule("deny"));
    await f.start();
    f.agents.root!.agent = role;
    f.agents.root!.permissions = [rule("allow")];
    assert.equal(await f.permission("root", "subagent", dispatch.input.agent), "allow", "later session allow overrides original agent deny");
    assert.equal(await f.permission("unrelated", "subagent", dispatch.input.agent, true), "deny", "configured deny precedes saved allow");
    assert.equal(whollyDisabled("edit", f.registry()["dog-reviewer-v010"]!.permissions), true);
    f.agents.root!.agent = "dog-operator";
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const failure of ["lookup", "switch"] as const) for (const cold of [false, true]) {
  test(`restoration retains recovery identity after ${failure} failure; ${cold ? "cold" : "live"} retry settles once`, async () => {
    const f = await fixture();
    try {
      await initial(f);
      const prepared = await f.tool("root", "repair_review");
      const dispatch = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", dispatch.input.prompt);
      if (failure === "lookup") f.projection.failRestorationLookup = true;
      else f.projection.failRestore = true;
      await assert.rejects(f.tool("root", "cancel_operator", { reason: "explicit-cancellation" }), /native-(?:session-lookup|switch)-transient/);
      assert.match(f.agents.author!.agent, /^dog-reviewer-correction-/);
      assert(f.storage.has("v2-reviewer-correction-permissions:author"));
      f.projection.failRestorationLookup = false;
      const before = (await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled").length;
      if (cold) await f.start();
      await f.tool("root", "operator_status");
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      assert.equal((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled").length, before);
      assert.equal((await f.ledger()).state.consumed_units, 2);
    } finally { await f.dispose(); }
  });
}

test("cold restoration distinguishes native SessionNotFoundError from a transient lookup", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    f.projection.failRestorationLookup = true;
    await assert.rejects(f.tool("root", "cancel_operator", { reason: "explicit-cancellation" }), /native-session-lookup-transient/);
    assert(f.storage.has("v2-reviewer-correction-permissions:author"));
    delete f.agents.author;
    await f.start();
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
  } finally { await f.dispose(); }
});

test("exact correction chains preserve each member's native deny and ask", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs";
    await initial(f, { validation: [A, B] });
    const prepared = await f.tool("root", "repair_review");
    const correction = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", correction.input.prompt); await f.bind("author");
    for (const effect of ["deny", "ask", "allow"] as const) {
      f.agents.author!.permissions = [{ action: "shell", resource: A, effect }];
      assert.equal(await f.permission("author", "shell", [A, B]), effect,
        "actual native parsed resources preserve each configured member effect");
    }
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const mode of ["four", "two", "early-fail", "late-fail", "chain", "failed-chain", "retry"] as const) {
  test(`native correction executes each inherited [A,B,A,B] occurrence: ${mode}`, async () => {
    const f = await fixture();
    try {
      const validation = ["node required-test.mjs", "node check.mjs", "node required-test.mjs", "node check.mjs"];
      await initial(f, { validation });
      const initialValidation = (await f.ledger()).records.filter(({ event }) => event.kind === "validation.admission");
      assert.equal(initialValidation.filter(({ event }) => event.kind === "validation.admission" && event.decision === "ALLOW").length, 2,
        "the original Worker also actually executes/counts both mandatory canonical occurrences");
      assert.equal(initialValidation.some(({ event }) => event.kind === "validation.admission" && event.decision === "SKIP"), false);
      const prepared = await f.tool("root", "repair_review");
      assert.deepEqual((await f.run()).units[0]!.unit.validation, validation, "planning and correction preserve every declared occurrence");
      const correction = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", correction.input.prompt); await f.bind("author"); await f.edit("author", "ready");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      if (mode === "chain" || mode === "failed-chain") {
        await f.shell("author", validation.join(" && "), mode === "failed-chain" ? 1 : 0);
      } else {
        for (const [i, command] of (mode === "two" ? validation.slice(0, 2) : validation).entries()) {
          await f.shell("author", command, mode === "early-fail" && i === 0 || mode === "late-fail" && i === 2 ? 1 : 0);
        }
        if (mode === "retry") for (const command of validation) await f.shell("author", command);
      }
      const checkedRun = await f.run();
      const checks = checkedRun.units[0]!.reviewerCorrection!.checks!;
      assert.equal(checks.length, mode === "two" ? 2 : mode.includes("chain") ? 1 : mode === "retry" ? 8 : 4);
      const validations = (await f.ledger()).records.filter(({ event }) => event.kind === "validation.admission");
      assert(validations.every(({ event }) => event.kind !== "validation.admission" || event.operation_id === undefined ||
        !checks.some(check => check.callID === event.operation_id) || event.decision === "ALLOW"), "mandatory repeats never become SKIP notices");
      await f.finish(correction, "author", "CORRECTION_READY");
      assert.equal((await f.missions.required("root")).corrections![0]!.status, ["four", "chain", "retry"].includes(mode) ? "ready" : "failed");
    } finally { await f.dispose(); }
  });
}

for (const mode of ["hook-edit", "hook-edit-rerun", "scratch-cold", "missing-binding", "generators", "report-edit"] as const) {
  test(`required correction checks retain actual candidate bindings: ${mode}`, async () => {
    const f = await fixture();
    try {
      const validation = mode === "generators" ? ["node generate.mjs", "node format.mjs", "node required-test.mjs", "node check.mjs"]
        : mode === "scratch-cold" ? ["TMPDIR=.cache node required-test.mjs", "TMPDIR=.cache node check.mjs"]
        : ["node required-test.mjs", "node check.mjs"];
      await initial(f, { validation, ...(mode === "report-edit" ? { write: ["result.txt", "reports/**"] } : {}) });
      const prepared = await f.tool("root", "repair_review");
      const correction = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", correction.input.prompt); await f.bind("author"); await f.edit("author", "ready");
      for (const command of validation.slice(0, -1)) await f.shell("author", command);
      if (mode.startsWith("hook-edit")) {
        const hook = join(f.directory, ".git", "hooks", "pre-commit");
        await writeFile(hook, '#!/bin/sh\nprintf "hook-changed\\n" > result.txt\ngit add -- result.txt\n'); await chmod(hook, 0o755);
      }
      await f.shell("author", "git add -- result.txt && git commit -m correction");
      if (mode === "hook-edit-rerun") await f.shell("author", "node required-test.mjs");
      await f.shell("author", validation.at(-1)!);
      if (mode === "report-edit") {
        const report = await f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: reports/result.md\n+Native checks passed.\n*** End Patch" });
        await mkdir(join(f.directory, "reports"));
        await writeFile(join(f.directory, "reports/result.md"), "Native checks passed.\n");
        await f.after(report, "Added report");
      }
      await f.finish(correction, "author", "CORRECTION_READY");
      if (mode === "missing-binding") {
        const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE);
        const statePath = runtime.statePath("root");
        const state = JSON.parse(await readFile(statePath, "utf8"));
        state.units[0].reviewerCorrection.checks = state.units[0].reviewerCorrection.checks.filter((check: ObjectValue) => check.command[0] !== "node required-test.mjs");
        await writeFile(statePath, JSON.stringify(state));
      }
      if (mode === "scratch-cold") {
        await mkdir(join(f.directory, ".cache"), { recursive: true });
        await writeFile(join(f.directory, ".cache", "scratch"), "ignored cache");
      }
      await f.start(); // Settlement erased live executions; later Review uses original persisted recipes.
      const expected = mode === "hook-edit" ? "failed" : "ready";
      assert.equal((await f.missions.required("root")).corrections![0]!.status, expected);
      if (mode === "missing-binding") await assert.rejects(f.tool("root", "review_mission", { risk_tags: ["public-logic"] }), /correction-validation-binding-unavailable/);
      else if (expected === "ready") assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-logic"] })).status, "self-recheck-required");
      const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
      assert(checks.every(check => check.binding.freshness && check.dispatchCallID === correction.id));
      if (mode === "generators") assert(checks.slice(0, 2).every(check => check.generatedInputs));
    } finally { await f.dispose(); }
  });
}

test("installed client 2.0.18 and converted role tool snapshots support correction without permission.rules", async () => {
  const client = OpenCode.make({ baseUrl: "http://unused.invalid", fetch: async () => { throw new Error("no-network-contract-test"); } });
  assert.equal("rules" in client.permission, false);
  assert.equal(typeof client.session.switchAgent, "function");
  assert.equal(typeof client.session.switchModel, "function");
  const f = await fixture();
  try {
    for (const role of ["dog-operator", "dogs-coordinator"]) {
      const asset = runtimeAssets.find(item => item.name === role)!.content;
      assert.match(asset, /sortie_v010_repair_review: true/);
      const tool = "sortie_v010_repair_review", native = convertedAssetPermissions(asset);
      assert.equal(whollyDisabled(tool, native), false, "tool must survive snapshot creation before the context hook");
      const context = { sessionID: "root", agent: role, system: [], tools: { [tool]: { description: "repair", input: {} } } };
      await f.context(context);
      assert(tool in context.tools, "context filtering retains the real snapshot's repair tool");
    }
    const reviewer = f.registry()["dog-reviewer-v010"]!;
    assert.equal(whollyDisabled("edit", reviewer.permissions), true);
    assert.equal(whollyDisabled("shell", reviewer.permissions), true);
  } finally { await f.dispose(); }
});

for (const mode of ["missing", "failed", "historical", "out-of-order", "source-changed", "fresh-pass"] as const) {
  test(`all inherited correction checks require fresh native outcomes: ${mode}`, async () => {
    const f = await fixture();
    try {
      await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
      if (mode === "historical") {
        const past = Date.now() - 60_000;
        (f.history.author ??= []).push({ id: "old-review-context", type: "assistant", agent: "dog-reviewer-v010", content: [{ type: "tool", name: "shell", id: "historical-check",
          time: { ran: past, completed: past + 1 }, state: { status: "completed", input: { command: "node required-test.mjs" }, metadata: { exit: 0 } } }] });
      }
      const prepared = await f.tool("root", "repair_review");
      const correction = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", correction.input.prompt); await f.bind("author");
      await f.edit("author", mode === "failed" ? "bad-required" : "ready");
      if (mode === "out-of-order") await f.shell("author", "node check.mjs");
      if (!["missing", "historical"].includes(mode)) await f.shell("author", "node required-test.mjs");
      if (mode === "source-changed") await f.edit("author", "ready-again");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      if (mode !== "out-of-order") await f.shell("author", "node check.mjs");
      await f.finish(correction, "author", "CORRECTION_READY\nThe canonical check passed.");
      const mission = await f.missions.required("root"), run = await f.run(), ledger = await f.ledger();
      assert.equal(mission.corrections![0]!.status, mode === "fresh-pass" ? "ready" : "failed");
      assert.equal(ledger.state.outstanding_reservations.length, 0);
      assert.equal(ledger.state.consumed_units, 2);
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      const settled = ledger.records.map(record => record.event).filter(event => event.kind === "unit.settled").at(-1)!;
      assert.equal(settled.disposition, mode === "fresh-pass" ? "succeeded" : "failed");
      if (mode !== "fresh-pass") {
        assert.equal(run.phase, "awaiting-decision");
        assert.equal(settled.evidence.length, 0, "canonical-only evidence cannot silently satisfy a missing mandatory check");
        if (mode === "historical") {
          const status = await f.tool("root", "operator_status");
          const validation = status.acceptance_summary.native_declared_validation.find((item: ObjectValue) => !item.historical);
          assert(validation.observations.not_observed.includes("node required-test.mjs"), "acceptance summary also excludes initial Reviewer history");
        }
        await assert.rejects(f.tool("root", "review_mission", { risk_tags: ["public-logic"] }), /awaits-unit-validation|terminal-unreconciled/);
        // Even an independently accepted final Reviewer cannot mask the inherited missing check.
        await f.missions.update("root", state => { state.review = { ...state.review!, runID: run.runID, child: "final", verdict: "PASS" }; });
        await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|unit-validation|awaiting|incomplete/);
      } else {
        const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
        const dispatch = await f.before("root", "subagent", f.task(review.task));
        await f.prompt("author", dispatch.input.prompt);
        await f.finish(dispatch, "author", `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate: (await f.missions.required("root")).review!.source, unresolved_findings: [], residual_major: null })}\nBoth inherited checks passed on this correction; original requirements and relevant impact compared.`);
        assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      }
    } finally { await f.dispose(); }
  });
}

for (const place of ["global", "project", "session", "global-all"] as const) test(`correction profile preserves explicit ${place} shell denies`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const deny: Rule = { action: "shell", resource: place === "global-all" ? "*" : "node check.mjs", effect: "deny" };
    if (place === "session") f.agents.author!.permissions = [deny];
    else f.globalRules.push(deny); // Host converts both project/global documents into the registry's inherited rules.
    await f.start();
    const prepared = await f.tool("root", "repair_review");
    const correction = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", correction.input.prompt); await f.bind("author");
    await assert.rejects(f.before("author", "shell", { command: "node check.mjs" }), /native permission denied shell/);
    assert.equal(f.registry()[f.agents.author!.agent]!.permissions.some((rule: Rule) => rule.action === "shell" && rule.resource === "*" && rule.effect === "allow"), false);
    const command = "printf x > undeclared.txt";
    if (place === "global-all") await assert.rejects(f.before("author", "shell", { command }), /native permission denied shell/);
    else {
      const output = await f.before("author", "shell", { command });
      assert.ok((await f.run()).units[0]!.reviewerCorrection!.writeUnion.includes("undeclared.txt"));
      await f.after(output, "Known path reconciled, no formal check", { exit: 0 });
      await assert.rejects(f.before("author", "shell", { command: "node check.mjs" }), /native permission denied shell/,
        "scope reconciliation cannot alter the inherited native deny");
    }
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.deepEqual(f.agents.author!.permissions, place === "session" ? [deny] : undefined);
  } finally { await f.dispose(); }
});

test("native original-target admission then prompt activation retains the author's current model and non-default variant", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const selected = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" };
    f.agents.author!.model = selected; // A genuine native user model switch after the initial review.
    const previous = f.switches.filter(item => "model" in item).length;
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    assert.equal(dispatch.input.sessionID, "author"); assert.equal(dispatch.input.model, undefined);
    assert.equal(dispatch.input.agent, "dog-reviewer-v010");
    assert.equal(f.agents.author!.agent, dispatch.input.agent, "native existing-agent comparison cannot replace the current model");
    await f.prompt("author", dispatch.input.prompt); await f.start();
    assert.deepEqual(f.registry()[f.agents.author!.agent]!.model, selected);
    assert.deepEqual(f.agents.author!.model, selected);
    assert.equal(f.switches.filter(item => "model" in item).length, previous);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.deepEqual(f.agents.author!.model, selected);
    assert.equal(f.switches.filter(item => "model" in item).length, previous);
  } finally { await f.dispose(); }
});

for (const mode of ["cancel", "agent-change", "native-launch-error", "background-failed", "permission-failed"] as const) {
  test(`Reviewer correction restores permissions and settles once: ${mode}`, async () => {
    const f = await fixture();
    try {
      await initial(f);
      const prior = [{ action: "webfetch", resource: "*", effect: "deny" }];
      f.agents.author!.permissions = prior;
      const prepared = await f.tool("root", "repair_review");
      await assert.rejects(f.before("root", "subagent", { ...f.task(prepared.task), model: "openai/gpt-6-astra" }), /operator-/);
      assert.equal((await f.tool("root", "operator_status")).budget.reserved_units, 0);
      if (mode === "permission-failed") {
        f.projection.failGrant = true;
        await assert.rejects(f.before("root", "subagent", f.task(prepared.task)), /native-permission-storage-failed/);
      } else {
        const correction = await f.before("root", "subagent", { ...f.task(prepared.task), ...(mode === "background-failed" ? { background: true } : {}) });
        if (mode === "native-launch-error") {
          // A native resume failure need not return child metadata; admitted sessionID is retained.
          await f.after(correction, "Native launch failed", {}, "error");
          await f.after(correction, "Duplicate native failure", {}, "error");
        } else {
          await f.prompt("author", correction.input.prompt); await f.bind("author");
          await f.start();
          if (mode === "cancel") await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
          else if (mode === "agent-change") {
            f.agents.root!.agent = "build";
            await f.prompt("root", "Use Build for a different request.");
          } else {
            await f.after(correction, "Native Job running", { sessionID: "author", status: "running" });
            f.terminal("author", "Native correction failed", true);
            await f.tool("root", "operator_status");
          }
        }
      }
      assert.deepEqual(f.agents.author!.permissions, prior);
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      const mission = await f.missions.required("root"), ledger = await f.ledger();
      assert.equal(mission.corrections![0]!.status, ["cancel", "agent-change"].includes(mode) ? "cancelled" : "failed");
      assert.equal(ledger.state.outstanding_reservations.length, 0);
      assert.equal(ledger.state.consumed_units, 2);
      assert.equal(ledger.records.filter(({ event }) => event.kind === "unit.settled").length, 2);
      assert.equal(mission.review!.verdict, "findings");
    } finally { await f.dispose(); }
  });
}

test("unsupported native correction permissions refuse before creating a new run or spending budget", async () => {
  const f = await fixture({ permissionsUnavailable: true });
  try {
    const before = await initial(f);
    await assert.rejects(f.tool("root", "repair_review"), /native-reviewer-correction-permissions-unavailable/);
    assert.equal((await f.run()).runID, before.run.runID);
    assert.equal((await f.missions.required("root")).corrections, undefined);
    assert.equal((await f.ledger()).state.consumed_units, 1);
  } finally { await f.dispose(); }
});

test("native correction session grants preserve explicit session denies without granting global Reviewer writes", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prior = [{ action: "edit", resource: "result.txt", effect: "deny" }];
    f.agents.author!.permissions = prior;
    const prepared = await f.tool("root", "repair_review");
    await f.before("root", "subagent", f.task(prepared.task));
    assert.deepEqual(f.agents.author!.permissions, prior, "session denies never get replaced");
    assert.equal(evaluate("edit", "result.txt", f.rules.at(-1)!.permissions, prior).effect, "deny", "native last-match semantics retain user denial");
    assert.deepEqual(f.agents.final!.permissions, undefined);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.deepEqual(f.agents.author!.permissions, prior);
  } finally { await f.dispose(); }
});

test("Reviewer correction inherits the host Git lifecycle and exact proof/declaration rather than creating new authority", async () => {
  const f = await fixture();
  try {
    await f.prompt("root", "Produce ready output with the original check and host-owned commit boundary.");
    await f.tool("root", "start_mission", { requirements: ["Ready output; preserve the check and clean commit"] });
    const raw = { ...missionPlan(await f.missions.required("root"), [{ title: "Ready output", objective: "Produce ready output",
      read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }], f.directory),
      git_lifecycle: { branch_create: { branch: "feature/retained-correction", start_ref: "refs/heads/base" },
        commit: { message: "Preserve the authorized commit boundary" }, post_commit_validation: ["node check.mjs"] } };
    const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE);
    const first = await runtime.prepareMission("root", raw);
    const implement = async (state: typeof first, child: string, callID: string, text: string) => {
      const task = runtime.nextWorkerTask(state);
      await runtime.admitWorker("root", "root", callID, task);
      await runtime.claimAdmittedWorkerPrompt("root", "root", child, task.prompt);
      await writeFile(join(f.directory, "result.txt"), text + "\n");
      await runtime.beforePostCommitValidation("root", child, "node check.mjs");
      assert.equal(await runtime.postCommitLocked("root"), true);
      await assert.rejects(runtime.beforePostCommitValidation("root", child, "node format.mjs"), /operator-git-post-commit-command-denied/);
      await exec(process.execPath, ["check.mjs"], { cwd: f.directory });
      // Focused core boundary test: bridge evidence is synthetic here, not a native live receipt.
      await runtime.settled({ rootSessionID: "root", callID, childSessionID: child, unitID: state.units[0]!.unit.id,
        disposition: "succeeded", resultClass: "acceptance", evidence: [{ measurement: { criterion_ids: ["requirement-1"] },
          execution: { command: ["node check.mjs"], exit_code: 0 } }] as never });
      return runtime.required("root");
    };
    const settled = await implement(first, "worker", "core-initial", "wrong");
    assert.equal(settled.phase, "awaiting-acceptance");
    const priorHead = settled.gitLifecycle!.committedHead;
    const correctionPlan = { ...raw, units: [{ ...raw.units[0]!, title: "Correct the retained finding", objective: "Correct wrong to ready" }] };
    for (const invalid of [
      { ...correctionPlan, goal_declaration: { ...raw.goal_declaration, goal_budget_units: 999 } },
      { ...correctionPlan, acceptance_proof: [[]] },
      { ...correctionPlan, git_lifecycle: { ...raw.git_lifecycle, commit: { message: "Different authority" } } },
      { ...correctionPlan, units: [{ ...correctionPlan.units[0]!, write: ["undeclared.txt"] }] },
    ]) {
      await assert.rejects(runtime.prepareReviewerCorrection("root", settled.runID, invalid, "author", "review-identity", ["result.txt"]));
      assert.equal((await runtime.required("root")).runID, settled.runID, "rejected correction retains the settled candidate");
    }
    const corrected = await runtime.prepareReviewerCorrection("root", settled.runID, correctionPlan, "author", "review-identity", ["result.txt"]);
    assert.equal(corrected.units[0]!.task.task_id, "author");
    assert.equal(corrected.units[0]!.task.subagent_type, "dog-reviewer-v010");
    assert.deepEqual(corrected.gitLifecycle, { ...settled.gitLifecycle, committedHead: null, commitProvenance: null });
    assert.deepEqual(corrected.acceptanceProof, settled.acceptanceProof);
    assert.deepEqual(corrected.sourceRefs, settled.sourceRefs);
    assert.equal(corrected.acceptanceFingerprint, settled.acceptanceFingerprint);
    assert.equal(corrected.units[0]!.hashes[2], settled.units[0]!.hashes[2], "fixed declaration hash is inherited unchanged");
    assert.deepEqual(corrected.units[0]!.evidence, [], "old validation cannot certify the correction");
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout.trim(), priorHead);
    const cold = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE);
    const done = await implement(await cold.required("root"), "author", "core-correction", "ready");
    assert.equal(done.phase, "awaiting-acceptance");
    assert.notEqual(done.gitLifecycle!.committedHead, priorHead);
    assert.equal(done.gitLifecycle!.commitProvenance, "host-created");
    assert.equal((await exec("git", ["rev-parse", "HEAD^"], { cwd: f.directory })).stdout.trim(), priorHead);
    assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: f.directory })).stdout.trim(), raw.git_lifecycle.commit.message);
    assert.equal((await exec("git", ["branch", "--show-current"], { cwd: f.directory })).stdout.trim(), raw.git_lifecycle.branch_create.branch);
    assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.directory })).stdout, "");
  } finally { await f.dispose(); }
});
