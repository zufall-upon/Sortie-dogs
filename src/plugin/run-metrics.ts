export interface RunMetricsClient {
  readonly session?: {
    readonly get?: (request: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>;
    readonly children?: (request: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>;
    readonly messages?: (request: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>;
  };
}

export interface RunMetrics {
  readonly durationMilliseconds: number | undefined;
  readonly tokens: number | undefined;
  readonly cost: number | undefined;
  readonly steps: number | undefined;
  readonly sessions: number | undefined;
  readonly cacheRatio: number | undefined;
}

const MAX_SESSIONS = 128;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function unwrap(value: unknown): unknown {
  const object = record(value);
  return object !== undefined && "data" in object ? object.data : value;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function messageTokens(message: Record<string, unknown>): [number, number] | undefined {
  const info = record(message.info) ?? message;
  const tokens = record(info.tokens) ?? record(message.tokens);
  if (tokens === undefined) return undefined;
  const input = number(tokens.input);
  const output = number(tokens.output);
  const reasoning = number(tokens.reasoning);
  const cache = record(tokens.cache);
  const cacheRead = number(cache?.read) ?? number(tokens.cacheRead) ?? number(tokens.cache_read);
  const cacheWrite = number(cache?.write) ?? number(tokens.cacheWrite) ?? number(tokens.cache_write);
  if (input === undefined || output === undefined || reasoning === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return [input + output + reasoning + cacheRead + cacheWrite, cacheRead];
}

function assistantMessages(value: unknown): Record<string, unknown>[] | undefined {
  const payload = unwrap(value);
  if (!Array.isArray(payload)) return undefined;
  return payload.filter((entry): entry is Record<string, unknown> => {
    const item = record(entry);
    const info = item === undefined ? undefined : record(item.info);
    return item !== undefined && (info?.role ?? item.role) === "assistant";
  });
}

export async function collectRunMetrics(
  client: RunMetricsClient | undefined,
  rootSessionID: string,
  directory?: string,
  now = Date.now(),
): Promise<RunMetrics | undefined> {
  const session = client?.session;
  if (session?.messages === undefined) return undefined;
  const ids = [rootSessionID];
  const visited = new Set(ids);
  let hierarchyComplete = session.children !== undefined;
  for (let index = 0; index < ids.length && ids.length < MAX_SESSIONS; index += 1) {
    if (session.children === undefined) break;
    try {
      const children = unwrap(await session.children.call(session, { path: { id: ids[index]! }, query: { directory } }));
      if (!Array.isArray(children)) { hierarchyComplete = false; break; }
      for (const child of children) {
        const item = record(child);
        const id = typeof item?.id === "string" ? item.id : typeof item?.sessionID === "string" ? item.sessionID : undefined;
        if (id === undefined) { hierarchyComplete = false; continue; }
        if (!visited.has(id) && ids.length < MAX_SESSIONS) { visited.add(id); ids.push(id); }
        else if (!visited.has(id)) hierarchyComplete = false;
      }
    } catch { hierarchyComplete = false; break; }
  }
  if (ids.length >= MAX_SESSIONS) hierarchyComplete = false;
  const uniqueMessages = new Set<string>();
  let totalTokens = 0;
  let cacheRead = 0;
  let tokensAvailable = true;
  let messagesComplete = true;
  let steps = 0;
  let cost = 0;
  let costAvailable = true;
  for (const id of ids) {
    try {
      const messages = assistantMessages(await session.messages.call(session, { path: { id }, query: { directory } }));
      if (messages === undefined) return undefined;
      for (const message of messages) {
        const info = record(message.info) ?? message;
        const time = record(info.time) ?? record(message.time);
        if (time !== undefined && number(time.completed) === undefined) continue;
        const messageID = typeof info.id === "string" ? info.id : typeof message.id === "string" ? message.id : undefined;
        if (messageID === undefined) { messagesComplete = false; continue; }
        if (uniqueMessages.has(messageID)) continue;
        uniqueMessages.add(messageID);
        steps += 1;
        const tokens = messageTokens(message);
        if (tokens !== undefined) { totalTokens += tokens[0]; cacheRead += tokens[1]; } else tokensAvailable = false;
        const reportedCost = number(info.cost) ?? number(message.cost);
        if (reportedCost === undefined) costAvailable = false; else cost += reportedCost;
      }
    } catch { return undefined; }
  }
  let created: number | undefined;
  if (session.get !== undefined) {
    try {
      const root = record(unwrap(await session.get.call(session, { path: { id: rootSessionID }, query: { directory } })));
      const time = record(root?.time);
      created = number(time?.created);
    } catch { /* fallback below */ }
  }
  return {
    durationMilliseconds: created === undefined ? undefined : Math.max(0, now - created),
    tokens: hierarchyComplete && messagesComplete && tokensAvailable ? totalTokens : undefined,
    cost: hierarchyComplete && messagesComplete && costAvailable ? cost : undefined,
    steps: hierarchyComplete && messagesComplete ? steps : undefined,
    sessions: hierarchyComplete ? ids.length : undefined,
    cacheRatio: hierarchyComplete && messagesComplete && tokensAvailable && totalTokens > 0 ? cacheRead / totalTokens : undefined,
  };
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatRunMetrics(metrics: RunMetrics): string {
  const elapsed = metrics.durationMilliseconds === undefined ? "duration unavailable" : `${duration(metrics.durationMilliseconds)} wall-clock`;
  const cost = metrics.cost === undefined ? "cost unavailable" : `$${metrics.cost.toFixed(4)}`;
  const tokens = metrics.tokens === undefined ? "tokens unavailable" : `${metrics.tokens.toLocaleString("en-US")} tokens`;
  const steps = metrics.steps === undefined ? "steps unavailable" : `${metrics.steps} completed assistant model step${metrics.steps === 1 ? "" : "s"}`;
  const sessions = metrics.sessions === undefined ? "sessions unavailable" : `${metrics.sessions} session${metrics.sessions === 1 ? "" : "s"}`;
  const cache = metrics.cacheRatio === undefined ? "cache ratio unavailable" : `${(metrics.cacheRatio * 100).toFixed(1)}% cache ratio`;
  return `**Run:** pre-terminal host snapshot · ${elapsed} · ${tokens} · ${cost} · ${steps} · ${sessions} · ${cache}`;
}

export function isDoneTerminalText(text: string): boolean {
  const first = text.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
  return /^✅\s+\*\*DONE\*\*(?:\s|$)/u.test(first) || /^status:\s*DONE(?:\s|$)/u.test(first);
}

export function insertRunMetrics(text: string, metrics: RunMetrics): string {
  if (/\*\*Run:\*\*/u.test(text) || !isDoneTerminalText(text)) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const statusStart = text.search(/^(?:✅\s+\*\*DONE\*\*|status:\s*DONE).*$/mu);
  if (statusStart < 0) return text;
  const statusEnd = text.indexOf(newline, statusStart);
  if (statusEnd < 0) return `${text}${newline}${newline}${formatRunMetrics(metrics)}`;
  return `${text.slice(0, statusEnd + newline.length)}${newline}${formatRunMetrics(metrics)}${newline}${text.slice(statusEnd + newline.length)}`;
}
