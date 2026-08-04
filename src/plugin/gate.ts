import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { RelativePathError, normalizeRelativePath } from "../core/path.js";
import type { OperationManifest } from "../core/types.js";
import { validateOperationManifestSchema } from "../core/validate-schema.js";

export interface ToolExecuteBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

export interface ToolExecuteBeforeOutput {
  args: unknown;
}

export type WriteDenialReason =
  | "manifest-unavailable"
  | "unclassified-command"
  | "path-required"
  | "project-boundary"
  | "manifest-scope"
  | "repeated-denial";

export class WriteDeniedError extends Error {
  readonly reason: WriteDenialReason;

  constructor(reason: WriteDenialReason, path: string, options?: ErrorOptions) {
    const messages: Record<WriteDenialReason, string> = {
      "manifest-unavailable": "operation manifest unavailable.",
      "unclassified-command": "unclassified command; use the stated direct-command hint.",
      "path-required": "write path must be explicit.",
      "project-boundary": "project-root-relative path required.",
      "manifest-scope": "operation manifest write scope.",
      "repeated-denial": "same command and denial reason already denied in this session; retry blocked.",
    };
    super(`Write denied for "${safePath(path)}": ${messages[reason]}`, options);
    this.name = "WriteDeniedError";
    this.reason = reason;
  }
}

export interface ProjectPaths {
  readonly root: string;
  absolute(relativePath: string): string;
  contains(path: string): Promise<boolean>;
  toRelativePath(path: string): Promise<string>;
}

export interface WriteGate {
  check(input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput): Promise<void>;
  checkPath(path: string): Promise<void>;
  toRelativePath(path: string): Promise<string>;
}

interface Extraction {
  applies: boolean;
  ambiguous: boolean;
  paths: string[];
  gitCommit?: boolean;
  issue?: CommandIssue;
}

interface CommandIssue {
  segment: string;
  cause: string;
  hint: string;
}

const execFileAsync = promisify(execFile);

const DIRECT_PATH_KEYS = new Set([
  "file", "filepath", "file_path", "path", "destination", "target",
]);
const ALL_OPERAND_COMMANDS = new Set(["mkdir", "rm", "rmdir", "touch", "truncate", "unlink"]);
const LAST_OPERAND_COMMANDS = new Set(["cp", "install"]);
const READ_ONLY_COMMANDS = new Set([
  "cat", "echo", "false", "get-childitem", "get-content", "get-date", "grep", "head", "ls", "pwd",
  "measure-object", "rg", "select-object", "stat", "tail", "test-path", "true", "type",
  "where-object", "wc",
]);
const READ_ONLY_GIT_COMMANDS = new Set(["diff", "log", "ls-files", "rev-parse", "show", "status"]);
const POWERSHELL_WRITE_COMMANDS = new Set([
  "add-content", "copy-item", "move-item", "new-item", "out-file", "remove-item",
  "rename-item", "set-content",
]);
const READ_ONLY_OPTIONS_WITH_VALUES = new Set(["-c", "--directory", "--exclude", "--include"]);
const READ_ONLY_TOOLS = new Set([
  "glob", "grep", "list", "list_mcp_resource_templates", "list_mcp_resources", "question",
  "read", "read_mcp_resource", "review_git_evidence", "skill", "webfetch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safePath(path: string): string {
  return [...path].map((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : character;
  }).join("").slice(0, 512);
}

export function resolveProjectRoot(input: { directory: string; worktree?: string }): string {
  return resolve(input.directory);
}

function directPaths(args: unknown): string[] {
  if (!isRecord(args)) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (DIRECT_PATH_KEYS.has(key.toLowerCase()) && typeof value === "string") paths.push(value);
    if (/^(?:files|paths|destinations|targets)$/iu.test(key) && Array.isArray(value)) {
      paths.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  return paths;
}

function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/u)) {
    const envelope = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/u.exec(line) ??
      /^\*\*\* Move to:\s*(.+?)\s*$/u.exec(line);
    if (envelope !== null) paths.push(envelope[1]);
    const unified = /^\+\+\+\s+(?:b\/)?(.+?)\s*$/u.exec(line);
    if (unified !== null && unified[1] !== "/dev/null") paths.push(unified[1]);
  }
  return paths;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function words(command: string): string[] {
  return command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/gu)?.map(unquote) ?? [];
}

