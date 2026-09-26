import { estimateModelUsageCost } from "./model-cost.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Price complete native requests; absent/interrupted usage is unknown, never a fabricated zero. */
export function settledUnitUsage(messages: readonly unknown[], startedAt?: string): number | null {
  let cost = 0, requests = 0;
  const seen = new Set<string>();
  for (const message of messages) {
    if (!record(message) || !record(message.info) || message.info.role !== "assistant") continue;
    const info = message.info;
    if (typeof info.id !== "string" || seen.has(info.id)) continue;
    seen.add(info.id);
    const time = record(info.time) ? info.time : undefined;
    if (startedAt) {
      if (typeof time?.created !== "number") return null;
      if (time.created < Date.parse(startedAt)) continue;
    }
    if (typeof time?.completed !== "number") return null;
    const tokens = record(info.tokens) ? info.tokens : undefined;
    const cache = record(tokens?.cache) ? tokens.cache : undefined;
    if (info.error && [tokens?.input, tokens?.output, tokens?.reasoning, cache?.read, cache?.write]
      .every(value => value === 0 || value === undefined)) return null;
    const estimate = estimateModelUsageCost({
      providerID: typeof info.providerID === "string" ? info.providerID : undefined,
      modelID: typeof info.modelID === "string" ? info.modelID : undefined,
      uncachedInputTokens: typeof tokens?.input === "number" ? tokens.input : undefined,
      outputTokens: typeof tokens?.output === "number" ? tokens.output : undefined,
      reasoningTokens: typeof tokens?.reasoning === "number" ? tokens.reasoning : undefined,
      cacheReadTokens: typeof cache?.read === "number" ? cache.read : undefined,
      cacheWriteTokens: typeof cache?.write === "number" ? cache.write : undefined,
      serviceTier: typeof info.serviceTier === "string" ? info.serviceTier : undefined,
    });
    if (estimate.status !== "priced") return null;
    requests++;
    cost += estimate.usd;
  }
  return requests ? cost : null;
}
