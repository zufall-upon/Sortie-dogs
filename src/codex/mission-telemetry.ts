/** Native cumulative counters are observations, not billable API usage. */
import type { CodexUsageTotal, CodexUsageObservation } from "../core/operator-mission.js";
export type { CodexUsageTotal, CodexUsageObservation } from "../core/operator-mission.js";
export const emptyCodexUsage = (): CodexUsageTotal => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
  cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function codexUsageTotal(value: unknown): CodexUsageTotal | undefined {
  if (!record(value)) return;
  const keys = Object.keys(emptyCodexUsage()) as (keyof CodexUsageTotal)[];
  if (!keys.every(key => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0)) return;
  const result = Object.fromEntries(keys.map(key => [key, value[key]])) as unknown as CodexUsageTotal;
  if (result.totalTokens !== result.inputTokens + result.outputTokens || result.cachedInputTokens + result.cacheWriteInputTokens > result.inputTokens ||
      result.reasoningOutputTokens > result.outputTokens) return;
  return result;
}
export function codexTurnTokens(total: unknown, baseline: unknown): Record<string, unknown> | undefined {
  const end = codexUsageTotal(total), start = codexUsageTotal(baseline);
  if (!end || !start) return;
  const delta = Object.fromEntries((Object.keys(end) as (keyof CodexUsageTotal)[]).map(key => [key, end[key] - start[key]]));
  const usage = codexUsageTotal(delta);
  if (!usage) return;
  return { input: usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
    output: usage.outputTokens - usage.reasoningOutputTokens, reasoning: usage.reasoningOutputTokens,
    cache: { read: usage.cachedInputTokens, write: usage.cacheWriteInputTokens } };
}
export function codexNativeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
}
/** One mutable accounting message per turn: repeated snapshots replace, never add, cumulative usage. */
export function codexUsageInfo(observation: CodexUsageObservation): Record<string, unknown> {
  const tokens = codexTurnTokens(observation.total, observation.baseline);
  return { id: observation.turnID, role: "assistant", sessionID: observation.threadID, agent: observation.agent,
    providerID: observation.model.providerID, modelID: observation.model.modelID, billingMode: "chatgpt", usageGranularity: "native-turn",
    time: { created: observation.startedAt, completed: observation.updatedAt }, ...(tokens ? { tokens } : {}) };
}
