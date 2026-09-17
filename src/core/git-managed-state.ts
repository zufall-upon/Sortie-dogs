import { execFile } from "node:child_process";
import { open, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_PROFILES, type RuntimeProfile } from "./runtime-profile.js";

const samePath = (left: string, right: string): boolean => process.platform === "win32"
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function git(root: string, executable: string, args: readonly string[]): Promise<string | undefined> {
  try {
    return (await promisify(execFile)(executable, [...args], {
      cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024,
    })).stdout.trim();
  } catch {
    return undefined;
  }
}

async function safeDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error("operator-git-managed-state-path-unsafe");
  }
}

/**
 * Keep only the plugin-owned profile state invisible to normal Git status.
 * The repository-local exclude file is Git metadata, not a source-tree policy.
 * Callers invoke this only for an explicitly requested Git workflow; an
 * enclosing repository is not the source root and therefore fails closed.
 */
export async function ensureGitManagedStateExcluded(
  sourceRoot: string,
  profile: RuntimeProfile,
  executable = "git",
): Promise<boolean> {
  const root = resolve(sourceRoot);
  const known = Object.values(RUNTIME_PROFILES).some(candidate =>
    candidate.id === profile.id && candidate.stateDirectory === profile.stateDirectory);
  if (!known || !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile.stateDirectory)) {
    throw new Error("operator-git-managed-state-profile-unknown");
  }
  const top = await git(root, executable, ["rev-parse", "--show-toplevel"]);
  if (top === undefined) return false;
  if (!samePath(top, root)) throw new Error("operator-git-managed-state-root-mismatch");
  const commonValue = await git(root, executable, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const excludeValue = await git(root, executable, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (commonValue === undefined || excludeValue === undefined) {
    throw new Error("operator-git-managed-state-metadata-unavailable");
  }
  const common = resolve(root, commonValue);
  const exclude = resolve(root, excludeValue);
  if (!inside(common, exclude) || !samePath(exclude, join(common, "info", "exclude"))) {
    throw new Error("operator-git-managed-state-path-unsafe");
  }
  await safeDirectory(common);
  const info = dirname(exclude);
  try { await mkdir(info); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await safeDirectory(info);

  const pattern = `/${profile.stateDirectory}/`;
  try {
    const existing = await lstat(exclude);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("operator-git-managed-state-path-unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let handle;
  try { handle = await open(exclude, "a+"); }
  catch (error) { throw new Error("operator-git-managed-state-exclude-open-failed", { cause: error }); }
  try {
    const pathMetadata = await lstat(exclude);
    const fileMetadata = await handle.stat();
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || !fileMetadata.isFile() ||
        !samePath(await realpath(exclude), exclude)) {
      throw new Error("operator-git-managed-state-path-unsafe");
    }
    const source = await handle.readFile();
    if (source.toString("utf8").split(/\r?\n/u).includes(pattern)) return true;
    const newline = source.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    const prefix = source.length === 0 || source.at(-1) === 0x0a ? "" : newline;
    await handle.writeFile(`${prefix}${pattern}${newline}`);
    return true;
  } finally {
    await handle.close();
  }
}
