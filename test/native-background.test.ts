import assert from "node:assert/strict";
import test from "node:test";
import { NativeBackgroundLifecycle } from "../dist/plugin/native-background.js";

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
