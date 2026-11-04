import assert from "node:assert/strict";
import test from "node:test";
import { NativeBackgroundLifecycle } from "../dist/plugin/native-background.js";
import { createSortieDogsV2Plugin } from "../dist/plugin/v2.js";

function fixture() {
  const state = new Map<string, unknown>();
  const history: Record<string, Record<string, unknown>[]> = { root: [], child: [] };
  const parents: Record<string, string | undefined> = { child: "root" };
  const context = { storage: {
    get: async (key: string) => structuredClone(state.get(key)),
    set: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); },
  }, session: {
    get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID] }),
    context: async ({ sessionID }: { sessionID: string }) => history[sessionID] ?? [],
  } } as never;
  return { context, state, history, parents };
}

for (const agent of ["dogs-coordinator", "dog-worker-v010", "dog-reviewer-v010"]) {
  test(`native ${agent}: running acknowledgement holds ownership; real completion settles once`, async () => {
    const f = fixture(), settled: unknown[] = [];
    const lifecycle = new NativeBackgroundLifecycle(f.context, async (dispatch, text) => { settled.push([dispatch.callID, dispatch.owner, text]); });
    await lifecycle.admit("root", "call", { agent, prompt: "exact", background: true }, { root: "root", generation: 3 });
    await lifecycle.bind("root", "child", agent, "exact", "prompt-3");
    f.history.child!.push({ id: "prompt-3", type: "user", text: "exact" });
    await lifecycle.launched("root", "call", "child", true);
    assert.equal(await lifecycle.awaiting("root"), true);
    assert.equal(await lifecycle.awaiting("child"), true);
    await lifecycle.event({ type: "session.idle", data: { sessionID: "root" } });
    assert.equal(settled.length, 0, "root idle is not child completion");
    f.history.child!.push({ id: "answer-3", type: "assistant", finish: "stop", content: [{ type: "text", text: "result" }] });
    const event = { type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "child" } };
    await lifecycle.event(event);
    await lifecycle.event(event);
    await lifecycle.reconcile("root");
    assert.deepEqual(settled, [["call", { root: "root", generation: 3 }, "result"]]);
    assert.equal(await lifecycle.awaiting("root"), false);
  });
}

test("quick completion before launch-after, duplicate events, same-child old generation, and reload", async () => {
  const f = fixture(), settled: string[] = [];
  const create = () => new NativeBackgroundLifecycle(f.context, async dispatch => { settled.push(`${dispatch.callID}:${dispatch.terminal}`); });
  let lifecycle = create();
  await lifecycle.admit("root", "first", { agent: "dogs-coordinator", prompt: "first" });
  await lifecycle.bind("root", "child", "dogs-coordinator", "first", "prompt-first");
  f.history.child!.push({ id: "prompt-first", type: "user" });
  const old = { type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "child" } };
  await lifecycle.event(old);
  assert.equal(settled.length, 0, "early terminal must wait for launch-after acknowledgement");
  lifecycle = create();
  await lifecycle.launched("root", "first", "child", true);
  assert.deepEqual(settled, ["first:succeeded"]);
  await new Promise(resolve => setTimeout(resolve, 2));
  await lifecycle.admit("root", "second", { agent: "dogs-coordinator", prompt: "next", sessionID: "child" });
  await lifecycle.bind("root", "child", "dogs-coordinator", "next", "prompt-second");
  f.history.child!.push({ id: "prompt-second", type: "user" });
  await lifecycle.launched("root", "second", "child", true);
  await lifecycle.event(old);
  assert.equal(settled.length, 1, "an earlier execution timestamp cannot settle the subsequent prompt");
  lifecycle = create();
  f.history.root!.push({ id: "inbox-second", type: "synthetic", metadata: { source: "subagent", childID: "child", state: "failed" }, time: { created: Date.now() } });
  await lifecycle.reconcile("root");
  assert.deepEqual(settled, ["first:succeeded", "second:failed"]);
});

for (const outcome of ["failed", "interrupted"]) test(`native ${outcome} releases only after the real terminal`, async () => {
  const f = fixture(), settled: string[] = [];
  const lifecycle = new NativeBackgroundLifecycle(f.context, async dispatch => { settled.push(dispatch.terminal!); });
  await lifecycle.admit("root", "call", { agent: "dog-worker-v010", prompt: "exact" });
  await lifecycle.bind("root", "child", "dog-worker-v010", "exact", "prompt");
  await lifecycle.launched("root", "call", "child", true);
  assert.equal(settled.length, 0);
  await lifecycle.event({ type: `session.execution.${outcome}`, created: Date.now(), data: { sessionID: "child" } });
  assert.deepEqual(settled, [outcome]);
});

