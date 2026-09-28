import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { createProjectPaths } from "./gate.js";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";

const controlDirectories = new Set([".git", ".opencode", ...Object.values(RUNTIME_PROFILES).map(profile => profile.stateDirectory)]);

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
      // WSL's default drive mount and a native Windows project refer to the same directory.
      // Other mounts are not inferred from command text.
      const wsl = process.platform === "win32" ? /^\/mnt\/([a-z])\/(.+)$/iu.exec(declared) : null;
      const target = wsl ? win32.resolve(`${wsl[1]!.toUpperCase()}:\\`, wsl[2]!.replaceAll("/", "\\"))
        : isAbsolute(declared) ? resolve(declared) : null;
      if (!target) continue;
      const path = relative(project.root, target).replaceAll("\\", "/");
      if (!path || path === ".." || path.startsWith("../") || seen.has(path)) continue;
      seen.add(path);
      if (controlDirectories.has(path.split("/")[0]!) || !await project.contains(target).catch(() => false)) {
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
