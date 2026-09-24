import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { WorkLoop, runWorkCheck, workSource, type WorkStore } from "../dist/core/work-loop.js";
import { createUserProxyPlugin, V011_ROUTES, type NativeWorkContext } from "../dist/plugin/work-loop-v2.js";
import { initializeProject } from "../dist/core/initialize.js";
import { runtimeAssets } from "../dist/runtime-assets-v011.js";
import { estimateModelUsageCost } from "../dist/plugin/model-cost.js";
import { newWorkProgress, progressLimit, repairWorkToolHistory } from "../dist/core/work-progress.js";
import { auxiliaryResponseUsage, observeAuxiliaryResponse } from "../dist/plugin/work-usage.js";
import { workOverview } from "../dist/core/work-overview.js";

function storage(): WorkStore {
  const values = new Map<string, unknown>();
  return { get: async key => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }) };
}
async function fixture(action: (directory: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/v011-loop-"));
  try {
    await writeFile(join(directory, "a.txt"), "pending\n");
    await writeFile(join(directory, "b.txt"), "pending\n");
    await writeFile(join(directory, "check.mjs"), "import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';for(const name of ['a','b'])assert.equal((await readFile(name+'.txt','utf8')).trim(),'done');console.log('PASS');\n");
    await action(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function start(loop: WorkLoop, root = "root", child = "child") {
  await loop.observe(root, { id: "user-1", text: "Complete both files. Preserve the oracle and do not commit." });
  const work = await loop.start(root, "Use the project's existing check.");
  await loop.admit(root, "call-1", loop.task(work));
  await loop.claim(root, child, loop.task(work).prompt);
  return work;
}
async function completeFiles(directory: string) {
  await writeFile(join(directory, "a.txt"), "done\n");
  await writeFile(join(directory, "b.txt"), "done\n");
}

test("v0.11 discovers, fails, fixes and verifies two files in one invocation without a plan", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage());
  await start(loop);
  const failed = await loop.check("root", "child", "node check.mjs", 10000);
  assert.notEqual(failed.exit, 0);
  await completeFiles(directory);
  const passed = await loop.check("root", "child", "node check.mjs", 10000);
  await loop.settled("root", "call-1", true, "Both requested files complete; oracle unchanged.");
  await loop.inspect("root", "root");
  const accepted = await loop.review("root", "accept", "Both files equal done, negative constraints checked against source and Git state.", [passed.id]);
  assert.equal(accepted.phase, "completed");
  assert.equal(accepted.attempts, 1);
  assert.equal(accepted.checks.length, 2);
  assert.equal(accepted.acceptedSource, (await workSource(directory)).fingerprint);
}));

test("v0.11 refuses missing, failed, superseded and stale validation evidence", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop); await completeFiles(directory);
  const pass = await loop.check("root", "child", "node check.mjs", 10000);
  await writeFile(join(directory, "a.txt"), "wrong\n");
  const fail = await loop.check("root", "child", "node check.mjs", 10000);
  await loop.settled("root", "call-1", true, "Claims complete");
  await loop.inspect("root", "root");
  await assert.rejects(loop.review("root", "accept", "claim", []), /current-validation-required/);
  await assert.rejects(loop.review("root", "accept", "claim", [pass.id]), /missing-failed-or-stale/);
  await assert.rejects(loop.review("root", "accept", "claim", [fail.id]), /missing-failed-or-stale/);
  await assert.rejects(loop.review("root", "accept", "claim", ["invented"]), /missing-failed-or-stale/);
  assert.equal((await loop.current("root"))!.phase, "review");
}));

test("v0.11 cannot hide an unexecuted behavior check behind a passing syntax check", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store); await start(loop);
  const failed = await loop.check("root", "child", "node check.mjs", 10000);
  assert.notEqual(failed.exit, 0);
  await writeFile(join(directory, "notes.txt"), "A source edit must not erase a failed verification obligation.\n");
  const syntax = await loop.check("root", "child", "node --check check.mjs", 10000);
  await loop.settled("root", "call-1", true, "Syntax passes, behavioral test remains unresolved.");
  const restored = new WorkLoop(directory, store);
  await restored.inspect("root", "root");
  await assert.rejects(restored.review("root", "accept", "Accept only the passing syntax check.", [syntax.id]), /unresolved-checks/);
  assert.equal((await restored.current("root"))!.phase, "review");
}));

test("v0.11 review evidence becomes stale when another check runs without source edits", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop); await completeFiles(directory);
  const pass = await loop.check("root", "child", "node check.mjs", 10000);
  await loop.settled("root", "call-1", true, "Done");
  await loop.inspect("root", "root");
  await loop.check("root", "root", "node --check check.mjs", 10000);
  await assert.rejects(loop.review("root", "accept", "Use the old evidence view.", [pass.id]), /review-view-stale/);
}));

test("v0.11 blocked verification resumes the same child and clears only after a current behavioral pass", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store); const original = await start(loop);
  await loop.check("root", "child", "node check.mjs", 10000);
  await loop.settled("root", "call-1", true, "Cannot verify both files.");
  const blocked = await loop.review("root", "blocked", "Both-file oracle still fails; work is incomplete.", []);
  assert.equal(blocked.phase, "blocked"); assert.equal(blocked.acceptedSource, null);
  const restored = new WorkLoop(directory, store);
  const resumed = await restored.start("root", "Resolve the remaining behavior.");
  assert.equal(resumed.id, original.id); assert.equal(restored.task(resumed).sessionID, "child");
  assert.equal(resumed.attempts, 1);
  await restored.admit("root", "call-2", restored.task(resumed));
  assert.match(await restored.claim("root", "child", restored.task(resumed).prompt), /Both-file oracle still fails/);
  await completeFiles(directory);
  const pass = await restored.check("root", "child", "node check.mjs", 10000);
  await restored.settled("root", "call-2", true, "Both files verified.");
  await restored.inspect("root", "root");
  assert.equal((await restored.review("root", "accept", "The original behavioral oracle now passes for both files.", [pass.id])).phase, "completed");
}));

test("v0.11 corrected check commands need an explicit equivalent passing replacement", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop); await completeFiles(directory);
  const wrong = await loop.check("root", "child", "node missing-check.mjs", 10000);
  const pass = await loop.check("root", "child", "node check.mjs", 10000);
  await loop.settled("root", "call-1", true, "The original command named a nonexistent file; the repository's check passed.");
  await loop.inspect("root", "root");
  await assert.rejects(loop.review("root", "accept", "Ignore the bad command.", [pass.id]), /unresolved-checks/);
  const replacement = { check: wrong.id, replacement: pass.id, reason: "Corrected the nonexistent test path to the unchanged repository oracle that checks both requested files." };
  for (const invalid of [{ ...replacement, replacement: "invented" }, { ...replacement, reason: "" }, { ...replacement, check: pass.id }]) {
    await assert.rejects(loop.review("root", "accept", "Both-file verification.", [pass.id], [invalid]), /replacement-invalid/);
  }
  const accepted = await loop.review("root", "accept", "The actual repository oracle verifies both files; inspected the corrected command and its output.", [pass.id], [replacement]);
  assert.equal(accepted.phase, "completed"); assert.deepEqual(accepted.checkReplacements, [replacement]);
  assert.notEqual(accepted.checks.find(check => check.id === wrong.id)!.exit, 0);
}));

test("v0.11 semantic rejection resumes the same cheap child and survives a cold restart", () => fixture(async directory => {
  const store = storage(), first = new WorkLoop(directory, store); await start(first);
  await writeFile(join(directory, "a.txt"), "done\n");
  await first.settled("root", "call-1", true, "Only first requirement done");
  const revised = await first.review("root", "revise", "The second file is still pending. Complete it and run the real oracle.", []);
  const restored = new WorkLoop(directory, store);
  const task = restored.task((await restored.current("root"))!);
  assert.equal(task.sessionID, "child");
  await restored.admit("root", "call-2", task);
  const prompt = await restored.claim("root", "child", task.prompt);
  assert.match(prompt, /Preserve the oracle and do not commit/);
  assert.match(prompt, /second file is still pending/);
  await completeFiles(directory);
  const pass = await restored.check("root", "child", "node check.mjs", 10000);
  await restored.settled("root", "call-2", true, "Corrected");
  await restored.inspect("root", "root");
  const done = await restored.review("root", "accept", "All original requirements including the second file now checked.", [pass.id]);
  assert.equal(done.id, revised.id); assert.equal(done.attempts, 2);
}));

test("v0.11 dispatch identity, parent binding, replay and attempt budgets are bounded", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage(), 1);
  await loop.observe("root", { id: "user-1", text: "Complete both files" });
  const work = await loop.start("root", "");
  const task = loop.task(work);
  for (const wrong of [{ ...task, prompt: `${task.prompt} changed` }, { ...task, background: true }, { ...task, model: "other" }]) {
    await assert.rejects(loop.admit("root", "bad", wrong), /dispatch-mismatch/);
  }
  await Promise.all([loop.admit("root", "call", task), loop.admit("root", "call", task)]);
  assert.equal((await loop.current("root"))!.attempts, 1);
  await loop.claim("root", "child", task.prompt);
  await assert.rejects(loop.claim("root", "foreign-child", task.prompt), /not-admitted/);
  await assert.rejects(loop.claim("other-root", "child", task.prompt), /not-admitted/);
  await loop.settled("root", "call", true, "incomplete");
  await assert.rejects(loop.review("root", "revise", "fix", []), /budget-exhausted/);
  assert.equal((await loop.current("root"))!.phase, "review");
}));