test("settlement errors remain pending and retry; independent parents are concurrent", async () => {
  const f = fixture();
  f.parents.other = "other-root";
  let fail = true, unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const settled: string[] = [];
  const lifecycle = new NativeBackgroundLifecycle(f.context, async dispatch => {
    if (dispatch.parent === "root" && fail) { fail = false; throw new Error("accounting failed"); }
    if (dispatch.parent === "root") await blocked;
    settled.push(dispatch.parent);
  });
  for (const [parent, child] of [["root", "child"], ["other-root", "other"]]) {
    await lifecycle.admit(parent!, child!, { agent: "dog-worker-v010", prompt: child });
    await lifecycle.bind(parent!, child!, "dog-worker-v010", child!);
    await lifecycle.launched(parent!, child!, child!, true);
  }
  await assert.rejects(lifecycle.event({ type: "session.execution.failed", created: Date.now(), data: { sessionID: "child" } }), /accounting failed/);
  assert.equal(await lifecycle.awaiting("root"), true, "errors are not recorded as successful settlement");
  const slow = lifecycle.reconcile("root");
  await lifecycle.event({ type: "session.execution.failed", created: Date.now(), data: { sessionID: "other" } });
  assert.deepEqual(settled, ["other-root"]);
  unblock();
  await slow;
  assert.deepEqual(settled, ["other-root", "root"]);
});

test("cold native log reconciles interrupted launches and excludes late old-generation events", async () => {
  const f = fixture(), log: Record<string, unknown>[] = [], settled: string[] = [];
  const base = f.context as unknown as { session: Record<string, unknown> };
  const context = { ...base, session: { ...base.session,
    log: async function* () { yield* log; },
  } } as never;
  const create = () => new NativeBackgroundLifecycle(context, async dispatch => { settled.push(`${dispatch.callID}:${dispatch.terminal}`); });
  let lifecycle = create();
  await lifecycle.admit("root", "new-call", { agent: "dogs-coordinator", prompt: "new", sessionID: "child" });
  await lifecycle.bind("root", "child", "dogs-coordinator", "new", "new-prompt");
  // The native launch is durable, but execute.after was lost during reload.
  f.history.root!.push({ type: "assistant", content: [{ type: "tool", id: "new-call", state: {
    status: "completed", metadata: { status: "running", sessionID: "child" },
  } }] });
  log.push({ type: "session.inbox.delivered", data: { inboxID: "old-prompt" } },
    { type: "session.execution.succeeded", created: Date.now() + 1, data: { sessionID: "child" } },
    { type: "session.inbox.delivered", data: { inboxID: "new-prompt" } });
  lifecycle = create();
  await lifecycle.event({ type: "session.execution.succeeded", created: Date.now() + 1, data: { sessionID: "child" } });
  assert.equal(settled.length, 0, "timestamp alone does not identify a same-child execution when native logs are available");
  assert.equal(await lifecycle.awaiting("root"), true);
  log.push({ type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "child" } });
  await lifecycle.reconcile("root");
  assert.deepEqual(settled, ["new-call:interrupted"]);
});

test("reload restores ownership before continued child observations and checkpoints their formal evidence", async () => {
  const f = fixture();
  const first = new NativeBackgroundLifecycle(f.context, async () => {});
  await first.admit("root", "call", { agent: "dog-worker-v010", prompt: "exact" }, { reservation: "held", evidence: [] });
  await first.bind("root", "child", "dog-worker-v010", "exact", "prompt");
  await first.launched("root", "call", "child", true);
  let current: Record<string, unknown> | undefined;
  let restores = 0;
  const resumed = new NativeBackgroundLifecycle(f.context, async () => {}, (_call, restore) => {
    if (restore) { current = restore; restores++; }
    return current;
  });
  await resumed.resume("child");
  assert.deepEqual(current, { reservation: "held", evidence: [] });
  current!.evidence = ["native-formal-check"];
  await resumed.resume("child");
  assert.equal(restores, 1, "further native calls cannot overwrite newly observed evidence with the launch snapshot");
  await resumed.checkpoint("child");
  let recovered: unknown;
  const cold = new NativeBackgroundLifecycle(f.context, async dispatch => { recovered = dispatch.owner; });
  await cold.event({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "child" } });
  assert.deepEqual(recovered, { reservation: "held", evidence: ["native-formal-check"] });
});

