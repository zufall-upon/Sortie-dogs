#!/usr/bin/env node
/**
 * Read-only phase cost audit for one operator root and every nested descendant session.
 *
 * The existing measure-workflow-run.ps1 helper aggregates only direct children and has no v0.10
 * role or phase model, so a coordinator=0 reading there is a tool limitation and not an observation.
 * This adapter keeps that helper untouched, reads the host database read-only, and prices requests
 * through the product's own estimateModelUsageCost so the price table is never duplicated here.
 *
 * aggregateRun is pure and database independent: the synthetic fixture test drives it directly.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { estimateModelUsageCost, MODEL_COST_PRICING_SNAPSHOT } from "../dist/plugin/model-cost.js";

export const PHASES = ["intake", "proposal-investigation", "semantic-comparison-approval", "implementation",
  "review", "remediation", "final-acceptance", "consultation", "unclassified"];

/** Root phase markers. The tool prefix is a parameter so a different runtime profile stays observable. */
const ROOT_PHASE_MARKERS = [
  { suffix: "begin_operator_proposal", phase: "proposal-investigation", at: "start" },
  { suffix: "submit_operator_proposal", phase: "proposal-investigation", at: "start" },
  { suffix: "approve_operator_proposal", phase: "implementation", at: "end" },
  { suffix: "prepare_operator", phase: "implementation", at: "end" },
  { suffix: "operator_next", phase: "implementation", at: "end" },
  { suffix: "resume_operator", phase: "remediation", at: "start" },
  { suffix: "resolve_operator_contract_repair", phase: "remediation", at: "start" },
  { suffix: "cancel_operator", phase: "remediation", at: "start" },
  { suffix: "complete_operator", phase: "final-acceptance", at: "start" },
];

/** Descendant phase by observed agent role. An unmapped role stays visible instead of vanishing. */
export function phaseForAgent(agent) {
  if (typeof agent !== "string" || agent.length === 0) return "unclassified";
  if (/coordinator/u.test(agent)) return "proposal-investigation";
  if (/reviewer/u.test(agent)) return "review";
  if (/advisor/u.test(agent)) return "consultation";
  if (/scout/u.test(agent)) return "proposal-investigation";
  if (/worker|implementer|fixer|builder/u.test(agent)) return "implementation";
  return "unclassified";
}

function emptyBucket() {
  return { requests: 0, tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
    estimatedUsd: 0, pricedRequests: 0, unpricedRequests: 0, hostReportedUsd: 0, hostCostRequests: 0 };
}
function addUsage(bucket, tokens, estimate, hostCost) {
  bucket.requests += 1;
  if (tokens !== null) {
    bucket.tokens += tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
    bucket.input += tokens.input; bucket.cacheRead += tokens.cacheRead; bucket.cacheWrite += tokens.cacheWrite;
    bucket.output += tokens.output; bucket.reasoning += tokens.reasoning;
  }
  if (estimate.status === "priced") { bucket.estimatedUsd += estimate.usd; bucket.pricedRequests += 1; }
  else bucket.unpricedRequests += 1;
  if (typeof hostCost === "number" && Number.isFinite(hostCost)) { bucket.hostReportedUsd += hostCost; bucket.hostCostRequests += 1; }
}
function bucketOf(map, key) {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = emptyBucket(); map.set(key, created); return created;
}
function round(value) { return Math.round(value * 1e6) / 1e6; }
function round3(value) { return Math.round(value * 1e3) / 1e3; }

/**
 * Prompt prefix reuse per session, in request order.
 *
 * A total cache ratio hides the failure this exists to catch: when a mutating element sits in the
 * system block, every later request re-sends the whole prompt uncached while the small stable head
 * keeps reporting the same cacheRead, so the run still looks "partly cached". Comparing each
 * request's cacheRead against the previous request's whole prompt exposes that directly, because a
 * healthy continuation reuses nearly all of it and a broken prefix reuses almost none.
 *
 * @param {Array<{input: number, cacheRead: number}>} ordered requests in creation order
 */