test("v0.11 a result-driven task continues past six dispatches without resetting history or failed checks", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store); await start(loop);
  const failure = await loop.check("root", "child", "node check.mjs", 10000);
  for (let attempt = 1; attempt <= 7; attempt++) {
    await writeFile(join(directory, "a.txt"), `stage ${attempt}\n`);
    await loop.settled("root", attempt === 1 ? "call-1" : `call-${attempt}`, true, "Stage implemented; remaining scope continues.");
    await loop.inspect("root", "root");
    const revised = await loop.review("root", "revise", `Inspected stage ${attempt}; implement the next remaining behavior and keep its failed oracle.`, []);
    assert.equal(revised.child, "child"); assert.equal(revised.attempts, attempt);
    await loop.admit("root", `call-${attempt + 1}`, loop.task(revised));
    await loop.claim("root", "child", loop.task(revised).prompt);
  }
  const restored = new WorkLoop(directory, store), work = (await restored.current("root"))!;
  assert.equal(work.attempts, 8); assert.equal(work.attemptExtensions!.length, 1);
  assert.equal(work.attemptExtensions![0].attempts, 6); assert.equal(work.attemptExtensions![0].limit, 12);
  assert.equal(work.checks[0].id, failure.id); assert.notEqual(work.checks[0].exit, 0);
  await completeFiles(directory);
  const pass = await restored.check("root", "child", "node check.mjs", 10000);
  await restored.settled("root", "call-8", true, "Full result verified"); await restored.inspect("root", "root");
  assert.equal((await restored.review("root", "accept", "All original requirements verified after continued stages", [pass.id])).phase, "completed");
}));

test("v0.11 an inspected ordinary correction can start its next native invocation instead of immediately yielding again", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage());
  const received = Date.now() - 10000;
  await loop.observe("root", { id: "user", text: "Complete both files", at: received });
  const work = await loop.start("root", ""); await loop.admit("root", "first", loop.task(work)); await loop.claim("root", "child", loop.task(work).prompt);
  await writeFile(join(directory, "a.txt"), "done\n");
  await loop.stall("root", "first", "First interval elapsed"); await loop.settled("root", "first", false, "Native return");
  await loop.inspect("root", "root");
  const revised = await loop.review("root", "revise", "Inspected a.txt; complete the remaining b.txt and verify both", [], [], 1000);
  await loop.admit("root", "second", loop.task(revised));
  assert.equal(progressLimit((await loop.current("root"))!.progress!, Date.now(), 50, 1), null);
  await loop.claim("root", "child", loop.task(revised).prompt);
  assert.equal((await loop.current("root"))!.attempts, 2); assert.equal(revised.progress!.startedAt, received);
}));

test("v0.11 cancellation cannot be overwritten by late success; a new task has new instructions", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop);
  await loop.interrupt("root", true);
  await loop.settled("root", "call-1", true, "late success");
  assert.equal((await loop.current("root"))!.phase, "cancelled");
  await loop.observe("root", { id: "user-2", text: "Now explain the format only." });
  const next = await loop.start("root", "");
  assert.deepEqual(next.requests, [{ id: "user-2", text: "Now explain the format only." }]);
  assert.equal(next.attempts, 0); assert.equal(next.child, null);
}));

test("v0.11 interrupted continuation preserves all steering instructions and spend", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); const old = await start(loop);
  await loop.observe("root", { id: "user-2", text: "Also preserve the trailing newline." });
  await loop.interrupt("root");
  const resumed = await loop.start("root", "Continue the same request.");
  assert.equal(resumed.id, old.id); assert.equal(resumed.attempts, 1);
  assert.equal(loop.task(resumed).sessionID, "child");
  assert.equal(resumed.requests.length, 2);
}));

test("v0.11 validation subprocesses honor timeout and cancellation", () => fixture(async directory => {
  const command = `node -e "setTimeout(()=>{},60000)"`;
  const timed = await runWorkCheck(directory, command, 100);
  assert.equal(timed.timedOut, true); assert.notEqual(timed.exit, 0);
  const controller = new AbortController();
  const running = runWorkCheck(directory, command, 10000, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try { assert.equal((await running).interrupted, true); } finally { clearTimeout(timer); }
}));

function nativeFixture(directory: string, store = storage()) {
  const tools = new Map<string, any>(), hooks = new Map<string, any>(), rpcs = new Map<string, any>(), sessions = new Map<string, any>([
    ["root", { id: "root", agent: "dog-operator", model: V011_ROUTES.operator }],
    ["child", { id: "child", agent: "dogs-coordinator", parentID: "root", model: V011_ROUTES.worker }],
    ["ordinary", { id: "ordinary", agent: "build" }],
  ]);
  const histories = new Map<string, any[]>(), modelChanges: any[] = [], compactions: string[] = [], interrupts: string[] = [], agents: Record<string, any> = {
    "dog-operator": {}, "dogs-coordinator": {}, "dog-reviewer-v010": { model: "review-model" }, "dog-advisor-v010": { model: "advisor-model" },
  };
  const context = {
    location: { directory }, storage: store, options: {},
    rpc: { register: async (definition: any, handlers: any) => { rpcs.set(definition.id, handlers); return { dispose() {} }; } },
    agent: { transform: async (callback: any) => callback({ update: (id: string, update: any) => update(agents[id]) }) },
    tool: { list: async () => [{ id: "shell", execute: async (args: any, context: any) => {
        const result = await runWorkCheck(directory, args.command, args.timeout, context.signal);
        return { output: { exit: result.exit, timeout: result.timedOut, status: "completed" }, content: result.output };
      } }],
      transform: async (callback: any) => { callback({ add: (tool: any) => tools.set(tool.name, tool),
        update: (id: string, update: any) => { if (tools.has(id)) update(tools.get(id)); } }); return { dispose() {} }; },
      hook: async (name: string, callback: any) => { hooks.set(`tool:${name}`, callback); return { dispose() {} }; } },
    session: { get: async ({ sessionID }: any) => sessions.get(sessionID), context: async ({ sessionID }: any) => histories.get(sessionID) ?? [],
      hook: async (name: string, callback: any) => { hooks.set(`session:${name}`, callback); return { dispose() {} }; },
      switchModel: async (value: any) => { modelChanges.push(value); }, switchAgent: async () => {},
      compact: async ({ sessionID }: any) => { compactions.push(sessionID); },
      interrupt: async ({ sessionID }: any) => { interrupts.push(sessionID); return { interrupted: true }; },
      prompt: async () => { throw new Error("no synthetic continuation allowed"); }, synthetic: async () => { throw new Error("no synthetic input allowed"); } },
    permission: { hook: async (name: string, callback: any) => { hooks.set(`permission:${name}`, callback); return { dispose() {} }; } }, event: { async *subscribe() {} },
  } as unknown as NativeWorkContext;
  const call = async (name: string, args: unknown = {}, sessionID = "root") => JSON.parse((await tools.get(`sortie_v011_${name}`).execute(args, { sessionID })).content);
  return { context, tools, hooks, rpcs, sessions, histories, modelChanges, compactions, interrupts, agents, call };
}

test("v0.11 native hooks execute the whole flow, Fast settings, compaction and root-only review", () => fixture(async directory => {
  const fixture = nativeFixture(directory);
  const cleanup = await createUserProxyPlugin().setup(fixture.context);
  try {
    assert.equal(fixture.agents["dog-operator"].model.id, "gpt-6-sol");
    assert.equal(fixture.agents["dogs-coordinator"].model.id, "gpt-6-luna-fast");
    assert.equal(fixture.agents["dog-reviewer-v010"].model, "review-model");
    assert.equal(fixture.agents["dog-advisor-v010"].model, "advisor-model");
    await fixture.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-1", prompt: { text: "Complete both files; preserve the oracle." } });
    const prepared = await fixture.call("start_work");
    await fixture.hooks.get("tool:execute.before")({ sessionID: "root", id: "call", tool: "subagent", input: prepared.task });
    const childPrompt = { sessionID: "child", prompt: { text: `You are a subagent spawned by another session.\n${prepared.task.prompt}` } };
    await fixture.hooks.get("session:prompt")(childPrompt);
    assert.match(childPrompt.prompt.text, /preserve the oracle/);
    for (const tool of ["grep", "glob", "patch", "shell"]) await fixture.hooks.get("tool:execute.before")({ sessionID: "child", tool, input: {} });
    const request = { sessionID: "child", system: [], options: {}, tools: { sortie_v011_review_work: {}, sortie_v011_check: {} } };
    await fixture.hooks.get("session:context")(request);
    assert.equal((request.options as any).serviceTier, "priority");
    const frame = { sessionID: "child", model: { ...V011_ROUTES.worker, id: "gpt-6-luna" }, frame: JSON.stringify({ type: "response.create", model: "gpt-6-luna" }) };
    await fixture.hooks.get("session:experimental.ws.send")(frame);
    assert.equal(JSON.parse(frame.frame).service_tier, "priority");
    const http = { sessionID: "child", model: { ...V011_ROUTES.worker, id: "gpt-6-luna" },
      request: new Request("https://example.invalid/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-luna", input: "test" }) }) };
    await fixture.hooks.get("session:http.request")(http);
    assert.equal((await http.request.json()).service_tier, "priority");
    assert.equal("sortie_v011_review_work" in request.tools, false);
    assert.equal((await fixture.call("compact", {}, "child")).status, "compaction-queued");
    assert.deepEqual(fixture.compactions, ["child"]);
    await assert.rejects(fixture.call("review_work", { decision: "accept", assessment: "self accept", checks: [] }, "child"), /operator-only/);
    await completeFiles(directory);
    const pass = await fixture.call("check", { command: "node check.mjs" }, "child");
    await fixture.hooks.get("tool:execute.after")({ sessionID: "root", id: "call", tool: "subagent", status: "completed", result: { content: "done" } });
    await fixture.call("work_status");
    const accepted = await fixture.call("review_work", { decision: "accept", assessment: "Both files are done; inspected the unchanged oracle.", checks: [pass.id] });
    assert.equal(accepted.receipt.status, "succeeded");
    await fixture.hooks.get("tool:execute.before")({ sessionID: "ordinary", tool: "patch", input: {} });
    await assert.rejects(fixture.call("start_work", {}, "ordinary"), /profile-session-inactive/);
  } finally { cleanup(); }
}));

