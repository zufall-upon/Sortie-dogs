import assert from "node:assert/strict";
import test from "node:test";
import { collectRunMetrics, createSortieResult, formatRunMetrics, formatSortieResult, insertRunMetrics,
  insertSortieResult, isDoneTerminalText, replaceDoneTerminalStatus, replaceTerminalStatus, sanitizeTerminalReport,
  terminalRunOutcome, createGoalReport, withSavedGoalReport } from "../dist/plugin/run-metrics.js";
import { evaluateRareAwards } from "../dist/core/rare-awards.js";
import { goalFingerprint, type GoalTerminalReceipt, type GoalFlightEventRecord } from "../dist/core/goal-bound.js";
import { summarizeCareer } from "../dist/plugin/sortie-career.js";
import { resolveReportLocale } from "../dist/plugin/report-locale.js";
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
  assert.match(displayed, /🔧 Implementation\n利用者の説明/u);
  assert.match(displayed, /⏳ Pending\n利用者の保留/u);
  assert.match(displayed, /➡️ NEXT\n利用者の次操作/u);
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
      assert.match(text, /PACK RECORD/u);
      if (locale === "en") assert.doesNotMatch(text, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
      return text;
    });
    assert.equal(JSON.stringify(result), before, "locale and renderer never mutate saved state");
    if (name === "earned") {
      assert.equal(career.rare[0]!.earned, 1);
      assert.match(outputs[1]!, /Quiet Strike — Award recorded/u);
      assert.match(outputs[1]!, /Listed under special insignia/u);
    } else if (name === "combination") assert.equal(career.rare[1]!.earned, 1);
    else assert.ok(career.rare.every(item => item.earned === 0));
    for (const [index, locale] of ["ja", "en"].entries()) {
      const text = outputs[index]!;
      await writeFile(`${folder}/${name}.${locale}.md`, `<!-- SYNTHETIC fixture; actual formatSortieResult output; no real award -->\n${text}\n`);
      const body = text.slice(text.indexOf("~~~text\n") + 8, text.lastIndexOf("\n~~~"));
      const escape = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
      await writeFile(`${folder}/${name}.${locale}.html`, `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>Synthetic ${name} ${locale}</title><style>body{background:#171c1b;color:#ddd;font:14px monospace}pre{white-space:pre-wrap}summary{cursor:pointer}</style><p>SYNTHETIC fixture — actual text renderer, HTML pre wrapper; not native WebUI evidence.</p><details open><summary>${escape(name)} / ${locale}</summary><pre>${escape(body)}</pre></details></html>`);
    }
    const source = "status: DONE — synthetic\n\n**Implementation:** fixture/model\n\n**Pending:** unverified\n\n**Next:** none";
    const en = insertSortieResult(source, result, "evidence-gaps", undefined, "en");
    assert.equal(insertSortieResult(en, result, "evidence-gaps", undefined, "en"), en);
    const switched = insertSortieResult(en, result, undefined, undefined, "ja");
    assert.equal((switched.match(/<details>/gu) ?? []).length, 1, "locale switch replaces the old report");
    assert.match(switched, /fixture\/model/u);
    const stopped = { ...result, mission: { ...result.mission, status: "INTERRUPTED" as const } };
    const unfinished = formatSortieResult(stopped, { locale: "en" });
    assert.match(unfinished, /Not awarded \(unfinished\)/u);
    assert.doesNotMatch(unfinished.split("📜 PACK RECORD")[0]!, /Award recorded/u);
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
  assert.ok(inserted.startsWith("status: DONE — complete\n\n<details>\n<summary><strong>🐾 SORTIE DOGS — 帰還報告｜🟢 完了</strong></summary>"));
  assert.match(inserted, /~~~text\n🐾 SORTIE DOGS — 帰還報告\nTACTICAL DESK \/ 作戦卓\n─+\ngoal-result\n\n🟢 COMPLETED — complete/u);
  assert.match(inserted, /⚑ MISSION[\s\S]*経過\s+⏱ 4s ※待機含む[\s\S]*最終達成条件\s+◔ 1\/1/u);
  assert.match(inserted, /🔧 実装\n未取得[\s\S]*⏳ 未実施\n未確認（未実施なしを確認した意味ではありません）[\s\S]*➡️ NEXT\n未取得/u);
  assert.match(inserted, /✎ 称号・観測の根拠\n特別記章 — 保存判定未取得（授与未確認）\n特性の根拠未確認/u);
  assert.ok(inserted.indexOf("⚑ MISSION") < inserted.indexOf("✎ 称号・観測の根拠"));
  assert.match(inserted, /host計上費用\s+\$0\.2500/u);
  assert.match(inserted, /🪙 COST \/ PACK[\s\S]*19 tokens[\s\S]*予測費用\s+計測不可 ※予測概算/u);
  assert.match(inserted, /🛑 STOP REASON\ncompleted[\s\S]*➡️ NEXT\n未取得[\s\S]*※使用量は最終応答生成前の計測\n~~~/u);
  assert.ok(inserted.indexOf("🪙 COST / PACK") < inserted.indexOf("➡️ NEXT"));
  assert.match(inserted, /作戦称号\s+判定保留/u);
  assert.doesNotMatch(inserted, /evidence-1|evidence ref|completed\)|sha256:/u);
  assert.equal(insertSortieResult(inserted, result), inserted);
  const explicitNone = insertSortieResult("status: DONE\n\n**未実施:** なし", result);
  assert.match(explicitNone, /⏳ 未実施\nなし/u);
  const unknownCost = formatSortieResult({ ...result, cost: { ...result.cost,
    cost_usd: { availability: "unavailable", value: null, reason: "incomplete-host-coverage" } } });
  assert.match(unknownCost, /host計上費用\s+unknown（全体の計上額未取得）/u);
  assert.doesNotMatch(unknownCost, /host計上費用\s+\$0/u);
  const gaps = insertSortieResult("status: DONE — checks passed\n\n**未実施:** 未解決の返却行\n\n**次:** なし", result,
    "evidence-gaps", "EVIDENCE_GAPS\n未解決の返却行");
  assert.match(gaps, /SourceReview\s+🟡 補足あり（非ブロッキング・PASSではない）/u);
  assert.match(gaps, /レビュー補足\s+未解決の返却行/u);
  assert.match(gaps, /⏳ 未実施\n未解決の返却行[\s\S]*➡️ NEXT\nなし/u);
  assert.match(gaps, /\*\*次:\*\* なし/u);
  assert.equal(insertSortieResult(gaps, result, "evidence-gaps", "EVIDENCE_GAPS\n未解決の返却行"), gaps,
    "the native final renderer retains the host review verdict and next action");
  const specific = insertSortieResult("status: DONE\n\n**未実施:** Windows 検証未実施\n\n**次:** 返却行299を確認", result,
    "evidence-gaps", "EVIDENCE_GAPS\n自動省略の証拠不足");
  assert.match(specific, /⏳ 未実施\nWindows 検証未実施/u);
  assert.match(specific, /レビュー補足\s+自動省略の証拠不足/u);
  assert.match(specific, /➡️ NEXT\n返却行299を確認/u);
  const multiline = insertSortieResult("status: DONE\n\n**次:**\nなし\n\n```md\n**次:** なし\n```\n> **次:** なし", result,
    "evidence-gaps", "EVIDENCE_GAPS\n未解決の返却行");
  assert.match(multiline, /\*\*次:\*\*\nなし/u);
  assert.match(multiline, /```md\n\*\*次:\*\* なし\n```\n> \*\*次:\*\* なし/u,
    "quoted and fenced examples must not be changed");
  assert.match(insertSortieResult("status: DONE", result, "PASS"), /SourceReview\s+🟢 PASS（独立Reviewer）/u);
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
  assert.equal((screenshotText.match(/<details>/gu) ?? []).length, 1);
  assert.doesNotMatch(screenshotText, /Evidence|manifest:|raw_status/u);
  const decisionText = insertSortieResult("❓ **NEED_DECISION** choose", decision);
  assert.match(externalText, /🔴 EXTERNAL_BLOCKER/u);
  assert.match(interruptedText, /🟡 INTERRUPTED/u);
  assert.match(decisionText, /🟡 USER_DECISION/u);
  assert.doesNotMatch(externalText, /TRUE_BLOCKER|external_dependency|Evidence|evidence_refs/u);
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
  assert.match(formatSortieResult(result), /使用量\s+計測不可/u);
  assert.doesNotMatch(formatSortieResult(result), /host-metrics-unavailable|goal-clock-invalid|evidence_refs/u);
  assert.doesNotMatch(formatSortieResult(result), /\$0\.0000|0 tokens/u);
  const selfchecked = formatSortieResult(result, { missionReview: "self-rechecked" });
  assert.match(selfchecked, /自己再確認済み（修正著者・独立PASSではない）/);
  assert.doesNotMatch(selfchecked, /PASS（独立Reviewer）/);
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
  assert.match(output, /candidate-real[\s\S]*🟡 INTERRUPTED — budget reached/u);
  assert.match(output, /🔧 実装\nrenderer `literal` and ``` input[\s\S]*⏳ 未実施\nrelease[\s\S]*➡️ NEXT\nverify CLI/u);
  assert.match(output, /Commit\s+abc123[\s\S]*🛑 STOP REASON\nbudget: exhausted/u);
  assert.equal(terminalRunOutcome(output), "INTERRUPTED");
  assert.equal(insertSortieResult(output, result), output);
});
