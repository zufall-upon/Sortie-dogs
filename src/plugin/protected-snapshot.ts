import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { goalFingerprint, type GoalEvidence } from "../core/goal-bound.js";
import { normalizeManifestScope } from "../core/path.js";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";
import type { OperationManifest } from "../core/types.js";
import { declaredArtifacts } from "./declared-artifacts.js";

type Binding = NonNullable<GoalEvidence["protected_binding"]>;
const controlRoots = new Set([".git", ...Object.values(RUNTIME_PROFILES).map(profile => profile.stateDirectory)]);

/** Live orchestration/Git bookkeeping is readable context, not the source being validated. */
export function isRuntimeControlPath(path: string): boolean {
  const first = path.replaceAll("\\", "/").split("/")[0]!;
  return controlRoots.has(process.platform === "win32" ? first.toLowerCase() : first);
}

async function protectedScopeDigest(projectRoot: string, paths: readonly string[], manifestHash: string,
  sourcePolicy?: Binding["source_policy"], excluded: readonly string[] = []): Promise<string | undefined> {
  const entries: Array<readonly [string, string, string?]> = [];
  const canonicalRoot = await realpath(projectRoot);
  const visit = async (absolute: string): Promise<boolean> => {
    if (excluded.some(root => !outside(root, absolute))) return true;
    const scoped = relative(projectRoot, absolute).replaceAll("\\", "/");
    if (scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) return false;
    if (sourcePolicy === "project-files-v1" && isRuntimeControlPath(scoped)) return true;
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
        !(await stat(target)).isFile()) return false;
      const link = await readlink(absolute);
      entries.push([scoped, `symlink:${link}`, createHash("sha256").update(await readFile(target)).digest("hex")]);
      return true;
    }
    if (metadata.isDirectory()) {
      entries.push([scoped, "directory"]);
      for (const child of (await readdir(absolute)).sort()) if (!await visit(join(absolute, child))) return false;
      return true;
    }
    if (!metadata.isFile()) return false;
    entries.push([scoped, "file", createHash("sha256").update(await readFile(absolute)).digest("hex")]);
    return true;
  };
  for (const path of [...new Set(paths)].sort()) if (!await visit(path)) return undefined;
  return goalFingerprint({ manifest_hash: `sha256:${manifestHash}`, entries });
}

function outside(projectRoot: string, path: string): boolean {
  const scoped = relative(projectRoot, path).replaceAll("\\", "/");
  return scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped);
}

async function declaredScopeDigest(projectRoot: string, paths: readonly string[], manifestHash: string,
  source: boolean, excluded: readonly string[] = []): Promise<string | undefined> {
  const local = paths.filter(path => !outside(projectRoot, path));
  const external = paths.filter(path => outside(projectRoot, path));
  const project = await protectedScopeDigest(projectRoot, local, manifestHash, source ? "project-files-v1" : undefined, excluded);
  if (project === undefined) return undefined;
  const artifacts = await declaredArtifacts(external).catch(() => undefined);
  return artifacts && goalFingerprint({ project, external: artifacts.entries.filter(([path]) => !excluded.some(root => !outside(root, path))) });
}

/** An existing operation may create its declared outputs. Compare its other inputs during execution;
 * ordinary evidence still pins the full post-operation source and outputs for later acceptance. */
export async function operationInputSnapshot(projectRoot: string, binding: Binding): Promise<string | undefined> {
  const manifest = await readFile(resolve(projectRoot, binding.manifest_path)).catch(() => undefined);
  if (!manifest || `sha256:${createHash("sha256").update(manifest).digest("hex")}` !== binding.manifest_hash) return undefined;
  const paths = binding.source_paths.map(path => resolve(projectRoot, path));
  const outputs = binding.candidate_paths.map(path => resolve(projectRoot, path));
  const hash = binding.manifest_hash.slice("sha256:".length);
  return binding.source_policy === "declared-paths-v1"
    ? await declaredScopeDigest(projectRoot, paths, hash, true, outputs)
    : await protectedScopeDigest(projectRoot, paths, hash, binding.source_policy, outputs);
}

