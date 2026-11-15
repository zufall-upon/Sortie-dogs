import assert from "node:assert/strict";
import test from "node:test";
import { collectRunMetrics, createSortieResult, formatRunMetrics, formatSortieResult, insertRunMetrics,
  insertSortieResult, isDoneTerminalText, replaceDoneTerminalStatus, replaceTerminalStatus, sanitizeTerminalReport,
  terminalRunOutcome, createGoalReport, withSavedGoalReport, returnReportRange, compactReturnReportRange } from "../dist/plugin/run-metrics.js";
import { evaluateRareAwards } from "../dist/core/rare-awards.js";
import { goalFingerprint, type GoalTerminalReceipt, type GoalFlightEventRecord } from "../dist/core/goal-bound.js";
import { summarizeCareer } from "../dist/plugin/sortie-career.js";
import { resolveReportLocale } from "../dist/plugin/report-locale.js";
import { returnReportPanel } from "../dist/plugin/receipt-presentation.js";
import { mkdir, writeFile } from "node:fs/promises";

test("report locale redisplay regenerates host defaults without consuming cards or quoted examples as prose", () => {
  const receipt: GoalTerminalReceipt = { goal_id: "locale-redisplay", terminal_revision: 1,
    acceptance_fingerprint: goalFingerprint("locale-redisplay"), started_at: new Date(0).toISOString(),
    ended_at: new Date(1000).toISOString(), status: "succeeded", stop_reason: "completed",
    unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null };
  const result = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  const insert = (text: string, locale: string) => insertSortieResult(text, result, undefined, undefined, locale);
  const japanese = insert("status: DONE", "ja");
  const english = insert(japanese, "en");
  assert.doesNotMatch(english, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
  assert.equal(insert(english, "en"), english);
  assert.equal(insert(english, "ja"), japanese);
  const prose = "status: DONE\n\n```text\nImplementation: quoted example\n```\n\n" +
    "<details><summary>Example</summary>\nPending: disclosure example\n</details>\n\n" +
    "**Implementation:** 利用者の説明\n\n**Pending:** 利用者の保留\n\n**Next:** 利用者の次操作";
  const displayed = insert(insert(prose, "ja"), "en");
  assert.match(displayed, /🔧 Result: 利用者の説明/u);
  assert.match(displayed, /⏳ Pending: 利用者の保留/u);
  assert.match(displayed, /➡️ Next: 利用者の次操作/u);
  assert.ok(displayed.endsWith(prose.slice("status: DONE\n\n".length)), "original explanatory content stays verbatim");
  assert.equal(insert(displayed, "en"), displayed);
});

test("rare saved receipt snapshots and bilingual renderer preserve counts, states, prose and redisplay", async () => {
  const receipt: GoalTerminalReceipt = { goal_id: "synthetic-i18n", terminal_revision: 1,
    acceptance_fingerprint: goalFingerprint("synthetic"), started_at: new Date(0).toISOString(),
    ended_at: new Date(1000).toISOString(), status: "succeeded", stop_reason: "completed",
    unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null };
  const base = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: 1000, satisfied_criteria: [] },
    { tokens: 1500, cost: 0, debrief: { complete: false, sessions: [], window: undefined } }, new Date(1001).toISOString());
  assert.ok(base.debrief);
  const debrief = { ...base.debrief, traits: ["一発完遂"] as const,
    mix: [{ model: "fixture/model", tokens: 1500, percent: 100,
      estimatedCost: { usd: 0.02, pricedRequests: 1, unpricedRequests: 0, complete: true }, hostCostZero: true }],
    estimatedCost: { usd: 0.02, pricedRequests: 1, unpricedRequests: 0 },
    notes: ["host履歴の取得が一部不足", "モデルIDまたはusageの記録が不足", "稼働区間の時刻が不足（token集計とは独立）"] };
  const cases = [
    ["earned", evaluateRareAwards(true, "true", "false", "false")],
    ["combination", evaluateRareAwards(true, "false", "true", "true")],
    ["not-applicable", evaluateRareAwards(true, "false", "false", "unknown")],
    ["unknown", evaluateRareAwards(true, "unknown", "unknown", "unknown")],
    ["future", { definition: "rare-awards/v2", evaluations: [] }],
    ["legacy", undefined],
  ] as const;
  const folder = "_testenv/pr311-rare-i18n";
  await mkdir(folder, { recursive: true });
  for (const [name, rare] of cases) {
    const traits = name === "earned" ? ["一発完遂"] as const : name === "combination" ? ["連携作戦", "修正から復帰"] as const : [];
    const measured = { ...base, debrief: { ...debrief, traits, rare } };
    const report = createGoalReport(measured, receipt);
    const record = (event: object, sequence: number) => ({ event, sequence, previous_hash: null,
      event_hash: goalFingerprint([event, sequence]) } as GoalFlightEventRecord);
    const records = [record({ kind: "goal.accepted", goal_id: receipt.goal_id, at: receipt.started_at }, 1),
      record({ kind: "goal.terminal", goal_id: receipt.goal_id, at: receipt.ended_at, receipt }, 2),
      record({ kind: "goal.reported", goal_id: receipt.goal_id, at: receipt.ended_at, report }, 3)];
    const later = { ...measured, debrief: { ...debrief, traits: ["修正から復帰"] as const, rare: evaluateRareAwards(true, "false", "true", "true") } };
    const saved = withSavedGoalReport(later, receipt, records);
    assert.deepEqual(saved.debrief?.rare, rare, "redisplay must use the first saved evaluation, not new observation");
    assert.deepEqual(saved.debrief?.traits, measured.debrief.traits, "saved operation traits remain consistent with the award snapshot");
    const career = summarizeCareer([records, records], { files: 1, included: 1, unavailable: 0, truncated: true });
    const result = { ...saved, career };
    const before = JSON.stringify(result);
    const outputs = ["ja", "en"].map(locale => {
      const text = formatSortieResult(result, { locale, implementation: "fixture/model stays verbatim", next: "none" });
      assert.match(text, /fixture\/model/u);
      assert.match(text, /█/u);
      assert.match(text, /1,500 tokens/u);
      assert.match(text, /\$0\.0200/u);
      assert.match(text, /host|Host/u);
      assert.doesNotMatch(text, /<details>|PACK RECORD|Detailed record|詳細記録/u);
      if (locale === "en") assert.doesNotMatch(text, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
      return text;
    });
    assert.equal(JSON.stringify(result), before, "locale and renderer never mutate saved state");
    if (name === "earned") {
      assert.equal(career.rare[0]!.earned, 1);
      assert.match(outputs[1]!.replace(/\n/gu, ""), /Quiet Strike — Award recorded/u);
    } else if (name === "combination") assert.equal(career.rare[1]!.earned, 1);
    else assert.ok(career.rare.every(item => item.earned === 0));
    for (const [index, locale] of ["ja", "en"].entries()) {
      const text = outputs[index]!;
      await writeFile(`${folder}/${name}.${locale}.md`, `<!-- SYNTHETIC fixture; actual formatSortieResult output; no real award -->\n${text}\n`);
      assert.match(text, /^```text\n🐾 SORTIE DOGS — /u);
      assert.match(text, /\n```$/u);
    }
    const source = "status: DONE — synthetic\n\n**Implementation:** fixture/model\n\n**Pending:** unverified\n\n**Next:** none";
    const en = insertSortieResult(source, result, "evidence-gaps", undefined, "en");
    assert.equal(insertSortieResult(en, result, "evidence-gaps", undefined, "en"), en);
    const switched = insertSortieResult(en, result, undefined, undefined, "ja");
    assert.equal((switched.match(/🐾 SORTIE DOGS — 帰還報告/gu) ?? []).length, 1, "locale switch replaces the old report");
    assert.match(switched, /fixture\/model/u);
    const stopped = { ...result, mission: { ...result.mission, status: "INTERRUPTED" as const } };
    const unfinished = formatSortieResult(stopped, { locale: "en" });
    assert.match(unfinished, /Not awarded \(unfinished\)/u);
    assert.doesNotMatch(unfinished, /Award recorded/u);
    assert.doesNotMatch(unfinished, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
  }
  const previous = process.env.SORTIE_REPORT_LOCALE;
  try {
    process.env.SORTIE_REPORT_LOCALE = "en-GB";
    assert.match(formatSortieResult(base), /Return Report/u);
    process.env.SORTIE_REPORT_LOCALE = "ja-JP";
    assert.match(formatSortieResult(base), /帰還報告/u);
    assert.match(formatSortieResult(base, { locale: "fr-FR" }), /Return Report/u);
    assert.equal(resolveReportLocale(""), "ja");
    assert.equal(resolveReportLocale("JA_jp"), "ja");
  } finally { if (previous === undefined) delete process.env.SORTIE_REPORT_LOCALE; else process.env.SORTIE_REPORT_LOCALE = previous; }
});

test("collects bounded recursive assistant metrics and deduplicates messages", async () => {
  const metrics = await collectRunMetrics({ session: {
    get: async () => ({ data: { time: { created: 1_000 } } }),
    children: async ({ path }) => ({ data: path.id === "root" ? [{ id: "child" }] : [] }),
    messages: async () => ({ data: [{ info: { id: "same", role: "assistant", agent: "dog-coordinator", cost: 0.25, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 1 } } }, time: { created: 2_000, completed: 3_000 } }] }),
  } }, "root", "test", 5_000);
  const { debrief, ...legacyMetrics } = metrics!;
  assert.ok(debrief);
  assert.deepEqual(legacyMetrics, {
    durationMilliseconds: 4_000,
    tokens: 19,
    inputTokens: 10,
    outputTokens: 2,
    reasoningTokens: 1,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    cost: 0.25,
    steps: 1,
    sessions: 2,
    cacheRatio: 5 / 19,
    roles: { "dog-coordinator": {
      tokens: 19,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 1,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      cost: 0.25,
      steps: 1,
      cacheRatio: 5 / 19,
    } },
  });
  assert.deepEqual(debrief?.sessions[0]?.modelUsage?.["未分類"], {
    tokens: 19, uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1,
    cost: 0.25, costAvailable: true, estimatedCost: 0, pricedRequests: 0, unpricedRequests: 1,
  });
  assert.match(formatRunMetrics(metrics!), /pre-terminal host snapshot[\s\S]*\$0\.2500/u);
  const original = "✅ **DONE** x\n\n**Validation:** keep\n\n<details>";
  const inserted = insertRunMetrics(original, metrics!);
  assert.match(inserted, /^✅ \*\*DONE\*\* x\n\n\*\*Run:\*\*/u);
  assert.match(inserted, /\*\*Run:\*\*[\s\S]*\n\n\*\*Validation:\*\* keep\n\n<details>$/u);
  assert.equal(insertRunMetrics(inserted, metrics!), inserted);
});

