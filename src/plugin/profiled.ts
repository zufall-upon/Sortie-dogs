import { V010_RUNTIME_ASSET_VERSION } from "../asset-version.js";
import { OperatorRuntime } from "../core/operator-runtime.js";
import { CANONICAL_AGENT_ROLES, canonicalAgent, profileAgent, profileTool, V010_RUNTIME_PROFILE,
  type CanonicalAgentRole, type RuntimeProfile } from "../core/runtime-profile.js";
import { SortieDogsPlugin as canonicalPlugin, type OpenCodeHooks, type OpenCodePlugin, type OpenCodePluginInput } from "./index.js";
import { taskChildSessionID } from "./task-result-repair.js";
import type { RuntimeBridge } from "./runtime-bridge.js";
import { relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { BUILT_IN_MODEL_CATALOG } from "./model-routing.js";

const SERIAL_CAPABILITIES = new Set([
  "sortie_bind_write_gate", "sortie_release_write_gate", "sortie_check_contract",
  "sortie_compact_and_continue", "sortie_enable_backlog_drain",
]);
const PREVIEW_WORKER_ROUTE = Object.freeze({ model: "openai/gpt-5.6-sol", variant: "medium" });
const PREVIEW_PRIMARY_ROUTE = Object.freeze({ model: "openai/gpt-5.6-sol", variant: "low" });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const payload = (value: unknown): unknown => record(value) && "data" in value ? value.data : value;
type Tool = NonNullable<OpenCodeHooks["tool"]>[string];

function forwardTerminalText(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const first = lines.findIndex(line => line.trim().length > 0);
  if (first >= 0 && /^DONE(?=[ \t]*(?:[—-]|$))/u.test(lines[first]!)) lines[first] = `status: ${lines[first]}`;
  return lines.join(newline);
}

/** One transport namespace around the existing MkII engine; no second write gate or acceptance engine. */
export function createProfiledPlugin(profile: RuntimeProfile, assetVersion: string): OpenCodePlugin {
  return async (input, options) => {
    const operators = new OperatorRuntime(input.directory, profile);
    const selected = new Map<string, string>();
    const operatorParents = new Map<string, string>();
    const taskOwners = new Map<string, { root: string; actor: string; operator: boolean }>();
    const retired = new Set<string>();
    let control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0] | undefined;
    const nativeSession = input.client?.session as unknown as Record<string, unknown> | undefined;
    async function session(method: string, request: unknown): Promise<unknown> {
      const operation = nativeSession?.[method];
      if (typeof operation !== "function") return undefined;
      return await operation.call(nativeSession, request);
    }
    async function messages(id: string): Promise<readonly Record<string, unknown>[]> {
      const result = payload(await session("messages", { path: { id }, query: { directory: input.directory } }));
      return Array.isArray(result) ? result.filter(record) : [];
    }
    async function identity(id: string): Promise<{ role?: CanonicalAgentRole; parent?: string }> {
      const info = payload(await session("get", { path: { id }, query: { directory: input.directory } }));
      const parent = record(info) && typeof info.parentID === "string" ? info.parentID : undefined;
      let agent = selected.get(id);
      if (agent === undefined) {
        const history = await messages(id);
        for (const message of [...history].reverse()) {
          const metadata = record(message.info) ? message.info : message;
          if (metadata.role === "user" && typeof metadata.agent === "string") { agent = metadata.agent; break; }
        }
        agent ??= record(info) && typeof info.agent === "string" ? info.agent : undefined;
      }
      return { role: canonicalAgent(profile, agent), ...(parent === undefined ? {} : { parent }) };
    }
    async function rootFor(id: string, depth = 0): Promise<string | undefined> {
      if (depth > 3 || retired.has(id)) return undefined;
      const who = await identity(id);
      if (who.role === "dog-coordinator" && who.parent === undefined) return id;
      if (!who.role || !who.parent) return undefined;
      const parentRoot = await rootFor(who.parent, depth + 1);
      if (!parentRoot) return undefined;
      if (who.role === "dog-worker" || who.role === "dog-luna-worker") {
        const state = await operators.read(parentRoot);
        if (state?.units.some(unit => unit.childSessionID === id) && ["cancelled", "completed"].includes(state.phase)) return undefined;
      }
      if (who.role === "dog-operator") {
        const state = await operators.read(parentRoot);
        if (!state || state.phase === "cancelled" || state.phase === "completed") return undefined;
        if (state.operatorSessionID !== id) {
          const history = await messages(id);
          const first = history.find(message => (record(message.info) ? message.info.role : message.role) === "user");
          const prompt = Array.isArray(first?.parts) ? first.parts.filter(record)
            .filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
          await operators.bindOperator(parentRoot, id, prompt);
        }
        operatorParents.set(id, parentRoot);
      }
      return parentRoot;
    }
    function mapAgent(value: string, outward: boolean): string {
      if (outward) {
        if (value.startsWith("foreign/")) return value.slice("foreign/".length);
        return CANONICAL_AGENT_ROLES.includes(value as CanonicalAgentRole) ? profileAgent(profile, value as CanonicalAgentRole) : value;
      }
      const role = canonicalAgent(profile, value);
      if (role) return role;
      return CANONICAL_AGENT_ROLES.includes(value as CanonicalAgentRole) ? `foreign/${value}` : value;
    }
    function translate(value: unknown, outward: boolean): unknown {
      if (Array.isArray(value)) return value.map(item => translate(item, outward));
      if (!record(value)) return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if ((key === "agent" || key === "subagent_type") && typeof item === "string") return [key, mapAgent(item, outward)];
        if (!outward && (key === "parentID" || key === "parentId") && typeof item === "string") {
          return [key, operatorParents.get(item) ?? item];
        }
        if (key === "tool" && typeof item === "string") {
          if (!outward && item.startsWith(profile.toolPrefix)) return [key, `sortie_${item.slice(profile.toolPrefix.length)}`];
          if (outward && SERIAL_CAPABILITIES.has(item)) return [key, profileTool(profile, item)];
        }
        return [key, translate(item, outward)];
      }));
    }
    const client = input.client === undefined ? undefined : new Proxy(input.client, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== "session" || !record(value)) return value;
        return new Proxy(value, {
          get(group, method) {
            const operation = Reflect.get(group, method, group);
            if (typeof operation !== "function") return operation;
            return async (...args: unknown[]) => {
              const request = args[0];
              if ((method === "prompt" || method === "promptAsync") && record(request) && record(request.path) &&
                  typeof request.path.id === "string" && retired.has(request.path.id)) throw new Error("runtime-profile-revoked");
              return translate(await operation.apply(group, args.map(argument => translate(argument, true))), false);
            };
          },
        });
      },
    });
    const runtimeBridge: RuntimeBridge = {
      profile, assetVersion,
      defaultModelCatalog: { global: BUILT_IN_MODEL_CATALOG.global?.map(entry => entry.model === PREVIEW_PRIMARY_ROUTE.model
        ? { ...entry, variants: [...new Set([...(entry.variants ?? []), PREVIEW_PRIMARY_ROUTE.variant])] } : entry) },
      transformConfiguration: value => {
        if (!record(value) || !record(value.modelRouting)) return value;
        const routes: Record<string, unknown> = {};
        for (const [external, route] of Object.entries(value.modelRouting)) {
          const canonical = canonicalAgent(profile, external) ?? external;
          if (Object.hasOwn(routes, canonical)) throw new Error(`preview-model-route-collision: ${external} -> ${canonical}`);
          routes[canonical] = route;
        }
        return { ...value, modelRouting: routes };
      },
      defaultModelRouting: {
        "dog-coordinator": { preferred: PREVIEW_PRIMARY_ROUTE },
        "dog-operator": { preferred: { model: "openai/gpt-5.6-terra", variant: "high" } },
        "dog-worker": { preferred: PREVIEW_WORKER_ROUTE },
      },
      connected: value => { control = value; },
      onSerialSettlement: result => operators.settled(result),
      onRootTerminal: (root, receipt) => operators.terminal(root, receipt),
    };
    const core = await canonicalPlugin({ ...input, worktree: input.directory, client, runtimeBridge }, {
      operationManifestPath: `${profile.stateDirectory}/contracts/operation-manifest.json`,
      handoffPaths: [`${profile.stateDirectory}/contracts/handoff.json`],
      ...options,
    });
    const tools: Record<string, Tool> = {};
    async function requireRoot(id: string): Promise<void> {
      if (await rootFor(id) !== id || !await control?.isRoot(id)) throw new Error("profile-coordinator-root-required");
    }
    for (const [name, definition] of Object.entries(core.tool ?? {})) {
      if (!SERIAL_CAPABILITIES.has(name)) continue;
      tools[profileTool(profile, name)] = { ...definition,
        execute: async (args, context) => {
          const root = await rootFor(context.sessionID);
          if (!root) throw new Error("runtime-profile-session-inactive");
          if ((await identity(context.sessionID)).role === "dog-operator") throw new Error("operator-capability-denied");
          return definition.execute(args, { ...context, ...(context.agent === undefined ? {} : { agent: mapAgent(context.agent, false) }) });
        },
      };
    }
    const stringSchema = core.tool!.sortie_bind_write_gate!.args.project_root;
    const prepare = profileTool(profile, "sortie_prepare_operator");
    const next = profileTool(profile, "sortie_operator_next");
    const status = profileTool(profile, "sortie_operator_status");
    const cancel = profileTool(profile, "sortie_cancel_operator");
    async function stop(root: string, reason: string, retireRoot = true): Promise<void> {
      if (retireRoot) retired.add(root);
      if (retireRoot) await control?.stopAutomaticRecovery(root);
      const children = await operators.interrupted(root, reason);
      for (const child of children) {
        retired.add(child);
        const result = await session("abort", { path: { id: child }, query: { directory: input.directory } });
        if (result === undefined || result === false || (record(result) && result.data === false)) throw new Error("operator-child-stop-unconfirmed");
      }
      await control?.cancelChildren(root);
      if (retireRoot) await control?.stopRoot(root);
    }
    tools[prepare] = { description: "Freeze an approved serial operator plan, generate canonical immutable handoffs, and return the exact next Task. Coordinator only.",
      args: { plan_json: stringSchema }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        const state = await operators.prepare(context.sessionID, JSON.parse(args.plan_json));
        if (state.phase !== "prepared" || state.dispatched > 0) return JSON.stringify(operators.packet(state));
        control!.enableUnits(context.sessionID, state.units.length);
        return JSON.stringify({ profile: profile.id, run_id: state.runID, acceptance_fingerprint: state.acceptanceFingerprint,
          fast_path: state.units.length === 1, task: state.units.length === 1 ? state.units[0]!.task : operators.operatorTask(state) });
      } };
    tools[next] = { description: "Return the next exact admitted worker Task or a bounded decision packet. No acceptance or scope edits.",
      args: {}, execute: async (_args, context) => {
        const root = await rootFor(context.sessionID);
        if (!root) throw new Error("operator-grant-invalid");
        return JSON.stringify(await operators.next(root, context.sessionID));
      } };
    tools[status] = { description: "Read the durable root-owned operator outcome without claiming acceptance or retrying work.",
      args: {}, execute: async (_args, context) => {
        await requireRoot(context.sessionID);
        const state = await operators.read(context.sessionID);
        return JSON.stringify(state ? operators.packet(state) : { status: "absent", profile: profile.id });
      } };
    tools[cancel] = { description: "Revoke this root's operator grant and stop only its owned children before releasing core state.",
      args: {}, execute: async (_args, context) => {
        await requireRoot(context.sessionID);
        await stop(context.sessionID, "explicit-cancellation", false);
        return JSON.stringify(operators.packet(await operators.required(context.sessionID)));
      } };
    const ownTools = new Set([prepare, next, status, cancel]);
    const protocolMap = CANONICAL_AGENT_ROLES.map(role => `${role}=${profileAgent(profile, role)}`).join(", ");

    const hooks: OpenCodeHooks & { config(config: Record<string, unknown>): Promise<void> } = {
      config: async config => {
        const agents = record(config.agent) ? config.agent : undefined;
        const workerName = profileAgent(profile, "dog-worker");
        const worker = agents && record(agents[workerName]) ? agents[workerName] : undefined;
        if (worker !== undefined) Object.assign(worker, PREVIEW_WORKER_ROUTE);
      },
      tool: tools,
      "chat.message": async (chat, output) => {
        const actual = chat.agent ?? output.message.agent;
        const previous = canonicalAgent(profile, selected.get(chat.sessionID));
        if (actual !== undefined) selected.set(chat.sessionID, actual);
        const role = canonicalAgent(profile, actual);
        if (previous === "dog-coordinator" && role !== "dog-coordinator") await stop(chat.sessionID, "agent-changed");
        if (!role && previous === undefined) return;
        if (role === "dog-coordinator") {
          if (retired.has(chat.sessionID) && output.parts.some(part => record(part) && part.synthetic === true)) throw new Error("runtime-profile-revoked");
          retired.delete(chat.sessionID);
        }
        if (role === "dog-operator") {
          // The host invokes this hook before persisting the first user message.
          // Bind the actual incoming prompt against the already-admitted parent grant.
          const who = await identity(chat.sessionID);
          const root = who.parent === undefined ? undefined : await rootFor(who.parent);
          if (!root || root !== who.parent) throw new Error("operator-grant-invalid");
          const prompt = output.parts.filter(record).filter(part => part.type === "text" && typeof part.text === "string")
            .map(part => part.text).join("\n");
          const state = await operators.required(root);
          if (state.operatorSessionID !== chat.sessionID) await operators.bindOperator(root, chat.sessionID, prompt);
          operatorParents.set(chat.sessionID, root);
          if (!await rootFor(chat.sessionID)) throw new Error("operator-grant-invalid");
        }
        if (role === "dog-worker") {
          const root = await rootFor(chat.sessionID);
          const state = root ? await operators.read(root) : undefined;
          const pending = state?.units.find(unit => unit.status === "running");
          if (root && pending?.callID && output.parts.some(part => record(part) && typeof part.text === "string" && part.text.includes(pending.task.prompt))) {
            await operators.observeChild(root, pending.callID, chat.sessionID);
          }
        }
        const mapped = translate(output, false) as typeof output;
        await core["chat.message"]?.(translate(chat, false) as typeof chat, mapped);
        Object.assign(output, translate(mapped, true));
        if (actual !== undefined) output.message.agent = actual;
        if (role === "dog-coordinator" && previous !== role) {
          const packageVersion = await readFile(new URL("../../package.json", import.meta.url), "utf8")
            .then(source => String(JSON.parse(source).version)).catch(() => "unknown");
          const model = output.message.model;
          const log = input.client?.app?.log;
          if (log) void Promise.resolve(log.call(input.client!.app, { body: {
            service: `sortie-dogs-${profile.id}`, level: "info", message: "runtime.profile-selected",
            extra: { sessionID: chat.sessionID, profile: profile.id, packageVersion, runtimeMarker: assetVersion,
              agent: actual, model: `${model.providerID}/${model.modelID}` },
          }, query: { directory: input.directory } })).catch(() => undefined);
        }
      },
      "tool.execute.before": async (request, output) => {
        const who = await identity(request.sessionID);
        if (!who.role) {
          if (request.tool.startsWith(profile.toolPrefix)) throw new Error("runtime-profile-session-inactive");
          return;
        }
        const root = await rootFor(request.sessionID);
        if (!root) throw new Error("runtime-profile-session-inactive");
        if (request.tool.startsWith("sortie_") && !request.tool.startsWith(profile.toolPrefix)) throw new Error("runtime-profile-tool-mismatch");
        if (ownTools.has(request.tool)) return;
        const args = record(output.args) ? output.args : {};
        if (who.role === "dog-operator" && request.tool === "read") {
          if (typeof args.filePath !== "string") throw new Error("operator-read-path-required");
          const path = resolve(input.directory, args.filePath);
          const state = await operators.required(root);
          const permitted = state.units.flatMap(unit => [...unit.unit.read, ...unit.unit.write, unit.handoffPath, unit.manifestPath]);
          if (!permitted.some(scope => {
            const rest = relative(resolve(input.directory, scope), path);
            return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !rest.startsWith(sep) && !/^[A-Za-z]:/.test(rest));
          })) throw new Error("operator-read-scope-denied");
          return;
        }
        if (who.role === "dog-operator" && !["task", "todowrite", "todoread"].includes(request.tool)) throw new Error("operator-readonly-control-role");
        if (request.tool === "task" && args.subagent_type === profileAgent(profile, "dog-operator")) {
          await requireRoot(request.sessionID);
          await operators.admitOperator(root, request.callID, args);
          taskOwners.set(request.callID, { root, actor: request.sessionID, operator: true });
          return;
        }
        const state = await operators.read(root);
        const delegated = request.tool === "task" && args.subagent_type === profileAgent(profile, "dog-worker") &&
          state !== undefined && ["prepared", "running"].includes(state.phase);
        if (who.role === "dog-operator" && request.tool === "task" && !delegated) throw new Error("operator-worker-task-required");
        if (delegated) {
          await operators.admitWorker(root, request.sessionID, request.callID, args);
          taskOwners.set(request.callID, { root, actor: request.sessionID, operator: false });
        }
        const mapped = translate(output, false) as typeof output;
        try {
          await core["tool.execute.before"]?.({ ...translate(request, false) as typeof request,
            ...(delegated ? { sessionID: root, agent: "dog-coordinator" } : {}) }, mapped);
          if (delegated && (await operators.required(root)).phase !== "running") throw new Error("operator-grant-revoked");
          Object.assign(output, translate(mapped, true));
        } catch (error) {
          if (delegated) { taskOwners.delete(request.callID); await operators.rejectedAdmission(root, request.callID); }
          throw error;
        }
      },
      "tool.execute.after": async (request, output) => {
        const id = request.sessionID;
        if (!id) return;
        const ownership = request.callID === undefined ? undefined : taskOwners.get(request.callID);
        if (ownership?.operator) {
          const state = await operators.operatorReturned(ownership.root);
          output.output = JSON.stringify(operators.packet(state));
          taskOwners.delete(request.callID!);
          return;
        }
        if ((!ownership && !await rootFor(id)) || ownTools.has(request.tool)) return;
        const mapped = translate(output, false) as typeof output;
        await core["tool.execute.after"]?.({ ...translate(request, false) as typeof request,
          ...(ownership ? { sessionID: ownership.root } : {}) }, mapped);
        Object.assign(output, translate(mapped, true));
        if (ownership) {
          const child = taskChildSessionID(output);
          if (child) await operators.observeChild(ownership.root, request.callID!, child);
          output.output = JSON.stringify(operators.packet(await operators.required(ownership.root)));
          taskOwners.delete(request.callID!);
        }
      },
      "permission.ask": async (request, output) => {
        if (!request.sessionID || !await rootFor(request.sessionID)) return;
        if ((await identity(request.sessionID)).role === "dog-operator" && request.permission === "edit") { output.status = "deny"; return; }
        await core["permission.ask"]?.(request, output);
      },
      "experimental.chat.system.transform": async (request, output) => {
        const root = await rootFor(request.sessionID);
        if (!root) return;
        await core["experimental.chat.system.transform"]?.(request, output);
        (output.system ??= []).push(`SORTIE_RUNTIME_PROFILE ${profile.id}; marker ${assetVersion}. ` +
          `Shared MkII protocol role names are logical: ${protocolMap}. Use only ${profile.toolPrefix} tools for this profile. ` +
          "Never rewrite user acceptance or evidence to rename protocol roles. Final acceptance belongs only to the root coordinator.");
      },
      "experimental.text.complete": async (request, output) => {
        const role = (await identity(request.sessionID)).role;
        if (role === "dog-operator" || !await rootFor(request.sessionID)) return;
        const mapped = { text: role === "dog-coordinator" ? forwardTerminalText(output.text) : output.text };
        await core["experimental.text.complete"]?.(request, mapped);
        output.text = mapped.text;
      },
      "experimental.session.compacting": async (request, output) => {
        const root = await rootFor(request.sessionID);
        if (!root) return;
        if ((await identity(request.sessionID)).role === "dog-operator") {
          const state = await operators.required(root);
          (output.context ??= []).push(`Operator continuation: root=${root}; run=${state.runID}; generation=${state.generation}; contract=${state.planHash}. ` +
            `Read ${next} for current authoritative state. Do not reconstruct acceptance or reset the queue.`);
          return;
        }
        await core["experimental.session.compacting"]?.(request, output);
      },
      "experimental.compaction.autocontinue": async (request, output) => {
        if (!await rootFor(request.sessionID)) return;
        if ((await identity(request.sessionID)).role === "dog-operator") { output.enabled = false; return; }
        await core["experimental.compaction.autocontinue"]?.(request, output);
      },
      event: async ({ event }) => {
        const properties = event.properties ?? {};
        const info = record(properties.info) ? properties.info : undefined;
        const part = record(properties.part) ? properties.part : undefined;
        const id = typeof properties.sessionID === "string" ? properties.sessionID
          : typeof info?.sessionID === "string" ? info.sessionID
            : typeof part?.sessionID === "string" ? part.sessionID
              : event.type.startsWith("session.") && typeof info?.id === "string" ? info.id : undefined;
        if (!id) return;
        if (event.type === "session.deleted" && canonicalAgent(profile, selected.get(id)) === "dog-coordinator") {
          await stop(id, "session-deleted");
          return;
        }
        if (!await rootFor(id)) return;
        const mappedEvent = translate({ event }, false) as { event: typeof event };
        const mappedPart = record(mappedEvent.event.properties?.part) ? mappedEvent.event.properties.part : undefined;
        if ((await identity(id)).role === "dog-coordinator" && mappedPart?.type === "text" && typeof mappedPart.text === "string") {
          mappedPart.text = forwardTerminalText(mappedPart.text);
        }
        await core.event?.(mappedEvent);
        if (event.type === "message.part.updated" && part?.type === "tool" && part.tool === "task" &&
          typeof part.callID === "string" && record(part.state) && part.state.status === "error") {
          const ownership = taskOwners.get(part.callID);
          if (ownership !== undefined && ownership.actor === id) {
            const settled = ownership.operator
              ? (await operators.operatorRejected(ownership.root), true)
              : await control?.settleRejectedDispatch(ownership.root, part.callID) ?? false;
            if (settled) taskOwners.delete(part.callID);
          }
        }
      },
    };
    return hooks;
  };
}

export const SortieDogsV010Plugin: OpenCodePlugin = createProfiledPlugin(V010_RUNTIME_PROFILE, V010_RUNTIME_ASSET_VERSION);
