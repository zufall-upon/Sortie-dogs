import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const canonical = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const inside = (root: string, path: string) => {
  const rest = relative(canonical(root), canonical(path));
  return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

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
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readFile(marker, "utf8"));
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
    const modulesRoot = await realpath(join(line(common), "modules"));
    const expected = await realpath(resolve(modulesRoot, names[0]!));
    const actual = await realpath(resolve(child, match[1]!));
    if (!inside(modulesRoot, expected) || canonical(expected) !== canonical(actual)) throw fail();
    // An edited .gitmodules/index must not redirect one gitlink to a different
    // protected module. The protected module's own config binds its worktree.
    const worktree = line(await git(["config", "--no-includes", "--file", join(expected, "config"), "--get", "core.worktree"]));
    if (canonical(await realpath(resolve(expected, worktree))) !== canonical(await realpath(child))) throw fail();
    const commonFile = join(expected, "commondir");
    const commonContent = await readFile(commonFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (commonContent !== undefined && !inside(expected, await realpath(resolve(expected, line(commonContent))))) throw fail();
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
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readFile(marker, "utf8"));
    if (!match) throw fail();
    const gitdir = await realpath(resolve(child, match[1]!));
    // A linked worktree's protected administrative record points back to this exact
    // marker. Metadata inside the writable Location is not an independent record.
    const rootGit = await realpath(join(root, ".git")).catch(() => undefined);
    if (inside(await realpath(root), gitdir) && (!rootGit || !inside(rootGit, gitdir))) throw fail();
    const backlink = line(await readFile(join(gitdir, "gitdir"), "utf8"));
    if (canonical(await realpath(resolve(gitdir, backlink))) !== canonical(await realpath(marker))) throw fail();
    const common = await realpath(resolve(gitdir, line(await readFile(join(gitdir, "commondir"), "utf8"))));
    if (!inside(await realpath(join(common, "worktrees")), gitdir)) throw fail();
    return gitdir;
  } catch { throw fail(); }
}