test("marks cost unavailable when an assistant has no finite host cost", async () => {
  const metrics = await collectRunMetrics({ session: { messages: async () => ({ data: [{ info: { id: "m", role: "assistant", tokens: { input: 1 } } }] }) } }, "root", undefined, 1);
  assert.equal(metrics?.cost, undefined);
  assert.match(formatRunMetrics(metrics!), /cost unavailable/);
});

test("deduplicates part usage identities and keeps zero cost distinct from missing cost", async () => {
  const part = { id: "shared-part", type: "step-finish", cost: 0, tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 1, write: 0 } } };
  const metrics = await collectRunMetrics({ session: {
    children: async ({ path }) => ({ data: path.id === "root" ? [{ id: "child" }] : [] }),
    messages: async () => ({ data: [{ info: { id: "wrapper", role: "assistant", agent: "dog-worker", cost: 0 },
      parts: [part, part, { id: "tool", type: "tool", cost: 99 }] }] }),
  } }, "root", undefined, 1);
  assert.equal(metrics?.tokens, 4);
  assert.equal(metrics?.cost, 0);
  assert.equal(metrics?.steps, 1);
  assert.equal(metrics?.roles?.["dog-worker"]?.tokens, 4);
});

test("scopes goal metrics to completed host messages inside the terminal receipt window", async () => {
  const message = (id: string, completed: number, input: number, cost: number) => ({ info: {
    id, role: "assistant", agent: "dog-coordinator", time: { completed }, cost,
    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } });
  const metrics = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [message("prior-goal", 500, 100, 1), message("current-goal", 1_500, 10, 0.1)] }),
  } }, "root", undefined, 3_000, {
    startedAt: "1970-01-01T00:00:01.000Z", endedAt: "1970-01-01T00:00:02.000Z",
  });
  assert.equal(metrics?.durationMilliseconds, 1_000);
  assert.equal(metrics?.tokens, 10);
  assert.equal(metrics?.cost, 0.1);
  assert.equal(metrics?.steps, 1);
});