function operands(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^(?:\d*>>?|>\||[|&])(?:.*)?$/u.test(token)) break;
    if (READ_ONLY_OPTIONS_WITH_VALUES.has(token)) index += 1;
    else if (!token.startsWith("-")) result.push(token.replace(/[|&;]+$/u, ""));
  }
  return result.filter(Boolean);
}

function unwrapEnvironmentCommand(tokens: readonly string[]): readonly string[] {
  const executable = tokens[0]?.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (executable !== "env") return tokens;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "-u" || token === "--unset") {
      index += 2;
    } else if (token.startsWith("--unset=") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1;
    } else {
      break;
    }
  }
  return tokens.slice(index);
}

function isRemoteOnlyGitHubCommand(tokens: readonly string[]): boolean {
  const command = tokens[1]?.toLowerCase();
  return command === "project" || (command === "api" && tokens[2]?.toLowerCase() === "graphql");
}

function isReadOnlyGitCommand(tokens: readonly string[]): boolean {
  const command = tokens[1]?.toLowerCase() ?? "";
  return READ_ONLY_GIT_COMMANDS.has(command) ||
    (command === "branch" && tokens.length === 3 && tokens[2] === "--show-current");
}

function exactGitAddPaths(tokens: readonly string[]): string[] | undefined {
  if (tokens.length < 4 || tokens[2] !== "--") return undefined;
  const paths = tokens.slice(3);
  if (paths.some((path) =>
    path === "." || path.startsWith("-") || path.startsWith(":") ||
    path.includes("*") || path.includes("?") || path.includes("[")
  )) return undefined;
  return paths;
}

function isSafeGitCommit(tokens: readonly string[]): boolean {
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-a" || token === "--all" || token === "--amend") return false;
    if (token === "-m" || token === "--message") {
      if (++index >= tokens.length) return false;
    } else if (/^-m.+/u.test(token) || token.startsWith("--message=")) {
      continue;
    } else if (!["--no-verify", "--signoff", "-s", "--quiet", "-q", "--verbose", "-v"].includes(token)) {
      return false;
    }
  }
  return true;
}

function isLiteralPowerShellAssignment(value: string): boolean {
  return /^(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)|\$(?:null|true|false)|\$[A-Za-z_][A-Za-z0-9_]*|\$env:[A-Za-z_][A-Za-z0-9_]*|'[^']*'|"[^"`$]*")$/iu.test(value);
}

function isSafePowerShellForEach(source: string): boolean {
  return /^(?:foreach-object|%)\s+\{\s*\$_(?:\.[A-Za-z_][A-Za-z0-9_]*)?\s*\}$/iu.test(source);
}

type ShellDialect = "posix" | "powershell";

interface ShellSyntax {
  masked: string;
  unsafeExpansion: boolean;
  activeBrace: boolean;
}

function scanShellSyntax(source: string, dialect: ShellDialect): ShellSyntax {
  const masked = new Array<string>(source.length).fill(" ");
  let quote: "\"" | "'" | undefined;
  let unsafeExpansion = false;
  let activeBrace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== undefined) {
      if (dialect === "powershell" && quote === "\"" && character === "`") {
        unsafeExpansion = true;
        index += 1;
        continue;
      }
      if (dialect === "posix" && quote === "\"" && character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) {
        if (dialect === "powershell" && source[index + 1] === quote) index += 1;
        else quote = undefined;
        continue;
      }
      if (quote === "\"" &&
          (((character === "$" || character === "<") && source[index + 1] === "(") ||
            (character === "$" && source[index + 1] === "{"))) unsafeExpansion = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    masked[index] = character;
    if (character === "`") {
      unsafeExpansion = true;
      if (dialect === "powershell") index += 1;
    } else if (((character === "$" || character === "<") && source[index + 1] === "(") ||
               (character === "$" && source[index + 1] === "{")) {
      unsafeExpansion = true;
    } else if (character === "{" || character === "}") {
      activeBrace = true;
    }
  }
  return { masked: masked.join(""), unsafeExpansion, activeBrace };
}

function shellSegments(command: string, dialect: ShellDialect): string[] {
  const segments: string[] = [];
  const masked = scanShellSyntax(command, dialect).masked;
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    const pair = masked.slice(index, index + 2);
    const separator = pair === "&&" || pair === "||" ? 2
      : character === ";" || character === "\n" || character === "\r" ||
          (character === "|" && command[index - 1] !== ">") ? 1 : 0;
    if (separator === 0) continue;
    segments.push(command.slice(start, index));
    index += separator - 1;
    if (character === "\r" && command[index + 1] === "\n") index += 1;
    start = index + 1;
  }
  segments.push(command.slice(start));
  return segments;
}

