import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { goalFingerprint, type GoalEvidence } from "../core/goal-bound.js";
import { normalizeManifestScope } from "../core/path.js";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";
import type { OperationManifest } from "../core/types.js";
import { declaredArtifacts } from "./declared-artifacts.js";
import { validationScratchPaths } from "./validation-scratch.js";
import { captureDockerWorkspaceSnapshot } from "./docker-validation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ValidationToolchain {
  readonly directory: string;
  readonly commands: readonly string[];
  readonly executables: readonly { readonly name: string; readonly path: string | null; readonly realpath: string | null;
    readonly sha256: string | null; readonly mode?: number; readonly runtime?: string }[];
}
type SavedBinding = NonNullable<GoalEvidence["protected_binding"]>;
// Optional additions to the existing capture recipe. Missing fields retain legacy comparisons.
type Binding = Omit<SavedBinding, "freshness"> & { readonly freshness?: NonNullable<SavedBinding["freshness"]> & {
  readonly incidental_control_paths?: readonly string[];
  readonly toolchain?: ValidationToolchain;
} };
const controlRoots = new Set([".git", ...Object.values(RUNTIME_PROFILES).map(profile => profile.stateDirectory)]);
const exec = promisify(execFile);
const environmentKeys = ["PATH", "GOOS", "GOARCH", "CGO_ENABLED", "GOFLAGS", "GOPROXY", "GOSUMDB", "NODE_OPTIONS", "NODE_ENV",
  "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "TMPDIR", "GOCACHE", "GOMODCACHE", "GOPATH"];
const environment = (manifest: OperationManifest) => ({
  ...Object.fromEntries([...new Set([...environmentKeys, ...manifest.validation.flatMap(command =>
    [...command.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu)].map(match => match[1] ?? match[2]!))])]
    .map(key => [key, process.env[key] ?? null])),
  "@platform": process.platform, "@arch": process.arch, "@runtime": process.version, "@executable": process.execPath,
});
const validationContractHash = (manifest: OperationManifest) => goalFingerprint({ read: manifest.read, validation: manifest.validation });
const legacyValidationContractHash = (manifest: OperationManifest) => goalFingerprint({ task_id: manifest.task_id,
  read: manifest.read, validation: manifest.validation });
const executableBytes = new Map<string, { signature: string; value: Promise<{ sha256: string; prefix: string }> }>();
async function executableContent(path: string): Promise<{ sha256: string; prefix: string }> {
  const metadata = await stat(path, { bigint: true });
  const signature = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.mode].join(":");
  const saved = executableBytes.get(path);
  if (saved?.signature === signature) return saved.value;
  // Observe current file identity on every comparison, but do not reread an unchanged
  // large interpreter for each source/candidate/progress projection in the same host.
  const value = (async () => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    const handle = await open(path, "r"), prefix = Buffer.alloc(512);
    try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
    return { sha256: `sha256:${hash.digest("hex")}`, prefix: prefix.toString("utf8") };
  })();
  executableBytes.set(path, { signature, value });
  if (executableBytes.size > 128) executableBytes.delete(executableBytes.keys().next().value!);
  try { return await value; } catch (error) {
    if (executableBytes.get(path)?.value === value) executableBytes.delete(path);
    throw error;
  }
}

/** Tokenize literal command heads without invoking a shell or evaluating command substitutions. */
function executableSegments(command: string): string[][] {
  const result: string[][] = [], words: string[] = [];
  let word = "", quote = "", started = false;
  const flush = () => { if (started) words.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        if (command[i + 1] === quote) { word += ch; i++; } else quote = "";
      } else if (quote === '"' && (ch === "`" || ch === "\\" && /["\\$]/u.test(command[i + 1] ?? ""))) {
        const escaped = command[++i] ?? ""; word += escaped === "$" ? "\0" : escaped;
      } else word += quote === "'" && ch === "$" ? "\0" : ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; }
    else if (/\s/u.test(ch) && ch !== "\n" && ch !== "\r") flush();
    else if (/[;&|\n\r]/u.test(ch)) {
      flush();
      if (words.length) result.push(words.splice(0));
    } else { word += ch; started = true; }
  }
  flush(); if (words.length) result.push(words);
  return result;
}

