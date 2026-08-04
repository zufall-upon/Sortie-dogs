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
  extractWritePaths,
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
}

interface SessionAuthorization {
  gate: WriteGate;
  contractFingerprint: string;
  expiresAt: number;
  handoffPath: string;
  manifestPath: string;
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

function inspectionFingerprint(handoff: unknown, diagnostics: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([stableValue(handoff), stableValue(diagnostics)]))
    .digest("hex");
}

function pruneInspectionCache(cache: Map<string, InspectionCacheEntry>, now: number): void {
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size >= INSPECTION_CACHE.maximum) cache.delete(cache.keys().next().value!);
}

function pruneSessionAuthorizations(cache: Map<string, SessionAuthorization>, now: number): void {
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size >= INSPECTION_CACHE.maximum) cache.delete(cache.keys().next().value!);
}

/** Named OpenCode plugin export. Importing the package has no side effects; invoking it installs active gates. */
export const SortieDogsPlugin: OpenCodePlugin = async (input, options) => {
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
  const handoffBoundSessions = new Set<string>();
  const activeSessions = new Set<string>();
  let loadedGateRefresh: Promise<WriteGate | undefined> | undefined;

  async function inspect(path: string, sessionID: string | undefined): Promise<void> {
    await ensureLoaded();
    if (loaded === undefined || project === undefined) {
      throw new HandoffDeniedError("configuration-unavailable", path, { cause: loadFailure });
    }
    const absolutePath = isAbsolute(path)
      ? resolve(path)
      : resolve(input.worktree ?? project.root, path);
    if (!loaded.handoffPaths.includes(absolutePath)) return;
    if (sessionID !== undefined) {
      handoffBoundSessions.add(sessionID);
      sessionAuthorizations.delete(sessionID);
    }

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
      } catch (error) {
        throw new HandoffDeniedError("contract-invalid", path, { cause: error });
      }
    }
    const diagnostics = validateManifest(validation.value, manifest, undefined, false);
    if (diagnostics.some(({ severity }) => severity === "error")) {
      throw new HandoffDeniedError("contract-invalid", path);
    }

    const fingerprint = inspectionFingerprint(validation.value, diagnostics);
    if (sessionID === undefined) return;
    const key = `${sessionID}\u0000${absolutePath}`;
    const now = Date.now();
    pruneInspectionCache(inspected, now);
    inspected.delete(key);
    inspected.set(key, { fingerprint, expiresAt: now + INSPECTION_CACHE.ttlMilliseconds });
    pruneSessionAuthorizations(sessionAuthorizations, now);
    sessionAuthorizations.set(sessionID, {
      gate: authorizationGate,
      contractFingerprint: inspectionFingerprint(validation.value, manifest),
      expiresAt: now + INSPECTION_CACHE.ttlMilliseconds,
      handoffPath: absolutePath,
      manifestPath,
    });
  }

  async function sessionGate(sessionID: string | undefined): Promise<WriteGate | undefined> {
    const now = Date.now();
    pruneSessionAuthorizations(sessionAuthorizations, now);
    if (sessionID === undefined) return undefined;
    const authorization = sessionAuthorizations.get(sessionID);
    if (authorization === undefined) return undefined;
    try {
      const handoffValue = await readJson(authorization.handoffPath, INPUT_LIMITS.handoff);
      const handoffValidation = validateHandoffSchema(handoffValue);
      if (!handoffValidation.ok) throw new Error("handoff-invalid");
      const manifestValue = await readJson(authorization.manifestPath, INPUT_LIMITS.manifest);
      const manifestValidation = validateOperationManifestSchema(manifestValue);
      if (!manifestValidation.ok) throw new Error("manifest-invalid");
      if (inspectionFingerprint(handoffValidation.value, manifestValidation.value) !== authorization.contractFingerprint) {
        throw new Error("authorization-stale");
      }
      return authorization.gate;
    } catch {
      sessionAuthorizations.delete(sessionID);
      return undefined;
    }
  }

  async function loadedGate(): Promise<WriteGate | undefined> {
    if (loadedGateRefresh !== undefined) return loadedGateRefresh;
    const refresh = (async (): Promise<WriteGate | undefined> => {
      await ensureLoaded();
      if (
        loaded?.gate === undefined || loaded.manifestFingerprint === undefined ||
        loaded.operationManifestAbsolutePath === undefined || project === undefined
      ) return undefined;
      try {
        const manifestValue = await readJson(loaded.operationManifestAbsolutePath, INPUT_LIMITS.manifest);
        const validation = validateOperationManifestSchema(manifestValue);
        if (!validation.ok) throw new WriteDeniedError("manifest-unavailable", "<unknown>");
        const fingerprint = inspectionFingerprint(validation.value, undefined);
        if (fingerprint !== loaded.manifestFingerprint) {
          const gate = await createWriteGate(project, validation.value);
          loaded.manifest = validation.value;
          loaded.manifestFingerprint = fingerprint;
          loaded.gate = gate;
        }
        return loaded.gate;
      } catch (error) {
        loaded.gate = undefined;
        loaded.manifest = undefined;
        loaded.manifestFingerprint = undefined;
        loadFailure = error;
        return undefined;
      }
    })();
    loadedGateRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (loadedGateRefresh === refresh) loadedGateRefresh = undefined;
    }
  }

  async function authorizedGate(sessionID: string): Promise<WriteGate | undefined> {
    const boundGate = await sessionGate(sessionID);
    if (boundGate !== undefined || handoffBoundSessions.has(sessionID)) return boundGate;
    return await loadedGate();
  }

  function evictSession(sessionID: string): void {
    activeSessions.delete(sessionID);
    handoffBoundSessions.delete(sessionID);
    sessionAuthorizations.delete(sessionID);
    for (const key of inspected.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) inspected.delete(key);
    }
  }

  return {
    "chat.message": async (chatInput, output): Promise<void> => {
      if (activatesSession(chatInput, output)) activeSessions.add(chatInput.sessionID);
      if (!activeSessions.has(chatInput.sessionID)) return;
      await ensureLoaded();
      await loaded?.modelRoutingHook?.(chatInput, output);
    },
    "permission.ask": async (permission): Promise<void> => {
      if (permission.permission !== "edit") return;
      if (permission.sessionID !== undefined && !activeSessions.has(permission.sessionID)) return;
      const gate = permission.sessionID === undefined
        ? await loadedGate()
        : await authorizedGate(permission.sessionID);
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
      if (!activeSessions.has(toolInput.sessionID)) return;
      const gate = await authorizedGate(toolInput.sessionID);
      if (gate === undefined) {
        const extraction = extractWritePaths(toolInput.tool, output.args);
        if (extraction.applies) {
          throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: loadFailure });
        }
        return;
      }
      await gate.check(toolInput, output);
    },
    event: async ({ event }): Promise<void> => {
      const eventSessionID = typeof event.properties?.sessionID === "string"
        ? event.properties.sessionID
        : undefined;
      if (eventSessionID === undefined || !activeSessions.has(eventSessionID)) return;
      if (event.type === "file.edited" && typeof event.properties?.file === "string") {
        await inspect(event.properties.file, eventSessionID);
      } else if (event.type === "session.idle" && eventSessionID !== undefined) {
        try {
          await ensureLoaded();
          if (loaded === undefined) {
            throw new HandoffDeniedError("configuration-unavailable", "<unknown>", { cause: loadFailure });
          }
          for (const path of loaded.handoffPaths) await inspect(path, eventSessionID);
        } finally {
          evictSession(eventSessionID);
        }
      } else if (event.type === "session.deleted") {
        evictSession(eventSessionID);
      }
    },
  };
};

export type { SortieDogsPluginOptions } from "./config.js";
export { InvalidModelTargetError, ModelRoutingDeniedError } from "./model-routing-hook.js";
