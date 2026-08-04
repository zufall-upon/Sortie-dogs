import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { RelativePathError } from "../core/path.js";
import type { OperationManifest } from "../core/types.js";
import { validateManifest } from "../core/validate-manifest.js";
import { validateHandoffSchema, validateOperationManifestSchema } from "../core/validate-schema.js";
import {
  resolvePluginConfigurationSources,
  type ConfiguredPluginSources,
  type SortieDogsPluginOptions,
} from "./config.js";
import {
  WriteDeniedError,
  createProjectPaths,
  createWriteGate,
  isKnownReadOnlyTool,
  resolveProjectRoot,
  safePath,
  type ProjectPaths,
  type ToolExecuteBeforeInput,
  type ToolExecuteBeforeOutput,
  type WriteGate,
} from "./gate.js";
import {
  createModelRoutingHook,
  type OpenCodeChatMessageHook,
} from "./model-routing-hook.js";

const INPUT_LIMITS = { config: 64 * 1024, manifest: 512 * 1024, handoff: 2 * 1024 * 1024 } as const;
const INSPECTION_CACHE = { maximum: 256, ttlMilliseconds: 30 * 60 * 1000 } as const;
const SESSION_DENIAL_LIMIT = 256;
const PROJECT_CONFIG_PATH = ".opencode/sortie-dogs.json";
const ENV_CONFIG = "SORTIE_DOGS_CONFIG";
const COORDINATOR_AGENT = "dog-coordinator";
const SORTIE_TRIGGER = /^\/sortie(?:\s|$)/;

export interface OpenCodePluginInput {
  directory: string;
  worktree?: string;
  [key: string]: unknown;
}

export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface OpenCodeHooks {
  event?: (input: { event: OpenCodeEvent }) => Promise<void>;
  "permission.ask"?: (
    input: { permission: string; patterns: string[]; sessionID?: string },
    output: { status: "ask" | "deny" | "allow" },
  ) => Promise<void>;
  "tool.execute.before"?: (
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ) => Promise<void>;
  "chat.message"?: OpenCodeChatMessageHook;
  tool?: Record<string, OpenCodeToolDefinition>;
}

export type OpenCodePlugin = (
  input: OpenCodePluginInput,
  options?: SortieDogsPluginOptions | Record<string, unknown>,
) => Promise<OpenCodeHooks>;

export type HandoffDenialReason =
  | "configuration-unavailable"
  | "path-invalid"
  | "input-unavailable"
  | "schema-invalid"
  | "contract-invalid";

export class HandoffDeniedError extends Error {
  readonly reason: HandoffDenialReason;

  constructor(reason: HandoffDenialReason, path: string, options?: ErrorOptions) {
    super(`Handoff denied for "${safePath(path)}": handoff and operation manifest contract.`, options);
    this.name = "HandoffDeniedError";
    this.reason = reason;
  }
}

class PluginInputError extends Error {
  readonly reason: "not-file" | "too-large" | "read-failed" | "invalid-json";

  constructor(reason: PluginInputError["reason"], options?: ErrorOptions) {
    super("Plugin input unavailable.", options);
    this.name = "PluginInputError";
    this.reason = reason;
  }
}

interface LoadedConfiguration {
  gate?: WriteGate;
  manifest?: OperationManifest;
  operationManifestPath: string;
  operationManifestAbsolutePath?: string;
  manifestFingerprint?: string;
  handoffPaths: readonly string[];
  modelRoutingHook?: OpenCodeChatMessageHook;
}

interface InspectionCacheEntry {
  fingerprint: string;
  expiresAt: number;
  handoffPath: string;
  manifestPath: string;
  projectRoot: string;
}

interface SessionAuthorization {
  gate: WriteGate;
  expiresAt: number;
  manifestHash: string;
  manifestMtimeMs: number;
  manifestPath: string;
}

interface ActiveSessionState {
  deniedSignatures: Set<string>;
  expiresAt: number;
}

interface OpenCodeToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute(args: Record<string, string>, context: { sessionID: string }): Promise<string>;
}

interface OpenCodeToolFactory {
  (definition: OpenCodeToolDefinition): OpenCodeToolDefinition;
  schema: { string(): unknown };
}

