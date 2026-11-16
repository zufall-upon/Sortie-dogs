import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export type ManagedTestCommand =
  | { readonly scope: "full" | "focused"; readonly runner: "node" | "pytest" | "go" | "cargo" | "jest" | "vitest" | "node-project-router";
      readonly identity?: string; readonly suiteKey?: string; readonly selection?: readonly string[] }
  | { readonly scope: "unknown"; readonly reason: string };

const unknown = (reason: string): ManagedTestCommand => ({ scope: "unknown", reason });

// This adapter describes these exact sources, not a filename or a convention that other
// projects' arbitrary scripts can opt into by accident. Changes require re-evaluation.
const routerInputs: Readonly<Record<string, string>> = {
  "scripts/test-router.mjs": "4bb0cd8a83c217bf58a44b2133aa51e0624c214c988a86779c11935a925c477c",
  "test/helpers/full-test-runner.ts": "02e42bae651f1d5ba0469092f47f1fddbe678b39eb5c1f406ee5322867da1e80",
  "test/setup.ts": "2b55fd54aa309c031807c54a909ef145daa64fac78b05d7cc96cb2050c5f88a2",
  "tsconfig.json": "0bb195e46f7e646a499baf9e752f1c7bac2b241646161f4db6e217dd1191f2a5",
};
const routerBuild: Readonly<Record<string, string>> = {
  prebuild: `node --input-type=module --eval "import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true });"`,
  build: "tsc -p tsconfig.json",
  postbuild: `node --input-type=module --eval "import fs from 'node:fs'; const path = 'dist/cli/main.js'; const source = fs.readFileSync(path, 'utf8'); if (!source.startsWith('#!')) fs.writeFileSync(path, '#!/usr/bin/env node\\n' + source); if (process.platform !== 'win32') fs.chmodSync(path, 0o755);"`,
};
// Inspected TypeScript 5.9.3 CLI sources. Other compilers, wrappers and versions
// remain native executions, not an inference from the name "tsc".
const routerCompiler: Readonly<Record<string, string>> = {
  "package.json": "822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6",
  "bin/tsc": "8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0",
  "lib/tsc.js": "2cffde0b8c6760dfb0b5b0382bbb7e00ba6a8b2d981b9205b256a700a481d983",
  "lib/_tsc.js": "e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419",
};

// Do not follow symlinks in any component of a project input, including directories.
async function regularProjectFile(directory: string, name: string, limit = 2 * 1024 * 1024): Promise<Buffer | undefined> {
  try {
    let path = directory;
    for (const [index, part] of name.split("/").entries()) {
      if (!part || part === "." || part === "..") return undefined;
      path = join(path, part);
      const metadata = await lstat(path);
      if (index === name.split("/").length - 1) {
        if (!metadata.isFile() || metadata.size > limit) return undefined;
      } else if (!metadata.isDirectory()) return undefined;
    }
    return await readFile(path);
  } catch { return undefined; }
}

async function selectedExecutable(name: string, directory: string, paths: readonly string[]): Promise<string | undefined> {
  for (const root of paths) {
    const path = resolve(directory, root || ".", name), metadata = await stat(path).catch(() => undefined);
    if (metadata?.isFile() && (metadata.mode & 0o111) !== 0) return realpath(path).catch(() => undefined);
  }
  return undefined;
}