test("v0.11 pacing counts all tools and protects running processes without certifying progress", () => {
  const progress = newWorkProgress(1000);
  progress.tools = 11;
  assert.equal(progressLimit(progress, 2000, 180000, 12), null);
  progress.tools++;
  assert.match(progressLimit(progress, 2000, 180000, 12)!, /discovery-limit/);
  progress.tools = 0;
  progress.active.push({ id: "read", tool: "read", detail: "README", startedAt: 179000 });
  assert.match(progressLimit(progress, 181000, 180000, 12)!, /planning-timeout/);
  progress.active.push({ id: "check", tool: "sortie_v011_check", detail: "npm test", startedAt: 1001 });
  assert.equal(progressLimit(progress, 999000, 180000, 12), null);
});

test("v0.11 repairs interrupted outgoing tool history without altering native evidence or valid results", () => {
  const call = (id: string) => ({ type: "tool-call", id, name: "shell", input: { command: "run-once" } });
  const valid = { role: "tool", content: [{ type: "tool-result", id: "a", name: "shell", result: { type: "text", value: "exit 7" } }] };
  const messages = [{ role: "assistant", content: [call("a"), { ...call("b"), namespace: "functions" }] }, valid,
    { role: "user", content: [{ type: "text", text: "Continue and preserve existing jobs." }] },
    { role: "assistant", content: [call("c")] }];
  const original = structuredClone(messages), repaired = repairWorkToolHistory(messages);
  assert.deepEqual(repaired.repaired, ["b", "c"]);
  assert.deepEqual(messages, original);
  assert.equal(repaired.messages[1], valid);
  assert.equal(repaired.messages[2].content[0].result.type, "error");
  assert.equal(repaired.messages[2].content[0].namespace, "functions");
  assert.match(repaired.messages.at(-1)!.content[0].result.value, /unverified.*do not duplicate/);
  assert.equal(repairWorkToolHistory(repaired.messages).messages, repaired.messages);
  const hosted = [{ role: "assistant", content: [{ ...call("hosted"), providerExecuted: true }] }];
  assert.equal(repairWorkToolHistory(hosted).messages, hosted);
});

test("v0.11 native child card receives live observations and a planning stall yields internally without a blind retry", () => fixture(async directory => {
  const f = nativeFixture(directory);
  Object.assign(f.context.options!, { maxPlanningMs: 70, progressIntervalMs: 10 });
  const updates: any[] = [];
  let finish!: () => void;
  const interrupted = new Promise<void>(resolve => { finish = resolve; });
  f.context.session.interrupt = async ({ sessionID }: any) => { f.interrupts.push(sessionID); finish(); };
  f.tools.set("subagent", { execute: async (_input: any, execution: any) => {
    await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: _input.prompt } });
    await execution.progress({ sessionID: "child", native: "retained" });
    await interrupted;
    return { content: "Native child interrupted", metadata: { sessionID: "child" } };
  } });
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "user", prompt: { text: "Run the existing controller and retain results." } });
    const ready = await f.call("start_work");
    await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "dispatch", tool: "subagent", input: ready.task });
    const result = await f.tools.get("subagent").execute(ready.task, { sessionID: "root", id: "dispatch", progress: async (value: any) => updates.push(value) });
    await f.hooks.get("tool:execute.after")({ sessionID: "root", id: "dispatch", tool: "subagent", status: "completed", result });
    assert.deepEqual(f.interrupts, ["child"]);
    assert(updates.some(value => value.sessionID === "child" && value.native === "retained" && value.sortie_progress.phase === "thinking"));
    assert(updates.some(value => value.description.includes("軌道修正")));
    const status = await f.call("work_status");
    assert.equal(status.phase, "yielded"); assert.equal(status.attempts, 1);
    assert.equal(status.progress.commands, 0);
    await assert.rejects(f.call("start_work"), /work-progress-blocked/);
    const resumed = await f.call("start_work", { instructions: "Run node existing-controller.mjs with the frozen manifest now." });
    assert.equal(resumed.task.sessionID, "child"); assert.equal(resumed.work_id, ready.work_id); assert.equal(resumed.attempts, 1);
  } finally { cleanup(); }
}));

test("v0.11 arbitrary shell, patch, noise checks and redispatch retain receipt clocks and unresolved interventions", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store);
  const receivedAt = Date.now() - 5000;
  await loop.observe("root", { id: "original", text: "Fix both files and preserve tests", at: receivedAt });
  const work = await loop.start("root", "");
  await loop.admit("root", "one", loop.task(work)); await loop.claim("root", "child", loop.task(work).prompt);
  for (const tool of ["shell", "patch", "read", "shell"]) {
    const id = `activity-${Math.random()}`;
    await loop.activity("root", "child", { id, tool, detail: "irrelevant", startedAt: Date.now() });
    await loop.activity("root", "child", { id, tool, detail: "", startedAt: 0 }, { status: "completed", exit: 0 });
  }
  const noise = await loop.check("root", "child", "node --version", 10000);
  let progress = (await loop.current("root"))!.progress!;
  assert.equal(progress.startedAt, receivedAt); assert.equal(progress.reviewedAt, receivedAt);
  assert.match(progressLimit(progress, Date.now(), 100, 3)!, /discovery-limit/);
  await loop.stall("root", "one", "No target result");
  const restored = new WorkLoop(directory, store);
  const resumed = await restored.start("root", "Run the actual oracle now", [], 10);
  await restored.admit("root", "two", restored.task(resumed)); await restored.claim("root", "child", restored.task(resumed).prompt);
  progress = (await restored.current("root"))!.progress!;
  assert.equal(progress.startedAt, receivedAt); assert.equal(progress.reviewedAt, receivedAt); assert(progress.stopped);
  assert.equal(progress.tools, 4); assert.equal(progress.interventions!.length, 1);
  const failed = await restored.check("root", "child", "node check.mjs", 10000);
  assert.notEqual(failed.exit, 0);
  assert((await restored.current("root"))!.progress!.stopped, "A check must not clear an intervention automatically");
  await restored.stall("root", "two", "Inspect actual reproduction");
  const confirmed = await restored.start("root", "The existing oracle really reproduces pending files; fix them.", [failed.id]);
  assert.equal(confirmed.progress!.stopped, undefined);
  assert(confirmed.progress!.interventions![0].resolvedAt);
  await assert.rejects(restored.start("root", "Replay old evidence", [noise.id]), /missing-or-old/);
  assert.equal(confirmed.checks.find(check => check.id === failed.id)!.exit, failed.exit);
  assert.equal(confirmed.attempts, 2);
}));

test("v0.11 a pacing return with completed behavior needs no ceremonial child redispatch", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop); await completeFiles(directory);
  const pass = await loop.check("root", "child", "node check.mjs", 10000);
  await loop.stall("root", "call-1", "Planning interval elapsed before final child report");
  await assert.rejects(loop.review("root", "accept", "Still awaiting native settlement", [pass.id]), /not-ready-for-review/);
  await loop.settled("root", "call-1", false, "Interrupted native call; existing check retained");
  await loop.inspect("root", "root");
  const result = await loop.review("root", "accept", "Both files and unchanged check inspected; no implementation remains", [pass.id]);
  assert.equal(result.phase, "completed"); assert.equal(result.attempts, 1);
}));