interface PinnedJson {
  value: unknown;
  hash: string;
  mtimeMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(path: string, limit: number): Promise<unknown> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new PluginInputError("read-failed", { cause: error });
  }
  if (!metadata.isFile()) throw new PluginInputError("not-file");
  if (metadata.size > limit) throw new PluginInputError("too-large");

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new PluginInputError("read-failed", { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new PluginInputError("invalid-json", { cause: error });
  }
}

async function readPinnedJson(path: string, limit: number): Promise<PinnedJson> {
  const before = await stat(path).catch((error: unknown) => {
    throw new PluginInputError("read-failed", { cause: error });
  });
  if (!before.isFile()) throw new PluginInputError("not-file");
  if (before.size > limit) throw new PluginInputError("too-large");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new PluginInputError("read-failed", { cause: error });
  }
  const after = await stat(path).catch((error: unknown) => {
    throw new PluginInputError("read-failed", { cause: error });
  });
  const beforeMtimeMs = Math.trunc(before.mtimeMs);
  const afterMtimeMs = Math.trunc(after.mtimeMs);
  if (!after.isFile() || before.size !== after.size || beforeMtimeMs !== afterMtimeMs) {
    throw new PluginInputError("read-failed");
  }
  try {
    return {
      value: JSON.parse(source),
      hash: createHash("sha256").update(source).digest("hex"),
      mtimeMs: afterMtimeMs,
    };
  } catch (error) {
    throw new PluginInputError("invalid-json", { cause: error });
  }
}

async function readOptionalProjectConfig(project: ProjectPaths): Promise<unknown> {
  const path = project.absolute(PROJECT_CONFIG_PATH);
  try {
    return await readJson(path, INPUT_LIMITS.config);
  } catch (error) {
    if (
      error instanceof PluginInputError &&
      error.reason === "read-failed" &&
      isRecord(error.cause) &&
      error.cause.code === "ENOENT"
    ) return undefined;
    throw error;
  }
}

function readEnvironmentConfig(): unknown {
  const source = process.env[ENV_CONFIG];
  if (source === undefined || source.length === 0) return undefined;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new PluginInputError("invalid-json", { cause: error });
  }
}

function loadConfigured(
  config: ConfiguredPluginSources,
  handoffBase: string,
): LoadedConfiguration {
  const handoffPaths = config.handoffPaths.map((path) => resolve(handoffBase, path));
  const hasModelRouting = Object.keys(config.localModelRouting).length > 0 ||
    Object.keys(config.globalModelRouting).length > 0;
  const modelRoutingHook = hasModelRouting
    ? createModelRoutingHook({
      local: config.localModelRouting,
      global: config.globalModelRouting,
      catalog: config.modelCatalog,
    })
    : undefined;
  return {
    operationManifestPath: config.operationManifestPath,
    handoffPaths,
    modelRoutingHook,
  };
}

function textPart(part: unknown): string | undefined {
  return isRecord(part) && typeof part.text === "string" ? part.text : undefined;
}

