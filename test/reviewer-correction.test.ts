import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createSortieDogsV2Plugin, type OpenCodeV2Context } from "../dist/plugin/v2.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { OperatorMissionRuntime, missionPlan, missionReviewIndependent } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { runtimeAssets } from "../dist/runtime-assets-v010.js";
import type { OpenCodeHooks } from "../dist/plugin/index.js";

const exec = promisify(execFile);
type ObjectValue = Record<string, any>;

async function fixture(options: { permissionsUnavailable?: boolean } = {}) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/reviewer-correction-"));
  for (const args of [["init", "--quiet", "--initial-branch=base"], ["config", "user.name", "test"], ["config", "user.email", "test@example.invalid"]]) {
    await exec("git", args, { cwd: directory });
  }
  await writeFile(join(directory, ".gitignore"), ".sortie-dogs-v010/\n");
  await writeFile(join(directory, "result.txt"), "old\n");
  await writeFile(join(directory, "check.mjs"), 'import { readFileSync } from "node:fs"; if (!readFileSync("result.txt", "utf8").trim()) process.exit(1);\n');
  await exec("git", ["add", "--all"], { cwd: directory });
  await exec("git", ["commit", "--quiet", "-m", "base"], { cwd: directory });
  const agents: Record<string, ObjectValue> = { root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
    author: { agent: "dog-reviewer-v010", parentID: "root" }, final: { agent: "dog-reviewer-v010", parentID: "root" } };
  const history: Record<string, ObjectValue[]> = {}, storage = new Map<string, unknown>(), rules: ObjectValue[] = [], switches: ObjectValue[] = [];
  let tools: ObjectValue[], toolHooks: Map<string, Function>, sessionHooks: Map<string, Function>, hooks: OpenCodeHooks;
  let cleanup: (() => void) | void, counter = 0;
  const projection = { failGrant: false };
  const start = async () => {
    cleanup?.(); tools = []; toolHooks = new Map(); sessionHooks = new Map();
    const context: OpenCodeV2Context = {
      location: { directory }, storage: { get: async key => structuredClone(storage.get(key)),
        set: async (key, value) => { storage.set(key, structuredClone(value)); }, remove: async key => { storage.delete(key); } },
      agent: { transform: async () => ({ dispose() {} }), get: async ({ agentID }) => ({ model: {
        providerID: "openai", id: agentID === "dog-worker-v010" ? "gpt-6-luna-fast" : "gpt-6.1-sol", variant: agentID === "dog-worker-v010" ? "max" : "xhigh" } }) },
      event: { subscribe: async function* () {} },
      tool: { transform: async callback => { callback({ add: tool => tools.push(tool) }); return { dispose() {} }; },
        hook: async (name, callback) => { toolHooks.set(name, callback); return { dispose() {} }; } },
      session: { get: async ({ sessionID }) => ({ id: sessionID, ...agents[sessionID], model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } }),
        context: async ({ sessionID }) => history[sessionID] ?? [],
        list: async ({ parentID }) => ({ data: Object.entries(agents).filter(([, info]) => info.parentID === parentID).map(([id, info]) => ({ id, ...info })), cursor: {} }),
        prompt: async () => ({}), synthetic: async () => ({}), interrupt: async ({ sessionID }) => { agents[String(sessionID)]!.outcome = "interrupted"; return { interrupted: true }; },
        switchAgent: async input => { switches.push(input); }, switchModel: async input => { switches.push(input); },
        hook: async (name, callback) => { sessionHooks.set(name, callback); return { dispose() {} }; } },
      permission: { hook: async () => ({ dispose() {} }), ...(!options.permissionsUnavailable ? { rules: async (input: ObjectValue) => {
        if (projection.failGrant && input.permissions.some((rule: ObjectValue) => rule.action === "edit" && rule.effect === "allow")) {
          projection.failGrant = false; throw new Error("native-permission-storage-failed");
        }
        rules.push(structuredClone(input)); agents[input.sessionID]!.permissions = input.permissions;
      } } : {}) },
      provider: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
    };
    cleanup = await createSortieDogsV2Plugin(async (input, options) => { hooks = await SortieDogsV010Plugin(input, options); return hooks; }).setup(context);
  };
  const before = async (sessionID: string, tool: string, input: ObjectValue) => {
    const event = { sessionID, agent: agents[sessionID]!.agent, tool, id: `call_${++counter}`, input: structuredClone(input) };
    await toolHooks.get("execute.before")!(event); return event;
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
    const output = await exec(command.startsWith("git ") ? "git" : process.execPath,
      command.startsWith("git ") ? command.slice(4).split(" ") : ["check.mjs"], { cwd: directory });
    await after(event, output.stdout, { exit });
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
  return { directory, agents, history, storage, rules, switches, projection, start, before, after, prompt, tool, task, run, missions, bind, edit, shell, finish, terminal, ledger,
    hooks: () => hooks, context: (event: ObjectValue) => sessionHooks.get("context")!(event),
    dispose: async () => { cleanup?.(); await rm(directory, { recursive: true, force: true }); } };
}

