import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const GIT_POINTER_LIMIT = 4096;

async function readGitMetadata(path: string): Promise<string | undefined> {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata === undefined) return undefined;
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > GIT_POINTER_LIMIT) throw new Error("invalid-git-metadata");
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("invalid-git-metadata");
  return value;
}

/** One repository-wide lease location shared by OpenCode and other Sortie hosts. */
export async function durableScopeRoot(projectRoot: string): Promise<string | undefined> {
  try {
    const dotGit = join(projectRoot, ".git");
    const dotGitStat = await stat(dotGit);
    let gitDirectory: string;
    if (dotGitStat.isDirectory()) gitDirectory = dotGit;
    else if (dotGitStat.isFile()) {
      const pointer = await readGitMetadata(dotGit);
      const match = pointer === undefined ? undefined : /^gitdir:\s*(.+)$/u.exec(pointer);
      if (!match) return undefined;
      gitDirectory = resolve(dirname(dotGit), match[1]!);
      if (!(await stat(gitDirectory)).isDirectory()) return undefined;
    } else return undefined;
    const commonPointer = await readGitMetadata(join(gitDirectory, "commondir"));
    const commonDirectory = commonPointer === undefined ? gitDirectory : resolve(gitDirectory, commonPointer);
    if (!(await stat(commonDirectory)).isDirectory()) return undefined;
    return join(commonDirectory, "sortie-dogs", "scope-leases");
  } catch {
    return undefined;
  }
}
