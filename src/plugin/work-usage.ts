import { isRecord, type WorkUsageReceipt } from "../core/work-loop.js";
import { estimateModelUsageCost } from "./model-cost.js";

/** OpenAI native response usage includes cached input and reasoning in its totals. */
export function auxiliaryResponseUsage(model: { providerID: string; id: string }, value: unknown, requestedTier?: string): Omit<WorkUsageReceipt, "session"> | undefined {
  if (!isRecord(value)) return;
  const response = isRecord(value.response) ? value.response : value;
  const usage = response.usage;
  if (!isRecord(usage) || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) return;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0, reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  if (![cached, reasoning].every(n => Number.isInteger(n) && n >= 0) || cached > usage.input_tokens || reasoning > usage.output_tokens) return;
  const tier = requestedTier ?? (model.id === "gpt-6-luna-fast" ? "priority" : response.service_tier ?? "standard");
  const estimate = estimateModelUsageCost({ providerID: model.providerID, modelID: model.id,
    uncachedInputTokens: usage.input_tokens - cached, cacheReadTokens: cached, cacheWriteTokens: 0,
    outputTokens: usage.output_tokens - reasoning, reasoningTokens: reasoning, serviceTier: tier });
  return { model: `${model.providerID}/${model.id}`, tokens: usage.input_tokens + usage.output_tokens,
    usd: estimate.status === "priced" ? estimate.usd : null, requestedTier: tier,
    ...(typeof response.service_tier === "string" ? { tier: response.service_tier } : {}), pending: false };
}

/** Observe a cloned SSE/JSON response without consuming or replacing native delivery. */
export async function observeAuxiliaryResponse(response: Response, onValue: (value: unknown) => Promise<void>) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder(); let buffer = "", data = "";
  // Native/provider bridges may omit Content-Type. Detect the actual framing
  // without consuming the native response or assuming that missing means JSON.
  let sse: boolean | undefined = response.headers.get("content-type")?.includes("text/event-stream") ? true : undefined;
  const parse = async (text: string) => { try { await onValue(JSON.parse(text)); } catch { /* Unknown/partial usage remains retained. */ } };
  const flush = async () => { if (data.trim() && data.trim() !== "[DONE]") await parse(data); data = ""; };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length + data.length > 8 * 1024 * 1024) return;
      if (sse === undefined) {
        const start = buffer.trimStart();
        if (/^(:|(?:event|data|id|retry):)/u.test(start)) sse = true;
        else if (/^[{[]/u.test(start)) sse = false;
      }
      if (sse) {
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/u, ""); buffer = buffer.slice(end + 1);
          if (!line.trim()) await flush();
          else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /u, "") + "\n";
          if (data.length > 8 * 1024 * 1024) return;
        }
      }
      if (done) {
        if (sse) { if (buffer.startsWith("data:")) data += buffer.slice(5); await flush(); }
        else if (buffer.trim()) await parse(buffer);
        return;
      }
    }
  } finally { void reader.cancel().catch(() => undefined); }
}
