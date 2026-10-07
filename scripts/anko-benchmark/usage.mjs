import { DatabaseSync } from 'node:sqlite';

export const nativeTerminal = session => Number.isFinite(session?.time_idle ?? session?.time?.idle) &&
  ['succeeded', 'failed', 'interrupted'].includes(session?.idle_outcome ?? session?.outcome);
const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 });
const routeOf = model => model?.providerID && model?.id
  ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}` : 'unidentified-model';
const validCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// A missing provider usage receipt is an accounting gap, not a native retry gate.
// Unsupported prices still stop; unknown totals never become zero or complete.
export const usageSafetyStopReason = usage => usage.records.some(record => record.status === 'unpriced-usage')
  ? 'unpriced-usage-safety-stop' : null;

// Token completeness, price availability and actual billing are different facts.
export function classifyUsage(message, session, estimate) {
  const tokens = message.tokens;
  const counts = { input: tokens?.input, output: tokens?.output, reasoning: tokens?.reasoning,
    cache_read: tokens?.cache?.read, cache_write: tokens?.cache?.write };
  const complete = Object.values(counts).every(validCount);
  // V2 can retain a prior idle while a background child wakes the parent again.
  // That older idle is not a terminal observation for the newer message.
  const idle = session?.time_idle ?? session?.time?.idle;
  const created = message.time?.created;
  const currentIdle = nativeTerminal(session) && (!Number.isFinite(created) || idle >= created);
  const terminal = Number.isFinite(message.time?.completed) || Boolean(message.error) ||
    ['completed', 'failed'].includes(message.status) || currentIdle;
  if (!complete) return { status: terminal ? 'missing-terminal-usage' : 'pending-usage',
    reason: 'missing-usage', usd: null, token_usage: counts };
  const result = estimate({ providerID: message.model?.providerID, modelID: message.model?.id,
    uncachedInputTokens: counts.input, outputTokens: counts.output, reasoningTokens: counts.reasoning,
    cacheReadTokens: counts.cache_read, cacheWriteTokens: counts.cache_write,
    serviceTier: typeof message.providerState?.serviceTier === 'string' ? message.providerState.serviceTier : undefined });
  if (result.status !== 'priced' || !validCount(result.usd)) return {
    status: 'unpriced-usage', reason: result.reason ?? 'invalid-price', usd: null, token_usage: counts };
  return { status: 'priced', reason: null, usd: result.usd, price_key: result.priceKey, token_usage: counts };
}

export function summarizeOwnedUsage(allSessions, allMessages, rootID, estimate) {
  const queue = [rootID], owned = new Set();
  for (let i = 0; i < queue.length; i += 1) {
    if (owned.has(queue[i])) continue;
    owned.add(queue[i]);
    for (const child of allSessions.filter(item => item.parent_id === queue[i])) queue.push(child.id);
  }
  if (!allSessions.some(item => item.id === rootID)) throw new Error('owned usage root is missing');
  const sessions = allSessions.filter(item => owned.has(item.id)).map(item => ({ ...item,
    configured_model: item.model ? routeOf(typeof item.model === 'string' ? JSON.parse(item.model) : item.model) : null,
    model: undefined, active: !nativeTerminal(item), native_terminal_observed: nativeTerminal(item),
    observed_models: [], assistant_messages: 0, compaction_messages: 0, token_usage: emptyTokens() }));
  const models = {}, records = [];
  let usd = 0, priced = 0, unpriced = 0, pending = 0, missing = 0;
  for (const row of allMessages.filter(item => owned.has(item.session_id) && ['assistant', 'compaction'].includes(item.type))) {
    const message = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const session = sessions.find(item => item.id === row.session_id);
    const route = routeOf(message.model);
    const classification = classifyUsage(message, session, estimate);
    const bucket = models[route] ??= { messages: 0, priced_messages: 0, unpriced_messages: 0,
      pending_messages: 0, missing_token_messages: 0, priced_usd: 0, price_keys: [], service_tiers: [],
      token_usage: emptyTokens() };
    if (row.type === 'assistant') session.assistant_messages += 1;
    else session.compaction_messages += 1;
    bucket.messages += 1;
    if (row.type === 'assistant' && !session.observed_models.includes(route)) session.observed_models.push(route);
    for (const [key, count] of Object.entries(classification.token_usage)) if (validCount(count)) {
      bucket.token_usage[key] += count;
      session.token_usage[key] += count;
    }
    if (classification.reason === 'missing-usage') { missing += 1; bucket.missing_token_messages += 1; }
    if (classification.status === 'priced') {
      usd += classification.usd; priced += 1; bucket.priced_messages += 1; bucket.priced_usd += classification.usd;
      if (!bucket.price_keys.includes(classification.price_key)) bucket.price_keys.push(classification.price_key);
    } else if (classification.status === 'pending-usage') { pending += 1; bucket.pending_messages += 1; }
    else { unpriced += 1; bucket.unpriced_messages += 1; }
    const tier = message.providerState?.serviceTier;
    if (typeof tier === 'string' && !bucket.service_tiers.includes(tier)) bucket.service_tiers.push(tier);
    records.push({ id: row.id ?? message.id, session_id: row.session_id, message_type: row.type, model: route,
      time: message.time, status: classification.status, reason: classification.reason,
      estimated_usd: classification.usd, error_type: message.error?.type ?? null,
      transport_close_code: /WebSocket closed with code (\d+)/u.exec(message.error?.message ?? '')?.[1] ?? null,
      retry: message.retry ? { attempt: message.retry.attempt, at: message.retry.at } : null });
  }
  return { priced_usd: usd, priced_messages: priced, unpriced_messages: unpriced, pending_messages: pending,
    missing_token_messages: missing, cost_estimate_complete: unpriced === 0 && pending === 0,
    estimated_total_usd: unpriced === 0 && pending === 0 ? usd : null, actual_billed_usd: null,
    models, sessions, records };
}

export function readOwnedUsage(path, rootID, estimate) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // One consistent snapshot for ownership, terminal state and request usage.
    db.exec('BEGIN');
    const sessions = db.prepare('SELECT id,parent_id,agent,model,time_idle,idle_outcome,time_updated FROM session_v2').all();
    const messages = db.prepare("SELECT id,session_id,type,data FROM session_message WHERE type IN ('assistant','compaction')").all();
    return summarizeOwnedUsage(sessions, messages, rootID, estimate);
  } finally { db.close(); }
}
