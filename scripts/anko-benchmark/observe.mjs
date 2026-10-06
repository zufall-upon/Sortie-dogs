import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeTerminal } from './usage.mjs';

export function observeSessionTurn(turns, event) {
  if (!event.session_id || !Number.isFinite(event.created)) return;
  const previous = turns.get(event.session_id) ?? {};
  if (event.type === 'session.execution.started' && event.created >= (previous.started_at ?? -Infinity)) {
    turns.set(event.session_id, { ...previous, started_at: event.created,
      terminal_at: null, terminal_outcome: null });
  } else if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type) &&
      event.created >= Math.max(previous.started_at ?? -Infinity, previous.terminal_at ?? -Infinity)) {
    turns.set(event.session_id, { ...previous, terminal_at: event.created,
      terminal_outcome: event.type.slice('session.execution.'.length) });
  }
}

// Enqueue acknowledgement is not evidence of execution or completion.
export function expectSessionTurn(turns, sessionID, requestedAt = Date.now()) {
  turns.set(sessionID, { ...(turns.get(sessionID) ?? {}), requested_at: requestedAt });
}

export function nativeTurnTerminal(session, turns = new Map()) {
  if (!nativeTerminal(session) || session.active === true) return false;
  const turn = turns.get(session.id);
  if (!turn) return true;
  if (turn.requested_at != null && !(turn.started_at >= turn.requested_at)) return false;
  if (turn.started_at == null) return true;
  const idle = session.time_idle ?? session.time?.idle;
  return idle > turn.started_at || (idle >= turn.started_at && turn.terminal_at >= turn.started_at &&
    turn.terminal_outcome === (session.idle_outcome ?? session.outcome));
}

// Native events and polled plugin hooks share terminal tombstones. A delayed
// before/start event cannot revive a call already ended through either channel.
export function observeToolEvent(tools, terminalTools, event, now = Date.now()) {
  if (!event.session_id || !event.call_id) return;
  const key = `${event.session_id}/${event.call_id}`;
  const type = event.type ?? event.phase;
  if (['session.tool.success', 'session.tool.failed', 'plugin-hook-after'].includes(type)) {
    terminalTools.add(key);
    tools.delete(key);
    return;
  }
  if (terminalTools.has(key)) return;
  const prior = tools.get(key);
  if (['session.tool.called', 'session.tool.input.started', 'plugin-hook-before'].includes(type)) {
    tools.set(key, { session_id: event.session_id, call_id: event.call_id,
      name: event.tool ?? prior?.name ?? null, path: event.path ?? prior?.path ?? null,
      started_at: prior?.started_at ?? now, last_progress_at: now,
      last_event_type: type, observed_at: event.observed_at ?? event.at });
  } else if (prior && ['session.tool.input.delta', 'session.tool.input.ended', 'session.tool.progress'].includes(type)) {
    tools.set(key, { ...prior, last_progress_at: now, last_event_type: type,
      observed_at: event.observed_at ?? event.at });
  }
}

export function safeNativeEvent(event, toolName = null) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const input = data.input && typeof data.input === 'object' ? data.input : {};
  const name = toolName ?? data.name ?? null;
  const toolPath = name === 'read' ? (input.filePath ?? input.path ?? input.filepath ?? data.path ?? null) : null;
  const tokens = data.tokens;
  const selected = { type: event?.type ?? null, id: event?.id ?? null, created: event?.created ?? null,
    session_id: data.sessionID ?? null, assistant_message_id: data.assistantMessageID ?? null,
    call_id: data.id ?? data.callID ?? data.requestID ?? null, tool: name,
    path: typeof toolPath === 'string' ? toolPath : undefined,
    action: data.action ?? null, resources: Array.isArray(data.resources) ? data.resources.map(String) : undefined,
    reply: data.reply ?? undefined, executed: data.executed ?? undefined,
    delta_bytes: typeof data.delta === 'string' ? Buffer.byteLength(data.delta) : undefined,
    error_type: typeof data.error?.type === 'string' ? data.error.type : undefined,
    transport_close_code: /WebSocket closed with code (\d+)/u.exec(data.error?.message ?? '')?.[1],
    retry_attempt: data.attempt, retry_at: data.at,
    usage_present: Object.hasOwn(data, 'tokens'),
    tokens: tokens ? { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning,
      cache: { read: tokens.cache?.read, write: tokens.cache?.write } } : undefined };
  return Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== undefined));
}

