import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { goalFingerprint, type GoalEvidence } from "../core/goal-bound.js";
import { normalizeManifestScope } from "../core/path.js";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";
import type { OperationManifest } from "../core/types.js";
import { declaredArtifacts } from "./declared-artifacts.js";
import { validationScratchPaths } from "./validation-scratch.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

type Binding = NonNullable<GoalEvidence["protected_binding"]>;
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
const validationContractHash = (manifest: OperationManifest) => goalFingerprint({ task_id: manifest.task_id,
  read: manifest.read, validation: manifest.validation });

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
    if (validationContractHash(manifest) !== binding.freshness.contract_hash ||
        goalFingerprint(boundEnvironment) !== goalFingerprint(binding.freshness.environment)) return undefined;
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
  const visit = async (absolute: string, ancestors: ReadonlySet<string> = new Set(), projectArtifacts = false): Promise<boolean> => {
    if (excluded.some(root => !outside(root, absolute))) return true;
    if (scratchExcluded(absolute)) return true;
    const scoped = relative(projectRoot, absolute).replaceAll("\\", "/");
    if (scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) return false;
    if ((sourcePolicy === "project-files-v1" || projectArtifacts) && isRuntimeControlPath(scoped)) return true;
    const metadata = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata === undefined) { entries.push([scoped, "missing"]); return true; }
    if (metadata.isSymbolicLink()) {
      const target = await realpath(absolute).catch(() => undefined);
      if (target === undefined) return false;
      const relativeTarget = relative(canonicalRoot, target);
      if (relativeTarget === ".." || relativeTarget.startsWith("../") || isAbsolute(relativeTarget) ||
        ancestors.has(target)) return false;
      const targetMetadata = await stat(target);
      const link = await readlink(absolute);
      if (targetMetadata.isDirectory()) {
        // Keep the logical scope path and link target in the digest; do not follow external links or cycles.
        entries.push([scoped, `symlink:${link}`]);
        const next = new Set([...ancestors, target]);
        for (const child of (await readdir(absolute)).sort()) if (!await visit(join(absolute, child), next, projectArtifacts)) return false;
        return true;
      }
      if (!targetMetadata.isFile()) return false;
      entries.push([scoped, `symlink:${link}`, createHash("sha256").update(await readFile(target)).digest("hex")]);
      return true;
    }
    if (metadata.isDirectory()) {
      const real = await realpath(absolute);
      if (ancestors.has(real)) return false;
      entries.push([scoped, "directory"]);
      const next = new Set([...ancestors, real]);
      for (const child of (await readdir(absolute)).sort()) if (!await visit(join(absolute, child), next, projectArtifacts)) return false;
      return true;
    }
    if (!metadata.isFile()) return false;
    entries.push([scoped, "file", createHash("sha256").update(await readFile(absolute)).digest("hex")]);
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
  const scopes = binding.source_paths.map(path => resolve(projectRoot, path));
  const protection = [...new Set([...(binding.freshness?.protected_paths ?? []),
    ...await currentSnapshotProtection(projectRoot, current.manifest)])];
  const paths = [...new Set([...current.manifest.read.map(entry => resolve(projectRoot, normalizeManifestScope(entry).path)),
    ...protection.filter(path => scopes.some(scope => !outside(scope, path)))])];
  return binding.source_policy === "declared-paths-v1"
    ? declaredScopeDigest(projectRoot, paths, current.hash, true, [], binding)
    : protectedScopeDigest(projectRoot, paths, current.hash, binding.source_policy, [], binding);
}

export async function protectedSnapshot(authorization: { manifestPath: string; manifestHash: string; projectRoot: string },
  options: { captureFreshness?: boolean } = {}): Promise<{
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
    const binding: Binding = { manifest_hash: `sha256:${manifestHash}`, project_root: authorization.projectRoot,
      manifest_path: relativePath, source_policy: external ? "declared-paths-v1" : "project-files-v1",
      candidate_policy: "project-root-artifacts-v1",
      source_paths: sourcePaths.map(evidencePath),
      candidate_paths: candidatePaths.map(evidencePath),
      freshness: { contract_hash: validationContractHash(manifest), scratch_paths: validationScratchPaths(authorization.projectRoot, manifest.validation, process.env),
        protected_paths: [...new Set([...actualPaths(manifest.read).filter(path => path !== resolve(authorization.projectRoot)),
          ...tracked.map(path => resolve(authorization.projectRoot, path)),
          ...actualPaths(manifest.write.filter(path => !path.endsWith("/**")))] )], environment: environment(manifest) } };
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

export async function refreshProtectedSnapshot(projectRoot: string, binding: Binding): Promise<{
  readonly source: string; readonly candidate: string;
} | undefined> {
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
