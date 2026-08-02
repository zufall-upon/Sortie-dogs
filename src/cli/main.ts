import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CliDiagnostic,
  Diagnostic,
  Handoff,
  OperationManifest,
  SchemaDiagnostic,
} from "../core/types.js";

const core: typeof import("../core/validate-schema.js") = await import(
  `../core/validate-schema.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);
const diagnostics: typeof import("../core/diagnostics.js") = await import(
  `../core/diagnostics.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);
const manifestValidator: typeof import("../core/validate-manifest.js") = await import(
  `../core/validate-manifest.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);
const pathUtils: typeof import("../core/path.js") = await import(
  `../core/path.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);

const LIMITS = {
  handoffBytes: 2 * 1024 * 1024,
  manifestBytes: 512 * 1024,
  changedPathsBytes: 1024 * 1024,
  changedPaths: 10_000,
  arrayItems: 10_000,
  pathCharacters: 512,
  jsonDepth: 32,
} as const;

const USAGE = `Usage: sortie-dogs lint <handoff.json> [<handoff.json> ...]
  [--manifest <operation-manifest.json>]
  [--changed-paths-from <file|->]
  [--changed-path <path> ...]
  [--format text|json] [--quiet] [--strict]`;

type OutputFormat = "text" | "json";

interface ParsedArguments {
  handoffs: string[];
  manifest?: string;
  changedPathsFrom?: string;
  changedPaths: string[];
  changedPathsProvided: boolean;
  format: OutputFormat;
  quiet: boolean;
  strict: boolean;
}

interface ParseSuccess {
  kind: "run";
  value: ParsedArguments;
}

type ParseTerminal = { kind: "help" } | { kind: "usage" };

class InputFailure extends Error {
  readonly safeMessage: string;

  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "InputFailure";
    this.safeMessage = safeMessage;
  }
}

function parseArguments(argv: readonly string[]): ParseSuccess | ParseTerminal {
  if (argv[0] === "--help") {
    return argv.length === 1 ? { kind: "help" } : { kind: "usage" };
  }
  if (argv[0] !== "lint") return { kind: "usage" };

  const parsed: ParsedArguments = {
    handoffs: [],
    changedPaths: [],
    changedPathsProvided: false,
    format: "text",
    quiet: false,
    strict: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { kind: "help" };
    if (argument === "--quiet" || argument === "--strict") {
      parsed[argument === "--quiet" ? "quiet" : "strict"] = true;
      continue;
    }
    if (argument === "--manifest" || argument === "--changed-paths-from" ||
        argument === "--changed-path" || argument === "--format") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { kind: "usage" };
      index += 1;
      if (argument === "--manifest") {
        if (parsed.manifest !== undefined) return { kind: "usage" };
        parsed.manifest = value;
      } else if (argument === "--changed-paths-from") {
        if (parsed.changedPathsFrom !== undefined) return { kind: "usage" };
        parsed.changedPathsFrom = value;
        parsed.changedPathsProvided = true;
      } else if (argument === "--changed-path") {
        parsed.changedPaths.push(value);
        parsed.changedPathsProvided = true;
      } else {
        if (value !== "text" && value !== "json") return { kind: "usage" };
        parsed.format = value;
      }
      continue;
    }
    if (argument.startsWith("-")) return { kind: "usage" };
    parsed.handoffs.push(argument);
  }

  return parsed.handoffs.length === 0 ? { kind: "usage" } : { kind: "run", value: parsed };
}