/** Pin the literal selected executable, its symlink target and bytes; never execute a version probe. */
async function validationToolchain(directory: string, commands: readonly string[]): Promise<ValidationToolchain> {
  const executables: ValidationToolchain["executables"][number][] = [], seen = new Set<string>();
  const host = await realpath(process.execPath).catch(() => process.execPath);
  const inherited = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]));
  const expand = (value: string, cwd: string, env: NodeJS.ProcessEnv) => value.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/giu,
    (raw, ps, braces, plain) => (ps ?? braces ?? plain) === "PWD" ? cwd
      : env[process.platform === "win32" ? (ps ?? braces ?? plain).toUpperCase() : ps ?? braces ?? plain] ?? raw).replaceAll("\0", "$");
  const add = async (name: string, cwd: string, env: NodeJS.ProcessEnv, depth = 0): Promise<void> => {
    name = expand(name, cwd, env);
    const key = JSON.stringify([cwd, name, env.PATH, env.PATHEXT]);
    if (seen.has(key) || depth > 4) return;
    seen.add(key);
    const suffixes = process.platform === "win32" && !extname(name)
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
    const roots = isAbsolute(name) || /[\\/]/u.test(name) ? [cwd]
      : (env.PATH ?? "").split(delimiter).map(path => path.replace(/^"|"$/gu, "") || cwd);
    let path: string | undefined;
    for (const root of roots) {
      for (const suffix of suffixes) {
        const candidate = resolve(cwd, root, name + suffix), info = await stat(candidate).catch(() => undefined);
        if (info?.isFile() && (process.platform === "win32" || (info.mode & 0o111) !== 0)) { path = candidate; break; }
      }
      if (path) break;
    }
    if (!path) { executables.push({ name, path: null, realpath: null, sha256: null }); return; }
    const target = await realpath(path), info = await stat(target), content = await executableContent(target);
    executables.push({ name, path, realpath: target, sha256: content.sha256, mode: info.mode,
      ...(target === host ? { runtime: process.version } : {}) });
    const shebang = /^#!([^\r\n\0]+)/u.exec(content.prefix);
    if (shebang) await scan(shebang[1]!, cwd, env, depth + 1);
  };
  const builtins = new Set(["cd", "pushd", "popd", "set-location", "echo", "printf", "test", "[", "true", "false", ":", "exit", "export", "set", "unset"]);
  const scan = async (command: string, initial: string, inherited: NodeJS.ProcessEnv, depth = 0): Promise<void> => {
    if (depth > 4) return;
    const env = { ...inherited };
    let cwd = initial;
    for (const segment of executableSegments(command)) {
      const words = [...segment], local = { ...env };
      if (words[0] === "export") words.shift();
      while (/^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*=/iu.test(words[0] ?? "")) {
        const assignment = words.shift()!, at = assignment.indexOf("="), key = assignment.slice(0, at).replace(/^\$env:/iu, "");
        local[process.platform === "win32" ? key.toUpperCase() : key] = expand(assignment.slice(at + 1), cwd, local);
      }
      const head = words.shift(); if (!head) { Object.assign(env, local); continue; }
      const name = basename(head.replaceAll("\\", "/")).replace(/\.(exe|cmd|bat)$/iu, "").toLowerCase();
      if (["cd", "pushd", "set-location"].includes(name)) { if (words[0]) cwd = resolve(cwd, expand(words[0], cwd, local)); continue; }
      if (builtins.has(name)) continue;
      await add(head, cwd, local, depth);
      if (["env", "command", "exec", "sudo", "ccache", "sccache", "distcc"].includes(name)) {
        while (words[0]?.startsWith("-")) words.shift();
        if (words.length) await scan(words.map(word => JSON.stringify(word)).join(" "), cwd, local, depth + 1);
      }
      if (["bash", "sh", "zsh", "pwsh", "powershell"].includes(name)) {
        const at = words.findIndex(word => /^-(?:[a-z]*c|command)$/iu.test(word));
        if (at >= 0 && words[at + 1]) await scan(words[at + 1]!.replaceAll("\0", "$"), cwd, local, depth + 1);
      }
      if (["cmake", "ctest", "make", "ninja"].includes(name)) {
        for (const key of ["CC", "CXX"]) if (local[key]) await scan(local[key]!, cwd, local, depth + 1);
        const at = words.findIndex(word => ["--build", "--test-dir"].includes(word));
        const build = at >= 0 ? words[at + 1] : undefined;
        // Configuration creates this cache; only build/test execution consumes its selected tools.
        const cache = name === "cmake" && at < 0 ? "" : await readFile(resolve(cwd, build ?? ".", "CMakeCache.txt"), "utf8").catch(() => "");
        for (const match of cache.matchAll(/^CMAKE_(?:C|CXX|Fortran|CUDA)_COMPILER:FILEPATH=(.+)$|^CMAKE_MAKE_PROGRAM:FILEPATH=(.+)$/gmu)) {
          await add(match[1] ?? match[2]!, cwd, local, depth + 1);
        }
      }
    }
  };
  for (const command of commands) await scan(command, directory, inherited);
  return { directory, commands: [...commands], executables };
}

