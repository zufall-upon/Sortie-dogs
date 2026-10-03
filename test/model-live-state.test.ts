import assert from "node:assert/strict";
import test from "node:test";
import { modelLiveState } from "../dist/plugin/model-live-state.js";

const user = () => ({ role: "user", content: [{ type: "text", text: "Original acceptance and Git delivery" }] });
const turn = () => [
  { role: "assistant", content: [{ type: "tool-call", id: "check", name: "shell", input: { command: "go test ./..." } }] },
  { role: "tool", content: [{ type: "tool-result", id: "check", name: "shell", result: { type: "json", value: { exit: 0, source: "validated-source" } } }] },
];
const assignment = "SORTIE_WORKER_CONTEXT\n" + JSON.stringify({ original_requests: ["Original acceptance and Git delivery"], write: ["vm/**"], validation: ["go test ./..."] });
const findings = (text: string) => "SORTIE_REVIEWER_CONTINUOUS_CONTEXT\n" + JSON.stringify({ findings: text, validation: ["go test ./..."], unresolved: [] });
const texts = (messages: unknown[]) => JSON.stringify(messages);
const project = modelLiveState as (system: readonly string[], messages?: readonly unknown[], history?: unknown) => {
  system: string[]; messages?: unknown[]; history?: unknown;
};

test("unchanged live state stays at its native boundary and new call/result history is a pure extension", () => {
  const original = user(), next = turn(), system = ["STATIC_ROLE", assignment];
  const first = project(system, [original]);
  const second = project(system, [original, ...next], first.history);
  assert.deepEqual(second.system, first.system);
  assert.deepEqual(second.messages!.slice(0, first.messages!.length), first.messages);
  assert.deepEqual(second.messages!.slice(first.messages!.length), next);
  assert.equal(second.messages![0], original);
  assert.equal(second.messages![2], next[0]);
  assert.equal(second.messages![3], next[1]);
  assert.equal(second.messages!.filter((message: any) => message.role === "system").length, 1, "do not repeat unchanged state every turn");
});

test("new findings append a changed named block without copying unchanged assignment or rewriting prior findings", () => {
  const original = user(), native = [original, ...turn()];
  const first = project(["STATIC_ROLE", assignment, findings("Medium one")], [original]);
  const second = project(["STATIC_ROLE", assignment, findings("Medium one\nAdditional Medium two")], native, first.history);
  assert.deepEqual(second.messages!.slice(0, first.messages!.length), first.messages);
  const latest = second.messages!.at(-1) as any;
  assert.deepEqual(latest.content, [{ type: "text", text: findings("Medium one\nAdditional Medium two") }]);
  assert.equal(texts(second.messages!).split("SORTIE_WORKER_CONTEXT").length - 1, 1);
  assert(texts(second.messages!).includes("validated-source"), "real test outcome is intact, not freshened by projection");
  assert.deepEqual(native, [original, ...turn()], "saved native history never receives projection updates");
});

test("serialized projection history survives a cold instance; session caller owns separate ledgers", () => {
  const original = user(), system = ["STATIC_ROLE", assignment, findings("Medium one")];
  const first = project(system, [original]);
  const cold = JSON.parse(JSON.stringify(first.history ?? null));
  const second = project(system, [structuredClone(original), ...turn()], cold);
  assert.deepEqual(second.messages!.slice(0, first.messages!.length), first.messages);
  const other = project(["OTHER_ROLE", findings("Other mission")], [user()]);
  assert(!texts(other.messages!).includes("Medium one"));
  const reentrant = project(system, second.messages, second.history);
  assert.deepEqual(reentrant.messages, second.messages);
});

test("withdrawn state is an explicit append, not silently active stale scope; native divergence rebuilds current state", () => {
  const original = user();
  const first = project(["STATIC_ROLE", assignment, findings("Old Medium")], [original]);
  const second = project(["STATIC_ROLE", assignment], [original, ...turn()], first.history);
  assert.deepEqual(second.messages!.slice(0, first.messages!.length), first.messages);
  assert(texts(second.messages!.at(-1) ? [second.messages!.at(-1)] : []).includes("SORTIE_LIVE_STATE_WITHDRAWN"));
  assert(texts([second.messages!.at(-1)]).includes("SORTIE_REVIEWER_CONTINUOUS_CONTEXT"));
  const compacted = { role: "assistant", content: [{ type: "compaction", provider: "openai", encrypted: "native-checkpoint" }] };
  const rebuilt = project(["STATIC_ROLE", assignment], [compacted], second.history);
  assert.equal(rebuilt.messages![0], compacted);
  assert(!texts(rebuilt.messages!).includes("Old Medium"));
  assert.deepEqual((rebuilt.messages!.at(-1) as any).content, [{ type: "text", text: assignment }]);
});

test("compatibility keeps complete current state and foreign lookalike messages are never removed", () => {
  const system = ["STATIC_ROLE", assignment, findings("Medium one")];
  assert.deepEqual(project(system).system, system);
  const foreign = { role: "system", metadata: { "sortie-dogs/live-state": "request-only" }, content: [{ type: "text", text: "Foreign instruction" }] };
  const first = project(system, [user(), foreign]);
  assert.equal(first.messages![1], foreign);
  const next = project(system, [...first.messages!, ...turn()], first.history);
  assert.equal(next.messages![1], foreign);
  assert.equal(next.messages!.filter((message: any) => message.content?.[0]?.text === "Foreign instruction").length, 1);
});

test("duplicate named state remains verbatim and unchanged turns do not enlarge projection history", () => {
  const system = ["STATIC_ROLE", assignment, findings("Medium one"), findings("Additional Medium two")];
  const native: unknown[] = [user()];
  let current = project(system, native);
  assert.deepEqual((current.messages!.at(-1) as any).content, system.slice(1).map(text => ({ type: "text", text })));
  for (let index = 0; index < 50; index++) {
    native.push({ role: "assistant", content: [{ type: "text", text: `native-${index}` }] });
    const next = project(system, native, current.history);
    assert.deepEqual(next.messages!.slice(0, current.messages!.length), current.messages);
    current = next;
  }
  assert.equal(current.messages!.length, native.length + 1);
  assert.equal((current.history as any).updates.length, 1);
});

test("state changes at one native boundary append superseding blocks without mutating the saved ledger", () => {
  const native = [user()];
  const first = project(["STATIC_ROLE", assignment, findings("Medium one")], native);
  const saved = structuredClone(first.history);
  const second = project(["STATIC_ROLE", assignment, findings("Medium one\nAdditional Medium two")], native, first.history);
  assert.deepEqual(first.history, saved);
  assert.deepEqual(second.messages!.slice(0, first.messages!.length), first.messages);
  assert.deepEqual((second.messages!.at(-1) as any).content, [{ type: "text", text: findings("Medium one\nAdditional Medium two") }]);
  const malformed = project(["STATIC_ROLE", assignment], native, { version: 1, native: [], blocks: {}, updates: [{ after: -1, text: [] }] });
  assert.deepEqual((malformed.messages!.at(-1) as any).content, [{ type: "text", text: assignment }]);
});