test("recognizes only an accepted first terminal status line", () => {
  assert.equal(isDoneTerminalText("✅ **DONE** — complete\n\nbody **DONE**"), true);
  assert.equal(isDoneTerminalText("status: DONE — complete\n\nbody"), true);
  assert.equal(isDoneTerminalText("✅ conclusion: status: DONE; task_id: task-06; complete"), true);
  assert.equal(isDoneTerminalText("progress\n✅ **DONE** — body mention"), false);
  assert.equal(isDoneTerminalText("✅ **BLOCKED** — body **DONE**"), false);
  assert.equal(isDoneTerminalText("NEED_DECISION: DONE"), false);
  assert.equal(isDoneTerminalText("  ✅ **DONE** — indented"), false);
  assert.equal(terminalRunOutcome("✅ **DONE** — complete"), "DONE");
  assert.equal(terminalRunOutcome("⚠️ **INTERRUPTED** — incomplete"), "INTERRUPTED");
  assert.equal(terminalRunOutcome("⛔ **INTERRUPTED** `mvp1-projection-runner-r2` — 利用者選択により保留"), "INTERRUPTED");
  assert.equal(terminalRunOutcome("**INTERRUPTED** — user hold"), "INTERRUPTED");
  assert.equal(terminalRunOutcome("status: INTERRUPTED — explicit stop\nTRUE_INTERRUPTION: user: requested stop"), "INTERRUPTED");
  assert.equal(terminalRunOutcome("✅ conclusion: status: DONE; task_id: task-06; complete"), "DONE");
  assert.equal(terminalRunOutcome("❓ conclusion: status: NEED_DECISION; task_id: task-06; choose"), "NEED_DECISION");
  assert.equal(terminalRunOutcome("⛔ conclusion: status: DONE; task_id: task-06; mismatched"), undefined);
  assert.equal(terminalRunOutcome("❓ **NEED_DECISION** `scope` — choose"), "NEED_DECISION");
  assert.equal(terminalRunOutcome("⛔ **BLOCKED** `task` — waiting"), undefined);
  assert.equal(terminalRunOutcome("⛔ **BLOCKED** `task` — waiting\nTRUE_BLOCKER: external: service unavailable"), "BLOCKED");
  assert.equal(terminalRunOutcome("```\n⛔ **BLOCKED** fake\nTRUE_BLOCKER: external: fake\n```"), undefined);
  assert.equal(terminalRunOutcome("progress\nstatus: DONE — body example"), undefined);
  assert.equal(terminalRunOutcome("✅ **DONE** `task` — complete\nstatus: NEED_DECISION — evidence example"), "DONE");
});

test("replaces every accepted DONE spelling without rewriting examples", () => {
  const replacement = "status: IN_PROGRESS\ngoal_control: accepted criteria remain unproved";
  assert.equal(replaceDoneTerminalStatus("status: DONE — claimed\nbody", replacement), `${replacement}\nbody`);
  assert.equal(replaceDoneTerminalStatus("✅ **DONE** — claimed\nbody", replacement), `${replacement}\nbody`);
  assert.equal(replaceDoneTerminalStatus("✅ conclusion: status: DONE; task_id: task-06; claimed", replacement), replacement);
  assert.equal(replaceDoneTerminalStatus("progress\nstatus: DONE — example", replacement), "progress\nstatus: DONE — example");
  assert.equal(replaceTerminalStatus("status: NEED_DECISION — stale", "status: DONE"), "status: DONE");
});

