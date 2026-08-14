import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { RelativePathError, normalizeManifestPath, normalizeRelativePath } from "../core/path.js";
import type { OperationManifest } from "../core/types.js";
import { validateOperationManifestSchema } from "../core/validate-schema.js";

export interface ToolExecuteBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
  agent?: string;
}

export interface ToolExecuteBeforeOutput {
  args: unknown;
}

export type WriteDenialReason =
  | "manifest-unavailable"
  | "session-expired"
  | "unclassified-command"
  | "path-required"
  | "project-boundary"
  | "manifest-scope"
  | "parallel-git-mutation"
  | "parallel-remote-mutation"
  | "parallel-validation"
  | "session-released"
  | "repeated-denial";

export class WriteDeniedError extends Error {
  readonly reason: WriteDenialReason;

  constructor(reason: WriteDenialReason, path: string, options?: ErrorOptions) {
    const messages: Record<WriteDenialReason, string> = {
      "manifest-unavailable": "operation manifest unavailable.",
      "session-expired": "active session expired; start or resume an explicit Task takeover.",
      "unclassified-command": "unclassified command; use the stated direct-command hint.",
      "path-required": "write path must be explicit.",
      "project-boundary": "project-root-relative path required.",
      "manifest-scope": "operation manifest write scope.",
      "parallel-git-mutation": "parallel implementation workers cannot mutate shared Git state.",
      "parallel-remote-mutation": "parallel implementation workers cannot mutate shared remote state.",
      "parallel-validation": "parallel implementation validation must run after the worker join.",
      "session-released": "released session must re-read only its handoff and bind before further work.",
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
  gitMutation?: boolean;
  remoteMutation?: boolean;
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
/**
 * Tools that never change project files themselves. A dispatched subagent runs in its own session
 * and is gated there, and task-list tools only change session state, so denying them would stop
 * delegation and progress tracking without protecting any path.
 */
const READ_ONLY_TOOLS = new Set([
  "glob", "grep", "list", "list_mcp_resource_templates", "list_mcp_resources", "question",
  "read", "read_mcp_resource", "review_git_evidence", "skill", "task", "todoread", "todowrite",
  "webfetch",
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

function isRemoteGitHubMutation(tokens: readonly string[]): boolean {
  const command = tokens[1]?.toLowerCase();
  if (command === "project") {
    return !new Set(["field-list", "item-list", "list", "view"]).has(tokens[2]?.toLowerCase() ?? "");
  }
  // GraphQL transport can hide mutations in variables, files, or stdin; parallel workers fail closed.
  return command === "api" && tokens[2]?.toLowerCase() === "graphql";
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
    const segmentBefore = masked.slice(start, index).trim();
    const hasCommandBefore = segmentBefore.length > 0;
    const powershellCallOperator = dialect === "powershell" &&
      (segmentBefore.length === 0 || segmentBefore.endsWith("="));
    const separator = pair === "&&" || pair === "||" ? 2
      : character === ";" || character === "\n" || character === "\r" ||
          (character === "|" && command[index - 1] !== ">") ||
          (character === "&" && hasCommandBefore && command[index - 1] !== ">" && !powershellCallOperator) ? 1 : 0;
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
  let gitMutation = false;
  let remoteMutation = false;
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
      gitMutation = true;
      const selected = exactGitAddPaths(tokens);
      if (selected === undefined) ambiguous = true;
      else paths.push(...selected);
    } else if (executable === "git" && tokens[1]?.toLowerCase() === "commit") {
      applies = true;
      gitMutation = true;
      if (isSafeGitCommit(tokens)) gitCommit = true;
      else ambiguous = true;
    } else if (executable === "git" && isReadOnlyGitCommand(tokens)) {
      // Explicitly read-only git subcommands.
    } else if (/^gh(?:\.exe)?$/u.test(executable) && isRemoteOnlyGitHubCommand(tokens)) {
      // Remote operations are pathless, but parallel workers must distinguish reads from mutations.
      remoteMutation ||= isRemoteGitHubMutation(tokens);
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
        gitMutation ||= nested.gitMutation === true;
        remoteMutation ||= nested.remoteMutation === true;
        issue ??= nested.issue;
      }
    } else if (!READ_ONLY_COMMANDS.has(executable)) {
      applies = true;
      ambiguous = true;
      issue ??= commandIssue(source, "executable-not-allowlisted", "use a direct allowlisted read-only command");
    }
  }
  return {
    applies,
    ambiguous,
    paths,
    ...(gitCommit ? { gitCommit: true } : {}),
    ...(gitMutation ? { gitMutation: true } : {}),
    ...(remoteMutation ? { remoteMutation: true } : {}),
    ...(issue ? { issue } : {}),
  };
}

function issuePath(issue: CommandIssue): string {
  return `segment=${issue.segment}; cause=${issue.cause}; hint=${issue.hint}; retry=false; action=return-denial-to-coordinator`;
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
      ...(extracted.gitMutation ? { gitMutation: true } : {}),
      ...(extracted.remoteMutation ? { remoteMutation: true } : {}),
      ...(extracted.issue ? { issue: extracted.issue } : {}),
    };
  }
  return { applies: false, ambiguous: false, paths: [] };
}

