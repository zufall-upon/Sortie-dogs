import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const within = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rest));
};

/** Explicit external artifacts are filesystem inputs, not Git pathspecs. Stream complete bytes;
 * previews are bounded independently. Follow package links only inside a declared physical root.
 */
export async function declaredArtifacts(paths: readonly string[], previewLimit = 0) {
  const roots = [...new Set(paths.map(path => resolve(path)))].sort();
  const physical = await Promise.all(roots.map(path => realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return path;
    throw error;
  })));
  const entries: Array<readonly [string, string, string?]> = [];
  const excerpts: string[] = [];
  let remaining = previewLimit, truncated = false;
  const visited = new Set<string>();
  const visit = async (path: string, ancestors: ReadonlySet<string>): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    const label = path.replaceAll("\\", "/");
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata) { entries.push([label, "missing"]); return; }
    const canonical = await realpath(path);
    if (metadata.isSymbolicLink()) {
      entries.push([label, `symlink:${await readlink(path)}`, canonical]);
      if (!physical.some(root => within(root, canonical))) throw new Error("declared-artifact-link-outside-scope");
      if (ancestors.has(canonical)) return; // The link identity is recorded; do not traverse cycles.
      await visit(canonical, ancestors);
      return;
    }
    if (metadata.isDirectory()) {
      entries.push([label, "directory", canonical]);
      const next = new Set([...ancestors, canonical]);
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), next);
      return;
    }
    if (!metadata.isFile()) throw new Error("declared-artifact-not-file-or-directory");
    const hash = createHash("sha256");
    const room = remaining;
    let preview = Buffer.alloc(0);
    for await (const part of createReadStream(path)) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      hash.update(bytes);
      if (preview.length < room) preview = Buffer.concat([preview, bytes.subarray(0, room - preview.length)]);
    }
    entries.push([label, `file:${metadata.mode}`, hash.digest("hex")]);
    if (previewLimit > 0) {
      if (room) {
        const excerpt = `\n--- external file: ${label} ---\n${preview.includes(0) ? "[binary artifact: bytes fingerprinted]" : preview.toString("utf8")}`;
        const bounded = Buffer.from(excerpt).subarray(0, remaining);
        excerpts.push(bounded.toString("utf8"));
        remaining -= bounded.length;
      }
      if (metadata.size > room || remaining === 0) truncated = true;
    }
  };
  for (const path of roots) await visit(path, new Set());
  return { entries, excerpt: excerpts.join(""), truncated };
}
