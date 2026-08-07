import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { RUNTIME_ASSET_VERSION } from "../asset-version.js";
import { normalizeRelativePath, RelativePathError } from "../core/path.js";
import type { ManifestDiagnostic, OperationManifest, SchemaDiagnostic } from "../core/types.js";
import { validateManifest } from "../core/validate-manifest.js";
import {
  safeSchemaPointer,
  validateHandoffSchema,
  validateOperationManifestSchema,
} from "../core/validate-schema.js";
import {
  DEFAULT_PLUGIN_OPTIONS,
  resolvePluginConfiguration,
  resolvePluginConfigurationSourcesWithGlobal,
  type ConfiguredPluginSources,
  type ContinuationConfiguration,
  type SortieDogsPluginOptions,
} from "./config.js";
import {
  CONTINUATION_CAPABILITY,
  createContinuationHooks,
  type ContinuationClient,
  type ContinuationHooks,
} from "./continuation.js";
import {
  WriteDeniedError,
  createProjectPaths,
  createWriteGate,
  describeUnclassifiedCommand,
  isKnownReadOnlyTool,
  normalizeCommand,
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
  type OpenCodeModelAvailabilityClient,
} from "./model-routing-hook.js";
import {
  createTaskResultRepairHook,
  type SessionMessageReader,
} from "./task-result-repair.js";
import { configRoot, nearestPackageVersion, reflectionEnabled, ReflectionError, ReflectionStore } from "../reflection/index.js";

const INPUT_LIMITS = { config: 64 * 1024, manifest: 512 * 1024, handoff: 2 * 1024 * 1024 } as const;
const INSPECTION_CACHE = { maximum: 256, ttlMilliseconds: 30 * 60 * 1000 } as const;
const ACTIVE_SESSION_CACHE = { maximum: 256, ttlMilliseconds: 30 * 60 * 1000 } as const;
const SESSION_DENIAL_LIMIT = 256;
const PROJECT_CONFIG_PATH = ".opencode/sortie-dogs.json";
const PROJECT_VERSION_MARKER = ".opencode/sortie-dogs.version";
const ENV_CONFIG = "SORTIE_DOGS_CONFIG";
const COORDINATOR_AGENT = "dog-coordinator";
const SORTIE_TRIGGER = /^\/sortie(?:\s|$)/;
const TASK_ROLES = new Set(["implementation", "remediation", "blocker-resolution"]);

export interface OpenCodePluginInput {
  directory: string;
  worktree?: string;
  /** The host SDK client. Absent in hosts that construct the plugin without one. */
  client?: SessionMessageReader & ContinuationClient & OpenCodeModelAvailabilityClient;
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
  "tool.execute.after"?: (
    input: TaskToolExecuteAfterInput,
    output: TaskResultRepairOutput,
  ) => Promise<void>;
  "chat.message"?: OpenCodeChatMessageHook;
  "experimental.chat.system.transform"?: (input: { sessionID: string }, output: { system?: string[]; model?: unknown }) => Promise<void>;
  /** Continuation observes the coordinator's completed final text to honour its fallback markers. */
  "experimental.text.complete"?: (
    input: { sessionID: string },
    output: { text: string },
  ) => Promise<void>;
  /** Continuation replaces the compaction prompt so batch state survives the rollover. */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context?: string[]; prompt?: string },
  ) => Promise<void>;
  /** Continuation owns the resume, so the host must not auto-continue the same session too. */
  "experimental.compaction.autocontinue"?: (
    input: { sessionID: string; overflow?: boolean },
    output: { enabled: boolean },
  ) => Promise<void>;
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

/**
 * A denial the author cannot diagnose is a denial the author repeats, so every contract rejection
 * reports which document failed, which JSON pointer failed, and which rule failed. Defect evidence
 * is deliberately limited to that structural triple: no file content ever reaches an agent report.
 */
type ContractDocument = "handoff" | "manifest" | "contract";

const CONTRACT_DEFECTS = { limit: 8, pointerCharacters: 120 } as const;

function contractPointer(pointer: string): string {
  const bounded = pointer.slice(0, CONTRACT_DEFECTS.pointerCharacters);
  const neutralized = bounded.replaceAll(/[^A-Za-z0-9@~/._-]/gu, "?");
  return neutralized.length === 0 ? "/" : neutralized;
}

function contractDefect(document: ContractDocument, pointer: string, code: string): string {
  return `${document} ${contractPointer(pointer)} ${code}`;
}

function schemaDefects(
  document: ContractDocument,
  diagnostics: readonly SchemaDiagnostic[],
): string[] {
  return diagnostics.map((diagnostic) =>
    contractDefect(document, safeSchemaPointer(diagnostic), diagnostic.code)
  );
}

function contractDefects(diagnostics: readonly ManifestDiagnostic[]): string[] {
  return diagnostics
    .filter(({ severity }) => severity === "error")
    .map((diagnostic) => contractDefect("contract", diagnostic.pointer, diagnostic.code));
}

function normalizeDefects(defects: readonly string[] | undefined): readonly string[] {
  return [...new Set(defects ?? [])];
}

function describeDefects(defects: readonly string[]): string {
  const shown = defects.slice(0, CONTRACT_DEFECTS.limit);
  const remainder = defects.length - shown.length;
  return `${shown.join("; ")}${remainder > 0 ? `; +${remainder} more` : ""}`;
}

export class HandoffDeniedError extends Error {
  readonly reason: HandoffDenialReason;
  readonly defects: readonly string[];

