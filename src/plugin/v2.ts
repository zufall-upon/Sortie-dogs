import type { OpenCodeHooks, OpenCodePlugin } from "./index.js";
import { SortieDogsV010Plugin } from "./profiled.js";

type JsonObject = Record<string, unknown>;
type Registration = { dispose(): Promise<void> | void };

interface V2ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: JsonObject;
    execute(input: unknown, context: JsonObject): Promise<JsonObject>;
  }): void;
  update?(id: string, update: (tool: { execute(input: unknown, context: JsonObject): Promise<JsonObject> }) => void): void;
}

interface V2AgentEditor {
  update(id: string, update: (agent: { model?: { providerID: string; id: string; variant?: string } }) => void): void;
}

export interface OpenCodeV2Context {
  readonly app?: { readonly version?: string };
  readonly location: { readonly directory: string; readonly project?: { readonly id?: string } };
  readonly options?: Readonly<Record<string, unknown>>;
  readonly agent?: {
    transform(callback: (editor: V2AgentEditor) => void): Promise<Registration>;
    get?(input: { agentID: string }): Promise<{ model?: { providerID: string; id: string; variant?: string };
      data?: { model?: { providerID: string; id: string; variant?: string } } }>;
  };
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<JsonObject> };
  readonly tool: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<Registration>;
    hook(name: "execute.before" | "execute.after", callback: (event: JsonObject) => Promise<void> | void): Promise<Registration>;
  };
  readonly session: {
    list?(input: JsonObject): Promise<unknown>;
    get(input: { sessionID: string }): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
    prompt(input: JsonObject): Promise<unknown>;
    synthetic(input: JsonObject): Promise<unknown>;
    interrupt(input: JsonObject): Promise<unknown>;
    switchAgent(input: JsonObject): Promise<unknown>;
    switchModel(input: JsonObject): Promise<unknown>;
    hook(name: "prompt" | "context" | "compaction", callback: (event: JsonObject) => Promise<void> | void): Promise<Registration>;
  };
  readonly message?: { list(input: JsonObject): Promise<unknown> };
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

function legacyMessage(value: unknown, session: string, agent?: string): JsonObject | undefined {
  if (!record(value) || typeof value.id !== "string" || typeof value.type !== "string") return undefined;
  const id = value.id;
  if (value.type === "user") {
    return { info: { id, sessionID: session, role: "user", agent, time: value.time },
      parts: [{ id: `${id}-text`, sessionID: session, messageID: id, type: "text", text: String(value.text ?? "") }] };
  }
  if (value.type !== "assistant") {
    if (value.type === "synthetic") return { info: { id, sessionID: session, role: "user", agent, time: value.time },
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

async function legacyMessages(context: OpenCodeV2Context, id: string): Promise<JsonObject[]> {
  const [info, history] = await Promise.all([
    context.session.get({ sessionID: id }).catch(() => undefined),
    context.message ? nativePages(cursor => context.message!.list({ sessionID: id, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) }))
      : context.session.context({ sessionID: id }),
  ]);
  const agent = record(info) ? string(info.agent) : undefined;
  return array(history).flatMap(value => {
    const converted = legacyMessage(value, id, agent);
    return converted === undefined ? [] : [converted];
  });
}

async function nativePages(fetch: (cursor?: string) => Promise<unknown>): Promise<unknown[]> {
  const items: unknown[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await fetch(cursor);
    if (!record(result) || !Array.isArray(result.data) || !record(result.cursor)) throw new Error("v2-history-page-invalid");
    items.push(...result.data);
    const next = string(result.cursor.next);
    if (!next) return items;
    if (seen.has(next)) throw new Error("v2-history-cursor-repeated");
    seen.add(next); cursor = next;
  }
  throw new Error("v2-history-page-limit");
}

function legacyClient(context: OpenCodeV2Context): JsonObject {
  const directory = context.location.directory;
  const session = {
    get: async (request: unknown) => {
      const id = sessionID(request);
      return { data: id === undefined ? undefined : await context.session.get({ sessionID: id }) };
    },
    messages: async (request: unknown) => {
      const id = sessionID(request);
      return { data: id === undefined ? [] : await legacyMessages(context, id) };
    },
    message: async (request: unknown) => {
      const id = sessionID(request), wanted = messageID(request);
      return { data: id === undefined || wanted === undefined ? undefined
        : (await legacyMessages(context, id)).find(message => record(message.info) && message.info.id === wanted) };
    },
    ...(context.session.list ? { children: async (request: unknown) => {
      const id = sessionID(request);
      if (id === undefined) throw new Error("v2-history-parent-missing");
      return { data: await nativePages(cursor => context.session.list!({ parentID: id, limit: 100,
        ...(cursor ? { cursor } : { order: "asc" }) })) };
    } } : {}),
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
  };
  return {
    session,
    v2: { model: { list: () => context.model?.list() } },
    provider: { list: () => context.provider?.list() },
  };
}

function plainSchema(value: unknown): JsonObject {
  if (!record(value)) return { type: "string" };
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== "x-sortie-optional" && typeof item !== "function"));
}

