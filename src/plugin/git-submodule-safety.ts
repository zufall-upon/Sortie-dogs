import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const canonical = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const inside = (root: string, path: string) => {
  const rest = relative(canonical(root), canonical(path));
  return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

// These are small Git pointer files, never general artifacts. Do not follow a
// replaced symlink, wait for a FIFO, or allocate according to an untrusted size.
async function readPointer(path: string, initial?: Stats): Promise<string> {
  const before = initial ?? await lstat(path);
  if (!before.isFile() || before.size > 65_536) throw new Error("invalid Git pointer file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 65_536) {
      throw new Error("changed Git pointer file");
    }
    const buffer = Buffer.alloc(65_537);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (size > 65_536 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("changed Git pointer file");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
}

/** Use an already verified submodule gitdir instead of rereading its writable .git file. */
export const pinnedGitArguments = (directory: string, gitdir?: string) => gitdir
  ? [`--git-dir=${gitdir}`, `--work-tree=${directory}`] : [];

// A linked worktree can share metadata with another checkout inside the writable
// Location. Do not expose its effective config or Git errors any more than a
// standalone nested checkout's, even when another linked worktree is protected.
export const isLocallyControlledNestedGitdir = (directory: string, gitdir?: string) =>
  gitdir !== undefined && (canonical(gitdir) === canonical(join(directory, ".git")) ||
    basename(dirname(gitdir)).toLowerCase() === "worktrees");

/** Git errors may include effective config values in stderr or command arguments. */
export function sanitizedNestedGitError(error: unknown): Error {
  const original = error as { code?: number | string; stderr?: string };
  const stderr = String(original?.stderr ?? "");
  const known = /^fatal: Needed a single revision\s*$/u.test(stderr) ? "fatal: Needed a single revision"
    : /^fatal: bad object HEAD\s*$/u.test(stderr) ? "fatal: bad object HEAD"
    : /^fatal: not a git repository \(or (?:any of the parent directories|any parent up to mount point [^\r\n)]+)\)(?:: \.git)?\s*$/u.test(stderr)
      ? "fatal: not a git repository (or any of the parent directories): .git" : "";
  const reason = known === "fatal: bad object HEAD" ? ": bad object HEAD" : "";
  return Object.assign(new Error(`git-inspection: cannot inspect nested Git repository${reason}`), { code: original?.code, stderr: known });
}

const missingGitPath = async (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  return undefined;
});

// An alternate is unsafe for Git-based inspection, but a caller that only hashes
// declared filesystem paths can conservatively protect the whole checkout instead.
// The checkout identity prevents an ancestor's failure from authorizing a child.
class AlternateObjectStoreError extends Error {}
class NestedGitAlternatesError extends Error {
  constructor(root: string, readonly checkout: string) {
    super(`not a git repository: untrusted nested Git metadata: ${relative(root, checkout)}`);
  }
}
export const hasNestedGitAlternates = (error: unknown, checkout: string): boolean =>
  error instanceof NestedGitAlternatesError && canonical(error.checkout) === canonical(checkout);

/** The Location's own Git metadata is protected; other metadata inside it can be writable. */
export async function isWritableNestedGitdir(projectRoot: string, gitdir?: string): Promise<boolean> {
  if (!gitdir) return false;
  const logicalRoot = resolve(projectRoot), logicalRootGit = join(logicalRoot, ".git");
  const root = await realpath(projectRoot);
  const rootGit = await realpath(logicalRootGit).catch(() => undefined);
  return (inside(logicalRoot, gitdir) || inside(root, gitdir)) &&
    !inside(logicalRootGit, gitdir) && (!rootGit || !inside(rootGit, gitdir));
}

async function inspectWritableGitPath(path: string, fail: () => Error): Promise<void> {
  const info = await missingGitPath(path);
  if (!info) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw fail();
      if (entry.isDirectory()) await inspectWritableGitPath(join(path, entry.name), fail);
      else if (!entry.isFile()) {
        // Some filesystems return unknown Dirent types.
        const child = await lstat(join(path, entry.name));
        if (child.isSymbolicLink() || !child.isFile()) throw fail();
      }
    }
  } else if (!info.isFile()) throw fail();
}

/** Writable metadata must not redirect Git through commondir, object alternates
 * or metadata symlinks. This also applies to a linked worktree's common Git dir. */