test("reused Reviewer old idle/text cannot settle a missing new prompt; log failure overrides text success", async () => {
  const f = fixture(), events: Record<string, unknown>[] = [], settled: string[] = [];
  f.history.child!.push({ id: "old-review", type: "assistant", finish: "stop", content: [{ type: "text", text: "PASS old" }] });
  const base = f.context as unknown as { session: Record<string, unknown> };
  const context = { ...base, session: { ...base.session, log: async function* () { yield* events; } } } as never;
  const lifecycle = new NativeBackgroundLifecycle(context, async dispatch => { settled.push(dispatch.terminal!); });
  await lifecycle.admit("root", "correction", { agent: "dog-reviewer-v010", sessionID: "child", prompt: "correction" });
  await lifecycle.bind("root", "child", "dog-reviewer-v010", "correction", "new-prompt");
  f.history.child!.push({ id: "old-unpaged-review", type: "assistant", finish: "stop", content: [{ type: "text", text: "old ready" }] });
  await lifecycle.launched("root", "correction", "child", true);
  await lifecycle.event({ type: "session.idle", data: { sessionID: "root" } });
  assert.equal(settled.length, 0);
  assert.equal(await lifecycle.awaiting("root"), true);
  f.history.child!.push({ id: "new-prompt", type: "user" }, { id: "new-report", type: "assistant", finish: "stop", content: [{ type: "text", text: "CORRECTION_READY" }] });
  events.push({ type: "session.inbox.delivered", data: { inboxID: "new-prompt" } });
  await lifecycle.reconcile("root");
  assert.equal(settled.length, 0, "text alone is not execution success when native logs are available");
  events.push({ type: "session.execution.failed", data: { sessionID: "child" } });
  await lifecycle.reconcile("root");
  await lifecycle.reconcile("root");
  assert.deepEqual(settled, ["failed"]);
});

test("host result is durable and projected beside the same native completion without another wakeup or settlement", async () => {
  const f = fixture();
  let settlements = 0;
  const result = JSON.stringify({ status: "review-correction-recorded", call_id: "call", independent: false });
  let lifecycle = new NativeBackgroundLifecycle(f.context, async () => { settlements++; return result; });
  await lifecycle.admit("root", "call", { agent: "dog-reviewer-v010", prompt: "review" });
  await lifecycle.bind("root", "child", "dog-reviewer-v010", "review", "prompt");
  f.history.child!.push({ id: "prompt", type: "user" }, { id: "terminal", type: "assistant", finish: "stop",
    content: [{ type: "text", text: "SELF_RECHECKED" }] });
  await lifecycle.launched("root", "call", "child", true);
  const text = '<subagent sessionID="child" state="completed">\nSELF_RECHECKED\n</subagent>';
  f.history.root!.push({ type: "synthetic", text, time: { created: Date.now() },
    metadata: { source: "subagent", childID: "child", state: "completed" } });
  const messages = [{ role: "user", content: [{ type: "text", text }] },
    { role: "user", content: [{ type: "text", text: "Record and hold; no acceptance" }] }];
  const original = structuredClone(messages);
  lifecycle = new NativeBackgroundLifecycle(f.context, async () => { throw Error("must not resettle"); });
  const projected = await lifecycle.project("root", messages) as any[];
  assert.equal(projected.length, 3);
  assert.equal(projected[0], messages[0]); assert.equal(projected[2], messages[1]);
  assert.equal(projected[1].role, "system");
  assert.match(projected[1].content[0].text, /review-correction-recorded/);
  assert.match(projected[1].content[0].text, /not a new request or acceptance/);
  assert.deepEqual(await lifecycle.project("root", projected), projected, "reentrant projection is once-only");
  assert.deepEqual(await lifecycle.project("other-root", messages), messages, "no cross-parent output");
  assert.deepEqual(messages, original, "native history remains untouched");
  assert.equal(settlements, 1);
});

