import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const assets: typeof import("../runtime-assets.js") = await import(
  `../runtime-assets.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);
const { runtimeAssets } = assets;

const OPEN_CODE_DIRECTORY = ".opencode";
const VERSION_MARKER = `${OPEN_CODE_DIRECTORY}/sortie-dogs.version`;
const GLOBAL_VERSION_MARKER = "sortie-dogs.version";

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

function assetVersion(): string {
  const versions = new Set(runtimeAssets.map(({ version }) => version));
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

function classifyVersionTransition(installedValue: string, currentValue: string): VersionTransition {
  const installed = parseVersion(installedValue);
  const current = parseVersion(currentValue);
  if (installed === undefined || current === undefined) return "incompatible";
  const order = compareVersions(installed, current);
  if (order === 0) return "same";
  if (order > 0) return "incompatible";

  // SemVer-compatible update line: stable releases share a major; 0.x releases also share a minor.
  const sameLine = installed.major === current.major &&
    (installed.major !== 0 || installed.minor === current.minor);
  return sameLine ? "compatible-update" : "incompatible";
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

interface InitializationLayout {
  readonly assetPrefix: string;
  readonly markerPath: string;
  readonly preserveAllLegacy: boolean;
  readonly invalidRootMessage: string;
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

async function initializeRoot(
  requestedRoot: string,
  layout: InitializationLayout,
): Promise<InitializeProjectResult> {
  const root = resolve(requestedRoot);
  const rootInfo = await metadata(root);
  if (rootInfo === undefined || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ProjectInitializationError("invalid-project", layout.invalidRootMessage);
  }

  const version = assetVersion();
  const assetEntries: InstallEntry[] = runtimeAssets.map(({ installPath, content }) => ({
    relativePath: safeAssetPath(installPath, layout.assetPrefix),
    content,
  }));
  const entries: InstallEntry[] = [
    ...assetEntries,
    { relativePath: layout.markerPath, content: `${version}\n` },
  ];

  const preservedGlobalLegacyPaths: string[] = [];
  if (layout.preserveAllLegacy) {
    for (const asset of LEGACY_RUNTIME_ASSETS) {
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
  if (markerText !== undefined && parseMarker(markerText.toString("utf8")) === version && assetsMatch) {
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
    if (classifyVersionTransition(installedVersion, version) === "incompatible") {
      throw new ProjectInitializationError(
        "incompatible-version",
        `Installed Sortie-dogs ${installedVersion} cannot be updated to ${version}.`,
      );
    }
  }

  const installedVersion = markerText === undefined ? undefined : parseMarker(markerText.toString("utf8"));
  const removableLegacyFiles: Array<{ asset: LegacyRuntimeAsset; content: Buffer }> = [];
  const preservedLegacyPaths: string[] = [...preservedGlobalLegacyPaths];
  if (!layout.preserveAllLegacy && installedVersion !== undefined) {
    for (const asset of LEGACY_RUNTIME_ASSETS) {
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
    installedPaths: entries.map(({ relativePath }) => relativePath),
    preservedLegacyPaths,
  };
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

/** Installs the packaged runtime into one existing project without changing user settings. */
export async function initializeProject(projectRoot: string = process.cwd()): Promise<InitializeProjectResult> {
  return initializeRoot(projectRoot, PROJECT_LAYOUT);
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
export async function initializeGlobal(globalRoot?: string): Promise<InitializeProjectResult> {
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
    return await initializeRoot(root, GLOBAL_LAYOUT);
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