function activatesSession(input: Parameters<OpenCodeChatMessageHook>[0], output: Parameters<OpenCodeChatMessageHook>[1]): boolean {
  if (input.agent === COORDINATOR_AGENT || output.message.agent === COORDINATOR_AGENT) return true;
  return output.parts.some((part) => {
    const text = textPart(part);
    return text !== undefined && SORTIE_TRIGGER.test(text);
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function inspectionFingerprint(handoff: unknown, diagnostics: unknown, manifest?: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([stableValue(handoff), stableValue(manifest), stableValue(diagnostics)]))
    .digest("hex");
}

function normalizeCommand(command: string): string {
  let quote: "\"" | "'" | undefined;
  let whitespace = false;
  let normalized = "";
  for (const character of command.trim()) {
    if (quote !== undefined) {
      normalized += character;
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      if (whitespace && normalized.length > 0) normalized += " ";
      whitespace = false;
      quote = character;
      normalized += character;
    } else if (/\s/u.test(character)) {
      whitespace = true;
    } else {
      if (whitespace && normalized.length > 0) normalized += " ";
      whitespace = false;
      normalized += character;
    }
  }
  return normalized;
}

function denialSignature(
  input: ToolExecuteBeforeInput,
  output: ToolExecuteBeforeOutput,
  reason: string,
): string {
  const command = isRecord(output.args) && typeof output.args.command === "string"
    ? normalizeCommand(output.args.command)
    : JSON.stringify(stableValue(output.args));
  return createHash("sha256")
    .update(JSON.stringify([input.tool.toLowerCase(), command, reason]))
    .digest("hex");
}

function pruneInspectionCache(
  cache: Map<string, InspectionCacheEntry>,
  now: number,
  reserveSlot = false,
): void {
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  const limit = INSPECTION_CACHE.maximum - (reserveSlot ? 1 : 0);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

function pruneSessionAuthorizations(cache: Map<string, SessionAuthorization>, now: number): void {
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size >= INSPECTION_CACHE.maximum) cache.delete(cache.keys().next().value!);
}

/** Named OpenCode plugin export. Importing the package has no side effects; invoking it installs active gates. */
export const SortieDogsPlugin: OpenCodePlugin = async (input, options) => {
  const pluginModuleName = "@opencode-ai/plugin";
  const pluginModule = await import(pluginModuleName).catch(() => undefined) as
    | { tool?: OpenCodeToolFactory }
    | undefined;
  const toolCandidate = pluginModule?.tool as unknown;
  const toolSchema = typeof toolCandidate === "function"
    ? (toolCandidate as unknown as { schema?: unknown }).schema
    : undefined;
  const validToolCandidate = typeof toolCandidate === "function" &&
    isRecord(toolSchema) && typeof toolSchema.string === "function";
  const defineTool: OpenCodeToolFactory = validToolCandidate
    ? toolCandidate as OpenCodeToolFactory
    : Object.assign(
    (definition: OpenCodeToolDefinition) => definition,
    { schema: { string: () => ({ type: "string" }) } },
  );
  let project: ProjectPaths | undefined;
  let loaded: LoadedConfiguration | undefined;
  let loadFailure: unknown;
  let loading: Promise<void> | undefined;

  async function ensureLoaded(): Promise<void> {
    if (loaded?.gate !== undefined) return;
    if (loading !== undefined) return loading;
    loading = (async () => {
      try {
        project ??= await createProjectPaths(resolveProjectRoot(input));
        const projectConfig = await readOptionalProjectConfig(project);
        const environmentConfig = readEnvironmentConfig();
        const parsed = resolvePluginConfigurationSources(projectConfig, environmentConfig, options);
        if (parsed.kind === "invalid") throw new WriteDeniedError("manifest-unavailable", "<unknown>");
        loaded = loadConfigured(parsed, input.worktree ?? project.root);
        const manifestPath = await project.toRelativePath(loaded.operationManifestPath);
        loaded.operationManifestAbsolutePath = project.absolute(manifestPath);
        const manifestValue = await readJson(loaded.operationManifestAbsolutePath, INPUT_LIMITS.manifest);
        const validation = validateOperationManifestSchema(manifestValue);
        if (!validation.ok) throw new WriteDeniedError("manifest-unavailable", "<unknown>");
        loaded.manifest = validation.value;
        loaded.manifestFingerprint = inspectionFingerprint(validation.value, undefined);
        loaded.gate = await createWriteGate(project, validation.value);
        loadFailure = undefined;
      } catch (error) {
        loadFailure = error;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }

  const inspected = new Map<string, InspectionCacheEntry>();
  const sessionAuthorizations = new Map<string, SessionAuthorization>();
  const activeSessions = new Map<string, ActiveSessionState>();

  async function inspect(path: string, sessionID: string | undefined): Promise<void> {
    await ensureLoaded();
    if (loaded === undefined || project === undefined) {
      throw new HandoffDeniedError("configuration-unavailable", path, { cause: loadFailure });
    }
    const absolutePath = isAbsolute(path)
      ? resolve(path)
      : resolve(input.worktree ?? project.root, path);
    if (!loaded.handoffPaths.includes(absolutePath)) return;
    const key = sessionID === undefined ? undefined : `${sessionID}\u0000${absolutePath}`;
    if (key !== undefined) inspected.delete(key);
    let value: unknown;
    try {
      value = await readJson(absolutePath, INPUT_LIMITS.handoff);
    } catch (error) {
      if (error instanceof PluginInputError) {
        throw new HandoffDeniedError("input-unavailable", path, { cause: error });
      }
      throw error;
    }
    const validation = validateHandoffSchema(value);
    if (!validation.ok) throw new HandoffDeniedError("schema-invalid", path);

    let authorizationGate: WriteGate;
    let manifestPath: string;
    let manifest: OperationManifest;
    let inspectedProjectRoot: string;
    const extension = validation.value.ext?.["sortie-dogs/write-gate"];
    if (extension === undefined) {
      if (
        loaded.manifest === undefined || loaded.gate === undefined ||
        loaded.operationManifestAbsolutePath === undefined
      ) {
        throw new HandoffDeniedError("configuration-unavailable", path, { cause: loadFailure });
      }
      try {
        await project.toRelativePath(absolutePath);
      } catch (error) {
        if (error instanceof WriteDeniedError || error instanceof RelativePathError) {
          throw new HandoffDeniedError("path-invalid", path, { cause: error });
        }
        throw error;
      }
      manifest = loaded.manifest;
      authorizationGate = loaded.gate;
      manifestPath = loaded.operationManifestAbsolutePath;
      inspectedProjectRoot = project.root;
    } else {
      if (
        !isRecord(extension) ||
        Object.keys(extension).some((key) => key !== "operation_manifest" && key !== "project_root") ||
        typeof extension.operation_manifest !== "string" || extension.operation_manifest.length === 0 ||
        typeof extension.project_root !== "string" || !isAbsolute(extension.project_root) ||
        isAbsolute(extension.operation_manifest)
      ) throw new HandoffDeniedError("contract-invalid", path);
      try {
        const allowedRoots = [project];
        if (input.worktree !== undefined && resolve(input.worktree) !== project.root) {
          allowedRoots.push(await createProjectPaths(resolve(input.worktree)));
        }
        const containment = await Promise.all(
          allowedRoots.map((allowedRoot) => allowedRoot.contains(extension.project_root as string)),
        );
        if (!containment.some(Boolean)) throw new WriteDeniedError("project-boundary", "<candidate-root>");
        const candidateProject = await createProjectPaths(extension.project_root);
        await candidateProject.toRelativePath(absolutePath);
        const relativeManifestPath = await candidateProject.toRelativePath(extension.operation_manifest);
        manifestPath = candidateProject.absolute(relativeManifestPath);
        const manifestValue = await readJson(manifestPath, INPUT_LIMITS.manifest);
        const manifestValidation = validateOperationManifestSchema(manifestValue);
        if (!manifestValidation.ok) throw new WriteDeniedError("manifest-unavailable", "<unknown>");
        manifest = manifestValidation.value;
        authorizationGate = await createWriteGate(candidateProject, manifest);
        inspectedProjectRoot = candidateProject.root;
      } catch (error) {
        throw new HandoffDeniedError("contract-invalid", path, { cause: error });
      }
    }
    const diagnostics = validateManifest(validation.value, manifest, undefined, false);
    if (diagnostics.some(({ severity }) => severity === "error")) {
      throw new HandoffDeniedError("contract-invalid", path);
    }

    const fingerprint = inspectionFingerprint(validation.value, diagnostics, manifest);
    if (sessionID === undefined) return;
    const now = Date.now();
    pruneInspectionCache(inspected, now, true);
    inspected.set(key!, {
      fingerprint,
      expiresAt: now + INSPECTION_CACHE.ttlMilliseconds,
      handoffPath: absolutePath,
      manifestPath,
      projectRoot: inspectedProjectRoot,
    });
    pruneSessionAuthorizations(sessionAuthorizations, now);
  }

  async function bindWriteGate(
    sessionID: string,
    projectRoot: string,
    manifestPathArgument: string,
  ): Promise<string> {
    const deny = (reason: string): string => JSON.stringify({ status: "denied", reason });
    try {
      if (!isActiveSession(sessionID)) return deny("session-inactive");
      const now = Date.now();
      pruneSessionAuthorizations(sessionAuthorizations, now);
      if (sessionAuthorizations.has(sessionID)) return deny("binding-replay");
      if (!isAbsolute(projectRoot) || isAbsolute(manifestPathArgument)) return deny("path-invalid");

      project ??= await createProjectPaths(resolveProjectRoot(input));
      const allowedRoots = [project];
      if (input.worktree !== undefined && resolve(input.worktree) !== project.root) {
        allowedRoots.push(await createProjectPaths(resolve(input.worktree)));
      }
      const containment = await Promise.all(allowedRoots.map((root) => root.contains(projectRoot)));
      if (!containment.some(Boolean)) return deny("project-boundary");

      const candidate = await createProjectPaths(projectRoot);
      const relativeManifestPath = await candidate.toRelativePath(manifestPathArgument);
      const manifestPath = candidate.absolute(relativeManifestPath);
      const pinned = await readPinnedJson(manifestPath, INPUT_LIMITS.manifest);
      const validation = validateOperationManifestSchema(pinned.value);
      if (!validation.ok) return deny("manifest-invalid");
      pruneInspectionCache(inspected, now);
      const inspectedEntry = [...inspected.entries()].find(([key, entry]) =>
        key.startsWith(`${sessionID}\u0000`) &&
        entry.projectRoot === candidate.root && entry.manifestPath === manifestPath
      )?.[1];
      if (inspectedEntry === undefined) return deny("handoff-uninspected");
      const handoffValue = await readJson(inspectedEntry.handoffPath, INPUT_LIMITS.handoff);
      const handoffValidation = validateHandoffSchema(handoffValue);
      if (!handoffValidation.ok) return deny("handoff-mismatch");
      const diagnostics = validateManifest(handoffValidation.value, validation.value, undefined, false);
      if (
        diagnostics.some(({ severity }) => severity === "error") ||
        inspectionFingerprint(handoffValidation.value, diagnostics, validation.value) !== inspectedEntry.fingerprint
      ) return deny("handoff-mismatch");
      const gate = await createWriteGate(candidate, validation.value);
      sessionAuthorizations.set(sessionID, {
        gate,
        expiresAt: now + INSPECTION_CACHE.ttlMilliseconds,
        manifestHash: pinned.hash,
        manifestMtimeMs: pinned.mtimeMs,
        manifestPath,
      });
      return JSON.stringify({
        status: "bound",
        manifest_hash: pinned.hash,
        manifest_path: relativeManifestPath,
      });
    } catch (error) {
      if (error instanceof RelativePathError || error instanceof WriteDeniedError) {
        return deny(error.reason === "project-boundary" ? "project-boundary" : "manifest-invalid");
      }
      if (error instanceof PluginInputError) return deny("manifest-unavailable");
      return deny("binding-failed");
    }
  }

  async function sessionGate(sessionID: string | undefined): Promise<WriteGate | undefined> {
    const now = Date.now();
    pruneSessionAuthorizations(sessionAuthorizations, now);
    if (sessionID === undefined) return undefined;
    const authorization = sessionAuthorizations.get(sessionID);
    if (authorization === undefined) return undefined;
    try {
      const pinned = await readPinnedJson(authorization.manifestPath, INPUT_LIMITS.manifest);
      const manifestValidation = validateOperationManifestSchema(pinned.value);
      if (!manifestValidation.ok) throw new Error("manifest-invalid");
      if (pinned.hash !== authorization.manifestHash || pinned.mtimeMs !== authorization.manifestMtimeMs) {
        throw new Error("authorization-stale");
      }
      return authorization.gate;
    } catch {
      sessionAuthorizations.delete(sessionID);
      return undefined;
    }
  }

  async function authorizedGate(sessionID: string): Promise<WriteGate | undefined> {
    return await sessionGate(sessionID);
  }

  function pruneActiveSessions(now: number, reserveSlot = false): void {
    for (const [sessionID, state] of activeSessions) {
      if (state.expiresAt <= now) evictSession(sessionID);
    }
    const limit = INSPECTION_CACHE.maximum - (reserveSlot ? 1 : 0);
    while (activeSessions.size > limit) evictSession(activeSessions.keys().next().value!);
  }

  function activateSession(sessionID: string): void {
    const now = Date.now();
    pruneActiveSessions(now);
    const existing = activeSessions.get(sessionID);
    if (existing !== undefined) activeSessions.delete(sessionID);
    else pruneActiveSessions(now, true);
    activeSessions.set(sessionID, {
      deniedSignatures: existing?.deniedSignatures ?? new Set<string>(),
      expiresAt: now + INSPECTION_CACHE.ttlMilliseconds,
    });
  }

  function isActiveSession(sessionID: string): boolean {
    pruneActiveSessions(Date.now());
    return activeSessions.has(sessionID);
  }

  function evictSession(sessionID: string): void {
    activeSessions.delete(sessionID);
    sessionAuthorizations.delete(sessionID);
    for (const key of inspected.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) inspected.delete(key);
    }
  }

  return {
    tool: {
      sortie_bind_write_gate: defineTool({
        description: "Bind this active session to one project-relative operation manifest without changing files.",
        args: {
          project_root: defineTool.schema.string(),
          manifest_path: defineTool.schema.string(),
        },
        async execute(args, context): Promise<string> {
          return await bindWriteGate(context.sessionID, args.project_root, args.manifest_path);
        },
      }),
    },
    "chat.message": async (chatInput, output): Promise<void> => {
      if (activatesSession(chatInput, output)) activateSession(chatInput.sessionID);
      if (!isActiveSession(chatInput.sessionID)) return;
      await ensureLoaded();
      await loaded?.modelRoutingHook?.(chatInput, output);
    },
    "permission.ask": async (permission): Promise<void> => {
      if (permission.permission !== "edit") return;
      if (permission.sessionID !== undefined && !isActiveSession(permission.sessionID)) return;
      const gate = permission.sessionID === undefined ? undefined : await authorizedGate(permission.sessionID);
      if (gate === undefined) {
        throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: loadFailure });
      }
      for (const pattern of permission.patterns) {
        const path = isAbsolute(pattern)
          ? pattern
          : resolve(input.worktree ?? input.directory, pattern);
        await gate.checkPath(path);
      }
    },
    "tool.execute.before": async (toolInput, output): Promise<void> => {
      if (!isActiveSession(toolInput.sessionID)) return;
      if (toolInput.tool === "sortie_bind_write_gate") return;
      try {
        const gate = await authorizedGate(toolInput.sessionID);
        if (gate === undefined) {
          if (!isKnownReadOnlyTool(toolInput.tool, output.args)) {
            throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: loadFailure });
          }
          return;
        }
        await gate.check(toolInput, output);
      } catch (error) {
        if (!(error instanceof WriteDeniedError) || error.reason === "repeated-denial") throw error;
        const signature = denialSignature(toolInput, output, error.reason);
        const activeSession = activeSessions.get(toolInput.sessionID);
        if (activeSession === undefined) throw error;
        const denied = activeSession.deniedSignatures;
        if (denied.has(signature)) {
          throw new WriteDeniedError("repeated-denial", "<unknown>", { cause: error });
        }
        if (denied.size >= SESSION_DENIAL_LIMIT) denied.delete(denied.values().next().value!);
        denied.add(signature);
        throw error;
      }
    },
    event: async ({ event }): Promise<void> => {
      const eventSessionID = typeof event.properties?.sessionID === "string"
        ? event.properties.sessionID
        : undefined;
      if (eventSessionID === undefined || !isActiveSession(eventSessionID)) return;
      if (event.type === "file.edited" && typeof event.properties?.file === "string") {
        try {
          await inspect(event.properties.file, eventSessionID);
        } catch {
          sessionAuthorizations.delete(eventSessionID);
        }
      } else if (event.type === "session.idle" && eventSessionID !== undefined) {
        try {
          await ensureLoaded();
          if (loaded === undefined) {
            throw new HandoffDeniedError("configuration-unavailable", "<unknown>", { cause: loadFailure });
          }
          for (const path of loaded.handoffPaths) await inspect(path, eventSessionID);
        } catch {
          sessionAuthorizations.delete(eventSessionID);
        }
      } else if (event.type === "session.deleted") {
        evictSession(eventSessionID);
      }
    },
  };
};

export type { SortieDogsPluginOptions } from "./config.js";
export { InvalidModelTargetError, ModelRoutingDeniedError } from "./model-routing-hook.js";