/** New captures can omit incidental config. Explicit inputs, outputs and tracked files still pin it. */
export function snapshotControlExclusion(projectRoot: string, binding: Binding, protection: readonly string[] = []): (absolute: string) => boolean {
  const roots = (binding.freshness?.incidental_control_paths ?? []).filter(path => path === ".opencode").map(path => resolve(projectRoot, path));
  const protectedPaths = [...(binding.freshness?.protected_paths ?? []), ...protection].filter(path => resolve(path) !== resolve(projectRoot));
  return absolute => roots.some(root => !outside(root, absolute)) &&
    !protectedPaths.some(path => !outside(path, absolute) || !outside(absolute, path));
}

export function snapshotScratchExcluded(binding: Binding, absolute: string, currentProtection: readonly string[] = []): boolean {
  return snapshotScratchExclusion(binding, currentProtection)(absolute);
}

/** Prepare the same lexical containment rules once per snapshot/Review, not once per
 * cache-file × protected-file pair. This is call-local; edits and new deliverables are
 * still rediscovered by currentSnapshotProtection on the next freshness check. */
export function snapshotScratchExclusion(binding: Binding, currentProtection: readonly string[] = []): (absolute: string) => boolean {
  const fixed = binding.freshness;
  if (!fixed) return () => false;
  const rawProtection = [...fixed.protected_paths, ...currentProtection];
  const previous = (absolute: string) => fixed.scratch_paths.some(root => !outside(root, absolute)) &&
    !rawProtection.some(path => !outside(path, absolute) || !outside(absolute, path));
  // POSIX permits literal backslashes in a filename. The previous relative-path rule
  // must decide those uncommon names; they are not Windows directory separators.
  if (process.platform !== "win32" && [...fixed.scratch_paths, ...rawProtection].some(path => path.includes("\\"))) return previous;
  const canonical = (path: string) => {
    const normalized = resolve(path).replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const prepared = (path: string) => ({ exact: path, prefix: path.endsWith("/") ? path : `${path}/` });
  const scratch = fixed.scratch_paths.map(path => prepared(canonical(path)));
  const protection = [...new Set(rawProtection.map(canonical))].map(prepared);
  return absolute => {
    if (process.platform !== "win32" && absolute.includes("\\")) return previous(absolute);
    const target = prepared(canonical(absolute));
    return scratch.some(root => target.exact === root.exact || target.exact.startsWith(root.prefix)) &&
      !protection.some(path => target.exact === path.exact || target.exact.startsWith(path.prefix) || path.exact.startsWith(target.prefix));
  };
}

/** Tighten old scratch exclusions for current real inputs/outputs; never rewrite the saved recipe. */
export async function currentSnapshotProtection(projectRoot: string, manifest: Pick<OperationManifest, "read" | "write">): Promise<string[]> {
  const actual = (entry: string) => resolve(projectRoot, normalizeManifestScope(entry).path);
  const tracked = await exec("git", ["ls-files", "-z"], { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 })
    .then(value => value.stdout.split("\0").filter(Boolean).map(path => resolve(projectRoot, path))).catch(() => []);
  const outputs = manifest.write.filter(path => !path.endsWith("/**")).map(actual);
  // An absent execution grant is not a newly delivered artifact. Initial missing paths remain
  // protected by the immutable binding, while new outputs become protected when materialized.
  const materialized = await Promise.all(outputs.map(async path => await lstat(path).catch(() => undefined) ? path : undefined));
  // A whole-project read includes real source, not every configured compiler-cache output.
  // Specific cache inputs, tracked files and exact deliverables still tighten the recipe.
  return [...new Set([...manifest.read.map(actual).filter(path => path !== resolve(projectRoot)),
    ...tracked, ...materialized.filter((path): path is string => path !== undefined)])];
}

async function snapshotManifest(projectRoot: string, binding: Binding): Promise<{ manifest: OperationManifest; hash: string } | undefined> {
  const source = await readFile(resolve(projectRoot, binding.manifest_path)).catch(() => undefined);
  if (!source) return undefined;
  const hash = createHash("sha256").update(source).digest("hex");
  const manifest = JSON.parse(source.toString("utf8")) as OperationManifest;
  if (binding.freshness) {
    const currentEnvironment: Record<string, unknown> = environment(manifest);
    // Compare the saved environment recipe only. Old proof cannot gain new cache exclusions
    // or lose validity merely because new captures bind additional environment variables.
    const boundEnvironment = Object.fromEntries(Object.keys(binding.freshness.environment).map(key => [key, currentEnvironment[key]]));
    if (![validationContractHash(manifest), legacyValidationContractHash(manifest)].includes(binding.freshness.contract_hash) ||
        goalFingerprint(boundEnvironment) !== goalFingerprint(binding.freshness.environment)) return undefined;
    const toolchain = binding.freshness.toolchain;
    if (toolchain) {
      const observed = await validationToolchain(toolchain.directory, toolchain.commands);
      const executables = observed.executables.map((entry, index) => {
        const { runtime, ...identity } = entry, savedRuntime = toolchain.executables[index]?.runtime;
        // Moving the transport away from an unchanged interpreter does not change
        // that interpreter's bytes. Compare host runtime only while it still is that tool.
        return savedRuntime === undefined ? identity : { ...identity, runtime: runtime ?? savedRuntime };
      });
      if (goalFingerprint({ ...observed, executables }) !== goalFingerprint(toolchain)) return undefined;
    }
    return { manifest, hash: binding.freshness.contract_hash.slice("sha256:".length) };
  }
  return `sha256:${hash}` === binding.manifest_hash ? { manifest, hash } : undefined;
}

/** Live orchestration/Git bookkeeping is readable context, not the source being validated. */
export function isRuntimeControlPath(path: string): boolean {
  const first = path.replaceAll("\\", "/").split("/")[0]!;
  return controlRoots.has(process.platform === "win32" ? first.toLowerCase() : first);
}

async function protectedScopeDigest(projectRoot: string, paths: readonly string[], manifestHash: string,
  sourcePolicy?: Binding["source_policy"], excluded: readonly string[] = [], binding?: Binding,
  candidatePolicy?: Binding["candidate_policy"]): Promise<string | undefined> {
  const entries: Array<readonly [string, string, string?]> = [];
  const canonicalRoot = await realpath(projectRoot);
  const scratchExcluded = binding ? snapshotScratchExclusion(binding) : () => false;
  const controlExcluded = binding ? snapshotControlExclusion(projectRoot, binding) : () => false;
  const visit = async (absolute: string, ancestors: ReadonlySet<string> = new Set(), projectArtifacts = false,
    physical = absolute): Promise<boolean> => {
    if (excluded.some(root => !outside(root, absolute))) return true;
    if (scratchExcluded(absolute)) return true;
    if (controlExcluded(absolute)) return true;
    const scoped = relative(projectRoot, absolute).replaceAll("\\", "/");
    if (scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) return false;
    if ((sourcePolicy === "project-files-v1" || projectArtifacts) && isRuntimeControlPath(scoped)) return true;
    const metadata = await lstat(physical).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata === undefined) { entries.push([scoped, "missing"]); return true; }
    if (metadata.isSymbolicLink()) {
      const target = await realpath(physical).catch(() => undefined);
      if (target === undefined) return false;
      const relativeTarget = relative(canonicalRoot, target);
      if (relativeTarget === ".." || relativeTarget.startsWith("../") || isAbsolute(relativeTarget)) return false;
      const targetMetadata = await stat(target);
      const link = await readlink(physical);
      if (targetMetadata.isDirectory()) {
        // Keep the logical scope path and link target in the digest; do not follow external links or cycles.
        entries.push([scoped, `symlink:${link}`]);
        // Repository fixtures can deliberately link back to an ancestor (e.g. ".").
        // Its files are already traversed by this branch; pin the link itself and
        // stop recursive re-entry, rather than losing all native validation proof.
        if (ancestors.has(target)) return true;
        const next = new Set([...ancestors, target]);
        // Windows compatibility junctions can deny enumeration through the alias while
        // their resolved directory remains readable. Traverse the already resolved target.
        // Retain logical entry labels so unchanged existing evidence keeps its identity.
        for (const child of (await readdir(target)).sort()) if (!await visit(join(absolute, child), next, projectArtifacts, join(target, child))) return false;
        return true;
      }
      if (!targetMetadata.isFile()) return false;
      entries.push([scoped, `symlink:${link}`, createHash("sha256").update(await readFile(target)).digest("hex")]);
      return true;
    }
    if (metadata.isDirectory()) {
      const real = await realpath(physical);
      entries.push([scoped, "directory"]);
      // An ancestor link can lead back into this directory through ordinary
      // children. The original traversal already pins its real contents.
      if (ancestors.has(real)) return true;
      const next = new Set([...ancestors, real]);
      for (const child of (await readdir(physical)).sort()) if (!await visit(join(absolute, child), next, projectArtifacts, join(physical, child))) return false;
      return true;
    }
    if (!metadata.isFile()) return false;
    entries.push([scoped, "file", createHash("sha256").update(await readFile(physical)).digest("hex")]);
    return true;
  };
  for (const path of [...new Set(paths)].sort()) {
    // Only a whole-project grant excludes incidental host bookkeeping. A separately
    // declared control-like output still traverses and pins its exact bytes.
    const projectArtifacts = candidatePolicy === "project-root-artifacts-v1" && resolve(path) === resolve(projectRoot);
    if (!await visit(path, new Set(), projectArtifacts)) return undefined;
  }
  return goalFingerprint({ manifest_hash: `sha256:${manifestHash}`, entries });
}