function toolSchema(args: Record<string, unknown>): JsonObject {
  const entries = Object.entries(args);
  return { type: "object", properties: Object.fromEntries(entries.map(([name, schema]) => [name, plainSchema(schema)])),
    required: entries.filter(([, schema]) => !record(schema) || schema["x-sortie-optional"] !== true).map(([name]) => name),
    additionalProperties: false };
}

function legacyToolName(name: unknown): string {
  return name === "subagent" ? "task" : String(name ?? "");
}

function legacyToolInput(name: unknown, input: unknown): JsonObject {
  const value = record(input) ? { ...input } : {};
  if (name === "subagent") {
    if (value.background === true && typeof value.prompt === "string" && value.prompt.startsWith("SORTIE_OPERATOR_")) {
      throw new Error("operator-background-dispatch-not-supported: retry the same exact Task with background omitted or false; no admission or budget reservation occurred. Operator dispatch requires foreground completion for lifecycle accounting.");
    }
    if (value.background === false) delete value.background;
    if (typeof value.agent === "string") value.subagent_type = value.agent;
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
  return typeof result.content === "string" ? { ...result, content: text }
    : { ...result, content: [{ type: "text", text }] };
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

async function registerV2Hooks(context: OpenCodeV2Context, hooks: OpenCodeHooks): Promise<void> {
  const explicitlySelectedChildren = new Set<string>();
  const classifiedSubagentModels = new Map<string, boolean>();
  // The V1 config hook is not invoked by OpenCode V2. Apply only missing role
  // defaults in its native registry; a user's configured agent model wins.
  await context.agent?.transform(editor => {
    for (const [name, id, variant] of [
      ["dog-operator", "gpt-6-sol", "xhigh"],
      ["dogs-coordinator", "gpt-6-sol", "xhigh"],
      ["dog-advisor-v010", "gpt-6-sol", "xhigh"],
      ["dog-reviewer-v010", "gpt-6-sol", "xhigh"],
      ["dog-scout-v010", "gpt-6-luna-fast", "max"],
      ["dog-luna-worker-v010", "gpt-6-luna-fast", "max"],
      ["dog-worker-v010", "gpt-6-luna-fast", "max"],
    ]) editor.update(name, agent => { agent.model ??= { providerID: "openai", id, variant }; });
  });
  await context.tool.transform(editor => {
    // Mutating execute.before's draft does not reliably affect V2's native
    // subagent model selection. Wrap the executable tool before child creation.
    editor.update?.("subagent", tool => {
      const execute = tool.execute;
      tool.execute = async (input, execution) => {
        const value = record(input) ? { ...input } : {};
        const key = typeof execution?.sessionID === "string" && typeof value.prompt === "string"
          ? `${execution.sessionID}\0${value.prompt}` : undefined;
        const explicit = key === undefined ? value.model !== undefined
          : classifiedSubagentModels.get(key) ?? value.model !== undefined;
        if (key !== undefined) classifiedSubagentModels.delete(key);
        if (typeof value.agent === "string" && !explicit && context.agent?.get &&
          ["dogs-coordinator", "dog-advisor-v010", "dog-reviewer-v010", "dog-scout-v010",
            "dog-luna-worker-v010", "dog-worker-v010"].includes(value.agent)) {
          const resolved = await context.agent.get({ agentID: value.agent });
          const model = resolved.data?.model ?? resolved.model;
          if (!model) throw new Error(`sortie-v010-subagent-model-unavailable:${value.agent}`);
          value.model = `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
        }
        return execute(value, execution);
      };
    });
    for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
      editor.add({ name, description: definition.description, input: toolSchema(definition.args),
        execute: async (input, execution) => ({ content: await definition.execute(record(input) ? input as Record<string, string> : {}, {
          sessionID: String(execution.sessionID ?? ""), ...(typeof execution.agent === "string" ? { agent: execution.agent } : {}) }) }) });
    }
  });
  if (hooks["tool.execute.before"]) await context.tool.hook("execute.before", async event => {
    if (event.tool === "subagent" && record(event.input) && typeof event.input.prompt === "string") {
      const key = `${event.sessionID}\0${event.input.prompt}`;
      const explicit = typeof event.input.model === "string";
      classifiedSubagentModels.set(key, explicit);
      if (explicit) explicitlySelectedChildren.add(key);
    }
    const mapped = { args: legacyToolInput(event.tool, event.input) };
    await hooks["tool.execute.before"]!({ tool: legacyToolName(event.tool), sessionID: String(event.sessionID ?? ""),
      callID: String(event.id ?? ""), ...(typeof event.agent === "string" ? { agent: event.agent } : {}) }, mapped);
    event.input = v2ToolInput(event.tool, record(mapped.args) ? mapped.args : {});
    if (event.tool === "subagent" && record(event.input) && typeof event.input.agent === "string" &&
      event.input.model === undefined) {
      const role = event.input.agent;
      if (["dogs-coordinator", "dog-advisor-v010", "dog-reviewer-v010", "dog-scout-v010",
        "dog-luna-worker-v010", "dog-worker-v010"].includes(role)) {
        const configured = await context.agent?.get?.({ agentID: role });
        const model = configured?.data?.model ?? configured?.model;
        if (!model) throw new Error(`sortie-v010-subagent-model-unavailable:${role}`);
        event.input.model = `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
      }
    }
  });
  if (hooks["tool.execute.after"]) await context.tool.hook("execute.after", async event => {
    const result = record(event.result) ? event.result : {};
    const mapped: JsonObject = { status: event.status, output: toolContentText(result.content), metadata: result.metadata ?? event.error };
    await hooks["tool.execute.after"]!({ tool: legacyToolName(event.tool), sessionID: String(event.sessionID ?? ""),
      callID: String(event.id ?? "") }, mapped);
    if (typeof mapped.output === "string" && event.status === "completed") event.result = replaceToolContent(result, mapped.output);
  });
  if (hooks["chat.message"]) await context.session.hook("prompt", async event => {
    const info = await context.session.get({ sessionID: String(event.sessionID ?? "") });
    if (!record(info) || !record(event.prompt)) return;
    const nativeText = String(event.prompt.text ?? "");
    const legacyText = typeof info.parentID === "string" && nativeText.startsWith(V2_SUBAGENT_PROMPT_PREFIX)
      ? nativeText.slice(V2_SUBAGENT_PROMPT_PREFIX.length)
      : nativeText;
    let model = modelReference(info.model) ?? { providerID: "unknown", modelID: "unknown" };
    if (typeof info.parentID === "string" && typeof info.agent === "string" && context.agent?.get) {
      const key = `${info.parentID}\0${legacyText}`;
      const explicit = explicitlySelectedChildren.delete(key);
      if (!explicit && ["dogs-coordinator", "dog-advisor-v010", "dog-reviewer-v010", "dog-scout-v010",
        "dog-luna-worker-v010", "dog-worker-v010"].includes(info.agent)) {
        const configured = await context.agent.get({ agentID: info.agent });
        const selected = configured.data?.model ?? configured.model;
        if (!selected) throw new Error(`sortie-v010-subagent-model-unavailable:${info.agent}`);
        if (model.providerID !== selected.providerID || model.modelID !== selected.id || model.variant !== selected.variant) {
          await context.session.switchModel({ sessionID: String(event.sessionID), model: selected });
          model = { providerID: selected.providerID, modelID: selected.id, ...(selected.variant ? { variant: selected.variant } : {}) };
        }
      }
    }
    const output = { message: { id: String(event.messageID ?? ""), agent: string(info.agent), model },
      parts: [{ type: "text", text: legacyText }] };
    await hooks["chat.message"]!({ sessionID: String(event.sessionID), messageID: String(event.messageID ?? ""),
      ...(typeof info.agent === "string" ? { agent: info.agent } : {}), model }, output);
    const text = output.parts.find(part => record(part) && part.type === "text" && typeof part.text === "string");
    if (record(text) && typeof text.text === "string" && text.text !== legacyText) event.prompt.text = text.text;
    if (typeof output.message.agent === "string" && output.message.agent !== info.agent) {
      await context.session.switchAgent({ sessionID: event.sessionID, agent: output.message.agent });
    }
    const selected = output.message.model;
    if (selected.providerID !== "unknown" && (selected.providerID !== model.providerID || selected.modelID !== model.modelID || selected.variant !== model.variant)) {
      await context.session.switchModel({ sessionID: event.sessionID,
        model: { providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) } });
    }
  });
  if (hooks["experimental.chat.system.transform"]) await context.session.hook("context", async event => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: String(event.sessionID ?? "") }, output);
    if (Array.isArray(event.system)) event.system.push(...output.system.map(text => ({ type: "text", text })));
  });
  if (hooks["experimental.session.compacting"]) await context.session.hook("compaction", async event => {
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!({ sessionID: String(event.sessionID ?? "") }, output);
    if (Array.isArray(event.system)) event.system.push(...output.context.map(text => ({ type: "text", text })));
  });
  if (hooks["permission.ask"]) await context.permission.hook("evaluate", async event => {
    const output = { status: event.effect === "deny" ? "deny" : event.effect === "allow" ? "allow" : "ask" } as { status: "ask" | "deny" | "allow" };
    await hooks["permission.ask"]!({ permission: String(event.action ?? ""), patterns: array(event.resources).map(String),
      ...(typeof event.sessionID === "string" ? { sessionID: event.sessionID } : {}) }, output);
    event.effect = output.status;
  });
}