export function prefixReuse(ordered) {
  const ratios = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1].input + ordered[index - 1].cacheRead;
    if (previous <= 0) continue;
    ratios.push(round3(Math.min(1, ordered[index].cacheRead / previous)));
  }
  const sorted = [...ratios].sort((left, right) => left - right);
  const stalled = ratios.filter(ratio => ratio < 0.5).length;
  return {
    comparisons: ratios.length,
    ratios,
    min: sorted.length === 0 ? null : sorted[0],
    median: sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)],
    stalledRequests: stalled,
    // Three consecutive continuations that all reuse under half of the prior prompt is not latency or
    // a cold start: the prefix itself is changing. Fewer requests stay reported but unflagged.
    prefixStalled: ratios.length >= 3 && stalled === ratios.length,
  };
}
function finishBucket(bucket) { return { ...bucket, estimatedUsd: round(bucket.estimatedUsd), hostReportedUsd: round(bucket.hostReportedUsd) }; }

/**
 * Collect the root and every descendant. Cycles and repeated ids are dropped instead of being
 * counted twice, and a session whose parent is outside the tree never joins it by role name.
 */
export function collectTree(sessions, rootID) {
  const byParent = new Map();
  for (const session of sessions) {
    const key = session.parentID ?? "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(session);
  }
  const index = new Map(sessions.map(session => [session.id, session]));
  const root = index.get(rootID);
  if (root === undefined) throw new Error(`root session not found: ${rootID}`);
  const ordered = []; const seen = new Set(); const queue = [{ session: root, depth: 0 }];
  const cycles = [];
  while (queue.length > 0) {
    const { session, depth } = queue.shift();
    if (seen.has(session.id)) { cycles.push(session.id); continue; }
    seen.add(session.id);
    ordered.push({ ...session, depth });
    for (const child of byParent.get(session.id) ?? []) queue.push({ session: child, depth: depth + 1 });
  }
  return { sessions: ordered, cycles };
}

/** Ordered root phase transitions derived from tool boundaries, not from prose. */
export function rootPhaseTimeline(rootToolParts, toolPrefix) {
  const events = [];
  for (const part of rootToolParts) {
    const tool = part.tool ?? "";
    for (const marker of ROOT_PHASE_MARKERS) {
      if (tool !== `${toolPrefix}${marker.suffix}`) continue;
      if (part.status !== "completed") continue;
      const at = marker.at === "end" ? part.endedMs ?? part.startedMs : part.startedMs;
      if (typeof at === "number") events.push({ at, phase: marker.phase, tool, status: part.status });
    }
    if (tool === "task" && part.proposalChild === true && typeof part.endedMs === "number") {
      // A returned proposal Task only starts semantic comparison when it actually carries a submitted
      // proposal. A child that returned without one leaves the root handling a failure, not approving.
      events.push({ at: part.endedMs, tool, status: part.status,
        phase: part.proposalSubmitted === true ? "semantic-comparison-approval" : "remediation" });
    }
  }
  return events.sort((left, right) => left.at - right.at);
}
function phaseAt(timeline, at) {
  let phase = "intake";
  for (const event of timeline) { if (event.at <= at) phase = event.phase; else break; }
  return phase;
}

/**
 * @param {{sessions: Array, messages: Array, toolParts: Array}} input normalized host rows
 * @param {{rootID: string, toolPrefix?: string, startMs?: number, endMs?: number, asOfMs?: number}} options
 */