function outside(projectRoot: string, path: string): boolean {
  const scoped = relative(projectRoot, path).replaceAll("\\", "/");
  return scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped);
}

async function declaredScopeDigest(projectRoot: string, paths: readonly string[], manifestHash: string,
  source: boolean, excluded: readonly string[] = [], binding?: Binding,
  candidatePolicy?: Binding["candidate_policy"],
  artifactsMemo?: Map<string, ReturnType<typeof declaredArtifacts>>): Promise<string | undefined> {
  const local = paths.filter(path => !outside(projectRoot, path));
  const external = paths.filter(path => outside(projectRoot, path));
  const project = await protectedScopeDigest(projectRoot, local, manifestHash, source ? "project-files-v1" : undefined, excluded, binding, candidatePolicy);
  if (project === undefined) return undefined;
  const key = JSON.stringify(external);
  let pending = artifactsMemo?.get(key);
  if (!pending) {
    pending = declaredArtifacts(external);
    artifactsMemo?.set(key, pending);
  }
  const artifacts = await pending.catch(() => undefined);
  return artifacts && goalFingerprint({ project, external: artifacts.entries.filter(([path]) => !excluded.some(root => !outside(root, path))) });
}

/** An existing operation may create its declared outputs. Compare its other inputs during execution;
 * ordinary evidence still pins the full post-operation source and outputs for later acceptance. */