/**
 * Bootstrap is intentionally narrower than the normal write extractor: only one native Write or
 * one single-file apply_patch envelope exposes enough structure to authorize a missing control file.
 */
export function bootstrapWritePaths(tool: string, args: unknown): readonly string[] | undefined {
  const name = tool.toLowerCase();
  if (name === "write") {
    const paths = directPaths(args);
    return paths.length === 1 ? paths : undefined;
  }
  if (name !== "apply_patch" || !isRecord(args) || typeof args.patchText !== "string") {
    return undefined;
  }
  const paths: string[] = [];
  let operationCount = 0;
  for (const line of args.patchText.split(/\r?\n/u)) {
    const operation = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/u.exec(line);
    if (operation !== null) {
      operationCount += 1;
      if (operation[1] === "Delete") return undefined;
      paths.push(operation[2]!);
    }
    if (/^\*\*\* Move to:/u.test(line) || /^\+\+\+\s/u.test(line)) return undefined;
  }
  return operationCount >= 1 && operationCount <= 2 && paths.length === operationCount ? paths : undefined;
}

export function isGitMutation(tool: string, args: unknown): boolean {
  return extractWritePaths(tool, args).gitMutation === true;
}

export function isRemoteMutation(tool: string, args: unknown): boolean {
  return extractWritePaths(tool, args).remoteMutation === true;
}

/**
 * Quoted segments keep their contents; every unquoted whitespace run collapses to one space so the
 * same command written with different spacing compares equal.
 */
export function normalizeCommand(command: string): string {
  let quote: "\"" | "'" | undefined;
  let whitespace = false;
  let normalized = "";
  for (const character of command.trim()) {
    if (quote !== undefined) {
      normalized += character;
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      if (whitespace && normalized.length > 0) normalized += " ";
      whitespace = false;
      quote = character;
      normalized += character;
    } else if (/\s/u.test(character)) {
      whitespace = true;
    } else {
      if (whitespace && normalized.length > 0) normalized += " ";
      whitespace = false;
      normalized += character;
    }
  }
  return normalized;
}