test("v0.11 the operator can complete required validation after a settled pacing return without redispatch", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store); const original = await start(loop);
  await loop.stall("root", "call-1", "Child yielded before required verification");
  await assert.rejects(loop.check("root", "root", "node check.mjs", 10000), /check-not-owned/);
  await loop.settled("root", "call-1", false, "Native child has stopped; verification remains");
  const restored = new WorkLoop(directory, store);
  await assert.rejects(restored.check("root", "child", "node check.mjs", 10000), /check-not-owned/);
  await assert.rejects(restored.check("root", "unrelated", "node check.mjs", 10000), /check-not-owned/);
  const failed = await restored.check("root", "root", "node check.mjs", 10000);
  assert.equal(failed.exit, 1);
  const syntax = await restored.check("root", "root", "node --check check.mjs", 10000);
  await restored.inspect("root", "root");
  await assert.rejects(restored.review("root", "accept", "Only syntax passed after the yield", [syntax.id]), /unresolved-checks/);
  await completeFiles(directory);
  const passed = await restored.check("root", "root", "node check.mjs", 10000);
  const finalSyntax = await restored.check("root", "root", "node --check check.mjs", 10000);
  assert.equal(passed.exit, 0);
  const retained = (await restored.current("root"))!;
  assert.equal(retained.id, original.id); assert.equal(retained.child, "child"); assert.equal(retained.attempts, 1);
  assert.equal(retained.phase, "yielded"); assert(retained.progress!.stopped);
  assert.equal(retained.checks.find(check => check.id === failed.id)!.exit, 1);
  await restored.inspect("root", "root");
  const accepted = await restored.review("root", "accept", "Both files pass the original required oracle after recovery", [passed.id, finalSyntax.id]);
  assert.equal(accepted.phase, "completed"); assert.equal(accepted.attempts, 1);
}));

test("v0.11 validation after a pacing return cannot override an explicit user stop", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop);
  await loop.stall("root", "call-1", "Yield before validation");
  await loop.settled("root", "call-1", false, "Child stopped");
  await loop.interrupt("root");
  await assert.rejects(loop.check("root", "root", "node check.mjs", 10000), /check-not-owned/);
  assert.equal((await loop.current("root"))!.checks.length, 0);
}));

test("v0.11 first operator tool executes a known command and cold replay cannot launch it twice", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store);
  const cleanup = await createUserProxyPlugin().setup(f.context);
  const command = `node -e "require('fs').appendFileSync('launches.txt','one\\n')"`;
  let workID: string;
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Run the supplied command once and verify its output" } });
    const ready = await f.call("start_work", { command }); workID = ready.work_id;
    assert.equal(ready.execution_results[0].exit, 0); assert.equal(ready.child_session_id, null);
    assert.equal(await readFile(join(directory, "launches.txt"), "utf8"), "one\n");
  } finally { cleanup(); }
  const next = nativeFixture(directory, store), finish = await createUserProxyPlugin().setup(next.context);
  try {
    const replay = await next.call("start_work", { command });
    assert.equal(replay.work_id, workID!);
    assert.equal(replay.execution_results.length, 1);
    assert.equal(await readFile(join(directory, "launches.txt"), "utf8"), "one\n");
    const pass = await next.call("check", { command: `node -e "if(require('fs').readFileSync('launches.txt','utf8')!=='one\\n')process.exit(1)"` });
    await next.call("work_status");
    const accepted = await next.call("review_work", { decision: "accept", assessment: "The actual output has exactly one launch and the oracle passed.", checks: [pass.id] });
    assert.equal(accepted.receipt.status, "succeeded");
    for (const heading of ["🐾 SORTIE DOGS", "⚔️ MISSION", "🪙 COST / PACK", "📜 PACK RECORD"]) assert(accepted.return_report.includes(heading));
    assert(accepted.return_report.includes("🏁 完了 1"));
  } finally { finish(); }
}));

test("v0.11 unknown launch intent survives restart and is never silently rerun or accepted", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store);
  await loop.observe("root", { id: "request", text: "Run one job" }); await loop.start("root", "");
  const command = await loop.beginCommand("root", "native-call", "node runner.mjs", 10000);
  assert(command.launch);
  const next = new WorkLoop(directory, store);
  assert.equal((await next.beginCommand("root", "new-call", "node runner.mjs", 10000)).launch, false);
  await next.inspect("root", "root");
  await assert.rejects(next.review("root", "accept", "Unknown launch is not success", []), /command-unverified/);
}));

test("v0.11 native prelaunch permission rejection permits a linked corrected command without inventing an exit", () => fixture(async directory => {
  const f = nativeFixture(directory), list = f.context.tool.list!.bind(f.context.tool);
  f.context.tool.list = async () => [{ id: "shell", execute: async (input: any, execution: any) => {
    if (input.command === "denied command") {
      // Native 2.0.14 rejects static rules before invoking permission.evaluate.
      throw Object.assign(Error("Unable to execute command"), { _tag: "Tool.Error", error: { _tag: "Permission.BlockedError", permission: "shell", resources: [input.command] } });
    }
    return (await list()).find(tool => tool.id === "shell")!.execute(input, execution);
  } }] as any;
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Run the documented local check" } });
    const denied = await f.call("start_work", { command: "denied command" });
    const original = denied.execution_results[0];
    assert.equal(original.exit, null); assert.equal(original.nativeStatus, "rejected");
    const retried = await f.call("start_work", { command: "node --version", retry_command: original.id });
    assert.equal(retried.execution_results[1].exit, 0); assert.equal(retried.execution_results[1].retryOf, original.id);
    const replay = await f.call("start_work", { command: "node --version", retry_command: original.id });
    assert.equal(replay.execution_results.length, 2);
    await f.call("work_status");
    assert.equal((await f.call("review_work", { decision: "accept", assessment: "The native denial launched no process; inspected the corrected local result", checks: [] })).receipt.status, "succeeded");
  } finally { cleanup(); }
}));

test("v0.11 an unrelated permission denial cannot turn an ambiguous native launch into a safe retry", () => fixture(async directory => {
  const f = nativeFixture(directory);
  f.context.tool.list = async () => [{ id: "shell", execute: async () => {
    await f.hooks.get("permission:evaluate")({ sessionID: "root", action: "shell", effect: "deny", source: { type: "tool", id: "other-call" } });
    throw Error("Terminal result unavailable");
  } }] as any;
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Run the known job once" } });
    const result = JSON.parse((await f.tools.get("sortie_v011_start_work").execute({ command: "node one-shot.mjs" }, { sessionID: "root", id: "owned-call" })).content);
    assert.equal(result.execution_results[0].nativeStatus, undefined);
    await assert.rejects(f.call("start_work", { command: "node one-shot.mjs", retry_command: result.execution_results[0].id }), /retry-unverified/);
  } finally { cleanup(); }
}));

test("v0.11 auxiliary SSE usage counts cached input and reasoning once without consuming native delivery", async () => {
  const value = { type: "response.completed", response: { id: "response-title", usage: { input_tokens: 100, output_tokens: 20,
    input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } } } };
  const payload = `event: response.completed\ndata: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`;
  const response = new Response(payload, { headers: { "content-type": "text/event-stream" } }), receipts: any[] = [];
  await observeAuxiliaryResponse(response.clone(), async event => { const receipt = auxiliaryResponseUsage(V011_ROUTES.worker, event); if (receipt) receipts.push(receipt); });
  assert.equal(await response.text(), payload); assert.equal(receipts.length, 1);
  assert.equal(receipts[0].tokens, 120);
  assert(Math.abs(receipts[0].usd - 0.0000328) < 1e-12); // Fast: 60 uncached, 40 cached, 20 output including reasoning.
  const baseLuna = { providerID: "openai", id: "gpt-6-luna" };
  assert(Math.abs(auxiliaryResponseUsage(baseLuna, value)!.usd! - 0.0000164) < 1e-12); // Independently configured support routes keep standard pricing.
  assert.equal(auxiliaryResponseUsage(baseLuna, value, "priority")!.usd, receipts[0].usd);
  assert.equal(receipts[0].tier, undefined); assert.equal(receipts[0].requestedTier, "priority");
  assert.equal(auxiliaryResponseUsage(V011_ROUTES.worker, { response: { usage: { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 4 } } } }), undefined);
});

test("v0.11 headerless native title streams retain chunked multiline usage and preserve response delivery", async () => {
  const parts = ['eve', 'nt: response.completed\r\nda', 'ta: {"response":\r\ndata: {"usage":{"input_tokens":100,"output_tokens":20}}}\r\n\r\ndata: [DONE]\r\n\r\n'];
  const response = new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close();
  } }));
  assert.equal(response.headers.get("content-type"), null);
  const receipts: any[] = [];
  await observeAuxiliaryResponse(response.clone(), async event => { const receipt = auxiliaryResponseUsage(V011_ROUTES.worker, event); if (receipt) receipts.push(receipt); });
  assert.equal(receipts.length, 1); assert.equal(receipts[0].tokens, 120); assert(receipts[0].usd > 0);
  assert.equal(await response.text(), parts.join(""));
});

