import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeCareer, collectCareer, renderCareer } from "../dist/plugin/sortie-career.js";
import { goalFingerprint, type GoalFlightEventRecord, type GoalTerminalReceipt } from "../dist/core/goal-bound.js";
import { validGoalReport } from "../src/core/goal-report.ts";

const coverage = { files: 1, included: 1, unavailable: 0, truncated: false };
const root = fileURLToPath(new URL(`../_testenv/career-${process.pid}/`, import.meta.url));
test.before(async () => { await mkdir(root, { recursive: true }); });
test.after(async () => { await rm(root, { recursive: true, force: true }); });
const at = (n: number) => new Date(n * 1000).toISOString();
const receipt = (id: string, status: "succeeded" | "stopped" = "succeeded", end = 10): GoalTerminalReceipt => ({
  goal_id: id, terminal_revision: 1, acceptance_fingerprint: goalFingerprint(id), started_at: at(0), ended_at: at(end),
  status, stop_reason: status === "succeeded" ? "completed" : "stopped", unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null,
});
const record = (event: object, sequence = 1): GoalFlightEventRecord => ({ sequence, previous_hash: null,
  event_hash: goalFingerprint([event, sequence]), event } as GoalFlightEventRecord);
const history = (value: GoalTerminalReceipt, tokens: number | null = null) => [
  record({ kind: "goal.accepted", goal_id: value.goal_id, at: at(0) }),
  record({ kind: "unit.settled", goal_id: value.goal_id, at: at(1), reservation_id: "unit", elapsed_ms: 1000 }, 2),
  record({ kind: "goal.terminal", goal_id: value.goal_id, at: value.ended_at, receipt: value }, 3),
  record({ kind: "goal.reported", goal_id: value.goal_id, at: value.ended_at, report: {
    definition: "pre-terminal-host-tokens/v1", terminal_key: goalFingerprint(value), tokens,
    models: tokens === null ? null : [{ model: "fixture/model", tokens }], first_pass_eligible: true, traits: ["clean-sweep"],
  } }, 4),
];

test("replays deduplicate goals and reopened completion replaces the previous contribution", () => {
  const stopped = history(receipt("g", "stopped"), 10);
  const final = receipt("g", "succeeded", 20);
  const resumed = [...stopped, record({ kind: "goal.user-continued", at: at(11), goal_id: "g" }, 5),
    ...history(final, 30).slice(2).map((entry, index) => ({ ...entry, sequence: index + 6 }))];
  const result = summarizeCareer([resumed, resumed], coverage);
  assert.equal(result.goals, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.interrupted, 0);
  assert.deepEqual(result.tokens, { sum: 30, covered: 1 });
  assert.equal(result.workerTime.sum, 1000);
  assert.equal(result.goalWall.sum, 20000);
  assert.deepEqual(result.firstPass, { count: 1, eligible: 1 });
});

test("unknown telemetry, clock gaps, and active goals never become zero-cost successful missions", () => {
  const old = history(receipt("old")).slice(0, 3);
  const knownZero = history(receipt("zero"), 0);
  const unknownClock = history({ ...receipt("clock", "stopped"), started_at: "unknown" }).slice(0, 3);
  const active = [...history(receipt("active", "stopped"), 50), record({ kind: "goal.user-continued", at: at(11), goal_id: "active" }, 5)];
  const result = summarizeCareer([old, knownZero, unknownClock, active], coverage);
  assert.equal(result.goals, 4);
  assert.equal(result.active, 1);
  assert.deepEqual(result.tokens, { sum: 0, covered: 1 });
  assert.equal(result.goalWall.covered, 2);
  assert.equal(result.telemetryCovered, 1);
  assert.match(renderCareer(result).join("\n"), /累積使用量 0 tokens ※1\/3任務/u);
  assert.doesNotMatch(renderCareer(result).join("\n"), /XP|Level|faster|saved/u);
});

test("incompatible report definitions do not mix token or model totals", () => {
  const incompatible = history(receipt("old-definition"), 100);
  const last = incompatible.at(-1)!.event as Extract<GoalFlightEventRecord["event"], { kind: "goal.reported" }>;
  (last.report as { definition: string }).definition = "other-definition";
  const result = summarizeCareer([history(receipt("current"), 20), incompatible], coverage);
  assert.deepEqual(result.tokens, { sum: 20, covered: 1 });
  assert.equal(result.completed, 2);
  assert.equal(result.models[0]!.tokens, 20);
  assert.equal(validGoalReport({ definition: "pre-terminal-host-tokens/v1", terminal_key: goalFingerprint("x"),
    tokens: 10, models: [{ model: "m", tokens: 20 }], first_pass_eligible: false, traits: [] }), false);
});

test("aggregate overlap is a ratio of compatible duration sums, never an average of ratios", () => {
  const first = history(receipt("short"), 10), second = history(receipt("long"), 20);
  const attach = (entries: typeof first, worker: number, wall: number) => {
    const event = entries.at(-1)!.event as Extract<GoalFlightEventRecord["event"], { kind: "goal.reported" }>;
    (event.report as { overlap: object }).overlap = { definition: "worker-span-union/v1", worker_ms: worker, wall_ms: wall };
  };
  attach(first, 200, 100); attach(second, 900, 900);
  const result = summarizeCareer([first, second, history(receipt("unmeasured"))], coverage);
  assert.deepEqual(result.overlap, { worker: 1100, wall: 1000, covered: 2, ratio: 1.1 });
  assert.notEqual(result.overlap.ratio, (2 + 1) / 2);
});

test("bounded read-only inventory exposes gaps and reflects retention without resurrecting data", async () => {
  const a = join(root, `${"a".repeat(64)}.json`), b = join(root, `${"b".repeat(64)}.json`);
  const current = join(root, `${"c".repeat(64)}.json`);
  await writeFile(a, "fixture"); await writeFile(b, "fixture");
  let reads = 0;
  const read = async (path: string) => { reads++; if (path === b) throw new Error("unreadable"); return { records: history(receipt("a"), 5) }; };
  const first = await collectCareer([root, root], current, history(receipt("current"), 10), read, 2);
  assert.equal(reads, 1);
  assert.equal(first.coverage.truncated, true);
  assert.equal(first.tokens.sum, 15);
  const incomplete = await collectCareer([root], current, history(receipt("current"), 10), read);
  assert.equal(incomplete.coverage.unavailable, 1);
  await rm(a); await rm(b);
  const retained = await collectCareer([root], current, history(receipt("current"), 10), read);
  assert.equal(retained.goals, 1);
  assert.equal(retained.tokens.sum, 10);
  assert.match(renderCareer(retained).join("\n"), /生涯戦績ではありません/u);
});

test("renders PACK RECORD in ordered icon rows with measured coverage and retention scope", () => {
  const result = summarizeCareer([history(receipt("done"), 25), history(receipt("waiting", "stopped")).slice(0, 3)], coverage);
  const text = renderCareer(result).join("\n");
  assert.match(text, /^📜 PACK RECORD\n🏁 完了 1\n🟡 中断 1\n⏳ 外部待機 0\n❓ 指示待ち 0\n🔄 進行中 0\n↩️ 復帰 0/u);
  assert.match(text, /🪙 累積使用量 25 tokens ※1\/2任務/u);
  assert.match(text, /🕰 累積goal 0\.3分 ※2\/2任務 ※待機・重複含む/u);
  assert.match(text, /📦 保存範囲\n1970-01-01以降 \/ 1 of 1 files\n※生涯戦績ではありません$/u);
});
