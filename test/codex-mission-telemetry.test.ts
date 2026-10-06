import assert from "node:assert/strict";
import test from "node:test";
import { codexTurnTokens, codexUsageInfo, codexUsageTotal, emptyCodexUsage, codexNativeTime } from "../dist/codex/mission-telemetry.js";
import { collectRunMetrics } from "../dist/plugin/run-metrics.js";

const total = (input: number, output: number, cached = 0, reasoning = 0) => ({ totalTokens: input + output,
  inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteInputTokens: 0, reasoningOutputTokens: reasoning });

test("Codex cumulative counters become disjoint turn buckets without counting cached/reasoning tokens twice", () => {
  assert.deepEqual(codexTurnTokens(total(382081,1763,345088,89), emptyCodexUsage()), {
    input: 36993, output: 1674, reasoning: 89, cache: { read: 345088, write: 0 },
  });
  assert.deepEqual(codexTurnTokens(total(150,25,80,7), total(100,10,40,2)), {
    input: 10, output: 10, reasoning: 5, cache: { read: 40, write: 0 },
  });
  assert.equal(codexTurnTokens(total(150,25), undefined), undefined, "cold missing baseline cannot attribute lifetime totals to one turn");
  assert.equal(codexTurnTokens(total(50,5), total(100,10)), undefined, "counter reset is not zero usage");
  assert.equal(codexUsageTotal(total(10,5,20)), undefined);
  assert.equal(codexUsageTotal({ ...total(10,5), totalTokens: 25 }), undefined);
  assert.equal(codexNativeTime(null), undefined); assert.equal(codexNativeTime(undefined), undefined);
  assert.equal(codexNativeTime(12.5), 12500);
});

test("common report uses Codex snapshots once, preserves tool timing and leaves subscription cost unavailable", async () => {
  const observation = { threadID: "root", turnID: "native-turn", startedAt: 1000, updatedAt: 2000,
    agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6.1-sol" }, baseline: emptyCodexUsage(), total: total(100,10,40,2) };
  const message = { info: codexUsageInfo(observation), parts: [] };
  const tool = { info: { id: "call", role: "assistant", codexToolReceipt: true, time: { created: 1200, completed: 1300 } },
    parts: [{ type: "tool", tool: "bash", callID: "call", state: { status: "completed", input: { command: "npm test" },
      metadata: { exit: 0 }, time: { start: 1200, end: 1300 } } }] };
  const control = { info: { id: "control", role: "assistant", codexToolReceipt: true, codexControlReceipt: true }, parts: [] };
  const client = { session: { get: async () => ({ data: { time: { created: 1000 } } }), children: async () => ({ data: [] }),
    messages: async () => ({ data: [message, tool, control, message] }) } };
  const first = await collectRunMetrics(client, "root", undefined, 2200);
  assert.equal(first?.tokens, 110); assert.equal(first?.cost, undefined); assert.equal(first?.steps, undefined);
  assert.equal(first?.durationMilliseconds, 1200);
  assert.equal(first?.debrief?.sessions[0]?.checks.length, 1);
  assert.equal(first?.debrief?.sessions[0]?.modelUsage?.["openai/gpt-6.1-sol"]?.pricedRequests, 0);
  assert.equal(first?.debrief?.sessions[0]?.modelUsage?.["openai/gpt-6.1-sol"]?.unpricedRequests, 1);
  message.info = codexUsageInfo({ ...observation, updatedAt: 2100, total: total(150,25,80,7) });
  const latest = await collectRunMetrics(client, "root", undefined, 2300);
  assert.equal(latest?.tokens, 175, "updated snapshot replaces rather than adds old totals");
  message.info = codexUsageInfo({ ...observation, baseline: undefined });
  assert.equal((await collectRunMetrics(client, "root"))?.tokens, undefined);
});


test("native accounting and Mission lifecycle instances share the same in-process state writer", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OperatorMissionRuntime } = await import("../dist/core/operator-mission.js");
  const { V010_RUNTIME_PROFILE } = await import("../dist/core/runtime-profile.js");
  const directory = await mkdtemp(join(tmpdir(), "codex-accounting-writer-"));
  try {
    const first = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    const second = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await first.capture("root", { id: "user", text: "Keep native accounting with this Mission." });
    await first.start("root", ["Keep native accounting with this Mission."]);
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).update("root", state => { state.plans++; })));
    assert.equal((await first.required("root")).plans, 20);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