test("sanitizes internal terminal fields without a metrics or result insertion", () => {
  const sanitized = sanitizeTerminalReport("status: INTERRUPTED\nreason_code: fake\nmanifest: hidden.json\n**EVIDENCE:** claim\n" +
    "```yaml\nraw_status: fake\n```\n<details>claim</details>");
  assert.equal(sanitized, "status: INTERRUPTED\n\n<details>claim</details>");
});

test("terminal cleanup preserves explanatory disclosures and code while removing only internal Evidence", () => {
  const explanation = "作業の目的と背景。\n\n<details><summary>詳しい説明</summary>\n\n" +
    "設計の理由を保持する。\n```yaml\nmanifest: example.json\n```\n</details>\n\n" +
    "使い方の例:\n```yaml\nmanifest: user-example.json\n```";
  assert.equal(sanitizeTerminalReport(explanation), explanation);
  const nestedEvidenceExample = "<details><summary>詳しい説明</summary>\n\n" +
    "Evidence: 公開出力の読み方\n```yaml\nmanifest: user-example.json\n```\n</details>";
  assert.equal(sanitizeTerminalReport(nestedEvidenceExample), nestedEvidenceExample,
    "an Evidence heading inside an explanatory disclosure is user prose, not internal evidence");
  assert.equal(sanitizeTerminalReport(`Evidence: internal proof\n${nestedEvidenceExample}`), nestedEvidenceExample,
    "an earlier internal heading must not consume code owned by an explanatory disclosure");
  const adjacentExample = "<details><summary>Explanation</summary>\nEvidence: illustrative example\n</details>\n" +
    "```yaml\nmanifest: user-example.json\n```";
  assert.equal(sanitizeTerminalReport(adjacentExample), adjacentExample,
    "a protected disclosure must not own the following code fence even without a blank line");
  const cleaned = sanitizeTerminalReport(explanation + "\n\n<details><summary>Evidence: validation</summary>hidden</details>");
  assert.equal(cleaned, explanation);
});

test("inserts metrics after the observed conclusion-status alias", async () => {
  const metrics = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [] }),
  } }, "root");
  const text = insertRunMetrics("✅ conclusion: status: DONE; task_id: task-06; complete\n\n**Next:** none", metrics!);
  assert.match(text, /^✅ conclusion: status: DONE;[^\n]+\n\n\*\*Run:\*\*/u);
  assert.equal(insertRunMetrics("progress\nstatus: DONE — body example", metrics!), "progress\nstatus: DONE — body example");
  const afterExamples = insertRunMetrics("> status: DONE — quoted example\n```\nstatus: DONE — fenced example\n```\n✅ **DONE** — complete", metrics!);
  assert.match(afterExamples, /```\n✅ \*\*DONE\*\* — complete\n\n\*\*Run:\*\*/u);
  const afterRunExample = insertRunMetrics("> **Run:** quoted example\n```\n**Run:** fenced example\n```\n✅ **DONE** — complete", metrics!);
  assert.match(afterRunExample, /```\n✅ \*\*DONE\*\* — complete\n\n\*\*Run:\*\*/u);
});

test("reports unavailable tokens and survives host failures", async () => {
  const missing = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [{ info: { id: "m", role: "assistant", tokens: { input: 1 } } }] }),
  } }, "root", undefined, 1);
  assert.equal(missing?.tokens, undefined);
  assert.equal(missing?.cacheRatio, undefined);
  assert.equal(missing?.durationMilliseconds, undefined);
  assert.match(formatRunMetrics(missing!), /tokens unavailable/);
  assert.match(formatRunMetrics(missing!), /duration unavailable/);
  assert.equal(await collectRunMetrics({ session: { messages: async () => { throw new Error("host"); } } }, "root"), undefined);
});

test("reports a zero pre-terminal snapshot for a single-turn DONE", async () => {
  const metrics = await collectRunMetrics({ session: {
    get: async () => ({ data: { time: { created: 1_000 } } }),
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [] }),
  } }, "root", undefined, 2_000);
  const { debrief, ...legacyMetrics } = metrics!;
  assert.ok(debrief);
  assert.deepEqual(legacyMetrics, {
    durationMilliseconds: 1_000,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    steps: 0,
    sessions: 1,
    cacheRatio: undefined,
    roles: {},
  });
  assert.match(formatRunMetrics(metrics!), /1s wall-clock · 0 tokens · \$0\.0000 · 0 completed assistant model steps · 1 session/u);
});

test("marks totals unavailable when child discovery is incomplete", async () => {
  const metrics = await collectRunMetrics({ session: {
    children: async () => { throw new Error("children unavailable"); },
    messages: async () => ({ data: [{ info: {
      id: "root", role: "assistant", cost: 0.1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }] }),
  } }, "root", undefined, 1);
  assert.equal(metrics?.tokens, undefined);
  assert.equal(metrics?.cost, undefined);
  assert.equal(metrics?.steps, undefined);
  assert.equal(metrics?.sessions, undefined);
  assert.match(formatRunMetrics(metrics!), /steps unavailable · sessions unavailable/u);
});

test("excludes the terminal assistant message until host accounting completes", async () => {
  const metrics = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [{ info: {
      id: "completed", role: "assistant", time: { completed: 2 }, cost: 0.1,
      tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }, { info: {
      id: "terminal", role: "assistant", time: { created: 3 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } }] }),
  } }, "root", undefined, 4);
  assert.equal(metrics?.tokens, 3);
  assert.equal(metrics?.steps, 1);
});

