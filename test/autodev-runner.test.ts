import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accounting, initialState, loadProject, main, nativeCost, nextAction,
  observe, parseHandoff, readState, reconcile, reserveSource, runTick, sourceCost, tick, verifyCycle, workPrompt,
} from "../scripts/autodev-runner.mjs";
import { formatNotification, hermesDelivery, notification } from "../scripts/autodev-notifications.mjs";
import { writeAtomicJson } from "../scripts/swebench-lite-supervisor.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autodev-test-"));
  const path = join(root, "project.json");
  await writeFile(path, JSON.stringify({ schema_version: 1, id: "test", workflow: "swebench", directory: root,
    state_root: join(root, "state"), objective: "Complete a real development task", budget: { limit_usd: 300, turn_reserve_usd: 5 } }));
  return { root, path, config: await loadProject(path) };
}

async function delegatedFixture() {
  const value = await fixture();
  await mkdir(value.config.state_root);
  await writeFile(join(value.config.state_root, "standing-owner.txt"),
    "Owner explicitly delegates available local product implementation; preserve Task/model/fee and native acceptance boundaries.");
  value.config.autonomy = { instruction_files: ["standing-owner.txt"], reconsider_blocked_once: true };
  return value;
}

function fakeClient(config: any, failPrompt = false) {
  const calls: any[] = [];
  const data: any = { id: "", messages: [], active: {}, inbox: [], outcome: "succeeded", permissions: [], forms: [] };
  const client = {
    session: {
      create: async (input: any) => { calls.push(["create", input]); data.id = input.id; return { id: input.id }; },
      get: async () => ({ id: data.id, projectID: "project", location: { directory: config.directory }, outcome: data.outcome }),
      list: async () => ({ data: [{ id: data.id }], cursor: {} }),
      active: async () => data.active,
      inbox: { list: async () => data.inbox },
      form: { list: async () => data.forms },
      interrupt: async (input: any) => { calls.push(["interrupt", input]); },
      prompt: async (input: any) => {
        calls.push(["prompt", input]);
        if (failPrompt) throw Error("ambiguous transport failure");
        data.messages.push({ id: "user", type: "user", text: input.text, metadata: input.metadata });
        data.active[data.id] = { type: "running" };
        return { id: "inbox" };
      },
    },
    message: { list: async () => ({ data: data.messages, cursor: {} }) },
    permission: { list: async () => data.permissions },
  };
  const finish = (handoff: any) => {
    data.active = {};
    data.messages.push({ id: `assistant-${data.messages.length}`, type: "assistant", agent: "build",
      model: { providerID: "openai", id: "gpt-6.1-sol" }, time: { completed: Date.now() }, finish: "stop",
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text: `<autodev>${JSON.stringify(handoff)}</autodev>` }] });
  };
  return { client, calls, data, finish };
}

test("two project configs retain one shared runner and the real project contracts", async () => {
  const sortie = await loadProject("scripts/autodev/sortie-dogs.json");
  const vibe = await loadProject("scripts/autodev/vibe-dev-mate.json");
  assert.equal(sortie.directory, process.cwd());
  assert.equal(sortie.budget.limit_usd, 600);
  assert.match(sortie.instructions.join("\n"), /20-minute progress checkpoint/);
  assert.match(sortie.instructions.join("\n"), /mode=complete/);
  assert.match(sortie.instructions.join("\n"), /seed-file fixture/);
  assert.match(vibe.instructions.join("\n"), /exactly one In progress/);
  assert.match(vibe.instructions.join("\n"), /Project.*projects\/12/);
  assert.equal(vibe.directory, resolve(process.cwd(), "../Vibe-Dev-Mate"));
  assert.deepEqual(vibe.required_commands, ["/home/user/.local/bin/gh"]);
  assert.match(vibe.instructions.join("\n"), /overriding only AGENTS.md's Windows gh path/);
  assert.equal(vibe.autonomy.reconsider_blocked_once, true);
  assert.deepEqual(vibe.autonomy.instruction_files, ["owner-instruction-20261010f.txt",
    "owner-instruction-20261010g.txt", "owner-instruction-20261010h.txt"]);
  assert.doesNotMatch(vibe.instructions.join("\n"), /MK2-05-03\) is In progress/);
});

test("active work, input requests, failed native turns and ambiguous admissions never get blind continuation", () => {
  const state = { ...initialState({ id: "test", directory: "/repo", workflow: "swebench" }), session_id: "ses", pending: { id: "dispatch" } };
  const base = { needs_input: false, busy: false, acknowledged: true, settled: true, text: "no handoff" };
  assert.equal(nextAction(state, { ...base, busy: true }).action, "running");
  assert.equal(nextAction(state, { ...base, needs_input: true }).action, "needs-input");
  assert.equal(nextAction(state, { ...base, acknowledged: false }).action, "blocked");
  assert.equal(nextAction(state, { ...base, settled: false }).action, "blocked");
  assert.match(nextAction(state, base).reason, /missing-structured-handoff/);
  assert.equal(nextAction({ ...state, paused: true }, base).action, "paused");
});

test("only changed concrete evidence permits continuation; a plan or changing prose does not", () => {
  const state = { session_id: "ses", pending: { id: "dispatch" }, last_progress: "same" };
  const handoff = { status: "continue", summary: "new words", next_action: "fix the actual defect", evidence: ["/repo/result.json"] };
  const observation = { settled: true, acknowledged: true, text: `<autodev>${JSON.stringify(handoff)}</autodev>` };
  assert.equal(nextAction(state, observation, { fingerprint: "same" }).action, "blocked");
  assert.equal(nextAction(state, observation, { fingerprint: null }).action, "blocked");
  assert.equal(nextAction(state, observation, { fingerprint: "changed" }).action, "dispatch");
  assert.equal(nextAction(state, observation, { fingerprint: "changed", waiting: true }).action, "waiting");
  assert.throws(() => parseHandoff('<autodev>{"status":"continue","summary":"x","evidence":["relative"]}</autodev>'), /absolute/);
});