test("v0.11 five-field overview preserves failure, stale-source, pending and accepted-result distinctions", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop);
  const fail = await loop.check("root", "child", "node check.mjs", 10000);
  let view = workOverview((await loop.current("root"))!);
  assert.match(view.done, /PASSはまだありません/); assert.match(view.blocked, /未成功/);
  assert.match(view.cost, /0ドルではありません/);
  await completeFiles(directory);
  const pass = await loop.check("root", "child", "node check.mjs", 10000);
  view = workOverview((await loop.current("root"))!);
  assert.match(view.done, /PASS 1件/); assert.match(view.done, /未受理/); assert.match(view.returned, /a.txt, b.txt/);
  assert.doesNotMatch(view.blocked, /未成功/);
  await writeFile(join(directory, "a.txt"), "wrong\n"); await loop.inspect("root", "root");
  view = workOverview((await loop.current("root"))!);
  assert.match(view.done, /PASSはまだありません/); assert.match(view.blocked, /再確認待ち/);
  await completeFiles(directory);
  let release!: () => void;
  const waiting = loop.check("root", "child", "node check.mjs", 10000, undefined, async () => {
    await new Promise<void>(resolve => { release = resolve; }); return { exit: 0, timedOut: false, interrupted: false, output: "PASS" };
  });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  view = workOverview((await loop.current("root"))!);
  assert.match(view.current, /必須検証実行中/); assert.doesNotMatch(view.done, /PASS 1件/); assert.doesNotMatch(view.blocked, /未成功/);
  release(); const final = await waiting;
  await loop.settled("root", "call-1", true, "Both files complete"); await loop.inspect("root", "root");
  const accepted = await loop.review("root", "accept", "Both files verified on final source", [final.id]);
  await loop.usage("root", accepted.id, { tokens: null, usd: null, models: [], estimatedUsd: 0.25, unpricedRequests: 2, meteredAt: 100 });
  view = workOverview((await loop.current("root"))!);
  assert.equal(view.phase, "returned"); assert.match(view.done, /依頼全体を検証・受理/);
  assert.match(view.returned, /受理時の変更: a.txt, b.txt/); assert.match(view.cost, /\$0.2500.*使用量不明 2件/);
  assert.equal(view.cost_as_of, 100); assert.equal((await loop.current("root"))!.checks[0].id, fail.id);
  assert.notEqual(final.id, pass.id);
}));

test("v0.11 overview RPC reads durable evidence without execution, scopes sessions and clears the previous task", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store), cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    const read = (sessionID = "root") => f.rpcs.get("sortie-work-overview").read({ sessionID });
    assert.equal((await read()).overview, null); assert.equal((await read("ordinary")).overview, null);
    f.sessions.set("foreign", { id: "foreign", agent: "dog-operator", location: { directory: directory + "/elsewhere" } });
    await assert.rejects(read("foreign"), /location-mismatch/);
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-1", prompt: { text: "Complete both files" } });
    assert.match((await read()).overview.current, /最初の実行待ち/);
    const ready = await f.call("start_work");
    await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "call", tool: "subagent", input: ready.task });
    await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
    await completeFiles(directory); const pass = await f.call("check", { command: "node check.mjs" }, "child");
    await f.hooks.get("tool:execute.after")({ sessionID: "root", id: "call", tool: "subagent", status: "completed", result: { content: "Done" } });
    await f.call("work_status");
    const accepted = await f.call("review_work", { decision: "accept", assessment: "Both files and oracle verified", checks: [pass.id] });
    assert.equal((await read()).overview.phase, "returned"); assert.equal((await read("child")).overview.work_id, ready.work_id);
    assert.match(accepted.return_report, /任務一覧/);
    const returned = (await read()).overview;
    await writeFile(join(directory, "after-acceptance.txt"), "Later workspace edit, outside the accepted request\n");
    const later = await f.call("work_status");
    assert.equal(later.accepted_source_current, false); assert(later.changed_paths.includes("after-acceptance.txt"));
    assert.equal(later.overview.returned, returned.returned); assert.equal(later.overview.source_as_of, returned.source_as_of);
    assert.doesNotMatch(later.overview.returned, /after-acceptance/); assert.equal(later.return_report, accepted.return_report);
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-2", prompt: { text: "Explain the result" } });
    const pending = (await read()).overview;
    assert.equal(pending.work_id, null); assert.match(pending.current, /依頼受付/); assert.doesNotMatch(pending.done, /受理/);
    assert.equal((await new WorkLoop(directory, store).current("root"))!.presentation!.report, accepted.return_report);
    assert.equal(f.histories.size, 0); assert.deepEqual(f.compactions, []);
  } finally { cleanup(); }
}));

test("v0.11 native title and late generate usage survive acceptance, archival and replay without repricing", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store), cleanup = await createUserProxyPlugin().setup(f.context);
  const event = (kind: string, frame: unknown) => ({ sessionID: "root", kind, model: V011_ROUTES.worker, frame: JSON.stringify(frame) });
  const send = async (kind: string, id: string) => {
    await f.hooks.get("session:experimental.ws.send")(event(kind, { type: "response.create", model: "gpt-6-luna" }));
    await f.hooks.get("session:experimental.ws.receive")(event(kind, { type: "response.created", response: { id } }));
  };
  const finish = async (kind: string, id: string) => f.hooks.get("session:experimental.ws.receive")(event(kind, { type: "response.completed",
    response: { id, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } } } }));
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Complete both files" } });
    await send("title", "title"); // Native title can start before start_work.
    const ready = await f.call("start_work"); await finish("title", "title");
    await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "dispatch", tool: "subagent", input: ready.task });
    await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
    await completeFiles(directory); const pass = await f.call("check", { command: "node check.mjs" }, "child");
    await send("generate", "late");
    await f.hooks.get("tool:execute.after")({ sessionID: "root", id: "dispatch", tool: "subagent", status: "completed", result: { content: "Done" } });
    await f.call("work_status");
    const accepted = await f.call("review_work", { decision: "accept", assessment: "Both files and unchanged oracle inspected", checks: [pass.id] });
    assert.equal(accepted.cost.rows[0].requests, 2); assert.equal(accepted.cost.rows[0].unpriced_requests, 1);
    await new Promise(resolve => setTimeout(resolve, 2));
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "next-request", prompt: { text: "Explain the result" } });
    await f.call("start_work"); await finish("generate", "late"); await finish("generate", "late");
    const loop = new WorkLoop(directory, store), previous = (await loop.retained()).find(work => work.id === ready.work_id)!;
    assert.equal(previous.usage!.tokens, 240); assert(Math.abs(previous.usage!.usd! - 0.0000656) < 1e-12);
    assert.equal(Object.keys(previous.usageReceipts!).length, 2); assert.equal(previous.presentation!.report, accepted.return_report);
    assert.equal((await loop.auxiliaryReceipts("root", (await loop.current("root"))!.startedAt)).length, 0);
  } finally { cleanup(); }
}));

test("v0.11 overlapping auxiliary HTTP responses are correlated to their native request, not the last request of that kind", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store), cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Complete both files" } });
    await f.call("start_work");
    const first = { sessionID: "root", kind: "generate", model: V011_ROUTES.worker, request: new Request("https://example.invalid/responses", { method: "POST", body: "{}" }) };
    const second = { ...first, request: new Request(first.request) };
    await f.hooks.get("session:http.request")(first); await f.hooks.get("session:http.request")(second);
    const loop = new WorkLoop(directory, store), before = await loop.auxiliaryReceipts("root", 0);
    assert.equal(before.length, 2);
    // Return in reverse order; both requests must retain their own response usage.
    for (const [event, input] of [[second, 200], [first, 100]] as const) {
      await f.hooks.get("session:http.response")({ ...event, response: new Response(JSON.stringify({ usage: { input_tokens: input, output_tokens: 20 } })) });
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !(await loop.auxiliaryReceipts("root", 0)).some(r => r.receipt.tokens === input + 20)) await new Promise(resolve => setTimeout(resolve, 1));
    }
    const after = await loop.auxiliaryReceipts("root", 0);
    assert.equal(after.find(r => r.id === before[0].id)!.receipt.tokens, 120);
    assert.equal(after.find(r => r.id === before[1].id)!.receipt.tokens, 220);
    assert(after.every(r => !r.receipt.pending));
  } finally { cleanup(); }
}));

