export const MODEL_COST_PRICING_SNAPSHOT = {
  checkedAt: "2026-09-23",
  currency: "USD",
  unit: "1M tokens",
  sources: [
    "https://developers.openai.com/api/docs/pricing",
    "https://developers.openai.com/api/docs/models/gpt-6-astra",
    "https://developers.openai.com/api/docs/models/gpt-6-sol",
    "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
    "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    "https://platform.claude.com/docs/en/about-claude/pricing",
  ],
  assumptions: [
    "OpenAI Standard pricing; requests above 272,000 total input/cache tokens use 2x input/cache and 1.5x output pricing.",
    "Anthropic Standard pricing with the 5-minute cache-write rate; Fast, Batch, Flex, regional, tool, and subscription charges are excluded.",
    "variant and serviceTier are separate; model variants do not alter the selected Standard token price.",
    "gpt-5.6-luna-fast has no published model page; its rates are the resolved host model catalog entry for openai/gpt-5.6-luna-fast, exactly twice the Luna Standard schedule. That entry declares no separate long-context band, so the shared OpenAI band above is applied rather than a second assumed schedule.",
  ],
} as const;

export interface ModelCostUsage {
  readonly providerID: string | undefined;
  readonly modelID: string | undefined;
  readonly uncachedInputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly serviceTier?: string;
}

export type ModelCostEstimate =
  | { readonly status: "priced"; readonly usd: number; readonly longContext: boolean; readonly priceKey: string }
  | { readonly status: "unpriced"; readonly reason: "missing-usage" | "unknown-model" | "unsupported-service-tier" };

type Prices = { input: number; cacheRead: number; cacheWrite: number; output: number };

const OPENAI: Readonly<Record<string, Prices>> = {
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.6-luna-fast": { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 2.4 },
};
const ANTHROPIC: Readonly<Record<string, Prices>> = {
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
};

const tokenCount = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Pure request-level estimate. Unknown identities and incomplete usage never become synthetic zero cost. */
export function estimateModelUsageCost(usage: ModelCostUsage): ModelCostEstimate {
  const counts = [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens,
    usage.outputTokens, usage.reasoningTokens];
  if (!counts.every(tokenCount)) return { status: "unpriced", reason: "missing-usage" };
  if (usage.serviceTier !== undefined && !["standard", "default"].includes(usage.serviceTier.toLowerCase())) {
    return { status: "unpriced", reason: "unsupported-service-tier" };
  }
  const provider = usage.providerID?.toLowerCase();
  const model = usage.modelID;
  const base = provider === "openai" && model !== undefined && Object.hasOwn(OPENAI, model) ? OPENAI[model]
    : provider === "anthropic" && model !== undefined && Object.hasOwn(ANTHROPIC, model) ? ANTHROPIC[model] : undefined;
  if (base === undefined) return { status: "unpriced", reason: "unknown-model" };
  const requestInput = counts[0]! + counts[1]! + counts[2]!;
  const longContext = provider === "openai" && requestInput > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const usd = (counts[0]! * base.input * inputMultiplier + counts[1]! * base.cacheRead * inputMultiplier +
    counts[2]! * base.cacheWrite * inputMultiplier + (counts[3]! + counts[4]!) * base.output * outputMultiplier) / 1_000_000;
  if (!Number.isFinite(usd)) return { status: "unpriced", reason: "missing-usage" };
  return { status: "priced", usd, longContext, priceKey: `${provider}/${model}` };
}
