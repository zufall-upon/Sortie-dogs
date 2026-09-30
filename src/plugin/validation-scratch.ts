import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { createProjectPaths } from "./gate.js";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";

const controlDirectories = new Set([".git", ".opencode", ...Object.values(RUNTIME_PROFILES).map(profile => profile.stateDirectory)]);

/** WSL's default drive mount and a native Windows project share one path identity. */
function nativeScratchPath(directory: string, value: string): string | undefined {
  const declared = value.replace(/^\$\{?PWD\}?/u, directory);
  if (/[$`]/u.test(declared)) return undefined;
  const wsl = process.platform === "win32" ? /^\/mnt\/([a-z])\/(.+)$/iu.exec(declared) : null;
  return wsl ? win32.resolve(`${wsl[1]!.toUpperCase()}:\\`, wsl[2]!.replaceAll("/", "\\")) : resolve(directory, declared);
}

function localScratchPath(directory: string, target: string): string | undefined {
  const scoped = relative(directory, target).replaceAll("\\", "/");
  return !scoped || scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped) ? undefined : scoped;
}

const isControl = (path: string) => controlDirectories.has(process.platform === "win32" ? path.split("/")[0]!.toLowerCase() : path.split("/")[0]!);

/** Only explicitly configured tool scratch/cache outputs; no filename, ignored or untracked heuristic. */
export function validationScratchPaths(directory: string, commands: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const command of commands) for (const match of command.matchAll(/(?:^|\s)(TMPDIR|GOCACHE|GOMODCACHE|GOPATH)=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gu)) {
    const absolute = nativeScratchPath(directory, match[2] ?? match[3] ?? match[4]!);
    if (!absolute) continue;
    const scoped = localScratchPath(directory, absolute);
    if (!scoped || isControl(scoped)) continue;
    if (match[1] === "GOPATH") { paths.add(resolve(absolute, "pkg/mod")); paths.add(resolve(absolute, "pkg/sumdb")); }
    else paths.add(absolute);
  }
  return [...paths].sort();
}

/** Prepare only an explicitly declared, in-project TMPDIR before a Worker starts validation. */
export async function prepareValidationScratch(directory: string, commands: readonly string[]): Promise<{
  prepared_directories: string[]; unprepared_directories: string[];
}> {
  const prepared_directories: string[] = [], unprepared_directories: string[] = [];
  if (!commands.some(command => /(?:^|\s)TMPDIR=/u.test(command))) return { prepared_directories, unprepared_directories };
  const project = await createProjectPaths(directory);
  const seen = new Set<string>();
  for (const command of commands) {
    for (const match of command.matchAll(/(?:^|\s)TMPDIR=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gu)) {
      const declared = match[1] ?? match[2] ?? match[3]!;
      // Preparation retains its absolute-path contract; freshness also accepts explicit local paths.
      const target = isAbsolute(declared) ? nativeScratchPath(directory, declared) : undefined;
      if (!target) continue;
      const path = localScratchPath(project.root, target);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (isControl(path) || !await project.contains(target).catch(() => false)) {
        unprepared_directories.push(path);
        continue;
      }
      try {
        const stat = await lstat(target).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (stat?.isDirectory()) continue;
        if (stat) throw new Error("path is not a directory");
        await mkdir(target, { recursive: true });
        prepared_directories.push(path);
      } catch {
        // Existing Worker dispatch remains available; the Coordinator sees the missing setup.
        unprepared_directories.push(path);
      }
    }
  }
  return { prepared_directories, unprepared_directories };
}