function depthOnePowerShellLiteral(source: string): string | undefined {
  const match = /^\s*(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|[^\s"']*(?:pwsh|powershell)(?:\.exe)?)\s+-noprofile\s+-command\s+'((?:''|[^'])*)'\s*$/iu.exec(source);
  return match?.[1].replaceAll("''", "'");
}

function commandIssue(segment: string, cause: string, hint: string): CommandIssue {
  return { segment: segment.trim().slice(0, 240), cause, hint };
}

function shellPaths(command: string, powershell: boolean, depth = 0): Extraction {
  const paths: string[] = [];
  let applies = false;
  let ambiguous = false;
  let gitCommit = false;
  let issue: CommandIssue | undefined;
  const redirection = /(?<![<>=!])(?:&|\d*)?(?:>>|>\||>)(?![=])/gu;
  const redirectionTarget = /^\s*("(?:\\.|[^"])*"|'[^']*'|&?\d+|[^\s;&|]+)/u;
  const dialect: ShellDialect = powershell ? "powershell" : "posix";
  const segments = shellSegments(command, dialect);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    let source = segment.trim();
    let assignment = false;
    const syntax = scanShellSyntax(source, dialect);
    for (const match of syntax.masked.matchAll(redirection)) {
      applies = true;
      const target = redirectionTarget.exec(source.slice(match.index + match[0].length))?.[1];
      if (target === undefined || target.startsWith("&")) {
        ambiguous = true;
        issue ??= commandIssue(source, "redirect-target-unresolved", "name one manifest-scoped output path");
      } else {
        paths.push(unquote(target));
      }
    }
    if (syntax.unsafeExpansion) {
      applies = true;
      ambiguous = true;
      issue ??= commandIssue(source, "active-expansion", "remove substitution and run a direct literal command");
      continue;
    }
    if (powershell) {
      const stripped = source.replace(/^\$[A-Za-z_][A-Za-z0-9_:]*\s*=\s*/u, "");
      assignment = stripped !== source;
      source = stripped;
      if (/^\$env:[A-Za-z_][A-Za-z0-9_]*$/iu.test(source) ||
          (assignment && isLiteralPowerShellAssignment(source))) continue;
    }
    const tokens = unwrapEnvironmentCommand(words(source));
    if (tokens.length === 0) continue;
    const executable = tokens[0].replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
    const commandOperands = operands(tokens);
    if (powershell && syntax.activeBrace) {
      if (segmentIndex > 0 && isSafePowerShellForEach(source)) continue;
      applies = true;
      ambiguous = true;
      issue ??= commandIssue(source, "active-scriptblock", "use strict ForEach-Object { $_.Property } or a direct command");
    } else if (ALL_OPERAND_COMMANDS.has(executable)) {
      applies = true;
      paths.push(...commandOperands);
    } else if (LAST_OPERAND_COMMANDS.has(executable)) {
      applies = true;
      const destination = commandOperands.at(-1);
      if (destination === undefined) ambiguous = true;
      else paths.push(destination);
    } else if (executable === "mv") {
      applies = true;
      if (commandOperands.length < 2) ambiguous = true;
      paths.push(...commandOperands);
    } else if (executable === "tee") {
      applies = true;
      if (commandOperands.length === 0) ambiguous = true;
      paths.push(...commandOperands);
    } else if (POWERSHELL_WRITE_COMMANDS.has(executable)) {
      applies = true;
      const named: string[] = [];
      for (let index = 1; index < tokens.length - 1; index += 1) {
        if (/^-(?:path|literalpath|destination)$/iu.test(tokens[index])) named.push(tokens[index + 1]);
      }
      const selected = named.length > 0 ? named : commandOperands.slice(0, 1);
      if (selected.length === 0) ambiguous = true;
      paths.push(...selected);
    } else if (/^(?:apply_?patch)$/iu.test(executable)) {
      applies = true;
      const selected = patchPaths(segment);
      if (selected.length === 0) ambiguous = true;
      paths.push(...selected);
    } else if (executable === "git" && tokens[1]?.toLowerCase() === "add") {
      applies = true;
      const selected = exactGitAddPaths(tokens);
      if (selected === undefined) ambiguous = true;
      else paths.push(...selected);
    } else if (executable === "git" && tokens[1]?.toLowerCase() === "commit") {
      applies = true;
      if (isSafeGitCommit(tokens)) gitCommit = true;
      else ambiguous = true;
    } else if (executable === "git" && isReadOnlyGitCommand(tokens)) {
      // Explicitly read-only git subcommands.
    } else if (/^gh(?:\.exe)?$/u.test(executable) && isRemoteOnlyGitHubCommand(tokens)) {
      // GitHub Project commands mutate remote state, not project files. Redirections remain gated above.
    } else if (depth === 0 && /^(?:pwsh|powershell)(?:\.exe)?$/u.test(executable)) {
      const literal = depthOnePowerShellLiteral(source);
      if (literal === undefined) {
        applies = true;
        ambiguous = true;
        issue ??= commandIssue(source, "unsupported-pwsh-form", "use pwsh -NoProfile -Command '<literal>' at depth one");
      } else {
        const nested = shellPaths(literal, true, depth + 1);
        applies ||= nested.applies;
        ambiguous ||= nested.ambiguous;
        paths.push(...nested.paths);
        gitCommit ||= nested.gitCommit === true;
        issue ??= nested.issue;
      }
    } else if (!READ_ONLY_COMMANDS.has(executable)) {
      applies = true;
      ambiguous = true;
      issue ??= commandIssue(source, "executable-not-allowlisted", "use a direct allowlisted read-only command");
    }
  }
  return { applies, ambiguous, paths, ...(gitCommit ? { gitCommit: true } : {}), ...(issue ? { issue } : {}) };
}