/** Unbound sessions may invoke only tools whose complete input is known to be read-only. */
export function isKnownReadOnlyTool(
  tool: string,
  args: unknown,
  additionalReadOnlyTools: ReadonlySet<string> = new Set(),
): boolean {
  const name = tool.toLowerCase();
  if (READ_ONLY_TOOLS.has(name) || additionalReadOnlyTools.has(name)) return true;
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

function toggledCaseProbe(path: string): { original: string; alternate: string } | undefined {
  let candidate = resolve(path);
  while (true) {
    const name = basename(candidate);
    const index = [...name].findIndex((character) => /[A-Za-z]/u.test(character));
    if (index >= 0) {
      const characters = [...name];
      const character = characters[index]!;
      characters[index] = character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase();
      return {
        original: candidate,
        alternate: resolve(candidate, "..", characters.join("")),
      };
    }
    const parent = resolve(candidate, "..");
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function isCaseInsensitivePath(path: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  const probe = toggledCaseProbe(path);
  if (probe === undefined || probe.alternate === probe.original) return false;
  try {
    return resolve(await realpath(probe.alternate)) === resolve(await realpath(probe.original));
  } catch {
    return false;
  }
}

async function canonicalPotentialPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const realCandidate = await realpath(candidate);
      const canonical = resolve(realCandidate, ...missing);
      return await isCaseInsensitivePath(candidate)
        ? canonical.toLowerCase()
        : canonical;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      const parent = resolve(candidate, "..");
      if (parent === candidate) throw error;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonicalManifestScopes(
  project: ProjectPaths,
  entries: readonly string[],
): Promise<readonly string[]> {
  const scopes = await Promise.all(entries.map(async (entry) => {
    const normalized = normalizeManifestPath(entry);
    const absolute = normalized.kind === "relative"
      ? project.absolute(normalized.path)
      : resolve(normalized.path);
    return await canonicalPotentialPath(absolute);
  }));
  return [...new Set(scopes)];
}

/** Canonical scopes let sibling worker bindings reject equal or ancestor ownership. */
export async function canonicalManifestWriteScopes(
  project: ProjectPaths,
  manifest: OperationManifest,
): Promise<readonly string[]> {
  return await canonicalManifestScopes(project, manifest.write);
}

export async function canonicalManifestReadScopes(
  project: ProjectPaths,
  manifest: OperationManifest,
): Promise<readonly string[]> {
  return await canonicalManifestScopes(project, manifest.read);
}

export function writeScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) =>
    right.some((rightPath) => isWithin(leftPath, rightPath) || isWithin(rightPath, leftPath))
  );
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
  // A build or test command may touch any path its toolchain owns, so it can never be classified by
  // path extraction. The manifest already declares the commands this candidate is allowed to run,
  // so an exact match against that declaration is the only accepted form.
  const declaredValidation = new Set(manifest.validation.map(normalizeCommand));
  const writable = new Set<string>();
  const externalEntries: string[] = [];
  try {
    for (const entry of manifest.write) {
      const normalized = normalizeManifestPath(entry);
      if (normalized.kind === "relative") writable.add(normalized.path);
      else {
        if (!isAbsolute(normalized.path)) throw new RelativePathError("absolute");
        externalEntries.push(resolve(normalized.path));
      }
    }
  } catch (error) {
    throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: error });
  }
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
  const externalDirectories: { path: string; realPath: string }[] = [];
  const externalFiles: { path: string; realPath?: string; anchorRealPath: string }[] = [];
  for (const path of externalEntries) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new WriteDeniedError("manifest-unavailable", "<unknown>");
      }
      if (metadata.isDirectory()) {
        externalDirectories.push({ path, realPath: await realpath(path) });
      } else {
        externalFiles.push({ path, realPath: await realpath(path), anchorRealPath: await realpath(resolve(path, "..")) });
      }
    } catch (error) {
      if (error instanceof WriteDeniedError) throw error;
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw new WriteDeniedError("manifest-unavailable", "<unknown>", { cause: error });
      }
      externalFiles.push({ path, anchorRealPath: await nearestExistingRealPath(resolve(path, "..")) });
    }
  }
  const matchingExternalScopes = (absolute: string) => ({
    files: externalFiles.filter((scope) => scope.path === absolute),
    directories: externalDirectories.filter((scope) => isWithin(scope.path, absolute)),
  });
  const isExternalWritable = async (absolute: string): Promise<boolean> => {
    const scopes = matchingExternalScopes(absolute);
    for (const scope of scopes.files) {
      if (await isSymbolicLink(absolute)) return false;
      try {
        const targetRealPath = await realpath(absolute);
        if (scope.realPath !== undefined) return isWithin(scope.realPath, targetRealPath) && isWithin(targetRealPath, scope.realPath);
        return isWithin(scope.anchorRealPath, targetRealPath);
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") return false;
        try {
          return isWithin(scope.anchorRealPath, await nearestExistingRealPath(resolve(absolute, "..")));
        } catch {
          return false;
        }
      }
    }
    if (scopes.directories.length === 0) return false;
    try {
      const realTarget = await nearestExistingRealPath(absolute);
      return scopes.directories.some((scope) => isWithin(scope.realPath, realTarget));
    } catch {
      return false;
    }
  };
  const checkPath = async (path: string): Promise<void> => {
    let manifestPath: ReturnType<typeof normalizeManifestPath>;
    try {
      manifestPath = normalizeManifestPath(path);
    } catch (error) {
      if (error instanceof RelativePathError) {
        throw new WriteDeniedError("project-boundary", path, { cause: error });
      }
      throw error;
    }
    if (manifestPath.kind === "absolute") {
      if (!isAbsolute(manifestPath.path)) throw new WriteDeniedError("project-boundary", path);
      const absolute = resolve(manifestPath.path);
      if (await project.contains(absolute)) {
        const normalized = await project.toRelativePath(absolute);
        if (!await isWritable(normalized)) throw new WriteDeniedError("manifest-scope", normalized);
        return;
      }
      const scopes = matchingExternalScopes(absolute);
      if (scopes.files.length === 0 && scopes.directories.length === 0) {
        throw new WriteDeniedError("project-boundary", path);
      }
      if (!await isExternalWritable(absolute)) throw new WriteDeniedError("manifest-scope", path);
      return;
    }
    let normalized: string;
    try {
      normalized = await project.toRelativePath(manifestPath.path);
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
      const command = isRecord(output.args) && typeof output.args.command === "string"
        ? normalizeCommand(output.args.command)
        : undefined;
      if (command !== undefined && declaredValidation.has(command)) return;
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