async function trustedStandaloneGitdir(root: string, marker: string, initial: Stats): Promise<string> {
  const fail = () => new Error(`not a git repository: untrusted nested Git metadata: ${relative(root, dirname(marker))}`);
  try {
    // These files redirect Git's common metadata or object database even though
    // the .git marker itself is an ordinary directory.
    if (await missingGitPath(join(marker, "commondir"))) throw fail();
    for (const name of ["HEAD", "index", "config", "config.worktree", "packed-refs", "shallow", "refs", "objects", "info"]) {
      await inspectWritableGitPath(join(marker, name), fail);
    }
    const alternates = await missingGitPath(join(marker, "objects", "info", "alternates"));
    const after = await lstat(marker);
    if (!after.isDirectory() || after.dev !== initial.dev || after.ino !== initial.ino) throw fail();
    if (alternates) throw new AlternateObjectStoreError();
    return marker;
  } catch (error) { if (error instanceof AlternateObjectStoreError) throw error; throw fail(); }
}

/** A tracked submodule must refer to its own protected superproject metadata, not an
 * arbitrary repository selected by a Worker-writable .git file. Return the verified
 * gitdir so subsequent Git commands cannot race a replacement of that marker. */
export async function trustedSubmoduleGitdir(directory: string, child: string, parentGitdir?: string,
  projectRoot = directory): Promise<string | undefined> {
  const scoped = relative(directory, child).replaceAll("\\", "/");
  if (!scoped || scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) return undefined;
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
  const sanitize = isLocallyControlledNestedGitdir(directory, parentGitdir) || await isWritableNestedGitdir(projectRoot, parentGitdir);
  const git = async (args: string[]) => {
    try {
      return (await exec("git", [...pinnedGitArguments(directory, parentGitdir), "-c", "core.fsmonitor=false", ...args],
        { cwd: directory, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (error) { throw sanitize ? sanitizedNestedGitError(error) : error; }
  };
  let stage: string;
  try { stage = await git(["ls-files", "--stage", "-z", "--", scoped]); }
  catch (error) {
    if (/fatal: not a git repository \(or (?:any of the parent directories|any parent up to mount point [^\r\n)]+)\)(?:: \.git)?/u
      .test(String((error as { stderr?: string }).stderr ?? ""))) return undefined;
    throw error;
  }
  if (!stage.split("\0").some(entry => /^160000 [a-f0-9]{40,64} [0-3]\t/u.test(entry) && entry.slice(entry.indexOf("\t") + 1) === scoped)) return undefined;
  const fail = () => new Error(`untrusted Git submodule metadata: ${scoped}`);
  const marker = join(child, ".git");
  const info = await lstat(marker).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (!info) return undefined; // Uninitialized submodules have no metadata to inspect.
  if (!info.isFile()) throw fail();
  try {
    const line = (value: string) => value.replace(/\r?\n$/u, "");
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readPointer(marker, info));
    if (!match) throw fail();
    const [top, modulesPath, modules] = await Promise.all([
      git(["rev-parse", "--show-toplevel"]), git(["rev-parse", "--path-format=absolute", "--git-path", "modules"]),
      git(["config", "--blob=:.gitmodules", "--null", "--list"]),
    ]);
    const names = modules.split("\0").filter(Boolean).flatMap(entry => {
      const split = entry.indexOf("\n"), key = entry.slice(0, split), value = entry.slice(split + 1);
      const name = /^submodule\.([\s\S]+)\.path$/u.exec(key)?.[1];
      return name && canonical(resolve(line(top), value)) === canonical(child) ? [name] : [];
    });
    if (names.length !== 1) throw fail();
    // Git places modules of a linked worktree beneath that worktree's gitdir,
    // not necessarily beneath its common Git directory.
    const logicalModules = resolve(line(modulesPath));
    const logicalExpected = resolve(logicalModules, names[0]!);
    if (!inside(logicalModules, logicalExpected)) throw fail();
    const lexicalWritable = await isWritableNestedGitdir(projectRoot, logicalModules);
    if (lexicalWritable && !(await lstat(logicalModules)).isDirectory()) throw fail();
    const modulesRoot = await realpath(logicalModules);
    const expectedPath = resolve(modulesRoot, names[0]!);
    const actualPath = resolve(child, match[1]!);
    // Check the lexical boundary before touching a path supplied by the marker.
    if (!inside(modulesRoot, expectedPath) || !inside(logicalModules, actualPath) && !inside(modulesRoot, actualPath)) throw fail();
    const expected = await realpath(expectedPath);
    const actual = await realpath(actualPath);
    if (!inside(modulesRoot, expected) || canonical(expected) !== canonical(actual)) throw fail();
    const writable = lexicalWritable || await isWritableNestedGitdir(projectRoot, modulesRoot);
    if (writable) {
      // Neither the module root nor an intermediate name may redirect Git through
      // a symlink, even if the resolved target happens to be inside the Location.
      let path = logicalModules;
      if (!(await lstat(path)).isDirectory()) throw fail();
      for (const part of relative(logicalModules, logicalExpected).split(sep).filter(Boolean)) {
        path = join(path, part);
        if (!(await lstat(path)).isDirectory()) throw fail();
      }
      const before = await lstat(expected);
      await inspectWritableGitPath(expected, fail);
      if (await missingGitPath(join(expected, "objects", "info", "alternates"))) throw fail();
      const after = await lstat(expected);
      if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) throw fail();
    }
    const commonFile = join(expected, "commondir");
    const commonContent = await readPointer(commonFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (commonContent !== undefined) {
      const commonPath = resolve(expected, line(commonContent));
      if (!inside(expected, commonPath) || !inside(expected, await realpath(commonPath))) throw fail();
      if (writable && await missingGitPath(join(commonPath, "objects", "info", "alternates"))) throw fail();
    }
    // An edited .gitmodules/index must not redirect one gitlink to a different
    // module. Its own config binds the worktree after writable metadata is checked.
    const worktree = line(await git(["config", "--no-includes", "--file", join(expected, "config"), "--get", "core.worktree"]));
    const declaredWorktree = resolve(expected, worktree), physicalChild = await realpath(child);
    if (canonical(declaredWorktree) !== canonical(child) && canonical(declaredWorktree) !== canonical(physicalChild)) throw fail();
    return expected;
  } catch { throw fail(); }
}

/** Find the closest enclosing repository without trusting a nested Git marker first. */
export async function trustedNestedGitdir(projectRoot: string, child: string): Promise<string | undefined> {
  const root = resolve(projectRoot);
  if (!inside(root, child) || canonical(root) === canonical(child)) return undefined;
  let parent = dirname(child);
  while (canonical(parent) !== canonical(root)) {
    if (await lstat(join(parent, ".git")).then(() => true, () => false)) break;
    const next = dirname(parent);
    if (next === parent || !inside(root, next)) return undefined;
    parent = next;
  }
  const parentGitdir = canonical(parent) === canonical(root) ? undefined : await trustedNestedGitdir(root, parent);
  const submodule = await trustedSubmoduleGitdir(parent, child, parentGitdir, root);
  if (submodule) return submodule;
  const marker = join(child, ".git");
  const info = await lstat(marker).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (!info) return undefined;
  if (info.isDirectory()) {
    try { return await trustedStandaloneGitdir(root, marker, info); }
    catch (error) {
      if (error instanceof AlternateObjectStoreError) throw new NestedGitAlternatesError(root, child);
      throw error;
    }
  }
  const fail = () => new Error(`not a git repository: untrusted nested Git metadata: ${relative(root, child)}`);
  if (!info.isFile()) throw fail();
  try {
    const line = (value: string) => value.replace(/\r?\n$/u, "");
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readPointer(marker, info));
    if (!match) throw fail();
    const requested = resolve(child, match[1]!);
    // A linked worktree marker identifies an entry in its common worktrees
    // directory. Reject other layouts before opening any selected metadata.
    if (basename(dirname(requested)).toLowerCase() !== "worktrees") throw fail();
    const gitdir = await realpath(requested);
    if (basename(dirname(gitdir)).toLowerCase() !== "worktrees") throw fail();
    // Reciprocal records identify the checkout, but do not by themselves make
    // writable administrative data safe to give to Git.
    const backlink = line(await readPointer(join(gitdir, "gitdir")));
    const declaredMarker = resolve(gitdir, backlink), physicalMarker = join(await realpath(child), ".git");
    if (canonical(declaredMarker) !== canonical(marker) && canonical(declaredMarker) !== canonical(physicalMarker)) throw fail();
    const commonPath = resolve(gitdir, line(await readPointer(join(gitdir, "commondir"))));
    if (canonical(commonPath) !== canonical(dirname(dirname(gitdir)))) throw fail();
    const common = await realpath(commonPath);
    if (canonical(await realpath(join(common, "worktrees"))) !== canonical(dirname(gitdir))) throw fail();
    const rootGit = await realpath(join(root, ".git")).catch(() => undefined);
    if (inside(await realpath(root), gitdir) && (!rootGit || !inside(rootGit, gitdir))) {
      const initial = await lstat(common);
      if (!initial.isDirectory()) throw fail();
      let alternates = false;
      try { await trustedStandaloneGitdir(root, common, initial); }
      catch (error) { if (error instanceof AlternateObjectStoreError) alternates = true; else throw error; }
      const entry = await lstat(gitdir);
      if (!entry.isDirectory()) throw fail();
      await inspectWritableGitPath(gitdir, fail);
      const after = await lstat(gitdir);
      if (!after.isDirectory() || after.dev !== entry.dev || after.ino !== entry.ino) throw fail();
      if (alternates) throw new NestedGitAlternatesError(root, child);
    }
    return gitdir;
  } catch (error) { if (error instanceof NestedGitAlternatesError) throw error; throw fail(); }
}