export function aggregateRun(input, options) {
  const toolPrefix = options.toolPrefix ?? "sortie_v010_";
  const { sessions: tree, cycles } = collectTree(input.sessions, options.rootID);
  const treeIDs = new Set(tree.map(session => session.id));
  const startMs = options.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = options.endMs ?? Number.POSITIVE_INFINITY;
  const inWindow = at => typeof at === "number" && at >= startMs && at <= endMs;

  // A resumed window must inherit the phase that was already active at its start, so the timeline is
  // built from every root boundary and only the reported slice is windowed.
  const timeline = rootPhaseTimeline(input.toolParts.filter(part => part.sessionID === options.rootID), toolPrefix);
  const inheritedPhase = timeline.filter(event => event.at < startMs).at(-1)?.phase ?? null;

  const phases = new Map(); const roles = new Map(); const models = new Map(); const sessionTotals = new Map();
  const trajectories = new Map();
  const total = emptyBucket();
  const counted = new Set();
  let duplicateMessages = 0; let pendingUsage = 0; let outOfWindow = 0; let nonTreeMessages = 0;

  for (const message of input.messages) {
    if (!treeIDs.has(message.sessionID)) { nonTreeMessages += 1; continue; }
    if (message.role !== "assistant") continue;
    if (!inWindow(message.createdMs)) { outOfWindow += 1; continue; }
    if (counted.has(message.id)) { duplicateMessages += 1; continue; }
    counted.add(message.id);
    const tokens = message.tokens ?? null;
    if (tokens === null) pendingUsage += 1;
    const estimate = estimateModelUsageCost({ providerID: message.providerID, modelID: message.modelID,
      uncachedInputTokens: tokens?.input, cacheReadTokens: tokens?.cacheRead, cacheWriteTokens: tokens?.cacheWrite,
      outputTokens: tokens?.output, reasoningTokens: tokens?.reasoning, serviceTier: message.serviceTier });
    const session = tree.find(entry => entry.id === message.sessionID);
    const phase = message.sessionID === options.rootID
      ? phaseAt(timeline, message.createdMs)
      : phaseForAgent(message.agent ?? session?.agent);
    const roleKey = message.sessionID === options.rootID ? `root:${message.agent ?? session?.agent ?? "unknown"}`
      : `${session?.agent ?? message.agent ?? "unknown"}`;
    const modelKey = message.providerID !== undefined && message.modelID !== undefined
      ? `${message.providerID}/${message.modelID}${message.variant ? `:${message.variant}` : ""}` : "unclassified";
    for (const bucket of [total, bucketOf(phases, phase), bucketOf(roles, roleKey), bucketOf(models, modelKey),
      bucketOf(sessionTotals, message.sessionID)]) addUsage(bucket, tokens, estimate, message.cost);
    if (tokens !== null) {
      if (!trajectories.has(message.sessionID)) trajectories.set(message.sessionID, []);
      trajectories.get(message.sessionID).push({ createdMs: message.createdMs, input: tokens.input, cacheRead: tokens.cacheRead });
    }
  }

  const cacheBySession = {};
  const cacheStalled = [];
  for (const session of tree) {
    const ordered = (trajectories.get(session.id) ?? []).sort((left, right) => left.createdMs - right.createdMs);
    if (ordered.length === 0) continue;
    const reuse = prefixReuse(ordered);
    const uncached = ordered.reduce((sum, entry) => sum + entry.input, 0);
    const cached = ordered.reduce((sum, entry) => sum + entry.cacheRead, 0);
    cacheBySession[session.id] = { agent: session.agent ?? null, requests: ordered.length,
      uncachedInput: uncached, cacheRead: cached,
      cacheRatio: cached + uncached === 0 ? null : round3(cached / (cached + uncached)), ...reuse };
    if (reuse.prefixStalled) cacheStalled.push(session.id);
  }

  const reads = { calls: 0, errors: 0, bytes: 0, uniquePaths: 0, repeatCalls: 0, rangedCalls: 0, bySession: {} };
  const perPath = new Map();
  const toolCalls = new Map(); const toolErrors = new Map(); let runningCalls = 0;
  for (const part of input.toolParts) {
    if (!treeIDs.has(part.sessionID) || !inWindow(part.startedMs)) continue;
    const tool = part.tool ?? "unknown";
    toolCalls.set(tool, (toolCalls.get(tool) ?? 0) + 1);
    if (part.status === "error") toolErrors.set(tool, (toolErrors.get(tool) ?? 0) + 1);
    if (part.status === "running" || part.status === "pending") runningCalls += 1;
    if (tool !== "read") continue;
    reads.calls += 1;
    if (part.status === "error") reads.errors += 1;
    reads.bytes += part.outputBytes ?? 0;
    if (part.ranged === true) reads.rangedCalls += 1;
    reads.bySession[part.sessionID] = (reads.bySession[part.sessionID] ?? 0) + 1;
    if (typeof part.path === "string" && part.path.length > 0) {
      const key = `${part.sessionID}\u0000${part.path}`;
      perPath.set(key, (perPath.get(key) ?? 0) + 1);
    }
  }
  reads.uniquePaths = perPath.size;
  for (const count of perPath.values()) reads.repeatCalls += count - 1;

  const phaseSum = [...phases.values()].reduce((sum, bucket) => sum + bucket.tokens, 0);
  const roleSum = [...roles.values()].reduce((sum, bucket) => sum + bucket.tokens, 0);
  const sorted = object => Object.fromEntries([...object.entries()]
    .sort((left, right) => right[1].estimatedUsd - left[1].estimatedUsd || right[1].tokens - left[1].tokens)
    .map(([key, bucket]) => [key, finishBucket(bucket)]));

  return {
    schema_version: "0.1",
    as_of: new Date(options.asOfMs ?? Date.now()).toISOString(),
    window: { start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
      end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null },
    pricing: { checkedAt: MODEL_COST_PRICING_SNAPSHOT.checkedAt, source: "product estimateModelUsageCost",
      note: "API-equivalent estimate; not a subscription invoice." },
    root: options.rootID,
    sessions: tree.map(session => ({ id: session.id, parentID: session.parentID, depth: session.depth,
      agent: session.agent ?? null, title: session.title ?? null,
      usage: finishBucket(sessionTotals.get(session.id) ?? emptyBucket()) })),
    total: finishBucket(total),
    byPhase: sorted(phases),
    byRole: sorted(roles),
    byModel: sorted(models),
    reads,
    cacheHealth: { bySession: cacheBySession, stalledSessions: cacheStalled },
    tools: { calls: Object.fromEntries([...toolCalls.entries()].sort((a, b) => b[1] - a[1])),
      errors: Object.fromEntries([...toolErrors.entries()].sort((a, b) => b[1] - a[1])) },
    integrity: {
      phaseTokensMatchTotal: phaseSum === total.tokens,
      roleTokensMatchTotal: roleSum === total.tokens,
      duplicateMessagesSkipped: duplicateMessages,
      cyclesSkipped: cycles,
      messagesOutsideWindow: outOfWindow,
      messagesOutsideTree: nonTreeMessages,
      pendingUsageRequests: pendingUsage,
      unpricedRequests: total.unpricedRequests,
      pricingCoverage: total.requests === 0 ? null : round(total.pricedRequests / total.requests),
      runningToolCalls: runningCalls,
      // An unfinished call means later usage is still unrecorded: this snapshot is not a terminal total.
      partial: runningCalls > 0 || pendingUsage > 0,
    },
    inheritedPhase,
    timeline: timeline.filter(event => inWindow(event.at))
      .map(event => ({ at: new Date(event.at).toISOString(), phase: event.phase, tool: event.tool })),
  };
}