  constructor(
    reason: HandoffDenialReason,
    path: string,
    options?: ErrorOptions & { defects?: readonly string[] },
  ) {
    const defects = normalizeDefects(options?.defects);
    super(
      `Handoff denied for "${safePath(path)}": handoff and operation manifest contract.` +
        (defects.length === 0 ? "" : ` Defects: ${describeDefects(defects)}.`) +
        " Correct the registered handoff or its operation manifest, then read the handoff again.",
      options,
    );
    this.name = "HandoffDeniedError";
    this.reason = reason;
    this.defects = defects;
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

const WRITE_GATE_EXTENSION_POINTER = "/ext/sortie-dogs~1write-gate";

interface WriteGateExtension {
  readonly operation_manifest: string;
  readonly project_root: string;
}

function defectCode(prefix: string, reason: string): string {
  return `${prefix}_${reason.replaceAll("-", "_")}`;
}

function writeGateExtensionDefects(value: unknown): string[] {
  if (!isRecord(value)) {
    return [contractDefect("handoff", WRITE_GATE_EXTENSION_POINTER, "ext_not_an_object")];
  }
  const defects: string[] = [];
  if (Object.keys(value).some((key) => key !== "operation_manifest" && key !== "project_root")) {
    defects.push(
      contractDefect("handoff", `${WRITE_GATE_EXTENSION_POINTER}/@unknown`, "ext_property_unknown"),
    );
  }
  const manifestPointer = `${WRITE_GATE_EXTENSION_POINTER}/operation_manifest`;
  if (typeof value.operation_manifest !== "string" || value.operation_manifest.length === 0) {
    defects.push(contractDefect("handoff", manifestPointer, "ext_operation_manifest_missing"));
  } else if (isAbsolute(value.operation_manifest)) {
    defects.push(contractDefect("handoff", manifestPointer, "ext_operation_manifest_not_relative"));
  }
  const rootPointer = `${WRITE_GATE_EXTENSION_POINTER}/project_root`;
  if (typeof value.project_root !== "string") {
    defects.push(contractDefect("handoff", rootPointer, "ext_project_root_missing"));
  } else if (!isAbsolute(value.project_root)) {
    defects.push(contractDefect("handoff", rootPointer, "ext_project_root_not_absolute"));
  }
  return defects;
}

function isWriteGateExtension(value: unknown): value is WriteGateExtension {
  return writeGateExtensionDefects(value).length === 0;
}

/** Map a resolution failure to the contract rule the author can act on, never to a raw path. */
function extensionFailureDefect(error: unknown): string {
  if (error instanceof PluginInputError) {
    return contractDefect("manifest", "/", defectCode("input", error.reason));
  }
  if (error instanceof RelativePathError) {
    return contractDefect(
      "handoff",
      `${WRITE_GATE_EXTENSION_POINTER}/operation_manifest`,
      "ext_operation_manifest_not_relative",
    );
  }
  if (error instanceof WriteDeniedError) {
    return contractDefect("handoff", WRITE_GATE_EXTENSION_POINTER, defectCode("ext", error.reason));
  }
  return contractDefect("handoff", WRITE_GATE_EXTENSION_POINTER, "ext_unresolved");
}

interface LoadedConfiguration {
  gate?: WriteGate;
  manifest?: OperationManifest;
  operationManifestPath: string;
  operationManifestAbsolutePath?: string;
  manifestFingerprint?: string;
  handoffPaths: readonly string[];
  handoffRelativePaths: readonly string[];
  readOnlyTools: ReadonlySet<string>;
  modelRoutingHook?: OpenCodeChatMessageHook;
  continuation: ContinuationConfiguration;
  reflection: ConfiguredPluginSources["reflection"];
}

interface TaskToolExecuteAfterInput {
  readonly tool: string;
  readonly sessionID?: string;
  readonly callID?: string;
  readonly args?: unknown;
}

interface TaskResultRepairOutput {
  output?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

interface InspectionCacheEntry {
  fingerprint: string;
  expiresAt: number;
  handoffPath: string;
  manifestPath: string;
  ownerSessionID: string;
  projectRoot: string;
  rootSessionID: string;
}

interface SessionAuthorization {
  gate: WriteGate;
  expiresAt: number;
  handoffPath: string;
  manifestHash: string;
  manifestMtimeMs: number;
  manifestPath: string;
  projectRoot: string;
  rootSessionID: string;
  suspended: boolean;
}

interface BindingPin {
  manifestHash: string;
  manifestMtimeMs: number;
  manifestPath: string;
}

interface ActiveSessionState {
  deniedSignatures: Set<string>;
  expiresAt: number;
}

interface CoordinatorRootLineage {
  expiresAt: number;
  projectRoot: string;
}

interface OpenCodeToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute(
    args: Record<string, string>,
    context: { sessionID: string; agent?: string },
  ): Promise<string>;
}

interface OpenCodeToolFactory {
  (definition: OpenCodeToolDefinition): OpenCodeToolDefinition;
  schema: { string(): unknown; optional?(value: unknown): unknown };
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

/** A path that was never created is an unconfigured project, not a defective one. */
function isAbsentPathError(error: unknown): boolean {
  return error instanceof PluginInputError && error.reason === "read-failed" &&
    isRecord(error.cause) && (error.cause.code === "ENOENT" || error.cause.code === "ENOTDIR");
}

async function readOptionalProjectConfig(project: ProjectPaths): Promise<unknown> {
  const path = project.absolute(PROJECT_CONFIG_PATH);
  try {
    return await readJson(path, INPUT_LIMITS.config);
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
}

async function readOptionalGlobalConfig(): Promise<unknown> {
  try {
    const value = await readJson(join(configRoot(), "sortie-dogs.json"), INPUT_LIMITS.config);
    if (resolvePluginConfiguration(value).kind === "invalid") {
      console.warn("[sortie-dogs] global configuration ignored: invalid or unavailable");
      return undefined;
    }
    return value;
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    console.warn("[sortie-dogs] global configuration ignored: invalid or unavailable");
    return undefined;
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
  client?: OpenCodeModelAvailabilityClient,
): LoadedConfiguration {
  const handoffPaths = config.handoffPaths.map((path) => resolve(handoffBase, path));
  const handoffRelativePaths = config.handoffPaths.flatMap((path) => {
    try {
      return [normalizeRelativePath(path)];
    } catch {
      return [];
    }
  });
  const hasModelRouting = Object.keys(config.localModelRouting).length > 0 ||
    Object.keys(config.globalModelRouting).length > 0;
  const modelRoutingHook = hasModelRouting
    ? createModelRoutingHook({
      local: config.localModelRouting,
      global: config.globalModelRouting,
      catalog: config.modelCatalog,
      dedicated: config.dedicatedWorkerModel,
      freeTierFallbackModels: config.freeTierFallbackModels,
    }, client)
    : undefined;
  return {
    operationManifestPath: config.operationManifestPath,
    handoffPaths,
    handoffRelativePaths,
    readOnlyTools: new Set(config.readOnlyTools.map((tool) => tool.toLowerCase())),
    modelRoutingHook,
    continuation: config.continuation,
    reflection: config.reflection,
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function sameRelativePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function hasRelativePathSuffix(path: string, relativePath: string): boolean {
  const platformPath = relativePath.replaceAll("/", sep);
  const candidate = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const suffix = process.platform === "win32" ? platformPath.toLowerCase() : platformPath;
  return candidate === suffix || candidate.endsWith(`${sep}${suffix}`);
}

function textPart(part: unknown): string | undefined {
  return isRecord(part) && typeof part.text === "string" ? part.text : undefined;
}

/**
 * One handoff entry per line. The coordinator asset emits inline digests as `key: value`, often
 * indented or list-prefixed, while host wrappers emit flat `key=value`. Both forms describe the
 * same contract, so a single line parser accepts either separator instead of one fixed layout.
 */
const HANDOFF_ENTRY = /^[\t ]*(?:[-*][\t ]+)?(?:(\*\*|__|\*|_|`)([A-Za-z_][A-Za-z0-9_]*)(?:\1[\t ]*[=:]|[\t ]*[=:]\1)|([A-Za-z_][A-Za-z0-9_]*)[\t ]*[=:])[\t ]*(.*)$/u;

function unwrapMarkdownValue(value: string): string {
  const trimmed = value.trim();
  const wrapped = /^(\*\*|__|\*|_|`)([\s\S]*)\1$/u.exec(trimmed);
  return wrapped === null ? trimmed : wrapped[2].trim();
}

const HANDOFF_KEYS = {
  role: ["role"],
  projectRoot: ["projectroot", "project_root"],
  manifest: ["source_manifest", "operation_manifest", "sourcemanifest", "operationmanifest"],
  acceptance: ["acceptance", "validation"],
} as const;

function handoffEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = HANDOFF_ENTRY.exec(line);
    if (match === null) continue;
    const key = (match[2] ?? match[3]).toLowerCase();
    if (entries.has(key)) continue;
    entries.set(key, unwrapMarkdownValue(match[4]));
  }
  return entries;
}

function handoffValue(entries: Map<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = entries.get(key);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function unquoteValue(value: string): string {
  const trimmed = value.replace(/,$/u, "").trim();
  const quote = trimmed[0];
  return (quote === "\"" || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1
    ? trimmed.slice(1, -1)
    : trimmed;
}

/*
 * The dispatching coordinator writes user-facing prose in the user's own language, so its role label
 * is the one digest key a localized dispatch is most likely to translate. The role value itself is a
 * protocol token that never localizes, so an unrecognized label still yields the role from any line
 * whose entire value is one of those tokens. Every other required key still has to be present, so a
 * bare resume or an unrelated message cannot activate a session through this path.
 */
const LABELLED_VALUE = /^[\t ]*(?:[-*][\t ]+)?[^\r\n:=]{1,64}[\t ]*[=:][\t ]*(.*)$/u;

function roleTokenValue(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const match = LABELLED_VALUE.exec(line);
    if (match === null) continue;
    const value = unquoteValue(unwrapMarkdownValue(match[1])).toLowerCase();
    if (TASK_ROLES.has(value)) return value;
  }
  return undefined;
}

export function isExplicitTaskHandoff(text: string): boolean {
  const entries = handoffEntries(text);
  const labelled = handoffValue(entries, HANDOFF_KEYS.role)?.toLowerCase();
  const role = labelled !== undefined && TASK_ROLES.has(labelled) ? labelled : roleTokenValue(text);
  return role !== undefined && TASK_ROLES.has(role) &&
    handoffValue(entries, HANDOFF_KEYS.projectRoot) !== undefined &&
    handoffValue(entries, HANDOFF_KEYS.manifest) !== undefined &&
    handoffValue(entries, HANDOFF_KEYS.acceptance) !== undefined;
}

function explicitTaskText(output: Parameters<OpenCodeChatMessageHook>[1]): string | undefined {
  return output.parts.map(textPart).find((text) => text !== undefined && isExplicitTaskHandoff(text));
}

function taskProjectRoot(text: string): string | undefined {
  const value = handoffValue(handoffEntries(text), HANDOFF_KEYS.projectRoot);
  return value === undefined ? undefined : unquoteValue(value);
}

function chatParentID(input: Parameters<OpenCodeChatMessageHook>[0]): string | undefined {
  const candidate = input as typeof input & { parentID?: unknown; parentId?: unknown };
  return typeof candidate.parentID === "string" ? candidate.parentID
    : typeof candidate.parentId === "string" ? candidate.parentId
      : undefined;
}

function activatesSession(input: Parameters<OpenCodeChatMessageHook>[0], output: Parameters<OpenCodeChatMessageHook>[1]): boolean {
  if (input.agent === COORDINATOR_AGENT || output.message.agent === COORDINATOR_AGENT) return false;
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
  const optionalString = () => {
    const stringSchema = defineTool.schema.string();
    if (isRecord(stringSchema) && typeof stringSchema.optional === "function") {
      return (stringSchema.optional as () => unknown)();
    }
    return typeof defineTool.schema.optional === "function" ? defineTool.schema.optional(stringSchema) : stringSchema;
  };
  let project: ProjectPaths | undefined;
  let reflectionStartup = false;
  let reflectionConfiguration: ConfiguredPluginSources["reflection"] | undefined;
  let reflectionVersion: string | undefined;
  let reflectionStore: ReflectionStore | undefined;
  let loaded: LoadedConfiguration | undefined;
  let loadFailure: unknown;
  let loading: Promise<void> | undefined;
  let manifestAbsent = false;
  let assetVersionReported = false;
  const globalConfig = await readOptionalGlobalConfig();

  // Project config read is required discovery for its opt-in; no reflection storage/version read
  // occurs unless that resolved config enables reflection. It stays isolated from write-gate load.
  try {
    project = await createProjectPaths(resolveProjectRoot(input));
    const probed = resolvePluginConfigurationSourcesWithGlobal(
      globalConfig,
      await readOptionalProjectConfig(project),
      readEnvironmentConfig(),
      options,
    );
    if (probed.kind === "configured" && reflectionEnabled(probed.reflection)) {
      reflectionVersion = await nearestPackageVersion();
      reflectionConfiguration = probed.reflection;
      reflectionStore = new ReflectionStore(join(configRoot(), "sortie-dogs", "reflection"), project.root, {
        warn: (code) => {
          const log = (input.client as Record<string, unknown> | undefined)?.app;
          if (!isRecord(log) || typeof log.log !== "function") return;
          try { (log.log as (value: unknown) => unknown)({ level: "warn", service: "sortie-dogs", message: code }); } catch { /* host logging is best effort */ }
        },
      });
      reflectionStartup = true;
    }
  } catch {
    reflectionStartup = false;
    reflectionConfiguration = undefined;
    reflectionVersion = undefined;
    reflectionStore = undefined;
  }
  /*
   * Continuation must be callable before the first lazy configuration load completes, so it reads
   * the effective policy at call time and falls back to the shipped default until then.
   */
  const continuation: ContinuationHooks = createContinuationHooks(
    input.client,
    input.worktree ?? input.directory,
    () => loaded?.continuation ?? DEFAULT_PLUGIN_OPTIONS.continuation,
    undefined,
    /*
     * The message hook already proved which session runs the coordinator as a root, so continuation
     * trusts that observation before asking the host, whose session lookup may answer without an
     * agent field or for a different directory.
     */
    (sessionID) => isCoordinatorSession(sessionID)
      ? { agent: COORDINATOR_AGENT, parentID: undefined }
      : undefined,
  );

  async function ensureLoaded(): Promise<void> {
    if (loaded?.gate !== undefined) return;
    if (loading !== undefined) return loading;
    loading = (async () => {
      try {
        project ??= await createProjectPaths(resolveProjectRoot(input));
        await reportAssetVersionSkew(project);
        const projectConfig = await readOptionalProjectConfig(project);
        const environmentConfig = readEnvironmentConfig();
        const parsed = resolvePluginConfigurationSourcesWithGlobal(
          globalConfig,
          projectConfig,
          environmentConfig,
          options,
        );
        if (parsed.kind === "invalid") throw new WriteDeniedError("manifest-unavailable", "<unknown>");
        loaded = loadConfigured(parsed, input.worktree ?? project.root, input.client);
        const manifestPath = await project.toRelativePath(loaded.operationManifestPath);
        loaded.operationManifestAbsolutePath = project.absolute(manifestPath);
        let manifestValue: unknown;
        try {
          manifestValue = await readJson(loaded.operationManifestAbsolutePath, INPUT_LIMITS.manifest);
        } catch (error) {
          manifestAbsent = isAbsentPathError(error);
          throw error;
        }
        manifestAbsent = false;
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

  /**
   * Installed agents and this plugin implement two halves of one contract. A project that installed
   * a different asset version is reported once so the mismatch is visible before it shows up as an
   * unexplained handshake failure. Reporting never blocks: reinstalling is the operator's decision.
   */
  async function reportAssetVersionSkew(paths: ProjectPaths): Promise<void> {
    if (assetVersionReported) return;
    assetVersionReported = true;
    const marker = await readFile(paths.absolute(PROJECT_VERSION_MARKER), "utf8").catch(() => undefined);
    const installed = marker?.trim();
    if (installed === undefined || installed.length === 0 || installed === RUNTIME_ASSET_VERSION) return;
    console.warn(
      `Sortie-dogs: this project installed agent assets ${installed} but the loaded plugin ships ` +
      `${RUNTIME_ASSET_VERSION}. Run "sortie-dogs init ." to reinstall the matching agents.`,
    );
  }

  /**
   * A project without an operation manifest never opted into the write gate. Enforcing a scope that
   * was never declared would also deny creating that same manifest, so an absent manifest disables
   * enforcement while an unreadable or invalid manifest stays fail-closed.
   */
  async function isUnconfiguredProject(): Promise<boolean> {
    await ensureLoaded();
    return loaded?.gate === undefined && manifestAbsent;
  }

  const inspected = new Map<string, InspectionCacheEntry>();
  const sessionAuthorizations = new Map<string, SessionAuthorization>();
  const bindingPins = new Map<string, BindingPin>();
  const activeSessions = new Map<string, ActiveSessionState>();
  const coordinatorRoots = new Map<string, CoordinatorRootLineage>();
  const reflectionOwnedRoots = new Set<string>();
  const reflectionClosingRoots = new Set<string>();
  const reflectionInFlight = new Map<string, number>();
  const reflectionWaiters = new Map<string, Array<() => void>>();
  const bindingDenials = new Map<
    string,
    Map<string, Map<string, string>>
  >();
  const expiredSessions = new Set<string>();
  const sessionParents = new Map<string, string>();
  const sessionRoots = new Map<string, string>();

  function hasSessionEnforcementState(sessionID: string): boolean {
    return sessionAuthorizations.has(sessionID) || bindingPins.has(sessionID);
  }

  function bindingCandidateKey(projectRoot: string, manifestPath: string): string {
    return `${projectRoot}\u0000${manifestPath}`;
  }

  function recordBindingDenial(
    sessionID: string,
    projectRoot: string,
    manifestPath: string,
    signature: string,
  ): boolean {
    const rootSessionID = inspectionRoot(sessionID, Date.now()) ?? sessionID;
    const candidateKey = bindingCandidateKey(projectRoot, manifestPath);
    const rootDenials = bindingDenials.get(rootSessionID) ?? new Map<string, Map<string, string>>();
    const candidateDenials = rootDenials.get(candidateKey) ?? new Map<string, string>();
    const repeated = candidateDenials.has(signature);
    if (!repeated) candidateDenials.set(signature, sessionID);
    while (candidateDenials.size > SESSION_DENIAL_LIMIT) {
      candidateDenials.delete(candidateDenials.keys().next().value!);
    }
    rootDenials.delete(candidateKey);
    rootDenials.set(candidateKey, candidateDenials);
    while (rootDenials.size > SESSION_DENIAL_LIMIT) rootDenials.delete(rootDenials.keys().next().value!);
    bindingDenials.delete(rootSessionID);
    bindingDenials.set(rootSessionID, rootDenials);
    while (bindingDenials.size > ACTIVE_SESSION_CACHE.maximum) {
      bindingDenials.delete(bindingDenials.keys().next().value!);
    }
    return repeated;
  }

  function clearBindingDenial(
    rootSessionID: string,
    projectRoot: string,
    manifestPath: string,
    ownerSessionID?: string,
  ): void {
    const rootDenials = bindingDenials.get(rootSessionID);
    if (rootDenials === undefined) return;
    const candidateKey = bindingCandidateKey(projectRoot, manifestPath);
    const candidateDenials = rootDenials.get(candidateKey);
    if (candidateDenials === undefined) return;
    if (ownerSessionID === undefined) {
      rootDenials.delete(candidateKey);
    } else {
      for (const [signature, owner] of candidateDenials) {
        if (owner === ownerSessionID) candidateDenials.delete(signature);
      }
      if (candidateDenials.size === 0) rootDenials.delete(candidateKey);
    }
    if (rootDenials.size === 0) bindingDenials.delete(rootSessionID);
  }

  /**
   * Preflight reporting reuses this exact evaluation instead of a parallel implementation, so a
   * document that passes the check cannot fail the gate. It never inspects, binds, or caches: an
   * absent sessionID returns before any state is written.
   */
  async function inspect(
    path: string,
    sessionID: string | undefined,
    options: { readonly report?: boolean } = {},
  ): Promise<void> {
    const unregistered = (code: string): void => {
      if (!options.report) return;
      throw new HandoffDeniedError("path-invalid", path, {
        defects: [contractDefect("handoff", "/", code)],
      });
    };
    await ensureLoaded();
    if (loaded === undefined || project === undefined) {
      throw new HandoffDeniedError("configuration-unavailable", path, { cause: loadFailure });
    }
    const absolutePath = isAbsolute(path)
      ? resolve(path)
      : resolve(input.worktree ?? project.root, path);
    const exactRegisteredPath = loaded.handoffPaths.some((candidate) => samePath(candidate, absolutePath));
    const candidateRelativePath = loaded.handoffRelativePaths.find((candidate) =>
      hasRelativePathSuffix(absolutePath, candidate)
    );
    if (!exactRegisteredPath && candidateRelativePath === undefined) {
      unregistered("handoff_path_not_registered");
      return;
    }
    const key = sessionID === undefined ? undefined : `${sessionID}\u0000${absolutePath}`;
    if (key !== undefined) inspected.delete(key);
    let value: unknown;
    try {
      value = await readJson(absolutePath, INPUT_LIMITS.handoff);
    } catch (error) {
      if (error instanceof PluginInputError) {
        throw new HandoffDeniedError("input-unavailable", path, {
          cause: error,
          defects: [contractDefect("handoff", "/", defectCode("input", error.reason))],
        });
      }
      throw error;
    }
    const validation = validateHandoffSchema(value);
    if (!validation.ok) {
      throw new HandoffDeniedError("schema-invalid", path, {
        defects: schemaDefects("handoff", validation.diagnostics),
      });
    }

    let authorizationGate: WriteGate;
    let manifestPath: string;
    let manifest: OperationManifest;
    let inspectedProjectRoot: string;
    const extension = validation.value.ext?.["sortie-dogs/write-gate"];
    if (extension === undefined) {
      // Candidate-relative registration is only safe when the handoff names its candidate root.
      if (!exactRegisteredPath) {
        unregistered("ext_write_gate_missing");
        return;
      }
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
          throw new HandoffDeniedError("path-invalid", path, {
            cause: error,
            defects: [contractDefect("handoff", "/", "handoff_path_outside_project")],
          });
        }
        throw error;
      }
      manifest = loaded.manifest;
      authorizationGate = loaded.gate;
      manifestPath = loaded.operationManifestAbsolutePath;
      inspectedProjectRoot = project.root;
    } else {
      if (!isWriteGateExtension(extension)) {
        throw new HandoffDeniedError("contract-invalid", path, {
          defects: writeGateExtensionDefects(extension),
        });
      }
      try {
        const allowedRoots = [project];
        if (input.worktree !== undefined && resolve(input.worktree) !== project.root) {
          allowedRoots.push(await createProjectPaths(resolve(input.worktree)));
        }
        const containment = await Promise.all(
          allowedRoots.map((allowedRoot) => allowedRoot.contains(extension.project_root)),
        );
        if (!containment.some(Boolean)) throw new WriteDeniedError("project-boundary", "<candidate-root>");
        const candidateProject = await createProjectPaths(extension.project_root);
        const relativeHandoffPath = await candidateProject.toRelativePath(absolutePath);
        if (
          !exactRegisteredPath &&
          !loaded.handoffRelativePaths.some((candidate) => sameRelativePath(candidate, relativeHandoffPath))
        ) {
          unregistered("handoff_path_not_registered");
          return;
        }
        const relativeManifestPath = await candidateProject.toRelativePath(extension.operation_manifest);
        manifestPath = candidateProject.absolute(relativeManifestPath);
        const manifestValue = await readJson(manifestPath, INPUT_LIMITS.manifest);
        const manifestValidation = validateOperationManifestSchema(manifestValue);
        if (!manifestValidation.ok) {
          throw new HandoffDeniedError("contract-invalid", path, {
            defects: schemaDefects("manifest", manifestValidation.diagnostics),
          });
        }
        manifest = manifestValidation.value;
        authorizationGate = await createWriteGate(candidateProject, manifest);
        inspectedProjectRoot = candidateProject.root;
      } catch (error) {
        if (error instanceof HandoffDeniedError) throw error;
        throw new HandoffDeniedError("contract-invalid", path, {
          cause: error,
          defects: [extensionFailureDefect(error)],
        });
      }
    }
    const diagnostics = validateManifest(
      validation.value,
      manifest,
      undefined,
      false,
      { requirePassedValidation: false },
    );
    if (diagnostics.some(({ severity }) => severity === "error")) {
      throw new HandoffDeniedError("contract-invalid", path, {
        defects: contractDefects(diagnostics),
      });
    }

    if (sessionID === undefined) return;
    const now = Date.now();
    const rootSessionID = inspectionRoot(sessionID, now);
    if (rootSessionID === undefined) return;
    const fingerprint = inspectionFingerprint(validation.value, diagnostics, manifest);
    pruneInspections(now, true);
    inspected.set(key!, {
      fingerprint,
      expiresAt: now + INSPECTION_CACHE.ttlMilliseconds,
      handoffPath: absolutePath,
      manifestPath,
      ownerSessionID: sessionID,
      projectRoot: inspectedProjectRoot,
      rootSessionID,
    });
    clearBindingDenial(rootSessionID, inspectedProjectRoot, manifestPath, sessionID);
    pruneSessionAuthorizations(sessionAuthorizations, now);
  }

  async function bindWriteGate(
    sessionID: string,
    projectRoot: string,
    manifestPathArgument: string,
  ): Promise<string> {
    const remedies: Record<string, { recoverable: boolean; remedy: string }> = {
      "session-inactive": {
        recoverable: true,
        remedy: "Freshly redispatch this worker with prompt text containing role, project_root, source_manifest or operation_manifest, and acceptance or validation fields; a bare resume or file read cannot activate the session.",
      },
      "session-expired": {
        recoverable: true,
        remedy: "Resume this worker session once with an explicit blocker-resolution Task.",
      },
      "handoff-uninspected": {
        recoverable: true,
        remedy: "Inspect the exact registered handoff path read-only, then resume this worker once.",
      },
      "handoff-mismatch": {
        recoverable: true,
        remedy: "Have dog-coordinator regenerate the registered handoff, inspect it, then resume this worker once.",
      },
      "binding-replay": {
        recoverable: false,
        remedy: "Start a new candidate session; do not replace an existing binding.",
      },
      "retry-exhausted": {
        recoverable: false,
        remedy: "No write-gate state changed after one retry; stop this candidate and record the local blocker.",
      },
    };
    const deny = (reason: string, defects: readonly string[] = []): string => {
      const detail = remedies[reason] ?? {
        recoverable: false,
        remedy: "Correct the reported contract defect before starting a new bind flow.",
      };
      const reported = normalizeDefects(defects).slice(0, CONTRACT_DEFECTS.limit);
      const escalation = reason === "session-inactive"
        ? {
          action: "redispatch-worker",
          resume_session: false,
          true_blocker: false,
        }
        : detail.recoverable
        ? {
          action: "blocker-resolution-takeover",
          resume_session: true,
          true_blocker: false,
        }
        : {
          action: "follow-remedy",
          resume_session: false,
          true_blocker: reason === "binding-failed" || reason === "retry-exhausted",
        };
      return JSON.stringify({
        status: "denied",
        reason,
        ...detail,
        ...(reported.length === 0 ? {} : { defects: reported }),
        escalation,
      });
    };
    try {
      const sessionStatus = activeSessionStatus(sessionID);
      if (sessionStatus !== "active") {
        return deny(sessionStatus === "expired" ? "session-expired" : "session-inactive");
      }
      touchActiveSession(sessionID);
      const now = Date.now();
      pruneSessionAuthorizations(sessionAuthorizations, now);
      if (!isAbsolute(projectRoot)) return deny("path-invalid");

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
      if (!validation.ok) {
        return deny("manifest-invalid", schemaDefects("manifest", validation.diagnostics));
      }
      const bindingPin = bindingPins.get(sessionID);
      if (bindingPin !== undefined) {
        if (
          bindingPin.manifestPath !== manifestPath ||
          bindingPin.manifestHash !== pinned.hash ||
          bindingPin.manifestMtimeMs !== pinned.mtimeMs
        ) return deny("binding-replay");
      }
      const existingAuthorization = sessionAuthorizations.get(sessionID);
      pruneInspections(now);
      const inspectedEntry = [...inspected.entries()].find(([key, entry]) =>
        key.startsWith(`${sessionID}\u0000`) &&
        entry.ownerSessionID === sessionID &&
        entry.projectRoot === candidate.root && entry.manifestPath === manifestPath
      )?.[1];
      if (inspectedEntry === undefined) {
        const signature = inspectionFingerprint(
          ["handoff-uninspected", candidate.root, manifestPath, pinned.hash, pinned.mtimeMs],
          undefined,
        );
        if (recordBindingDenial(sessionID, candidate.root, manifestPath, signature)) {
          return deny("retry-exhausted");
        }
        return deny("handoff-uninspected");
      }
      const denyHandoffMismatch = (evidence: unknown, defects: readonly string[] = []): string => {
        const signature = inspectionFingerprint(
          ["handoff-mismatch", candidate.root, manifestPath, pinned.hash, pinned.mtimeMs],
          evidence,
        );
        if (recordBindingDenial(sessionID, candidate.root, manifestPath, signature)) {
          return deny("retry-exhausted", defects);
        }
        return deny("handoff-mismatch", defects);
      };
      let handoffValue: unknown;
      try {
        handoffValue = await readJson(inspectedEntry.handoffPath, INPUT_LIMITS.handoff);
      } catch (error) {
        if (error instanceof PluginInputError) {
          return denyHandoffMismatch({ input: error.reason }, [
            contractDefect("handoff", "/", defectCode("input", error.reason)),
          ]);
        }
        throw error;
      }
      const handoffValidation = validateHandoffSchema(handoffValue);
      if (!handoffValidation.ok) {
        return denyHandoffMismatch(handoffValue, schemaDefects("handoff", handoffValidation.diagnostics));
      }
      const diagnostics = validateManifest(
        handoffValidation.value,
        validation.value,
        undefined,
        false,
        { requirePassedValidation: false },
      );
      if (
        diagnostics.some(({ severity }) => severity === "error") ||
        inspectionFingerprint(handoffValidation.value, diagnostics, validation.value) !== inspectedEntry.fingerprint
      ) return denyHandoffMismatch(handoffValue, contractDefects(diagnostics));
      if (existingAuthorization !== undefined) {
        existingAuthorization.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
        existingAuthorization.suspended = false;
        return JSON.stringify({
          status: "bound",
          manifest_hash: pinned.hash,
          manifest_path: relativeManifestPath,
          idempotent: true,
        });
      }
      const gate = await createWriteGate(candidate, validation.value);
      bindingPins.set(sessionID, {
        manifestHash: pinned.hash,
        manifestMtimeMs: pinned.mtimeMs,
        manifestPath,
      });
      sessionAuthorizations.set(sessionID, {
        gate,
        expiresAt: now + ACTIVE_SESSION_CACHE.ttlMilliseconds,
        handoffPath: inspectedEntry.handoffPath,
        manifestHash: pinned.hash,
        manifestMtimeMs: pinned.mtimeMs,
        manifestPath,
        projectRoot: candidate.root,
        rootSessionID: inspectedEntry.rootSessionID,
        suspended: false,
      });
      clearBindingDenial(inspectedEntry.rootSessionID, candidate.root, manifestPath, sessionID);
      return JSON.stringify({
        status: "bound",
        manifest_hash: pinned.hash,
        manifest_path: relativeManifestPath,
        ...(bindingPin === undefined ? {} : { idempotent: true }),
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
      if (authorization.suspended) return undefined;
    try {
      const pinned = await readPinnedJson(authorization.manifestPath, INPUT_LIMITS.manifest);
      const manifestValidation = validateOperationManifestSchema(pinned.value);
      if (!manifestValidation.ok) throw new Error("manifest-invalid");
      if (pinned.hash !== authorization.manifestHash || pinned.mtimeMs !== authorization.manifestMtimeMs) {
        throw new Error("authorization-stale");
      }
      authorization.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
      return authorization.gate;
    } catch {
      authorization.suspended = true;
      return undefined;
    }
  }

  async function authorizedGate(sessionID: string): Promise<WriteGate | undefined> {
    return await sessionGate(sessionID);
  }

  function pruneActiveSessions(now: number, reserveSlot = false): void {
    for (const [sessionID, state] of activeSessions) {
      if (state.expiresAt <= now) expireSession(sessionID);
    }
    const limit = ACTIVE_SESSION_CACHE.maximum - (reserveSlot ? 1 : 0);
    while (activeSessions.size > limit) expireSession(activeSessions.keys().next().value!);
  }

  function pruneCoordinatorRoots(now: number, reserveSlot = false): void {
    for (const [sessionID, state] of coordinatorRoots) {
      if (state.expiresAt <= now) coordinatorRoots.delete(sessionID);
    }
    const limit = ACTIVE_SESSION_CACHE.maximum - (reserveSlot ? 1 : 0);
    while (coordinatorRoots.size > limit) coordinatorRoots.delete(coordinatorRoots.keys().next().value!);
  }

  async function rememberCoordinatorRoot(sessionID: string): Promise<void> {
    const now = Date.now();
    pruneCoordinatorRoots(now);
    project ??= await createProjectPaths(resolveProjectRoot(input));
    if (coordinatorRoots.has(sessionID)) coordinatorRoots.delete(sessionID);
    else pruneCoordinatorRoots(now, true);
    coordinatorRoots.set(sessionID, {
      expiresAt: now + ACTIVE_SESSION_CACHE.ttlMilliseconds,
      projectRoot: project.root,
    });
    sessionRoots.set(sessionID, sessionID);
  }

  /**
   * The coordinator owns candidate setup, handoff regeneration, and the commit, so it must never be
   * gated by the worker write scope. Enforcement is released instead of expired so a session that
   * later becomes the coordinator is not reported as a revoked worker session.
   */
  function releaseSessionEnforcement(sessionID: string): void {
    activeSessions.delete(sessionID);
    sessionAuthorizations.delete(sessionID);
    bindingPins.delete(sessionID);
    expiredSessions.delete(sessionID);
  }

  function isCoordinatorSession(sessionID: string): boolean {
    pruneCoordinatorRoots(Date.now());
    return coordinatorRoots.has(sessionID);
  }

  function coordinatorRootForSession(sessionID: string, now = Date.now()): string | undefined {
    pruneCoordinatorRoots(now);
    const assigned = sessionRoots.get(sessionID);
    if (assigned !== undefined && coordinatorRoots.has(assigned)) return assigned;
    const visited = new Set<string>();
    let cursor: string | undefined = sessionID;
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      if (coordinatorRoots.has(cursor)) {
        sessionRoots.set(sessionID, cursor);
        return cursor;
      }
      const inherited = sessionRoots.get(cursor);
      if (inherited !== undefined && coordinatorRoots.has(inherited)) {
        sessionRoots.set(sessionID, inherited);
        return inherited;
      }
      cursor = sessionParents.get(cursor);
    }
    return undefined;
  }

  function inspectionRoot(sessionID: string, now: number): string | undefined {
    if (!activeSessions.has(sessionID)) return undefined;
    const coordinatorRoot = coordinatorRootForSession(sessionID, now);
    if (sessionRoots.has(sessionID)) return coordinatorRoot;
    return coordinatorRoot ?? sessionID;
  }

  function pruneInspections(now: number, reserveSlot = false): void {
    pruneInspectionCache(inspected, now, reserveSlot);
    pruneActiveSessions(now);
    pruneCoordinatorRoots(now);
    for (const [key, entry] of inspected) {
      const ownerActive = activeSessions.has(entry.ownerSessionID);
      const ownerRoot = sessionRoots.has(entry.ownerSessionID)
        ? coordinatorRootForSession(entry.ownerSessionID, now)
        : entry.ownerSessionID;
      if (
        !ownerActive || ownerRoot !== entry.rootSessionID ||
        !isAbsolute(entry.projectRoot) || !isAbsolute(entry.handoffPath) || !isAbsolute(entry.manifestPath) ||
        entry.fingerprint.length === 0 || key !== `${entry.ownerSessionID}\u0000${entry.handoffPath}`
      ) inspected.delete(key);
    }
  }

  function activateSession(sessionID: string): void {
    const now = Date.now();
    pruneActiveSessions(now);
    const existing = activeSessions.get(sessionID);
    if (existing !== undefined) activeSessions.delete(sessionID);
    else pruneActiveSessions(now, true);
    expiredSessions.delete(sessionID);
    activeSessions.set(sessionID, {
      deniedSignatures: existing?.deniedSignatures ?? new Set<string>(),
      expiresAt: now + ACTIVE_SESSION_CACHE.ttlMilliseconds,
    });
  }

  function activeSessionStatus(sessionID: string): "active" | "expired" | "inactive" {
    pruneActiveSessions(Date.now());
    return activeSessions.has(sessionID) ? "active"
      : expiredSessions.has(sessionID) ? "expired"
        : "inactive";
  }

  function isActiveSession(sessionID: string): boolean {
    return activeSessionStatus(sessionID) === "active";
  }

  function touchActiveSession(sessionID: string): boolean {
    const now = Date.now();
    pruneActiveSessions(now);
    const state = activeSessions.get(sessionID);
    if (state === undefined) return false;
    activeSessions.delete(sessionID);
    state.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
    activeSessions.set(sessionID, state);
    return true;
  }

  function expireSession(sessionID: string): void {
    activeSessions.delete(sessionID);
    sessionAuthorizations.delete(sessionID);
    for (const key of inspected.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) inspected.delete(key);
    }
    expiredSessions.delete(sessionID);
    expiredSessions.add(sessionID);
    while (expiredSessions.size > ACTIVE_SESSION_CACHE.maximum) {
      expiredSessions.delete(expiredSessions.values().next().value!);
    }
    clearSessionLinks(sessionID);
  }

  function evictSession(sessionID: string): void {
    activeSessions.delete(sessionID);
    sessionAuthorizations.delete(sessionID);
    bindingPins.delete(sessionID);
    for (const key of inspected.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) inspected.delete(key);
    }
    expiredSessions.delete(sessionID);
    coordinatorRoots.delete(sessionID);
    bindingDenials.delete(sessionID);
    clearSessionLinks(sessionID);
  }

  async function inspectSuccessfulRead(input: TaskToolExecuteAfterInput): Promise<void> {
    if (input.tool.toLowerCase() !== "read" || input.sessionID === undefined) return;
    if (activeSessionStatus(input.sessionID) !== "active" || !isRecord(input.args)) return;
    const path = input.args.filePath;
    if (typeof path !== "string" || path.length === 0) return;
    await inspect(path, input.sessionID);
  }

  async function invalidateEditedHandoff(path: string): Promise<void> {
    await ensureLoaded();
    if (loaded === undefined || project === undefined) return;
    const absolutePath = isAbsolute(path)
      ? resolve(path)
      : resolve(input.worktree ?? project.root, path);
    for (const [key, entry] of inspected) {
      if (!samePath(entry.handoffPath, absolutePath)) continue;
      inspected.delete(key);
    }
    for (const authorization of sessionAuthorizations.values()) {
      if (!samePath(authorization.handoffPath, absolutePath)) continue;
      authorization.suspended = true;
    }
  }

  async function pathMatchesProject(root: string): Promise<boolean> {
    if (!isAbsolute(root)) return false;
    project ??= await createProjectPaths(resolveProjectRoot(input));
    const allowedRoots = [project];
    if (input.worktree !== undefined && resolve(input.worktree) !== project.root) {
      allowedRoots.push(await createProjectPaths(resolve(input.worktree)));
    }
    return (await Promise.all(allowedRoots.map((allowed) => allowed.contains(root)))).some(Boolean);
  }

  async function taskMatchesProject(text: string): Promise<boolean> {
    const root = taskProjectRoot(text);
    return root !== undefined && await pathMatchesProject(root);
  }

  async function inheritedTaskRoot(sessionID: string, text: string): Promise<string | undefined> {
    const root = taskProjectRoot(text);
    if (root === undefined || !await taskMatchesProject(text)) return undefined;
    const rootSessionID = coordinatorRootForSession(sessionID);
    if (rootSessionID === undefined) return undefined;
    const lineage = coordinatorRoots.get(rootSessionID);
    if (lineage === undefined) return undefined;
    const lineageProject = await createProjectPaths(lineage.projectRoot);
    return await lineageProject.contains(root) ? rootSessionID : undefined;
  }

  function rememberParent(sessionID: string, parentID: string): void {
    sessionParents.delete(sessionID);
    sessionParents.set(sessionID, parentID);
  }

  async function hostSessionIdentity(
    sessionID: string,
  ): Promise<{ agent?: string; parentID?: string; parentPresent: boolean } | undefined> {
    const get = input.client?.session?.get;
    if (get === undefined) return undefined;
    try {
      const response = await get.call(input.client!.session, {
        path: { id: sessionID },
        query: { directory: input.directory },
      });
      const payload = isRecord(response) && "data" in response ? response.data : response;
      if (!isRecord(payload)) return undefined;
      return {
        ...(typeof payload.agent === "string" ? { agent: payload.agent } : {}),
        ...(typeof payload.parentID === "string" ? { parentID: payload.parentID } : {}),
        parentPresent: "parentID" in payload,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * A long worker or visual validation can outlive the bounded lineage cache, and hosts may deliver a
   * child's first chat message before its session.created event. In both cases the inline handoff is
   * complete but the child looks inactive. Rebuild only the one lineage the host proves: child ->
   * parent root, where that parent is the configured coordinator and itself has no parent. An absent
   * client or incomplete identity remains fail-closed.
   */
  async function recoverCoordinatorLineage(sessionID: string): Promise<string | undefined> {
    const child = await hostSessionIdentity(sessionID);
    if (child?.parentID === undefined) return undefined;
    const parent = await hostSessionIdentity(child.parentID);
    if (parent?.agent !== COORDINATOR_AGENT || parent.parentPresent) return undefined;
    await rememberCoordinatorRoot(child.parentID);
    rememberParent(sessionID, child.parentID);
    return child.parentID;
  }

  function clearSessionLinks(sessionID: string): void {
    sessionParents.delete(sessionID);
    sessionRoots.delete(sessionID);
    for (const [childID, parentID] of sessionParents) {
      if (parentID === sessionID) {
        sessionParents.delete(childID);
        sessionRoots.delete(childID);
      }
    }
  }

  async function reflectionPermitted(sessionID: string, agent?: string): Promise<boolean> {
    if (!reflectionStartup || reflectionStore === undefined || reflectionVersion === undefined || process.env.SORTIE_REFLECTION === "0") return false;
    if (agent !== undefined && agent !== COORDINATOR_AGENT) return false;
    if (!isCoordinatorSession(sessionID) || coordinatorRootForSession(sessionID) !== sessionID || sessionParents.has(sessionID)) return false;
    const identity = await hostSessionIdentity(sessionID);
    if (identity?.agent !== COORDINATOR_AGENT || identity.parentPresent) return false;
    return true;
  }

  async function beginReflection(sessionID: string, agent?: string): Promise<boolean> {
    if (!(await reflectionPermitted(sessionID, agent)) || reflectionClosingRoots.has(sessionID)) return false;
    reflectionOwnedRoots.add(sessionID);
    reflectionInFlight.set(sessionID, (reflectionInFlight.get(sessionID) ?? 0) + 1);
    return true;
  }

  function endReflection(sessionID: string): void {
    const remaining = (reflectionInFlight.get(sessionID) ?? 1) - 1;
    if (remaining > 0) { reflectionInFlight.set(sessionID, remaining); return; }
    reflectionInFlight.delete(sessionID);
    for (const resolve of reflectionWaiters.get(sessionID) ?? []) resolve();
    reflectionWaiters.delete(sessionID);
  }

  async function waitForReflections(sessionID: string): Promise<void> {
    if ((reflectionInFlight.get(sessionID) ?? 0) === 0) return;
    await new Promise<void>((resolve) => (reflectionWaiters.get(sessionID) ?? reflectionWaiters.set(sessionID, []).get(sessionID)!).push(resolve));
  }

  function reflectionWarning(code: string): void {
    const log = (input.client as Record<string, unknown> | undefined)?.app;
    if (!isRecord(log) || typeof log.log !== "function") return;
    try { (log.log as (value: unknown) => unknown)({ level: "warn", service: "sortie-dogs", message: code }); } catch { /* host logging is best effort */ }
  }

  const hooks: OpenCodeHooks = {
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
      sortie_check_contract: defineTool({
        description:
          "Report handoff and operation manifest contract defects before dispatch. Read-only: it never inspects, binds, or authorizes.",
        args: {
          handoff_path: defineTool.schema.string(),
        },
        async execute(args): Promise<string> {
          try {
            await inspect(args.handoff_path, undefined, { report: true });
            return JSON.stringify({ status: "ok", defects: [] });
          } catch (error) {
            if (!(error instanceof HandoffDeniedError)) throw error;
            return JSON.stringify({
              status: "defective",
              reason: error.reason,
              defects: error.defects.slice(0, CONTRACT_DEFECTS.limit),
              remedy: "Repair each reported pointer in the named document, then check it again.",
            });
          }
        },
      }),
      [CONTINUATION_CAPABILITY]: defineTool({
        description: continuation.tool.description,
        args: {},
        async execute(_args, context): Promise<string> {
          // A configuration failure must not remove the loop; the shipped default still resolves.
          await ensureLoaded().catch(() => undefined);
          return await continuation.tool.execute({}, context);
        },
      }),
      ...(reflectionStartup ? {
        sortie_reflection: defineTool({
          description: "Record, promote, or clear a bounded process reflection.",
          args: { action: defineTool.schema.string(), layer: defineTool.schema.string(), scope: optionalString(), trigger: optionalString(), cause: optionalString(), prevention: optionalString(), evidence: optionalString(), evidenceRef: optionalString(), id: optionalString(), promotedRef: optionalString(), confirmation: optionalString() },
          async execute(args, context): Promise<string> {
            if (!(await beginReflection(context.sessionID, context.agent))) return "reflection_not_permitted";
            const layer = args.layer as "run" | "project" | "global";
            try {
              if (!["run", "project", "global"].includes(layer)) return "reflection_invalid_layer";
              if (!(reflectionConfiguration?.layers[layer] ?? false)) return "reflection_not_permitted";
              if (args.action === "record") return JSON.stringify(await reflectionStore!.record(layer, context.sessionID, args, reflectionVersion!));
              if (args.action === "promote") return await reflectionStore!.promote(layer, context.sessionID, args.id, args.promotedRef, reflectionVersion!);
              if (args.action === "clear") return await reflectionStore!.clear(layer, context.sessionID, args.confirmation, reflectionVersion!);
              return "reflection_invalid_action";
            } catch (error) { return error instanceof ReflectionError ? error.code : "reflection_storage_error"; } finally { endReflection(context.sessionID); }
          },
        }),
      } : {}),
    },
    "experimental.text.complete": async (textInput, textOutput): Promise<void> => {
      await continuation.textComplete(textInput, textOutput);
    },
    "experimental.session.compacting": async (compactInput, compactOutput): Promise<void> => {
      await continuation.sessionCompacting(compactInput, compactOutput);
    },
    "experimental.compaction.autocontinue": async (autoInput, autoOutput): Promise<void> => {
      await continuation.compactionAutoContinue(autoInput, autoOutput);
    },
    "chat.message": async (chatInput, output): Promise<void> => {
      const parentID = chatParentID(chatInput);
      if (parentID !== undefined) rememberParent(chatInput.sessionID, parentID);
      const coordinatorOrigin = chatInput.agent === COORDINATOR_AGENT || output.message.agent === COORDINATOR_AGENT;
      if (coordinatorOrigin) {
        releaseSessionEnforcement(chatInput.sessionID);
        await rememberCoordinatorRoot(chatInput.sessionID);
      } else {
        const taskText = explicitTaskText(output);
        let inheritedRoot = taskText === undefined
          ? undefined
          : await inheritedTaskRoot(chatInput.sessionID, taskText);
        if (taskText !== undefined && inheritedRoot === undefined) {
          await recoverCoordinatorLineage(chatInput.sessionID);
          inheritedRoot = await inheritedTaskRoot(chatInput.sessionID, taskText);
        }
        if (inheritedRoot !== undefined) {
          sessionRoots.set(chatInput.sessionID, inheritedRoot);
          activateSession(chatInput.sessionID);
        } else if (activatesSession(chatInput, output)) activateSession(chatInput.sessionID);
        touchActiveSession(chatInput.sessionID);
      }
      /*
       * Role routing is a dispatch policy, not a write-gate concern. Consultation and evidence roles
       * never activate the write gate, so gating routing on session activation left every one of
       * them silently inheriting the caller's model instead of its own configured route.
       */
      await ensureLoaded();
      await loaded?.modelRoutingHook?.(chatInput, output);
      if (coordinatorOrigin) continuation.observeModel(chatInput.sessionID, output.message.model);
    },
    ...(reflectionStartup ? { "experimental.chat.system.transform": async (transformInput: { sessionID: string }, transformOutput: { system?: string[] }): Promise<void> => {
      if (!(await beginReflection(transformInput.sessionID))) return;
      const config = reflectionConfiguration;
      try {
        if (!config) return;
        const buckets = (["run", "project", "global"] as const)
          .filter((layer) => config.layers[layer])
          .map((layer) => ({ layer, ...(layer === "global" ? {} : { run: transformInput.sessionID }) }));
        const text = await reflectionStore!.injectBuckets(buckets, config.maxInjectedEntries, config.maxInjectedTokens, reflectionVersion);
        if (text) transformOutput.system = [...(transformOutput.system ?? []), text];
      } catch { /* reflection is strictly non-invasive */ } finally { endReflection(transformInput.sessionID); }
    } } : {}),
    "permission.ask": async (permission): Promise<void> => {
      if (permission.permission !== "edit") return;
      // Without a session identity no gate can be attributed; tool.execute.before still enforces.
      if (permission.sessionID === undefined) return;
      if (isCoordinatorSession(permission.sessionID)) return;
      const status = activeSessionStatus(permission.sessionID);
      if (status === "inactive") return;
      if (status === "expired") {
        if (!hasSessionEnforcementState(permission.sessionID) && await isUnconfiguredProject()) return;
        throw new WriteDeniedError("session-expired", "<expired-session>");
      }
      touchActiveSession(permission.sessionID);
      const gate = await authorizedGate(permission.sessionID);
      if (gate === undefined) {
        if (!hasSessionEnforcementState(permission.sessionID) && await isUnconfiguredProject()) return;
        throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: loadFailure });
      }
      for (const pattern of permission.patterns) {
        const path = isAbsolute(pattern)
          ? pattern
          : resolve(input.worktree ?? input.directory, pattern);
        await gate.checkPath(path);
      }
    },
    /*
     * Upstream builds a task result from the child's last text part, so a trailing empty text part
     * erases an answer the worker already produced and the coordinator re-dispatches the same work.
     */
    "tool.execute.after": async (toolInput, output): Promise<void> => {
      await createTaskResultRepairHook(input.client)(toolInput, output);
      await inspectSuccessfulRead(toolInput);
    },
    "tool.execute.before": async (toolInput, output): Promise<void> => {
      if (isCoordinatorSession(toolInput.sessionID)) {
        if (continuation.blocksTool(toolInput.sessionID)) {
          throw new Error("SORTIE_ROLLOVER_PENDING: stop this turn and wait for compaction");
        }
        return;
      }
      const status = activeSessionStatus(toolInput.sessionID);
      if (status === "inactive") return;
      if (status === "expired") {
        if (isKnownReadOnlyTool(toolInput.tool, output.args, loaded?.readOnlyTools)) return;
        if (!hasSessionEnforcementState(toolInput.sessionID) && await isUnconfiguredProject()) return;
        throw new WriteDeniedError("session-expired", "<expired-session>");
      }
      touchActiveSession(toolInput.sessionID);
      if (toolInput.tool === "sortie_bind_write_gate") return;
      try {
        const gate = await authorizedGate(toolInput.sessionID);
        if (gate === undefined) {
          if (!hasSessionEnforcementState(toolInput.sessionID) && await isUnconfiguredProject()) return;
          if (!isKnownReadOnlyTool(toolInput.tool, output.args, loaded?.readOnlyTools)) {
            const detail = describeUnclassifiedCommand(toolInput.tool, output.args);
            if (detail !== undefined) throw new WriteDeniedError("unclassified-command", detail);
            const shellTool = /^(?:bash|shell|powershell|pwsh)(?:$|[_-])/iu.test(toolInput.tool);
            throw new WriteDeniedError(
              "manifest-unavailable",
              shellTool ? `<unbound:${toolInput.tool}>` : "<unknown>",
              { cause: loadFailure },
            );
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
          throw new WriteDeniedError("repeated-denial", "<repeated-command>", { cause: error });
        }
        if (denied.size >= SESSION_DENIAL_LIMIT) denied.delete(denied.values().next().value!);
        denied.add(signature);
        throw error;
      }
    },
    event: async ({ event }): Promise<void> => {
      const info = isRecord(event.properties?.info) ? event.properties.info : undefined;
      const eventSessionID = typeof event.properties?.sessionID === "string" ? event.properties.sessionID
        : typeof info?.id === "string" ? info.id
          : undefined;
      if (event.type === "file.edited" && typeof event.properties?.file === "string") {
        // Event session identity is absent in current hosts and cannot be trusted as proof of which
        // child read a file. Every edit therefore revokes state; only a successful Read can grant it.
        await invalidateEditedHandoff(event.properties.file);
        return;
      }
      if (eventSessionID === undefined) return;
      const eventParentID = typeof event.properties?.parentID === "string" ? event.properties.parentID
        : typeof info?.parentID === "string" ? info.parentID
          : undefined;
      if (event.type === "session.created" || event.type === "session.updated") {
        if (eventParentID !== undefined) {
          rememberParent(eventSessionID, eventParentID);
        }
        return;
      }
      if (event.type === "session.deleted") {
        if (reflectionStore !== undefined && reflectionConfiguration?.layers.run && reflectionOwnedRoots.has(eventSessionID)) {
          reflectionClosingRoots.add(eventSessionID);
          await waitForReflections(eventSessionID);
          let deleted = false;
          for (const delay of [0, 50, 250, 1_000, 5_000]) {
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            try { await reflectionStore.deleteRun(eventSessionID); deleted = true; } catch { /* bounded retry below */ }
            if (deleted) break;
          }
          if (deleted) { reflectionOwnedRoots.delete(eventSessionID); reflectionClosingRoots.delete(eventSessionID); }
          else reflectionWarning("reflection_cleanup_failed");
        }
        evictSession(eventSessionID);
        continuation.forgetSession(eventSessionID);
        return;
      }
      /*
       * The coordinator root is deliberately not a write-gate session, so continuation must run
       * before the active-session guard below or the batch could never resume itself.
       */
      if (event.type === "session.compacted") await continuation.sessionCompacted(eventSessionID);
      if (event.type === "session.idle") await continuation.sessionIdle(eventSessionID);
      if (!isActiveSession(eventSessionID)) return;
      if (event.type !== "session.idle") touchActiveSession(eventSessionID);
      if (event.type === "session.idle" && eventSessionID !== undefined) {
        const authorization = sessionAuthorizations.get(eventSessionID);
        if (authorization === undefined) return;
        try {
          // Idle can revalidate a handoff already pinned by a successful bind, but it can never
          // create the first inspection or authorize an unbound child.
          await inspect(authorization.handoffPath, eventSessionID);
        } catch {
          authorization.suspended = true;
        }
      }
    },
  };
  return hooks;
};

export type { SortieDogsPluginOptions } from "./config.js";
export { InvalidModelTargetError, ModelRoutingDeniedError } from "./model-routing-hook.js";
