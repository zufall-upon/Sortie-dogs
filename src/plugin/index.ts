import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { RUNTIME_ASSET_VERSION } from "../asset-version.js";
import { normalizeRelativePath, RelativePathError } from "../core/path.js";
import { ScopeLeaseError, ScopeLeaseRegistry, type ScopeLease } from "../core/scope-lease-registry.js";
import {
  produceWorktreeCommitArtifact,
  recoverWorktreeCommitArtifact,
  WorktreeCommitArtifactError,
} from "../core/worktree-commit-artifact.js";
import { normalizeWorktreeScope } from "../core/worktree-scope.js";
import {
  ParallelDispatchCoordinator,
  ParallelDispatchError,
} from "../core/worktree-parallel-dispatch.js";
import { IntegrationQueueError, WorktreeIntegrationQueue } from "../core/worktree-integration-queue.js";
import type {
  IntegrationQueueSnapshot,
  ManifestDiagnostic,
  OperationManifest,
  ParallelDispatchArchive,
  ParallelDispatchDescriptor,
  ParallelDispatchOutcome,
  ParallelDispatchSnapshot,
  SchemaDiagnostic,
  WorktreeCommitArtifact,
  WorktreeParallelContract,
} from "../core/types.js";
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
  CONTINUATION_MARKER,
  ROLLOVER_MARKER,
  createContinuationHooks,
  type ContinuationClient,
  type ContinuationHooks,
} from "./continuation.js";
import {
  WriteDeniedError,
  canonicalManifestReadScopes,
  canonicalManifestWriteScopes,
  createProjectPaths,
  createWriteGate,
  describeUnclassifiedCommand,
  bootstrapWritePaths,
  isGitMutation,
  isKnownReadOnlyTool,
  isRemoteMutation,
  normalizeCommand,
  resolveProjectRoot,
  safePath,
  writeScopesOverlap,
  type ProjectPaths,
  type ToolExecuteBeforeInput,
  type ToolExecuteBeforeOutput,
  type WriteGate,
} from "./gate.js";
import { BACKLOG_DRAIN_CAPABILITY, FastLaneController } from "./fast-lane.js";
import {
  createModelRoutingHook,
  type OpenCodeChatMessageHook,
  type OpenCodeModelAvailabilityClient,
} from "./model-routing-hook.js";
import {
  createTaskResultRepairHook,
  lastAssistantText,
  markConsultationFallbackRetry,
  taskChildSessionID,
  type SessionMessage,
  type SessionMessageReader,
} from "./task-result-repair.js";
import { configRoot, nearestPackageVersion, reflectionEnabled, ReflectionError, ReflectionStore } from "../reflection/index.js";

const INPUT_LIMITS = { config: 64 * 1024, manifest: 512 * 1024, handoff: 2 * 1024 * 1024, parallel: 512 * 1024 } as const;
const INSPECTION_CACHE = { maximum: 256, ttlMilliseconds: 30 * 60 * 1000 } as const;
const ACTIVE_SESSION_CACHE = { maximum: 256, ttlMilliseconds: 30 * 60 * 1000 } as const;
const SESSION_DENIAL_LIMIT = 256;
const PROJECT_CONFIG_PATH = ".opencode/sortie-dogs.json";
const PROJECT_VERSION_MARKER = ".opencode/sortie-dogs.version";
const ENV_CONFIG = "SORTIE_DOGS_CONFIG";
const COORDINATOR_AGENT = "dog-coordinator";
const REVIEWER_AGENT = "dog-reviewer";
const ADVISOR_AGENT = "dog-advisor";
const CONSULTATION_AGENTS = new Set([REVIEWER_AGENT, ADVISOR_AGENT]);
type ConsultationAgent = typeof REVIEWER_AGENT | typeof ADVISOR_AGENT;
const SORTIE_TRIGGER = /^\/sortie(?:\s|$)/;
const TASK_ROLES = new Set(["implementation", "remediation", "blocker-resolution"]);
const GIT_POINTER_LIMIT = 4096;
const PARALLEL_OUTCOME_MARKER = "SORTIE_PARALLEL_OUTCOME";
export const PARALLEL_COMMIT_ARTIFACT_CAPABILITY = "sortie_create_parallel_commit_artifact";

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
  lease?: ScopeLease;
  manifestHash: string;
  manifestMtimeMs: number;
  manifestPath: string;
  projectRoot: string;
  readScopes: readonly string[];
  rootSessionID: string;
  suspended: boolean;
  validationCommands: ReadonlySet<string>;
  writeScopes: readonly string[];
}

async function readGitMetadata(path: string): Promise<string | undefined> {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata === undefined) return undefined;
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > GIT_POINTER_LIMIT) throw new Error("invalid-git-metadata");
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("invalid-git-metadata");
  return value;
}

/** Resolve one repository-wide lease location without invoking Git or trusting process-local state. */
async function durableScopeRoot(projectRoot: string): Promise<string | undefined> {
  try {
    const dotGit = join(projectRoot, ".git");
    const dotGitStat = await stat(dotGit);
    let gitDirectory: string;
    if (dotGitStat.isDirectory()) {
      gitDirectory = dotGit;
    } else if (dotGitStat.isFile()) {
      const pointer = await readGitMetadata(dotGit);
      const match = pointer === undefined ? undefined : /^gitdir:\s*(.+)$/u.exec(pointer);
      if (match === undefined || match === null) return undefined;
      gitDirectory = resolve(dirname(dotGit), match[1]!);
      if (!(await stat(gitDirectory)).isDirectory()) return undefined;
    } else {
      return undefined;
    }
    const commonPointer = await readGitMetadata(join(gitDirectory, "commondir"));
    const commonDirectory = commonPointer === undefined ? gitDirectory : resolve(gitDirectory, commonPointer);
    if (!(await stat(commonDirectory)).isDirectory()) return undefined;
    return join(commonDirectory, "sortie-dogs", "scope-leases");
  } catch {
    return undefined;
  }
}

interface BindingPin {
  manifestHash: string;
  manifestMtimeMs: number;
  manifestPath: string;
}

interface ActiveSessionState {
  deniedSignatures: Set<string>;
  expiresAt: number;
  inFlightCalls: Set<string>;
  parallel: "none" | "valid" | "invalid";
  released: boolean;
}

interface ParallelChildBinding {
  readonly ownerRoot: string;
  readonly descriptor: ParallelDispatchDescriptor;
  readonly completionCallID: string;
}