test("v0.11 a native terminal receipt recovers an ambiguous launch and retry is explicit and idempotent", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store);
  await loop.observe("root", { id: "request", text: "Run the known job once" }); await loop.start("root", "");
  const launched = await loop.beginCommand("root", "first", "node runner.mjs", 10000);
  await loop.nativeCommand("root", launched.command.id, "sh_owned");
  const f = nativeFixture(directory, store);
  let release!: () => void, finish!: () => void;
  const event = new Promise<void>(resolve => { release = resolve; }), done = new Promise<void>(resolve => { finish = resolve; });
  const file = join(directory, "native-output"); await writeFile(file, "large output\n".repeat(10000) + "Native process confirmed stopped");
  (f.context as any).event = { async *subscribe() {
    await event;
    yield { type: "shell.created", data: { info: { id: "sh_owned", command: "node runner.mjs", cwd: directory, file, metadata: { sessionID: "root" }, status: "running" } } };
    yield { type: "shell.exited", data: { id: "sh_owned", status: "killed", exit: null } }; finish();
  } };
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await assert.rejects(loop.beginCommand("root", "retry", "node runner.mjs", 10000, launched.command.id), /retry-unverified/);
    release(); await done;
    const result = await f.call("work_status");
    assert.equal(result.execution_results[0].nativeStatus, "killed");
    assert.equal(result.execution_results[0].status, "interrupted");
    assert(result.execution_results[0].output.length <= 16 * 1024); assert.match(result.execution_results[0].output, /Native process confirmed stopped$/);
    const restored = new WorkLoop(directory, store);
    const retry = await restored.beginCommand("root", "retry", "node runner.mjs", 10000, launched.command.id);
    assert(retry.launch); assert.equal(retry.command.retryOf, launched.command.id);
    assert.equal((await restored.beginCommand("root", "retry-again", "node runner.mjs", 10000, launched.command.id)).launch, false);
    await restored.endCommand("root", retry.command.id, { exit: 0, interrupted: false, output: "real completed result" });
    await rm(file);
    await restored.inspect("root", "root");
    const accepted = await restored.review("root", "accept", "The stopped native attempt was inspected; its explicit retry completed", []);
    assert.equal(accepted.commands!.length, 2); assert.equal(accepted.commands![0].status, "interrupted");
  } finally { cleanup(); }
}));

test("v0.11 host deadline acts before the first operator tool and native resume is explicit", () => fixture(async directory => {
  const f = nativeFixture(directory), notices: any[] = [], interruptions: any[] = [];
  Object.assign(f.context.options!, { maxOperatorPlanningMs: 50, progressIntervalMs: 10 });
  let wake!: () => void; const resumed = new Promise<void>(resolve => { wake = resolve; });
  f.context.session.synthetic = async input => { notices.push(input); };
  f.context.session.interrupt = async input => { interruptions.push(input); wake(); };
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Run the known task now" } });
    await f.hooks.get("session:context")({ sessionID: "root", system: [], options: {}, tools: {} });
    await resumed;
    assert.equal(notices.length, 1); assert.equal(notices[0].resume, false); assert.equal(notices[0].delivery, "steer");
    assert.equal(interruptions[0].resume, true); assert.equal(interruptions[0].sessionID, "root");
    const ready = await f.call("start_work");
    assert.equal(ready.original_requests.length, 1); assert.equal(ready.original_requests[0].id, "request");
    assert.equal(ready.attempts, 0);
  } finally { cleanup(); }
}));

test("v0.11 substantive post-result review keeps the bounded ordinary interval instead of the first-action cutoff", () => fixture(async directory => {
  const f = nativeFixture(directory), notices: any[] = [];
  Object.assign(f.context.options!, { maxOperatorPlanningMs: 50, maxPlanningMs: 200, progressIntervalMs: 10 });
  f.context.session.synthetic = async input => { notices.push(input); };
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Complete both files and inspect all requirements" } });
    await f.call("start_work", { command: "node check.mjs" });
    await f.hooks.get("session:context")({ sessionID: "root", system: [], tools: {}, options: {} });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(notices.length, 0); assert.deepEqual(f.interrupts, []);
    const deadline = Date.now() + 2000;
    while (!notices.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(notices.length, 1); assert.deepEqual(f.interrupts, ["root"]);
  } finally { cleanup(); }
}));

test("v0.11 detached controller reattaches after plugin restart and notifies the same work once", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store), cleanup = await createUserProxyPlugin().setup(f.context);
  const path = join(directory, "controller.json");
  const state = { run_id: "owned-run", input_sha256: "frozen", status: "running", instances: [{ instance_id: "one", status: "running" }] };
  await writeFile(path, JSON.stringify(state));
  await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Run this controller then verify its result" } });
  const ready = await f.call("start_work", { command: "node --version", controller_state: path, stop_command: "node existing-stop.mjs" });
  assert.equal(ready.phase, "waiting");
  await assert.rejects(f.call("review_work", { decision: "accept", assessment: "A launch is not completion", checks: [] }), /not-ready-for-review/);
  cleanup();
  const g = nativeFixture(directory, store), notices: any[] = [];
  let wake!: () => void; const notice = new Promise<void>(resolve => { wake = resolve; });
  g.context.session.synthetic = async input => { notices.push(input); wake(); };
  await writeFile(path, JSON.stringify({ ...state, status: "completed", instances: [{ instance_id: "one", status: "failed" }] }));
  const finish = await createUserProxyPlugin().setup(g.context);
  try {
    await notice;
    const result = await g.call("work_status");
    assert.equal(result.work_id, ready.work_id); assert.equal(result.phase, "review");
    assert.equal(result.controller.snapshot.instances[0].status, "failed");
    assert.equal(notices[0].sessionID, "root"); assert.equal(notices[0].resume, true);
    assert.equal(result.original_requests.length, 1); assert.equal(result.child_session_id, null);
  } finally { finish(); }
  const last = nativeFixture(directory, store);
  last.context.session.synthetic = async () => { throw Error("duplicate terminal notification"); };
  const end = await createUserProxyPlugin().setup(last.context);
  try { assert.equal((await last.call("work_status")).controller.notified, true); } finally { end(); }
}));

test("v0.11 career scope excludes other project fixtures and preserves the accepted report on replay", () => fixture(async directory => {
  const store = storage(), first = new WorkLoop(directory, store); await start(first);
  const otherDirectory = join(directory, "other"); await mkdir(otherDirectory);
  const other = new WorkLoop(otherDirectory, store); await other.observe("other-root", { id: "other-user", text: "Other project" }); await other.start("other-root", "");
  assert.equal((await first.retained()).length, 1); assert.equal((await other.retained()).length, 1);
  await first.presentation("root", "same-receipt", "canonical panel");
  const restored = new WorkLoop(directory, store);
  assert.equal((await restored.presentation("root", "same-receipt", "different text")).report, "canonical panel");
}));

test("v0.11 interrupted validation stays durable and cannot vanish across a host restart", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store); await start(loop);
  let release!: () => void, launched!: () => void;
  const started = new Promise<void>(resolve => { launched = resolve; });
  const pending = loop.check("root", "child", "node check.mjs", 10000, undefined, async () => {
    launched(); await new Promise<void>(resolve => { release = resolve; });
    return { exit: null, timedOut: false, interrupted: true, output: "Native process was interrupted" };
  });
  await started;
  const restored = new WorkLoop(directory, store);
  const admitted = (await restored.current("root"))!.checks;
  assert.equal(admitted.length, 1); assert.equal(admitted[0].pending, true); assert.equal(admitted[0].exit, null);
  await restored.interrupt("root"); release(); await pending;
  const retained = (await restored.current("root"))!.checks[0];
  assert.equal(retained.id, admitted[0].id); assert.equal(retained.interrupted, true);
  assert.equal(retained.pending, false);
  const ready = await restored.start("root", "Continue and resolve the original required check");
  assert.equal(ready.userStopped, undefined);
  await restored.admit("root", "next", restored.task(ready)); await restored.claim("root", "child", restored.task(ready).prompt);
  await completeFiles(directory);
  const pass = await restored.check("root", "child", "node check.mjs", 10000);
  await restored.settled("root", "next", true, "Fixed and reran the original check"); await restored.inspect("root", "root");
  const accepted = await restored.review("root", "accept", "Both files and the original required check were verified", [pass.id]);
  assert.equal(accepted.checks.length, 2); assert.equal(accepted.checks[0].interrupted, true);
}));

test("v0.11 an explicit user stop remains durable while its existing controller finishes", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store);
  await loop.observe("root", { id: "user", text: "Run the known controller" }); await loop.start("root", "");
  await loop.bindController("root", "state.json", "node stop.mjs"); await loop.controller("root", "state.json");
  await loop.interrupt("root");
  const restored = new WorkLoop(directory, store);
  await restored.controller("root", "state.json", { run_id: "same", input_sha256: "frozen", status: "completed", instances: [] });
  const work = (await restored.current("root"))!;
  assert.equal(work.phase, "interrupted"); assert.equal(work.userStopped, true);
}));