/** A validation may populate write-only caches. Keep its declared read inputs stable
 * while binding the resulting candidate (including those outputs) after the command. */
export async function validationInputSnapshot(projectRoot: string, binding: Binding): Promise<string | undefined> {
  const manifestSource = await readFile(resolve(projectRoot, binding.manifest_path)).catch(() => undefined);
  if (!manifestSource || `sha256:${createHash("sha256").update(manifestSource).digest("hex")}` !== binding.manifest_hash) return undefined;
  const manifest = JSON.parse(manifestSource.toString("utf8")) as OperationManifest;
  if (!manifest.read.length) return undefined; // Keep the original full-source check when no inputs were declared.
  const paths = manifest.read.map(entry => {
    const path = normalizeManifestScope(entry);
    return path.kind === "relative" ? resolve(projectRoot, path.path) : resolve(path.path);
  });
  const hash = binding.manifest_hash.slice("sha256:".length);
  return binding.source_policy === "declared-paths-v1"
    ? declaredScopeDigest(projectRoot, paths, hash, true)
    : protectedScopeDigest(projectRoot, paths, hash, binding.source_policy);
}

export async function protectedSnapshot(authorization: { manifestPath: string; manifestHash: string; projectRoot: string }): Promise<{
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
  const source = external ? await declaredScopeDigest(authorization.projectRoot, sourcePaths, manifestHash, true)
    : await protectedScopeDigest(authorization.projectRoot, sourcePaths, manifestHash, "project-files-v1");
  // Explicit outputs and the exact operation manifest remain pinned, including control-like paths.
  const candidate = external ? await declaredScopeDigest(authorization.projectRoot, candidatePaths, manifestHash, false)
    : await protectedScopeDigest(authorization.projectRoot, candidatePaths, manifestHash);
  if (source === undefined || candidate === undefined || relativePath.startsWith("../") || isAbsolute(relativePath)) return undefined;
  return { binding: { manifest_hash: `sha256:${manifestHash}`, project_root: authorization.projectRoot,
    manifest_path: relativePath, source_policy: external ? "declared-paths-v1" : "project-files-v1",
    source_paths: sourcePaths.map(path => (outside(authorization.projectRoot, path) ? path : relative(authorization.projectRoot, path)).replaceAll("\\", "/")),
    candidate_paths: candidatePaths.map(path => (outside(authorization.projectRoot, path) ? path : relative(authorization.projectRoot, path)).replaceAll("\\", "/")) }, source, candidate };
}

export async function refreshProtectedSnapshot(projectRoot: string, binding: Binding): Promise<{
  readonly source: string; readonly candidate: string;
} | undefined> {
  const manifestSource = await readFile(resolve(projectRoot, binding.manifest_path)).catch(() => undefined);
  if (manifestSource === undefined) return undefined;
  const manifestHash = createHash("sha256").update(manifestSource).digest("hex");
  if (`sha256:${manifestHash}` !== binding.manifest_hash) return undefined;
  if (binding.source_policy === "declared-paths-v1") {
    const source = await declaredScopeDigest(projectRoot, binding.source_paths.map(path => resolve(projectRoot, path)), manifestHash, true);
    const candidate = await declaredScopeDigest(projectRoot, binding.candidate_paths.map(path => resolve(projectRoot, path)), manifestHash, false);
    return source === undefined || candidate === undefined ? undefined : { source, candidate };
  }
  // Legacy evidence retains its original recipe; a new policy cannot relabel stale proof as fresh.
  if (binding.source_policy !== undefined && binding.source_policy !== "project-files-v1") return undefined;
  const source = await protectedScopeDigest(projectRoot, binding.source_paths.map(path => resolve(projectRoot, path)), manifestHash, binding.source_policy);
  const candidate = await protectedScopeDigest(projectRoot, binding.candidate_paths.map(path => resolve(projectRoot, path)), manifestHash);
  return source === undefined || candidate === undefined ? undefined : { source, candidate };
}