interface PendingParallelArtifact {
  readonly requestFingerprint: string;
  readonly artifact: WorktreeCommitArtifact;
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

interface HandoffPathRegistration {
  readonly scopedID?: string;
}

interface InspectedContractIdentity {
  readonly explicitWriteGate: boolean;
  readonly manifestPath: string;
  readonly projectRoot: string;
}

/** Accept a task-scoped sibling of a registered handoff without opening arbitrary directories. */
function relativeHandoffRegistration(
  actualPath: string,
  registeredPath: string,
): HandoffPathRegistration | undefined {
  const normalize = (value: string) => value.replaceAll("\\", "/");
  const actual = normalize(actualPath).split("/");
  const registered = normalize(registeredPath).split("/");
  if (actual.length !== registered.length) return undefined;
  if (!actual.slice(0, -1).every((segment, index) => sameRelativePath(segment, registered[index]!))) {
    return undefined;
  }
  const actualName = actual.at(-1)!;
  const registeredName = registered.at(-1)!;
  if (sameRelativePath(actualName, registeredName)) return {};
  const extensionIndex = registeredName.lastIndexOf(".");
  const stem = extensionIndex > 0 ? registeredName.slice(0, extensionIndex) : registeredName;
  const extension = extensionIndex > 0 ? registeredName.slice(extensionIndex) : "";
  const prefix = `${stem}.`;
  if (!actualName.startsWith(prefix) || !actualName.endsWith(extension)) return undefined;
  const scopedID = actualName.slice(prefix.length, extension.length === 0 ? undefined : -extension.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(scopedID) ? { scopedID } : undefined;
}

function absoluteHandoffRegistration(
  path: string,
  registeredPath: string,
): HandoffPathRegistration | undefined {
  const actual = path.replaceAll("\\", "/").split("/");
  const registered = registeredPath.replaceAll("\\", "/").split("/");
  if (actual.length < registered.length) return undefined;
  return relativeHandoffRegistration(actual.slice(-registered.length).join("/"), registered.join("/"));
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

function handoffValues(text: string, keys: readonly string[]): string[] {
  const accepted = new Set(keys);
  const values: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = HANDOFF_ENTRY.exec(line);
    if (match === null || !accepted.has((match[2] ?? match[3]).toLowerCase())) continue;
    values.push(unquoteValue(unwrapMarkdownValue(match[4])));
  }
  return values;
}

function hasIndentedFieldBody(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^([\\t ]*)${escaped}[\\t ]*:[\\t ]*\\r?\\n\\1[\\t ]+\\S`, "mu").test(text);
}

function hasResumeContractShape(text: string): boolean {
  const fields = text.split(/\r?\n/u).flatMap((line, index) => {
    const match = HANDOFF_ENTRY.exec(line);
    if (match === null) return [];
    return [{
      index,
      indent: /^[\t ]*/u.exec(line)![0].replaceAll("\t", "  ").length,
      key: (match[2] ?? match[3]).toLowerCase(),
      value: unquoteValue(unwrapMarkdownValue(match[4])),
    }];
  });
  const unique = (key: string) => fields.filter((field) => field.key === key);
  const taskID = unique("task_id");
  const digest = unique("context_digest");
  const mode = unique("mode");
  const delta = unique("resume_delta");
  if (
    taskID.length !== 1 || taskID[0]!.value.length === 0 ||
    digest.length !== 1 || digest[0]!.value.length !== 0 ||
    mode.length !== 1 || mode[0]!.value !== "same-task-resume" ||
    delta.length !== 1 || delta[0]!.value.length !== 0
  ) return false;
  const directParent = (field: typeof fields[number]) => {
    for (let index = fields.indexOf(field) - 1; index >= 0; index -= 1) {
      if (fields[index]!.indent < field.indent) return fields[index];
    }
    return undefined;
  };
  const baseIndent = Math.min(...fields.map((field) => field.indent));
  return taskID[0]!.indent === baseIndent && digest[0]!.indent === baseIndent &&
    mode[0]!.index > digest[0]!.index && delta[0]!.index > mode[0]!.index &&
    directParent(mode[0]!) === digest[0] && directParent(delta[0]!) === digest[0] &&
    hasIndentedFieldBody(text, "resume_delta");
}

/*
 * The dispatching coordinator writes user-facing prose in the user's own language, so its role label
 * is the one digest key a localized dispatch is most likely to translate. The role value itself is a
 * protocol token that never localizes, so an unrecognized label still yields the role from any line
 * whose entire value is one of those tokens. Every other required key still has to be present, so a
 * bare resume or an unrelated message cannot activate a session through this path.
 */
const LABELLED_VALUE = /^[\t ]*(?:[-*][\t ]+)?[^\r\n:=]{1,64}[\t ]*[=:][\t ]*(.*)$/u;

function roleTokenValues(text: string): string[] {
  const values: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = LABELLED_VALUE.exec(line);
    if (match === null) continue;
    const value = unquoteValue(unwrapMarkdownValue(match[1])).toLowerCase();
    if (TASK_ROLES.has(value)) values.push(value);
  }
  return values;
}

export function isExplicitTaskHandoff(text: string): boolean {
  const entries = handoffEntries(text);
  const labelledRoles = handoffValues(text, HANDOFF_KEYS.role);
  if (labelledRoles.length > 1) return false;
  const labelled = labelledRoles[0]?.toLowerCase();
  const localizedRoles = roleTokenValues(text);
  const role = labelled === undefined
    ? localizedRoles.length === 1 ? localizedRoles[0] : undefined
    : TASK_ROLES.has(labelled) && localizedRoles.length === 1 && localizedRoles[0] === labelled
      ? labelled
      : undefined;
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

function taskValues(text: string, keys: readonly string[]): string[] {
  return handoffValues(text, keys);
}

function parallelTaskMode(text: string): ActiveSessionState["parallel"] {
  const entries = handoffEntries(text);
  const group = handoffValue(entries, ["parallel_group"]);
  const unit = handoffValue(entries, ["parallel_unit"]);
  const countValue = handoffValue(entries, ["parallel_units"]);
  if (group === undefined && unit === undefined && countValue === undefined) return "none";
  const count = Number(countValue);
  if (group?.toLowerCase() === "none" && unit !== undefined && count === 1) return "none";
  return group !== undefined && group.toLowerCase() !== "none" &&
    unit !== undefined && unit.toLowerCase() !== "none" &&
    Number.isInteger(count) && count >= 2 && count <= 3 ? "valid" : "invalid";
}

function parseStringArray(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.length > 4096) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length <= 256 &&
      parsed.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parallelDescriptor(text: string): ParallelDispatchDescriptor | undefined {
  const unique = (key: string): string | undefined => {
    const values = taskValues(text, [key]);
    return values.length === 1 ? values[0] : undefined;
  };
  const runID = unique("run_id");
  const dispatchID = unique("dispatch_id");
  const taskID = unique("task_id");
  const managedPath = unique("managed_path");
  const branch = unique("branch");
  const baseSHA = unique("base_sha");
  const dependsOn = parseStringArray(unique("depends_on"));
  const scopeRead = parseStringArray(unique("scope_read"));
  const scopeWrite = parseStringArray(unique("scope_write"));
  const group = unique("parallel_group");
  const unit = unique("parallel_unit");
  const units = Number(unique("parallel_units"));
  const attempt = Number(unique("attempt"));
  const contractFingerprint = unique("contract_fingerprint");
  if ([runID, dispatchID, taskID, managedPath, branch, baseSHA, group, unit, contractFingerprint]
    .some((value) => value === undefined) || dependsOn === undefined || scopeRead === undefined ||
    scopeWrite === undefined || !Number.isInteger(units) || !Number.isInteger(attempt)) return undefined;
  return {
    run_id: runID!, dispatch_id: dispatchID!, task_id: taskID!, managed_path: managedPath!, branch: branch!,
    base_sha: baseSHA!, depends_on: dependsOn, scope_read: scopeRead, scope_write: scopeWrite,
    parallel_group: group!, parallel_unit: unit!, parallel_units: units, attempt: attempt as 1,
    contract_fingerprint: contractFingerprint!,
  };
}

function sameParallelDescriptor(left: ParallelDispatchDescriptor, right: ParallelDispatchDescriptor): boolean {
  return inspectionFingerprint(left, undefined) === inspectionFingerprint(right, undefined);
}

function parallelValidationRequest(args: Record<string, string>): {
  readonly validation: { readonly executable: string; readonly args: readonly string[]; readonly timeout_ms?: number };
  readonly fingerprint: string;
} | undefined {
  const keys = Object.keys(args).sort();
  const allowed = new Set(["dispatch_id", "run_id", "timeout_ms", "validation_args_json", "validation_executable"]);
  if (!keys.every((key) => allowed.has(key)) ||
    !["dispatch_id", "run_id", "validation_executable"].every((key) => typeof args[key] === "string") ||
    !isAbsolute(args.validation_executable!) || /[\u0000-\u001f\u007f]/u.test(args.validation_executable!)) return undefined;
  let validationArgs: readonly string[] = [];
  if (args.validation_args_json !== undefined) {
    if (typeof args.validation_args_json !== "string" || args.validation_args_json.length > INPUT_LIMITS.parallel) return undefined;
    try {
      const parsed = JSON.parse(args.validation_args_json) as unknown;
      if (!Array.isArray(parsed) || parsed.length > 128 || !parsed.every((value) =>
        typeof value === "string" && value.length > 0 && value.length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(value))) return undefined;
      validationArgs = parsed;
    } catch {
      return undefined;
    }
  }
  let timeout: number | undefined;
  if (args.timeout_ms !== undefined) {
    if (typeof args.timeout_ms !== "string" || !/^[1-9][0-9]{0,5}$/u.test(args.timeout_ms)) return undefined;
    timeout = Number(args.timeout_ms);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) return undefined;
  }
  const validation = {
    executable: args.validation_executable!,
    args: validationArgs,
    ...(timeout === undefined ? {} : { timeout_ms: timeout }),
  };
  return {
    validation,
    fingerprint: inspectionFingerprint({ run_id: args.run_id, dispatch_id: args.dispatch_id, validation }, undefined),
  };
}

function parallelOutcome(output: unknown): {
  readonly outcome: ParallelDispatchOutcome;
  readonly claimed?: { readonly run_id: string; readonly dispatch_id: string };
} {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 64 * 1024) return { outcome: "failed" };
  const matches = [...output.matchAll(new RegExp(`^${PARALLEL_OUTCOME_MARKER} ([^\\r\\n]{1,512})$`, "gmu"))];
  if (matches.length !== 1) return { outcome: "failed" };
  try {
    const value = JSON.parse(matches[0]![1]!) as unknown;
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== "dispatch_id,run_id,status" ||
      typeof value.run_id !== "string" || typeof value.dispatch_id !== "string" ||
      !["completed", "failed", "blocked", "cancelled"].includes(value.status as string)) return { outcome: "failed" };
    return {
      outcome: value.status as ParallelDispatchOutcome,
      claimed: { run_id: value.run_id, dispatch_id: value.dispatch_id },
    };
  } catch {
    return { outcome: "failed" };
  }
}

function chatParentID(input: Parameters<OpenCodeChatMessageHook>[0]): string | undefined {
  const candidate = input as typeof input & { parentID?: unknown; parentId?: unknown };
  return typeof candidate.parentID === "string" ? candidate.parentID
    : typeof candidate.parentId === "string" ? candidate.parentId
      : undefined;
}

function chatParentPresent(input: Parameters<OpenCodeChatMessageHook>[0]): boolean {
  return Object.prototype.hasOwnProperty.call(input, "parentID") ||
    Object.prototype.hasOwnProperty.call(input, "parentId");
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

function pruneSessionAuthorizations(
  cache: Map<string, SessionAuthorization>,
  active: Map<string, ActiveSessionState>,
  now: number,
): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now) continue;
    if ((active.get(key)?.inFlightCalls.size ?? 0) > 0) {
      entry.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
    } else {
      abandonDetachedLease(entry.lease);
      cache.delete(key);
    }
  }
  while (cache.size >= INSPECTION_CACHE.maximum) {
    const key = cache.keys().next().value!;
    abandonDetachedLease(cache.get(key)?.lease);
    cache.delete(key);
  }
}

function abandonDetachedLease(lease: ScopeLease | undefined): void {
  if (lease === undefined) return;
  void lease.abandon().catch(() => lease.close());
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
  let bootstrapRequired = false;
  let bootstrapCompleted = false;
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
      await reflectionStore.cleanupStaleLocks();
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
  const normalizedCoordinatorDrifts = new Set<string>();
  const completedCoordinatorMessages = new Set<string>();
  const completedCoordinatorParts = new Set<string>();

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
          if (manifestAbsent && !bootstrapCompleted) bootstrapRequired = true;
          throw error;
        }
        manifestAbsent = false;
        const validation = validateOperationManifestSchema(manifestValue);
        if (!validation.ok) throw new WriteDeniedError("manifest-unavailable", "<unknown>");
        loaded.manifest = validation.value;
        loaded.manifestFingerprint = inspectionFingerprint(validation.value, undefined);
        loaded.gate = await createWriteGate(project, validation.value);
        bootstrapRequired = false;
        bootstrapCompleted = true;
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
  const bindingOperations = new Set<string>();
  const activeSessions = new Map<string, ActiveSessionState>();
  const coordinatorRoots = new Map<string, CoordinatorRootLineage>();
  const bootstrapIdleWarnings = new Set<string>();
  const coordinatorTaskCalls = new Map<string, Set<string>>();
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
  const sessionTaskIDs = new Map<string, string>();
  const recoverableWorkerChildren = new Set<string>();
  const consultationRetries = new Map<
    string,
    { readonly phase: "pending" | "routing" | "consumed"; readonly retryChildSessionID?: string }
  >();
  const taskResultRepair = createTaskResultRepairHook(input.client);
  const fastLane = new FastLaneController();
  let parallelCoordinator: ParallelDispatchCoordinator | undefined;
  const integrationQueues = new Map<string, WorktreeIntegrationQueue>();
  const parallelCalls = new Map<string, {
    readonly ownerRoot: string;
    readonly descriptor: ParallelDispatchDescriptor;
    readonly completionCallID: string;
  }>();
  const parallelRecoverableChildren = new Map<string, {
    readonly ownerRoot: string;
    readonly descriptor: ParallelDispatchDescriptor;
    readonly completionCallID: string;
  }>();
  const parallelChildBindings = new Map<string, ParallelChildBinding>();
  const parallelArtifacts = new Map<string, PendingParallelArtifact>();
  const parallelArtifactOperations = new Set<string>();

  interface BootstrapControlState {
    readonly controls: readonly string[];
    readonly missing: readonly string[];
    readonly usable: boolean;
  }

  async function bootstrapControlState(): Promise<BootstrapControlState | undefined> {
    await ensureLoaded();
    if (loaded === undefined || project === undefined || loaded.operationManifestAbsolutePath === undefined) {
      return undefined;
    }
    const controls = [...new Set([
      loaded.operationManifestAbsolutePath,
      ...loaded.handoffPaths,
    ].map((path) => resolve(path)))];
    const missing: string[] = [];
    for (const path of controls) {
      if (!await project.contains(path)) return undefined;
      try {
        if (!(await stat(path)).isFile()) return undefined;
      } catch (error) {
        if (!isRecord(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) return undefined;
        missing.push(path);
      }
    }
    return { controls, missing, usable: loaded.gate !== undefined || manifestAbsent };
  }

  async function isExactCoordinatorRoot(toolInput: ToolExecuteBeforeInput): Promise<boolean> {
    if (
      !isCoordinatorSession(toolInput.sessionID) ||
      coordinatorRootForSession(toolInput.sessionID) !== toolInput.sessionID ||
      sessionParents.has(toolInput.sessionID) ||
      (toolInput.agent !== undefined && toolInput.agent !== COORDINATOR_AGENT)
    ) return false;
    const identity = await hostSessionIdentity(toolInput.sessionID);
    return identity === undefined || (
      !identity.parentPresent &&
      (identity.agent === undefined || identity.agent === COORDINATOR_AGENT)
    );
  }

  async function permitsBootstrapWrite(
    toolInput: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
    _state: BootstrapControlState,
  ): Promise<boolean> {
    if (!await isExactCoordinatorRoot(toolInput)) return false;
    const targets = bootstrapWritePaths(toolInput.tool, output.args);
    if (targets === undefined || project === undefined) return false;
    const absolutes = targets.map((target) => isAbsolute(target)
      ? resolve(target)
      : resolve(input.worktree ?? input.directory, target));
    if (new Set(absolutes.map((path) => process.platform === "win32" ? path.toLowerCase() : path)).size !== absolutes.length) return false;
    let manifests = 0;
    let handoffs = 0;
    for (const absolute of absolutes) {
      if (!await project.contains(absolute) || dirname(absolute) !== project.root) return false;
      const name = basename(absolute);
      if (name === "operation-manifest.json" || name.endsWith(".operation-manifest.json")) manifests += 1;
      else if (name === "handoff.json" || (/^handoff[.-].+\.json$/u.test(name))) handoffs += 1;
      else return false;
    }
    if (manifests > 1 || handoffs > 1 || manifests + handoffs !== absolutes.length) return false;
    return true;
  }

  function successfulBootstrapContractCheck(value: unknown): boolean {
    if (!isRecord(value) || typeof value.output !== "string") return false;
    try {
      const result = JSON.parse(value.output) as unknown;
      return isRecord(result) && result.status === "ok" && Array.isArray(result.defects) && result.defects.length === 0;
    } catch { return false; }
  }

  async function getParallelCoordinator(): Promise<ParallelDispatchCoordinator> {
    project ??= await createProjectPaths(resolveProjectRoot(input));
    parallelCoordinator ??= await ParallelDispatchCoordinator.open({ repositoryRoot: project.root });
    return parallelCoordinator;
  }

  async function getIntegrationQueue(targetBranch: string): Promise<WorktreeIntegrationQueue> {
    project ??= await createProjectPaths(resolveProjectRoot(input));
    const key = `${project.root}\u0000${targetBranch}`;
    const cached = integrationQueues.get(key);
    if (cached !== undefined) return cached;
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: project.root, targetBranch });
    while (integrationQueues.size >= 4) integrationQueues.delete(integrationQueues.keys().next().value!);
    integrationQueues.set(key, queue);
    return queue;
  }

  function validIntegrationInput(value: string, maximum = 256): boolean {
    return value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
  }

  async function integrationToolOwner(context: { sessionID: string; agent?: string }): Promise<string | undefined> {
    if (context.agent !== undefined && context.agent !== COORDINATOR_AGENT) return undefined;
    if (!await recoverCoordinatorRoot(context.sessionID) || coordinatorRootForSession(context.sessionID) !== context.sessionID) return undefined;
    const identity = await hostSessionIdentity(context.sessionID);
    return identity === undefined || (identity.agent === COORDINATOR_AGENT && !identity.parentPresent)
      ? context.sessionID
      : undefined;
  }

  function boundedIntegrationSnapshot(snapshot: IntegrationQueueSnapshot, targetBranch: string): object {
    return {
      run_id: snapshot.run_id,
      target_branch: targetBranch,
      phase: snapshot.phase,
      candidate: snapshot.candidate_head,
      blocker: snapshot.blocker,
      validation: snapshot.validation,
      review: snapshot.review,
      remediation_attempts_used: snapshot.remediation_attempts_used,
      failure_code: snapshot.failure_code,
      tasks: snapshot.tasks.map(({ task_id, source_commit, original_source_commit, synthetic_commit, integrated }) => ({
        task_id,
        source_commit,
        original_source_commit,
        synthetic_commit,
        integrated,
      })),
      cleanup_pending: snapshot.cleanup_pending.length,
      cleanup_pending_visible: snapshot.cleanup_pending.length > 0,
      warnings: snapshot.warnings.map((warning) => warning.startsWith("cleanup-pending:") ? "cleanup-pending" : "warning"),
    };
  }

  async function parallelIntegration(
    action: "enqueue" | "prepare" | "accept" | "remediation" | "status",
    args: Record<string, string>,
    context: { sessionID: string; agent?: string },
  ): Promise<string> {
    const deny = (reason: string) => JSON.stringify({ status: "denied", reason });
    const runID = args.run_id;
    const targetBranch = args.target_branch;
    if (!validIntegrationInput(runID ?? "", 64) || !validIntegrationInput(targetBranch ?? "")) return deny("invalid-request");
    const ownerRoot = await integrationToolOwner(context);
    if (ownerRoot === undefined) return deny("coordinator-root-required");
    try {
      const queue = await getIntegrationQueue(targetBranch!);
      if (action === "status") {
        const snapshot = await queue.snapshot(ownerRoot, runID!);
        return snapshot === undefined ? JSON.stringify({ status: "absent" })
          : JSON.stringify({ status: "ok", ...boundedIntegrationSnapshot(snapshot, targetBranch!) });
      }
      if (action === "enqueue") {
        const archive = await (await getParallelCoordinator()).archive(ownerRoot, runID!);
        if (archive === undefined) return deny("archive-required");
        return JSON.stringify({ status: "queued", ...boundedIntegrationSnapshot(await queue.enqueue(ownerRoot, archive), targetBranch!) });
      }
      if (action === "prepare") {
        const snapshot = await queue.prepare(ownerRoot, runID!);
        return JSON.stringify({ status: snapshot.phase, ...boundedIntegrationSnapshot(snapshot, targetBranch!) });
      }
      if (action === "accept") {
        const candidateHead = args.candidate_head;
        const review = args.review;
        const reviewFingerprint = args.review_fingerprint;
        if (!validIntegrationInput(candidateHead ?? "", 128) || !["pass", "fail"].includes(review ?? "") ||
          !/^[a-f0-9]{64}$/u.test(reviewFingerprint ?? "")) return deny("invalid-request");
        const snapshot = await queue.accept(ownerRoot, runID!, {
          candidate_head: candidateHead!,
          review: review as "pass" | "fail",
          review_fingerprint: reviewFingerprint!,
        });
        return JSON.stringify({ status: snapshot.phase, ...boundedIntegrationSnapshot(snapshot, targetBranch!) });
      }
      if (action === "remediation") {
        const artifactJson = args.artifact_json;
        if (typeof artifactJson !== "string" || Buffer.byteLength(artifactJson, "utf8") > 64 * 1024 ||
          /[\u0000-\u001f\u007f]/u.test(artifactJson)) return deny("invalid-request");
        let artifact: WorktreeCommitArtifact;
        try {
          artifact = JSON.parse(artifactJson) as WorktreeCommitArtifact;
        } catch {
          return deny("invalid-request");
        }
        const snapshot = await queue.submitRemediation(ownerRoot, runID!, artifact);
        return JSON.stringify({ status: snapshot.phase, ...boundedIntegrationSnapshot(snapshot, targetBranch!) });
      }
      return deny("invalid-request");
    } catch (error) {
      return deny(error instanceof IntegrationQueueError ? error.code : "integration-unavailable");
    }
  }

  async function parallelToolOwner(sessionID: string): Promise<string | undefined> {
    if (!await recoverCoordinatorRoot(sessionID)) return undefined;
    const identity = await hostSessionIdentity(sessionID);
    return identity === undefined || (identity.agent === COORDINATOR_AGENT && !identity.parentPresent)
      ? sessionID
      : undefined;
  }

  function boundedParallelArtifact(artifact: WorktreeCommitArtifact | null): object | null {
    return artifact === null ? null : {
      task_id: artifact.task_id,
      base_sha: artifact.base_sha,
      commit_sha: artifact.commit_sha,
      branch: artifact.branch,
      changed_paths: artifact.changed_paths,
      change_fingerprint: artifact.change_fingerprint,
      validation: artifact.validation,
    };
  }

  function boundedParallelSnapshot(snapshot: ParallelDispatchSnapshot): object {
    return {
      run_id: snapshot.run_id,
      max_workers: snapshot.max_workers,
      cancelled: snapshot.cancelled,
      archived: snapshot.archived,
      terminal_reason: snapshot.terminal_reason,
      ready: snapshot.ready,
      tasks: snapshot.tasks.map(({ descriptor, worktree_id, phase, call_id, child_session_id, outcome, artifact }) => ({
        task_id: descriptor.task_id,
        worktree_id,
        dispatch_id: descriptor.dispatch_id,
        managed_path: descriptor.managed_path,
        branch: descriptor.branch,
        base_sha: descriptor.base_sha,
        phase,
        call_id,
        child_session_id,
        outcome,
        artifact: boundedParallelArtifact(artifact),
      })),
    };
  }

  function boundedParallelArchive(archive: ParallelDispatchArchive): object {
    return {
      run_id: archive.run_id,
      contract_fingerprint: archive.contract_fingerprint,
      cancelled: archive.cancelled,
      terminal_reason: archive.terminal_reason,
      tasks: archive.tasks.map(({ task_id, worktree_id, managed_path, branch, base_sha, dispatch_id, phase,
        call_id, child_session_id, outcome, artifact }) => ({
        task_id, worktree_id, managed_path, branch, base_sha, dispatch_id, phase, call_id, child_session_id, outcome,
        artifact: boundedParallelArtifact(artifact),
      })),
    };
  }

  function pruneParallelChildMap<T>(map: Map<string, T>): void {
    while (map.size > ACTIVE_SESSION_CACHE.maximum) map.delete(map.keys().next().value!);
  }

  async function createParallelCommitArtifact(
    args: Record<string, string>,
    context: { sessionID: string; agent?: string },
  ): Promise<string> {
    const deny = (reason: string): string => JSON.stringify({ status: "denied", reason });
    const sessionID = context.sessionID;
    if (context.agent !== undefined && context.agent !== "dog-worker") return deny("worker-required");
    const request = parallelValidationRequest(args);
    if (request === undefined) return deny("invalid-request");
    const active = activeSessions.get(sessionID);
    const binding = parallelChildBindings.get(sessionID);
    const authorization = sessionAuthorizations.get(sessionID);
    if (active === undefined || active.parallel !== "valid" || active.released || binding === undefined ||
      coordinatorRootForSession(sessionID) !== binding.ownerRoot || sessionParents.get(sessionID) !== binding.ownerRoot ||
      args.run_id !== binding.descriptor.run_id || args.dispatch_id !== binding.descriptor.dispatch_id) {
      return deny("parallel-worker-required");
    }
    if (active.inFlightCalls.size > 1) return deny("tools-in-flight");
    if (authorization === undefined || authorization.suspended || authorization.lease === undefined ||
      authorization.rootSessionID !== binding.ownerRoot || !samePath(authorization.projectRoot, binding.descriptor.managed_path)) {
      return deny("authorization-unavailable");
    }
    const existing = parallelArtifacts.get(sessionID);
    if (existing !== undefined) {
      return existing.requestFingerprint === request.fingerprint
        ? JSON.stringify({ status: "created", replay: true, artifact: boundedParallelArtifact(existing.artifact) })
        : deny("artifact-replay");
    }
    if (parallelArtifactOperations.has(sessionID)) return deny("artifact-replay");
    try {
      await authorization.lease.assertHeld();
      const snapshot = await (await getParallelCoordinator()).snapshot(binding.ownerRoot, binding.descriptor.run_id);
      const running = snapshot?.tasks.find((task) => task.phase === "running" &&
        task.descriptor.dispatch_id === binding.descriptor.dispatch_id && sameParallelDescriptor(task.descriptor, binding.descriptor));
      if (running === undefined) return deny("dispatch-inactive");
      if (running.artifact !== null) {
        const executable = await realpath(request.validation.executable).catch(() => undefined);
        if (executable === undefined) return deny("invalid-request");
        const requestedCommand = [executable, ...request.validation.args];
        if (JSON.stringify(running.artifact.validation.command) !== JSON.stringify(requestedCommand)) {
          return deny("artifact-replay");
        }
        await (await getParallelCoordinator()).acceptArtifact(binding.ownerRoot, binding.completionCallID,
          sessionID, binding.descriptor, running.artifact);
        parallelArtifacts.set(sessionID, { requestFingerprint: request.fingerprint, artifact: running.artifact });
        pruneParallelChildMap(parallelArtifacts);
        return JSON.stringify({ status: "created", replay: true, artifact: boundedParallelArtifact(running.artifact) });
      }
      parallelArtifactOperations.add(sessionID);
      const produceRequest = {
        descriptor: binding.descriptor,
        managed_path: binding.descriptor.managed_path,
        validation: request.validation,
      };
      const recovered = await recoverWorktreeCommitArtifact(produceRequest);
      const artifact = recovered ?? await produceWorktreeCommitArtifact(produceRequest);
      await (await getParallelCoordinator()).acceptArtifact(binding.ownerRoot, binding.completionCallID,
        sessionID, binding.descriptor, artifact);
      parallelArtifacts.set(sessionID, { requestFingerprint: request.fingerprint, artifact });
      pruneParallelChildMap(parallelArtifacts);
      return JSON.stringify({ status: "created", ...(recovered === undefined ? {} : { replay: true }),
        artifact: boundedParallelArtifact(artifact) });
    } catch (error) {
      return deny(error instanceof WorktreeCommitArtifactError ? `artifact-${error.code}` : "artifact-production-failed");
    } finally {
      parallelArtifactOperations.delete(sessionID);
    }
  }

  async function prepareParallelDispatch(sessionID: string, contractPath: string): Promise<string> {
    try {
      const ownerRoot = await parallelToolOwner(sessionID);
      project ??= await createProjectPaths(resolveProjectRoot(input));
      if (ownerRoot === undefined || !isAbsolute(contractPath) ||
        !await project.contains(contractPath)) return JSON.stringify({ status: "denied", reason: "project-boundary" });
      const contract = await readJson(resolve(contractPath), INPUT_LIMITS.parallel) as WorktreeParallelContract;
      const result = await (await getParallelCoordinator()).prepare(contract, ownerRoot);
      if (result.status === "serial-fallback") return JSON.stringify(result);
      const dispatched = result.snapshot.tasks.filter(({ phase }) =>
        phase === "running" || phase === "completed" || phase === "failed" || phase === "abandoned").length;
      const running = result.snapshot.tasks.filter(({ phase }) => phase === "running").length;
      fastLane.enableParallelDispatch(ownerRoot, result.snapshot.max_workers, dispatched, running, result.snapshot.tasks.length);
      return JSON.stringify({ status: "prepared", ...boundedParallelSnapshot(result.snapshot) });
    } catch (error) {
      const reason = error instanceof ParallelDispatchError ? error.code
        : error instanceof PluginInputError ? `input-${error.reason}`
          : "parallel-unavailable";
      return JSON.stringify({ status: "denied", reason });
    }
  }

  async function parallelDispatchStatus(sessionID: string, runID: string, reconcile: string): Promise<string> {
    try {
      const ownerRoot = await parallelToolOwner(sessionID);
      if (ownerRoot === undefined) return JSON.stringify({ status: "denied", reason: "coordinator-root-required" });
      const coordinator = await getParallelCoordinator();
      const snapshot = reconcile === "true"
        ? await coordinator.reconcile(ownerRoot, coordinatorTaskCalls.get(ownerRoot) ?? new Set(), runID || undefined)
        : await coordinator.snapshot(ownerRoot, runID || undefined);
      if (snapshot === undefined && !runID) {
        const archived = await coordinator.archives(ownerRoot);
        return JSON.stringify({ status: "ok", active: null, archived: archived.map(boundedParallelArchive) });
      }
      if (snapshot === undefined && runID) {
        const archived = (await coordinator.archives(ownerRoot)).find((entry) => entry.run_id === runID);
        return archived === undefined
          ? JSON.stringify({ status: "absent" })
          : JSON.stringify({ status: "archived", archive: boundedParallelArchive(archived) });
      }
      return snapshot === undefined
        ? JSON.stringify({ status: "absent" })
        : JSON.stringify({ status: "ok", ...boundedParallelSnapshot(snapshot),
          ...(!runID && !snapshot.archived
            ? { archived_history: (await coordinator.archives(ownerRoot)).map(boundedParallelArchive) }
            : {}) });
    } catch (error) {
      return JSON.stringify({
        status: "denied",
        reason: error instanceof ParallelDispatchError ? error.code : "parallel-unavailable",
      });
    }
  }

  async function cancelParallelDispatch(sessionID: string, runID: string): Promise<string> {
    try {
      const ownerRoot = await parallelToolOwner(sessionID);
      if (ownerRoot === undefined) return JSON.stringify({ status: "denied", reason: "coordinator-root-required" });
      const snapshot = await (await getParallelCoordinator()).cancel(ownerRoot, runID || undefined);
      return snapshot === undefined
        ? JSON.stringify({ status: "absent" })
        : JSON.stringify({ status: "cancelled", ...boundedParallelSnapshot(snapshot) });
    } catch (error) {
      return JSON.stringify({
        status: "denied",
        reason: error instanceof ParallelDispatchError ? error.code : "parallel-unavailable",
      });
    }
  }

  function abandonSessionLease(sessionID: string): void {
    const authorization = sessionAuthorizations.get(sessionID);
    if (authorization?.lease !== undefined) {
      abandonDetachedLease(authorization.lease);
      authorization.lease = undefined;
    }
  }

  async function completeContinuationText(sessionID: string, text: string): Promise<void> {
    await continuation.textComplete({
      sessionID,
      allowCheckpointContinuation: fastLane.backlogContinuationAllowed(sessionID),
    }, { text });
    if (fastLane.backlogContinuationAllowed(sessionID) && continuation.blocksTool(sessionID)) {
      fastLane.continuationQueued(sessionID);
    }
  }

  function beginCoordinatorTask(sessionID: string, callID: string): void {
    const calls = coordinatorTaskCalls.get(sessionID) ?? new Set<string>();
    calls.add(callID);
    coordinatorTaskCalls.set(sessionID, calls);
  }

  function finishCoordinatorTask(sessionID: string | undefined, callID: string | undefined): void {
    if (sessionID === undefined || callID === undefined) return;
    const calls = coordinatorTaskCalls.get(sessionID);
    if (calls === undefined) return;
    calls.delete(callID);
    if (calls.size === 0) coordinatorTaskCalls.delete(sessionID);
  }

  function childHasInFlightParentTask(sessionID: string): boolean {
    const parentID = sessionParents.get(sessionID);
    return parentID !== undefined && (coordinatorTaskCalls.get(parentID)?.size ?? 0) > 0;
  }

  function abortCoordinatorTasks(sessionID: string, preserveRecoverable = false): void {
    coordinatorTaskCalls.delete(sessionID);
    for (const [childID, parentID] of [...sessionParents]) {
      if (parentID === sessionID && (!preserveRecoverable || !recoverableWorkerChildren.has(childID))) {
        evictSession(childID);
      }
    }
  }

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
  ): Promise<InspectedContractIdentity | undefined> {
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
    const candidateRegistration = loaded.handoffRelativePaths.find((candidate) =>
      absoluteHandoffRegistration(absolutePath, candidate) !== undefined
    );
    if (!exactRegisteredPath && candidateRegistration === undefined) {
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
        const registration = loaded.handoffRelativePaths
          .map((candidate) => relativeHandoffRegistration(relativeHandoffPath, candidate))
          .find((candidate) => candidate !== undefined);
        if (!exactRegisteredPath && registration === undefined) {
          unregistered("handoff_path_not_registered");
          return;
        }
        if (registration?.scopedID !== undefined && registration.scopedID !== validation.value.id) {
          throw new HandoffDeniedError("contract-invalid", path, {
            defects: [contractDefect("handoff", "/id", "handoff_path_scope_mismatch")],
          });
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

    const identity = {
      explicitWriteGate: extension !== undefined,
      manifestPath,
      projectRoot: inspectedProjectRoot,
    };
    if (sessionID === undefined) return identity;
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
    pruneSessionAuthorizations(sessionAuthorizations, activeSessions, now);
    return identity;
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
      "binding-in-flight": {
        recoverable: true,
        remedy: "Wait for the current bind or release operation in this session to finish, then retry once.",
      },
      "manifest-overlap": {
        recoverable: true,
        remedy: "Wait for the conflicting worker to release its write gate, or repartition the parallel units into non-overlapping manifests before resuming this session.",
      },
      "parallel-contract-invalid": {
        recoverable: false,
        remedy: "Redispatch a fresh worker with parallel_group, parallel_unit, and parallel_units=2..3 all present, or omit all three fields for serial work.",
      },
      "durable-scope-unavailable": {
        recoverable: false,
        remedy: "Use a Git worktree with readable .git metadata before starting parallel implementation.",
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
    if (bindingOperations.has(sessionID)) return deny("binding-in-flight");
    bindingOperations.add(sessionID);
    try {
      const sessionStatus = activeSessionStatus(sessionID);
      if (sessionStatus !== "active") {
        return deny(sessionStatus === "expired" ? "session-expired" : "session-inactive");
      }
      if (activeSessions.get(sessionID)?.parallel === "invalid") {
        return deny("parallel-contract-invalid");
      }
      touchActiveSession(sessionID);
      const now = Date.now();
      pruneSessionAuthorizations(sessionAuthorizations, activeSessions, now);
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
      const conflictsWithActiveAuthorization = (
        writeScopes: readonly string[],
        readScopes: readonly string[],
      ): boolean =>
        [...sessionAuthorizations.entries()].some(([ownerSessionID, authorization]) =>
          ownerSessionID !== sessionID && !authorization.suspended &&
          (writeScopesOverlap(writeScopes, authorization.writeScopes) ||
            writeScopesOverlap(writeScopes, authorization.readScopes) ||
            writeScopesOverlap(readScopes, authorization.writeScopes))
        );
      const acquireDurableLease = async (
        readScopes: readonly string[],
        writeScopes: readonly string[],
      ): Promise<ScopeLease | undefined> => {
        if (activeSessions.get(sessionID)?.parallel !== "valid") return undefined;
        const scopeRoot = await durableScopeRoot(candidate.root);
        if (scopeRoot === undefined) return undefined;
        const relativeScope = normalizeWorktreeScope({
          read: await Promise.all(readScopes.map((path) => candidate.toRelativePath(path))),
          write: await Promise.all(writeScopes.map((path) => candidate.toRelativePath(path))),
        });
        return await new ScopeLeaseRegistry(scopeRoot).acquire({
          ownerId: `${process.pid}:${sessionID}`,
          scope: relativeScope,
        });
      };
      if (existingAuthorization !== undefined) {
        if (conflictsWithActiveAuthorization(
          existingAuthorization.writeScopes,
          existingAuthorization.readScopes,
        )) {
          return deny("manifest-overlap", [
            contractDefect("manifest", "/write", "parallel_write_scope_overlap"),
          ]);
        }
        if (activeSessions.get(sessionID)?.parallel === "valid") {
          try {
            if (existingAuthorization.lease === undefined) {
              existingAuthorization.lease = await acquireDurableLease(
                existingAuthorization.readScopes,
                existingAuthorization.writeScopes,
              );
              if (existingAuthorization.lease === undefined) return deny("durable-scope-unavailable");
            } else {
              await existingAuthorization.lease.assertHeld();
            }
          } catch (error) {
            if (error instanceof ScopeLeaseError && error.code === "not-held") {
              existingAuthorization.lease = undefined;
            }
            return error instanceof ScopeLeaseError && error.code === "scope-conflict"
              ? deny("manifest-overlap", [
              contractDefect("manifest", "/write", "parallel_write_scope_overlap"),
              ])
              : deny("durable-scope-unavailable");
          }
        }
        existingAuthorization.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
        existingAuthorization.suspended = false;
        const activeState = activeSessions.get(sessionID);
        if (activeState !== undefined) activeState.released = false;
        return JSON.stringify({
          status: "bound",
          manifest_hash: pinned.hash,
          manifest_path: relativeManifestPath,
          idempotent: true,
        });
      }
      const gate = await createWriteGate(candidate, validation.value);
      const readScopes = await canonicalManifestReadScopes(candidate, validation.value);
      const writeScopes = await canonicalManifestWriteScopes(candidate, validation.value);
      // Keep conflict detection and registration in one JavaScript turn so competing binds fail closed.
      if (conflictsWithActiveAuthorization(writeScopes, readScopes)) {
        return deny("manifest-overlap", [
          contractDefect("manifest", "/write", "parallel_write_scope_overlap"),
        ]);
      }
      let lease: ScopeLease | undefined;
      if (activeSessions.get(sessionID)?.parallel === "valid") {
        const scopeRoot = await durableScopeRoot(candidate.root);
        if (scopeRoot === undefined) return deny("durable-scope-unavailable");
        try {
          lease = await acquireDurableLease(readScopes, writeScopes);
        } catch (error) {
          return error instanceof ScopeLeaseError && error.code === "scope-conflict"
            ? deny("manifest-overlap", [
            contractDefect("manifest", "/write", "parallel_write_scope_overlap"),
            ])
            : deny("durable-scope-unavailable");
        }
        if (lease === undefined) return deny("durable-scope-unavailable");
      }
      try {
        bindingPins.set(sessionID, {
          manifestHash: pinned.hash,
          manifestMtimeMs: pinned.mtimeMs,
          manifestPath,
        });
        sessionAuthorizations.set(sessionID, {
          gate,
          expiresAt: now + ACTIVE_SESSION_CACHE.ttlMilliseconds,
          handoffPath: inspectedEntry.handoffPath,
          ...(lease === undefined ? {} : { lease }),
          manifestHash: pinned.hash,
          manifestMtimeMs: pinned.mtimeMs,
          manifestPath,
          projectRoot: candidate.root,
          readScopes,
          rootSessionID: inspectedEntry.rootSessionID,
          suspended: false,
          validationCommands: new Set(validation.value.validation.map(normalizeCommand)),
          writeScopes,
        });
      } catch (error) {
        bindingPins.delete(sessionID);
        sessionAuthorizations.delete(sessionID);
        if (lease !== undefined) {
          await lease.abandon().catch(() => lease.close());
        }
        throw error;
      }
      const activeState = activeSessions.get(sessionID);
      if (activeState !== undefined) activeState.released = false;
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
    } finally {
      bindingOperations.delete(sessionID);
    }
  }

  async function releaseWriteGate(sessionID: string): Promise<string> {
    if (bindingOperations.has(sessionID)) {
      return JSON.stringify({ status: "denied", reason: "binding-in-flight" });
    }
    const authorization = sessionAuthorizations.get(sessionID);
    if (authorization === undefined) return JSON.stringify({ status: "unbound" });
    if ((activeSessions.get(sessionID)?.inFlightCalls.size ?? 0) > 0) {
      return JSON.stringify({ status: "denied", reason: "tools-in-flight" });
    }
    bindingOperations.add(sessionID);
    try {
      const idempotent = authorization.suspended;
      if (!idempotent && authorization.lease !== undefined) {
        try {
          await authorization.lease.release();
          authorization.lease = undefined;
        } catch (error) {
          if (!(error instanceof ScopeLeaseError) || error.code !== "not-held") {
            return JSON.stringify({ status: "denied", reason: "durable-scope-unavailable" });
          }
          authorization.lease = undefined;
        }
      }
      authorization.suspended = true;
      for (const key of inspected.keys()) {
        if (key.startsWith(`${sessionID}\u0000`)) inspected.delete(key);
      }
      const activeState = activeSessions.get(sessionID);
      if (activeState !== undefined) activeState.released = true;
      return JSON.stringify({ status: "released", ...(idempotent ? { idempotent: true } : {}) });
    } finally {
      bindingOperations.delete(sessionID);
    }
  }

  async function sessionGate(sessionID: string | undefined): Promise<WriteGate | undefined> {
    const now = Date.now();
    pruneSessionAuthorizations(sessionAuthorizations, activeSessions, now);
    if (sessionID === undefined) return undefined;
      const authorization = sessionAuthorizations.get(sessionID);
      if (authorization === undefined) return undefined;
      if (authorization.suspended) return undefined;
    try {
      await authorization.lease?.assertHeld();
      const pinned = await readPinnedJson(authorization.manifestPath, INPUT_LIMITS.manifest);
      const manifestValidation = validateOperationManifestSchema(pinned.value);
      if (!manifestValidation.ok) throw new Error("manifest-invalid");
      if (pinned.hash !== authorization.manifestHash || pinned.mtimeMs !== authorization.manifestMtimeMs) {
        throw new Error("authorization-stale");
      }
      authorization.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
      return authorization.gate;
    } catch (error) {
      if (error instanceof ScopeLeaseError && error.code !== "not-held") return undefined;
      authorization.suspended = true;
      const lease = authorization.lease;
      if (lease !== undefined) await lease.abandon().catch(() => lease.close());
      authorization.lease = undefined;
      return undefined;
    }
  }

  async function authorizedGate(sessionID: string): Promise<WriteGate | undefined> {
    return await sessionGate(sessionID);
  }

  function pruneActiveSessions(now: number, reserveSlot = false): void {
    for (const [sessionID, state] of activeSessions) {
      if (state.expiresAt > now) continue;
      if (state.inFlightCalls.size > 0) state.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
      else expireSession(sessionID);
    }
    const limit = ACTIVE_SESSION_CACHE.maximum - (reserveSlot ? 1 : 0);
    while (activeSessions.size > limit) expireSession(activeSessions.keys().next().value!);
  }

  function pruneCoordinatorRoots(now: number, reserveSlot = false): void {
    for (const [sessionID, state] of coordinatorRoots) {
      if (state.expiresAt > now) continue;
      const hasInFlightChild = [...sessionRoots.entries()].some(([childID, rootID]) =>
        rootID === sessionID && (activeSessions.get(childID)?.inFlightCalls.size ?? 0) > 0
      );
      if (hasInFlightChild) state.expiresAt = now + ACTIVE_SESSION_CACHE.ttlMilliseconds;
      else coordinatorRoots.delete(sessionID);
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
    abandonSessionLease(sessionID);
    sessionAuthorizations.delete(sessionID);
    bindingPins.delete(sessionID);
    expiredSessions.delete(sessionID);
    parallelChildBindings.delete(sessionID);
    parallelArtifacts.delete(sessionID);
    parallelArtifactOperations.delete(sessionID);
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

  function activateSession(sessionID: string, parallel: ActiveSessionState["parallel"] = "none"): void {
    const now = Date.now();
    pruneActiveSessions(now);
    const existing = activeSessions.get(sessionID);
    if (existing !== undefined) activeSessions.delete(sessionID);
    else pruneActiveSessions(now, true);
    expiredSessions.delete(sessionID);
    activeSessions.set(sessionID, {
      deniedSignatures: existing?.deniedSignatures ?? new Set<string>(),
      expiresAt: now + ACTIVE_SESSION_CACHE.ttlMilliseconds,
      inFlightCalls: existing?.inFlightCalls ?? new Set<string>(),
      parallel: existing?.parallel === "valid" ? "valid" : parallel,
      released: existing?.released ?? false,
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
    abandonSessionLease(sessionID);
    sessionAuthorizations.delete(sessionID);
    if (!childHasInFlightParentTask(sessionID)) {
      parallelChildBindings.delete(sessionID);
      parallelArtifacts.delete(sessionID);
      parallelArtifactOperations.delete(sessionID);
    }
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
    abandonSessionLease(sessionID);
    sessionAuthorizations.delete(sessionID);
    bindingPins.delete(sessionID);
    for (const key of inspected.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) inspected.delete(key);
    }
    expiredSessions.delete(sessionID);
    coordinatorRoots.delete(sessionID);
    bindingDenials.delete(sessionID);
    sessionTaskIDs.delete(sessionID);
    recoverableWorkerChildren.delete(sessionID);
    parallelRecoverableChildren.delete(sessionID);
    parallelChildBindings.delete(sessionID);
    parallelArtifacts.delete(sessionID);
    parallelArtifactOperations.delete(sessionID);
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
      const parentPresent = Object.prototype.hasOwnProperty.call(payload, "parentID") ||
        Object.prototype.hasOwnProperty.call(payload, "parentId");
      const parentID = typeof payload.parentID === "string" ? payload.parentID
        : typeof payload.parentId === "string" ? payload.parentId
          : undefined;
      return {
        ...(typeof payload.agent === "string" ? { agent: payload.agent } : {}),
        ...(parentID === undefined ? {} : { parentID }),
        parentPresent,
      };
    } catch {
      return undefined;
    }
  }

  async function hostSessionUserTurn(
    sessionID: string,
  ): Promise<{ readonly agent: string; readonly synthetic: boolean } | undefined> {
    const messages = input.client?.session?.messages;
    if (messages === undefined) return undefined;
    try {
      const response = await messages.call(input.client!.session, { path: { id: sessionID } });
      const payload = isRecord(response) && "data" in response ? response.data : response;
      if (!Array.isArray(payload)) return undefined;
      for (let index = payload.length - 1; index >= 0; index -= 1) {
        const message = payload[index] as SessionMessage;
        if ((message.info?.role ?? message.role) !== "user") continue;
        const agent = message.info?.agent ?? message.agent;
        if (typeof agent !== "string") return undefined;
        return {
          agent,
          synthetic: (message.parts ?? []).some((part) => part.synthetic === true),
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async function assistantMessageText(
    sessionID: string,
    messageID: string,
    expectedAgent: string,
    partID?: string,
  ): Promise<string | undefined> {
    const messages = input.client?.session?.messages;
    if (messages === undefined) return undefined;
    const response = await messages.call(input.client!.session, { path: { id: sessionID } });
    const payload = isRecord(response) && "data" in response ? response.data : response;
    if (!Array.isArray(payload)) return undefined;
    const message = payload.find((candidate) => {
      if (!isRecord(candidate)) return false;
      const info = isRecord(candidate.info) ? candidate.info : undefined;
      return (info?.id ?? candidate.id) === messageID;
    });
    if (!isRecord(message)) return undefined;
    const info = isRecord(message.info) ? message.info : undefined;
    if ((info?.role ?? message.role) !== "assistant" || (info?.agent ?? message.agent) !== expectedAgent) {
      return undefined;
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (partID !== undefined) {
      const part = parts.find((candidate) => isRecord(candidate) && candidate.id === partID);
      if (!isRecord(part) || part.type !== "text" || part.synthetic === true || typeof part.text !== "string") {
        return undefined;
      }
      const text = part.text.trim();
      return text.length > 0 ? text : undefined;
    }
    return lastAssistantText([message as unknown as SessionMessage]);
  }

  async function eventAssistantMessageText(
    sessionID: string,
    messageID: string,
    expectedAgent: string,
    partID?: string,
  ): Promise<string | undefined> {
    for (const delay of [0, 10, 50]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const text = await assistantMessageText(sessionID, messageID, expectedAgent, partID);
        if (text !== undefined) return text;
      } catch {
        // The event can precede message-history persistence; retry within this single event delivery.
      }
    }
    return undefined;
  }

  async function recoverCoordinatorRoot(sessionID: string): Promise<boolean> {
    if (isCoordinatorSession(sessionID)) return true;
    const identity = await hostSessionIdentity(sessionID);
    if (identity === undefined || identity.parentPresent) return false;
    const persistedTurn = await hostSessionUserTurn(sessionID);
    if (persistedTurn?.agent !== COORDINATOR_AGENT) return false;
    await rememberCoordinatorRoot(sessionID);
    releaseSessionEnforcement(sessionID);
    fastLane.beginTurn(sessionID, persistedTurn?.synthetic ?? false);
    return true;
  }

  function consultationRetryKey(parentID: string, role: ConsultationAgent): string {
    return `${parentID}\u0000${role}`;
  }

  function consultationAgent(value: unknown): ConsultationAgent | undefined {
    return typeof value === "string" && CONSULTATION_AGENTS.has(value)
      ? value as ConsultationAgent
      : undefined;
  }

  async function reserveConsultationFallbackRetry(
    chatInput: Parameters<OpenCodeChatMessageHook>[0],
    output: Parameters<OpenCodeChatMessageHook>[1],
  ): Promise<{ readonly key: string; readonly childSessionID: string } | undefined> {
    const role = consultationAgent(chatInput.agent ?? output.message.agent);
    if (role === undefined) return undefined;
    const identity = await hostSessionIdentity(chatInput.sessionID);
    if (identity?.agent !== role || identity.parentID === undefined) return undefined;
    const key = consultationRetryKey(identity.parentID, role);
    if (consultationRetries.get(key)?.phase !== "pending") return undefined;
    consultationRetries.set(key, { phase: "routing" });
    return { key, childSessionID: chatInput.sessionID };
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
    if (!await recoverCoordinatorRoot(child.parentID)) return undefined;
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
          const result = await bindWriteGate(context.sessionID, args.project_root, args.manifest_path);
          try {
            const denial = JSON.parse(result) as { reason?: unknown };
            const parentID = sessionParents.get(context.sessionID);
            const taskID = sessionTaskIDs.get(context.sessionID);
            if (denial.reason === "handoff-uninspected" && parentID !== undefined && taskID !== undefined &&
              fastLane.authorizeRecoverableWorkerResume(parentID, taskID, context.sessionID)) {
              recoverableWorkerChildren.add(context.sessionID);
            } else if (denial.reason !== "handoff-uninspected") {
              recoverableWorkerChildren.delete(context.sessionID);
              parallelRecoverableChildren.delete(context.sessionID);
            }
          } catch {
            recoverableWorkerChildren.delete(context.sessionID);
            parallelRecoverableChildren.delete(context.sessionID);
          }
          return result;
        },
      }),
      sortie_release_write_gate: defineTool({
        description: "Release this session's bound write scope after a parallel implementation unit has stopped all tools and subprocesses.",
        args: {},
        async execute(_args, context): Promise<string> {
          return releaseWriteGate(context.sessionID);
        },
      }),
      [PARALLEL_COMMIT_ARTIFACT_CAPABILITY]: defineTool({
        description: "Validate and commit one exact active parallel worker unit, returning bounded artifact evidence only.",
        args: {
          run_id: defineTool.schema.string(),
          dispatch_id: defineTool.schema.string(),
          validation_executable: defineTool.schema.string(),
          validation_args_json: optionalString(),
          timeout_ms: optionalString(),
        },
        async execute(args, context): Promise<string> {
          return createParallelCommitArtifact(args, context);
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
          const result = await continuation.tool.execute({}, context);
          if (result === "SORTIE_COMPACT_AND_CONTINUE_QUEUED") {
            fastLane.continuationQueued(context.sessionID);
          }
          return result;
        },
      }),
      [BACKLOG_DRAIN_CAPABILITY]: defineTool({
        description: "Enable one explicit bounded backlog drain before its first worker dispatch.",
        args: { max_units: defineTool.schema.string() },
        async execute(args, context): Promise<string> {
          const maxUnits = Number(args.max_units);
          fastLane.enableBacklogDrain(context.sessionID, maxUnits);
          return JSON.stringify({ status: "enabled", max_units: maxUnits });
        },
      }),
      sortie_prepare_parallel_dispatch: defineTool({
        description: "Prepare one validated two-to-three-task dependency-aware parallel dispatch run.",
        args: { contract_path: defineTool.schema.string() },
        async execute(args, context): Promise<string> {
          return prepareParallelDispatch(context.sessionID, args.contract_path);
        },
      }),
      sortie_parallel_dispatch_status: defineTool({
        description: "Read or explicitly reconcile one bounded durable parallel dispatch snapshot.",
        args: { run_id: optionalString(), reconcile: optionalString() },
        async execute(args, context): Promise<string> {
          return parallelDispatchStatus(context.sessionID, args.run_id ?? "", args.reconcile ?? "false");
        },
      }),
      sortie_cancel_parallel_dispatch: defineTool({
        description: "Cancel one owned parallel dispatch without forcing running workers or cleaning worktrees.",
        args: { run_id: optionalString() },
        async execute(args, context): Promise<string> {
          return cancelParallelDispatch(context.sessionID, args.run_id ?? "");
        },
      }),
      sortie_enqueue_parallel_integration: defineTool({
        description: "Queue one archived completed parallel run for serial target-branch integration.",
        args: { run_id: defineTool.schema.string(), target_branch: defineTool.schema.string() },
        async execute(args, context): Promise<string> {
          return parallelIntegration("enqueue", args, context);
        },
      }),
      sortie_integrate_parallel_queue: defineTool({
        description: "Prepare one queued parallel run with combined validation only; the target branch remains unchanged.",
        args: { run_id: defineTool.schema.string(), target_branch: defineTool.schema.string() },
        async execute(args, context): Promise<string> {
          return parallelIntegration("prepare", args, context);
        },
      }),
      sortie_accept_parallel_integration: defineTool({
        description: "Accept or reject one prepared candidate after independent review; a passing review may update the target branch.",
        args: {
          run_id: defineTool.schema.string(), target_branch: defineTool.schema.string(),
          candidate_head: defineTool.schema.string(), review: defineTool.schema.string(),
          review_fingerprint: defineTool.schema.string(),
        },
        async execute(args, context): Promise<string> {
          return parallelIntegration("accept", args, context);
        },
      }),
      sortie_submit_integration_remediation: defineTool({
        description: "Submit the one coordinator-owned remediation artifact for a remediation-required integration.",
        args: { run_id: defineTool.schema.string(), target_branch: defineTool.schema.string(), artifact_json: defineTool.schema.string() },
        async execute(args, context): Promise<string> {
          return parallelIntegration("remediation", args, context);
        },
      }),
      sortie_parallel_integration_status: defineTool({
        description: "Read bounded serial integration queue status for one target branch and run.",
        args: { run_id: defineTool.schema.string(), target_branch: defineTool.schema.string() },
        async execute(args, context): Promise<string> {
          return parallelIntegration("status", args, context);
        },
      }),
      ...(reflectionStartup ? {
        sortie_reflection: defineTool({
          description: "List, record, replace, forget, promote, or clear a bounded process reflection.",
          args: { action: defineTool.schema.string(), layer: defineTool.schema.string(), scope: optionalString(), trigger: optionalString(), cause: optionalString(), prevention: optionalString(), evidence: optionalString(), evidenceRef: optionalString(), id: optionalString(), promotedRef: optionalString(), confirmation: optionalString() },
          async execute(args, context): Promise<string> {
            if (!(await beginReflection(context.sessionID, context.agent))) return "reflection_not_permitted";
            const layer = args.layer as "run" | "project" | "global";
            try {
              if (!["run", "project", "global"].includes(layer)) return "reflection_invalid_layer";
              if (!(reflectionConfiguration?.layers[layer] ?? false)) return "reflection_not_permitted";
              if (args.action === "list") return JSON.stringify(await reflectionStore!.list(layer, context.sessionID, reflectionVersion!));
              if (args.action === "record") return JSON.stringify(await reflectionStore!.record(layer, context.sessionID, args, reflectionVersion!));
              if (args.action === "replace") return JSON.stringify(await reflectionStore!.replace(layer, context.sessionID, args.id, args, reflectionVersion!));
              if (args.action === "forget") return await reflectionStore!.forget(layer, context.sessionID, args.id, reflectionVersion!);
              if (args.action === "promote") return await reflectionStore!.promote(layer, context.sessionID, args.id, args.promotedRef, reflectionVersion!);
              if (args.action === "clear") return await reflectionStore!.clear(layer, context.sessionID, args.confirmation, reflectionVersion!);
              return "reflection_invalid_action";
            } catch (error) { return error instanceof ReflectionError ? error.code : "reflection_storage_error"; } finally { endReflection(context.sessionID); }
          },
        }),
      } : {}),
    },
    "experimental.text.complete": async (textInput, textOutput): Promise<void> => {
      if (fastLane.manualCompactionForbidden(textInput.sessionID)) {
        textOutput.text = textOutput.text
          .replaceAll(ROLLOVER_MARKER, "")
          .replaceAll(CONTINUATION_MARKER, "")
          .trimEnd();
        return;
      }
      await completeContinuationText(textInput.sessionID, textOutput.text);
    },
    "experimental.session.compacting": async (compactInput, compactOutput): Promise<void> => {
      await continuation.sessionCompacting(compactInput, compactOutput);
    },
    "experimental.compaction.autocontinue": async (autoInput, autoOutput): Promise<void> => {
      await continuation.compactionAutoContinue(autoInput, autoOutput);
    },
    "chat.message": async (chatInput, output): Promise<void> => {
      const parentID = chatParentID(chatInput);
      const synthetic = output.parts.some((part) => isRecord(part) && part.synthetic === true);
      if (parentID !== undefined) rememberParent(chatInput.sessionID, parentID);
      const coordinatorRoot = isCoordinatorSession(chatInput.sessionID);
      const requestedCoordinator = chatInput.agent === COORDINATOR_AGENT || output.message.agent === COORDINATOR_AGENT;
      const normalizeCoordinatorDrift = coordinatorRoot && !requestedCoordinator;
      if (normalizeCoordinatorDrift) {
        /*
         * OpenCode can switch both agent and model when the user only intends to hand the root from
         * Terra to Sol. Letting that agent drift stand silently discards the coordinator prompt and
         * every in-memory continuation guard. Keep the selected model, but make the established root
         * role sticky; an actual workflow switch belongs in a new session.
         */
        chatInput.agent = COORDINATOR_AGENT;
        output.message.agent = COORDINATOR_AGENT;
        if (!normalizedCoordinatorDrifts.has(chatInput.sessionID)) {
          normalizedCoordinatorDrifts.add(chatInput.sessionID);
          console.warn(
            `[sortie-coordinator] normalized agent drift for ${chatInput.sessionID}; selected model preserved`,
          );
        }
      }
      const coordinatorOrigin = !chatParentPresent(chatInput) && (requestedCoordinator || normalizeCoordinatorDrift);
      if (coordinatorOrigin) {
        fastLane.beginTurn(chatInput.sessionID, synthetic);
        releaseSessionEnforcement(chatInput.sessionID);
        await rememberCoordinatorRoot(chatInput.sessionID);
      } else {
        if (!synthetic && isCoordinatorSession(chatInput.sessionID)) {
          fastLane.forget(chatInput.sessionID);
          abortCoordinatorTasks(chatInput.sessionID);
          continuation.forgetSession(chatInput.sessionID);
          evictSession(chatInput.sessionID);
        }
        const taskText = explicitTaskText(output);
        if (taskText !== undefined) {
          const taskID = handoffValue(handoffEntries(taskText), ["task_id"]);
          if (taskID !== undefined) sessionTaskIDs.set(chatInput.sessionID, unquoteValue(taskID));
        }
        let inheritedRoot = taskText === undefined
          ? undefined
          : await inheritedTaskRoot(chatInput.sessionID, taskText);
        if (taskText !== undefined && inheritedRoot === undefined) {
          await recoverCoordinatorLineage(chatInput.sessionID);
          inheritedRoot = await inheritedTaskRoot(chatInput.sessionID, taskText);
        }
        if (inheritedRoot !== undefined) {
          sessionRoots.set(chatInput.sessionID, inheritedRoot);
          activateSession(chatInput.sessionID, parallelTaskMode(taskText!));
          const descriptor = parallelDescriptor(taskText!);
          const recordedAgent = chatInput.agent ?? output.message.agent;
          const matchingCall = descriptor === undefined ? undefined : [...parallelCalls.values()].find((call) =>
            call.ownerRoot === inheritedRoot && sameParallelDescriptor(call.descriptor, descriptor));
          if (descriptor !== undefined && recordedAgent === "dog-worker" && matchingCall !== undefined &&
            samePath(taskProjectRoot(taskText!) ?? "", descriptor.managed_path) && sessionParents.get(chatInput.sessionID) === inheritedRoot) {
            parallelChildBindings.set(chatInput.sessionID, {
              ownerRoot: inheritedRoot,
              descriptor,
              completionCallID: matchingCall.completionCallID,
            });
            pruneParallelChildMap(parallelChildBindings);
          } else {
            parallelChildBindings.delete(chatInput.sessionID);
          }
        } else if (activatesSession(chatInput, output)) {
          activateSession(chatInput.sessionID, taskText === undefined ? "none" : parallelTaskMode(taskText));
        }
        touchActiveSession(chatInput.sessionID);
      }
      /*
       * Role routing is a dispatch policy, not a write-gate concern. Consultation and evidence roles
       * never activate the write gate, so gating routing on session activation left every one of
       * them silently inheriting the caller's model instead of its own configured route.
       */
      await ensureLoaded();
      const consultationFallbackRetry = await reserveConsultationFallbackRetry(chatInput, output);
      try {
        const routed = normalizeCoordinatorDrift
          ? false
          : await loaded?.modelRoutingHook?.(chatInput, output, {
            skipPreferred: consultationFallbackRetry !== undefined,
          });
        if (consultationFallbackRetry !== undefined && routed === true) {
          consultationRetries.set(consultationFallbackRetry.key, {
            phase: "consumed",
            retryChildSessionID: consultationFallbackRetry.childSessionID,
          });
        }
      } finally {
        if (
          consultationFallbackRetry !== undefined &&
          consultationRetries.get(consultationFallbackRetry.key)?.phase === "routing"
        ) {
          consultationRetries.set(consultationFallbackRetry.key, { phase: "pending" });
        }
      }
      if (coordinatorOrigin) {
        continuation.observeModel(chatInput.sessionID, output.message.model, synthetic);
      }
    },
    "experimental.chat.system.transform": async (transformInput: { sessionID: string }, transformOutput: { system?: string[] }): Promise<void> => {
      if (fastLane.terminalInstructionRequired(transformInput.sessionID)) {
        transformOutput.system = [...(transformOutput.system ?? []),
          "SORTIE_FAST_LANE_TERMINAL\nThis is a normal single-unit lane. " +
          "Dispatch at most the one allowed worker, perform any required risk-based review or coordinator-owned finalization, " +
          "then return the terminal report and stop. Do not call a compaction capability or emit a continuation marker."];
      }
      if (isCoordinatorSession(transformInput.sessionID) || await recoverCoordinatorRoot(transformInput.sessionID)) {
        const coordinator = parallelCoordinator ?? await getParallelCoordinator().catch(() => undefined);
        const snapshot = await coordinator?.snapshot(transformInput.sessionID).catch(() => undefined);
        if (snapshot !== undefined) {
          transformOutput.system = [...(transformOutput.system ?? []),
            `SORTIE_PARALLEL_DISPATCH_STATE\n${JSON.stringify(boundedParallelSnapshot(snapshot))}`];
        } else {
          const archived = await coordinator?.archives(transformInput.sessionID).catch(() => undefined);
          if ((archived?.length ?? 0) > 0) {
            transformOutput.system = [...(transformOutput.system ?? []),
              `SORTIE_PARALLEL_DISPATCH_STATE\n${JSON.stringify({ active: null,
                archived: archived!.map(boundedParallelArchive) })}`];
          }
        }
      }
      if (!reflectionStartup || !(await beginReflection(transformInput.sessionID))) return;
      const config = reflectionConfiguration;
      try {
        if (!config) return;
        const heading = "SORTIE_PROCESS_REFLECTIONS";
        const buckets = (["run", "project", "global"] as const)
          .filter((layer) => config.layers[layer])
          .map((layer) => ({ layer, ...(layer === "global" ? {} : { run: transformInput.sessionID }) }));
        const budget = Math.max(0, config.maxInjectedTokens - Buffer.byteLength(`${heading}\n`, "utf8"));
        const text = await reflectionStore!.injectBuckets(buckets, config.maxInjectedEntries, budget, reflectionVersion);
        if (text) transformOutput.system = [...(transformOutput.system ?? []), `${heading}\n${text}`];
      } catch { /* reflection is strictly non-invasive */ } finally { endReflection(transformInput.sessionID); }
    },
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
      const completedChildSessionID = toolInput.tool === "task" ? taskChildSessionID(output) : undefined;
      try {
        if (bootstrapRequired && toolInput.tool === "sortie_check_contract" && toolInput.sessionID !== undefined &&
          isCoordinatorSession(toolInput.sessionID) && successfulBootstrapContractCheck(output)) {
          bootstrapRequired = false;
          bootstrapCompleted = true;
          bootstrapIdleWarnings.delete(toolInput.sessionID);
        }
        const repair = await taskResultRepair(toolInput, output);
        if (
          repair.kind === "unrecoverable-empty" && toolInput.sessionID !== undefined
        ) {
          const identity = await hostSessionIdentity(repair.childSessionID);
          const role = consultationAgent(identity?.agent);
          if (role !== undefined && identity?.parentID === toolInput.sessionID) {
            const key = consultationRetryKey(toolInput.sessionID, role);
            if (
              !consultationRetries.has(key) &&
              markConsultationFallbackRetry(output, role)
            ) {
              consultationRetries.set(key, { phase: "pending" });
            }
          }
        }
        await inspectSuccessfulRead(toolInput);
        let parallel = parallelCalls.get(toolInput.callID ?? "");
        if (parallel === undefined && toolInput.tool === "task" && toolInput.sessionID !== undefined &&
          toolInput.callID !== undefined &&
          (isCoordinatorSession(toolInput.sessionID) || await recoverCoordinatorRoot(toolInput.sessionID))) {
          const coordinator = await getParallelCoordinator().catch(() => undefined);
          const snapshot = await coordinator?.snapshot(toolInput.sessionID).catch(() => undefined);
          const running = snapshot?.tasks.find(({ phase, call_id }) =>
            phase === "running" && call_id === toolInput.callID);
          if (running !== undefined) {
            parallelCoordinator = coordinator;
            parallel = {
              ownerRoot: toolInput.sessionID,
              descriptor: running.descriptor,
              completionCallID: toolInput.callID,
            };
          }
        }
        if (toolInput.tool === "task" && parallel !== undefined && completedChildSessionID !== undefined &&
          recoverableWorkerChildren.has(completedChildSessionID)) {
          parallelRecoverableChildren.set(completedChildSessionID, parallel);
        } else if (toolInput.tool === "task" && parallel !== undefined && parallelCoordinator !== undefined &&
          toolInput.callID !== undefined) {
          const terminal = parallelOutcome(output.output);
          let effectiveOutcome = terminal.outcome;
          let terminalRecorded = false;
          if (effectiveOutcome === "completed") {
            const binding = completedChildSessionID === undefined ? undefined : parallelChildBindings.get(completedChildSessionID);
            const childActive = completedChildSessionID === undefined ? undefined : activeSessions.get(completedChildSessionID);
            const authorization = completedChildSessionID === undefined ? undefined : sessionAuthorizations.get(completedChildSessionID);
            const artifactSnapshot = await parallelCoordinator.snapshot(parallel.ownerRoot, parallel.descriptor.run_id);
            const durableArtifact = artifactSnapshot?.tasks.find(({ descriptor }) =>
              descriptor.dispatch_id === parallel!.descriptor.dispatch_id)?.artifact ?? null;
            const terminalGate = completedChildSessionID !== undefined && binding !== undefined && durableArtifact !== null &&
              binding.ownerRoot === parallel.ownerRoot && sameParallelDescriptor(binding.descriptor, parallel.descriptor) &&
              childActive?.released === true && childActive.inFlightCalls.size === 0 && authorization?.suspended === true &&
              authorization.lease === undefined && !recoverableWorkerChildren.has(completedChildSessionID);
            if (!terminalGate) {
              effectiveOutcome = "failed";
            }
          }
          const snapshot = await parallelCoordinator.completeCall(
            parallel.ownerRoot, parallel.completionCallID, completedChildSessionID,
            effectiveOutcome, terminal.claimed,
          ).then((value) => { terminalRecorded = true; return value; }).catch(async () => {
            if (effectiveOutcome !== "failed") {
              return parallelCoordinator!.completeCall(parallel!.ownerRoot, parallel!.completionCallID,
                completedChildSessionID, "failed", terminal.claimed).then((value) => {
                terminalRecorded = true;
                return value;
              }).catch(() => undefined);
            }
            return undefined;
          });
          if (terminalRecorded && completedChildSessionID !== undefined) {
            parallelArtifacts.delete(completedChildSessionID);
            parallelChildBindings.delete(completedChildSessionID);
          }
          if (snapshot !== undefined) {
            const dispatched = snapshot.tasks.filter(({ phase }) =>
              phase === "running" || phase === "completed" || phase === "failed" || phase === "abandoned").length;
            const running = snapshot.tasks.filter(({ phase }) => phase === "running").length;
            fastLane.enableParallelDispatch(parallel.ownerRoot, snapshot.max_workers, dispatched, running, snapshot.tasks.length);
          }
        }
      } finally {
        parallelCalls.delete(toolInput.callID ?? "");
        activeSessions.get(toolInput.sessionID ?? "")?.inFlightCalls.delete(toolInput.callID ?? "");
        if (toolInput.tool === "task") finishCoordinatorTask(toolInput.sessionID, toolInput.callID);
        if (completedChildSessionID !== undefined && !recoverableWorkerChildren.has(completedChildSessionID)) {
          evictSession(completedChildSessionID);
        }
      }
    },
    "tool.execute.before": async (toolInput, output): Promise<void> => {
      const coordinatorRoot = isCoordinatorSession(toolInput.sessionID) || await recoverCoordinatorRoot(toolInput.sessionID);
      const coordinatorCapability = toolInput.tool === "task" ||
        toolInput.tool === CONTINUATION_CAPABILITY || toolInput.tool === BACKLOG_DRAIN_CAPABILITY ||
        toolInput.tool === "sortie_check_contract" ||
        toolInput.tool === "sortie_prepare_parallel_dispatch" || toolInput.tool === "sortie_parallel_dispatch_status" ||
        toolInput.tool === "sortie_cancel_parallel_dispatch" ||
        toolInput.tool === "sortie_enqueue_parallel_integration" || toolInput.tool === "sortie_integrate_parallel_queue" ||
        toolInput.tool === "sortie_accept_parallel_integration" || toolInput.tool === "sortie_submit_integration_remediation" ||
        toolInput.tool === "sortie_parallel_integration_status";
      const sessionGateCapability = toolInput.tool === "sortie_bind_write_gate" ||
        toolInput.tool === "sortie_release_write_gate" || toolInput.tool === PARALLEL_COMMIT_ARTIFACT_CAPABILITY;
      const bootstrap = bootstrapRequired && !coordinatorCapability && !sessionGateCapability &&
        !sessionAuthorizations.has(toolInput.sessionID) && (coordinatorRoot || coordinatorRoots.size > 0)
        ? await bootstrapControlState()
        : undefined;
      if (coordinatorRoot && bootstrapRequired && !coordinatorCapability && !sessionGateCapability) {
        if (bootstrap === undefined || bootstrap.missing.length > 0 || !bootstrap.usable) {
          if (bootstrap !== undefined && await permitsBootstrapWrite(toolInput, output, bootstrap)) return;
          if (isKnownReadOnlyTool(toolInput.tool, output.args, loaded?.readOnlyTools)) return;
          if (!coordinatorCapability) {
            throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: loadFailure });
          }
        }
      } else if (bootstrap?.usable === true && bootstrap.missing.length > 0) {
        const targets = bootstrapWritePaths(toolInput.tool, output.args);
        const absolutes = targets?.map((target) => isAbsolute(target) ? resolve(target) : resolve(input.worktree ?? input.directory, target));
        if (absolutes?.some((absolute) => bootstrap.controls.some((path) => samePath(path, absolute)))) {
          throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: loadFailure });
        }
      }
      if (coordinatorRoot) {
        if (continuation.blocksTool(toolInput.sessionID)) {
          throw new Error("SORTIE_ROLLOVER_PENDING: stop this turn and wait for compaction");
        }
        const taskRole = isRecord(output.args) && typeof output.args.subagent_type === "string"
          ? output.args.subagent_type
          : undefined;
        const role = consultationAgent(taskRole);
        const consultationFallbackAuthorized = role !== undefined &&
          consultationRetries.get(consultationRetryKey(toolInput.sessionID, role))?.phase === "pending";
        let parallelWorkerAuthorized = false;
        let reservedParallelDescriptor: ParallelDispatchDescriptor | undefined;
        if (toolInput.tool === "task" && taskRole === "dog-worker" && isRecord(output.args)) {
          const prompt = typeof output.args.prompt === "string" ? output.args.prompt : "";
          reservedParallelDescriptor = parallelDescriptor(prompt);
          if (reservedParallelDescriptor !== undefined) {
            const roots = taskValues(prompt, ["project_root", "projectroot"]);
            if (roots.length !== 1 || !samePath(roots[0]!, reservedParallelDescriptor.managed_path)) {
              throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
                defects: [contractDefect("contract", "/managed_path", "parallel_descriptor_project_mismatch")],
              });
            }
          }
          const modes = taskValues(prompt, ["mode"]);
          const resume = modes.length === 1 && modes[0] === "same-task-resume";
          const handoffPaths = taskValues(prompt, ["handoff_path", "handoffpath"]);
          const operationManifests = taskValues(prompt, ["operation_manifest", "operationmanifest"]);
          const projectRoots = taskValues(prompt, ["project_root", "projectroot"]);
          const sourceManifests = taskValues(prompt, ["source_manifest", "sourcemanifest"]);
          const acceptanceValues = taskValues(prompt, ["acceptance"]);
          const validationValues = taskValues(prompt, ["validation"]);
          const taskIDs = taskValues(prompt, ["task_id"]);
          const resumeDeltas = taskValues(prompt, ["resume_delta"]);
          const resumeDeltaPresent = resumeDeltas.length === 1 && hasResumeContractShape(prompt);
          const contractRedefinitions = [
            ...taskValues(prompt, [
              "role", "project_root", "projectroot", "source_manifest", "sourcemanifest",
              "acceptance", "validation", "validation_history", "validation_attempts", "scout",
              "known_facts", "known_paths", "relevant_constraints", "preserve",
              "parallel_group", "parallel_unit", "parallel_units",
            ]),
            ...roleTokenValues(prompt),
          ];
          if (modes.length !== 0 && !resume) {
            throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
              defects: [contractDefect("contract", "/mode", "dispatch_mode_invalid")],
            });
          } else if (resume) {
            // The one-use FastLane token already ties this preserve-only resume to its inspected contract.
            if (
              taskIDs.length !== 1 || taskIDs[0]!.length === 0 || !resumeDeltaPresent ||
              handoffPaths.length !== 0 || operationManifests.length !== 0 || contractRedefinitions.length !== 0
            ) {
              throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
                defects: [contractDefect("contract", "/", "resume_contract_redefinition")],
              });
            }
          } else if (!isExplicitTaskHandoff(prompt)) {
            throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
              defects: [contractDefect("contract", "/", "dispatch_inline_handoff_incomplete")],
            });
          } else if (
            acceptanceValues.length !== 1 || acceptanceValues[0]!.length === 0 ||
            validationValues.length !== 1 || validationValues[0]!.length === 0
          ) {
            throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
              defects: [contractDefect("contract", "/", "dispatch_acceptance_validation_ambiguous")],
            });
          } else if (operationManifests.length !== 1 || operationManifests[0]!.length === 0) {
            throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
              defects: [contractDefect("contract", "/operation_manifest", "dispatch_operation_manifest_unique")],
            });
          } else if (operationManifests[0]!.toLowerCase() === "none") {
            if (projectRoots.length !== 1 || projectRoots[0]!.length === 0 || !isAbsolute(projectRoots[0]!)) {
              throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
                defects: [contractDefect("contract", "/project_root", "dispatch_project_root_unique_absolute")],
              });
            }
            if (
              sourceManifests.length !== 1 || sourceManifests[0]!.length === 0 ||
              sourceManifests[0]!.toLowerCase() === "none"
            ) {
              throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
                defects: [contractDefect("contract", "/source_manifest", "readonly_source_manifest_unique")],
              });
            }
            if (handoffPaths.length !== 0) {
              throw new HandoffDeniedError("contract-invalid", handoffPaths[0] || "<worker-dispatch>", {
                defects: [contractDefect("contract", "/handoff_path", "readonly_handoff_forbidden")],
              });
            }
          } else {
            if (sourceManifests.length !== 1 || sourceManifests[0]!.length === 0) {
              throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
                defects: [contractDefect("contract", "/source_manifest", "dispatch_source_manifest_unique")],
              });
            }
            if (projectRoots.length !== 1 || projectRoots[0]!.length === 0 || !isAbsolute(projectRoots[0]!)) {
              throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
                defects: [contractDefect("contract", "/project_root", "dispatch_project_root_unique_absolute")],
              });
            }
            if (handoffPaths.length !== 1 || handoffPaths[0]!.length === 0 || !isAbsolute(handoffPaths[0]!)) {
              throw new HandoffDeniedError("contract-invalid", "<worker-dispatch>", {
                defects: [contractDefect("contract", "/handoff_path", "dispatch_handoff_path_unique_absolute")],
              });
            }
            const identity = await inspect(handoffPaths[0]!, undefined, { report: true });
            const promptManifestPath = resolve(projectRoots[0]!, operationManifests[0]!);
            if (
              identity === undefined || !identity.explicitWriteGate ||
              !samePath(identity.projectRoot, projectRoots[0]!) ||
              !samePath(identity.manifestPath, promptManifestPath)
            ) {
              throw new HandoffDeniedError("contract-invalid", handoffPaths[0]!, {
                defects: [contractDefect("contract", "/", "dispatch_identity_mismatch")],
              });
            }
          }
        }
        if (reservedParallelDescriptor !== undefined) {
          const coordinator = await getParallelCoordinator();
          const snapshot = await coordinator.snapshot(toolInput.sessionID, reservedParallelDescriptor.run_id);
          if (snapshot === undefined) throw new ParallelDispatchError("descriptor-mismatch", "Parallel run is absent.");
          const dispatched = snapshot.tasks.filter(({ phase }) =>
            phase === "running" || phase === "completed" || phase === "failed" || phase === "abandoned").length;
          const running = snapshot.tasks.filter(({ phase }) => phase === "running").length;
          fastLane.enableParallelDispatch(toolInput.sessionID, snapshot.max_workers, dispatched, running, snapshot.tasks.length);
          await coordinator.bindDispatch(toolInput.sessionID, toolInput.callID, reservedParallelDescriptor);
          parallelWorkerAuthorized = true;
        }
        const resumedWorkerSessionID = fastLane.beforeTool(toolInput.sessionID, toolInput.tool, output.args, {
          consultationFallbackAuthorized,
          parallelWorkerAuthorized,
        });
        if (resumedWorkerSessionID !== undefined) {
          const recoverableParallel = parallelRecoverableChildren.get(resumedWorkerSessionID);
          if (recoverableParallel !== undefined) {
            parallelCalls.set(toolInput.callID, recoverableParallel);
            parallelRecoverableChildren.delete(resumedWorkerSessionID);
          }
          recoverableWorkerChildren.delete(resumedWorkerSessionID);
        }
        if (toolInput.tool === "task" && taskRole === "dog-worker") {
          bootstrapRequired = false;
          bootstrapCompleted = true;
          bootstrapIdleWarnings.delete(toolInput.sessionID);
          beginCoordinatorTask(toolInput.sessionID, toolInput.callID);
          if (reservedParallelDescriptor !== undefined) {
            parallelCalls.set(toolInput.callID, {
              ownerRoot: toolInput.sessionID,
              descriptor: reservedParallelDescriptor,
              completionCallID: toolInput.callID,
            });
          }
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
      if (toolInput.tool === "sortie_bind_write_gate" || toolInput.tool === "sortie_release_write_gate") return;
      const activeState = activeSessions.get(toolInput.sessionID);
      activeState?.inFlightCalls.add(toolInput.callID);
      try {
        if (activeState?.parallel === "valid" && isGitMutation(toolInput.tool, output.args)) {
          throw new WriteDeniedError("parallel-git-mutation", "<parallel-unit>");
        }
        if (activeState?.parallel === "valid" && isRemoteMutation(toolInput.tool, output.args)) {
          throw new WriteDeniedError("parallel-remote-mutation", "<parallel-unit>");
        }
        if (toolInput.tool === PARALLEL_COMMIT_ARTIFACT_CAPABILITY) return;
        if (activeState?.released === true) {
          const authorization = sessionAuthorizations.get(toolInput.sessionID);
          const filePath = isRecord(output.args) && typeof output.args.filePath === "string"
            ? resolve(input.worktree ?? input.directory, output.args.filePath)
            : undefined;
          const exactHandoffRead = toolInput.tool.toLowerCase() === "read" && filePath !== undefined &&
            authorization !== undefined && samePath(filePath, authorization.handoffPath);
          if (!exactHandoffRead) throw new WriteDeniedError("session-released", "<released-session>");
        }
        const gate = await authorizedGate(toolInput.sessionID);
        if (gate === undefined) {
          if (!hasSessionEnforcementState(toolInput.sessionID) &&
            !(bootstrapRequired && coordinatorRoots.size > 0) && await isUnconfiguredProject()) return;
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
        const authorization = sessionAuthorizations.get(toolInput.sessionID);
        const command = isRecord(output.args) && typeof output.args.command === "string"
          ? normalizeCommand(output.args.command)
          : undefined;
        if (
          activeState?.parallel === "valid" && command !== undefined &&
          authorization?.validationCommands.has(command) === true
        ) throw new WriteDeniedError("parallel-validation", "<parallel-unit>");
        await gate.check(toolInput, output);
      } catch (error) {
        activeState?.inFlightCalls.delete(toolInput.callID);
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
      const eventPart = isRecord(event.properties?.part) ? event.properties.part : undefined;
      const eventSessionID = typeof event.properties?.sessionID === "string" ? event.properties.sessionID
        : event.type === "message.part.updated" && typeof eventPart?.sessionID === "string" ? eventPart.sessionID
          : event.type === "message.updated" && typeof info?.sessionID === "string" ? info.sessionID
            : typeof info?.id === "string" ? info.id
          : undefined;
      if (event.type === "file.edited" && typeof event.properties?.file === "string") {
        // Event session identity is absent in current hosts and cannot be trusted as proof of which
        // child read a file. Every edit therefore revokes state; only a successful Read can grant it.
        await invalidateEditedHandoff(event.properties.file);
        return;
      }
      if (eventSessionID === undefined) return;
      const eventPartTime = isRecord(eventPart?.time) ? eventPart.time : undefined;
      if (
        event.type === "message.part.updated" && isCoordinatorSession(eventSessionID) &&
        !fastLane.manualCompactionForbidden(eventSessionID) &&
        eventPart?.type === "text" && typeof eventPart.text === "string" && eventPart.text.trim().length > 0 &&
        typeof eventPartTime?.end === "number" && typeof eventPart.id === "string" &&
        typeof eventPart.messageID === "string" &&
        !completedCoordinatorParts.has(eventPart.id)
      ) {
        completedCoordinatorParts.add(eventPart.id);
        const text = await eventAssistantMessageText(
          eventSessionID,
          eventPart.messageID,
          COORDINATOR_AGENT,
          eventPart.id,
        );
        if (text !== undefined && text === eventPart.text.trim()) {
          completedCoordinatorMessages.add(eventPart.messageID);
          while (completedCoordinatorParts.size > ACTIVE_SESSION_CACHE.maximum) {
            completedCoordinatorParts.delete(completedCoordinatorParts.values().next().value!);
          }
          while (completedCoordinatorMessages.size > ACTIVE_SESSION_CACHE.maximum) {
            completedCoordinatorMessages.delete(completedCoordinatorMessages.values().next().value!);
          }
          await completeContinuationText(eventSessionID, text);
          return;
        }
        completedCoordinatorParts.delete(eventPart.id);
      }
      if (
        event.type === "message.part.updated" && isCoordinatorSession(eventSessionID) &&
        continuation.blocksTool(eventSessionID) && eventPart?.type === "text" &&
        typeof eventPart.text === "string" && eventPart.text.trim().length > 0 &&
        typeof eventPartTime?.end === "number" && typeof eventPart.id === "string" &&
        typeof eventPart.messageID === "string" && !completedCoordinatorParts.has(eventPart.id)
      ) {
        completedCoordinatorParts.add(eventPart.id);
        const text = await eventAssistantMessageText(eventSessionID, eventPart.messageID, "compaction", eventPart.id);
        if (text === undefined || text !== eventPart.text.trim()) {
          completedCoordinatorParts.delete(eventPart.id);
          return;
        }
        completedCoordinatorMessages.add(eventPart.messageID);
        await completeContinuationText(eventSessionID, text);
        return;
      }
      if (
        event.type === "message.updated" && isCoordinatorSession(eventSessionID) &&
        !fastLane.manualCompactionForbidden(eventSessionID) &&
        info?.role === "assistant" && info.agent === COORDINATOR_AGENT && isRecord(info.time) &&
        typeof info.time.completed === "number" && typeof info.id === "string" &&
        !completedCoordinatorMessages.has(info.id)
      ) {
        completedCoordinatorMessages.add(info.id);
        while (completedCoordinatorMessages.size > ACTIVE_SESSION_CACHE.maximum) {
          completedCoordinatorMessages.delete(completedCoordinatorMessages.values().next().value!);
        }
        try {
          const text = await eventAssistantMessageText(eventSessionID, info.id, COORDINATOR_AGENT);
          if (text === undefined) completedCoordinatorMessages.delete(info.id);
          else await completeContinuationText(eventSessionID, text);
        } catch {
          completedCoordinatorMessages.delete(info.id);
        }
        return;
      }
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
        normalizedCoordinatorDrifts.delete(eventSessionID);
        fastLane.forget(eventSessionID);
        abortCoordinatorTasks(eventSessionID);
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
        if (eventSessionID !== undefined) {
          const coordinator = await getParallelCoordinator().catch(() => undefined);
          const owned = await coordinator?.snapshot(eventSessionID).catch(() => undefined);
          if (owned !== undefined) await coordinator?.cancel(eventSessionID, owned.run_id).catch(() => undefined);
        }
        evictSession(eventSessionID);
        for (const role of [REVIEWER_AGENT, ADVISOR_AGENT] as const) {
          const key = consultationRetryKey(eventSessionID, role);
          consultationRetries.delete(key);
        }
        continuation.forgetSession(eventSessionID);
        return;
      }
      /*
       * The coordinator root is deliberately not a write-gate session, so continuation must run
       * before the active-session guard below or the batch could never resume itself.
       */
      if (event.type === "session.compacted") await continuation.sessionCompacted(eventSessionID);
      if (event.type === "session.idle" && isCoordinatorSession(eventSessionID)) {
        const bootstrap = await bootstrapControlState();
        if (bootstrapRequired && bootstrap?.usable === true && bootstrap.missing.length > 0) {
          if (!bootstrapIdleWarnings.has(eventSessionID)) {
            bootstrapIdleWarnings.add(eventSessionID);
            console.warn("[sortie-dogs] coordinator bootstrap paused: configured control files are missing");
          }
        }
      }
      if (event.type === "session.idle") await continuation.sessionIdle(eventSessionID);
      if (event.type === "session.idle" && isCoordinatorSession(eventSessionID)) {
        abortCoordinatorTasks(eventSessionID, true);
      }
      if (!isActiveSession(eventSessionID)) return;
      if (event.type !== "session.idle") touchActiveSession(eventSessionID);
      if (event.type === "session.idle" && eventSessionID !== undefined) {
        activeSessions.get(eventSessionID)?.inFlightCalls.clear();
        if (recoverableWorkerChildren.has(eventSessionID)) {
          touchActiveSession(eventSessionID);
          return;
        }
        if (childHasInFlightParentTask(eventSessionID) && activeSessions.get(eventSessionID)?.parallel !== "valid") {
          touchActiveSession(eventSessionID);
          return;
        }
        const authorization = sessionAuthorizations.get(eventSessionID);
        if (authorization === undefined) return;
        try {
          // Idle is the abnormal-exit fallback when the parent Task completion hook never arrives.
          await inspect(authorization.handoffPath, eventSessionID);
        } catch {
          // Suspension below is fail-closed for both valid and invalid handoffs.
        } finally {
          authorization.suspended = true;
          const lease = authorization.lease;
          if (lease !== undefined) {
            await lease.release().catch(() => lease.close());
          }
          authorization.lease = undefined;
          for (const key of inspected.keys()) {
            if (key.startsWith(`${eventSessionID}\u0000`)) inspected.delete(key);
          }
          const activeState = activeSessions.get(eventSessionID);
          if (activeState !== undefined) activeState.released = true;
        }
      }
    },
  };
  return hooks;
};

export type { SortieDogsPluginOptions } from "./config.js";
export { InvalidModelTargetError, ModelRoutingDeniedError } from "./model-routing-hook.js";
