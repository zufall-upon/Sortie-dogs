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
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly cost: number | undefined;
  readonly steps: number | undefined;
  readonly sessions: number | undefined;
  readonly cacheRatio: number | undefined;
  readonly roles: Readonly<Record<string, RunRoleMetrics>> | undefined;
}

export interface RunRoleMetrics {
  readonly tokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number | undefined;
  readonly steps: number;
  readonly cacheRatio: number | undefined;
}

export type RunTerminalOutcome = "DONE" | "BLOCKED" | "NEED_DECISION";

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

interface MessageTokens {
  readonly total: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

interface MutableRoleMetrics {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  costAvailable: boolean;
  steps: number;
}

function messageTokens(message: Record<string, unknown>): MessageTokens | undefined {
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
  return {
    total: input + output + reasoning + cacheRead + cacheWrite,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
  };
}

function messageAgent(message: Record<string, unknown>): string {
  const info = record(message.info) ?? message;
  const agent = info.agent ?? message.agent;
  return typeof agent === "string" && agent.trim().length > 0 ? agent.slice(0, 128) : "unknown";
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

function conclusionStatusAlias(line: string): RunTerminalOutcome | undefined {
  const match = /^([✅⛔❓])[ \t]+conclusion:\s*status:\s*(DONE|BLOCKED|NEED_DECISION)\b/iu.exec(line);
  const outcome = match?.[2]?.toUpperCase();
  if (outcome !== "DONE" && outcome !== "BLOCKED" && outcome !== "NEED_DECISION") return undefined;
  const expectedIcon = outcome === "DONE" ? "✅" : outcome === "BLOCKED" ? "⛔" : "❓";
  return match?.[1] === expectedIcon ? outcome : undefined;
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
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let tokensAvailable = true;
  let messagesComplete = true;
  let steps = 0;
  let cost = 0;
  let costAvailable = true;
  const roleMetrics = new Map<string, MutableRoleMetrics>();
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
        const agent = messageAgent(message);
        const role = roleMetrics.get(agent) ?? {
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          costAvailable: true,
          steps: 0,
        };
        role.steps += 1;
        roleMetrics.set(agent, role);
        const tokens = messageTokens(message);
        if (tokens !== undefined) {
          totalTokens += tokens.total;
          inputTokens += tokens.input;
          outputTokens += tokens.output;
          reasoningTokens += tokens.reasoning;
          cacheRead += tokens.cacheRead;
          cacheWrite += tokens.cacheWrite;
          role.tokens += tokens.total;
          role.inputTokens += tokens.input;
          role.outputTokens += tokens.output;
          role.reasoningTokens += tokens.reasoning;
          role.cacheReadTokens += tokens.cacheRead;
          role.cacheWriteTokens += tokens.cacheWrite;
        } else tokensAvailable = false;
        const reportedCost = number(info.cost) ?? number(message.cost);
        if (reportedCost === undefined) {
          costAvailable = false;
          role.costAvailable = false;
        } else {
          cost += reportedCost;
          role.cost += reportedCost;
        }
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
    inputTokens: hierarchyComplete && messagesComplete && tokensAvailable ? inputTokens : undefined,
    outputTokens: hierarchyComplete && messagesComplete && tokensAvailable ? outputTokens : undefined,
    reasoningTokens: hierarchyComplete && messagesComplete && tokensAvailable ? reasoningTokens : undefined,
    cacheReadTokens: hierarchyComplete && messagesComplete && tokensAvailable ? cacheRead : undefined,
    cacheWriteTokens: hierarchyComplete && messagesComplete && tokensAvailable ? cacheWrite : undefined,
    cost: hierarchyComplete && messagesComplete && costAvailable ? cost : undefined,
    steps: hierarchyComplete && messagesComplete ? steps : undefined,
    sessions: hierarchyComplete ? ids.length : undefined,
    cacheRatio: hierarchyComplete && messagesComplete && tokensAvailable && totalTokens > 0 ? cacheRead / totalTokens : undefined,
    roles: hierarchyComplete && messagesComplete && tokensAvailable
      ? Object.fromEntries([...roleMetrics].map(([agent, role]) => [agent, {
        tokens: role.tokens,
        inputTokens: role.inputTokens,
        outputTokens: role.outputTokens,
        reasoningTokens: role.reasoningTokens,
        cacheReadTokens: role.cacheReadTokens,
        cacheWriteTokens: role.cacheWriteTokens,
        cost: role.costAvailable ? role.cost : undefined,
        steps: role.steps,
        cacheRatio: role.tokens > 0 ? role.cacheReadTokens / role.tokens : undefined,
      }]))
      : undefined,
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

function topLevelLines(text: string): Array<{ index: number; line: string }> {
  const lines: Array<{ index: number; line: string }> = [];
  let fence: { character: string; length: number } | undefined;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (fence === undefined) {
      const opener = /^[ \t]*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (opener === undefined) {
        if (!/^[ \t]*>/u.test(line)) lines.push({ index, line });
        continue;
      }
      fence = { character: opener[0]!, length: opener.length };
      continue;
    }
    const closer = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
    if (closer?.[0] === fence.character && closer.length >= fence.length) fence = undefined;
  }
  return lines;
}

function terminalCheckpoint(text: string): { index: number; outcome: RunTerminalOutcome } | undefined {
  const lines = topLevelLines(text);
  const first = lines.find(({ line }) => line.trim().length > 0);
  if (first === undefined) return undefined;
  const checkpoint = (() => {
    const { index, line } = first;
    const normalized = /^status:\s*(DONE|BLOCKED|NEED_DECISION)\b/iu.exec(line)?.[1]?.toUpperCase();
    const explicit: RunTerminalOutcome | undefined = normalized === "DONE" || normalized === "BLOCKED" || normalized === "NEED_DECISION"
      ? normalized
      : undefined;
    const outcome = explicit ?? conclusionStatusAlias(line) ??
      (/^✅[ \t]+\*\*DONE\*\*/u.test(line) ? "DONE" :
        /^⛔[ \t]+\*\*BLOCKED\*\*/u.test(line) ? "BLOCKED" :
        /^❓[ \t]+\*\*NEED_DECISION\*\*/u.test(line) ? "NEED_DECISION" : undefined);
    return outcome === "DONE" || outcome === "BLOCKED" || outcome === "NEED_DECISION"
      ? { index, outcome }
      : undefined;
  })();
  return checkpoint;
}

export function isDoneTerminalText(text: string): boolean {
  return terminalCheckpoint(text)?.outcome === "DONE";
}

export function terminalRunOutcome(text: string): RunTerminalOutcome | undefined {
  const checkpoint = terminalCheckpoint(text);
  if (checkpoint === undefined) return undefined;
  if (checkpoint.outcome !== "BLOCKED") return checkpoint.outcome;
  return topLevelLines(text).some(({ index, line }) => index > checkpoint.index &&
    /^TRUE_BLOCKER\s*:\s*(?:external|user-decision)\s*:\s*\S.*$/u.test(line))
    ? "BLOCKED"
    : undefined;
}

export function insertRunMetrics(text: string, metrics: RunMetrics): string {
  const checkpoint = terminalCheckpoint(text);
  if (checkpoint?.outcome !== "DONE") return text;
  if (topLevelLines(text).some(({ index, line }) => index > checkpoint.index && /^\*\*Run:\*\*/u.test(line))) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  lines.splice(checkpoint.index + 1, 0, "", formatRunMetrics(metrics));
  return lines.join(newline);
}
