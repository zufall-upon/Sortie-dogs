// Keep this benchmark-local pricing snapshot aligned with src/plugin/model-cost.ts.
// The runner must start without importing a mutable build output under dist/.
const OPENAI = {
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.6-luna-fast": { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 2.4 },
};
const ANTHROPIC = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
};

const tokenCount = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Unknown identities and incomplete usage retain their reservation instead of becoming zero cost. */
export function estimateModelUsageCost(usage) {
  const counts = [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens,
    usage.outputTokens, usage.reasoningTokens];
  if (!counts.every(tokenCount)) return { status: "unpriced", reason: "missing-usage" };
  const lunaFastAlias = usage.providerID?.toLowerCase() === "openai" && usage.modelID === "gpt-6-luna-fast";
  const sol61FastAlias = usage.providerID?.toLowerCase() === "openai" && usage.modelID === "gpt-6.1-sol-fast";
  const alias = lunaFastAlias || sol61FastAlias;
  const fast = alias || (["fast", "priority"].includes(usage.serviceTier?.toLowerCase() ?? "") &&
    usage.providerID?.toLowerCase() === "openai" && ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"].includes(usage.modelID ?? ""));
  if (usage.serviceTier !== undefined && !(fast ? ["standard", "default", "fast", "priority"] : ["standard", "default"]).includes(usage.serviceTier.toLowerCase())) {
    return { status: "unpriced", reason: "unsupported-service-tier" };
  }
  const provider = usage.providerID?.toLowerCase();
  const model = lunaFastAlias ? "gpt-6-luna" : sol61FastAlias ? "gpt-6.1-sol" : usage.modelID;
  const base = provider === "openai" && model !== undefined && Object.hasOwn(OPENAI, model) ? OPENAI[model]
    : provider === "anthropic" && model !== undefined && Object.hasOwn(ANTHROPIC, model) ? ANTHROPIC[model] : undefined;
  if (base === undefined) return { status: "unpriced", reason: "unknown-model" };
  const requestInput = counts[0] + counts[1] + counts[2];
  const longContext = provider === "openai" && requestInput > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const usd = (fast ? 2 : 1) * (counts[0] * base.input * inputMultiplier + counts[1] * base.cacheRead * inputMultiplier +
    counts[2] * base.cacheWrite * inputMultiplier + (counts[3] + counts[4]) * base.output * outputMultiplier) / 1_000_000;
  if (!Number.isFinite(usd)) return { status: "unpriced", reason: "missing-usage" };
  return { status: "priced", usd, longContext, priceKey: `${provider}/${usage.modelID}${fast && !alias ? "#fast" : ""}` };
}