test("marks totals unavailable when an assistant message has no identity", async () => {
  const metrics = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [{ info: {
      role: "assistant", cost: 0.1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }, { info: {
      id: "known", role: "assistant", cost: 0.2,
      tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }] }),
  } }, "root", undefined, 1);
  assert.equal(metrics?.tokens, undefined);
  assert.equal(metrics?.cost, undefined);
  assert.equal(metrics?.steps, undefined);
  assert.equal(metrics?.sessions, 1);
});

test("builds a completed Sortie Result from the goal receipt, ledger, and host metrics", () => {
  const receipt = {
    goal_id: "goal-result", terminal_revision: 2, acceptance_fingerprint: `sha256:${"a".repeat(64)}`,
    started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:04.000Z",
    status: "succeeded" as const, stop_reason: "completed" as const, unit_ids: ["unit-1"],
    session_ids: ["root"], evidence_refs: ["evidence-1"], milestone_at: "2026-01-01T00:00:02.000Z",
  };
  const criterion = {
    criterion_id: "criterion-1", target: "target", entrypoint: "validator", workload: "work",
    oracle_coverage: ["behavior"], build_boundary: "included" as const, source: "source", candidate: "candidate",
    fixture: "fixture", proof_scope: "requested-full" as const, expected_outcome: "pass" as const,
  };
  const metrics = {
    durationMilliseconds: 4_100, tokens: 19, inputTokens: 10, outputTokens: 2, reasoningTokens: 1,
    cacheReadTokens: 5, cacheWriteTokens: 1, cost: 0.25, steps: 1, sessions: 2, cacheRatio: 5 / 16, roles: {},
  };
  const result = createSortieResult(receipt, {
    acceptance_contract: { criteria: [criterion] }, consumed_time_ms: 2_500, satisfied_criteria: ["criterion-1"],
  }, metrics, "2026-01-01T00:00:04.100Z");
  assert.deepEqual(result.result_id, ["goal-result", 2]);
  assert.deepEqual(result.speed.goal_wall_ms, { availability: "available", value: 4_000, provenance: "goal-receipt" });
  assert.deepEqual(result.speed.worker_execution_ms, { availability: "available", value: 2_500, provenance: "goal-ledger" });
  assert.deepEqual(result.speed.first_verifiable_ms, { availability: "available", value: 2_000, provenance: "goal-receipt" });
  assert.deepEqual(result.cost.total_tokens, { availability: "available", value: 19, provenance: "host-reported" });
  assert.equal(result.mission.status, "COMPLETED");
  assert.equal(result.proof.overall, "PASS");
  assert.deepEqual(result.proof.criteria.availability === "available" ? result.proof.criteria.value : null,
    [{ criterion_id: "criterion-1", status: "PASS" }]);
  const inserted = insertSortieResult("status: DONE — complete\n\n**Validation:** PASS", result);
  assert.ok(inserted.startsWith("status: DONE — complete\n\n```text\n🐾 SORTIE DOGS — 帰還報告｜🟢 完了\n"));
  assert.match(inserted, /📌 complete/u);
  assert.doesNotMatch(inserted, /<details>|詳細記録|⚑ MISSION|COST \/ PACK|goal-result/u);
  assert.match(inserted, /🛡 確認: 未記録 · ◔ 1\/1/u);
  assert.match(inserted, /⏱ 経過: 4s/u);
  assert.match(inserted, /🔧 成果: 未取得[\s\S]*⏳ 未実施: 未確認[\s\S]*➡️ 次: 未取得/u);
  assert.match(inserted, /host計上費用: \$0\.2500/u);
  assert.match(inserted, /19 tokens[\s\S]*予測費用（概算）: 計測不可/u);
  assert.doesNotMatch(inserted, /evidence-1|evidence ref|completed\)|sha256:/u);
  assert.equal(insertSortieResult(inserted, result), inserted);
  const explicitNone = insertSortieResult("status: DONE\n\n**未実施:** なし", result);
  assert.match(explicitNone, /⏳ 未実施: なし/u);
  const unknownCost = formatSortieResult({ ...result, cost: { ...result.cost,
    cost_usd: { availability: "unavailable", value: null, reason: "incomplete-host-coverage" } } });
  assert.match(unknownCost, /host計上費用: unknown/u);
  assert.doesNotMatch(unknownCost, /host計上費用: \$0/u);
  const gaps = insertSortieResult("status: DONE — checks passed\n\n**未実施:** 未解決の返却行\n\n**次:** なし", result,
    "evidence-gaps", "EVIDENCE_GAPS\n未解決の返却行");
  assert.match(gaps.replace(/\n/gu, ""), /Review: 🟡 補足あり（非ブロッキング・PASSではない）/u);
  assert.match(gaps, /レビュー補足: 未解決の返却行/u);
  assert.match(gaps, /⏳ 未実施: 未解決の返却行[\s\S]*➡️ 次: なし/u);
  assert.match(gaps, /\*\*次:\*\* なし/u);
  assert.equal(insertSortieResult(gaps, result, "evidence-gaps", "EVIDENCE_GAPS\n未解決の返却行"), gaps,
    "the native final renderer retains the host review verdict and next action");
  const specific = insertSortieResult("status: DONE\n\n**未実施:** Windows 検証未実施\n\n**次:** 返却行299を確認", result,
    "evidence-gaps", "EVIDENCE_GAPS\n自動省略の証拠不足");
  assert.match(specific, /⏳ 未実施: Windows 検証未実施/u);
  assert.match(specific, /レビュー補足: 自動省略の証拠不足/u);
  assert.match(specific, /➡️ 次: 返却行299を確認/u);
  const multiline = insertSortieResult("status: DONE\n\n**次:**\nなし\n\n```md\n**次:** なし\n```\n> **次:** なし", result,
    "evidence-gaps", "EVIDENCE_GAPS\n未解決の返却行");
  assert.match(multiline, /\*\*次:\*\*\nなし/u);
  assert.match(multiline, /```md\n\*\*次:\*\* なし\n```\n> \*\*次:\*\* なし/u,
    "quoted and fenced examples must not be changed");
  assert.match(insertSortieResult("status: DONE", result, "PASS"), /Review: 🟢 PASS（独立Reviewer）/u);
  const sanitized = insertSortieResult("status: DONE\n\n**EVIDENCE:** model claim\nraw_status: fake\n" +
    "```yaml\nEVIDENCE_REFS: [fake]\nraw: claim\n```\n<details><summary>Evidence</summary>fake</details>", result);
  assert.doesNotMatch(sanitized, /EVIDENCE|raw_status|EVIDENCE_REFS|raw: claim/iu);
});

