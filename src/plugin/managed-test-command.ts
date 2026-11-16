import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ManagedTestCommand =
  | { readonly scope: "full" | "focused"; readonly runner: "node" | "pytest" | "go" | "cargo" | "jest" | "vitest";
      readonly identity?: string }
  | { readonly scope: "unknown"; readonly reason: string };

const unknown = (reason: string): ManagedTestCommand => ({ scope: "unknown", reason });

// Deliberately do not interpret shell expansion, redirection, quoting or arbitrary scripts.
// A partial parse must never be presented as control over the whole invocation.
function words(command: string): string[] | undefined {
  const trimmed = command.trim();
  return trimmed && /^[\w@%+=:,./-]+(?:\s+[\w@%+=:,./-]+)*$/u.test(trimmed) ? trimmed.split(/\s+/u) : undefined;
}

function runnerCommand(parts: readonly string[]): ManagedTestCommand {
  const [program, ...args] = parts;
  if (program === "node") {
    if (args[0] !== "--test") return unknown("node-entrypoint-not-recognized");
    if (args.length === 1) return { scope: "full", runner: "node" };
    if (args.slice(1).every(value => /^[\w@./-]+\.test\.(?:[cm]?js|ts)$/u.test(value))) return { scope: "focused", runner: "node" };
    return unknown("node-test-options-not-resolved");
  }
  if (program === "pytest" || (program === "python" || program === "python3") && args[0] === "-m" && args[1] === "pytest") {
    const options = program === "pytest" ? args : args.slice(2);
    if (options.every(value => ["-q", "-v", "-x", "--quiet", "--verbose"].includes(value))) return { scope: "full", runner: "pytest" };
    if (options.some(value => /^[\w@./-]+\.py(?:::[\w:]+)?$/u.test(value)) &&
        options.every(value => ["-q", "-v", "-x", "--quiet", "--verbose"].includes(value) ||
          /^[\w@./-]+\.py(?:::[\w:]+)?$/u.test(value))) return { scope: "focused", runner: "pytest" };
    return unknown("pytest-selection-not-resolved");
  }
  if (program === "go" && args[0] === "test") {
    if (args.length === 2 && args[1] === "./...") return { scope: "full", runner: "go" };
    if (args.length === 2 && /^\.\/[\w./-]+$/u.test(args[1]!) && !args[1]!.endsWith("/...")) return { scope: "focused", runner: "go" };
    return unknown("go-selection-not-resolved");
  }
  if (program === "cargo" && args[0] === "test") {
    if (args.length === 1 || args.length === 2 && args[1] === "--workspace") return { scope: "full", runner: "cargo" };
    return unknown("cargo-selection-not-resolved");
  }
  if (program === "jest" || program === "vitest") {
    const options = program === "vitest" && args[0] === "run" ? args.slice(1) : args;
    if (options.length === 0 || options.length === 1 && options[0] === "--run") return { scope: "full", runner: program };
    if (options.length === 1 && /^[\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(options[0]!)) return { scope: "focused", runner: program };
    return unknown("javascript-test-selection-not-resolved");
  }
  return unknown("runner-not-recognized");
}

/** Resolve only literal project package scripts, not a shell or general-purpose program interpreter. */
export async function managedTestCommand(command: string, directory: string): Promise<ManagedTestCommand> {
  const initial = words(command);
  if (!initial) return unknown("shell-syntax-not-resolved");
  const readScripts = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const path = join(directory, "package.json"), metadata = await lstat(path);
      if (!metadata.isFile() || metadata.size > 1024 * 1024) return undefined;
      const pkg: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return undefined;
      const scripts = (pkg as { scripts?: unknown }).scripts;
      return scripts && typeof scripts === "object" && !Array.isArray(scripts) ? scripts as Record<string, unknown> : undefined;
    } catch { return undefined; }
  };
  let scripts: Record<string, unknown> | undefined, loaded = false;
  const definitions: { name: string; source: string }[] = [];
  const visit = async (parts: readonly string[], seen: Set<string>): Promise<ManagedTestCommand> => {
    const [program, ...args] = parts;
    let script: string | undefined;
    if (program === "npm" && args.length === 1 && args[0] === "test") script = "test";
    else if ((program === "npm" || program === "pnpm" || program === "yarn") && args.length === 2 && args[0] === "run") script = args[1];
    else if ((program === "pnpm" || program === "yarn") && args.length === 1 && args[0] === "test") script = "test";
    if (script === undefined) return runnerCommand(parts);
    if (/(?:release|preflight|windows|linux|environment|compat)/iu.test(script)) return unknown("environment-or-release-script");
    if (seen.has(script) || seen.size >= 12) return unknown("script-cycle-or-depth");
    if (!loaded) { scripts = await readScripts(); loaded = true; }
    if (!scripts || typeof scripts[script] !== "string") return unknown("script-definition-unavailable");
    // npm and other package managers can run extra lifecycle scripts. Do not suppress them.
    if (scripts[`pre${script}`] !== undefined || scripts[`post${script}`] !== undefined) return unknown("script-lifecycle-not-resolved");
    definitions.push({ name: script, source: scripts[script] as string });
    const nested = words(scripts[script] as string);
    if (!nested) return unknown("script-shell-syntax-not-resolved");
    return visit(nested, new Set([...seen, script]));
  };
  const result = await visit(initial, new Set());
  return result.scope === "unknown" ? result : { ...result,
    identity: createHash("sha256").update(JSON.stringify({ command, definitions })).digest("hex") };
}