function issuePath(issue: CommandIssue): string {
  return `segment=${issue.segment}; cause=${issue.cause}; hint=${issue.hint}`;
}

export function describeUnclassifiedCommand(tool: string, args: unknown): string | undefined {
  const extracted = extractWritePaths(tool, args);
  return extracted.ambiguous && extracted.issue !== undefined ? issuePath(extracted.issue) : undefined;
}

/** Extract known write destinations; unknown shell executables fail closed as ambiguous. */
export function extractWritePaths(tool: string, args: unknown): Extraction {
  const name = tool.toLowerCase();
  const paths = directPaths(args);
  if (/^(?:write|edit)(?:$|[_-])/u.test(name)) return { applies: true, ambiguous: paths.length === 0, paths };
  if (/patch/u.test(name)) {
    const patch = isRecord(args) && typeof args.patchText === "string"
      ? args.patchText
      : isRecord(args) && typeof args.patch === "string" ? args.patch : undefined;
    const extracted = patch === undefined ? [] : patchPaths(patch);
    return { applies: true, ambiguous: extracted.length === 0, paths: [...paths, ...extracted] };
  }
  if (/^(?:bash|shell|powershell|pwsh)(?:$|[_-])/u.test(name)) {
    const command = isRecord(args) && typeof args.command === "string" ? args.command : undefined;
    if (command === undefined) {
      const ambiguous = paths.length === 0;
      return {
        applies: paths.length > 0,
        ambiguous,
        paths,
        ...(ambiguous ? {
          issue: commandIssue("<missing-command>", "command-argument-missing", "provide one direct literal command"),
        } : {}),
      };
    }
    const extracted = shellPaths(command, /^(?:powershell|pwsh)(?:$|[_-])/u.test(name));
    return {
      applies: extracted.applies || paths.length > 0,
      ambiguous: extracted.ambiguous,
      paths: [...paths, ...extracted.paths],
      ...(extracted.gitCommit ? { gitCommit: true } : {}),
      ...(extracted.issue ? { issue: extracted.issue } : {}),
    };
  }
  return { applies: false, ambiguous: false, paths: [] };
}

/** Unbound sessions may invoke only tools whose complete input is known to be read-only. */
export function isKnownReadOnlyTool(tool: string, args: unknown): boolean {
  const name = tool.toLowerCase();
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (!/^(?:bash|shell|powershell|pwsh)(?:$|[_-])/u.test(name)) return false;
  const extraction = extractWritePaths(tool, args);
  return !extraction.applies && !extraction.ambiguous;
}

