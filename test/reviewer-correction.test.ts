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
import { canonicalDeclaredValidationMembers, declaredValidationShellResources, reviewerCorrectionShellAllowed } from "../dist/plugin/gate.js";
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
      assert.notEqual(await permission(sessionID, "shell", declaredValidationShellResources(input.command), false, event.id), "deny", "native permission denied shell");
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
  const prompt = async (sessionID: string, text: string) => {
    delete agents[sessionID]!.outcome;
    const event = { sessionID, messageID: `msg_${++counter}`, prompt: { text: sessionID === "root" ? text : `You are a subagent spawned by another session.\n${text}` } };
    await sessionHooks.get("prompt")!(event);
    (history[sessionID] ??= []).push({ id: event.messageID, type: "user", text: event.prompt.text, time: { created: Date.now() } });
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

async function initial(f: Awaited<ReturnType<typeof fixture>>, options: { readonly?: boolean; operation?: boolean; validation?: string[]; original?: string } = {}) {
  const original = options.original ?? "Produce ready output, validate, commit it, preserve all constraints and independently review.";
  await f.prompt("root", original);
  await f.tool("root", "start_mission", { requirements: ["Output must be ready", "Validate and commit; independent review"], ...(options.operation ? { kind: "operation" } : {}) });
  const plan = await f.tool("root", "plan_units", { units: [{ title: "Ready output", objective: "Produce ready output",
     read: ["check.mjs", "required-test.mjs", "generate.mjs", "format.mjs"], write: options.readonly ? [] : ["result.txt"], validation: options.validation ?? ["node check.mjs"] }] });
  assert(plan.task, JSON.stringify(plan));
  const worker = await f.before("root", "subagent", f.task(plan.task));
  await f.prompt("worker", worker.input.prompt); await f.bind("worker");
  if (!options.readonly) { await f.edit("worker", "wrong"); await f.shell("worker", "git add -- result.txt"); await f.shell("worker", "git commit -m candidate"); }
  for (const command of options.validation ?? ["node check.mjs"]) await f.shell("worker", command);
  await f.finish(worker, "worker", "Implemented");
  const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
  const dispatch = await f.before("root", "subagent", f.task(review.task));
  await f.prompt("author", dispatch.input.prompt);
   await f.finish(dispatch, "author", "FINDINGS\nMedium: result.txt is wrong rather than ready; correct its content.\nMedium: preserve the ready output contract.\nMedium: keep required validation and clean commit semantics.");
  return { original, run: await f.run(), mission: await f.missions.required("root") };
}

async function correctionReady(f: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await f.tool("root", "repair_review");
  const dispatch = await f.before("root", "subagent", f.task(prepared.task));
  await f.prompt("author", dispatch.input.prompt); await f.bind("author");
  await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
  await f.shell("author", "node check.mjs");
  await f.finish(dispatch, "author", "CORRECTION_READY\nAll retained findings corrected and declared checks/commit passed.");
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

for (const residual of [false, true]) test(`evidence refresh ${residual ? "invalidates old Major report" : "after acceptance"} stays in the SAME author`, async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, residual ? { reachable_path: "failed transaction retry", consequence: "state corruption" } : null);
    await f.finish(self.dispatch, "author", self.text);
    const before = await f.run(), prior = (await f.missions.required("root")).review!;
    const refreshed = await f.tool("root", "review_mission", { risk_tags: ["public-api"], evidence: [{ path: "result.txt", offset: 1, limit: 1 }] });
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
  assert.equal(reviewerCorrectionShellAllowed(`${C} && printf x > undeclared.txt`, [C]), false);
  assert.equal(reviewerCorrectionShellAllowed(`${C}; printf x > result.txt`, [C]), false);
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
      assert.equal(await f.permission("author", "shell", C, true), effect, "saved whole-command allow cannot override configured member/composite ask or deny");
      if (effect === "deny") await assert.rejects(f.before("author", "shell", { command: C }), /native permission denied shell/);
      else {
        const shell = await f.before("author", "shell", { command: C });
        assert.equal(await f.permission("author", "shell", [A, B], true, shell.id), "ask", "actual ShellTool parsed resources retain the atomic configured ask");
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
    await assert.rejects(f.before("author", "shell", { command: "node required-test.mjs" }), /correction-shell-boundary/);
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
      assert(grants.some((rule: ObjectValue) => rule.action === "edit" && rule.resource.endsWith("/result.txt") && rule.effect === "allow"));
      assert(!grants.some((rule: ObjectValue) => rule.action === "edit" && rule.resource === "*" && rule.effect === "allow"));
      assert(grants.some((rule: ObjectValue) => rule.action === "edit" && rule.resource === "result.txt" && rule.effect === "allow"));
      const context = { sessionID: "author", agent: f.agents.author!.agent, tools: Object.fromEntries(["read", "patch", "write", "shell",
        "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "sortie_v010_review_mission"].filter(name =>
          !whollyDisabled(["patch", "write"].includes(name) ? "edit" : name,
            [...f.registry()[f.agents.author!.agent]!.permissions, ...(f.agents.author!.permissions ?? [])]))
        .map(name => [name, { description: name, input: {} }])), system: [] };
      await f.context(context);
      assert.deepEqual(Object.keys(context.tools).sort(), ["patch", "read", "shell", "sortie_v010_bind_write_gate", "write"].sort());
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: undeclared.txt\n+x\n*** End Patch" }), /operation manifest write scope|mission-review-correction-write-union-fixed|write-denied|path-not-declared|outside|not-allowed/);
      await assert.rejects(f.before("author", "shell", { command: "printf x > undeclared.txt" }), /mission-review-correction-shell-boundary/);
      await assert.rejects(f.before("author", "shell", { command: "printf x > result.txt" }), /mission-review-correction-shell-boundary/);
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
      assert(Math.abs(status.budget.settled_cost_usd - 0.0048) < 1e-12, "initial Worker and six correction requests are each priced exactly once");
      const settled = (await f.ledger()).records.map(record => record.event).filter(event => event.kind === "unit.settled");
      assert.equal(settled.length, 2);
      const correctionSettlement = settled.find(event => event.native_session_id === "author")!;
      assert(Math.abs(correctionSettlement.cost_usd! - 0.0024) < 1e-12, "same-child review history is excluded from correction spend");
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

for (const mode of ["operation", "readonly", "stale"] as const) test(`Reviewer correction does not broaden mission semantics: ${mode}`, async () => {
  const f = await fixture();
  try {
    await initial(f, { operation: mode === "operation", readonly: mode === "readonly" });
    if (mode === "stale") await writeFile(join(f.directory, "result.txt"), "changed outside review\n");
    await assert.rejects(f.tool("root", "repair_review"), /mission-review-correction-unavailable|mission-review-correction-source-stale/);
    assert.equal((await f.missions.required("root")).corrections, undefined);
    assert.equal(f.rules.length, 0, "ordinary reviews never receive writer permissions");
    assert.equal((await f.tool("root", "operator_status")).budget.consumed_units, 1);
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
      assert.equal(await f.permission("author", "shell", `${A} && ${B}`, true), effect,
        "saved chain allow cannot bypass an individual required member's permission");
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

for (const mode of ["hook-edit", "hook-edit-rerun", "scratch-cold", "missing-binding", "generators"] as const) {
  test(`required correction checks retain actual candidate bindings: ${mode}`, async () => {
    const f = await fixture();
    try {
      const validation = mode === "generators" ? ["node generate.mjs", "node format.mjs", "node required-test.mjs", "node check.mjs"]
        : mode === "scratch-cold" ? ["TMPDIR=.cache node required-test.mjs", "TMPDIR=.cache node check.mjs"]
        : ["node required-test.mjs", "node check.mjs"];
      await initial(f, { validation });
      const prepared = await f.tool("root", "repair_review");
      const correction = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", correction.input.prompt); await f.bind("author"); await f.edit("author", "ready");
      for (const command of validation.slice(0, -1)) await f.shell("author", command);
      if (mode.startsWith("hook-edit")) {
        const hook = join(f.directory, ".git", "hooks", "pre-commit");
        await writeFile(hook, '#!/bin/sh\nprintf "hook-changed\\n" > result.txt\ngit add -- result.txt\n'); await chmod(hook, 0o755);
      }
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      if (mode === "hook-edit-rerun") await f.shell("author", "node required-test.mjs");
      await f.shell("author", validation.at(-1)!);
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
    await assert.rejects(f.before("author", "shell", { command: "printf x > undeclared.txt" }), /mission-review-correction-shell-boundary/);
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