test("v0.11 metering survives native compaction and restart without repricing or counting a request twice", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store);
  const cleanup = await createUserProxyPlugin().setup(f.context);
  const before = Date.now();
  await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "user", prompt: { text: "Complete both files" } });
  const ready = await f.call("start_work");
  await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "dispatch", tool: "subagent", input: ready.task });
  await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
  const observed = { id: "native-paid-request", type: "assistant", time: { created: before + 100, completed: before + 200 },
    model: { providerID: "openai", id: "gpt-6-luna-fast" }, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } };
  f.histories.set("child", [observed]);
  await f.hooks.get("session:compaction")({ sessionID: "child", system: [], messages: [], options: {} });
  const saved = (await new WorkLoop(directory, store).current("root"))!.usageReceipts!;
  assert.equal(saved[observed.id].tokens, 120); assert(saved[observed.id].usd! > 0);
  cleanup();
  const g = nativeFixture(directory, store), finish = await createUserProxyPlugin().setup(g.context);
  try {
    // The active native context no longer contains the pre-compaction message.
    g.histories.set("child", []);
    await g.hooks.get("session:compaction")({ sessionID: "child", system: [], messages: [], options: {} });
    // A repeated native ID with different fields must not silently reprice historical usage.
    g.histories.set("child", [{ ...observed, tokens: { ...observed.tokens, input: 999 } }]);
    await g.hooks.get("session:compaction")({ sessionID: "child", system: [], messages: [], options: {} });
    const retained = (await new WorkLoop(directory, store).current("root"))!.usageReceipts!;
    assert.deepEqual(retained, saved);
  } finally { finish(); }
}));

test("v0.11 durable accounting includes the real advisor and final response while the report snapshot stays stable", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store);
  let notify!: () => void, done!: () => void;
  const event = new Promise<void>(resolve => { notify = resolve; }), settled = new Promise<void>(resolve => { done = resolve; });
  (f.context as any).event = { async *subscribe() { await event; yield { type: "session.execution.succeeded", data: { sessionID: "root" } }; done(); } };
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Complete both files" } });
    const ready = await f.call("start_work");
    f.sessions.set("advisor", { id: "advisor", agent: "dog-advisor-v010", parentID: "root" });
    const paid = (id: string, model: string) => ({ id, type: "assistant", time: { created: Date.now() + 1, completed: Date.now() + 2 },
      model: { providerID: "openai", id: model }, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } });
    f.histories.set("advisor", [paid("advice", "gpt-6-astra")]);
    await f.hooks.get("tool:execute.after")({ sessionID: "root", id: "advice-call", tool: "subagent", status: "completed", result: { metadata: { sessionID: "advisor" }, content: "Bounded technical advice" } });
    await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "dispatch", tool: "subagent", input: ready.task });
    await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
    await completeFiles(directory);
    const pass = await f.call("check", { command: "node check.mjs" }, "child");
    await f.hooks.get("tool:execute.after")({ sessionID: "root", id: "dispatch", tool: "subagent", status: "completed", result: { content: "Verified" } });
    await f.call("work_status");
    const accepted = await f.call("review_work", { decision: "accept", assessment: "Both files verified", checks: [pass.id] });
    assert.equal(accepted.cost.rows.find((row: any) => row.role === "dog-advisor-v010").requests, 1);
    f.histories.set("root", [paid("acceptance", "gpt-6-sol"), paid("final", "gpt-6-sol")]);
    notify(); await settled;
    const work = (await new WorkLoop(directory, store).current("root"))!;
    assert.deepEqual(Object.keys(work.usageReceipts!).sort(), ["acceptance", "advice", "final"]);
    assert.equal(work.usage!.tokens, 360); assert.equal(work.presentation!.report, accepted.return_report);
  } finally { notify(); cleanup(); }
}));

test("v0.11 a failed controller launch returns for ordinary correction instead of waiting for a nonexistent job", () => fixture(async directory => {
  const f = nativeFixture(directory), cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Run the existing controller and verify its results" } });
    const result = await f.call("start_work", { command: "node -e 'process.exit(7)'", controller_state: "missing-state.json", stop_command: "node existing-stop.mjs" });
    assert.equal(result.phase, "ready"); assert.equal(result.controller.status, "launch-failed");
    assert.equal(result.execution_results[0].exit, 7); assert(result.task);
  } finally { cleanup(); }
}));

test("v0.11 live native commands outlast planning limits, report exits and do not leave a watchdog after completion", () => fixture(async directory => {
  const f = nativeFixture(directory), updates: any[] = [];
  Object.assign(f.context.options!, { maxPlanningMs: 50, progressIntervalMs: 10 });
  f.tools.set("subagent", { execute: async (input: any) => {
    await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: input.prompt } });
    await f.hooks.get("tool:execute.before")({ sessionID: "child", id: "command", tool: "shell", input: { command: "node long-command.mjs" } });
    const result = await runWorkCheck(directory, `node -e "setTimeout(()=>process.exit(7),160)"`, 10000);
    await f.hooks.get("tool:execute.after")({ sessionID: "child", id: "command", tool: "shell", status: "completed", result: { output: { exit: result.exit } } });
    return { content: "Command failed with exit 7", metadata: { sessionID: "child" } };
  } });
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "user", prompt: { text: "Run the documented command." } });
    const ready = await f.call("start_work");
    await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "dispatch", tool: "subagent", input: ready.task });
    const result = await f.tools.get("subagent").execute(ready.task, { sessionID: "root", id: "dispatch", progress: async (value: any) => updates.push(value) });
    await f.hooks.get("tool:execute.after")({ sessionID: "root", id: "dispatch", tool: "subagent", status: "completed", result });
    assert(updates.some(value => value.sortie_progress.phase === "executing" && value.description.includes("long-command")));
    assert.equal(result.metadata.sortie_progress.last.exit, 7);
    assert.equal((await f.call("work_status")).phase, "review");
    const count = updates.length;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(updates.length, count); assert.deepEqual(f.interrupts, []);
  } finally { cleanup(); }
}));

test("v0.11 recovers missed native child completion after a cold plugin restart", () => fixture(async directory => {
  const store = storage(), first = nativeFixture(directory, store);
  const cleanup = await createUserProxyPlugin().setup(first.context);
  await first.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-1", prompt: { text: "Complete the files" } });
  const ready = await first.call("start_work");
  await first.hooks.get("tool:execute.before")({ sessionID: "root", id: "call", tool: "subagent", input: ready.task });
  await first.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
  cleanup();
  const next = nativeFixture(directory, store);
  next.histories.set("root", [{ type: "assistant", content: [{ type: "tool", id: "call", name: "subagent", state: { status: "completed", content: "native result" } }] }]);
  const finish = await createUserProxyPlugin().setup(next.context);
  try { assert.equal((await next.call("work_status")).phase, "review"); assert.equal((await next.call("work_status")).attempts, 1); }
  finally { finish(); }
}));

test("v0.11 cold reconciliation settles an internally yielded native call and retains its real check", () => fixture(async directory => {
  const store = storage(), loop = new WorkLoop(directory, store); await start(loop); await completeFiles(directory);
  const pass = await loop.check("root", "child", "node check.mjs", 10000);
  await loop.stall("root", "call-1", "Internal pacing return");
  const f = nativeFixture(directory, store);
  f.histories.set("root", [{ type: "assistant", content: [{ type: "tool", id: "call-1", name: "subagent", state: { status: "error", error: "Native call returned after interruption" } }] }]);
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    const status = await f.call("work_status");
    assert.equal(status.phase, "yielded"); assert.equal(status.attempts, 1);
    const accepted = await f.call("review_work", { decision: "accept", assessment: "Both actual files and retained behavior test inspected", checks: [pass.id] });
    assert.equal(accepted.receipt.status, "succeeded"); assert.equal(accepted.child_session_id, "child");
  } finally { cleanup(); }
}));

test("v0.11 local pacing returns are not priced as transmissions and task accounting ends at the next request", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store), cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    const at = Date.now();
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "first", prompt: { text: "Complete both files" } });
    const ready = await f.call("start_work");
    await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "dispatch", tool: "subagent", input: ready.task });
    await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
    const local = { id: "unsent", type: "assistant", time: { created: at + 5, completed: at + 6 }, model: V011_ROUTES.worker,
      error: { type: "unknown", message: "work-pacing-yield-before-request: discovery-limit" } };
    f.histories.set("child", [local]);
    await completeFiles(directory); const pass = await f.call("check", { command: "node check.mjs" }, "child");
    await f.hooks.get("tool:execute.after")({ sessionID: "root", id: "dispatch", tool: "subagent", status: "completed", result: { content: "Done" } });
    await f.call("work_status");
    const accepted = await f.call("review_work", { decision: "accept", assessment: "Both files verified", checks: [pass.id] });
    assert.equal(accepted.cost.rows.find((row: any) => row.role === "worker").requests, 0);
    const nextAt = Date.now() + 10, loop = new WorkLoop(directory, store);
    await loop.observe("root", { id: "second", text: "Explain the format", at: nextAt });
    f.histories.set("root", [{ id: "second-response", type: "assistant", model: V011_ROUTES.operator,
      time: { created: nextAt, completed: nextAt + 1 }, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }]);
    await f.hooks.get("session:compaction")({ sessionID: "root", system: [], messages: [], options: {} });
    const old = (await loop.current("root"))!;
    assert.equal(old.usageUntil, nextAt); assert.equal(old.usageReceipts!["second-response"], undefined);
    assert.equal(old.usageReceipts!.unsent.local, true);
  } finally { cleanup(); }
}));