async function nearestExistingRealPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await lstat(candidate);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      const parent = resolve(candidate, "..");
      if (parent === candidate) throw error;
      candidate = parent;
      continue;
    }
    return await realpath(candidate);
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function createProjectPaths(rootCandidate: string): Promise<ProjectPaths> {
  const root = resolve(rootCandidate);
  const realRoot = await realpath(root);
  return {
    root,
    absolute: (relativePath) => resolve(root, relativePath),
    async contains(path): Promise<boolean> {
      const absolute = resolve(path);
      return isWithin(root, absolute) && isWithin(realRoot, await nearestExistingRealPath(absolute));
    },
    async toRelativePath(path): Promise<string> {
      const relativePath = isAbsolute(path) ? relative(root, resolve(path)) : path;
      const normalized = normalizeRelativePath(relativePath);
      const absolute = resolve(root, normalized);
      if (!isWithin(root, absolute) || !isWithin(realRoot, await nearestExistingRealPath(absolute))) {
        throw new WriteDeniedError("project-boundary", normalized);
      }
      return normalized;
    },
  };
}

export async function createWriteGate(project: ProjectPaths, value: unknown): Promise<WriteGate> {
  const validated = validateOperationManifestSchema(value);
  if (!validated.ok) throw new WriteDeniedError("manifest-unavailable", "<unknown>");
  const manifest: OperationManifest = validated.value;
  const writable = new Set(manifest.write.map((path) => normalizeRelativePath(path)));
  const writableDirectories: { path: string; realPath: string }[] = [];
  for (const path of writable) {
    try {
      const metadata = await lstat(project.absolute(path));
      if (metadata.isDirectory()) {
        writableDirectories.push({ path, realPath: await realpath(project.absolute(path)) });
      }
    } catch {
      // Missing, inaccessible, and concurrently changed paths remain exact-only scopes.
    }
  }
  const writableDirectoryPaths = new Set(writableDirectories.map(({ path }) => path));
  const exactWritable = new Set([...writable].filter((path) => !writableDirectoryPaths.has(path)));
  const isWritable = async (normalized: string): Promise<boolean> => {
    if (writable.has(normalized)) return true;
    const scopes = writableDirectories.filter((scope) => normalized.startsWith(`${scope.path}/`));
    if (scopes.length === 0) return false;
    try {
      const realTarget = await nearestExistingRealPath(project.absolute(normalized));
      return scopes.some((scope) => isWithin(scope.realPath, realTarget));
    } catch {
      return false;
    }
  };
  const checkPath = async (path: string): Promise<void> => {
    let normalized: string;
    try {
      normalized = await project.toRelativePath(path);
    } catch (error) {
      if (error instanceof WriteDeniedError) throw error;
      if (error instanceof RelativePathError) {
        throw new WriteDeniedError("project-boundary", path, { cause: error });
      }
      throw error;
    }
    if (!await isWritable(normalized)) throw new WriteDeniedError("manifest-scope", normalized);
  };
  const checkCachedSet = async (): Promise<void> => {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "git",
        [
          "-C", project.root,
          "-c", "core.quotePath=false",
          "diff", "--cached", "--name-only", "--no-renames", "--relative", "-z", "--",
        ],
        { encoding: "utf8", windowsHide: true },
      ));
    } catch (error) {
      throw new WriteDeniedError("manifest-scope", "<cached>", { cause: error });
    }
    let cached: Set<string>;
    try {
      cached = new Set(stdout.split("\0").filter(Boolean).map(normalizeRelativePath));
    } catch (error) {
      throw new WriteDeniedError("manifest-scope", "<cached>", { cause: error });
    }
    if (cached.size === 0) throw new WriteDeniedError("manifest-scope", "<cached>");
    for (const path of cached) {
      if (!await isWritable(path)) throw new WriteDeniedError("manifest-scope", "<cached>");
    }
    if ([...exactWritable].some((path) => !cached.has(path))) {
      throw new WriteDeniedError("manifest-scope", "<cached>");
    }
  };
  return {
    checkPath,
    toRelativePath: project.toRelativePath,
    async check(_input, output): Promise<void> {
      const extracted = extractWritePaths(_input.tool, output.args);
      if (!extracted.applies) return;
      if (extracted.ambiguous || (extracted.paths.length === 0 && !extracted.gitCommit)) {
        if (extracted.issue !== undefined) {
          throw new WriteDeniedError("unclassified-command", issuePath(extracted.issue));
        }
        throw new WriteDeniedError("path-required", "<missing-path>");
      }
      for (const path of extracted.paths) await checkPath(path);
      if (extracted.gitCommit) await checkCachedSet();
    },
  };
}