async function routerToolchain(directory: string): Promise<string | undefined> {
  const prefix = resolve(process.execPath, "../.."), npmRoot = join(prefix, "lib/node_modules/npm");
  const npm = await realpath(join(npmRoot, "bin/npm-cli.js")).catch(() => undefined);
  const node = await realpath(process.execPath).catch(() => undefined);
  if (!npm || !node || Object.keys(process.env).some(key => /^path$/iu.test(key) && key !== "PATH")) return undefined;
  const configEnvironment = new Map<string, string>();
  const supportedConfig = new Set(["userconfig", "globalconfig", "prefix", "global_prefix", "local_prefix", "user_agent", "npm_version",
    "cache", "noproxy", "node_gyp", "init_module", "loglevel"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_config_/iu.test(key) || value === undefined) continue;
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (!supportedConfig.has(normalized.slice("npm_config_".length)) || configEnvironment.has(normalized)) return undefined;
    configEnvironment.set(normalized, value);
  }
  for (const key of ["npm_config_prefix", "npm_config_global_prefix"])
    if (configEnvironment.has(key) && configEnvironment.get(key) !== prefix) return undefined;
  const inherited = (process.env.PATH ?? "").split(delimiter), lifecycle: string[] = [];
  for (let path = resolve(directory);;) {
    lifecycle.push(join(path, "node_modules/.bin"));
    if (dirname(path) === path) break;
    path = dirname(path);
  }
  lifecycle.push(join(npmRoot, "node_modules/@npmcli/run-script/lib/node-gyp-bin"), ...inherited);
  if (await selectedExecutable("npm", directory, inherited) !== npm ||
      await selectedExecutable("npm", directory, lifecycle) !== npm ||
      await selectedExecutable("node", directory, lifecycle) !== node) return undefined;
  // Metadata only: never read or expose credentials from npm configuration.
  // Uninspected config is not a reason to prevent its native side effects.
  const configs = [join(directory, ".npmrc"), join(npmRoot, "npmrc"),
    configEnvironment.get("npm_config_userconfig") ?? join(homedir(), ".npmrc"),
    configEnvironment.get("npm_config_globalconfig") ?? join(prefix, "etc/npmrc")];
  for (const path of configs) {
    if (!isAbsolute(path)) return undefined;
    try { await lstat(path); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
  }
  const compiler = join(directory, "node_modules/typescript/bin/tsc");
  if (!(await lstat(join(directory, "node_modules/.bin")).catch(() => undefined))?.isDirectory() ||
      await selectedExecutable("tsc", directory, lifecycle) !== compiler) return undefined;
  for (const [path, hash] of Object.entries(routerCompiler)) {
    const source = await regularProjectFile(directory, `node_modules/typescript/${path}`, 8 * 1024 * 1024);
    if (!source || createHash("sha256").update(source).digest("hex") !== hash) return undefined;
  }
  return createHash("sha256").update(JSON.stringify({ npm, node, compiler, routerCompiler })).digest("hex");
}

async function projectRouter(parts: readonly string[], directory: string, scripts: Record<string, unknown> | undefined): Promise<ManagedTestCommand> {
  if (parts[0] !== "node" || parts[1] !== "scripts/test-router.mjs") return unknown("runner-not-recognized");
  if (process.platform === "win32") return unknown("router-platform-offload-not-resolved");
  if (Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV)$/iu.test(key) || /^BASH_FUNC_/u.test(key)) ||
      /^development$/iu.test(process.env.NODE_ENV ?? ""))
    return unknown("router-environment-not-resolved");
  const toolchain = await routerToolchain(directory);
  if (!toolchain) return unknown("router-npm-config-or-toolchain-not-resolved");
  if (!scripts || Object.entries(routerBuild).some(([name, source]) => scripts[name] !== source))
    return unknown("router-build-not-resolved");
  for (const [path, hash] of Object.entries(routerInputs)) {
    const source = await regularProjectFile(directory, path);
    if (!source || createHash("sha256").update(source).digest("hex") !== hash) return unknown("router-source-not-resolved");
  }
  const mode = parts[2], selection = parts.slice(3);
  const suiteKey = createHash("sha256").update(JSON.stringify({ directory, routerInputs, routerBuild, toolchain })).digest("hex");
  if (mode === "full" && selection.length === 0) return { scope: "full", runner: "node-project-router", suiteKey };
  // Full starts one file per process with concurrency=1. A multi-file targeted
  // invocation has a different parallel execution contract, not just more files.
  if (mode !== "targeted" || selection.length !== 1) return unknown("router-selection-not-resolved");
  for (const path of selection) {
    // The full helper discovers regular *.test.ts files under test/, excluding Windows.
    if (!/^test\/(?!windows\/)[\w@./-]+\.test\.ts$/u.test(path) || !await regularProjectFile(directory, path))
      return unknown("router-selection-not-covered");
  }
  return { scope: "focused", runner: "node-project-router", suiteKey, selection };
}

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
  let npmOnly = true;
  const visit = async (parts: readonly string[], seen: Set<string>): Promise<ManagedTestCommand> => {
    const [program, ...args] = parts;
    let script: string | undefined;
    let forwarded: readonly string[] = [];
    if (program === "npm" && args.length === 1 && args[0] === "test") script = "test";
    else if ((program === "npm" || program === "pnpm" || program === "yarn") && args.length === 2 && args[0] === "run") script = args[1];
    else if (program === "npm" && args.length > 3 && args[0] === "run" && args[2] === "--") {
      script = args[1]; forwarded = args.slice(3);
    }
    else if ((program === "pnpm" || program === "yarn") && args.length === 1 && args[0] === "test") script = "test";
    if (script === undefined) {
      if (definitions.length && npmOnly && parts[0] === "node" && parts[1] === "scripts/test-router.mjs")
        return projectRouter(parts, directory, scripts);
      return runnerCommand(parts);
    }
    if (/(?:release|preflight|windows|linux|environment|compat)/iu.test(script)) return unknown("environment-or-release-script");
    npmOnly &&= program === "npm";
    if (seen.has(script) || seen.size >= 12) return unknown("script-cycle-or-depth");
    if (!loaded) { scripts = await readScripts(); loaded = true; }
    if (!scripts || typeof scripts[script] !== "string") return unknown("script-definition-unavailable");
    // npm and other package managers can run extra lifecycle scripts. Do not suppress them.
    if (scripts[`pre${script}`] !== undefined || scripts[`post${script}`] !== undefined) return unknown("script-lifecycle-not-resolved");
    definitions.push({ name: script, source: scripts[script] as string });
    const nested = words(scripts[script] as string);
    if (!nested) return unknown("script-shell-syntax-not-resolved");
    return visit([...nested, ...forwarded], new Set([...seen, script]));
  };
  const result = await visit(initial, new Set());
  return result.scope === "unknown" ? result : { ...result,
    identity: createHash("sha256").update(JSON.stringify({ command, directory, definitions, suiteKey: result.suiteKey, selection: result.selection })).digest("hex") };
}