test("renders completed, interrupted, external-blocker, and user-decision as distinct terminal states", () => {
  const base = {
    goal_id: "goal-stopped", terminal_revision: 1, acceptance_fingerprint: `sha256:${"b".repeat(64)}`,
    started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:01.000Z",
    status: "stopped" as const, unit_ids: [], session_ids: ["root"], evidence_refs: [], milestone_at: null,
  };
  const goal = { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] };
  const external = createSortieResult({ ...base, stop_reason: "external_dependency" }, goal, undefined);
  const interrupted = createSortieResult({ ...base, stop_reason: "stop_budget" }, goal, undefined);
  const decision = createSortieResult({ ...base, stop_reason: "awaiting_user" }, goal, undefined);
  assert.equal(external.mission.status, "EXTERNAL_BLOCKER");
  assert.equal(interrupted.mission.status, "INTERRUPTED");
  assert.equal(decision.mission.status, "USER_DECISION");
  assert.equal(external.proof.overall, "UNPROVEN");
  assert.equal(external.speed.worker_execution_ms.availability, "unavailable");
  const externalText = insertSortieResult("⛔ **BLOCKED** external\nTRUE_BLOCKER: external: service\n\n<details><summary>Evidence</summary>evidence_refs: secret</details>", external);
  const interruptedText = insertSortieResult("⚠️ **INTERRUPTED** incomplete", interrupted);
  const screenshotText = insertSortieResult("⛔ **INTERRUPTED** `runner` — 保留\n\n**Validation:** PASS\n\n" +
    "<details>\n<summary>Evidence: commit 1、validation 1、Scout 1</summary>\n\n```yaml\nmanifest:\n  raw_status: hidden\n```\n</details>", interrupted);
  assert.match(screenshotText, /帰還報告/u);
  assert.equal((screenshotText.match(/<details>/gu) ?? []).length, 0);
  assert.doesNotMatch(screenshotText, /Evidence|manifest:|raw_status/u);
  const decisionText = insertSortieResult("❓ **NEED_DECISION** choose", decision);
  assert.match(externalText, /🔴 外部要因で未完了/u);
  assert.match(interruptedText, /🟡 中断（未完了）/u);
  assert.match(decisionText.replace(/\n/gu, ""), /🟡 ユーザー判断待ち（未完了）/u);
  assert.doesNotMatch(externalText, /TRUE_BLOCKER|Evidence|evidence_refs/u);
});

