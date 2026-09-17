import assert from "node:assert/strict";
import test from "node:test";
import { buildDebrief, observeDebriefSession, renderDebrief } from "../dist/plugin/sortie-debrief.js";
import { collectRunMetrics, createSortieResult, insertSortieResult, terminalRunOutcome } from "../dist/plugin/run-metrics.js";
import type { GoalAcceptanceContract, GoalFlightEventRecord, GoalTerminalReceipt } from "../src/core/goal-bound.ts";

const receipt: GoalTerminalReceipt = { goal_id: "g", terminal_revision: 1, acceptance_fingerprint: "sha256:a",
  started_at: new Date(0).toISOString(), ended_at: new Date(1000).toISOString(), status: "succeeded", stop_reason: "completed",
  unit_ids: ["u"], session_ids: ["root"], evidence_refs: [], milestone_at: null };
const contract: GoalAcceptanceContract = { criteria: [{ criterion_id: "c", validation_command: "npm test", target: "t",
  entrypoint: "test", workload: "w", oracle_coverage: ["c"], build_boundary: "included", source: "s", candidate: "c",
  fixture: "f", proof_scope: "requested-full", expected_outcome: "pass" }] };
const tool = (id: string, name: string, start: number, end: number, input: object = {}, metadata: object = {}, output = "") =>
  ({ id, callID: id, type: "tool", tool: name, state: { status: "completed", input, metadata, output, time: { start, end } } });
const message = (id: string, start: number, end: number, parts: object[] = [], modelID = "cheap") => ({
  info: { id, role: "assistant", providerID: "provider", modelID, agent: "dog-worker", time: { created: start, completed: end },
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }, parts,
});
const observe = (id: string, messages: ReturnType<typeof message>[], root = false) =>
  observeDebriefSession(id, root, messages, { start: 0, end: 1000 });
const records = (events: object[]) => events.map((event, index) => ({ sequence: index + 1, event })) as GoalFlightEventRecord[];

test("same-session resumes count once, mixed models attribute tokens, and old goals are excluded", async () => {
  const histories = { root: [message("root", 100, 110)], child: [message("old", 1, 2), message("a", 150, 180), message("b", 200, 230, [], "strong")] };
  let reads = 0;
  const metrics = await collectRunMetrics({ session: {
    children: async ({ path }) => path.id === "root" ? [{ id: "child" }, { id: "child" }] : [],
    messages: async ({ path }) => { reads++; return histories[path.id as keyof typeof histories]; },
  } }, "root", undefined, 300, { startedAt: new Date(100).toISOString(), endedAt: new Date(300).toISOString() });
  const result = buildDebrief(receipt, contract, metrics?.debrief);
  assert.equal(reads, 2, "no additional host scans");
  assert.deepEqual(result.pack, [{ model: "混成", count: 1 }]);
  assert.equal(result.mix?.find((entry) => entry.model === "provider/cheap")?.tokens, 24);
  assert.equal(result.mix?.find((entry) => entry.model === "provider/strong")?.tokens, 12);
  assert.equal(metrics?.tokens, 36);
  assert.doesNotMatch(JSON.stringify(metrics?.debrief), /"parts"|"input"|"output"/u);
});

test("Pack Tactics requires actual positive overlap, not number of dispatches", () => {
  const first = observe("a", [message("a", 10, 30)]);
  const adjacent = observe("b", [message("b", 30, 40)]);
  const overlap = observe("c", [message("c", 20, 40)]);
  const make = (other: typeof first) => buildDebrief(receipt, null, { complete: true, sessions: [first, other], window: undefined });
  assert.deepEqual(make(adjacent).traits, []);
  assert.deepEqual(make(overlap).traits, ["連携作戦"]);
  assert.deepEqual(make(overlap).overlap, { workerMilliseconds: 40, wallMilliseconds: 30 });
  const missing = observe("d", [{ ...message("d", 1, 2), info: { ...message("d", 1, 2).info, time: {} as never } }]);
  assert.equal(make(missing).pack, null);
  assert.deepEqual(make(missing).traits, []);
});

