import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { RelativePathError } from "../core/path.js";
import type { OperationManifest } from "../core/types.js";
import { validateManifest } from "../core/validate-manifest.js";
import { validateHandoffSchema, validateOperationManifestSchema } from "../core/validate-schema.js";
import {
  resolvePluginConfiguration,
  type ConfiguredPlugin,
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

const INPUT_LIMITS = { config: 64 * 1024, manifest: 512 * 1024, handoff: 2 * 1024 * 1024 } as const;
const INSPECTION_CACHE = { maximum: 256, ttlMilliseconds: 30 * 60 * 1000 } as const;
const PROJECT_CONFIG_PATH = ".opencode/sortie-dogs.json";
const ENV_CONFIG = "SORTIE_DOGS_CONFIG";

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
  "tool.execute.before"?: (
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ) => Promise<void>;
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
  gate: WriteGate;
  manifest: OperationManifest;
  handoffPaths: readonly string[];
}

interface InspectionCacheEntry {
  fingerprint: string;
  expiresAt: number;
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

async function loadConfigured(project: ProjectPaths, config: ConfiguredPlugin): Promise<LoadedConfiguration> {
  const manifestPath = await project.toRelativePath(config.operationManifestPath);
  const manifestValue = await readJson(project.absolute(manifestPath), INPUT_LIMITS.manifest);
  const validation = validateOperationManifestSchema(manifestValue);
  if (!validation.ok) throw new WriteDeniedError("manifest-unavailable", "<unknown>");

  const gate = await createWriteGate(project, validation.value);
  const handoffPaths: string[] = [];
  for (const path of config.handoffPaths) handoffPaths.push(await project.toRelativePath(path));
  return { gate, manifest: validation.value, handoffPaths };
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

/** Named OpenCode plugin export. Importing the package has no side effects; invoking it installs active gates. */
export const SortieDogsPlugin: OpenCodePlugin = async (input, options) => {
  let project: ProjectPaths | undefined;
  let loaded: LoadedConfiguration | undefined;
  let loadFailure: unknown;
  try {
    project = await createProjectPaths(resolveProjectRoot(input));
    const projectConfig = await readOptionalProjectConfig(project);
    const environmentConfig = readEnvironmentConfig();
    const parsed = resolvePluginConfiguration(projectConfig, environmentConfig, options);
    if (parsed.kind === "invalid") throw new WriteDeniedError("manifest-unavailable", "<unknown>");
    loaded = await loadConfigured(project, parsed);
  } catch (error) {
    loadFailure = error;
  }

  const inspected = new Map<string, InspectionCacheEntry>();

  async function inspect(path: string, sessionID: string | undefined): Promise<void> {
    if (loaded === undefined || project === undefined) {
      throw new HandoffDeniedError("configuration-unavailable", path, { cause: loadFailure });
    }
    let normalized: string;
    try {
      normalized = await project.toRelativePath(path);
    } catch (error) {
      if (error instanceof WriteDeniedError || error instanceof RelativePathError) {
        throw new HandoffDeniedError("path-invalid", path, { cause: error });
      }
      throw error;
    }
    if (!loaded.handoffPaths.includes(normalized)) return;

    let value: unknown;
    try {
      value = await readJson(project.absolute(normalized), INPUT_LIMITS.handoff);
    } catch (error) {
      if (error instanceof PluginInputError) {
        throw new HandoffDeniedError("input-unavailable", normalized, { cause: error });
      }
      throw error;
    }
    const validation = validateHandoffSchema(value);
    if (!validation.ok) throw new HandoffDeniedError("schema-invalid", normalized);
    const diagnostics = validateManifest(validation.value, loaded.manifest, undefined, false);
    if (diagnostics.some(({ severity }) => severity === "error")) {
      throw new HandoffDeniedError("contract-invalid", normalized);
    }

    const fingerprint = inspectionFingerprint(validation.value, diagnostics);
    if (sessionID === undefined) return;
    const key = `${sessionID}\u0000${normalized}`;
    const now = Date.now();
    pruneInspectionCache(inspected, now);
    if (inspected.get(key)?.fingerprint === fingerprint) return;
    inspected.delete(key);
    inspected.set(key, { fingerprint, expiresAt: now + INSPECTION_CACHE.ttlMilliseconds });
  }

  return {
    "tool.execute.before": async (toolInput, output): Promise<void> => {
      if (loaded === undefined) {
        const extraction = extractWritePaths(toolInput.tool, output.args);
        if (extraction.applies) {
          throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: loadFailure });
        }
        return;
      }
      await loaded.gate.check(toolInput, output);
    },
    event: async ({ event }): Promise<void> => {
      const eventSessionID = typeof event.properties?.sessionID === "string"
        ? event.properties.sessionID
        : undefined;
      if (event.type === "file.edited" && typeof event.properties?.file === "string") {
        await inspect(event.properties.file, eventSessionID);
      } else if (event.type === "session.idle" && eventSessionID !== undefined) {
        if (loaded === undefined) {
          throw new HandoffDeniedError("configuration-unavailable", "<unknown>", { cause: loadFailure });
        }
        for (const path of loaded.handoffPaths) await inspect(path, eventSessionID);
      }
    },
  };
};

export type { SortieDogsPluginOptions } from "./config.js";