async function readBoundedFile(file: string, limit: number, label: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length <= limit) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) return buffer.subarray(0, length);
      length += result.bytesRead;
    }
    throw new InputFailure(`${label} exceeds the size limit.`);
  } catch (error) {
    if (error instanceof InputFailure) throw error;
    throw new InputFailure(`${label} could not be read.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedStdin(limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > limit) throw new InputFailure("Changed paths input exceeds the size limit.");
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof InputFailure) throw error;
    throw new InputFailure("Changed paths input could not be read.");
  }
  return Buffer.concat(chunks, length);
}

function checkJsonResources(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const isContainer = Array.isArray(current.value) ||
      (current.value !== null && typeof current.value === "object");
    if (isContainer && current.depth > LIMITS.jsonDepth) {
      throw new InputFailure("JSON input exceeds the nesting depth limit.");
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > LIMITS.arrayItems) {
        throw new InputFailure("JSON input exceeds the array item limit.");
      }
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const item of Object.values(current.value)) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function parseJson(buffer: Buffer, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new InputFailure(`${label} is not valid JSON.`);
  }
  checkJsonResources(value);
  return value;
}

function normalizeChangedPaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const path of paths) {
    if (path.length > LIMITS.pathCharacters) {
      throw new InputFailure("Changed paths input is invalid.");
    }
    try {
      normalized.add(pathUtils.normalizeRelativePath(path));
    } catch (error) {
      if (!(error instanceof pathUtils.RelativePathError)) throw error;
      throw new InputFailure("Changed paths input is invalid.");
    }
    if (normalized.size > LIMITS.changedPaths) {
      throw new InputFailure("Changed paths input exceeds the count limit.");
    }
  }
  return [...normalized];
}

function changedPathLines(buffer: Buffer): string[] {
  return buffer.toString("utf8").split(/\r?\n/u).filter((line) => line.length > 0);
}

function safeSchemaPointer(diagnostic: SchemaDiagnostic): string {
  if (diagnostic.code !== "schema_additionalProperties") return diagnostic.pointer;
  const slash = diagnostic.pointer.lastIndexOf("/");
  return `${diagnostic.pointer.slice(0, Math.max(0, slash))}/@unknown`;
}

function associate(
  file: string,
  input: readonly (Diagnostic | SchemaDiagnostic)[],
): CliDiagnostic[] {
  return input.map((diagnostic) => ({
    file,
    code: diagnostic.code,
    severity: diagnostic.severity,
    pointer: diagnostic.code.startsWith("schema_")
      ? safeSchemaPointer(diagnostic as SchemaDiagnostic)
      : diagnostic.pointer,
    message: diagnostic.message,
  }));
}

function neutralizeTextControlCharacters(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x0a) return "\\n";
    if (codePoint === 0x0d) return "\\r";
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
    return character;
  }).join("");
}

function render(output: readonly CliDiagnostic[], format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(output)}\n`;
  return output.map(({ file, pointer, code, severity, message }) =>
    `${file} ${neutralizeTextControlCharacters(pointer || "/")} ${code} ${severity} ${neutralizeTextControlCharacters(message)}\n`).join("");
}

export async function run(argv: readonly string[]): Promise<number> {
  const result = parseArguments(argv);
  if (result.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (result.kind === "usage") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const options = result.value;
  const output: CliDiagnostic[] = [];
  const failures: string[] = [];
  let manifest: OperationManifest | undefined;
  let changedPaths: string[] | undefined;
  let changedPathsResolved = true;

  if (options.manifest !== undefined) {
    try {
      const value = parseJson(
        await readBoundedFile(options.manifest, LIMITS.manifestBytes, "Manifest input"),
        "Manifest input",
      );
      const validation = core.validateOperationManifestSchema(value);
      if (validation.ok) manifest = validation.value;
      else output.push(...associate("manifest", validation.diagnostics));
    } catch (error) {
      failures.push(error instanceof InputFailure ? error.safeMessage : "Manifest input could not be processed.");
    }
  }

  try {
    const fromFile = options.changedPathsFrom === undefined
      ? []
      : changedPathLines(options.changedPathsFrom === "-"
        ? await readBoundedStdin(LIMITS.changedPathsBytes)
        : await readBoundedFile(options.changedPathsFrom, LIMITS.changedPathsBytes, "Changed paths input"));
    changedPaths = normalizeChangedPaths([...fromFile, ...options.changedPaths]);
  } catch (error) {
    changedPathsResolved = false;
    failures.push(error instanceof InputFailure ? error.safeMessage : "Changed paths input could not be processed.");
  }

  for (let index = 0; index < options.handoffs.length; index += 1) {
    const file = `handoff[${index}]`;
    try {
      const value = parseJson(
        await readBoundedFile(options.handoffs[index], LIMITS.handoffBytes, "Handoff input"),
        "Handoff input",
      );
      const validation = core.validateHandoffSchema(value);
      if (!validation.ok) {
        output.push(...associate(file, validation.diagnostics));
        continue;
      }
      output.push(...associate(file, diagnostics.lint(validation.value).diagnostics));
      if (manifest !== undefined && changedPathsResolved) {
        output.push(...associate(file, manifestValidator.validateManifest(
          validation.value as Handoff,
          manifest,
          changedPaths,
          options.changedPathsProvided,
        )));
      }
    } catch (error) {
      failures.push(error instanceof InputFailure ? error.safeMessage : "Handoff input could not be processed.");
    }
  }

  if (!options.quiet) process.stdout.write(render(output, options.format));
  for (const failure of failures) process.stderr.write(`${failure}\n`);

  if (failures.length > 0) return 2;
  const hasFailure = output.some(({ severity }) => severity === "error" ||
    (options.strict && severity === "warning"));
  return hasFailure ? 1 : 0;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await run(process.argv.slice(2));
}
