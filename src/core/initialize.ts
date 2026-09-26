import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { RUNTIME_PROFILES, type RuntimeProfileId } from "./runtime-profile.ts";
import type { RuntimeAsset } from "../runtime-assets.js";

const assets: typeof import("../runtime-assets.js") = await import(
  `../runtime-assets.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);
const { runtimeAssets } = assets;

const OPEN_CODE_DIRECTORY = ".opencode";
const VERSION_MARKER = `${OPEN_CODE_DIRECTORY}/sortie-dogs.version`;
const GLOBAL_VERSION_MARKER = "sortie-dogs.version";
const LUNA_FABRIC_CONTROL_IGNORE = `${OPEN_CODE_DIRECTORY}/.gitignore`;
const LUNA_FABRIC_CONTROL_FILE = "sortie-dogs-luna-fabric.json";

interface LegacyRuntimeAsset {
  readonly relativePath: string;
  readonly markerVersions: readonly string[];
  readonly sha256: string;
}

const LEGACY_RUNTIME_ASSETS: readonly LegacyRuntimeAsset[] = [
  {
    relativePath: ".opencode/agent/coordinator-mk2a2.md",
    markerVersions: ["0.2.0-card04"],
    sha256: "464e58c4973073937493d6a2205dc8594236b38d83cf63a8bba2965afe7c011c",
  },
  {
    relativePath: ".opencode/agent/sol-worker-mk2a2.md",
    markerVersions: ["0.2.0-card04"],
    sha256: "32391b899a2b1a39bcd03653adfcfe9e5d7343e1494cab020b16e5784b8bc0ba",
  },
] as const;

const V010_ROLE_NAME_LEGACY_ASSETS: readonly LegacyRuntimeAsset[] = [
  {
    relativePath: ".opencode/agent/dog-coordinator-v010.md",
    markerVersions: ["0.10.0-beta.1"],
    sha256: "50eb6392bdd98865b28ba3620781d1d27ab197c7211290745c6db39a0ed8db90",
  },
  {
    relativePath: ".opencode/agent/dog-operator-v010.md",
    markerVersions: ["0.10.0-beta.1"],
    sha256: "6f2fc1b4ae2bdadcd61b0984636930b60dc84218187107e39c8e1c32c33260cf",
  },
] as const;

export type InitializationStatus = "installed" | "unchanged";

export interface InitializeProjectResult {
  readonly status: InitializationStatus;
  readonly version: string;
  readonly installedPaths: readonly string[];
  readonly preservedLegacyPaths: readonly string[];
}

export type ProjectInitializationErrorCode =
  | "conflict"
  | "incompatible-version"
  | "invalid-project"
  | "unsafe-path"
  | "write-failed";

export class ProjectInitializationError extends Error {
  readonly code: ProjectInitializationErrorCode;

  constructor(code: ProjectInitializationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectInitializationError";
    this.code = code;
  }
}

interface InstallEntry {
  readonly relativePath: string;
  readonly content: string;
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

function assetVersion(assets: readonly RuntimeAsset[] = runtimeAssets): string {
  const versions = new Set(assets.map(({ version }) => version));
  if (versions.size !== 1) {
    throw new ProjectInitializationError("write-failed", "Runtime assets do not share one version.");
  }
  return versions.values().next().value!;
}

function safeAssetPath(installPath: string, prefix: string): string {
  const unified = installPath.replaceAll("\\", "/");
  const segments = unified.split("/");
  if (isAbsolute(installPath) || /^[A-Za-z]:/u.test(unified) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ProjectInitializationError("unsafe-path", "A runtime asset has an unsafe install path.");
  }
  return prefix === "" ? unified : `${prefix}/${unified}`;
}

function parseMarker(content: string): string {
  const match = /^([^\r\n]+)\r?\n$/u.exec(content);
  if (match === null || parseVersion(match[1]) === undefined) {
    throw new ProjectInitializationError("conflict", "The Sortie-dogs version marker is invalid.");
  }
  return match[1];
}

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber < rightNumber ? -1 : 1;
    if (leftNumber !== undefined || rightNumber !== undefined) return leftNumber !== undefined ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareVersions(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

type VersionTransition = "same" | "compatible-update" | "incompatible";

function classifyVersionTransition(installedValue: string, currentValue: string, v010Restore = false): VersionTransition {
  const installed = parseVersion(installedValue);
  const current = parseVersion(currentValue);
  if (installed === undefined || current === undefined) return "incompatible";
  const order = compareVersions(installed, current);
  if (order === 0) return "same";
  if (order > 0) return "incompatible";
  if (v010Restore && installed.major === 0 && installed.minor === 11 &&
    current.major === 0 && current.minor === 12) return "incompatible";

  // SemVer-compatible update line: stable releases share a major; 0.x releases also share a minor.
  const sameLine = installed.major === current.major &&
    (installed.major !== 0 || installed.minor === current.minor);
  // The installed marker is the runtime-asset version. An adjacent 0.x line is the only supported
  // cross-minor migration; skipped lines still fail closed instead of bypassing migration steps.
  const adjacentPreOneLine = installed.major === 0 && current.major === 0 &&
    current.minor === installed.minor + 1;
  // v0.11 used a different runtime. This explicit v010 asset migration restores
  // the 0.10 line directly into 0.12 without selecting any v0.11 execution path.
  const restoredPreview = v010Restore && installed.major === 0 && installed.minor === 10 &&
    current.major === 0 && current.minor === 12;
  return sameLine || adjacentPreOneLine || restoredPreview ? "compatible-update" : "incompatible";
}

async function metadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function assertSafeExistingPath(root: string, relativePath: string, file: boolean): Promise<boolean> {
  const segments = relativePath.split("/");
  let candidate = root;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = resolve(candidate, segments[index]);
    if (!insideRoot(root, candidate)) {
      throw new ProjectInitializationError("unsafe-path", "An initialization path escapes the project root.");
    }
    const info = await metadata(candidate);
    if (info === undefined) return false;
    if (info.isSymbolicLink()) {
      throw new ProjectInitializationError("unsafe-path", "Initialization paths must not contain symbolic links.");
    }
    const isLast = index === segments.length - 1;
    if (isLast && file) {
      if (!info.isFile()) {
        throw new ProjectInitializationError("conflict", "An initialization file path is not a regular file.");
      }
    } else if (!info.isDirectory()) {
      throw new ProjectInitializationError("conflict", "An initialization directory path is not a directory.");
    }
  }
  return true;
}

async function readableOwnedLegacyFile(
  root: string,
  asset: LegacyRuntimeAsset,
): Promise<Buffer | "absent" | "preserve"> {
  let candidate = root;
  const segments = asset.relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    candidate = resolve(candidate, segments[index]);
    if (!insideRoot(root, candidate)) return "preserve";
    const info = await metadata(candidate);
    if (info === undefined) return "absent";
    if (info.isSymbolicLink()) return "preserve";
    const isLast = index === segments.length - 1;
    if (isLast ? !info.isFile() : !info.isDirectory()) return "preserve";
  }

  const content = await readFile(candidate);
  return createHash("sha256").update(content).digest("hex") === asset.sha256 ? content : "preserve";
}

async function ensureDirectory(
  root: string,
  relativePath: string,
  createdDirectories: string[],
): Promise<void> {
  let candidate = root;
  for (const segment of relativePath.split("/")) {
    candidate = resolve(candidate, segment);
    const info = await metadata(candidate);
    if (info !== undefined) {
      if (info.isSymbolicLink()) {
        throw new ProjectInitializationError("unsafe-path", "Initialization paths must not contain symbolic links.");
      }
      if (!info.isDirectory()) {
        throw new ProjectInitializationError("conflict", "An initialization directory path is not a directory.");
      }
      continue;
    }
    try {
      await mkdir(candidate);
      createdDirectories.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await lstat(candidate);
      if (raced.isSymbolicLink() || !raced.isDirectory()) {
        throw new ProjectInitializationError("unsafe-path", "An initialization directory changed during init.");
      }
    }
  }
}

async function rollback(
  root: string,
  createdFiles: readonly string[],
  modifiedFiles: readonly { readonly relativePath: string; readonly content: Buffer }[],
  removedFiles: readonly { readonly relativePath: string; readonly content: Buffer }[],
  createdDirectories: readonly string[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const file of [...createdFiles].reverse()) {
    await rm(file, { force: true }).catch((error) => failures.push(error));
  }
  for (const file of [...modifiedFiles].reverse()) {
    await overwriteFileSafely(root, file.relativePath, file.content).catch((error) => failures.push(error));
  }
  for (const file of [...removedFiles].reverse()) {
    const path = resolve(root, file.relativePath);
    let handle;
    try {
      handle = await open(path, "wx");
      await handle.writeFile(file.content);
    } catch (error) {
      failures.push(error);
    } finally {
      await handle?.close().catch((error) => failures.push(error));
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") failures.push(error);
    });
  }
  if (failures.length > 0) throw new AggregateError(failures, "Initialization rollback failed.");
}

async function createFile(path: string, content: string, createdFiles: string[]): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx");
    createdFiles.push(path);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle?.close();
  }
}

async function overwriteFileSafely(
  root: string,
  relativePath: string,
  content: string | Buffer,
  beforeMutation?: () => void,
): Promise<void> {
  await assertSafeExistingPath(root, relativePath, true);
  const path = resolve(root, relativePath);
  let handle;
  try {
    // O_NOFOLLOW closes the race between the final lstat above and opening the destination.
    handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      throw new ProjectInitializationError("conflict", "An initialization file path is not a regular file.");
    }
    beforeMutation?.();
    await handle.truncate(0);
    await handle.writeFile(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ProjectInitializationError("unsafe-path", "Initialization paths must not contain symbolic links.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function appendFileSafely(root: string, relativePath: string, content: string): Promise<void> {
  await assertSafeExistingPath(root, relativePath, true);
  let handle;
  try {
    handle = await open(resolve(root, relativePath), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      throw new ProjectInitializationError("conflict", "An initialization file path is not a regular file.");
    }
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ProjectInitializationError("unsafe-path", "Initialization paths must not contain symbolic links.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureProjectLunaControlIgnore(
  root: string,
  createdFiles: string[] = [],
  modifiedFiles: Array<{ relativePath: string; content: Buffer }> = [],
  createdDirectories: string[] = [],
): Promise<void> {
  const relativePath = LUNA_FABRIC_CONTROL_IGNORE;
  const present = await assertSafeExistingPath(root, relativePath, true);
  if (!present) {
    await ensureDirectory(root, OPEN_CODE_DIRECTORY, createdDirectories);
    await createFile(resolve(root, relativePath), `${LUNA_FABRIC_CONTROL_FILE}\n`, createdFiles);
    return;
  }
  const current = await readFile(resolve(root, relativePath));
  const text = current.toString("utf8");
  if (new RegExp(`(?:^|\\r?\\n)${LUNA_FABRIC_CONTROL_FILE.replace(".", "\\.")}(?:\\r?\\n|$)`, "u").test(text)) return;
  modifiedFiles.push({ relativePath, content: current });
  const separator = text.endsWith("\n") ? "" : "\n";
  await appendFileSafely(root, relativePath, `${separator}${LUNA_FABRIC_CONTROL_FILE}\n`);
}

interface InitializationLayout {
  readonly assetPrefix: string;
  readonly markerPath: string;
  readonly preserveAllLegacy: boolean;
  readonly invalidRootMessage: string;
  readonly controlIgnore?: boolean;
  readonly legacyAssets?: readonly LegacyRuntimeAsset[];
  readonly renamedTargets?: readonly string[];
  readonly configureV010?: boolean;
}

const PROJECT_LAYOUT: InitializationLayout = {
  assetPrefix: OPEN_CODE_DIRECTORY,
  markerPath: VERSION_MARKER,
  preserveAllLegacy: false,
  invalidRootMessage: "Project root must be an existing non-symlink directory.",
};

const GLOBAL_LAYOUT: InitializationLayout = {
  assetPrefix: "",
  markerPath: GLOBAL_VERSION_MARKER,
  preserveAllLegacy: true,
  invalidRootMessage: "Global configuration root must be an existing non-symlink directory.",
};

function layoutLegacyPath(asset: LegacyRuntimeAsset, layout: InitializationLayout): string {
  return layout.preserveAllLegacy
    ? asset.relativePath.slice(`${OPEN_CODE_DIRECTORY}/`.length)
    : asset.relativePath;
}

async function v010Config(root: string, global: boolean): Promise<{ entry: InstallEntry; previous?: Buffer } | undefined> {
  const prefix = global ? "" : `${OPEN_CODE_DIRECTORY}/`;
  const json = `${prefix}opencode.json`, jsonc = `${prefix}opencode.jsonc`;
  const presentJSON = await assertSafeExistingPath(root, json, true);
  const presentJSONC = await assertSafeExistingPath(root, jsonc, true);
  if (presentJSON && presentJSONC) throw new ProjectInitializationError("conflict", "Both OpenCode JSON and JSONC configs exist; choose one before initialization.");
  const relativePath = presentJSONC ? jsonc : json;
  const previous = presentJSONC || presentJSON ? await readFile(resolve(root, relativePath)) : undefined;
  let content = previous?.toString("utf8") ?? "{}\n";
  const errors: ParseError[] = [];
  const config = parse(content, errors, { allowTrailingComma: true });
  if (errors.length || config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ProjectInitializationError("conflict", `OpenCode config ${relativePath} must be a valid JSON/JSONC object.`);
  }
  const current = config as Record<string, unknown>;
  const plugins = current.plugins;
  if (plugins !== undefined && (!Array.isArray(plugins) || !plugins.every(item => typeof item === "string" ||
      (item !== null && typeof item === "object" && !Array.isArray(item) && typeof item.package === "string")))) {
    throw new ProjectInitializationError("conflict", `OpenCode config ${relativePath} has an invalid plugins list.`);
  }
  if (current.experimental !== undefined && (current.experimental === null || typeof current.experimental !== "object" ||
      Array.isArray(current.experimental))) throw new ProjectInitializationError("conflict", `OpenCode config ${relativePath} has invalid experimental settings.`);
  const depth = (current.experimental as Record<string, unknown> | undefined)?.subagent_depth;
  if (depth !== undefined && (!Number.isSafeInteger(depth) || (depth as number) < 0)) {
    throw new ProjectInitializationError("conflict", `OpenCode config ${relativePath} has an invalid subagent depth.`);
  }
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  const update = (path: (string | number)[], value: unknown) => { content = applyEdits(content, modify(content, path, value, options)); };
  const wrapper = `${prefix}plugins/sortie-dogs/index.js`;
  const wrapperSource = await readFile(resolve(root, wrapper), "utf8").catch(() => "");
  const localV2Wrapper = /^\s*export\s*\{\s*default\s*\}\s*from\s*["']sortie-dogs\/server["'];?\s*$/u.test(wrapperSource);
  const registered = (plugins as unknown[] | undefined)?.some(item => {
    const name = typeof item === "string" ? item : item !== null && typeof item === "object" ? (item as Record<string, unknown>).package : undefined;
    return typeof name === "string" && /^sortie-dogs(?:@[^/]+)?$/u.test(name);
  });
  if (!localV2Wrapper && !registered) {
    update(["plugins"], [...(plugins as unknown[] | undefined ?? []), "sortie-dogs"]);
  }
  if (depth === undefined || (depth as number) < 2) update(["experimental", "subagent_depth"], 2);
  if (previous?.toString("utf8") === content) return undefined;
  return { entry: { relativePath, content }, previous };
}

async function initializeRoot(
  requestedRoot: string,
  layout: InitializationLayout,
  installAssets: readonly RuntimeAsset[] = runtimeAssets,
): Promise<InitializeProjectResult> {
  const root = resolve(requestedRoot);
  const legacyAssets = layout.legacyAssets ?? LEGACY_RUNTIME_ASSETS;
  const rootInfo = await metadata(root);
  if (rootInfo === undefined || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ProjectInitializationError("invalid-project", layout.invalidRootMessage);
  }
  const configUpdate = layout.configureV010 ? await v010Config(root, layout.assetPrefix === "") : undefined;

  const version = assetVersion(installAssets);
  const assetEntries: InstallEntry[] = installAssets.map(({ installPath, content }) => ({
    relativePath: safeAssetPath(installPath, layout.assetPrefix),
    content,
  }));
  const entries: InstallEntry[] = [
    ...assetEntries,
    { relativePath: layout.markerPath, content: `${version}\n` },
  ];

  const preservedGlobalLegacyPaths: string[] = [];
  if (layout.preserveAllLegacy) {
    for (const asset of legacyAssets) {
      const relativePath = layoutLegacyPath(asset, layout);
      if (await metadata(resolve(root, relativePath)) !== undefined) {
        preservedGlobalLegacyPaths.push(relativePath);
      }
    }
  }

  const existing = await Promise.all(entries.map(async (entry) => {
    const present = await assertSafeExistingPath(root, entry.relativePath, true);
    return present ? await readFile(resolve(root, entry.relativePath)) : undefined;
  }));
  const markerIndex = entries.length - 1;
  const markerText = existing[markerIndex];
  const matches = (entry: InstallEntry, index: number): boolean =>
    existing[index]?.equals(Buffer.from(entry.content)) ?? false;
  const assetsMatch = assetEntries.every(matches);
  if (markerText !== undefined && parseMarker(markerText.toString("utf8")) === version && assetsMatch && !configUpdate) {
    if (layout.controlIgnore ?? !layout.preserveAllLegacy) await ensureProjectLunaControlIgnore(root);
    return {
      status: "unchanged",
      version,
      installedPaths: entries.map(({ relativePath }) => relativePath),
      preservedLegacyPaths: preservedGlobalLegacyPaths,
    };
  }

  if (markerText === undefined) {
    if (existing.some((content) => content !== undefined)) {
      throw new ProjectInitializationError("conflict", "Existing Sortie-dogs runtime files have unknown ownership.");
    }
  } else {
    const installedVersion = parseMarker(markerText.toString("utf8"));
    if (classifyVersionTransition(installedVersion, version, layout.markerPath.endsWith("sortie-dogs-v010.version")) === "incompatible") {
      throw new ProjectInitializationError(
        "incompatible-version",
        `Installed Sortie-dogs ${installedVersion} cannot be updated to ${version}.`,
      );
    }
  }

  const installedVersion = markerText === undefined ? undefined : parseMarker(markerText.toString("utf8"));
  if (installedVersion !== undefined && legacyAssets.some(asset => asset.markerVersions.includes(installedVersion))) {
    for (const target of layout.renamedTargets ?? []) {
      const index = assetEntries.findIndex(entry => entry.relativePath === safeAssetPath(target, layout.assetPrefix));
      if (index >= 0 && existing[index] !== undefined && !matches(assetEntries[index]!, index)) {
        throw new ProjectInitializationError("conflict", `Renamed runtime target has unknown ownership: ${target}`);
      }
    }
  }
  const removableLegacyFiles: Array<{ asset: LegacyRuntimeAsset; content: Buffer }> = [];
  const preservedLegacyPaths: string[] = [...preservedGlobalLegacyPaths];
  if (!layout.preserveAllLegacy && installedVersion !== undefined) {
    for (const asset of legacyAssets) {
      if (!asset.markerVersions.includes(installedVersion)) continue;
      const state = await readableOwnedLegacyFile(root, asset);
      if (Buffer.isBuffer(state)) removableLegacyFiles.push({ asset, content: state });
      else if (state === "preserve") preservedLegacyPaths.push(asset.relativePath);
    }
  }

  const createdFiles: string[] = [];
  const modifiedFiles: Array<{ relativePath: string; content: Buffer }> = [];
  const removedFiles: Array<{ relativePath: string; content: Buffer }> = [];
  const createdDirectories: string[] = [];
  try {
    if (layout.controlIgnore ?? !layout.preserveAllLegacy) {
      await ensureProjectLunaControlIgnore(root, createdFiles, modifiedFiles, createdDirectories);
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (matches(entry, index)) continue;
      const parent = dirname(entry.relativePath).replaceAll("\\", "/");
      await ensureDirectory(root, parent, createdDirectories);
      await assertSafeExistingPath(root, parent, false);
      const target = resolve(root, entry.relativePath);
      if (existing[index] === undefined) {
        await createFile(target, entry.content, createdFiles);
      } else {
        await overwriteFileSafely(root, entry.relativePath, entry.content, () => {
          modifiedFiles.push({ relativePath: entry.relativePath, content: existing[index]! });
        });
      }
    }
    if (configUpdate) {
      const { entry, previous } = configUpdate;
      const parent = dirname(entry.relativePath).replaceAll("\\", "/");
      if (parent !== ".") await ensureDirectory(root, parent, createdDirectories);
      if (previous === undefined) await createFile(resolve(root, entry.relativePath), entry.content, createdFiles);
      else await overwriteFileSafely(root, entry.relativePath, entry.content, () => {
        modifiedFiles.push({ relativePath: entry.relativePath, content: previous });
      });
    }
    for (const { asset } of removableLegacyFiles) {
      const state = await readableOwnedLegacyFile(root, asset);
      if (!Buffer.isBuffer(state)) {
        if (state === "preserve" && !preservedLegacyPaths.includes(asset.relativePath)) {
          preservedLegacyPaths.push(asset.relativePath);
        }
        continue;
      }
      await rm(resolve(root, asset.relativePath));
      removedFiles.push({ relativePath: asset.relativePath, content: state });
    }
  } catch (error) {
    try {
      await rollback(root, createdFiles, modifiedFiles, removedFiles, createdDirectories);
    } catch (rollbackError) {
      throw new ProjectInitializationError("write-failed", "Initialization failed and rollback was incomplete.", {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    if (error instanceof ProjectInitializationError) throw error;
    const code = (error as NodeJS.ErrnoException).code === "EEXIST" ? "conflict" : "write-failed";
    throw new ProjectInitializationError(code, "Initialization failed without changing the project.", { cause: error });
  }

  return {
    status: "installed",
    version,
    installedPaths: [...entries.map(({ relativePath }) => relativePath), ...(configUpdate ? [configUpdate.entry.relativePath] : [])],
    preservedLegacyPaths,
  };
}

export const V010_COORDINATOR_MODEL = "openai/gpt-6-sol#xhigh";

/**
 * Report a user config that routes the v0.10 Coordinator away from its packaged model. Measured Luna
 * Coordinators repeated plans and review dispatches until timeout, so init surfaces it without editing it.
 */
export async function coordinatorModelOverride(root: string, global: boolean): Promise<{ path: string; model: string } | undefined> {
  const prefix = global ? "" : `${OPEN_CODE_DIRECTORY}/`;
  for (const relativePath of [`${prefix}opencode.jsonc`, `${prefix}opencode.json`]) {
    let content: string;
    try { content = await readFile(resolve(root, relativePath), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const config = parse(content, [], { allowTrailingComma: true }) as Record<string, unknown> | null;
    for (const key of ["agents", "agent"]) {
      const agents = config?.[key];
      const coordinator = agents !== null && typeof agents === "object" ? (agents as Record<string, unknown>)["dogs-coordinator"] : undefined;
      const model = coordinator !== null && typeof coordinator === "object" ? (coordinator as Record<string, unknown>).model : undefined;
      if (typeof model === "string" && model !== V010_COORDINATOR_MODEL) return { path: resolve(root, relativePath), model };
    }
  }
  return undefined;
}

/** Resolves the OpenCode global configuration directory without platform-specific paths. */
export async function resolveGlobalConfigRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<string> {
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR);
  if (env.OPENCODE_CONFIG) {
    const configured = resolve(env.OPENCODE_CONFIG);
    try {
      if ((await stat(configured)).isDirectory()) return await realpath(configured);
    } catch (error) {
      if (!(["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))) throw error;
    }
    return dirname(configured);
  }
  if (env.XDG_CONFIG_HOME) return resolve(env.XDG_CONFIG_HOME, "opencode");
  return resolve(home, ".config", "opencode");
}

/** Installs the packaged runtime into one existing project, preserving unrelated user settings. */
async function profileInstallation(id: RuntimeProfileId, global: boolean): Promise<{ layout: InitializationLayout; assets: readonly RuntimeAsset[] }> {
  if (!Object.hasOwn(RUNTIME_PROFILES, id)) throw new ProjectInitializationError("invalid-project", "Unknown runtime profile.");
  const profile = RUNTIME_PROFILES[id];
  if (!profile) throw new ProjectInitializationError("invalid-project", "Unknown runtime profile.");
  if (id === "stable") return { layout: global ? GLOBAL_LAYOUT : PROJECT_LAYOUT, assets: runtimeAssets };
  const module: typeof import("../runtime-assets-v010.js") = await import(`../runtime-assets-v010.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`);
  return { layout: { ...(global ? GLOBAL_LAYOUT : PROJECT_LAYOUT),
    markerPath: global ? profile.markerFile : `${OPEN_CODE_DIRECTORY}/${profile.markerFile}`,
    preserveAllLegacy: false, controlIgnore: false, legacyAssets: V010_ROLE_NAME_LEGACY_ASSETS,
    renamedTargets: ["agent/dog-operator.md", "agent/dogs-coordinator.md"], configureV010: true }, assets: module.runtimeAssets };
}

export async function initializeProject(projectRoot: string = process.cwd(), profile: RuntimeProfileId = "stable"): Promise<InitializeProjectResult> {
  const install = await profileInstallation(profile, false);
  return initializeRoot(projectRoot, install.layout, install.assets);
}

async function removeEmptyDirectories(paths: readonly string[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const directory of [...paths].reverse()) {
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") failures.push(error);
    });
  }
  return failures;
}

/** Installs the packaged runtime into OpenCode's global configuration directory. */
export async function initializeGlobal(globalRoot?: string, profile: RuntimeProfileId = "stable"): Promise<InitializeProjectResult> {
  const install = await profileInstallation(profile, true);
  let root = resolve(globalRoot ?? await resolveGlobalConfigRoot());
  let existing = await metadata(root);
  if (existing?.isSymbolicLink()) {
    try {
      if (!(await stat(root)).isDirectory()) throw new Error("Global configuration root is not a directory.");
      root = await realpath(root);
      existing = await metadata(root);
    } catch (error) {
      throw new ProjectInitializationError("invalid-project", GLOBAL_LAYOUT.invalidRootMessage, { cause: error });
    }
  }

  const createdRootDirectories: string[] = [];
  if (existing === undefined) {
    try {
      const missing: string[] = [];
      let candidate = root;
      while (await metadata(candidate) === undefined) {
        missing.push(candidate);
        const parent = dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
      }
      for (const directory of missing.reverse()) {
        try {
          await mkdir(directory);
          createdRootDirectories.push(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const raced = await metadata(directory);
          if (raced === undefined || raced.isSymbolicLink() || !raced.isDirectory()) throw error;
        }
      }
    } catch (error) {
      const cleanupFailures = await removeEmptyDirectories(createdRootDirectories);
      if (cleanupFailures.length > 0) {
        throw new ProjectInitializationError(
          "write-failed",
          "Global configuration directory creation failed and cleanup was incomplete.",
          { cause: new AggregateError([error, ...cleanupFailures]) },
        );
      }
      throw new ProjectInitializationError("write-failed", "Global configuration directory could not be created.", {
        cause: error,
      });
    }
  }
  try {
    return await initializeRoot(root, install.layout, install.assets);
  } catch (error) {
    const cleanupFailures = await removeEmptyDirectories(createdRootDirectories);
    if (cleanupFailures.length > 0) {
      throw new ProjectInitializationError(
        "write-failed",
        "Global initialization failed and directory cleanup was incomplete.",
        { cause: new AggregateError([error, ...cleanupFailures]) },
      );
    }
    throw error;
  }
}
