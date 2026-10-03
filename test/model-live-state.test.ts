import assert from "node:assert/strict";
import test from "node:test";
import { modelLiveState, reviewerContinuousState } from "../dist/plugin/model-live-state.js";

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

test("split Reviewer state preserves every current assignment field and exact cumulative findings through cold restore, compaction and withdrawal", () => {
  const current = { root_session_id: "root", run_id: "run", findings: 'Medium: first\nquoted "detail"',
    original_requests: ["original request, exact bytes"], write: ["source/**"], validation: ["formal check"],
    acceptance: { contract: "unchanged" }, future_field: { retained: true } };
  const instruction = "Preserve current-source formal checks and actual native terminal; not independent approval.";
  const split = reviewerContinuousState(current, instruction);
  const { findings: omitted, ...expected } = current;
  assert.deepEqual(JSON.parse(split[0]!.split("\n")[1]!), expected);
  assert.equal(split[0]!.split("\n").slice(2).join("\n"), instruction);
  assert.deepEqual(JSON.parse(split[1]!.split("\n")[1]!), { root_session_id: "root", run_id: "run", findings: current.findings });
  assert.deepEqual(project(["ROLE", ...split]).system, ["ROLE", ...split], "no message-array host keeps both complete current state blocks");
  const native = [user()];
  const first = project(["ROLE", ...split], native);
  const newer = { ...current, findings: current.findings + "\n\nMedium: new correction-impact finding" };
  const cold = project(["ROLE", ...reviewerContinuousState(newer, instruction)], [...native, ...turn()], structuredClone(first.history));
  assert.deepEqual(cold.messages!.slice(0, first.messages!.length), first.messages);
  assert.equal((cold.messages!.at(-1) as any).content.length, 1, "findings-only delta, not repeated assignment");
  assert.equal(JSON.parse((cold.messages!.at(-1) as any).content[0].text.split("\n")[1]).findings, newer.findings);
  const compacted = { role: "assistant", content: [{ type: "compaction", encrypted: "native-checkpoint" }] };
  const rebuilt = project(["ROLE", ...reviewerContinuousState(newer, instruction)], [compacted], cold.history);
  assert.equal(rebuilt.messages![0], compacted);
  assert.deepEqual((rebuilt.messages!.at(-1) as any).content, reviewerContinuousState(newer, instruction).map(text => ({ type: "text", text })));
  const retired = project(["ROLE"], [compacted, ...turn()], rebuilt.history);
  assert.deepEqual(JSON.parse((retired.messages!.at(-1) as any).content[0].text.split("\n")[1]),
    ["SORTIE_REVIEWER_CONTINUOUS_CONTEXT", "SORTIE_REVIEWER_RETAINED_FINDINGS"]);
});

test("legacy combined Reviewer snapshots are retained rather than rewritten when the new split state is first sent", () => {
  const current = { root_session_id: "root", run_id: "run", findings: "Medium: exact original finding",
    original_requests: ["original request"], write: ["source/**"], validation: ["formal check"] };
  const instruction = "Use current authoritative state and genuine evidence.";
  const legacy = `SORTIE_REVIEWER_CONTINUOUS_CONTEXT\n${JSON.stringify(current)}\n${instruction}`;
  const native = [user()], first = project(["ROLE", legacy], native);
  const split = reviewerContinuousState(current, instruction);
  const migrated = project(["ROLE", ...split], [...native, ...turn()], structuredClone(first.history));
  assert.deepEqual(migrated.messages!.slice(0, first.messages!.length), first.messages, "never reconstruct already-sent legacy history for byte savings");
  assert.deepEqual((migrated.messages!.at(-1) as any).content, split.map(text => ({ type: "text", text })));
  const changed = { ...current, write: ["new-authorized/**"], validation: ["new formal check"] };
  const next = project(["ROLE", ...reviewerContinuousState(changed, instruction)], [...native, ...turn(), ...turn()], migrated.history);
  assert.deepEqual((next.messages!.at(-1) as any).content, [{ type: "text", text: reviewerContinuousState(changed, instruction)[0] }],
    "real assignment changes are sent, never skipped as cache-stable or confused with formal evidence");
});