const TOKEN_FIELDS = ["input", "output", "reasoning"];
export function normalizeTokens(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const cache = typeof raw.cache === "object" && raw.cache !== null ? raw.cache : {};
  const values = { input: raw.input, output: raw.output, reasoning: raw.reasoning,
    cacheRead: cache.read ?? raw.cacheRead, cacheWrite: cache.write ?? raw.cacheWrite };
  for (const key of [...TOKEN_FIELDS, "cacheRead", "cacheWrite"]) {
    if (typeof values[key] !== "number" || !Number.isFinite(values[key]) || values[key] < 0) return null;
  }
  return values;
}

/** The host replaces a returned proposal Task output with its own packet, so the phase uses that fact. */
export function proposalPacketStatus(output) {
  if (typeof output !== "string" || !output.trimStart().startsWith("{")) return null;
  try { const parsed = JSON.parse(output); return typeof parsed?.status === "string" ? parsed.status : null; }
  catch { return null; }
}
export function proposalTaskStatus(output) {
  const status = proposalPacketStatus(output);
  return status === "investigating" || status === "submitted" ? status : null;
}

/**
 * Read rows with the sqlite3 CLI when one is configured, otherwise with the bundled node:sqlite
 * reader. Both paths open the database read-only; neither writes to host state.
 */