test("native observed model usage is priced; missing usage remains explicitly unknown", () => {
  const message = { id: "one", type: "assistant", time: { completed: 1 }, model: { providerID: "openai", id: "gpt-6.1-sol" },
    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  assert.equal(nativeCost([message]).priced, 4);
  assert.deepEqual(nativeCost([{ ...message, id: "missing", tokens: undefined }]).unknown, ["missing"]);
});

test("first dispatch is durable and an active subsequent tick does not create or prompt again", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    const state = await readState(config);
    assert.equal(state.pending.status, "accepted");
    assert.equal(state.native_reservation_usd, 5);
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "running");
    assert.deepEqual(fake.calls.map(item => item[0]), ["create", "prompt"]);
    assert.equal((await readState(config)).session_id, state.session_id);
    assert.equal(fake.calls[0][1].permissions, undefined, "existing host permissions are not overridden");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native message pagination passes cursor alone, preserving admission and actual usage", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "review complete", evidence: [] });
    const calls: any[] = [];
    fake.client.message.list = async (input: any) => {
      calls.push(input);
      if (input.cursor) {
        assert.equal(input.order, undefined);
        assert.equal(input.limit, undefined);
        return { data: [fake.data.messages[1]], cursor: {} };
      }
      return { data: [fake.data.messages[0]], cursor: { next: "native-cursor" } };
    };
    const observation = await observe(fake.client, await readState(config));
    assert.equal(observation.acknowledged, true);
    assert.equal(observation.settled, true);
    assert.equal(observation.cost.priced > 0, true);
    assert.equal(calls.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native observation never substitutes an older success for a newer error, pending answer or unfinished step", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "older result", evidence: [] });
    const newer: any = { id: "newer-error", type: "assistant", finish: "error", time: { completed: Date.now() },
      error: { type: "provider.invalid-request", message: "No tool output found for function call private-call." }, content: [] };
    fake.data.messages.push(newer);
    let value = await observe(fake.client, await readState(config));
    assert.equal(value.settled, false, "even an old succeeded Session outcome cannot hide the latest error");
    assert.equal(value.text, "");
    assert.equal(value.terminal.message_id, newer.id);
    assert.deepEqual(value.native_failure, { message_id: newer.id, ...newer.error });
    fake.data.messages.pop();
    fake.data.messages.push({ id: "owner-correction", type: "user", text: "Continue on the released version" });
    value = await observe(fake.client, await readState(config));
    assert.equal(value.acknowledged, true);
    assert.equal(value.settled, false, "a new native owner instruction needs its own result");
    assert.equal(value.text, "");
    fake.data.messages.push({ id: "unfinished", type: "assistant", time: { created: Date.now() }, content: [] });
    value = await observe(fake.client, await readState(config));
    assert.equal(value.settled, false);
    fake.finish({ status: "continue", summary: "new result", evidence: [] });
    value = await observe(fake.client, await readState(config));
    assert.equal(value.settled, true);
    assert.match(value.text, /new result/);
    assert.equal(value.native_failure, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a retained native Session follows its worktree without changing campaign identity or replaying work", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    const before = await readState(config);
    const moved = join(root, "worktree");
    fake.client.session.get = async () => ({ id: fake.data.id, projectID: "project",
      location: { directory: moved }, outcome: fake.data.outcome });
    const result = await tick(config, { execute: true, client: fake.client });
    const after = await readState(config);
    assert.equal(result.action, "running");
    assert.equal(result.native_directory, moved);
    assert.equal(after.directory, before.directory);
    assert.equal(after.session_id, before.session_id);
    assert.deepEqual(after.pending, before.pending);
    assert.equal(after.native_reservation_usd, before.native_reservation_usd);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    assert.match(workPrompt(config, after, {}, result.budget), /Preserve a legitimate worktree move/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("monitor failures notify immediately, retain pending spend, deduplicate, and still fail the command", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  config.notifications = { job_id: "job", delivery: "direct" };
  const sent: string[] = [];
  const notificationOptions = { delivery: async () => ({ current_execution_id: "native-execution" }),
    send: async (_: any, text: string) => { sent.push(text); return { success: true, message_id: "native-message" }; } };
  try {
    await tick(config, { execute: true, client: fake.client });
    const before = await readState(config);
    fake.client.session.get = async () => { throw Error("host observation unavailable"); };
    for (let i = 0; i < 2; i++) await assert.rejects(runTick(config, {
      execute: true, notify: true, client: fake.client }, notificationOptions), /host observation unavailable/);
    const after = await readState(config);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].split("\n").length, 5);
    assert.match(sent[0], /自動監視がエラー/);
    assert.doesNotMatch(sent[0], /host observation unavailable/);
    assert.deepEqual(after.pending, before.pending);
    assert.equal(after.native_reservation_usd, before.native_reservation_usd);
    assert.equal(after.monitoring_error.reason, "host observation unavailable");
    assert.equal(after.paused, before.paused, "observational failure is not authority to cancel or resend native work");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a transport error keeps the reservation and never automatically resends", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config, true);
  try {
    await assert.rejects(tick(config, { execute: true, client: fake.client }), /ambiguous transport/);
    assert.equal((await readState(config)).pending.status, "unknown");
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "blocked");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    assert.equal((await accounting(await readState(config))).held_usd, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("useful completion settles known usage and continues the same session once per evidence change", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  const evidence = join(root, "result.json");
  try {
    await writeFile(evidence, "actual result one");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "first fix verified", evidence: [evidence] });
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    assert.equal(fake.calls.filter(item => item[0] === "create").length, 1);
    fake.finish({ status: "continue", summary: "same result again", evidence: [evidence] });
    const result = await tick(config, { execute: true, client: fake.client });
    assert.equal(result.action, "blocked");
    assert.match(result.reason, /no-new-work-evidence/);
    assert.equal((await readState(config)).native_reservation_usd, 0);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a runner failure pause observes real recovery, waits without resending, and continues once when its original backend finishes", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config), evidence = join(root, "actual-result.json"), supervisor = join(root, "supervisor.json");
  try {
    await writeFile(evidence, "retained actual source work");
    await writeAtomicJson(supervisor, { status: "running", instances: [{ instance_id: "original-attempt" }] });
    await tick(config, { execute: true, client: fake.client });
    fake.data.active = {}; fake.data.outcome = "failed";
    fake.data.messages.push({ id: "api-error", type: "assistant", finish: "error", time: { completed: Date.now() },
      error: { type: "provider.invalid-request", message: "No tool output found for function call private-call." }, content: [] });
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "blocked");
    const paused = await readState(config);
    assert.equal(paused.pause_origin, "runner");
    assert.equal(paused.native_held_usd, 5, "unknown failed usage remains held");
    for (let i = 0; i < 2; i++) {
      const stopped = await tick(config, { execute: true, client: fake.client });
      assert.equal(stopped.action, "blocked");
      assert.equal(stopped.native_failure.type, "provider.invalid-request");
    }
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    fake.data.outcome = "succeeded";
    fake.finish({ status: "wait", summary: "original detached attempt remains active", evidence: [evidence],
      wait_for: [{ kind: "supervisor", path: supervisor }] });
    const waiting = await tick(config, { execute: true, client: fake.client });
    assert.equal(waiting.action, "waiting");
    assert.equal(waiting.recovery.previous_reason, paused.pause_reason);
    const recovered = await readState(config);
    assert.equal(recovered.paused, false);
    assert.equal(recovered.pause_reason, undefined);
    assert.deepEqual(recovered.pending, paused.pending);
    assert.equal(recovered.native_held_usd, paused.native_held_usd);
    assert.equal(recovered.last_recovery.terminal_id, fake.data.messages.at(-1).id);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    recovered.last_progress = waiting.proof.fingerprint;
    await writeAtomicJson(join(config.state_root, "state.json"), recovered);
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "waiting");
    await writeAtomicJson(supervisor, { status: "completed", instances: [{ instance_id: "original-attempt", result: { accepted: true } }] });
    const continuation = await tick(config, { execute: true, client: fake.client });
    assert.equal(continuation.action, "dispatched", "terminal backend change wakes unchanged handoff evidence");
    assert.notEqual(continuation.proof.fingerprint, waiting.proof.fingerprint);
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "running");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
    assert.equal(fake.calls.filter(item => item[0] === "create").length, 1);
    assert.equal((await readState(config)).native_held_usd, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native recovery remains visible during activity and permission waits without queueing another prompt", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    const paused = await readState(config);
    paused.paused = true; paused.pause_origin = "runner";
    paused.pause_reason = "native-turn-not-succeeded; inspect its actual error";
    for (const mode of ["running", "needs-input"]) {
      await writeAtomicJson(join(config.state_root, "state.json"), paused);
      fake.data.active = mode === "running" ? { [fake.data.id]: { type: "running" } } : {};
      fake.data.permissions = mode === "needs-input" ? [{ id: "native-permission" }] : [];
      const result = await tick(config, { execute: true, client: fake.client });
      assert.equal(result.action, mode);
      assert.equal((await readState(config)).paused, false);
      assert.deepEqual((await readState(config)).pending, paused.pending);
      assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovered native stops still preserve owner pauses, external gates, evidence and cumulative budget", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config), evidence = join(root, "actual-result.json");
  try {
    await writeFile(evidence, "real result");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "recovered result", evidence: [evidence] });
    const original = await readState(config);
    const paused = { ...original, paused: true, pause_origin: "runner",
      pause_reason: "native-turn-not-succeeded; inspect its actual error" };
    for (const fields of [{ pause_origin: "owner" }, { pause_origin: undefined },
      ...["campaign-budget-exhausted", "actual Windows-only gate", "acceptance decision pending", "session-creation-unconfirmed"]
        .map(pause_reason => ({ pause_reason }))]) {
      await writeAtomicJson(join(config.state_root, "state.json"), { ...paused, ...fields });
      assert.equal((await tick(config, { execute: true, client: fake.client })).action, "paused");
    }
    await writeAtomicJson(join(config.state_root, "state.json"), { ...paused, last_progress:
      createHash("sha256").update(JSON.stringify([{ path: evidence,
        sha256: createHash("sha256").update("real result").digest("hex") }])).digest("hex") });
    assert.equal((await tick(config, { execute: true, client: fake.client })).reason,
      "no-new-work-evidence; diagnose before continuing");
    await writeAtomicJson(join(config.state_root, "state.json"), { ...paused, native_priced_usd: 299 });
    assert.equal((await tick(config, { execute: true, client: fake.client })).reason, "insufficient-remaining-campaign-budget");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    await writeAtomicJson(join(config.state_root, "state.json"), paused);
    await rm(evidence);
    await assert.rejects(tick(config, { execute: true, client: fake.client }), /ENOENT/);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hermes persists standing authority on every unit and reconsiders an ambiguous stop once without an owner resume", async () => {
  const { root, config } = await delegatedFixture();
  const fake = fakeClient(config), evidence = join(root, "native-source.cpp");
  try {
    await writeFile(evidence, "existing unconnected product source");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", work_id: "card04", summary: "Windows inputs unavailable",
      next_action: "native input source still needs implementation", evidence: [evidence] });
    const result = await tick(config, { execute: true, client: fake.client });
    assert.equal(result.action, "dispatched");
    assert.equal(result.continuation.kind, "reconsider-blocker");
    const admitted = await readState(config);
    assert.equal(admitted.paused, false);
    assert.equal(admitted.autonomous_reconsiderations.length, 1);
    assert.equal(admitted.autonomous_reconsiderations[0].dispatch_id, admitted.pending.id);
    assert.match(fake.calls.at(-1)[1].text, /ONE bounded reconsideration/);
    assert.match(fake.calls.at(-1)[1].text, /Existing stable work_id: card04/);
    for (const [, input] of fake.calls.filter(item => item[0] === "prompt")) {
      assert.match(input.text, /Owner explicitly delegates available local product implementation/);
    }
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "running");
    await writeFile(evidence, "changed diagnostic prose must not refresh the recovery allowance");
    fake.finish({ status: "blocked", work_id: "card04", summary: "same unavailable host, different words", evidence: [evidence] });
    for (let i = 0; i < 2; i++) assert.equal((await tick(config, { execute: true, client: fake.client })).action, "blocked");
    assert.equal((await readState(config)).pause_origin, "runner");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
    assert.equal(fake.calls.filter(item => item[0] === "create").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runner-origin deferred stops continue changed local source work but never reuse unchanged evidence", async () => {
  const { root, config } = await delegatedFixture();
  const fake = fakeClient(config), evidence = join(root, "native-source.cpp");
  try {
    await writeFile(evidence, "actual product source change");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", work_id: "card04", summary: "Windows validation deferred", blocker_kind: "host",
      local_next_action: "connect the local native consumer", evidence: [evidence] });
    const stopped = await readState(config);
    stopped.paused = true; stopped.pause_origin = "runner"; stopped.pause_reason = "Windows validation deferred";
    await writeAtomicJson(join(config.state_root, "state.json"), stopped);
    const result = await tick(config, { execute: true, client: fake.client });
    assert.equal(result.action, "dispatched");
    assert.equal(result.continuation.kind, "local-work");
    assert.equal(result.reason, "connect the local native consumer");
    const state = await readState(config);
    assert.equal(state.paused, false);
    assert.equal(state.pause_origin, undefined);
    state.autonomous_reconsiderations = [{ key: createHash("sha256").update(JSON.stringify({
      work_id: "card04", authority: state.standing_authority.sha256 })).digest("hex") }];
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    fake.finish({ status: "blocked", work_id: "card04", summary: "same result", blocker_kind: "host",
      local_next_action: "different words are not progress", evidence: [evidence] });
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "blocked");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("standing delegation never overrides owner pause, native failure/input, actual exhaustion or missing authority", async () => {
  const { root, path, config } = await delegatedFixture();
  const fake = fakeClient(config), evidence = join(root, "native-source.cpp");
  try {
    await writeFile(evidence, "native source");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "external host", evidence: [evidence] });
    const state = await readState(config), proof = { fingerprint: "native evidence" };
    const observation = { settled: true, acknowledged: true, text: `<autodev>${JSON.stringify({
      status: "blocked", summary: "external host", evidence: [evidence] })}</autodev>` };
    assert.equal(nextAction({ ...state, paused: true, pause_origin: "owner" }, observation, proof, config).action, "paused");
    assert.equal(nextAction({ ...state, paused: true }, observation, proof, config).action, "paused", "legacy pauses are not silently adopted");
    assert.equal(nextAction(state, { ...observation, busy: true }, proof, config).action, "running");
    assert.equal(nextAction(state, { ...observation, needs_input: true }, proof, config).action, "needs-input");
    assert.equal(nextAction(state, { ...observation, acknowledged: false }, proof, config).action, "blocked");
    assert.equal(nextAction(state, { ...observation, settled: false }, proof, config).action, "blocked");
    assert.equal(nextAction(state, observation, null, config).action, "blocked");
    for (const fields of [{ local_work_exhausted: true }, ...["budget", "auth", "permission", "acceptance", "no-resend"]
      .map(blocker_kind => ({ blocker_kind }))]) {
      const text = `<autodev>${JSON.stringify({ status: "blocked", summary: "external host", evidence: [evidence], ...fields })}</autodev>`;
      assert.equal(nextAction(state, { ...observation, text }, proof, config).action, "blocked");
    }
    for (const summary of ["campaign budget exhausted", "追加承認が必要です", "認証期限切れ", "追加費用を認めてください"])
      assert.equal(nextAction(state, { ...observation, text: `<autodev>${JSON.stringify({
        status: "blocked", summary, evidence: [evidence] })}</autodev>` }, proof, config).action, "blocked");
    await main(["pause", "--config", path, "--reason", "external host"]);
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "paused");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    await rm(join(config.state_root, "standing-owner.txt"));
    await assert.rejects(tick(config, { execute: true, client: fake.client }), /ENOENT/);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic reconsideration still checks cumulative budget and retains ambiguous submission without replay", async () => {
  const { root, config } = await delegatedFixture();
  const fake = fakeClient(config), evidence = join(root, "native-source.cpp");
  try {
    await writeFile(evidence, "native source");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", work_id: "card04", summary: "host missing", evidence: [evidence] });
    const state = await readState(config);
    state.native_priced_usd = 299;
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    assert.equal((await tick(config, { execute: true, client: fake.client })).reason, "insufficient-remaining-campaign-budget");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    assert.equal((await readState(config)).autonomous_reconsiderations, undefined);
    state.native_priced_usd = 0; state.paused = false;
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    fake.client.session.prompt = async (input: any) => { fake.calls.push(["prompt", input]); throw Error("ambiguous recovery submission"); };
    await assert.rejects(tick(config, { execute: true, client: fake.client }), /ambiguous recovery/);
    const admitted = await readState(config);
    assert.equal(admitted.pending.status, "unknown");
    assert.equal(admitted.native_reservation_usd, 5);
    assert.equal(admitted.autonomous_reconsiderations.length, 1);
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "blocked");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit owner recovery supersedes missing old evidence without replacing the Session or dropping costs", async () => {
  const { root, path, config } = await fixture();
  const fake = fakeClient(config), instruction = join(root, "owner.txt");
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "old host blocker", evidence: [join(root, "deleted-temp.json")] });
    const before = await readState(config);
    before.paused = true;
    before.pause_origin = "runner";
    before.pause_reason = "old host blocker";
    before.native_held_usd = 5;
    await writeAtomicJson(join(config.state_root, "state.json"), before);
    assert.equal((await tick(config, { client: fake.client })).action, "paused");
    await writeFile(instruction, "Resume the retained task with current evidence");
    await main(["resume", "--config", path, "--instruction", instruction]);
    const result = await tick(config, { execute: true, client: fake.client });
    const after = await readState(config);
    assert.equal(result.action, "dispatched");
    assert.equal(result.reason, "new-owner-instruction");
    assert.equal(result.handoff, null, "do not display the superseded blocker as current");
    assert.equal(result.proof, null, "missing evidence is not fabricated or accepted");
    assert.equal(after.session_id, before.session_id);
    assert.equal(after.native_held_usd, 5);
    assert.equal(after.native_priced_usd > 0, true);
    assert.equal(after.native_reservation_usd, 5);
    assert.equal(fake.calls.filter(item => item[0] === "create").length, 1);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
    assert.match(fake.calls.at(-1)[1].text, /Resume the retained task with current evidence/);
    assert.doesNotMatch(fake.calls.at(-1)[1].text, /Previous verified handoff/);
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "running");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner recovery waits for native activity or input instead of replaying work with missing old evidence", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "old work", evidence: [join(root, "deleted-temp.json")] });
    const state = await readState(config);
    state.next_instruction = "Resume once native work and questions are settled";
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    fake.data.active[fake.data.id] = { type: "running" };
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "running");
    fake.data.active = {};
    fake.data.forms = [{ id: "native-question" }];
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "needs-input");
    assert.equal((await readState(config)).next_instruction, state.next_instruction);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    fake.data.forms = [];
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("autonomous continuation still requires retained evidence; failed native turns are not automatically retried", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "old work", evidence: [join(root, "deleted-temp.json")] });
    await assert.rejects(tick(config, { execute: true, client: fake.client }), /ENOENT/);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    fake.data.outcome = "failed";
    const result = await tick(config, { execute: true, client: fake.client });
    assert.equal(result.action, "blocked");
    assert.match(result.reason, /native-turn-not-succeeded/);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown usage is held once and cumulative budgets survive restarting the runner", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "missing provider usage", evidence: [] });
    delete fake.data.messages.at(-1).tokens;
    await tick(config, { execute: true, client: fake.client });
    await tick(config, { execute: true, client: fake.client });
    assert.equal((await readState(config)).native_held_usd, 5);
    const source = { id: "cycle-1", kind: "supervisor", path: join(root, "supervisor.json"), reservation_usd: 46 };
    await reserveSource(config, source);
    assert.equal((await accounting(await readState(config))).exposure_usd, 51);
    assert.equal((await reserveSource(config, source)).action, "already-reserved");
    await assert.rejects(reserveSource(config, { ...source, id: "duplicate" }), /already-accounted/);
    await assert.rejects(reserveSource(config, { ...source, id: "too-much", path: join(root, "other.json"), reservation_usd: 250 }), /remaining/);
    await assert.rejects(readState({ ...config, budget: { ...config.budget, limit_usd: 600 } }), /identity-changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("historical unknown messages do not hold another reservation for later known turns", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config), evidence = join(root, "result.json");
  try {
    await writeFile(evidence, "actual repair");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "first useful result", evidence: [evidence] });
    delete fake.data.messages.at(-1).tokens;
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    assert.equal((await readState(config)).native_held_usd, 5);
    const state = await readState(config);
    assert.deepEqual(state.pending.unknown_at_start, [fake.data.messages[1].id]);
    fake.finish({ status: "blocked", summary: "await owner", evidence: [] });
    await tick(config, { execute: true, client: fake.client });
    const settled = await readState(config);
    assert.equal(settled.native_held_usd, 5);
    assert.equal(settled.native_reservation_usd, 0);
    assert.equal(settled.native_holds.length, 1);
    assert.equal(settled.native_priced_usd > 0, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy ledger reconciliation retains real unknowns, original state, session and pause", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config), evidence = join(root, "result.json");
  try {
    await writeFile(evidence, "first repair");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "actual result", evidence: [evidence] });
    delete fake.data.messages.at(-1).tokens;
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "await owner", evidence: [] });
    await tick(config, { execute: true, client: fake.client });
    const state = await readState(config);
    delete state.native_holds;
    state.native_held_usd = 10;
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    const prompts = fake.calls.length;
    const receipt = await reconcile(config, { execute: true, client: fake.client });
    const repaired = await readState(config);
    assert.equal(receipt.original_state.native_held_usd, 10);
    assert.equal(repaired.native_held_usd, 5);
    assert.equal(repaired.native_priced_usd, state.native_priced_usd);
    assert.equal(repaired.paused, true);
    assert.equal(repaired.pause_reason, state.pause_reason);
    assert.equal(repaired.session_id, state.session_id);
    assert.equal(fake.calls.length, prompts);
    assert.equal(JSON.parse(await readFile(repaired.last_reconciliation.path, "utf8")).before.held_usd, 10);
    assert.equal((await reconcile(config, { client: fake.client })).after.exposure_usd, receipt.after.exposure_usd);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("no-inference release requires a frozen zero-request replay and never drops other unknown usage", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "await owner", evidence: [] });
    await tick(config, { execute: true, client: fake.client });
    const status = "prepared-environment-image-missing:exact-image";
    const path = join(root, "supervisor.json"), replay = join(root, "replay.json");
    const bytes = JSON.stringify({ failure: status, execution: { command: null, exit_code: null,
      stdout_bytes: 0, stderr_bytes: 0 }, patch_bytes: 0 });
    await writeFile(replay, bytes);
    const safe = { instance_id: "no-inference", held_unknown_usd: 2, result: { status, failure: status,
      usage: { usd: 0, requests: 0, unpriced: [] }, watchdog_events: 0, exit_code: null,
      replay_artifact: { path: replay, sha256: digest(bytes) } } };
    const value = { status: "completed", spent_usd: 0, reserved_usd: 0, held_unknown_usd: 4,
      instances: [safe, { ...safe, instance_id: "unknown-execution", result: { ...safe.result,
        usage: { usd: 0, requests: 1, unpriced: [] } } }] };
    await writeAtomicJson(path, value);
    await reserveSource(config, { id: "evaluation", kind: "supervisor", path, reservation_usd: 4 });
    const planned = await reconcile(config, { client: fake.client });
    assert.equal(planned.releases[0].usd, 2);
    assert.equal(planned.after.sources[0].held, 2);
    assert.equal((await readState(config)).sources[0].no_inference_release, undefined);
    await reconcile(config, { execute: true, client: fake.client });
    const source = (await readState(config)).sources[0];
    assert.equal(sourceCost(source, value).held, 2);
    assert.equal(sourceCost(source, { ...value, spent_usd: 0.1 }).held, 4, "changed evidence re-holds exposure");
    await writeFile(replay, "changed replay");
    const state = await readState(config);
    delete state.sources[0].no_inference_release;
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    await assert.rejects(reconcile(config, { execute: true, client: fake.client }), /replay-unconfirmed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native reconciliation does not run alongside owned work or discard unattributed unknowns", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    await assert.rejects(reconcile(config, { client: fake.client }), /waits-for-owned-work/);
    fake.finish({ status: "blocked", summary: "await owner", evidence: [] });
    await tick(config, { execute: true, client: fake.client });
    fake.data.messages.unshift({ id: "unattributed", type: "assistant", time: { completed: 1 }, content: [] });
    await assert.rejects(reconcile(config, { execute: true, client: fake.client }), /without-settled-dispatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("notifications backfill paused blockers and stdout is not delivery confirmation", async () => {
  const { root, config } = await fixture();
  config.notifications = { job_id: "job", progress_minutes: 30 };
  const result = { action: "paused", reason: "concrete blocker", session_id: "existing", handoff: {
    status: "blocked", summary: "concrete blocker", next_action: "owner decision", evidence: [] },
  inputs: [], budget: { priced_usd: 56, held_usd: 66, exposure_usd: 122, limit_usd: 300 } };
  let status = "running", current = "execution-one";
  const delivery = async (_: any, last: any) => ({ current_execution_id: current,
    ...(last ? { last: { status, id: last.execution_id } } : {}) });
  try {
    await writeAtomicJson(join(config.state_root, "last-output.json"), { signature: "legacy-stdout-only" });
    const text = await notification(config, result, { execute: true, now: 1_000_000, delivery });
    assert.match(text, /停止中/);
    assert.equal(text.split("\n").length, 5);
    assert.doesNotMatch(text, /concrete blocker|owner decision|existing|autodev\//);
    const path = join(config.state_root, "notification-state.json");
    let state = JSON.parse(await readFile(path, "utf8"));
    assert.equal(state.last.execution_id, current);
    assert.equal(state.last.status, "emitted-unverified");
    assert.equal(state.delivered_signature, undefined);
    assert.equal(await notification(config, result, { execute: true, now: 1_120_000, delivery }), null);
    status = "delivered";
    assert.equal(await notification(config, result, { execute: true, now: 1_240_000, delivery }), null);
    state = JSON.parse(await readFile(path, "utf8"));
    assert.equal(state.last.status, "delivered");
    assert.equal(state.delivered_signature, state.last.signature);
    current = "execution-two";
    assert.match(await notification(config, { ...result, reconciliation: { path: "/new/receipt.json" } },
      { execute: true, now: 1_360_000, delivery }), /費用換算/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("progress is bounded at thirty minutes while new input questions are immediate", async () => {
  const { root, config } = await fixture();
  const result = { action: "running", reason: "actual native work", session_id: "existing" };
  const delivery = async (_: any, last: any) => ({ current_execution_id: "execution", ...(last ? { last: { status: "delivered" } } : {}) });
  try {
    assert.match(await notification(config, result, { execute: true, now: 1_000_000, delivery }), /作業中/);
    assert.equal(await notification(config, result, { execute: true, now: 1_120_000, delivery }), null);
    assert.match(await notification(config, result, { execute: true, now: 2_800_000, delivery }), /作業中/);
    const input = { ...result, action: "needs-input", inputs: [{ session_id: "existing", forms: [{ question: "Which option?" }] }] };
    assert.match(await notification(config, input, { execute: true, now: 2_920_000, delivery }), /未回答の質問/);
    assert.equal(await notification(config, input, { execute: true, now: 3_040_000, delivery }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a useful changed handoff is immediate while same-handoff supervisor counts remain rate-limited", async () => {
  const { root, config } = await fixture();
  const delivery = async () => ({ current_execution_id: "execution" });
  const result = { action: "waiting", reason: "結果待ち", inputs: [],
    handoff: { summary: "評価を開始しました。", notification: { outcome: "評価を開始しました。" } },
    proof: { progress: [{ total: 23, finished: 0 }] } };
  try {
    assert.match(await notification(config, result, { execute: true, now: 1_000_000, delivery }), /評価を開始/);
    assert.equal(await notification(config, { ...result, proof: { progress: [{ total: 23, finished: 1 }] } },
      { execute: true, now: 1_120_000, delivery }), null);
    assert.match(await notification(config, { ...result, handoff: { summary: "採点を開始しました。",
      notification: { outcome: "採点を開始しました。" } } }, { execute: true, now: 1_240_000, delivery }), /採点を開始/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery from a stop is immediate rather than hidden by the thirty-minute active progress limit", async () => {
  const { root, config } = await fixture();
  const delivery = async () => ({ current_execution_id: "execution" });
  try {
    assert.match(await notification(config, { action: "blocked", reason: "監視停止" },
      { execute: true, now: 1_000_000, delivery }), /停止/);
    assert.match(await notification(config, { action: "running", reason: "復旧して実作業中" },
      { execute: true, now: 1_120_000, delivery }), /作業中/);
    assert.equal(await notification(config, { action: "running", reason: "復旧して実作業中" },
      { execute: true, now: 1_240_000, delivery }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("API failure notices describe the actual missing tool result without copying private provider payloads", async () => {
  const { root, config } = await fixture();
  config.notifications = { job_id: "job" };
  const delivery = async () => ({ current_execution_id: "cron-execution" });
  const result = { action: "blocked", reason: "native-turn-not-succeeded; inspect its actual error",
    native_failure: { message_id: "private-message", type: "provider.invalid-request",
      message: "No tool output found for function call private-call." } };
  try {
    const text = await notification(config, result, { execute: true, now: 1_000_000, delivery });
    assert.match(text, /ツール結果.*欠損/);
    assert.match(text, /再送しません/);
    assert.doesNotMatch(text, /private-call|private-message|No tool output|provider.invalid-request/);
    assert.equal(text.split("\n").length, 5);
    assert.equal(await notification(config, result, { execute: true, now: 1_120_000, delivery }), null);
    assert.match(await notification(config, { ...result, native_failure: {
      type: "provider.auth", message: "Private token text not for notification" } },
    { execute: true, now: 1_240_000, delivery }), /認証/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual notification previews never consume cron delivery and unknown delivery is not resent", async () => {
  const { root, config } = await fixture();
  config.notifications = { job_id: "job" };
  const result = { action: "paused", reason: "await owner", session_id: "existing" };
  try {
    assert.match(await notification(config, result, { execute: true, delivery: async () => ({}) }), /停止中/);
    await assert.rejects(readFile(join(config.state_root, "notification-state.json")), /ENOENT/);
    await notification(config, result, { execute: true, delivery: async () => ({ current_execution_id: "one" }) });
    assert.equal(await notification(config, result, { execute: true, delivery: async () => ({
      current_execution_id: "two", last: { status: "unknown" } }) }), null);
    assert.deepEqual(await hermesDelivery({ ...config, notifications: undefined }), {});
    assert.match(formatNotification(config, { ...result, inputs: [{ forms: ["actual question"] }] }), /未回答の質問/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all notices are five short Japanese lines without copied English, hashes, paths or identifiers", () => {
  const config = { id: "sortie-dogs-dev23", state_root: "/home/user/private/state" };
  const handoff = { status: "blocked", summary: "日本語: Owner budget decision required before expansion ".repeat(100),
    next_action: "Owner authorization required for additional cumulative budget", evidence: ["/private/log"] };
  for (const action of ["dispatched", "running", "waiting", "paused", "blocked", "complete", "needs-input", "needs-host", "unknown-code"]) {
    const text = formatNotification(config, { action, reason: "large English raw diagnostic", handoff,
      session_id: "ses_private", inputs: [{ forms: [{ question: "Which option?" }] }],
      budget: { priced_usd: 56, held_usd: 66, exposure_usd: 122, limit_usd: 300 } });
    const lines = text.split("\n");
    assert.equal(lines.length, 5);
    assert.equal(lines.every(line => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line)), true);
    assert.equal(lines.every(line => [...line].length <= 100), true);
    assert.doesNotMatch(text, /Owner|Which option|raw diagnostic|ses_private|\/home\/|notification\/|Cronjob Response/);
  }
});

test("autonomous host deferral notices never ask the owner to resume or pretend real-input acceptance", () => {
  for (const continuation of [{ kind: "reconsider-blocker" }, { kind: "local-work", next_action: "native接続の実装を進めます。" }]) {
    const text = formatNotification({ id: "vibe-dev-mate-kanban" }, { action: "dispatched", continuation,
      reason: "authorized-blocker-reconsideration", budget: { exposure_usd: 14, limit_usd: null },
      handoff: { status: "blocked", notification: { question: "Windows側で再開してください。" } } });
    assert.equal(text.split("\n").length, 5);
    assert.match(text, /外部待ちは保持/);
    assert.doesNotMatch(text, /Windows側で再開|受入完了|authorized-blocker/);
  }
  const denied = formatNotification({ id: "vibe-dev-mate-kanban" }, { action: "blocked",
    reason: "campaign-budget-exhausted", continuation: { kind: "reconsider-blocker" },
    budget: { exposure_usd: 300, limit_usd: 300 } });
  assert.match(denied, /累計予算の上限/);
  assert.doesNotMatch(denied, /確認を依頼|作業を開始|外部待ちは保持/);
});

test("Japanese summaries retain current outcomes/questions and suppress repaired historical budget requests", () => {
  const config = { id: "sortie-dogs-dev23" };
  const text = formatNotification(config, { action: "blocked", reason: "Current exposure below required46 budget",
    reconciliation: { path: "/old/receipt" }, budget: { exposure_usd: 122, limit_usd: 300 }, handoff: { notification: {
      outcome: "実操作は完遂。公式採点は0/1。\n詳細は/home/user/logとses_privateへ保持。",
      blocker: "追加予算が必要です。", next_action: "追加予算を承認してください。" } } });
  assert.match(text, /実操作は完遂。公式採点は0\/1/);
  assert.match(text, /以前の予算停止は精算済み/);
  assert.doesNotMatch(text, /追加予算|\/home\/|ses_private/);
  const progress = formatNotification(config, { action: "waiting", reason: "raw English", proof: {
    progress: [{ total: 23, finished: 8, status: "running" }] } });
  assert.match(progress, /23件中8件終了。公式採点は未確定/);
  const question = formatNotification(config, { action: "paused", handoff: { notification: {
    outcome: "新しい作業は未開始です。", question: "既存の記録を保持した入口修正を承認しますか？",
    next_action: "この通知に判断を返信してください。" } } });
  assert.match(question, /承認しますか？/);
  assert.equal(question.split("\n").length, 5);
  const camp = formatNotification({ id: "vibe-dev-mate-kanban" }, { action: "paused",
    reason: "承認済み新Taskは未開始。現Campがrevision 2・節目1に変わり、現行のrevision 0・節目0限定入口ではbindingが成立しない", handoff: {
      summary: "承認済み新Taskは未開始。現Campがrevision 2・節目1に変わり、現行のrevision 0・節目0限定入口ではbindingが成立しない",
      next_action: "現Campの成長・受入契約の変更可否を明示する。" } });
  assert.match(camp, /育成記録の改訂2が入口条件の改訂0に合わず停止/);
  assert.doesNotMatch(camp, /revision|binding|…/);
});

test("direct Hermes send saves its message receipt and never emits a second wrapped cron message", async () => {
  const { root, config } = await fixture();
  config.notifications = { job_id: "job", delivery: "direct", target: "discord:approved" };
  const result = { action: "paused", reason: "現存する記録を扱う判断待ちです。" };
  let sends = 0;
  const send = async (_: any, text: string) => {
    sends++; assert.equal(text.split("\n").length, 5);
    return { success: true, message_id: "actual-message-id" };
  };
  const delivery = async (_: any, last: any) => ({ current_execution_id: "execution",
    ...(last ? { last: { status: "suppressed" } } : {}) });
  try {
    assert.equal(await notification(config, result, { execute: true, delivery, send }), null);
    let state = JSON.parse(await readFile(join(config.state_root, "notification-state.json"), "utf8"));
    assert.equal(state.last.status, "delivered");
    assert.equal(state.last.transport, "hermes-send");
    assert.equal(state.last.delivery_receipt.message_id, "actual-message-id");
    assert.equal(await notification(config, result, { execute: true, delivery, send }), null);
    assert.equal(sends, 1, "local/suppressed cron status cannot overwrite a direct send receipt");
    await notification(config, { ...result, reason: "別の必要な判断待ちです。" }, { execute: true, delivery,
      send: async () => ({ success: true, skipped: true, reason: "duplicate-target" }) });
    state = JSON.parse(await readFile(join(config.state_root, "notification-state.json"), "utf8"));
    assert.equal(state.last.status, "unknown", "a skipped send is not delivery");
    state.last.status = "sending";
    await writeAtomicJson(join(config.state_root, "notification-state.json"), state);
    await notification(config, { ...result, reason: "別の必要な判断待ちです。" }, { execute: true, delivery, send });
    state = JSON.parse(await readFile(join(config.state_root, "notification-state.json"), "utf8"));
    assert.equal(state.last.status, "unknown", "a missing direct receipt survives restart as unknown");
    assert.equal(sends, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hermes delivery binds the live execution ancestry and retains the delivery queue's failure", { skip: process.platform !== "linux" }, async () => {
  const { root, config } = await fixture();
  try {
    await mkdir(join(root, "cron"));
    const fields = (await readFile(`/proc/${process.pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
    const script = `import sqlite3,sys
from pathlib import Path
root,pid,start=sys.argv[1:]
db=sqlite3.connect(str(Path(root)/'cron'/'executions.db'))
db.execute('create table executions(id text,job_id text,pid integer,process_started_at integer,status text,claimed_at text,delivery_outcome text,finished_at text,error text)')
db.execute('insert into executions values(?,?,?,?,?,?,?,?,?)',('live','job',int(pid),int(start),'running','2',None,None,None))
db.execute('insert into executions values(?,?,?,?,?,?,?,?,?)',('past','job',0,0,'completed','1','queued','done',None))
db.commit()
d=sqlite3.connect(str(Path(root)/'cron'/'deliveries.db'))
d.execute('create table deliveries(execution_id text,status text,finished_at text,error text)')
d.execute('insert into deliveries values(?,?,?,?)',('past','failed','done','transport error'))
d.commit()`;
    execFileSync("python3", ["-c", script, root, String(process.pid), fields[19]]);
    config.notifications = { job_id: "job", hermes_home: root };
    const receipt = await hermesDelivery(config, { execution_id: "past" });
    assert.equal(receipt.current_execution_id, "live");
    assert.equal(receipt.last.status, "failed");
    assert.equal(receipt.last.error, "transport error");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("running and absent cost sources keep their exposure; terminal unknown usage is not zero", () => {
  const source = { kind: "supervisor", reservation_usd: 46 };
  assert.equal(sourceCost(source, null).held, 46);
  assert.deepEqual(sourceCost(source, { status: "running", spent_usd: 10, held_unknown_usd: 0, reserved_usd: 16 }),
    { priced: 10, held: 36, unknown: 0, active: true });
  assert.deepEqual(sourceCost(source, { status: "completed", spent_usd: 10, held_unknown_usd: 2, reserved_usd: 0 }),
    { priced: 10, held: 2, unknown: 2, active: false });
  assert.equal(sourceCost({ kind: "probe", reservation_usd: 2 }, { priced_usd: 0.5, unpriced_requests: 1 }).held, 1.5);
  assert.throws(() => sourceCost(source, { status: "completed", spent_usd: null, reserved_usd: 0 }), /invalid-supervisor/);
});

test("exactly filling the budget with an admitted reservation does not interrupt active work", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await writeAtomicJson(join(config.state_root, "state.json"), { ...initialState(config), native_priced_usd: 295 });
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    const result = await tick(config, { execute: true, client: fake.client });
    assert.equal(result.action, "running");
    assert.equal(result.budget.exposure_usd, 300);
    assert.equal(result.budget.spent_or_unknown_usd, 295);
    assert.equal(fake.calls.some(item => item[0] === "interrupt"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only planning does not create sessions, state or cost reservations", async () => {
  const { root, config, path } = await fixture();
  try {
    assert.equal((await tick(config)).action, "dispatch");
    assert.equal((await main(["plan", "--config", path])).budget.limit_usd, 300);
    await assert.rejects(readFile(join(config.state_root, "state.json")), /ENOENT/);
    const prompt = workPrompt(config, initialState(config), {}, { exposure_usd: 0 });
    assert.match(prompt, /existing host authority/);
    assert.match(prompt, /必ず日本語で最大5行/);
    assert.match(prompt, /"notification":\{"outcome"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing canonical host commands report a free, deduplicated needs-host result", async () => {
  const { root, path } = await fixture();
  try {
    const config = await loadProject(path, { required_commands: [join(root, "missing-gh.exe")] });
    await writeFile(path, JSON.stringify(config));
    const args = ["tick", "--config", path, "--execute", "--quiet"];
    assert.equal((await main([...args])).action, "needs-host");
    assert.equal(await main([...args]), null);
    assert.equal((await readState(config)).session_id, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pause/resume preserves session and spend, and resume requires a new owner instruction", async () => {
  const { root, path, config } = await fixture();
  try {
    const state = { ...initialState(config), session_id: "existing", native_priced_usd: 25 };
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    await main(["pause", "--config", path]);
    await assert.rejects(main(["resume", "--config", path]), /owner/);
    const instruction = join(root, "instruction.txt");
    await writeFile(instruction, "The reported blocker is now resolved; continue the same work.");
    await main(["resume", "--config", path, "--instruction", instruction]);
    const resumed = await readState(config);
    assert.equal(resumed.session_id, "existing");
    assert.equal(resumed.native_priced_usd, 25);
    assert.equal(resumed.paused, false);
    assert.match(resumed.next_instruction, /same work/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a practical response-only probe cannot verify a dev23 cycle", async () => {
  const { root } = await fixture();
  try {
    const receipt = join(root, "receipt.json");
    const file = join(root, "empty.json");
    await writeFile(file, JSON.stringify({ candidate: { sha256: "not-the-actual-package" } }));
    await writeFile(receipt, JSON.stringify({ manifest: file, supervisor: file, scoring: file,
      practical: { observation: file }, package: file, package_sha256: "not-the-actual-package" }));
    await assert.rejects(verifyCycle(receipt), /cycle-candidate-mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cycle verification binds official predictions, a real original CLI task, and Git main ancestry", async () => {
  const { root } = await fixture();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
    const commit = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", commit]);
    const packagePath = join(root, "candidate.tgz");
    await writeFile(packagePath, "candidate package bytes");
    const packageHash = digest("candidate package bytes");
    const manifestPath = join(root, "manifest.json"), supervisorPath = join(root, "supervisor.json");
    const scoringPath = join(root, "scoring.json"), practicalPath = join(root, "observation.json");
    const predictionPath = join(root, "predictions.jsonl"), taskPath = join(root, "original-task.txt"), log = join(root, "validation.log");
    const publicLock = JSON.parse(await readFile("scripts/swebench-lite-public-lock.json", "utf8"));
    const ids = Object.keys(publicLock.splits.dev.rows);
    const manifest = { dataset: { id: "princeton-nlp/SWE-bench_Lite", revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2", split: "dev" },
      candidate: { sha256: packageHash, runtime_marker: "fixed-marker", version: "fixed-version" }, instances: ids.map(instance_id => ({ instance_id })) };
    const supervisor = { manifest: manifestPath, input_sha256: digest(JSON.stringify(manifest)), status: "completed",
      policy: { attempts_per_instance: 1, retry_count: 0 }, instances: ids.map(instance_id => ({ instance_id, attempt: 1 })),
      limits: { workers: 8, per_instance_usd: 2, cost_limit_usd: 46, timeout_seconds: 2400, prepared_environment: "official-image-testbed" } };
    const predictions = ids.map(instance_id => ({ instance_id, model_patch: "a frozen actual patch\n" }));
    const scoring = { status: "completed", split: "dev", max_workers: 1, retry_count: 0, supervisor_state: supervisorPath, last_harness: { exit_code: 0 },
      graded: Object.fromEntries(ids.map(id => [id, { patch_sha256: digest("a frozen actual patch\n"), result: { resolved: id === ids[0] } }])) };
    const practical = { candidate_sha256: packageHash, mode: "complete", accepted: true, mission_phase: "completed", receipt_status: "succeeded",
      code: 0, stopped: false, root: "practical-root", instance: { repo: "real/repo", base_commit: commit }, task_sha256: digest("original development task"),
      runtime_marker: "fixed-marker", package_version: "fixed-version",
      models: [{ agent: "dog-worker-v010", model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } }] };
    await Promise.all([writeAtomicJson(manifestPath, manifest), writeAtomicJson(supervisorPath, supervisor),
      writeAtomicJson(scoringPath, scoring), writeAtomicJson(practicalPath, practical),
      writeFile(predictionPath, predictions.map(item => JSON.stringify(item)).join("\n") + "\n"),
      writeFile(taskPath, "original development task"), writeFile(log, "canonical check passed")]);
    const runnerScripts = ["scripts/swebench-lite-runner.mjs", "scripts/swebench-lite-supervisor.mjs", "scripts/swebench-lite-grader.mjs",
      "scripts/swebench-model-cost.mjs", "scripts/release-cli.mjs"];
    for (const script of runnerScripts) await writeAtomicJson(join(root, script), { fixture: script });
    const runnerHashes = Object.fromEntries(await Promise.all(runnerScripts.map(async script =>
      [script, digest(await readFile(join(root, script), "utf8"))])));
    const receipt = { manifest: manifestPath, supervisor: supervisorPath, scoring: scoringPath, package: packagePath, package_sha256: packageHash,
      runtime_marker: "fixed-marker", runner_root: root, runner_sha256: runnerHashes,
      manifest_sha256: digest(await readFile(manifestPath, "utf8")), predictions: predictionPath, predictions_sha256: digest(await readFile(predictionPath, "utf8")),
      source_repo: root, commit, main_commit: commit, runner_commit: commit, main_integrated: true,
      practical: { observation: practicalPath, task: taskPath, repo: "real/repo", base_commit: commit,
        verification: [{ command: "canonical test", exit: 0, log, log_sha256: digest("canonical check passed") }] } };
    const receiptPath = join(root, "cycle.json");
    await writeAtomicJson(receiptPath, receipt);
    assert.equal((await verifyCycle(receiptPath)).total, 23);
    await writeAtomicJson(practicalPath, { ...practical, mode: "start" });
    await assert.rejects(verifyCycle(receiptPath), /practical-session-not-accepted/);
    await writeAtomicJson(practicalPath, { ...practical, instance: null });
    await assert.rejects(verifyCycle(receiptPath), /original-task-required/);
    await writeAtomicJson(practicalPath, practical);
    await writeFile(taskPath, "substituted seed-file task");
    await assert.rejects(verifyCycle(receiptPath), /original-task-required/);
    await writeFile(taskPath, "original development task");
    await writeAtomicJson(scoringPath, { ...scoring, max_workers: 2 });
    await assert.rejects(verifyCycle(receiptPath), /comparison-conditions/);
    await writeAtomicJson(scoringPath, scoring);
    await writeAtomicJson(practicalPath, { ...practical, models: [{ agent: "dog-worker-v010", model: { ...practical.models[0].model, providerID: "other" } }] });
    await assert.rejects(verifyCycle(receiptPath), /practical-session-not-accepted/);
    await writeAtomicJson(practicalPath, practical);
    await writeAtomicJson(receiptPath, { ...receipt, runner_commit: "not-the-actual-commit" });
    await assert.rejects(verifyCycle(receiptPath), /runner-commit/);
    await writeAtomicJson(receiptPath, receipt);
    await writeFile(predictionPath, "changed after scoring");
    await assert.rejects(verifyCycle(receiptPath), /frozen-artifacts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