test("goal-boundary timing and unrelated tool metadata do not erase known tokens, pack, or validation", async () => {
  const histories = {
    root: [message("root", 90, 120, [tool("plain-control", "sortie_check_contract", 105, 110, {}, {}, "ok")])],
    child: [message("child", 150, 200, [tool("validate", "bash", 160, 180, { command: "npm  test" }, { exit: 0 })])],
  };
  const metrics = await collectRunMetrics({ session: {
    children: async ({ path }) => path.id === "root" ? [{ id: "child" }] : [],
    messages: async ({ path }) => histories[path.id as keyof typeof histories],
  } }, "root", undefined, 300, { startedAt: new Date(100).toISOString(), endedAt: new Date(300).toISOString() });
  const result = buildDebrief(receipt, contract, metrics?.debrief);
  assert.equal(metrics?.tokens, 24);
  assert.deepEqual(result.pack, [{ model: "provider/cheap", count: 1 }]);
  assert.deepEqual(result.mix, [{ model: "provider/cheap", tokens: 24, percent: 100,
    inputCache: { uncachedInputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, hostCostZero: true }]);
  assert.equal(result.validation, "PASS");
  assert.deepEqual(result.overlap, { workerMilliseconds: 50, wallMilliseconds: 50 });
});

test("serial reviewer outcomes are labeled as reviewer reports without treating worker prose as review", () => {
  const make = (role: string) => buildDebrief(receipt, contract, { complete: true, window: undefined,
    sessions: [observe("root", [message("root", 1, 30, [
      tool("review", "task", 10, 20, { subagent_type: role }, { sessionId: "child" }, "<task_result>PASS\n\nMapping and implementation inspected.\n</task_result>"),
      tool("control", "sortie_check_contract", 21, 22, {}, {}, "ok"),
    ])], true)] });
  assert.equal(make("dog-reviewer").review, "PASS");
  assert.equal(make("dog-reviewer").reviewSource, "reviewer");
  assert.equal(make("dog-worker").review, "未確認");
});

test("usage and model attribution remain available when only elapsed spans are missing", () => {
  const known = observe("worker", [message("m", 1, 2)]);
  known.models["provider/cheap"] = 12;
  known.spans.length = 0;
  known.timingComplete = false;
  const result = buildDebrief(receipt, contract, { complete: true, sessions: [known], window: undefined });
  assert.deepEqual(result.pack, [{ model: "provider/cheap", count: 1 }]);
  assert.equal(result.mix?.[0]?.tokens, 12);
  assert.equal(result.overlap, undefined);
  assert.ok(result.notes?.some(note => note.includes("時刻")));
});

test("Recovery requires fail, intervening host edit, pass in same child, and completed goal", () => {
  const failed = tool("fail", "bash", 11, 12, { command: "npm test" }, { exit: 1 });
  const edit = tool("edit", "apply_patch", 13, 14, {}, { diff: "-old\n+new" });
  const passed = tool("pass", "bash", 15, 16, { command: "npm test" }, { exit: 0 });
  const make = (parts: object[], status = receipt.status) => buildDebrief({ ...receipt, status }, contract,
    { complete: true, sessions: [observe("a", [message("a", 10, 20, parts)])], window: undefined });
  assert.deepEqual(make([failed, edit, passed]).traits, ["修正から復帰"]);
  assert.deepEqual(make([failed, passed]).traits, []);
  assert.deepEqual(make([failed, edit, passed], "stopped").traits, []);
  const split = buildDebrief(receipt, contract, { complete: true, sessions: [
    observe("a", [message("a", 10, 14, [failed, edit])]), observe("b", [message("b", 15, 20, [passed])]),
  ], window: undefined });
  assert.deepEqual(split.traits, []);
});

test("Clean Sweep requires complete terminal-matched attempt history and no resume or denial", () => {
  const parent = observe("root", [message("r", 1, 30, [tool("task", "task", 2, 25, { subagent_type: "dog-worker" }, { sessionId: "a" })])], true);
  const child = observe("a", [message("a", 10, 20, [tool("check", "bash", 11, 15, { command: "npm test" }, { exit: 0 })])]);
  const observation = { complete: true, sessions: [parent, child], window: undefined };
  const events = [{ kind: "goal.accepted", goal_id: "g" }, { kind: "dispatch.reserved", goal_id: "g", reservation_id: "r" },
    { kind: "unit.settled", goal_id: "g", reservation_id: "r", disposition: "succeeded", result_class: "acceptance" },
    { kind: "goal.terminal", goal_id: "g", receipt }];
  assert.deepEqual(buildDebrief(receipt, contract, observation, records(events)).traits, ["一発完遂"]);
  assert.deepEqual(buildDebrief(receipt, contract, observation).traits, []);
  assert.deepEqual(buildDebrief(receipt, contract, { ...observation, complete: false }, records(events)).traits, []);
  assert.deepEqual(buildDebrief(receipt, contract, observation, records(events.slice(1))).traits, []);
  parent.tasks.push("a");
  assert.deepEqual(buildDebrief(receipt, contract, observation, records(events)).traits, []);
});

test("review prose is not proof and controller skip remains waived", () => {
  const make = (parts: object[]) => buildDebrief(receipt, contract, { complete: true,
    sessions: [observe("a", [message("a", 10, 30, parts)])], window: undefined });
  assert.equal(make([{ type: "text", text: "Review PASS" }]).review, "未確認");
  assert.equal(make([tool("r", "sortie_accept_luna_fabric_candidate", 11, 20, {}, {}, JSON.stringify({ status: "accepted", fabric: { review: { status: "skip" } } }))]).review, "WAIVED");
  assert.equal(make([tool("r", "sortie_accept_luna_fabric_candidate", 11, 20, {}, {}, JSON.stringify({ status: "accepted", fabric: { review: { status: "pass" } } }))]).review, "PASS");
});

test("cards overwrite model-authored numbers, are idempotent, retain status and human paragraphs", () => {
  const result = createSortieResult(receipt, { acceptance_contract: contract, consumed_time_ms: null, satisfied_criteria: ["c"] }, undefined);
  const original = "status: DONE\n\n**Sortie Result**\n**Speed:** fake\n**Cost:** $9999\n**達成:** fake\n\n**変更点:** keep\n\n**確認結果:** keep";
  const text = insertSortieResult(original, result);
  assert.doesNotMatch(text, /fake|9999/);
  assert.match(text, /計測不可/u);
  assert.match(text, /\*\*確認結果:\*\* keep/u);
  assert.equal(insertSortieResult(text, result), text);
  assert.equal(terminalRunOutcome(text), "DONE");
  assert.equal(insertSortieResult("```\nstatus: DONE\n```", result), "```\nstatus: DONE\n```");
});

test("adding a fenced collapsed report preserves detailed explanation headings and disclosure examples", () => {
  const result = createSortieResult(receipt, { acceptance_contract: contract, consumed_time_ms: 10, satisfied_criteria: ["c"] }, undefined);
  const explanation = "今の作業は起動前契約の重複をなくすこと。\n\n**確認:** 欠落項目を検出する場所と予算継承を揃える。\n\n" +
    "<details><summary>設計の詳細</summary>\n**Sortie Result** は表示名の例。\n```yaml\nmanifest: example.json\n```\n</details>";
  const output = insertSortieResult(`status: DONE\n\n${explanation}`, result);
  assert.ok(output.endsWith(explanation));
  assert.equal((output.match(/<details>/gu) ?? []).length, 2);
  assert.equal(insertSortieResult(output, result), output);
  assert.equal(terminalRunOutcome("<details><summary>Example</summary>\nstatus: DONE\n</details>"), undefined);
});

test("unconfirmed mutation and later mutation cannot retain a review PASS or earn Recovery", () => {
  const review = tool("r", "sortie_accept_luna_fabric_candidate", 10, 12, {}, {},
    JSON.stringify({ status: "accepted", fabric: { review: { status: "pass" } } }));
  for (const metadata of [{}, { diff: "-old\n+new" }]) {
    const session = observe("a", [message("a", 1, 30, [review, tool("edit", "apply_patch", 15, 18, {}, metadata)])]);
    const result = buildDebrief(receipt, contract, { complete: true, sessions: [session], window: undefined });
    assert.equal(result.review, "未確認");
    assert.deepEqual(result.traits, []);
  }
});

test("malformed optional display metadata falls back without dropping the terminal checkpoint", () => {
  const result = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  const corrupted = { ...result, debrief: { pack: {}, mix: [] } } as never;
  const output = insertSortieResult("status: INTERRUPTED\n\n**次:** retry display", corrupted);
  assert.equal(terminalRunOutcome(output), "INTERRUPTED");
  assert.match(output, /表示集計を取得できません/u);
  assert.match(output, /retry display/u);
  assert.equal(insertSortieResult(output, corrupted), output);
});

test("in-flight root terminal text is excluded but incomplete child execution is not a complete report", async () => {
  const rootMessage = message("root", 1, 20);
  delete (rootMessage.info.time as { completed?: number }).completed;
  const childMessage = message("child", 2, 10);
  const run = async () => collectRunMetrics({ session: {
    children: async ({ path }) => path.id === "root" ? [{ id: "child" }] : [],
    messages: async ({ path }) => [path.id === "root" ? rootMessage : childMessage],
  } }, "root", undefined, 1000, { startedAt: receipt.started_at, endedAt: receipt.ended_at });
  assert.equal(buildDebrief(receipt, contract, (await run())?.debrief).pack?.length, 1);
  delete (childMessage.info.time as { completed?: number }).completed;
  assert.equal(buildDebrief(receipt, contract, (await run())?.debrief).pack, null);
});

test("token bars use observed shares, group the tail, and remain idempotent with Career", () => {
  const result = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  const populated = { ...result, debrief: { pack: [{ model: "fixture/m", count: 1 }],
    mix: Array.from({ length: 6 }, (_, index) => ({ model: `fixture/${index}`, tokens: 10, percent: 100 / 6 })),
    validation: "未確認", review: "未確認", traits: [] } } as typeof result;
  const text = insertSortieResult("status: DONE", populated);
  assert.equal((text.match(/^🐕 /gmu) ?? []).length, 5);
  assert.match(text, /🐕 その他 ███▍\s+33\.3% 20 tokens/u);
  assert.match(text, /↺未取得/u);
  assert.match(text, /⚡ 実行重複率 稼働区間の記録不足\n   ※worker区間・速度倍率ではありません/u);
  assert.equal(insertSortieResult(text, populated), text);
});

test("model rows show input cache ratios, weight the tail, and distinguish host zero cost", () => {
  const base = (model: string, tokens: number, uncachedInputTokens: number, cacheReadTokens: number,
    cacheWriteTokens: number, hostCostZero = false) => ({ model, tokens, percent: tokens / 120 * 100,
      inputCache: { uncachedInputTokens, cacheReadTokens, cacheWriteTokens }, ...(hostCostZero ? { hostCostZero: true } : {}) });
  const debrief = { pack: [], mix: [
    ...["a", "b", "c", "d"].map(model => base(model, 25, 10, 90, 0)),
    base("e", 10, 0, 100, 0, true),
    base("f", 10, 300, 0, 0),
  ], validation: "未確認" as const, review: "未確認" as const, traits: [] };
  const rendered = renderDebrief(debrief);
  assert.match(rendered.join("\n"), /🐕 a .+ ↺90%/u);
  assert.match(rendered.join("\n"), /🐕 その他 .+ ↺25%†/u);
  assert.match(rendered.join("\n"), /†host費用0計上あり（無料・全体価格の評価ではありません）/u);

  const unknownTail = { ...debrief, mix: debrief.mix.map(entry => entry.model === "f"
    ? { model: entry.model, tokens: entry.tokens, percent: entry.percent } : entry) };
  assert.match(renderDebrief(unknownTail).join("\n"), /🐕 その他 .+ ↺未取得†/u);
});

test("return report renders request estimates without replacing unknown prices with zero", async () => {
  const priced = message("priced", 1, 2, [], "gpt-5.6-sol");
  priced.info.providerID = "openai";
  const unknown = message("unknown", 3, 4, [], "private-model");
  unknown.info.providerID = "private";
  const collect = async (messages: ReturnType<typeof message>[]) => collectRunMetrics({ session: {
    children: async () => [], messages: async () => messages,
  } }, "root", undefined, 5);
  const partial = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, await collect([priced, unknown]));
  assert.match(insertSortieResult("status: DONE", partial), /予測費用\s+\$0\.0001（一部未換算） ※予測概算/u);
  const unpriced = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, await collect([unknown]));
  assert.match(insertSortieResult("status: DONE", unpriced), /予測費用\s+未換算 ※予測概算/u);
});
