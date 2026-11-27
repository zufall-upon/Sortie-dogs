import { lstat, mkdir } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, win32 } from "node:path";
import { createProjectPaths, shellCommandWords } from "./gate.js";
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

/** npm accepts case-insensitive config keys, but the shell can retain multiple spellings.
 * Only use an unambiguous literal environment setting, not npm's defaults or config files. */
function npmCachePath(directory: string, command: string, inherited: Readonly<Record<string, string | undefined>>): string | undefined {
  // Newlines may separate shell statements, so an assignment on one line
  // cannot establish the environment of a later command.
  if (/[\r\n]/u.test(command)) return undefined;
  const values = new Map<string, { value: string; expandPwd: boolean; unquoted: boolean }>();
  const name = (key: string) => process.platform === "win32" ? key.toLowerCase() : key;
  for (const [key, value] of Object.entries(inherited)) {
    if (/^npm_config_cache$/iu.test(key) && value !== undefined) values.set(name(key), { value, expandPwd: false, unquoted: false });
  }
  // Recognize literal leading shell assignments (also after `env`). Assignments in
  // later shell segments or arguments cannot safely override the inherited recipe.
  const prefix = /^\s*(?:env\s+)?((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)*)/u.exec(command)!;
  const rest = command.slice(prefix[0].length);
  if (/\bnpm_config_cache\s*=/iu.test(rest) || /(?:^|\s)--cache(?:=|\s|$)/iu.test(command) ||
      /\bunset\b[^;&|\n]*\bnpm_config_cache\b/iu.test(command) ||
      /\benv\b[^;&|\n]*(?:-u\s*|--unset(?:=|\s+))['"]?npm_config_cache\b/iu.test(command) ||
      /\benv\s+(?:-i\b|--ignore-environment\b)/iu.test(command)) return undefined;
  // Decode ordinary quoted options too. Unknown env modifiers may change the
  // environment or cwd, so they cannot justify an inherited cache exemption.
  const words = shellCommandWords(command);
  if (words.some(word => /^--cache(?:=|$)/iu.test(word))) return undefined;
  for (let index = 0; index < words.length; index++) {
    if (!/(?:^|[\\/])env(?:\.exe)?$/iu.test(words[index]!)) continue;
    for (let option = index + 1; option < words.length && words[option]!.startsWith("-"); option++) {
      const token = words[option]!;
      if (token === "--") break;
      if (token === "-i" || token === "--ignore-environment" || token === "-") return undefined;
      const attached = /^(?:-u|--unset=)(.+)$/u.exec(token);
      const key = token === "-u" || token === "--unset" ? words[++option] : attached?.[1];
      if (key === undefined || /^npm_config_cache$/iu.test(key)) return undefined;
    }
  }
  for (const match of prefix[1]!.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s"']*))/gu)) {
    if (/^npm_config_cache$/iu.test(match[1]!)) {
      values.set(name(match[1]!), { value: match[2] ?? match[3] ?? match[4]!, expandPwd: match[3] === undefined, unquoted: match[4] !== undefined });
    }
  }
  const paths = [...values.values()].filter(entry => entry.value !== "").map(entry => {
    // npm trims path config and expands home-relative values even when the shell
    // passes them literally. Do not hide a different project-local pathname.
    if (entry.value !== entry.value.trim() || /^~(?:[\\/]|$)/u.test(entry.value)) return undefined;
    const declared = entry.expandPwd ? entry.value.replace(/^(?:\$\{PWD\}|\$PWD)(?=\/|$)/u, directory) : entry.value;
    if (/[$`]/u.test(declared) || process.platform !== "win32" && declared.includes("\\") ||
        entry.unquoted && /[;&|<>(){}[\]*?~]/u.test(declared) ||
        !isAbsolute(declared) && /\b(?:cd|pushd|popd|set-location)\b/iu.test(command)) return undefined;
    return nativeScratchPath(directory, declared);
  });
  return paths.length && paths.every(path => path !== undefined && path === paths[0]) ? paths[0] : undefined;
}

/** Only configured tool scratch/cache outputs; no filename, ignored or untracked heuristic. */
export function validationScratchPaths(directory: string, commands: readonly string[],
  inherited: Readonly<Record<string, string | undefined>> = {}, commandDirectory = directory): string[] {
  const paths = new Set<string>();
  for (const command of commands) {
    const npmCache = npmCachePath(commandDirectory, command, inherited);
    if (npmCache) {
      const scoped = localScratchPath(directory, npmCache);
      if (scoped && !isControl(scoped)) paths.add(npmCache);
    }
    const configured = new Map<string, string>();
    for (const key of ["TMPDIR", "GOCACHE", "GOMODCACHE", "GOPATH"]) {
      if (inherited[key]) configured.set(key, inherited[key]!);
    }
    for (const match of command.matchAll(/(?:^|\s)(TMPDIR|GOCACHE|GOMODCACHE|GOPATH)=(?:"([^"]*)"|'([^']*)'|([^\s"']*))/gu)) {
      configured.set(match[1]!, match[2] ?? match[3] ?? match[4]!);
    }
    for (const [key, value] of configured) for (const declared of key === "GOPATH" ? value.split(delimiter) : [value]) {
      if (!declared || key === "GOCACHE" && declared === "off") continue;
      const absolute = nativeScratchPath(commandDirectory, declared);
      if (!absolute) continue;
      const scoped = localScratchPath(directory, absolute);
      if (!scoped || isControl(scoped)) continue;
      if (key === "GOPATH") { paths.add(resolve(absolute, "pkg/mod")); paths.add(resolve(absolute, "pkg/sumdb")); }
      else paths.add(absolute);
    }
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
