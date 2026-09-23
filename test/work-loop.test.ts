import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { WorkLoop, runWorkCheck, workSource, type WorkStore } from "../dist/core/work-loop.js";
import { createUserProxyPlugin, V011_ROUTES, type NativeWorkContext } from "../dist/plugin/work-loop-v2.js";
import { initializeProject } from "../dist/core/initialize.js";
import { runtimeAssets } from "../dist/runtime-assets-v011.js";
import { estimateModelUsageCost } from "../dist/plugin/model-cost.js";

function storage(): WorkStore {
  const values = new Map<string, unknown>();
  return { get: async key => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); } };
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
  const tools = new Map<string, any>(), hooks = new Map<string, any>(), sessions = new Map<string, any>([
    ["root", { id: "root", agent: "dog-operator", model: V011_ROUTES.operator }],
    ["child", { id: "child", agent: "dogs-coordinator", parentID: "root", model: V011_ROUTES.worker }],
    ["ordinary", { id: "ordinary", agent: "build" }],
  ]);
  const histories = new Map<string, any[]>(), modelChanges: any[] = [], compactions: string[] = [], interrupts: string[] = [], agents: Record<string, any> = {
    "dog-operator": {}, "dogs-coordinator": {}, "dog-reviewer-v010": { model: "review-model" }, "dog-advisor-v010": { model: "advisor-model" },
  };
  const context = {
    location: { directory }, storage: store, options: {},
    agent: { transform: async (callback: any) => callback({ update: (id: string, update: any) => update(agents[id]) }) },
    tool: { list: async () => [{ id: "shell", execute: async (args: any, context: any) => {
        const result = await runWorkCheck(directory, args.command, args.timeout, context.signal);
        return { output: { exit: result.exit, timeout: result.timedOut, status: "completed" }, content: result.output };
      } }],
      transform: async (callback: any) => { callback({ add: (tool: any) => tools.set(tool.name, tool) }); return { dispose() {} }; },
      hook: async (name: string, callback: any) => { hooks.set(`tool:${name}`, callback); return { dispose() {} }; } },
    session: { get: async ({ sessionID }: any) => sessions.get(sessionID), context: async ({ sessionID }: any) => histories.get(sessionID) ?? [],
      hook: async (name: string, callback: any) => { hooks.set(`session:${name}`, callback); return { dispose() {} }; },
      switchModel: async (value: any) => { modelChanges.push(value); }, switchAgent: async () => {},
      compact: async ({ sessionID }: any) => { compactions.push(sessionID); },
      interrupt: async ({ sessionID }: any) => { interrupts.push(sessionID); return { interrupted: true }; },
      prompt: async () => { throw new Error("no synthetic continuation allowed"); }, synthetic: async () => { throw new Error("no synthetic input allowed"); } },
    permission: { hook: async () => ({ dispose() {} }) }, event: { async *subscribe() {} },
  } as unknown as NativeWorkContext;
  const call = async (name: string, args: unknown = {}, sessionID = "root") => JSON.parse((await tools.get(`sortie_v011_${name}`).execute(args, { sessionID })).content);
  return { context, tools, hooks, sessions, histories, modelChanges, compactions, interrupts, agents, call };
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
    fixture.context.tool.list = async () => [{ id: "shell", execute: async () => { throw new Error("native shell permission denied"); } }];
    const failed = await fixture.call("check", { command: "node check.mjs" }, "child");
    assert.equal(failed.exit, null);
    assert.match(failed.output, /native shell permission denied/);
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
