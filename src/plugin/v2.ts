import { toolSchema, legacyToolArgs } from "./tool-schema.js";
import type { OpenCodeHooks, OpenCodePlugin } from "./index.js";
import { SortieDogsV010Plugin } from "./profiled.js";
import { bindMissionProgress, missionProgressReader } from "./mission-progress.js";
import { cachedWorkProgress, forgetWorkSession, retainWorkDirectory, workRootForActor } from "../core/work-quantity-observations.js";
import { formatWorkQuantity } from "../core/work-quantity.js";
import { owningServiceMessageList, owningServiceSessionList, owningServiceSessionActive } from "./v2-session-history.js";
import { nativeContractReadSnapshot } from "./native-contract-read.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { V010_RUNTIME_ASSET_VERSION } from "../asset-version.js";
import { NativeBackgroundLifecycle } from "./native-background.js";
import { resolve } from "node:path";
import { isSessionNotFoundError } from "@opencode/client";
import { completionReportModelMessages } from "./receipt-presentation.js";
import { modelLiveState } from "./model-live-state.js";
import { serializeOperatorStatus } from "./operator-status-output.js";
import { runtimeAssets as reviewerAssets } from "../runtime-assets-v010.js";
import { MISSION_RESULT_HOLD_POLICY, MISSION_REFLECTION_WORKFLOW, LEGACY_MISSION_REFLECTION_WORKFLOW } from "../runtime-mission-assets.js";
import agentToolRegistry from "./frontierharness-agent-tool-registry.json" with { type: "json" };
import { canonicalAgent, V010_RUNTIME_PROFILE } from "../core/runtime-profile.js";

export const V010_AGENT_TOOL_REGISTRY = agentToolRegistry;