export async function operationInputSnapshot(projectRoot: string, binding: Binding): Promise<string | undefined> {
  const manifest = await snapshotManifest(projectRoot, binding);
  if (!manifest) return undefined;
  const paths = binding.source_paths.map(path => resolve(projectRoot, path));
  const outputs = manifest.manifest.write.map(path => resolve(projectRoot, normalizeManifestScope(path).path));
  const hash = manifest.hash;
  return binding.source_policy === "declared-paths-v1"
    ? await declaredScopeDigest(projectRoot, paths, hash, true, outputs, binding)
    : await protectedScopeDigest(projectRoot, paths, hash, binding.source_policy, outputs, binding);
}

/** A validation may populate write-only caches. Keep its declared read inputs stable
 * while binding the resulting candidate (including those outputs) after the command. */
export async function validationInputSnapshot(projectRoot: string, binding: Binding): Promise<string | undefined> {
  const current = await snapshotManifest(projectRoot, binding);
  if (!current) return undefined;
  const manifest = current.manifest;
  if (!manifest.read.length) return undefined; // Keep the original full-source check when no inputs were declared.
  const paths = manifest.read.map(entry => {
    const path = normalizeManifestScope(entry);
    return path.kind === "relative" ? resolve(projectRoot, path.path) : resolve(path.path);
  });
  const hash = current.hash;
  return binding.source_policy === "declared-paths-v1"
    ? declaredScopeDigest(projectRoot, paths, hash, true, [], binding)
    : protectedScopeDigest(projectRoot, paths, hash, binding.source_policy, [], binding);
}