async function initial(f: Awaited<ReturnType<typeof fixture>>, options: { readonly?: boolean; operation?: boolean } = {}) {
  const original = "Produce ready output, validate, commit it, preserve all constraints and independently review.";
  await f.prompt("root", original);
  await f.tool("root", "start_mission", { requirements: ["Output must be ready", "Validate and commit; independent review"], ...(options.operation ? { kind: "operation" } : {}) });
  const plan = await f.tool("root", "plan_units", { units: [{ title: "Ready output", objective: "Produce ready output",
    read: ["check.mjs"], write: options.readonly ? [] : ["result.txt"], validation: ["node check.mjs"] }] });
  const worker = await f.before("root", "subagent", f.task(plan.task));
  await f.prompt("worker", worker.input.prompt); await f.bind("worker");
  if (!options.readonly) { await f.edit("worker", "wrong"); await f.shell("worker", "git add -- result.txt"); await f.shell("worker", "git commit -m candidate"); }
  await f.shell("worker", "node check.mjs"); await f.finish(worker, "worker", "Implemented");
  const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
  const dispatch = await f.before("root", "subagent", f.task(review.task));
  await f.prompt("author", dispatch.input.prompt);
  await f.finish(dispatch, "author", "FINDINGS\nresult.txt is wrong rather than ready; correct its content.");
  return { original, run: await f.run(), mission: await f.missions.required("root") };
}

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
        await f.start();
        assert.equal((await f.tool("root", "operator_status")).budget.reserved_units, 1);
      }
      await f.bind("author");
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      assert.equal(f.switches.filter(input => "agent" in input).length, 0, "no worker switch or ignored resume agent assumption");
      assert.equal(f.switches.length, priorModelSwitches, "same-child correction retains the native Sol model and variant too");
      const grants = f.rules.at(-1)!.permissions;
      assert(grants.some((rule: ObjectValue) => rule.action === "edit" && rule.resource.endsWith("/result.txt") && rule.effect === "allow"));
      assert(!grants.some((rule: ObjectValue) => rule.action === "edit" && rule.resource === "*"));
      assert(grants.some((rule: ObjectValue) => rule.action === "edit" && rule.resource === "result.txt" && rule.effect === "allow"));
      const context = { sessionID: "author", agent: "dog-reviewer-v010", tools: Object.fromEntries(["read", "patch", "write", "shell",
        "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "sortie_v010_review_mission"].map(name => [name, { description: name, input: {} }])), system: [] };
      await f.context(context);
      assert.deepEqual(Object.keys(context.tools).sort(), ["patch", "read", "shell", "sortie_v010_bind_write_gate", "write"].sort());
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: undeclared.txt\n+x\n*** End Patch" }), /mission-review-correction-write-union-fixed|write-denied|path-not-declared|outside|not-allowed/);
      await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      await f.shell("author", "node check.mjs", mode === "failure" ? 1 : 0);
      if (mode === "background-restart") {
        f.terminal("author", "CORRECTION_READY\nFixed the retained finding and ran its exact validation.");
        await f.tool("root", "operator_status");
      } else await f.finish(correction, "author", "CORRECTION_READY\nFixed the retained finding and ran its exact validation.");
      const corrected = await f.missions.required("root"), status = await f.tool("root", "operator_status");
      assert.equal(status.budget.reserved_units, 0); assert.equal(status.budget.consumed_units, 2);
      assert.deepEqual(f.agents.author!.permissions, [], "terminal restores the original native session rules immediately");
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
      assert.equal(finalReview.status, "review-required", "correction cannot low-risk skip independent review");
      const finalDispatch = await f.before("root", "subagent", f.task(finalReview.task));
      assert.equal(finalDispatch.input.sessionID, undefined, "native final review creates a DIFFERENT child");
      assert.match(finalDispatch.input.prompt, /review_phase: verification/);
      assert.match(finalDispatch.input.prompt, /prior_findings_ref:/);
      assert.match(finalDispatch.input.prompt, /Changed since correction baseline/);
      if (mode === "self-review") {
        await f.finish(finalDispatch, "author", "PASS\nMy own correction is fine");
        assert.equal((await f.missions.required("root")).review!.verdict, "findings");
        assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false);
        await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
        return;
      }
      await f.prompt("final", finalDispatch.input.prompt); await f.finish(finalDispatch, "final", "PASS\nCorrection and relevant impact resolve the prior finding.");
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      const completed = await f.missions.required("root");
      assert.deepEqual(completed.requirements, previous.mission.requirements);
      assert.equal(completed.requests[0]!.text, previous.original);
      assert.equal(completed.review!.child, "final"); assert.equal((await f.run()).receipt!.status, "succeeded");
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
    assert.deepEqual(f.rules.at(-1)!.permissions.at(-1), prior[0], "native last-match semantics retain user denial");
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