async function querySqlite(sqlite, database, sql) {
  if (sqlite !== null) {
    const { stdout } = await promisify(execFile)(sqlite, ["-readonly", "-json", database, sql], { maxBuffer: 512 * 1024 * 1024 });
    const trimmed = stdout.trim();
    return trimmed.length === 0 ? [] : JSON.parse(trimmed);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const file = database.startsWith("file:") ? new URL(database).pathname : database;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1]?.startsWith("--") === false ? argv[++index] : "true";
    args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) throw new Error("--root <session id> is required");
  const sqlite = args.sqlite === "node" ? null : args.sqlite ?? "sqlite3.exe";
  const database = args.db ?? `file:${(process.env.USERPROFILE ?? process.env.HOME ?? "").replaceAll("\\", "/")}/.local/share/opencode/opencode.db?mode=ro`;
  const sessionRows = await querySqlite(sqlite, database,
    "select id, parent_id parentID, agent, title, time_created createdMs, time_updated updatedMs, cost from session;");
  const { sessions: tree } = collectTree(sessionRows.map(row => ({ ...row, parentID: row.parentID ?? null })), args.root);
  const ids = tree.map(session => `'${session.id.replaceAll("'", "''")}'`).join(",");
  const messageRows = await querySqlite(sqlite, database,
    `select id, session_id sessionID, time_created createdMs, json_extract(data,'$.role') role,
       json_extract(data,'$.agent') agent, json_extract(data,'$.providerID') providerID,
       json_extract(data,'$.modelID') modelID, json_extract(data,'$.variant') variant,
       json_extract(data,'$.cost') cost, json_extract(data,'$.serviceTier') serviceTier,
       json_extract(data,'$.tokens') tokens from message where session_id in (${ids});`);
  const partRows = await querySqlite(sqlite, database,
    `select session_id sessionID, message_id messageID, json_extract(data,'$.tool') tool,
       json_extract(data,'$.callID') callID, json_extract(data,'$.state.status') status,
       json_extract(data,'$.state.time.start') startedMs, json_extract(data,'$.state.time.end') endedMs,
       json_extract(data,'$.state.input.filePath') path, json_extract(data,'$.state.input.offset') offset,
       json_extract(data,'$.state.input.limit') "limit", json_extract(data,'$.state.input.subagent_type') subagentType,
       coalesce(json_extract(data,'$.state.output'),'') output
     from part where session_id in (${ids}) and json_extract(data,'$.type')='tool';`);

  const messages = messageRows.map(row => ({ id: row.id, sessionID: row.sessionID, role: row.role, agent: row.agent,
    providerID: row.providerID ?? undefined, modelID: row.modelID ?? undefined, variant: row.variant ?? undefined,
    serviceTier: row.serviceTier ?? undefined, cost: typeof row.cost === "number" ? row.cost : null,
    createdMs: row.createdMs, tokens: normalizeTokens(row.tokens === null ? null : JSON.parse(row.tokens)) }));
  const toolParts = partRows.map(row => {
    const proposalStatus = row.tool === "task" ? proposalTaskStatus(row.output) : null;
    return { sessionID: row.sessionID, messageID: row.messageID, tool: row.tool,
      callID: row.callID, status: row.status, startedMs: row.startedMs ?? null, endedMs: row.endedMs ?? null,
      path: row.path ?? null, ranged: row.offset !== null || row.limit !== null,
      outputBytes: Buffer.byteLength(row.output ?? "", "utf8"),
      proposalChild: proposalStatus === "investigating" || proposalStatus === "submitted",
      proposalSubmitted: proposalStatus === "submitted" };
  });

  const report = aggregateRun({ sessions: sessionRows.map(row => ({ ...row, parentID: row.parentID ?? null })), messages, toolParts },
    { rootID: args.root, toolPrefix: args.toolPrefix ?? "sortie_v010_",
      startMs: args.start ? Date.parse(args.start) : undefined, endMs: args.end ? Date.parse(args.end) : undefined });

  const text = JSON.stringify(report, null, 2);
  if (args.out) { await mkdir(dirname(resolve(args.out)), { recursive: true }); await writeFile(resolve(args.out), `${text}\n`); }
  process.stdout.write(`${text}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main().catch(error => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
}
