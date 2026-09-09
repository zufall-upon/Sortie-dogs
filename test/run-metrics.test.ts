import assert from "node:assert/strict";
import test from "node:test";
import { collectRunMetrics, createSortieResult, formatRunMetrics, formatSortieResult, insertRunMetrics,
  insertSortieResult, isDoneTerminalText, replaceDoneTerminalStatus, replaceTerminalStatus, sanitizeTerminalReport,
  terminalRunOutcome } from "../src/plugin/run-metrics.ts";

test("collects bounded recursive assistant metrics and deduplicates messages", async () => {
  const metrics = await collectRunMetrics({ session: {
    get: async () => ({ data: { time: { created: 1_000 } } }),
    children: async ({ path }) => ({ data: path.id === "root" ? [{ id: "child" }] : [] }),
    messages: async () => ({ data: [{ info: { id: "same", role: "assistant", agent: "dog-coordinator", cost: 0.25, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 1 } } }, time: { created: 2_000, completed: 3_000 } }] }),
  } }, "root", "test", 5_000);
  assert.deepEqual(metrics, {
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
  assert.equal(sanitized, "status: INTERRUPTED");
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
  assert.deepEqual(metrics, {
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
    cacheReadTokens: 5, cacheWriteTokens: 1, cost: 0.25, steps: 1, sessions: 2, cacheRatio: 5 / 19, roles: {},
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
  assert.ok(inserted.startsWith("status: DONE — complete\n\n**Sortie Result**\n**Speed:**"));
  assert.match(inserted, /\*\*達成:\*\* 完了 · acceptance 1\/1/u);
  assert.doesNotMatch(inserted, /evidence-1|evidence ref|completed\)|sha256:/u);
  assert.equal(insertSortieResult(inserted, result), inserted);
  const sanitized = insertSortieResult("status: DONE\n\n**EVIDENCE:** model claim\nraw_status: fake\n" +
    "```yaml\nEVIDENCE_REFS: [fake]\nraw: claim\n```\n<details><summary>claim</summary>fake</details>", result);
  assert.doesNotMatch(sanitized, /EVIDENCE|raw_status|EVIDENCE_REFS|<details>|raw: claim/iu);
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
  const decisionText = insertSortieResult("❓ **NEED_DECISION** choose", decision);
  assert.match(externalText, /\*\*達成:\*\* 外部要因で未完了/u);
  assert.match(interruptedText, /\*\*達成:\*\* 中断（未完了）/u);
  assert.match(decisionText, /\*\*達成:\*\* ユーザー判断待ち（未完了）/u);
  assert.doesNotMatch(externalText, /TRUE_BLOCKER|external_dependency|<details>|Evidence|evidence_refs/u);
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
  assert.match(formatSortieResult(result), /Cost:[\s\S]*計測不可/u);
  assert.doesNotMatch(formatSortieResult(result), /host-metrics-unavailable|goal-clock-invalid|evidence_refs/u);
  assert.doesNotMatch(formatSortieResult(result), /\$0\.0000|0 tokens/u);
});
