import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { goalFingerprint, type GoalEvidence } from "../core/goal-bound.js";
import { normalizeManifestScope } from "../core/path.js";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";
import type { OperationManifest } from "../core/types.js";

type Binding = NonNullable<GoalEvidence["protected_binding"]>;
const controlRoots = new Set([".git", ...Object.values(RUNTIME_PROFILES).map(profile => profile.stateDirectory)]);

/** Live orchestration/Git bookkeeping is readable context, not the source being validated. */
export function isRuntimeControlPath(path: string): boolean {
  const first = path.replaceAll("\\", "/").split("/")[0]!;
  return controlRoots.has(process.platform === "win32" ? first.toLowerCase() : first);
}

async function protectedScopeDigest(projectRoot: string, paths: readonly string[], manifestHash: string,
  sourcePolicy?: Binding["source_policy"]): Promise<string | undefined> {
  const entries: Array<readonly [string, string, string?]> = [];
  const canonicalRoot = await realpath(projectRoot);
  const visit = async (absolute: string): Promise<boolean> => {
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
  const source = await protectedScopeDigest(authorization.projectRoot, sourcePaths, manifestHash, "project-files-v1");
  // Explicit outputs and the exact operation manifest remain pinned, including control-like paths.
  const candidate = await protectedScopeDigest(authorization.projectRoot, candidatePaths, manifestHash);
  if (source === undefined || candidate === undefined || relativePath.startsWith("../") || isAbsolute(relativePath)) return undefined;
  return { binding: { manifest_hash: `sha256:${manifestHash}`, project_root: authorization.projectRoot,
    manifest_path: relativePath, source_policy: "project-files-v1",
    source_paths: sourcePaths.map(path => relative(authorization.projectRoot, path).replaceAll("\\", "/")),
    candidate_paths: candidatePaths.map(path => relative(authorization.projectRoot, path).replaceAll("\\", "/")) }, source, candidate };
}

export async function refreshProtectedSnapshot(projectRoot: string, binding: Binding): Promise<{
  readonly source: string; readonly candidate: string;
} | undefined> {
  const manifestSource = await readFile(resolve(projectRoot, binding.manifest_path)).catch(() => undefined);
  if (manifestSource === undefined) return undefined;
  const manifestHash = createHash("sha256").update(manifestSource).digest("hex");
  if (`sha256:${manifestHash}` !== binding.manifest_hash) return undefined;
  // Legacy evidence retains its original recipe; a new policy cannot relabel stale proof as fresh.
  if (binding.source_policy !== undefined && binding.source_policy !== "project-files-v1") return undefined;
  const source = await protectedScopeDigest(projectRoot, binding.source_paths.map(path => resolve(projectRoot, path)), manifestHash, binding.source_policy);
  const candidate = await protectedScopeDigest(projectRoot, binding.candidate_paths.map(path => resolve(projectRoot, path)), manifestHash);
  return source === undefined || candidate === undefined ? undefined : { source, candidate };
}