export function createSortieDogsV2Plugin(legacyFactory: OpenCodePlugin = SortieDogsV010Plugin): OpenCodeV2Plugin {
  return {
    id: "sortie-dogs.v010",
    async setup(context) {
      const hooks = await legacyFactory({ directory: context.location.directory, client: legacyClient(context) as never,
        returnReportTransport: "tool-result" }, context.options ?? {});
      await registerV2Hooks(context, hooks);
      const finalize = createV2ReturnReportFinalizer(context, hooks);
      const controller = new AbortController();
      void (async () => {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          try {
            const data = record(event.data) ? event.data : {};
            const id = string(data.sessionID);
            if (event.type === "filesystem.changed" && typeof data.file === "string") {
              await hooks.event?.({ event: { type: "file.edited", properties: { file: data.file } } });
              continue;
            }
            if (id === undefined) continue;
            if (event.type === "session.execution.succeeded") await finalize(id);
            if (event.type === "session.created" || event.type === "session.deleted" || event.type === "session.idle") {
              const info = event.type === "session.created" ? await context.session.get({ sessionID: id }).catch(() => ({ id })) : { id };
              await hooks.event?.({ event: { type: String(event.type), properties: { sessionID: id, info } } });
            }
            if (event.type === "session.compaction.ended") await hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: id } } });
          } catch (error) {
            console.warn("[sortie-dogs-v010] V2 event handling failed", error instanceof Error ? error.message : "unknown");
          }
        }
      })().catch(error => {
        if (!controller.signal.aborted) console.warn("[sortie-dogs-v010] V2 event adapter stopped", error instanceof Error ? error.message : "unknown");
      });
      return () => controller.abort();
    },
  };
}

export const SortieDogsV2Plugin = createSortieDogsV2Plugin();
export default SortieDogsV2Plugin;
