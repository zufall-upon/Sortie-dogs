import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { inspectAppExecLink, sameAppExecLink, type AppExecLinkIdentity } from "./windows-app-exec-link.js";

const within = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rest));
};

/** Explicit external artifacts are filesystem inputs, not Git pathspecs. Stream complete bytes;
 * previews are bounded independently. Follow package links only inside a declared physical root.
 */
export async function declaredArtifacts(paths: readonly string[], previewLimit = 0,
  options: { reportUnreadableDirectories?: boolean; reportUnreadableFile?: (path: string) => boolean | Promise<boolean>; reportOutsideLinks?: boolean } = {}) {
  const roots = [...new Set(paths.map(path => resolve(path)))].sort();
  const aliasRoots = new Map<string, AppExecLinkIdentity>();
  const physical = await Promise.all(roots.map(async path => {
    try { return await realpath(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return path;
      if (code === "EACCES" || code === "EPERM") {
        const identity = await inspectAppExecLink(path);
        if (identity) {
          aliasRoots.set(path, identity);
          return identity.canonicalEntry;
        }
      }
      throw error;
    }
  }));
  const entries: Array<readonly [string, string, string?]> = [];
  const excerpts: string[] = [];
  const unreadable: string[] = [];
  const unreadableFiles: string[] = [];
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
    const pinnedAlias = aliasRoots.get(path);
    if (pinnedAlias !== undefined) {
      // Root discovery and walking must observe the same exact entry. A race
      // or an incomplete reparse read is never converted into "missing".
      const current = metadata?.isSymbolicLink() ? await inspectAppExecLink(path) : undefined;
      if (!current || !sameAppExecLink(pinnedAlias, current)) throw new Error("declared-artifact-entry-changed");
      const digest = createHash("sha256").update(JSON.stringify(current)).digest("hex");
      entries.push([label, "app-execution-alias:entry", digest]);
      const notice = Buffer.from(`\n--- external App Execution Alias: ${label} ---\n[entry metadata fingerprinted; target not followed]\n`);
      const bounded = notice.subarray(0, remaining);
      if (bounded.length) { excerpts.push(bounded.toString("utf8")); remaining -= bounded.length; }
      if (bounded.length < notice.length) truncated = true;
      return;
    }
    if (!metadata) { entries.push([label, "missing"]); return; }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      let canonical: string;
      try { canonical = await realpath(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // ENOENT may be the link disappearing or being replaced, not a missing target.
        const current = await lstat(path);
        if (!current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino
          || current.ctimeMs !== metadata.ctimeMs || current.mtimeMs !== metadata.mtimeMs
          || await readlink(path) !== target) throw error;
        entries.push([label, `symlink:${target}`, "target-missing:ENOENT"]);
        const notice = Buffer.from(`\n--- external symlink: ${label} ---\n${target}\n[target missing: ENOENT]\n`);
        const bounded = notice.subarray(0, remaining);
        if (bounded.length) { excerpts.push(bounded.toString("utf8")); remaining -= bounded.length; }
        if (bounded.length < notice.length) truncated = true;
        return;
      }
      entries.push([label, `symlink:${target}`, canonical]);
      if (!physical.some(root => within(root, canonical))) {
        if (!options.reportOutsideLinks) throw new Error("declared-artifact-link-outside-scope");
        // Review records the link entry, not authority to inspect its target. Keep the
        // strict default for validation snapshots and never recurse beyond declared roots.
        entries.push([label, "target-not-inspected:outside-scope", canonical]);
        const notice = Buffer.from(`\n--- external symlink: ${label} ---\n${target}\n[target not inspected: outside declared scope]\n`);
        const bounded = notice.subarray(0, remaining);
        if (bounded.length) { excerpts.push(bounded.toString("utf8")); remaining -= bounded.length; }
        if (bounded.length < notice.length) truncated = true;
        return;
      }
      if (ancestors.has(canonical)) return; // The link identity is recorded; do not traverse cycles.
      await visit(canonical, ancestors);
      return;
    }
    const canonical = await realpath(path);
    if (metadata.isDirectory()) {
      entries.push([label, "directory", canonical]);
      const next = new Set([...ancestors, canonical]);
      let children: string[];
      try { children = await readdir(path); }
      catch (error) {
        if (!options.reportUnreadableDirectories || !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        entries.push([label, `unreadable:${(error as NodeJS.ErrnoException).code}`, canonical]);
        unreadable.push(label);
        const notice = `\n--- external directory: ${label} ---\n[not inspected: permission denied; select specific result files as review evidence]\n`;
        const bytes = Buffer.from(notice), bounded = bytes.subarray(0, remaining);
        if (bounded.length) {
          excerpts.push(bounded.toString("utf8"));
          remaining -= bounded.length;
        }
        if (bounded.length < bytes.length) truncated = true;
        return;
      }
      for (const child of children.sort()) await visit(join(path, child), next);
      return;
    }
    if (!metadata.isFile()) throw new Error("declared-artifact-not-file-or-directory");
    const hash = createHash("sha256");
    const room = remaining;
    let preview = Buffer.alloc(0);
    let received = false;
    try {
      for await (const part of createReadStream(path)) {
        received = true;
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        hash.update(bytes);
        if (preview.length < room) preview = Buffer.concat([preview, bytes.subarray(0, room - preview.length)]);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A partial read is not an uninspected file. Validation never enables this option.
      if (received || !["EACCES", "EPERM"].includes(code ?? "") || !(await options.reportUnreadableFile?.(path))) throw error;
      entries.push([label, `unreadable-file:${metadata.mode}:${metadata.size}:${code}`, canonical]);
      unreadableFiles.push(label);
      const notice = Buffer.from(`\n--- external file: ${label} ---\n[not inspected: permission denied; file bytes not fingerprinted]\n`);
      const bounded = notice.subarray(0, remaining);
      if (bounded.length) { excerpts.push(bounded.toString("utf8")); remaining -= bounded.length; }
      if (bounded.length < notice.length) truncated = true;
      return;
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
  return { entries, excerpt: excerpts.join(""), truncated, unreadable, unreadableFiles };
}