/** Pin a non-generating check's inputs and concrete source outputs, not incidental
 * files created later under a directory execution grant (for example result reports).
 * Exact outputs and tracked source remain protected even when omitted from read. */
export async function validatedSourceSnapshot(projectRoot: string, binding: Binding): Promise<string | undefined> {
  const current = await snapshotManifest(projectRoot, binding);
  if (!current?.manifest.read.length) return undefined; // An absent input set retains the full-source recipe.
  const scopes = [...binding.source_paths.map(path => resolve(projectRoot, path)),
    ...current.manifest.write.map(path => resolve(projectRoot, normalizeManifestScope(path).path))];
  const protection = [...new Set([...(binding.freshness?.protected_paths ?? []),
    ...await currentSnapshotProtection(projectRoot, current.manifest)])];
  const reads = current.manifest.read.map(entry => resolve(projectRoot, normalizeManifestScope(entry).path));
  const currentBinding = binding.freshness ? { ...binding, freshness: { ...binding.freshness, protected_paths: protection } } : binding;
  // A populated directory grant without a concrete output/input inventory cannot safely
  // acquire the report-only recipe. Keep the original full-candidate freshness instead.
  for (const entry of binding.validation_policy === undefined ? current.manifest.write : []) {
    const output = resolve(projectRoot, normalizeManifestScope(entry).path);
    if (reads.some(input => !outside(input, output)) || snapshotScratchExcluded(currentBinding, output) ||
        protection.some(path => path !== output && !outside(output, path) && !reads.includes(path))) continue;
    const stat = await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat?.isDirectory() && (await readdir(output)).length) return undefined;
  }
  const paths = [...new Set([...reads,
    ...protection.filter(path => scopes.some(scope => !outside(scope, path)))])];
  return binding.source_policy === "declared-paths-v1"
    ? declaredScopeDigest(projectRoot, paths, current.hash, true, [], currentBinding)
    : protectedScopeDigest(projectRoot, paths, current.hash, binding.source_policy, [], currentBinding);
}