test("types unavailable Sortie Result metrics without synthetic estimates", () => {
  const result = createSortieResult({
    goal_id: "goal-unavailable", terminal_revision: 1, acceptance_fingerprint: `sha256:${"c".repeat(64)}`,
    started_at: "unknown", ended_at: "also-unknown", status: "stopped", stop_reason: "stopped",
    unit_ids: [], session_ids: ["root"], evidence_refs: [], milestone_at: null,
  }, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  assert.deepEqual(result.cost.cost_usd,
    { availability: "unavailable", value: null, reason: "host-metrics-unavailable" });
  assert.deepEqual(result.speed.goal_wall_ms,
    { availability: "unavailable", value: null, reason: "goal-clock-invalid" });
  assert.deepEqual(result.proof.criteria,
    { availability: "unavailable", value: null, reason: "acceptance-contract-unavailable" });
  assert.match(formatSortieResult(result), /使用量: 計測不可/u);
  assert.doesNotMatch(formatSortieResult(result), /host-metrics-unavailable|goal-clock-invalid|evidence_refs/u);
  assert.doesNotMatch(formatSortieResult(result), /\$0\.0000|0 tokens/u);
  const selfchecked = formatSortieResult(result, { missionReview: "self-rechecked" });
  assert.match(selfchecked.replace(/\n/gu, ""), /自己再確認済み（修正著者・独立PASSではない）/);
  assert.doesNotMatch(selfchecked, /PASS（独立Reviewer）/);
  const broken = { ...result, debrief: { ...result.debrief!,
    estimatedCost: { usd: null as unknown as number, pricedRequests: 1, unpricedRequests: 0 } } };
  const fallback = insertSortieResult("status: INTERRUPTED", broken);
  assert.match(fallback, /```text\n🐾 SORTIE DOGS — 帰還報告｜⚠️ 未計測/u);
  assert.equal(insertSortieResult(fallback, broken), fallback, "the visible error fallback is replaced idempotently");
});

test("uses real terminal presentation fields without letting fenced status text become a checkpoint", () => {
  const result = createSortieResult({
    goal_id: "candidate-real", terminal_revision: 1, acceptance_fingerprint: `sha256:${"d".repeat(64)}`,
    started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:01.000Z",
    status: "stopped", stop_reason: "stop_budget", unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null,
  }, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  const source = "status: INTERRUPTED — budget reached\nTRUE_INTERRUPTION: budget: exhausted\n\n" +
    "**実装:** renderer `literal` and ``` input\n**未実施:** release\n**NEXT:** verify CLI\n**Commit:** abc123";
  const output = insertSortieResult(source, result);
  assert.match(output, /🟡 中断（未完了）[\s\S]*budget reached/u);
  assert.match(output.replace(/\n/gu, ""), /🔧 成果: renderer `literal` and ``` input[\s\S]*⏳ 未実施: release[\s\S]*➡️ 次: verify CLI/u);
  assert.match(output, /Commit: abc123[\s\S]*🛑 停止理由: budget: exhausted/u);
  assert.equal(terminalRunOutcome(output), "INTERRUPTED");
  assert.equal(insertSortieResult(output, result), output);
});

test("compact report keeps hostile Markdown fenced without producing a detailed record", () => {
  const id = `provider/model_${"x".repeat(160)}[v1]`;
  const receipt: GoalTerminalReceipt = { goal_id: id, terminal_revision: 1,
    acceptance_fingerprint: goalFingerprint(id), started_at: new Date(0).toISOString(),
    ended_at: new Date(1000).toISOString(), status: "succeeded", stop_reason: "completed",
    unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null };
  const base = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  const hostile = '</details><script>alert(1)</script> ![image](https://example.invalid) [link](javascript:alert(1)) ``` ~~~ &lt; **bold**';
  const result = { ...base, debrief: { ...base.debrief!, mix: [{ model: id, tokens: 1, percent: 100 }] } };
  for (const locale of ["ja", "en"]) {
    const output = formatSortieResult(result, { locale, implementation: hostile, pending: "1) not a list", next: "# not a heading ``` ~~~", commit: id });
    const opening = /^(`{3,})text\n/u.exec(output)?.[1];
    assert.ok(opening && opening.length > 3, "the delimiter must outlast injected backticks");
    assert.doesNotMatch(output, /\n<details>\n|Detailed record|詳細記録/u);
    assert.ok(output.replace(/\n/gu, "").includes(hostile), "literal user text is retained inside the fence");
    assert.ok(output.replace(/\n/gu, "").includes(id), "the supplied commit identifier is retained");
    assert.ok(output.includes("1) not a list"));
    assert.ok(output.includes("# not a heading"));
    assert.equal(returnReportPanel(`Before\n\n${output}\n\nAfter`), output);
  }
});

test("compact and legacy return panels extract and redisplay without consuming fenced examples", () => {
  const receipt: GoalTerminalReceipt = { goal_id: "panel-fixture", terminal_revision: 1,
    acceptance_fingerprint: goalFingerprint("panel-fixture"), started_at: new Date(0).toISOString(),
    ended_at: new Date(1000).toISOString(), status: "succeeded", stop_reason: "completed",
    unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null };
  const result = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  for (const locale of ["ja", "en"]) {
    const heading = locale === "ja" ? "帰還報告" : "Return Report";
    const legacy = `<details>\n<summary><strong>🐾 SORTIE DOGS — ${heading}</strong></summary>\n\nlegacy\n\n</details>`;
    const compact = formatSortieResult(result, { locale, next: "continue", missionReview: "self-rechecked" });
    const oldCompact = `${compact}\n\n<details>\n<summary>📜 ${locale === "ja" ? "詳細記録" : "Detailed record"}</summary>\n\nold long body\n\n</details>`;
    const migrated = insertSortieResult(`status: DONE\n\n${oldCompact}\n\n**Next:** continue`, result, "self-rechecked", undefined, locale);
    assert.equal(returnReportPanel(migrated), compact);
    assert.doesNotMatch(migrated, /old long body|詳細記録|Detailed record/u);
    assert.equal(returnReportPanel(`Before\n\n${legacy}\n\nAfter`), legacy);
    assert.equal(returnReportPanel(`Before\n\n${compact}\n\nAfter`), compact);
    for (const prefix of ["Updated the `<details>` renderer", "Updated the ``<details> `literal` </details>`` renderer"]) {
      assert.equal(returnReportPanel(`${prefix}\n\n${legacy}`), legacy);
      const source = `status: DONE\n\n${prefix}\n\n${compact}\n\n**Next:** continue`;
      for (const locate of [returnReportRange, compactReturnReportRange]) {
        const range = locate(source);
        assert.ok(range, "inline code tags must not hide the actual host panel");
        assert.equal(source.slice(range.start, range.end), compact);
      }
      assert.equal(returnReportPanel(source), compact);
      const inserted = insertSortieResult(source, result, "self-rechecked", undefined, locale);
      assert.equal(returnReportPanel(inserted), compact, "inline code must not hide the caller's next action either");
      assert.equal((inserted.match(/🐾 SORTIE DOGS — (?:帰還報告|Return Report)｜/gu) ?? []).length, 1);
      assert.ok(inserted.includes(prefix));
      assert.equal(insertSortieResult(inserted, result, "self-rechecked", undefined, locale), inserted);
      const legacySource = `status: DONE\n\n${prefix}\n\n${legacy}\n\n**Next:** continue`;
      const redisplayed = insertSortieResult(legacySource, result, "self-rechecked", undefined, locale);
      assert.ok(redisplayed.includes(prefix), "legacy replacement must preserve inline code and the surrounding caller prose");
      assert.equal(returnReportPanel(redisplayed), compact);
      assert.equal(insertSortieResult(redisplayed, result, "self-rechecked", undefined, locale), redisplayed);
    }
    for (const example of [legacy, compact]) {
      const disclosures = [
        "<details><summary>HTML example</summary>\n\n```html\n</details>\n```\n\n</details>",
        `<details><summary>Panel example</summary>\n\n~~~~html\n</details>\n${example}\n~~~~\n\n</details>`,
      ];
      for (const disclosure of disclosures) {
        assert.equal(returnReportPanel(disclosure), undefined, "a fenced panel inside a disclosure is only an example");
        const source = `${disclosure}\n\nstatus: DONE\n\n${example}\n\n**Next:** continue`;
        const range = returnReportRange(source);
        assert.ok(range, "a literal closing tag in a fenced disclosure must not hide the later host panel");
        assert.equal(source.slice(range.start, range.end), example);
        assert.equal(returnReportPanel(source), example);
        const compactRange = compactReturnReportRange(source);
        assert.equal(compactRange === undefined ? undefined : source.slice(compactRange.start, compactRange.end),
          example === compact ? compact : undefined);
        const inserted = insertSortieResult(source, result, "self-rechecked", undefined, locale);
        assert.ok(inserted.includes(disclosure), "the original fenced disclosure is preserved during redisplay");
        assert.equal(returnReportPanel(inserted), compact, "the terminal caller's next action survives the fenced disclosure");
        assert.equal(insertSortieResult(inserted, result, "self-rechecked", undefined, locale), inserted);
      }
      const quoted = `~~~~markdown\n${example}\n~~~~`;
      const disclosed = `<details><summary>Example</summary>\nLiteral closing tag: \`</details>\`\n${example}\n</details>`;
      assert.equal(returnReportPanel(quoted), undefined);
      assert.equal(returnReportPanel(disclosed), undefined);
      assert.equal(sanitizeTerminalReport(quoted), quoted);
      assert.equal(sanitizeTerminalReport(disclosed), disclosed, "inline closing tags must not truncate an explanatory disclosure");
      const source = `${quoted}\n\nstatus: DONE\n\n**Next:** continue`;
      const inserted = insertSortieResult(source, result, "self-rechecked", undefined, locale);
      assert.ok(inserted.includes(quoted));
      assert.equal(returnReportPanel(inserted), compact, "the actual panel wins over an earlier quoted legacy or compact example");
      assert.equal(insertSortieResult(inserted, result, "self-rechecked", undefined, locale), inserted);
    }
  }
});

test("compact primary report preserves measured gauges, partial cost and unfinished actions", () => {
  const receipt: GoalTerminalReceipt = { goal_id: "synthetic-hidden-identifier", terminal_revision: 1,
    acceptance_fingerprint: goalFingerprint("synthetic-hidden-identifier"), started_at: "unknown", ended_at: "unknown",
    status: "stopped", stop_reason: "stop_budget", unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null };
  const base = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] }, undefined);
  const model = `provider/${"long-model-name-".repeat(10)}v1`;
  const debrief = { ...base.debrief!, validation: "FAIL" as const, mixCoverage: { complete: false, observedTokens: 999 },
    pack: [{ model, count: 1 }], estimatedCost: { usd: 0.1, pricedRequests: 1, unpricedRequests: 1 },
    mix: [{ model, tokens: 999, percent: 100, hostCostZero: true,
      estimatedCost: { usd: 0.1, pricedRequests: 1, unpricedRequests: 1, complete: false } }] };
  const result = { ...base, debrief };
  const before = JSON.stringify(result);
  for (const locale of ["ja", "en"]) {
    const output = formatSortieResult(result, { locale, missionReview: "self-rechecked", pending: "Windows validation not run",
      stopReason: "budget exhausted", next: "resume verification" });
    const main = output;
    assert.doesNotMatch(output, /<details>|Detailed record|詳細記録|PACK RECORD/u);
    assert.match(main, /🟡/u);
    assert.match(main, /🔴 FAIL/u);
    assert.match(main, locale === "ja" ? /自己再確認済み/u : /Author self-rechecked/u);
    assert.match(main, /999 tokens/u);
    assert.match(main, locale === "ja" ? /観測分/u : /observed/u);
    assert.match(main, /\$0\.1000/u);
    assert.match(main, locale === "ja" ? /一部未換算/u : /partly unpriced/u);
    assert.match(main, /unknown/u);
    assert.match(main.replace(/\s+/gu, " "), locale === "ja" ? /請求総額ではない/u : /not the total bill/u);
    assert.match(main, /██████████/u);
    assert.match(main, /Windows validation not run/u);
    assert.match(main, /budget exhausted/u);
    assert.match(main, /resume verification/u);
    assert.doesNotMatch(main, /synthetic-hidden-identifier/u);
    assert.ok(main.replace(/\n/gu, "").includes(model), "model identity stays available without a detailed record");
    const widths = main.split("\n").slice(1, -1).map(line => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)]
      .reduce((sum, item) => sum + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}\uFF01-\uFF60]/u.test(item.segment) ? 2 : 1), 0));
    assert.ok(widths.every(width => width <= 48), `logical columns: ${widths.join(",")}`);
  }
  assert.equal(JSON.stringify(result), before, "presentation does not mutate the saved result");
});
