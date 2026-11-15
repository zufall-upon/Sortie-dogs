import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
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

/** A tracked submodule must refer to its own protected superproject metadata, not an
 * arbitrary repository selected by a Worker-writable .git file. Return the verified
 * gitdir so subsequent Git commands cannot race a replacement of that marker. */
export async function trustedSubmoduleGitdir(directory: string, child: string, parentGitdir?: string): Promise<string | undefined> {
  const scoped = relative(directory, child).replaceAll("\\", "/");
  if (!scoped || scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) return undefined;
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
  const git = async (args: string[]) => (await exec("git", [...pinnedGitArguments(directory, parentGitdir),
    "-c", "core.fsmonitor=false", ...args], { cwd: directory, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
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
    const [top, common, modules] = await Promise.all([
      git(["rev-parse", "--show-toplevel"]), git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(["config", "--blob=:.gitmodules", "--null", "--list"]),
    ]);
    const names = modules.split("\0").filter(Boolean).flatMap(entry => {
      const split = entry.indexOf("\n"), key = entry.slice(0, split), value = entry.slice(split + 1);
      const name = /^submodule\.([\s\S]+)\.path$/u.exec(key)?.[1];
      return name && canonical(resolve(line(top), value)) === canonical(child) ? [name] : [];
    });
    if (names.length !== 1) throw fail();
    const logicalModules = resolve(line(common), "modules");
    const modulesRoot = await realpath(logicalModules);
    const expectedPath = resolve(modulesRoot, names[0]!);
    const actualPath = resolve(child, match[1]!);
    // Check the lexical boundary before touching a path supplied by the marker.
    if (!inside(modulesRoot, expectedPath) || !inside(logicalModules, actualPath) && !inside(modulesRoot, actualPath)) throw fail();
    const expected = await realpath(expectedPath);
    const actual = await realpath(actualPath);
    if (!inside(modulesRoot, expected) || canonical(expected) !== canonical(actual)) throw fail();
    // An edited .gitmodules/index must not redirect one gitlink to a different
    // protected module. The protected module's own config binds its worktree.
    const worktree = line(await git(["config", "--no-includes", "--file", join(expected, "config"), "--get", "core.worktree"]));
    const declaredWorktree = resolve(expected, worktree), physicalChild = await realpath(child);
    if (canonical(declaredWorktree) !== canonical(child) && canonical(declaredWorktree) !== canonical(physicalChild)) throw fail();
    const commonFile = join(expected, "commondir");
    const commonContent = await readPointer(commonFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (commonContent !== undefined) {
      const commonPath = resolve(expected, line(commonContent));
      if (!inside(expected, commonPath) || !inside(expected, await realpath(commonPath))) throw fail();
    }
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
  const submodule = await trustedSubmoduleGitdir(parent, child, parentGitdir);
  if (submodule) return submodule;
  const marker = join(child, ".git");
  const info = await lstat(marker).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (!info || info.isDirectory()) return undefined;
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
    // A linked worktree's protected administrative record points back to this exact
    // marker. Metadata inside the writable Location is not an independent record.
    const rootGit = await realpath(join(root, ".git")).catch(() => undefined);
    if (inside(await realpath(root), gitdir) && (!rootGit || !inside(rootGit, gitdir))) throw fail();
    const backlink = line(await readPointer(join(gitdir, "gitdir")));
    const declaredMarker = resolve(gitdir, backlink), physicalMarker = join(await realpath(child), ".git");
    if (canonical(declaredMarker) !== canonical(marker) && canonical(declaredMarker) !== canonical(physicalMarker)) throw fail();
    const commonPath = resolve(gitdir, line(await readPointer(join(gitdir, "commondir"))));
    if (canonical(commonPath) !== canonical(dirname(dirname(gitdir)))) throw fail();
    const common = await realpath(commonPath);
    if (canonical(await realpath(join(common, "worktrees"))) !== canonical(dirname(gitdir))) throw fail();
    return gitdir;
  } catch { throw fail(); }
}