export async function protectedSnapshot(authorization: { manifestPath: string; manifestHash: string; projectRoot: string },
  options: { captureFreshness?: boolean; directory?: string; command?: string } = {}): Promise<{
  readonly binding: Binding; readonly source: string; readonly candidate: string;
} | undefined> {
  const manifestSource = await readFile(authorization.manifestPath).catch(() => undefined);
  if (manifestSource === undefined) return undefined;
  const manifestHash = createHash("sha256").update(manifestSource).digest("hex");
  if (manifestHash !== authorization.manifestHash) return undefined;
  const relativePath = relative(authorization.projectRoot, authorization.manifestPath).replaceAll("\\", "/");
  const manifest = JSON.parse(manifestSource.toString("utf8")) as OperationManifest;
  const actualPaths = (entries: readonly string[]) => entries.map((entry) => {
    const path = normalizeManifestScope(entry);
    return path.kind === "relative" ? resolve(authorization.projectRoot, path.path) : resolve(path.path);
  });
  const candidatePaths = actualPaths(manifest.write);
  const sourcePaths = [...new Set([...actualPaths(manifest.read), ...candidatePaths])];
  const external = sourcePaths.some(path => outside(authorization.projectRoot, path));
  // The project root has an empty relative path, which is not a valid evidence path.
  // Keep its absolute identity; resolving it still fingerprints the same directory.
  const evidencePath = (path: string): string => outside(authorization.projectRoot, path)
    ? path : relative(authorization.projectRoot, path).replaceAll("\\", "/") || path;
  if (options.captureFreshness !== false && Array.isArray(manifest.validation) && manifest.validation.length && manifest.task_id) {
    // New evidence pins validation inputs/outputs independently of the execution manifest hash.
    // Existing records keep their original recipe and cannot acquire exclusions retroactively.
    const tracked = await exec("git", ["ls-files", "-z"], { cwd: authorization.projectRoot, maxBuffer: 16 * 1024 * 1024 }).then(value => value.stdout.split("\0").filter(Boolean)).catch(() => []);
    const { "@runtime": _runtime, "@executable": _executable, ...capturedEnvironment } = environment(manifest);
    const binding: Binding = { manifest_hash: `sha256:${manifestHash}`, project_root: authorization.projectRoot,
      manifest_path: relativePath, source_policy: external ? "declared-paths-v1" : "project-files-v1",
      candidate_policy: "project-root-artifacts-v1",
      source_paths: sourcePaths.map(evidencePath),
      candidate_paths: candidatePaths.map(evidencePath),
      freshness: { contract_hash: validationContractHash(manifest), scratch_paths: validationScratchPaths(authorization.projectRoot, manifest.validation, process.env),
        incidental_control_paths: [".opencode"],
        toolchain: await validationToolchain(resolve(authorization.projectRoot, options.directory ?? "."), options.command ? [options.command] : manifest.validation),
        protected_paths: [...new Set([...actualPaths(manifest.read).filter(path => path !== resolve(authorization.projectRoot)),
          ...tracked.map(path => resolve(authorization.projectRoot, path)),
           ...actualPaths(manifest.write.filter(path => !path.endsWith("/**")))] )], environment: capturedEnvironment } };
    const current = await refreshProtectedSnapshot(authorization.projectRoot, binding);
    return current && { binding, ...current };
  }
  const source = external ? await declaredScopeDigest(authorization.projectRoot, sourcePaths, manifestHash, true)
    : await protectedScopeDigest(authorization.projectRoot, sourcePaths, manifestHash, "project-files-v1");
  // Explicit outputs and the exact operation manifest remain pinned, including control-like paths.
  const candidate = external ? await declaredScopeDigest(authorization.projectRoot, candidatePaths, manifestHash, false)
    : await protectedScopeDigest(authorization.projectRoot, candidatePaths, manifestHash);
  if (source === undefined || candidate === undefined || relativePath.startsWith("../") || isAbsolute(relativePath)) return undefined;
  return { binding: { manifest_hash: `sha256:${manifestHash}`, project_root: authorization.projectRoot,
    manifest_path: relativePath, source_policy: external ? "declared-paths-v1" : "project-files-v1",
    source_paths: sourcePaths.map(path => evidencePath(path).replaceAll("\\", "/")),
    candidate_paths: candidatePaths.map(path => evidencePath(path).replaceAll("\\", "/")) }, source, candidate };
}