test("legacy settled receipt recovery is read-only, once cached and isolated from unmatched generations", async () => {
  const f = fixture(), now = Date.now();
  f.state.set("v2-background-dispatches:root", [
    { parent: "root", child: "child", callID: "old", promptID: "old-prompt", agent: "dog-reviewer-v010",
      input: {}, baseline: [], admittedAt: now - 20, launched: true, settled: true, terminal: "succeeded", result: "old host receipt" },
    { parent: "root", child: "child", callID: "new", promptID: "new-prompt", agent: "dog-reviewer-v010",
      input: {}, baseline: [], admittedAt: now, launched: true, settled: true, terminal: "succeeded" },
  ]);
  const notices = [
    { text: "old native notice", time: { created: now - 10 }, metadata: { source: "subagent", childID: "child", state: "completed" } },
    { text: "new native notice", time: { created: now + 1 }, metadata: { source: "subagent", childID: "child", state: "completed" } },
    { text: "foreign notice", time: { created: now + 1 }, metadata: { source: "subagent", childID: "foreign", state: "completed" } },
    { text: "wrong outcome", time: { created: now + 1 }, metadata: { source: "subagent", childID: "child", state: "failed" } },
  ].map(item => ({ ...item, type: "synthetic" }));
  f.history.root!.push(...notices);
  let recoveries = 0;
  const lifecycle = new NativeBackgroundLifecycle(f.context, async () => { throw Error("no settlement"); }, undefined,
    async (parent, call, child, prompt) => {
      recoveries++; assert.deepEqual([parent, call, child, prompt], ["root", "new", "child", "new-prompt"]);
      return "new host receipt";
    });
  const messages = notices.map(item => ({ role: "user", content: [{ type: "text", text: item.text }] }));
  const projected = await lifecycle.project("root", messages) as any[];
  assert.equal(projected.length, 6);
  assert.match(projected[1].content[0].text, /old host receipt/);
  assert.match(projected[3].content[0].text, /new host receipt/);
  assert.equal(projected[4], messages[2]); assert.equal(projected[5], messages[3]);
  assert.deepEqual(await lifecycle.project("root", messages), projected);
  assert.equal(recoveries, 1);
});

test("a receipt projection failure never suppresses the actual native result or creates a task blocker", async () => {
  const f = fixture();
  f.state.set("v2-background-dispatches:root", [{ parent: "root", child: "child", callID: "call", input: {}, baseline: [],
    admittedAt: 1, launched: true, settled: true, terminal: "succeeded" }]);
  f.history.root!.push({ type: "synthetic", text: "native", time: { created: 2 },
    metadata: { source: "subagent", childID: "child", state: "completed" } });
  const lifecycle = new NativeBackgroundLifecycle(f.context, async () => {}, undefined, async () => { throw Error("projection unavailable"); });
  const messages = [{ role: "user", content: [{ type: "text", text: "native" }] }];
  assert.deepEqual(await lifecycle.project("root", messages), messages);
  assert.equal(await lifecycle.awaiting("root"), false);
});

