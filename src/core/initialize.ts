import { lstat, mkdir, open, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const assets: typeof import("../runtime-assets.js") = await import(
  `../runtime-assets.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);
const { runtimeAssets } = assets;

const OPEN_CODE_DIRECTORY = ".opencode";
const VERSION_MARKER = `${OPEN_CODE_DIRECTORY}/sortie-dogs.version`;

export type InitializationStatus = "installed" | "unchanged";

export interface InitializeProjectResult {
  readonly status: InitializationStatus;
  readonly version: string;
  readonly installedPaths: readonly string[];
}

export type ProjectInitializationErrorCode =
  | "conflict"
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

function assetVersion(): string {
  const versions = new Set(runtimeAssets.map(({ version }) => version));
  if (versions.size !== 1) {
    throw new ProjectInitializationError("write-failed", "Runtime assets do not share one version.");
  }
  return versions.values().next().value!;
}

function safeAssetPath(installPath: string): string {
  const unified = installPath.replaceAll("\\", "/");
  const segments = unified.split("/");
  if (isAbsolute(installPath) || /^[A-Za-z]:/u.test(unified) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ProjectInitializationError("unsafe-path", "A runtime asset has an unsafe install path.");
  }
  return `${OPEN_CODE_DIRECTORY}/${unified}`;
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

async function rollback(createdFiles: readonly string[], createdDirectories: readonly string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const file of [...createdFiles].reverse()) {
    await rm(file, { force: true }).catch((error) => failures.push(error));
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

/** Installs the packaged runtime into one existing project without changing user settings. */
export async function initializeProject(projectRoot: string = process.cwd()): Promise<InitializeProjectResult> {
  const root = resolve(projectRoot);
  const rootInfo = await metadata(root);
  if (rootInfo === undefined || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ProjectInitializationError("invalid-project", "Project root must be an existing non-symlink directory.");
  }

  const version = assetVersion();
  const entries: InstallEntry[] = [
    ...runtimeAssets.map(({ installPath, content }) => ({
      relativePath: safeAssetPath(installPath),
      content,
    })),
    { relativePath: VERSION_MARKER, content: `${version}\n` },
  ];

  const existing = await Promise.all(entries.map(async (entry) => {
    const present = await assertSafeExistingPath(root, entry.relativePath, true);
    return present ? await readFile(resolve(root, entry.relativePath), "utf8") : undefined;
  }));
  const presentCount = existing.filter((content) => content !== undefined).length;
  if (presentCount === entries.length && existing.every((content, index) => content === entries[index].content)) {
    return { status: "unchanged", version, installedPaths: entries.map(({ relativePath }) => relativePath) };
  }
  if (presentCount !== 0) {
    throw new ProjectInitializationError("conflict", "Existing Sortie-dogs runtime files conflict with initialization.");
  }

  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  try {
    for (const entry of entries) {
      const parent = dirname(entry.relativePath).replaceAll("\\", "/");
      await ensureDirectory(root, parent, createdDirectories);
      await assertSafeExistingPath(root, parent, false);
      await createFile(resolve(root, entry.relativePath), entry.content, createdFiles);
    }
  } catch (error) {
    try {
      await rollback(createdFiles, createdDirectories);
    } catch (rollbackError) {
      throw new ProjectInitializationError("write-failed", "Initialization failed and rollback was incomplete.", {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    if (error instanceof ProjectInitializationError) throw error;
    const code = (error as NodeJS.ErrnoException).code === "EEXIST" ? "conflict" : "write-failed";
    throw new ProjectInitializationError(code, "Initialization failed without changing the project.", { cause: error });
  }

  return { status: "installed", version, installedPaths: entries.map(({ relativePath }) => relativePath) };
}