/** Capture a task workspace that exists only inside the fixed Docker task container. */
export async function protectedDockerSnapshot(authorization: { manifestPath: string; manifestHash: string; projectRoot: string },
  containerID: string, cwd: string): Promise<{ readonly binding: Binding; readonly source: string; readonly candidate: string } | undefined> {
  const manifestSource = await readFile(authorization.manifestPath).catch(() => undefined);
  if (manifestSource === undefined) return undefined;
  const manifestHash = createHash("sha256").update(manifestSource).digest("hex");
  if (manifestHash !== authorization.manifestHash) return undefined;
  const relativePath = relative(authorization.projectRoot, authorization.manifestPath).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || isAbsolute(relativePath)) return undefined;
  const workspace = await captureDockerWorkspaceSnapshot(containerID, cwd);
  if (!workspace) return undefined;
  return { binding: { manifest_hash: `sha256:${manifestHash}`, project_root: authorization.projectRoot,
    manifest_path: relativePath, source_policy: "declared-paths-v1", source_paths: [], candidate_paths: [],
    docker_workspace: workspace }, source: workspace.source, candidate: workspace.candidate };
}

export async function refreshProtectedSnapshot(projectRoot: string, binding: Binding): Promise<{
  readonly source: string; readonly candidate: string;
} | undefined> {
  if (binding.docker_workspace) {
    if (resolve(projectRoot) !== resolve(binding.project_root) || !await snapshotManifest(projectRoot, binding)) return undefined;
    const workspace = await captureDockerWorkspaceSnapshot(binding.docker_workspace.container_id, binding.docker_workspace.cwd);
    if (!workspace || workspace.container_id !== binding.docker_workspace.container_id ||
        workspace.cwd !== binding.docker_workspace.cwd || workspace.repository_root !== binding.docker_workspace.repository_root) return undefined;
    return { source: workspace.source, candidate: workspace.candidate };
  }
  const current = await snapshotManifest(projectRoot, binding);
  if (!current) return undefined;
  if (binding.validation_policy === "inputs-and-concrete-outputs-v1") {
    const source = await validatedSourceSnapshot(projectRoot, binding);
    return source === undefined ? undefined : { source, candidate: source };
  }
  const manifestHash = current.hash;
  const sourcePaths = binding.source_paths.map(path => resolve(projectRoot, path));
  const candidatePaths = binding.candidate_paths.map(path => resolve(projectRoot, path));
  if (binding.freshness) {
    const protection = await currentSnapshotProtection(projectRoot, current.manifest);
    binding = { ...binding, freshness: { ...binding.freshness,
      protected_paths: [...new Set([...binding.freshness.protected_paths, ...protection])] } };
    // A compatible scope-only revision does not change old proof. Newly materialized outputs
    // outside its protected recipe do change the candidate; absent execution grants do not.
    for (const entry of current.manifest.write) {
      const path = resolve(projectRoot, normalizeManifestScope(entry).path);
      if (snapshotScratchExcluded(binding, path) || candidatePaths.some(root => !outside(root, path)) || !await lstat(path).catch(() => undefined)) continue;
      sourcePaths.push(path); candidatePaths.push(path);
    }
  }
  if (binding.source_policy === "declared-paths-v1") {
    // Reuse identical external inventories only inside this read-only refresh.
    // A later status/completion call always observes filesystem changes anew.
    const artifactsMemo = new Map<string, ReturnType<typeof declaredArtifacts>>();
    const source = await declaredScopeDigest(projectRoot, sourcePaths, manifestHash, true, [], binding, undefined, artifactsMemo);
    const candidate = await declaredScopeDigest(projectRoot, candidatePaths, manifestHash, false, [], binding, binding.candidate_policy, artifactsMemo);
    return source === undefined || candidate === undefined ? undefined : { source, candidate };
  }
  // Legacy evidence retains its original recipe; a new policy cannot relabel stale proof as fresh.
  if (binding.source_policy !== undefined && binding.source_policy !== "project-files-v1") return undefined;
  const source = await protectedScopeDigest(projectRoot, sourcePaths, manifestHash, binding.source_policy, [], binding);
  const candidate = await protectedScopeDigest(projectRoot, candidatePaths, manifestHash, undefined, [], binding, binding.candidate_policy);
  return source === undefined || candidate === undefined ? undefined : { source, candidate };
}