// A failed API observation is not progress or a reason to skip the caller's deadline.
export async function observeSessionState(read, recordError) {
  try { return await read(); }
  catch (error) {
    if (!/timed out|timeout|aborted/iu.test(String(error))) throw error;
    const observation = { status: 'query-error', error: String(error) };
    await recordError(observation);
    return { outcome: null, time: {}, observation_error: observation };
  }
}

export async function installObservationFiles(project) {
  const control = join(project, '.opencode');
  const directory = join(control, 'plugins/anko-benchmark-observer');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'package.json'), '{"private":true,"type":"module","main":"./index.js"}\n'),
    writeFile(join(directory, 'index.js'), observerPlugin),
    writeFile(join(control, 'plugins/sortie-dogs/index.js'), tracedSortiePlugin),
  ]);
}

// V2 hook observation only: never changes tool inputs, permission effects or model requests.
export const observerPlugin = `import { appendFile } from 'node:fs/promises';
const log = process.env.ANKO_BENCHMARK_HOOK_LOG;
const safe = (phase, event) => {
  const input = event.input ?? {};
  return { at: new Date().toISOString(), phase, tool: event.tool ?? null,
    session_id: event.sessionID ?? null, call_id: event.callID ?? event.id ?? null,
    path: event.tool === 'read' ? (input.path ?? input.filePath ?? null) : null,
    action: event.action ?? null, resources: event.resources ?? null,
    effect: event.effect ?? null, status: event.status ?? null };
};
const record = async (phase, event) => { if (log) await appendFile(log, JSON.stringify(safe(phase, event)) + '\\n'); };
export default { id: 'anko-benchmark-observer', async setup(ctx) {
  await ctx.tool.hook('execute.before', event => record('plugin-hook-before', event));
  await ctx.tool.hook('execute.after', event => record('plugin-hook-after', event));
  await ctx.permission.hook('evaluate', event => record('permission-evaluate', event));
  await ctx.session.hook('context', event => record('native-context-observed', event));
} };
`;

export const tracedSortiePlugin = `import plugin from 'sortie-dogs/server';
import { appendFile } from 'node:fs/promises';
const log = process.env.ANKO_BENCHMARK_HOOK_LOG;
const record = async (phase, domain, hook, event) => {
  if (!log) return;
  await appendFile(log, JSON.stringify({ at: new Date().toISOString(), phase, domain, hook,
    session_id: event?.sessionID ?? null, call_id: event?.callID ?? event?.id ?? null,
    tool: event?.tool ?? null, action: event?.action ?? null,
    resources: event?.resources ?? null, effect: event?.effect ?? null }) + '\\n');
};
export default { ...plugin, async setup(ctx) {
  const domains = new Map();
  const proxy = new Proxy(ctx, { get(target, key) {
    const value = Reflect.get(target, key);
    if (!['session', 'tool', 'permission'].includes(key)) return value;
    if (!domains.has(key)) domains.set(key, new Proxy(value, { get(object, method) {
      if (method !== 'hook') return Reflect.get(object, method);
      return (hook, callback, ...options) => object.hook(hook, async event => {
        await record('sortie-hook-start', key, hook, event);
        try { return await callback(event); }
        finally { await record('sortie-hook-end', key, hook, event); }
      }, ...options);
    } }));
    return domains.get(key);
  } });
  return plugin.setup(proxy);
} };
`;
