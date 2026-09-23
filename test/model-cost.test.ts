import assert from "node:assert/strict";
import test from "node:test";
import { estimateModelUsageCost, MODEL_COST_PRICING_SNAPSHOT } from "../dist/plugin/model-cost.js";

const estimate = (modelID: string, overrides: Partial<Parameters<typeof estimateModelUsageCost>[0]> = {}) =>
  estimateModelUsageCost({ providerID: "openai", modelID, uncachedInputTokens: 100_000,
    cacheReadTokens: 100_000, cacheWriteTokens: 10_000, outputTokens: 10_000, reasoningTokens: 5_000, ...overrides });

test("snapshot identifies the checked official sources and Standard assumptions", () => {
  assert.equal(MODEL_COST_PRICING_SNAPSHOT.checkedAt, "2026-09-23");
  assert.ok(MODEL_COST_PRICING_SNAPSHOT.sources.some(source => source.includes("developers.openai.com")));
  assert.ok(MODEL_COST_PRICING_SNAPSHOT.sources.some(source => source.includes("platform.claude.com")));
  assert.match(MODEL_COST_PRICING_SNAPSHOT.assumptions.join(" "), /Standard[\s\S]*5-minute/u);
});

test("calculates verified aliases per request and charges reasoning output once", () => {
  const sol = estimate("gpt-5.6-sol");
  const alias = estimate("gpt-5.6");
  assert.deepEqual(sol, { status: "priced", usd: 0.79, longContext: false, priceKey: "openai/gpt-5.6-sol" });
  assert.deepEqual(alias, { status: "priced", usd: 0.79, longContext: false, priceKey: "openai/gpt-5.6" });
  assert.deepEqual(estimate("gpt-6-sol"), { status: "priced", usd: 0.395, longContext: false, priceKey: "openai/gpt-6-sol" });
  const anthropic = estimateModelUsageCost({ providerID: "anthropic", modelID: "claude-opus-5",
    uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    outputTokens: 500_000, reasoningTokens: 0 });
  assert.deepEqual(anthropic, { status: "priced", usd: 24.25, longContext: false, priceKey: "anthropic/claude-opus-5" });
});

test("prices the released GPT-6 Sol and Luna definitions from their official schedules", () => {
  assert.deepEqual(estimate("gpt-6-sol"), { status: "priced", usd: 0.395, longContext: false, priceKey: "openai/gpt-6-sol" });
  assert.deepEqual(estimate("gpt-6-luna"), { status: "priced", usd: 0.01975, longContext: false, priceKey: "openai/gpt-6-luna" });
});

test("prices the Luna fast route so a routed worker never audits as unpriced", () => {
  const current = estimate("gpt-6-luna-fast");
  assert.deepEqual(current, { status: "priced", usd: 0.0395, longContext: false, priceKey: "openai/gpt-6-luna-fast" });
  assert.deepEqual(estimate("gpt-6-luna-fast", { serviceTier: "priority" }), current, "do not double-apply the Fast multiplier");
  const luna = estimate("gpt-5.6-luna");
  const fast = estimate("gpt-5.6-luna-fast");
  assert.deepEqual(luna, { status: "priced", usd: 0.0425, longContext: false, priceKey: "openai/gpt-5.6-luna" });
  assert.deepEqual(fast, { status: "priced", usd: 0.085, longContext: false, priceKey: "openai/gpt-5.6-luna-fast" });
  assert.match(MODEL_COST_PRICING_SNAPSHOT.assumptions.join(" "), /gpt-5\.6-luna-fast[\s\S]*twice the GPT-5\.6 Luna Standard schedule/u);
});

test("applies the OpenAI long-context band to each request instead of aggregate usage", () => {
  const long = estimate("gpt-5.6-sol", { uncachedInputTokens: 272_001, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 10_000, reasoningTokens: 0 });
  assert.deepEqual(long, { status: "priced", usd: 2.476008, longContext: true, priceKey: "openai/gpt-5.6-sol" });
  const shortA = estimate("gpt-5.6-sol", { uncachedInputTokens: 140_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningTokens: 0 });
  const shortB = estimate("gpt-5.6-sol", { uncachedInputTokens: 140_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningTokens: 0 });
  assert.equal(shortA.status === "priced" ? shortA.usd : NaN, 0.56);
  assert.equal(shortB.status === "priced" ? shortB.usd : NaN, 0.56);
});

test("leaves unknown models, missing usage, and non-Standard service tiers unpriced", () => {
  assert.deepEqual(estimate("gpt-5.6-sol-fast"), { status: "unpriced", reason: "unknown-model" });
  for (const modelID of ["constructor", "__proto__", "toString"]) {
    assert.deepEqual(estimate(modelID), { status: "unpriced", reason: "unknown-model" });
  }
  assert.deepEqual(estimate("gpt-5.6-sol", { cacheReadTokens: undefined }), { status: "unpriced", reason: "missing-usage" });
  assert.deepEqual(estimate("gpt-5.6-sol", { uncachedInputTokens: Number.MAX_VALUE }),
    { status: "unpriced", reason: "missing-usage" });
  assert.deepEqual(estimate("gpt-5.6-sol", { serviceTier: "fast" }), { status: "unpriced", reason: "unsupported-service-tier" });
});