test("v0.11 cumulative pacing yields before another provider request without discarding the completed result", () => fixture(async directory => {
  const store = storage(), f = nativeFixture(directory, store);
  Object.assign(f.context.options!, { maxPlanningMs: 50, progressIntervalMs: 10 });
  const cleanup = await createUserProxyPlugin().setup(f.context);
  try {
    await f.hooks.get("session:prompt")({ sessionID: "root", messageID: "request", prompt: { text: "Complete both files" } });
    const ready = await f.call("start_work");
    await f.hooks.get("tool:execute.before")({ sessionID: "root", id: "dispatch", tool: "subagent", input: ready.task });
    await f.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
    await completeFiles(directory);
    const check = await f.call("check", { command: "node check.mjs" }, "child");
    await new Promise(resolve => setTimeout(resolve, 60));
    await assert.rejects(f.hooks.get("session:context")({ sessionID: "child", system: [], options: {}, tools: {} }), /yield-before-request/);
    assert.deepEqual(f.interrupts, []);
    const work = (await new WorkLoop(directory, store).current("root"))!;
    assert.equal(work.phase, "yielded"); assert(work.progress!.stopped);
    assert.equal(work.checks[0].id, check.id); assert.equal(work.checks[0].exit, 0);
  } finally { cleanup(); }
}));

test("v0.11 reconciles an interrupted native dispatch even when its terminal tool part was not stored", () => fixture(async directory => {
  const store = storage(), first = nativeFixture(directory, store);
  const cleanup = await createUserProxyPlugin().setup(first.context);
  await first.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-1", prompt: { text: "Complete the files" } });
  const ready = await first.call("start_work");
  await first.hooks.get("tool:execute.before")({ sessionID: "root", id: "call", tool: "subagent", input: ready.task });
  cleanup();
  const next = nativeFixture(directory, store);
  next.sessions.get("root").outcome = "interrupted";
  next.sessions.get("root").time = { idle: Date.now() + 1 };
  const finish = await createUserProxyPlugin().setup(next.context);
  try {
    assert.equal((await next.call("work_status")).phase, "interrupted");
    const resumed = await next.call("start_work");
    assert.equal(resumed.phase, "ready"); assert.equal(resumed.attempts, 1);
    assert.equal(resumed.work_id, ready.work_id);
  } finally { finish(); }
}));

test("v0.11 migration installs native assets and backs up the v0.10 user-facing instructions", () => fixture(async directory => {
  await initializeProject(directory, "v010");
  const previous = join(directory, ".opencode/agent/dog-operator.md");
  await writeFile(previous, (await readFile(previous, "utf8")) + "\nUser customization retained in backup.\n");
  const old = await readFile(previous, "utf8");
  const migrated = await initializeProject(directory, "v011");
  assert.equal(migrated.status, "installed");
  assert.equal(await readFile(join(directory, ".opencode/sortie-dogs-v011-backup/agent/dog-operator.md.bak"), "utf8"), old);
  for (const asset of runtimeAssets) assert.equal(await readFile(join(directory, ".opencode", asset.installPath), "utf8"), asset.content);
  assert.equal((await initializeProject(directory, "v011")).status, "unchanged");
}));

test("GPT-6 Fast is the real model plus a priced service tier, never an invented model ID", () => {
  const input = { providerID: "openai", modelID: "gpt-6-luna", uncachedInputTokens: 1000000, cacheReadTokens: 0,
    cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const standard = estimateModelUsageCost(input), fast = estimateModelUsageCost({ ...input, serviceTier: "priority" });
  assert.equal(standard.status, "priced"); assert.equal(fast.status, "priced");
  if (standard.status === "priced" && fast.status === "priced") assert.equal(fast.usd, standard.usd * 2);
  assert.deepEqual(fast, estimateModelUsageCost({ ...input, serviceTier: "fast" }));
});

test("v0.11 acceptance requires the operator's current view of source and user instructions", () => fixture(async directory => {
  const loop = new WorkLoop(directory, storage()); await start(loop); await completeFiles(directory);
  const pass = await loop.check("root", "child", "node check.mjs", 10000);
  await loop.settled("root", "call-1", true, "complete");
  await loop.inspect("root", "child");
  await assert.rejects(loop.review("root", "accept", "claim", [pass.id]), /review-view-stale/);
  await loop.inspect("root", "root");
  await loop.observe("root", { id: "user-2", text: "Also explain why input is preserved." });
  await assert.rejects(loop.review("root", "accept", "old instructions", [pass.id]), /review-view-stale/);
  await loop.inspect("root", "root");
  await writeFile(join(directory, "a.txt"), "wrong\n");
  await assert.rejects(loop.review("root", "accept", "old source", [pass.id]), /review-view-stale/);
}));

test("v0.11 retains native attachments and live steering without exposing acceptance to the child", () => fixture(async directory => {
  const fixture = nativeFixture(directory), cleanup = await createUserProxyPlugin().setup(fixture.context);
  try {
    const files = [{ uri: 'file:///project/example.png', name: 'example.png', mention: { start: 0, end: 1 } }];
    await fixture.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-1", prompt: { text: "Match this reference.", files, skills: [{ id: "design" }] } });
    const prepared = await fixture.call("start_work");
    await fixture.hooks.get("tool:execute.before")({ sessionID: "root", id: "call", tool: "subagent", input: prepared.task });
    const child = { sessionID: "child", prompt: { text: prepared.task.prompt } };
    await fixture.hooks.get("session:prompt")(child);
    assert.deepEqual((child.prompt as any).files, [{ uri: files[0].uri, name: "example.png" }]);
    assert.deepEqual((child.prompt as any).skills, [{ id: "design" }]);
    await fixture.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-2", prompt: { text: "Keep keyboard accessibility." } });
    const request = { sessionID: "child", system: [], options: {}, tools: {} };
    await fixture.hooks.get("session:context")(request);
    assert.match(JSON.stringify(request.system), /Keep keyboard accessibility/);
    await assert.rejects(fixture.hooks.get("tool:execute.before")({ sessionID: "root", tool: "subagent", input: { agent: "general", model: "other" } }), /delegate-not-allowed/);
    await assert.rejects(fixture.hooks.get("session:compaction")({ ...request, model: { providerID: "openai", id: "gpt-6-astra" } }), /requires SOL6 or Luna6/);
  } finally { cleanup(); }
}));

test("v0.11 migration leaves customized reviewer/advisor files and user config in place", () => fixture(async directory => {
  await initializeProject(directory, "v010");
  const config = join(directory, ".opencode/opencode.jsonc");
  const original = '// User settings\n{"agents":{"dog-advisor-v010":{"model":"my-provider/my-advisor"}}}\n';
  await writeFile(config, original);
  const reviewer = join(directory, ".opencode/agent/dog-reviewer-v010.md");
  const custom = (await readFile(reviewer, "utf8")) + '\nUser-specific review requirement.\n';
  await writeFile(reviewer, custom);
  await initializeProject(directory, "v011");
  assert.equal(await readFile(reviewer, "utf8"), custom);
  assert.equal(await readFile(config, "utf8"), original);
  assert.equal((await initializeProject(directory, "v011")).status, "unchanged");
}));

test("v0.11 native shell denial remains a failed receipt and cannot disappear from acceptance", () => fixture(async directory => {
  const fixture = nativeFixture(directory), cleanup = await createUserProxyPlugin().setup(fixture.context);
  try {
    await fixture.hooks.get("session:prompt")({ sessionID: "root", messageID: "user-1", prompt: { text: "Complete both files" } });
    const ready = await fixture.call("start_work");
    await fixture.hooks.get("tool:execute.before")({ sessionID: "root", id: "call", tool: "subagent", input: ready.task });
    await fixture.hooks.get("session:prompt")({ sessionID: "child", prompt: { text: ready.task.prompt } });
    fixture.context.tool.list = async () => [{ id: "shell", execute: async () => { throw Object.assign(new Error("Unable to execute command"), {
      _tag: "Tool.Error", error: { _tag: "Permission.BlockedError", permission: "shell" },
    }); } }];
    const failed = await fixture.call("check", { command: "node check.mjs" }, "child");
    assert.equal(failed.exit, null);
    assert.match(failed.output, /native shell permission denied before launch.*permitted repository runner/);
    await fixture.hooks.get("tool:execute.after")({ sessionID: "root", id: "call", tool: "subagent", status: "completed", result: { content: "Verification blocked" } });
    const status = await fixture.call("work_status", { check_ids: [failed.id] });
    assert.deepEqual(status.unresolved_checks, [failed.id]);
    assert.match(status.check_results[0].output, /native shell permission denied/);
    await assert.rejects(fixture.call("review_work", { decision: "accept", assessment: "No modifications, accept anyway.", checks: [] }), /unresolved-checks/);
    const blocked = await fixture.call("review_work", { decision: "blocked", assessment: "The required oracle is denied by native shell permissions.", checks: [] });
    assert.equal(blocked.phase, "blocked"); assert.equal(blocked.receipt.status, "blocked");
    assert.deepEqual(blocked.unresolved_checks, [failed.id]);
    const resumed = await fixture.call("start_work", { instructions: "Resume once the native permission is available." });
    assert.equal(resumed.work_id, ready.work_id); assert.equal(resumed.task.sessionID, "child");
  } finally { cleanup(); }
}));