// Capture once when this module evaluates. A later package replacement must not make an old
// process report the replacement's bytes as its loaded adapter.
const loadedAdapter = Object.freeze({ adapter_url: import.meta.url,
  adapter_sha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  runtime_asset_version: V010_RUNTIME_ASSET_VERSION,
  // Named module snapshots, not a claim to identify every transitive dependency. Retain these
  // bytes across package replacement so an unchanged adapter cannot conceal an old implementation.
  implementation_sha256: Object.freeze(Object.fromEntries([
    "index", "profiled", "gate", "protected-snapshot", "declared-artifacts", "native-contract-read", "native-background", "model-live-state",
  ].map(name => [`${name}.js`, createHash("sha256").update(readFileSync(
    new URL(`./${name}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url))).digest("hex")]))),
  loaded_at: new Date().toISOString(), pid: process.pid });
const childSelectionKey = (id: string) => `v2-child-model-selection:${id}`;
const liveStateKey = (id: string) => `v2-model-live-state:${id}`;

type JsonObject = Record<string, unknown>;
type NativePermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };
type Registration = { dispose(): Promise<void> | void };

interface V2ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: JsonObject;
    options?: { codemode: boolean };
    execute(input: unknown, context: JsonObject): Promise<JsonObject>;
  }): void;
  update?(id: string, update: (tool: { execute(input: unknown, context: JsonObject): Promise<JsonObject> }) => void): void;
}

interface V2AgentInfo extends JsonObject {
  model?: { providerID: string; id: string; variant?: string };
  permissions?: NativePermissionRule[];
}
interface V2AgentEditor {
  get?(id: string): V2AgentInfo | undefined;
  update(id: string, update: (agent: V2AgentInfo) => void): void;
}

export interface OpenCodeV2Context {
  readonly app?: { readonly version?: string };
  readonly location: { readonly directory: string; readonly project?: { readonly id?: string } };
  readonly options?: Readonly<Record<string, unknown>>;
  readonly agent?: {
    transform(callback: (editor: V2AgentEditor) => void): Promise<Registration>;
    get?(input: { agentID: string }): Promise<V2AgentInfo & { data?: V2AgentInfo }>;
  };
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<JsonObject> };
  readonly tool: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<Registration>;
    hook(name: "execute.before" | "execute.after", callback: (event: JsonObject) => Promise<void> | void): Promise<Registration>;
  };
  readonly session: {
    list?(input: JsonObject): Promise<unknown>;
    active?(): Promise<unknown>;
    get(input: { sessionID: string }): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
    log?(input: { sessionID: string; follow: false }): AsyncIterable<JsonObject>;
    inbox?: { list(input: { sessionID: string }): Promise<unknown> };
    prompt(input: JsonObject): Promise<unknown>;
    synthetic(input: JsonObject): Promise<unknown>;
    interrupt(input: JsonObject): Promise<unknown>;
    switchAgent(input: JsonObject): Promise<unknown>;
    switchModel(input: JsonObject): Promise<unknown>;
    hook(name: "prompt" | "context" | "compaction", callback: (event: JsonObject) => Promise<void> | void): Promise<Registration>;
  };
  readonly message?: { list(input: JsonObject): Promise<unknown> };
  readonly storage?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove?(key: string): Promise<void>;
    scan?(input: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>;
  };
  readonly permission: {
    hook(name: "evaluate", callback: (event: JsonObject) => Promise<void> | void): Promise<Registration>;
  };
  readonly provider?: { list(input?: unknown): Promise<unknown> };
  readonly model?: { list(input?: unknown): Promise<unknown> };
}

export interface OpenCodeV2Plugin {
  readonly id: string;
  setup(context: OpenCodeV2Context): Promise<(() => void) | void>;
}

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (record(value) && Array.isArray(value.data)) return value.data;
  return [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionID(request: unknown): string | undefined {
  if (!record(request)) return undefined;
  if (typeof request.sessionID === "string") return request.sessionID;
  return record(request.path) && typeof request.path.id === "string" ? request.path.id : undefined;
}

function messageID(request: unknown): string | undefined {
  if (!record(request)) return undefined;
  if (typeof request.messageID === "string") return request.messageID;
  return record(request.path) && typeof request.path.messageID === "string" ? request.path.messageID : undefined;
}

function modelReference(value: unknown): { providerID: string; modelID: string; variant?: string } | undefined {
  if (!record(value) || typeof value.providerID !== "string") return undefined;
  const id = string(value.id) ?? string(value.modelID);
  if (id === undefined) return undefined;
  return { providerID: value.providerID, modelID: id, ...(typeof value.variant === "string" ? { variant: value.variant } : {}) };
}

function legacyPart(value: unknown, session: string, message: string): JsonObject | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" || value.type === "reasoning") {
    if (typeof value.text !== "string") return undefined;
    return { ...value, id: string(value.id) ?? `${message}-${value.type}`, sessionID: session, messageID: message };
  }
  if (value.type !== "tool") return { ...value, sessionID: session, messageID: message };
  const state = record(value.state) ? value.state : {};
  const output = toolContentText(state.content);
  const name = string(value.name) ?? string(value.tool);
  const tool = name === "subagent" ? "task" : name === "shell" ? "bash" : name === "patch" ? "apply_patch" : name;
  const time = record(value.time) ? value.time : undefined;
  const metadata = record(state.metadata) ? { ...state.metadata } : undefined;
  if (metadata && Array.isArray(metadata.files)) metadata.files = metadata.files.map(file => record(file) && typeof file.patch === "string"
    ? { ...file, diff: file.patch } : file);
  return { ...value, tool, callID: string(value.id), sessionID: session, messageID: message,
    state: { ...state, input: legacyToolInput(name, state.input), ...(metadata ? { metadata } : {}),
      ...(time ? { time: { start: time.ran ?? time.created, end: time.completed } } : {}),
      ...(output === undefined ? {} : { output }) } };
}

/** Resolved V2 files carry the original bytes, even when their source URI is no longer readable. */
function legacyUserParts(text: string, files: unknown, session: string, message: string): JsonObject[] {
  return [{ id: `${message}-text`, sessionID: session, messageID: message, type: "text", text },
    ...array(files).flatMap((file, index) => {
      if (!record(file)) return [];
      const mime = string(file.mime) ?? "application/octet-stream";
      const url = typeof file.data === "string" ? `data:${mime};base64,${file.data}`
        : string(file.uri); // The prompt hook runs before URI resolution.
      if (!url) return [];
      return [{ id: `${message}-file-${index}`, sessionID: session, messageID: message, type: "file", mime, url,
        ...(typeof file.name === "string" ? { filename: file.name } : {}),
        ...(record(file.source) ? { source: file.source } : {}) }];
    })];
}

function legacyMessage(value: unknown, session: string, agent?: string): JsonObject | undefined {
  if (!record(value) || typeof value.id !== "string" || typeof value.type !== "string") return undefined;
  const id = value.id;
  const originalAgent = record(value.metadata) ? string(value.metadata.agent) ?? agent : agent;
  if (value.type === "user") {
    return { info: { id, sessionID: session, role: "user", agent: originalAgent, time: value.time },
      parts: legacyUserParts(String(value.text ?? ""), value.files, session, id) };
  }
  if (value.type !== "assistant") {
    if (value.type === "synthetic") return { info: { id, sessionID: session, role: "user", agent: originalAgent, time: value.time },
      parts: [{ id: `${id}-text`, sessionID: session, messageID: id, type: "text", text: String(value.text ?? ""), synthetic: true }] };
    return undefined;
  }
  const model = modelReference(value.model);
  return { info: { id, sessionID: session, role: "assistant", agent: string(value.agent) ?? agent,
    ...(model === undefined ? {} : { model, providerID: model.providerID, modelID: model.modelID }),
    ...(record(value.providerState) && typeof value.providerState.serviceTier === "string" ? { serviceTier: value.providerState.serviceTier } : {}),
    ...(value.error === undefined ? {} : { error: value.error }), finish: value.finish, time: value.time, tokens: value.tokens, cost: value.cost },
  parts: array(value.content).flatMap(part => {
    const converted = legacyPart(part, session, id);
    return converted === undefined ? [] : [converted];
  }) };
}

async function legacyMessages(context: OpenCodeV2Context, id: string,
  paginated?: (input: { sessionID: string; limit: number; order?: "asc" | "desc"; cursor?: string }) => Promise<unknown>,
  notBefore?: number): Promise<JsonObject[]> {
  const list = paginated ?? (context.message ? (input: JsonObject) => context.message!.list(input) : undefined);
  const [info, history] = await Promise.all([
    context.session.get({ sessionID: id }).catch(() => undefined),
    list ? nativePages(cursor => list({ sessionID: id, limit: 100,
      ...(cursor ? { cursor } : { order: notBefore === undefined ? "asc" : "desc" }) }), notBefore)
      : context.session.context({ sessionID: id }),
  ]);
  const agent = record(info) ? string(info.agent) : undefined;
  return array(history).flatMap(value => {
    const converted = legacyMessage(value, id, agent);
    return converted === undefined ? [] : [converted];
  });
}

async function nativePages(fetch: (cursor?: string) => Promise<unknown>, notBefore?: number): Promise<unknown[]> {
  const items: unknown[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; notBefore !== undefined || page < 100; page += 1) {
    const result = await fetch(cursor);
    if (!record(result) || !Array.isArray(result.data) || !record(result.cursor)) throw new Error("v2-history-page-invalid");
    items.push(...result.data);
    // Retain the whole boundary page: a message created before admission can
    // contain tools that started after it. The check verifier applies its own
    // exact native-start cutoff. Do not scan decades of unrelated controller
    // history or reject a known unit window at the general full-history cap.
    if (notBefore !== undefined && result.data.some(message => record(message) && record(message.time) &&
        typeof message.time.created === "number" && message.time.created < notBefore)) return items.reverse();
    const next = string(result.cursor.next);
    if (!next) return notBefore === undefined ? items : items.reverse();
    if (seen.has(next)) throw new Error("v2-history-cursor-repeated");
    seen.add(next); cursor = next;
  }
  throw new Error("v2-history-page-limit");
}

function legacyClient(context: OpenCodeV2Context): JsonObject {
  const directory = context.location.directory;
  const list = owningServiceSessionList();
  const active = owningServiceSessionActive();
  const reviewList = owningServiceMessageList();
  const session = {
    active: async () => ({ data: await (context.session.active ? context.session.active() : active()) }),
    get: async (request: unknown) => {
      const id = sessionID(request);
      const info = id === undefined ? undefined : await context.session.get({ sessionID: id });
      // The native correction alias is still this same Reviewer's logical role.
      return { data: record(info) && correctionAgent(info.agent) ? { ...info, agent: "dog-reviewer-v010" } : info };
    },
    messages: async (request: unknown) => {
      const id = sessionID(request);
      return { data: id === undefined ? [] : await legacyMessages(context, id) };
    },
    reviewMessages: async (request: unknown) => {
      const id = sessionID(request);
      const query = record(request) && record(request.query) ? request.query : undefined;
      const requestedStart = typeof query?.notBefore === "string" ? Date.parse(query.notBefore) : undefined;
      return { data: id === undefined ? [] : await legacyMessages(context, id,
        context.message ? input => context.message!.list(input) : reviewList,
        Number.isFinite(requestedStart) ? requestedStart : undefined) };
    },
    reviewExecution: async (request: unknown) => {
      const id = sessionID(request);
      if (!id || !record(request)) return undefined;
      const activity = await (context.session.active ? context.session.active() : active()).catch(() => undefined);
      const pending = context.session.inbox ? array(await context.session.inbox.list({ sessionID: id })) : [];
      const queued = pending.some(item => record(item) && (item.id === request.promptID ||
        !request.promptID && typeof request.prompt === "string" && record(item.payload) && typeof item.payload.text === "string" &&
        item.payload.text.includes(request.prompt) && record(item.time) && Number(item.time.created) >= Number(request.admittedAt)));
      let terminal: string | undefined;
      if (typeof request.promptID === "string" && context.session.log) {
        let delivered = false;
        for await (const event of context.session.log({ sessionID: id, follow: false })) {
          const data = record(event.data) ? event.data : {};
          if (event.type === "session.inbox.delivered" && data.inboxID === request.promptID) delivered = true;
          if (delivered && ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(String(event.type))) {
            terminal = String(event.type).replace("session.execution.", ""); break;
          }
        }
      }
      return { data: { ...(record(activity) ? { active: Object.hasOwn(activity, id),
        parentActive: typeof request.parent === "string" && Object.hasOwn(activity, request.parent) } : {}), queued,
        ...(terminal ? { terminal } : {}) } };
    },
    message: async (request: unknown) => {
      const id = sessionID(request), wanted = messageID(request);
      return { data: id === undefined || wanted === undefined ? undefined
        : (await legacyMessages(context, id)).find(message => record(message.info) && message.info.id === wanted) };
    },
    children: async (request: unknown) => {
      const id = sessionID(request);
      if (id === undefined) throw new Error("v2-history-parent-missing");
      return { data: await nativePages(cursor => {
        const input = { parentID: id, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) };
        return context.session.list ? context.session.list(input) : list(input);
      }) };
    },
    abort: async (request: unknown) => {
      const id = sessionID(request);
      return id === undefined ? undefined : await context.session.interrupt({ sessionID: id, resume: false });
    },
    promptAsync: async (request: unknown) => {
      const id = sessionID(request), body = record(request) && record(request.body) ? request.body : {};
      const text = array(body.parts).flatMap(part => record(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
      return id === undefined ? undefined : await context.session.prompt({ sessionID: id, text, delivery: "queue", resume: true,
        metadata: { "sortie-dogs/source": "v1-continuation-adapter", directory } });
    },
    missionSteering: async (request: unknown) => {
      if (!record(request) || typeof request.child !== "string" || typeof request.requestID !== "string" || typeof request.text !== "string") throw new Error("mission-steering-input-invalid");
      const id = `msg_${createHash("sha256").update(`${request.child}\0${request.requestID}`).digest("hex").slice(0, 26)}`;
      const pending = context.session.inbox ? array(await context.session.inbox.list({ sessionID: request.child })) : [];
      const existing = [...pending, ...array(await context.session.context({ sessionID: request.child }))]
        .find(item => record(item) && item.id === id);
      if (existing) return existing;
      // Native prompt acknowledges queued inbox work, never execution completion.
      return await context.session.prompt({ sessionID: request.child, id, text: request.text, delivery: "queue", resume: true,
        metadata: { "sortie-dogs/source": "mission-steering", requestID: request.requestID } });
    },
  };
  return {
    session,
    v2: { model: { list: () => context.model?.list() } },
    provider: { list: () => context.provider?.list() },
  };
}

function legacyToolName(name: unknown): string {
  return name === "subagent" ? "task" : String(name ?? "");
}

function legacyToolInput(name: unknown, input: unknown): JsonObject {
  const value = record(input) ? { ...input } : {};
  if (name === "subagent") {
    if (value.background === false) delete value.background;
    if (typeof value.agent === "string") value.subagent_type = correctionAgent(value.agent) ? "dog-reviewer-v010" : value.agent;
    if (typeof value.sessionID === "string") value.task_id = value.sessionID;
    delete value.agent;
    delete value.sessionID;
  }
  if (name === "read" && typeof value.path === "string" && value.filePath === undefined) value.filePath = value.path;
  return value;
}

function v2ToolInput(name: unknown, input: JsonObject): JsonObject {
  const value = { ...input };
  if (name === "subagent") {
    if (typeof value.subagent_type === "string") value.agent = value.subagent_type;
    if (typeof value.task_id === "string") value.sessionID = value.task_id;
    delete value.subagent_type;
    delete value.task_id;
  }
  if (name === "read" && typeof value.filePath === "string") { value.path = value.filePath; delete value.filePath; }
  return value;
}

function toolContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  const values = array(content).flatMap(item => record(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []);
  return values.length === 0 ? undefined : values.join("\n");
}

function replaceToolContent(result: JsonObject, text: string): JsonObject {
  if (toolContentText(result.content) === text) return result;
  if (typeof result.content === "string") return { ...result, content: text };
  let replaced = false;
  const content = array(result.content).flatMap(item => {
    if (!record(item) || item.type !== "text" || typeof item.text !== "string") return [item];
    if (replaced) return [];
    replaced = true;
    return [{ ...item, text }];
  });
  // Only the legacy textual projection changed. Native file/image blocks must still reach
  // the host's model-input lowering, including images returned through Code Mode.
  return { ...result, content: replaced ? content : [...content, { type: "text", text }] };
}

function assistantText(message: unknown): string | undefined {
  if (!record(message) || message.type !== "assistant" || message.finish !== "stop" || typeof message.id !== "string") return undefined;
  const text = [...array(message.content)].reverse().find(part => record(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
  return record(text) && typeof text.text === "string" ? text.text.trim() : undefined;
}

const V2_SUBAGENT_PROMPT_PREFIX = "You are a subagent spawned by another session.\n";

/** Observe terminal text for accounting only. Synthetic input is queued work, even with resume=false. */
export function createV2ReturnReportFinalizer(context: OpenCodeV2Context, hooks: OpenCodeHooks): (session: string) => Promise<void> {
  const active = new Map<string, Promise<void>>();
  return async session => {
    const previous = active.get(session) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      for (const delay of [0, 25, 100, 250]) {
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        const history = array(await context.session.context({ sessionID: session }));
        const source = [...history].reverse().find(message => assistantText(message) !== undefined);
        if (!record(source) || typeof source.id !== "string") continue;
        const base = assistantText(source)!;
        const output = { text: base };
        await hooks["experimental.text.complete"]?.({ sessionID: session, messageID: source.id }, output);
        return;
      }
    }).finally(() => { if (active.get(session) === operation) active.delete(session); });
    active.set(session, operation);
    await operation;
  };
}

const correctionAgent = (agent: unknown): boolean => typeof agent === "string" && /^dog-reviewer-correction-v010-[a-f0-9]{16}$/u.test(agent);
const reviewerCorrectionOnlyTools = new Set(["edit", "write", "patch", "sortie_v010_bind_write_gate",
  "sortie_v010_release_write_gate", "sortie_v010_operator_status", "sortie_v010_expand_unit", "sortie_v010_finish_direct_unit", "fh_docker_exec"]);

// Order only the genuine, already-filtered native definitions. Initial read-only
// tools remain a deterministic prefix when correction admits additional tools;
// object identities, schemas, executors and native authority are unchanged.
const reviewerModelToolOrder = (tools: JsonObject): JsonObject => Object.fromEntries(Object.entries(tools).sort(([left], [right]) =>
  Number(reviewerCorrectionOnlyTools.has(left)) - Number(reviewerCorrectionOnlyTools.has(right)) ||
  (left < right ? -1 : left > right ? 1 : 0)));
const correctionAgentID = (sessionID: string) => `dog-reviewer-correction-v010-${createHash("sha256").update(sessionID).digest("hex").slice(0, 16)}`;
const correctionStoragePrefix = "v2-reviewer-correction-permissions:";
const reviewerObservationText = "Use the exposed read/search and native shell observations directly. Observe existing state without\n" +
  "mutating the candidate; actual correction uses repair_review in this same context. Native user permissions remain authoritative.";
const legacyReviewerObservationText = "Use the exposed read/search tools directly. Shell is unavailable during the initial read-only phase;\n" +
  "do not enumerate the tool catalog to find an unavailable terminal. Correction uses native shell normally.";
const reviewerSystem = reviewerAssets.find(asset => asset.name === "dog-reviewer-v010")!.content.split("---").slice(2).join("---");
const legacyReviewerSystem = reviewerSystem.replace(reviewerObservationText, legacyReviewerObservationText);
const operatorSystem = reviewerAssets.find(asset => asset.name === "dog-operator")!.content.split("---").slice(2).join("---");
const legacyOperatorSystem = operatorSystem.replace(`${MISSION_RESULT_HOLD_POLICY}\n\n`, "")
  .replace(MISSION_REFLECTION_WORKFLOW, LEGACY_MISSION_REFLECTION_WORKFLOW);
function reconcileOperatorContext(event: JsonObject): void {
  if (event.agent !== "dog-operator" || !Array.isArray(event.system)) return;
  // Native configuration sources may materialize the released role after our registry transform.
  // Reconcile its exact request part as well; never rewrite a combined/custom instruction block.
  event.system = event.system.map(part => record(part) && part.type === "text" && typeof part.text === "string" &&
    part.text.trim() === legacyOperatorSystem.trim() ? { ...part, text: operatorSystem } : part);
}
// OpenCode 2.0.18 util/wildcard.ts + permission.evaluate ordering.
function nativeRuleMatch(input: string, pattern: string): boolean {
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"));
}
// Exact shipped role block after ConfigAgentV1.normalize + ConfigMigrateV1.migrateAgent in
// OpenCode v2.0.18 (cd9a14a6), not all matching denies. Everything outside this block is retained.
const legacyNativeReviewerRoleRules: readonly NativePermissionRule[] = [
  { action: "sortie_*", resource: "*", effect: "deny" },
  ...["sortie_v010_repair_review", "sortie_v010_finish_direct_unit"].map(action => ({ action, resource: "*", effect: "allow" as const })),
  ...["read", "glob", "grep", "list"].map(action => ({ action, resource: "*", effect: "allow" as const })),
  ...["shell", "webfetch", "subagent", "question", "edit", "edit", "edit"].map(action => ({ action, resource: "*", effect: "deny" as const })),
];
export const nativeReviewerRoleRules: readonly NativePermissionRule[] = legacyNativeReviewerRoleRules.filter(rule => rule.action !== "shell");
function shippedReviewerBlock(rules: readonly NativePermissionRule[]): { start: number; rules: readonly NativePermissionRule[] } | undefined {
  for (const shipped of [legacyNativeReviewerRoleRules, nativeReviewerRoleRules]) {
    for (let start = rules.length - shipped.length; start >= 0; start--) {
      if (shipped.every((rule, offset) => {
        const actual = rules[start + offset];
        return actual?.action === rule.action && actual.resource === rule.resource && actual.effect === rule.effect;
      })) return { start, rules: shipped };
    }
  }
  return undefined;
}
function correctionGatewayReviewerRules(rules: readonly NativePermissionRule[]): NativePermissionRule[] {
  const role = agentToolRegistry.roles["dog-reviewer"];
  // Match product_agent_permissions()'s exact generated block, in place. A user's
  // surrounding agent rules and later session rules retain native last-match order.
  const generated = (correcting: boolean): NativePermissionRule[] => {
    const actions = [...new Set([...Object.values(role.tool_families),
      ...(correcting ? Object.values(role.correction_tool_families) : [])].flat())].sort();
    const native = [...new Set([...Object.values(role.native_tool_families),
      ...(correcting ? Object.values(role.correction_native_tool_families) : [])].flat())].sort();
    return [{ action: "*", resource: "*", effect: "deny" },
      ...actions.map(action => ({ action: agentToolRegistry.tool_prefix + action, resource: "*", effect: "allow" as const })),
      ...native.map(action => ({ action, resource: "*", effect: "allow" as const }))];
  };
  const original = generated(false);
  for (let start = rules.length - original.length; start >= 0; start--) {
    if (original.every((rule, offset) => {
      const actual = rules[start + offset];
      return actual?.action === rule.action && actual.resource === rule.resource && actual.effect === rule.effect;
    })) return [...rules.slice(0, start), ...generated(true), ...rules.slice(start + original.length)];
  }
  return [...rules];
}
const correctionAgents = new WeakMap<OpenCodeV2Context, Map<string, { generation: number; registration: Registration }>>();

/** Use 2.0.18's agent.transform/switchAgent BEFORE native tool snapshot selection; never mutate session rules. */
export async function syncReviewerCorrectionPermissions(context: OpenCodeV2Context, hooks: OpenCodeHooks, sessionID: string, activate = true): Promise<void> {
  const lanes = correctionPermissionLanes.get(context) ?? new Map<string, Promise<void>>();
  correctionPermissionLanes.set(context, lanes);
  const operation = (lanes.get(sessionID) ?? Promise.resolve()).catch(() => undefined).then(() =>
    syncReviewerCorrectionPermissionsOnce(context, hooks, sessionID, activate));
  lanes.set(sessionID, operation);
  try { await operation; }
  finally { if (lanes.get(sessionID) === operation) lanes.delete(sessionID); }
}
const correctionPermissionLanes = new WeakMap<OpenCodeV2Context, Map<string, Promise<void>>>();

/** Permission.configured in 2.0.18: agent rules, then the actual calling session, last match wins. */
async function originalReviewerPermission(context: OpenCodeV2Context, sessionID: string): Promise<NativePermissionRule["effect"]> {
  return configuredPermission(context, sessionID, "subagent", "dog-reviewer-v010");
}

async function configuredPermission(context: OpenCodeV2Context, sessionID: string, action: string, resource: string): Promise<NativePermissionRule["effect"]> {
  const info = await context.session.get({ sessionID });
  if (!record(info) || typeof info.agent !== "string" || !context.agent?.get) throw new Error("native-reviewer-correction-parent-permissions-unavailable");
  const response = await context.agent.get({ agentID: info.agent });
  const agent = response.data ?? response;
  if (!Array.isArray(agent.permissions)) throw new Error("native-reviewer-correction-parent-permissions-unavailable");
  const rules = [...agent.permissions, ...array(info.permissions)] as NativePermissionRule[];
  return [...rules].reverse().find(rule => nativeRuleMatch(action, rule.action) && nativeRuleMatch(resource, rule.resource))?.effect ?? "ask";
}

async function disposeCorrectionPermissions(context: OpenCodeV2Context, sessionID: string): Promise<void> {
  const active = correctionAgents.get(context);
  await active?.get(sessionID)?.registration.dispose();
  active?.delete(sessionID);
  await context.storage?.remove?.(`${correctionStoragePrefix}${sessionID}`);
}

async function syncReviewerCorrectionPermissionsOnce(context: OpenCodeV2Context, hooks: OpenCodeHooks, sessionID: string, activate: boolean): Promise<void> {
  const key = `${correctionStoragePrefix}${sessionID}`;
  const saved = await context.storage?.get(key);
  let scope: Awaited<ReturnType<NonNullable<OpenCodeHooks["reviewerCorrectionScope"]>>>;
  try { scope = await hooks.reviewerCorrectionScope?.(sessionID); }
  catch (error) {
    // Scope lookup can itself read the deleted child. Do not confuse a missing parent or a
    // transport failure with definite absence of this recovery identity.
    if (!isSessionNotFoundError(error) || error.sessionID !== sessionID) throw error;
    await disposeCorrectionPermissions(context, sessionID);
    return;
  }
  if (!scope && !record(saved)) return;
  if (!context.agent || !context.storage || !context.session.switchAgent) throw new Error("native-reviewer-correction-permissions-unavailable");
  const active = correctionAgents.get(context) ?? new Map<string, { generation: number; registration: Registration }>();
  correctionAgents.set(context, active);
  if (!scope) {
    // A failed lookup is not proof of deletion or restoration. Keep both the registration and
    // durable original identity so the next hook/setup scan can retry without settling again.
    let info: unknown;
    try { info = await context.session.get({ sessionID }); }
    catch (error) {
      // The pinned 2.0.18 client discriminant proves absence; transport/lookup failures do not.
      if (!isSessionNotFoundError(error) || error.sessionID !== sessionID) throw error;
      await disposeCorrectionPermissions(context, sessionID);
      return;
    }
    if (!record(info) || typeof info.agent !== "string") throw new Error("native-reviewer-correction-restoration-unconfirmed");
    if (record(info) && correctionAgent(info.agent)) await context.session.switchAgent({ sessionID,
      agent: record(saved) && typeof saved.agent === "string" ? saved.agent : "dog-reviewer-v010" });
    await disposeCorrectionPermissions(context, sessionID);
    return;
  }
  const info = await context.session.get({ sessionID });
  if (!record(info) || !record(info.model)) throw new Error("native-reviewer-correction-session-model-unavailable");
  const id = correctionAgentID(sessionID);
  const original = record(saved) && typeof saved.agent === "string" ? saved.agent : info.agent;
  if (original !== "dog-reviewer-v010") throw new Error("native-reviewer-correction-author-role-mismatch");
  await context.storage.set(key, { agent: original, model: info.model, generation: scope.generation });
  if (active.get(sessionID)?.generation !== scope.generation) {
    await active.get(sessionID)?.registration.dispose();
    active.delete(sessionID);
    const registration = await context.agent.transform(editor => {
      const reviewer = editor.get?.("dog-reviewer-v010");
      if (!reviewer?.permissions) throw new Error("native-reviewer-correction-role-permissions-unavailable");
      const rules = correctionGatewayReviewerRules(reviewer.permissions);
      const shipped = shippedReviewerBlock(rules);
      if (!shipped) throw new Error("native-reviewer-correction-readonly-role-block-unavailable");
      const inherited = [...rules.slice(0, shipped.start), ...shipped.rules.filter(rule => !["edit", "shell"].includes(rule.action)),
        ...["bind_write_gate", "release_write_gate", "operator_status", "expand_unit"].map(name => ({ action: `sortie_v010_${name}`, resource: "*", effect: "allow" as const })),
        ...rules.slice(shipped.start + shipped.rules.length)];
      editor.update(id, agent => Object.assign(agent, reviewer, { id, name: id, mode: "subagent", hidden: true,
        model: { ...info.model as JsonObject },
        // Project only the exact generated gateway block and shipped read-only edit/shell
        // role entries. Other configured rules keep their native order/effective meaning.
        // No edit/shell grants, copied historical denies, command scanner or session-rule replacement.
        // The existing correction-control tools stay exposed beneath the shipped sortie_* deny.
        // Common implementation gates own known output scope; the ordinary Reviewer is untouched.
        permissions: inherited }));
    });
    active.set(sessionID, { generation: scope.generation, registration });
  }
  const selected = activate ? id : original;
  if (info.agent !== selected) await context.session.switchAgent({ sessionID, agent: selected });
}

async function registerV2Hooks(context: OpenCodeV2Context, hooks: OpenCodeHooks, background: NativeBackgroundLifecycle,
  liveState: Map<string, unknown>): Promise<void> {
  const explicitlySelectedChildren = new Set<string>();
  const selectedChildModels = new Set<string>();
  const selectionKey = (parent: string, role: string, prompt: string) => `${parent}\0${role}\0${prompt}`;
  const correctionPermissions = (sessionID: string) => syncReviewerCorrectionPermissions(context, hooks, sessionID);
  const reconcileCorrectionPermissions = async (sessionID: string) => {
    for (const child of await hooks.reviewerCorrectionSessions?.(sessionID) ?? []) await correctionPermissions(child);
    await correctionPermissions(sessionID);
  };
  // The V1 config hook is not invoked by OpenCode V2. Apply only missing role
  // defaults in its native registry; a user's configured agent model wins.
  await context.agent?.transform(editor => {
    editor.update("dog-operator", agent => {
      if (typeof agent.system === "string" && agent.system.trim() === legacyOperatorSystem.trim()) agent.system = operatorSystem;
    });
    for (const [name, id, variant] of [
      ["dog-operator", "gpt-6.1-sol", "xhigh"],
      ["dogs-coordinator", "gpt-6.1-sol", "xhigh"],
      ["dog-advisor-v010", "gpt-6.1-sol", "xhigh"],
      ["dog-reviewer-v010", "gpt-6.1-sol", "xhigh"],
      ["dog-scout-v010", "gpt-6-luna-fast", "max"],
      ["dog-luna-worker-v010", "gpt-6-luna-fast", "max"],
      ["dog-worker-v010", "gpt-6.1-terra", "max"],
    ]) editor.update(name, agent => { agent.model ??= { providerID: "openai", id, variant }; });
    editor.update("dog-reviewer-v010", agent => {
      // Location-only candidate loading may retain released assets. Update only
      // the exact shipped body; user-customized instructions remain untouched.
      if (typeof agent.system === "string" && agent.system.trim() === legacyReviewerSystem.trim()) {
        agent.system = agent.system.replace(legacyReviewerObservationText, reviewerObservationText);
      }
      const rules = agent.permissions, shipped = rules && shippedReviewerBlock(rules);
      if (!rules || !shipped) return;
      agent.permissions = [...rules.slice(0, shipped.start), ...shipped.rules.filter(rule => rule.action !== "shell"),
        ...rules.slice(shipped.start + shipped.rules.length)];
    });
  });
  await context.tool.transform(editor => {
    // Task.model is for explicit per-task choices. Defaults remain structured in the registry
    // and are applied at the first child prompt if the host inherited its parent's model.
    editor.update?.("subagent", tool => {
      const execute = tool.execute;
      tool.execute = async (input, execution) => {
        const value = record(input) ? { ...input } : {};
        const joined = hooks.nativeTaskJoin?.(String(execution.id ?? ""));
        if (joined) return { content: joined.output ?? "Joined the existing native Reviewer; it continues in the same context.",
          metadata: { sessionID: joined.sessionID, status: joined.status ?? "running", joinedCallID: joined.callID, joined: true } };
        const coordinator = value.agent === "dogs-coordinator";
        const missionRole = coordinator || typeof value.agent === "string" && /^(?:dog-worker|dog-luna-worker|dog-reviewer)(?:-v010)?$/u.test(value.agent);
        if (!missionRole || typeof execution.progress !== "function") return execute(value, execution);
        const report = execution.progress as (value: JsonObject) => Promise<void>;
        let metadata: JsonObject = {};
        let pending = Promise.resolve();
        const update = (update: JsonObject) => {
          metadata = { ...metadata, ...update, ...(record(metadata.sortie_progress) && record(update.sortie_progress)
            ? { sortie_progress: { ...metadata.sortie_progress, ...update.sortie_progress } } : {}) };
          const snapshot = { ...metadata };
          pending = pending.catch(() => undefined).then(() => report(snapshot));
          return pending;
        };
        const root = workRootForActor(context.location.directory, String(execution.sessionID)) ?? String(execution.sessionID);
        const unbind = bindMissionProgress(root, update);
        const readProgress = coordinator ? missionProgressReader(context.location.directory, root, String(execution.id)) : async () => {
          const work = cachedWorkProgress(context.location.directory, root);
          return work ? { description: `🐾 ${formatWorkQuantity(work)}`, sortie_progress: { work_quantity: work } } : undefined;
        };
        let previous = "", reading: Promise<void> | undefined;
        const refresh = (): Promise<void> => {
          if (reading) return reading;
          reading = (async () => { try {
            const progress = await readProgress(), key = JSON.stringify(progress);
            if (progress && key !== previous) { await update(progress); previous = key; }
          } catch (error) { console.warn("[sortie-dogs-v010] mission progress unavailable", error instanceof Error ? error.message : "unknown"); }
          })().finally(() => { reading = undefined; });
          return reading;
        };
        // The native executor is a stable snapshot. Poll only local durable state, not models or
        // session status APIs; this also recovers progress after another plugin instance settles work.
        const timer = coordinator ? setInterval(() => { void refresh(); }, 1000) : undefined;
        timer?.unref();
        try {
          await refresh();
          const result = await execute(value, { ...execution, progress: update });
          await refresh();
          await pending.catch(() => undefined);
          // Native completion replaces metadata, so retain our display fields alongside its own.
          return { ...result, metadata: { ...metadata, ...(record(result.metadata) ? result.metadata : {}) } };
        } finally { if (timer) clearInterval(timer); unbind(); await reading; await pending.catch(() => undefined); }
      };
    });
    for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
      // The approved increase is discovered through execute/search. Direct-only registrations
      // are absent from that catalog; retain the other controls' existing direct entrypoints.
      editor.add({ name, description: definition.description, input: toolSchema(definition.args),
        options: { codemode: name === "sortie_v010_extend_mission_budget" },
        execute: async (input, execution) => {
          await background.reconcile(String(execution.sessionID ?? ""));
          let content: string;
          try { content = await definition.execute(legacyToolArgs(input, definition.args), {
            sessionID: String(execution.sessionID ?? ""), ...(typeof execution.id === "string" ? { callID: execution.id } : {}), ...(typeof execution.agent === "string" ? { agent: execution.agent } : {}) }); }
          finally { await reconcileCorrectionPermissions(String(execution.sessionID ?? "")); }
          if (name !== "sortie_v010_operator_status") return { content };
          const status: unknown = JSON.parse(content);
          return { content: record(status) ? serializeOperatorStatus({ ...status,
            runtime: { ...loadedAdapter, host_version: context.app?.version ?? null } }) : content };
        } });
    }
  });
  if (hooks["tool.execute.before"]) await context.tool.hook("execute.before", async event => {
    await background.resume(String(event.sessionID ?? ""));
    if (event.tool === "subagent" && record(event.input) && event.input.agent === "dog-reviewer-v010" &&
        typeof event.input.sessionID === "string" && (!context.agent || !context.storage)) {
      throw new Error("native-reviewer-correction-permissions-unavailable");
    }
    const mapped = { args: legacyToolInput(event.tool, event.input) };
    await hooks["tool.execute.before"]!({ tool: legacyToolName(event.tool), sessionID: String(event.sessionID ?? ""),
      callID: String(event.id ?? ""), ...(typeof event.agent === "string" ? { agent: event.agent } : {}) }, mapped);
    event.input = v2ToolInput(event.tool, record(mapped.args) ? mapped.args : {});
    if (event.tool === "subagent" && hooks.nativeTaskJoin?.(String(event.id ?? ""), false)) return;
    if (event.tool === "subagent" && record(event.input) && typeof event.input.sessionID === "string" && event.input.agent === "dog-reviewer-v010") {
      const child = event.input.sessionID;
      try {
        if (await hooks.reviewerCorrectionScope?.(child) && await originalReviewerPermission(context, String(event.sessionID)) === "deny") {
          throw new Error("native-reviewer-correction-parent-permission-denied");
        }
        // Pinned SubagentTool resolves/asserts input.agent BEFORE looking up/switching the child.
        // Admit the ORIGINAL target with its real caller-session last-match rules (including ask).
        // Keep the child on that same agent until native prompt admission, where our prompt hook
        // activates the scoped alias before the child's tool snapshot. No native model switch,
        // parent-registry grants, session-rule mutation or permission bypass is needed.
        await syncReviewerCorrectionPermissions(context, hooks, child, false);
      }
      catch (error) {
        // Native launch has not run. Settle this already-admitted dispatch through the same
        // failure path, so permission/storage failures cannot strand a writer or reservation.
        await hooks["tool.execute.after"]?.({ tool: "task", sessionID: String(event.sessionID), callID: String(event.id),
          args: legacyToolInput("subagent", event.input) }, { status: "error", output: "Native correction permission projection failed before launch.",
          metadata: { sessionID: child, status: "failed" } });
        await correctionPermissions(child);
        throw error;
      }
    }
    if (event.tool === "subagent" && record(event.input) && event.input.background === true) {
      const info = await context.session.get({ sessionID: String(event.sessionID) });
      if (record(info) && typeof info.parentID === "string") delete event.input.background;
      else await background.admit(String(event.sessionID), String(event.id), event.input, hooks.backgroundOwner?.(String(event.id)));
    }
    if (event.tool === "subagent" && record(event.input) && typeof event.input.agent === "string" && typeof event.input.prompt === "string") {
      // Record only admitted explicit choices, scoped by role as well as parent and prompt.
      const key = selectionKey(String(event.sessionID), event.input.agent, event.input.prompt);
      if (typeof event.input.model === "string") explicitlySelectedChildren.add(key);
      else explicitlySelectedChildren.delete(key);
    }
  });
  await context.tool.hook("execute.after", async event => {
    const result = record(event.result) ? event.result : {};
    const mapped: JsonObject = { status: event.status, output: toolContentText(result.content), metadata: result.metadata ?? event.error };
    const resumedReviewer = event.tool === "subagent" && record(event.input) && (event.input.agent === "dog-reviewer-v010" || correctionAgent(event.input.agent))
      ? string(event.input.sessionID) : undefined;
    if (resumedReviewer && await hooks.reviewerCorrectionScope?.(resumedReviewer) &&
        (!record(mapped.metadata) || typeof mapped.metadata.sessionID !== "string")) {
      mapped.metadata = { ...(record(mapped.metadata) ? mapped.metadata : {}), sessionID: resumedReviewer };
    }
    const running = event.tool === "subagent" && (result.status === "running" || record(result.metadata) && result.metadata.status === "running");
    if (running) mapped.metadata = { ...(record(mapped.metadata) ? mapped.metadata : {}), status: "running" };
    const view = event.tool === "read" && event.status === "completed"
      ? await nativeContractReadSnapshot(context.location.directory, event.input) : undefined;
    if (view !== undefined) mapped.output = view.output;
    await hooks["tool.execute.after"]?.({ tool: legacyToolName(event.tool), sessionID: String(event.sessionID ?? ""),
      callID: String(event.id ?? ""), args: legacyToolInput(event.tool, event.input),
      ...(view ? { nativeReadHash: view.hash } : {}) }, mapped);
    if (event.tool === "subagent") {
      const metadata = record(result.metadata) ? result.metadata : {};
      await background.launched(String(event.sessionID), String(event.id), string(metadata.sessionID), running);
      if (typeof metadata.sessionID === "string") await correctionPermissions(metadata.sessionID);
      if (resumedReviewer && resumedReviewer !== metadata.sessionID) await correctionPermissions(resumedReviewer);
    }
    await background.checkpoint(String(event.sessionID));
    if (!running && typeof mapped.output === "string" && event.status === "completed") event.result = replaceToolContent(result, mapped.output);
  });
  if (hooks["chat.message"]) await context.session.hook("prompt", async event => {
    const info = await context.session.get({ sessionID: String(event.sessionID ?? "") });
    if (!record(info) || !record(event.prompt)) return;
    const nativeText = String(event.prompt.text ?? "");
    const legacyText = typeof info.parentID === "string" && nativeText.startsWith(V2_SUBAGENT_PROMPT_PREFIX)
      ? nativeText.slice(V2_SUBAGENT_PROMPT_PREFIX.length)
      : nativeText;
    if (typeof info.parentID === "string") await background.bind(info.parentID, String(event.sessionID), String(info.agent), legacyText,
      string(event.messageID) ?? string(event.prompt.id));
    else await background.reconcile(String(event.sessionID));
    const nativeMetadata = record(event.metadata) ? event.metadata : record(event.prompt.metadata) ? event.prompt.metadata : {};
    // A native Job's completion is host inbox work, not a new user requirement or Sortie ticket.
    if (nativeMetadata.source === "subagent" || event.prompt.type === "synthetic") return;
    let model = modelReference(info.model) ?? { providerID: "unknown", modelID: "unknown" };
    if (typeof info.parentID === "string" && typeof info.agent === "string" && context.agent?.get) {
      const key = selectionKey(info.parentID, info.agent, legacyText);
      const explicit = explicitlySelectedChildren.delete(key);
      const priorSelection = selectedChildModels.has(String(event.sessionID)) ? undefined
        : await context.storage?.get(childSelectionKey(String(event.sessionID)));
      const retained = record(priorSelection) && priorSelection.agent === info.agent;
      if (!selectedChildModels.has(String(event.sessionID)) && !retained && ["dogs-coordinator", "dog-advisor-v010", "dog-reviewer-v010", "dog-scout-v010",
        "dog-luna-worker-v010", "dog-worker-v010"].includes(info.agent)) {
        // Process-local memory is empty after reload. Existing native context proves this is a
        // resume, whose current model (including a user's later switch) must remain authoritative.
        const history = explicit ? undefined : await context.session.context({ sessionID: String(event.sessionID) });
        const messages = Array.isArray(history) ? history : record(history) && Array.isArray(history.data) ? history.data : undefined;
        if (!explicit && !messages) throw new Error("sortie-v010-child-history-unavailable");
        if (!explicit && messages!.length === 0) {
          const configured = await context.agent.get({ agentID: info.agent });
          const selected = configured.data?.model ?? configured.model;
          if (!selected) throw new Error(`sortie-v010-subagent-model-unavailable:${info.agent}`);
          if (model.providerID !== selected.providerID || model.modelID !== selected.id || model.variant !== selected.variant) {
            await context.session.switchModel({ sessionID: String(event.sessionID), model: selected });
            model = { providerID: selected.providerID, modelID: selected.id, ...(selected.variant ? { variant: selected.variant } : {}) };
          }
        }
        // Queued prompt admission can run this hook before any context message exists. Plugin
        // storage retains the first selection without racing the host's session metadata writes.
        await context.storage?.set(childSelectionKey(String(event.sessionID)), { agent: info.agent });
      }
      selectedChildModels.add(String(event.sessionID));
    }
    const output = { message: { id: String(event.messageID ?? ""), agent: string(info.agent), model },
      parts: legacyUserParts(legacyText, event.prompt.files, String(event.sessionID), String(event.messageID ?? "")) };
    await hooks["chat.message"]!({ sessionID: String(event.sessionID), messageID: String(event.messageID ?? ""),
      ...(typeof info.agent === "string" ? { agent: info.agent } : {}), model }, output);
    await reconcileCorrectionPermissions(String(event.sessionID));
    // Native explicit selections and configured role models already won above. Legacy fixed serial
    // routing must not undo them at prompt admission (including same-child resumes).
    if (typeof info.parentID === "string" && selectedChildModels.has(String(event.sessionID))) output.message.model = model;
    const text = output.parts.find(part => record(part) && part.type === "text" && typeof part.text === "string");
    if (record(text) && typeof text.text === "string" && text.text !== legacyText) event.prompt.text = text.text;
    if (typeof output.message.agent === "string" && output.message.agent !== info.agent &&
        !(correctionAgent(info.agent) && output.message.agent === "dog-reviewer-v010")) {
      await context.session.switchAgent({ sessionID: event.sessionID, agent: output.message.agent });
    }
    const selected = output.message.model;
    if (selected.providerID !== "unknown" && (selected.providerID !== model.providerID || selected.modelID !== model.modelID || selected.variant !== model.variant)) {
      await context.session.switchModel({ sessionID: event.sessionID,
        model: { providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) } });
    }
  });
  if (hooks["experimental.chat.system.transform"]) await context.session.hook("context", async event => {
    reconcileOperatorContext(event);
    // V2 has no public assistant-message/part update API. The normal completion
    // request must retain the host-authored card for verbatim final delivery;
    // the terminal observer below is accounting-only, not a display transport.
    await background.resume(String(event.sessionID ?? ""));
    await background.reconcile(String(event.sessionID ?? ""));
    if (Array.isArray(event.messages)) event.messages = await background.project(String(event.sessionID ?? ""), event.messages);
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: String(event.sessionID ?? "") }, output);
    await reconcileCorrectionPermissions(String(event.sessionID));
    if (record(event.tools)) {
      const correcting = correctionAgent(event.agent) && !!await hooks.reviewerCorrectionScope?.(String(event.sessionID));
      const logicalRole = canonicalAgent(V010_RUNTIME_PROFILE, String(event.agent));
      const role = logicalRole ? (agentToolRegistry.roles as Record<string, { tool_families: Record<string, string[]>;
        correction_tool_families?: Record<string, string[]>; native_tool_families?: Record<string, string[]>;
        correction_native_tool_families?: Record<string, string[]> }>)[logicalRole] : undefined;
      const families = role ? [...Object.values(role.tool_families), ...(correcting ? Object.values(role.correction_tool_families ?? {}) : [])] : [];
      const allowed = role ? [...new Set(families.flat())] : undefined;
      const nativeFamilies = role ? [...Object.values(role.native_tool_families ?? {}),
        ...(correcting ? Object.values(role.correction_native_tool_families ?? {}) : [])] : [];
      const allowedNativeTools = new Set(nativeFamilies.flat());
      for (const key of Object.keys(event.tools)) {
        if ((event.agent === "dog-reviewer-v010" || correctionAgent(event.agent)) && !correcting &&
             ["edit", "write", "patch"].includes(key)) { delete event.tools[key]; continue; }
        if (key.startsWith("fh_") && !allowedNativeTools.has(key)) { delete event.tools[key]; continue; }
        if (!key.startsWith("sortie_")) continue;
        if (!allowed || !key.startsWith("sortie_v010_") || !allowed.includes(key.slice("sortie_v010_".length))) delete event.tools[key];
      }
      if (event.agent === "dog-reviewer-v010" || correctionAgent(event.agent)) {
        const tools = reviewerModelToolOrder(event.tools);
        event.tools = tools;
        output.system.push(`Native tools actually available in this request: ${Object.keys(tools).sort().join(", ")}. Use these tools directly; do not infer missing tools or ask the root to transcribe source.`);
      }
    }
    const id = String(event.sessionID ?? "");
    const previous = liveState.get(id) ?? await context.storage?.get(liveStateKey(id)).catch(() => {
      console.warn("[sortie-dogs-v010] Live-state projection restore unavailable; rebuilding current host state");
      return undefined;
    });
    const projection = modelLiveState(output.system, Array.isArray(event.messages) ? event.messages : undefined, previous);
    if (projection.history) {
      liveState.set(id, projection.history);
      await context.storage?.set(liveStateKey(id), projection.history).catch(() => {
        console.warn("[sortie-dogs-v010] Live-state projection persistence unavailable; current instance retains continuity");
      });
    }
    if (Array.isArray(event.system)) event.system.push(...projection.system.map(text => ({ type: "text", text })));
    if (projection.messages) event.messages = projection.messages;
  });
  if (hooks["experimental.session.compacting"]) await context.session.hook("compaction", async event => {
    reconcileOperatorContext(event);
    if (Array.isArray(event.messages)) event.messages = completionReportModelMessages(event.messages);
    await background.reconcile(String(event.sessionID ?? ""));
    if (Array.isArray(event.messages)) event.messages = await background.project(String(event.sessionID ?? ""), event.messages);
    // V2 compaction builds its own tool snapshot and does not run the normal
    // context hook's agent-specific Sortie filter. Summary calls cannot run
    // local tools, so do not expose Sortie schemas to the compaction provider.
    if (record(event.tools)) for (const name of Object.keys(event.tools)) {
      if (name.startsWith("sortie_")) delete event.tools[name];
    }
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!({ sessionID: String(event.sessionID ?? "") }, output);
    if (Array.isArray(event.system)) event.system.push(...output.context.map(text => ({ type: "text", text })));
  });
  await context.permission.hook("evaluate", async event => {
    const alias = event.action === "subagent" && array(event.resources).some(correctionAgent);
    let original = alias ? await originalReviewerPermission(context, String(event.sessionID)) : undefined;
    const output = { status: event.effect === "deny" ? "deny" : event.effect === "allow" ? "allow" : "ask" } as { status: "ask" | "deny" | "allow" };
    await hooks["permission.ask"]?.({ permission: String(event.action ?? ""), patterns: array(event.resources).map(String),
      ...(typeof event.sessionID === "string" ? { sessionID: event.sessionID } : {}) }, output);
    // Saved alias allows and legacy hooks cannot upgrade an original configured ask/deny.
    event.effect = original === "deny" || output.status === "deny" ? "deny" : original ?? output.status;
  });
}

export function createSortieDogsV2Plugin(legacyFactory: OpenCodePlugin = SortieDogsV010Plugin): OpenCodeV2Plugin {
  return {
    id: "sortie-dogs.v010",
    async setup(context) {
      const releaseWork = retainWorkDirectory(context.location.directory);
      try {
        let hooks: OpenCodeHooks;
        const liveState = new Map<string, unknown>();
        const background = new NativeBackgroundLifecycle(context, async (dispatch, text) => {
          if (dispatch.owner) hooks.backgroundOwner?.(dispatch.callID, dispatch.owner);
          const output = { status: dispatch.terminal === "succeeded" ? "completed" : dispatch.terminal === "interrupted" ? "cancelled" : "error",
            output: text, metadata: { sessionID: dispatch.child, status: dispatch.terminal } };
          await hooks["tool.execute.after"]?.({ tool: "task", sessionID: dispatch.parent, callID: dispatch.callID,
            args: legacyToolInput("subagent", dispatch.input) }, output);
          if (dispatch.child) await syncReviewerCorrectionPermissions(context, hooks, dispatch.child);
          // Inline Review already has a compact provenance receipt; retain the full diagnostic packet in its ordinary tool route.
          try {
            const packet: unknown = JSON.parse(output.output);
            if (record(packet) && record(packet.completion_receipt)) return JSON.stringify(packet.completion_receipt);
          } catch { /* Ordinary native outputs are not necessarily JSON. */ }
          return output.output;
        }, (callID, restore) => hooks.backgroundOwner?.(callID, restore),
        (parent, callID, child, promptID) => hooks.backgroundResult?.(parent, callID, child, promptID) ?? Promise.resolve(undefined));
        hooks = await legacyFactory({ directory: context.location.directory, client: legacyClient(context) as never,
          nativeBackground: background, returnReportTransport: "tool-result",
          reviewerCorrectionPermissions: !!context.agent && !!context.storage && !!context.session.switchAgent }, context.options ?? {});
        await registerV2Hooks(context, hooks, background, liveState);
        // Recreate exact durable correction profiles at plugin setup, before resumed native Steps
        // resolve their agent/tool snapshots. Storage.scan is part of Plugin 2.0.18's public domain.
        if (context.storage?.scan) {
          let after: string | undefined;
          do {
            const page = await context.storage.scan({ prefix: correctionStoragePrefix, ...(after ? { after } : {}) });
            for (const entry of page.entries) await syncReviewerCorrectionPermissions(context, hooks, entry.key.slice(correctionStoragePrefix.length));
            after = page.next;
          } while (after);
        }
        const finalize = createV2ReturnReportFinalizer(context, hooks);
        const controller = new AbortController();
        const eventOperations = new Map<string, Promise<void>>();
        const handleEvent = async (event: JsonObject): Promise<void> => {
          const data = record(event.data) ? event.data : {};
          const id = string(data.sessionID);
          if (event.type === "filesystem.changed" && typeof data.file === "string") {
            await hooks.event?.({ event: { type: "file.edited", properties: { file: data.file } } });
            return;
          }
          if (id === undefined) return;
          try {
            if (String(event.type).startsWith("session.execution.") || event.type === "session.inbox.enqueued" || event.type === "session.idle") await background.event(event);
            if (event.type === "session.deleted") {
              await context.storage?.remove?.(childSelectionKey(id));
              liveState.delete(id);
              await context.storage?.remove?.(liveStateKey(id));
              // This native event is definite deletion, unlike a transient session.get failure.
              await disposeCorrectionPermissions(context, id);
            }
            if (event.type === "session.execution.succeeded") await finalize(id);
            if (event.type === "session.created" || event.type === "session.deleted" || event.type === "session.idle") {
              const info = event.type === "session.created" ? await context.session.get({ sessionID: id }).catch(() => ({ id })) : { id };
              await hooks.event?.({ event: { type: String(event.type), properties: { sessionID: id, info } } });
              for (const child of await hooks.reviewerCorrectionSessions?.(id) ?? []) await syncReviewerCorrectionPermissions(context, hooks, child);
              if (event.type !== "session.deleted") await syncReviewerCorrectionPermissions(context, hooks, id);
            }
            if (event.type === "session.compaction.ended") await hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: id } } });
          } finally { if (event.type === "session.deleted") forgetWorkSession(context.location.directory, id); }
        };
        void (async () => {
          for await (const event of context.event.subscribe({ signal: controller.signal })) {
            const data = record(event.data) ? event.data : {};
            const lane = string(data.sessionID) ?? "filesystem";
            const operation = (eventOperations.get(lane) ?? Promise.resolve()).then(() => handleEvent(event)).catch(error => {
              console.warn("[sortie-dogs-v010] V2 event handling failed", error instanceof Error ? error.message : "unknown");
            }).finally(() => { if (eventOperations.get(lane) === operation) eventOperations.delete(lane); });
            eventOperations.set(lane, operation);
          }
        })().catch(error => {
          if (!controller.signal.aborted) console.warn("[sortie-dogs-v010] V2 event adapter stopped", error instanceof Error ? error.message : "unknown");
        });
        return () => { controller.abort(); releaseWork(); };
      } catch (error) { releaseWork(); throw error; }
    },
  };
}

export const SortieDogsV2Plugin = createSortieDogsV2Plugin();
export default SortieDogsV2Plugin;