test("saved Coordinator completion projects its captured evidence in native context and compaction without changing storage", async () => {
  const f = fixture(), now = Date.now();
  const paths = Array.from({ length: 44_629 }, (_, index) => `generated/protected/${index}/${"x".repeat(90)}.txt`);
  const evidence = { evidence_id: "proof-captured", identity: { source: "old-source", candidate: "old-candidate" },
    execution: { command: ["node check.mjs"], exit_code: 1, outcome: "fail", started_at: "start", ended_at: "end" },
    proof_scope: "requested-full", protected_binding: { manifest_path: "manifest.json", manifest_hash: "old-manifest",
      source_policy: "declared-paths-v1", source_paths: paths, candidate_paths: [],
      freshness: { protected_paths: paths, scratch_paths: [], environment: { NODE: "captured" } } } };
  const packet = { mission_id: "mission-old", run_id: "run-old", phase: "running", status: "awaiting-decision",
    requirements: [{ id: "R1", text: "Keep the full ordered request and attachment reference." }],
    original_request_refs: ["user:original-with-attachment"], budget: { consumed_units: 3, reserved_units: 1, remaining_units: 2 },
    next_action: "Continue the same failed unit", coordinator_report: "Failed; do not claim success.",
    units: [{ id: "unit-1", status: "failed", child_session_id: "worker", evidence: [evidence] }] };
  const captured = JSON.stringify(packet);
  const saved = [{ parent: "root", child: "child", callID: "call", agent: "dogs-coordinator", input: {}, baseline: [],
    owner: { profile: { root: "root", mission: true } }, admittedAt: now - 1, launched: true, settled: true,
    terminal: "succeeded", result: captured }];
  f.state.set("v2-background-dispatches:root", structuredClone(saved));
  const text = "native notification";
  f.history.root!.push({ type: "synthetic", text, time: { created: now },
    metadata: { source: "subagent", childID: "child", state: "completed" } });
  const sessionHooks = new Map<string, (event: any) => Promise<void>>();
  const base = f.context as any;
  const context = { ...base, location: { directory: process.cwd() }, options: {}, app: { version: "2.2.5" },
    event: { subscribe: async function* () {} },
    tool: { transform: async () => ({ dispose() {} }), hook: async () => ({ dispose() {} }) },
    permission: { hook: async () => ({ dispose() {} }) },
    session: { ...base.session, hook: async (name: string, callback: (event: any) => Promise<void>) => { sessionHooks.set(name, callback); return { dispose() {} }; } },
  } as never;
  const cleanup = await createSortieDogsV2Plugin(async () => ({
    "experimental.chat.system.transform": async () => {}, "experimental.session.compacting": async () => {},
  })).setup(context);
  try {
    for (const hook of ["context", "compaction"]) {
      const originalMessages = [{ role: "user", content: [{ type: "text", text }] }];
      const event = { sessionID: "root", agent: "dog-operator", messages: structuredClone(originalMessages), system: [] as any[], tools: {} };
      await sessionHooks.get(hook)!(event);
      assert.equal(event.messages.length, 2, hook);
      const result = (event.messages[1] as any).content[0].text as string;
      const projected = JSON.parse(result.slice(result.indexOf("\n", result.indexOf("\n") + 1) + 1));
      assert.ok(result.length < 10_000, `${hook}: generated 44,629-path snapshot must not be copied`);
      const { units: _units, ...nonEvidence } = packet;
      const { units: projectedUnits, ...projectedNonEvidence } = projected;
      assert.deepEqual(projectedNonEvidence, nonEvidence, "requirements, budget, failure and coordinator report are retained");
      const { protected_binding: _binding, ...measured } = evidence;
      assert.deepEqual(projectedUnits[0].evidence[0], { ...measured,
        protected_binding_ref: { manifest_path: "manifest.json", manifest_hash: "old-manifest", source_policy: "declared-paths-v1" } });
      assert.deepEqual(projectedUnits[0].evidence_details_ref, { storage: "sortie-dogs.v010", key: "v2-background-dispatches:root",
        call_id: "call", run_id: "run-old", unit_id: "unit-1", field: "result.units[].evidence",
        omitted: "captured host snapshot recipe; the original result remains in this native background dispatch" });
      assert.deepEqual(event.messages[0], originalMessages[0]);
      assert.deepEqual(f.state.get("v2-background-dispatches:root"), saved, "projection never replaces captured storage with current state");
    }
  } finally { cleanup?.(); }
});

test("background projection leaves unrelated JSON and malformed captured evidence untouched", async () => {
  const f = fixture(), now = Date.now(), text = "native notification";
  f.history.root!.push({ type: "synthetic", text, time: { created: now },
    metadata: { source: "subagent", childID: "child", state: "completed" } });
  const packet = { mission_id: "mission", run_id: "run", units: [{ id: "unit", evidence: [{ protected_binding: null, result: "keep" }] }] };
  const input = [{ role: "user", content: [{ type: "text", text }] }];
  for (const [owner, result] of [
    [{ profile: { mission: false } }, JSON.stringify({ ...packet, units: [{ id: "unit", evidence: [{ protected_binding: { source_paths: ["keep"] } }] }] })],
    [{ profile: { mission: true } }, JSON.stringify(packet)],
  ] as const) {
    f.state.set("v2-background-dispatches:root", [{ parent: "root", child: "child", callID: "call", owner,
      input: {}, baseline: [], admittedAt: now - 1, launched: true, settled: true, terminal: "succeeded", result }]);
    const lifecycle = new NativeBackgroundLifecycle(f.context, async () => { throw Error("must not resettle"); });
    const projected = await lifecycle.project("root", input) as any[];
    assert.ok(projected[1].content[0].text.endsWith(result), "unrecognized evidence is not silently transformed");
    assert.equal((f.state.get("v2-background-dispatches:root") as any[])[0].result, result);
  }
});
