import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { OperatorState } from "../core/operator-runtime.js";

const exec = promisify(execFile);
/** Pin all scoped tracked/untracked source bytes, including deletions; display a bounded excerpt only. */
export async function missionReviewSource(directory: string, run: OperatorState): Promise<{ fingerprint: string; excerpt: string }> {
  const scopes = [...new Set(run.units.flatMap(unit => unit.unit.write))];
  const git = async (args: string[]) => (await exec("git", args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const names = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes]);
  const untracked = new Set((await git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...scopes])).split("\0").filter(Boolean));
  const hash = createHash("sha256").update(JSON.stringify(run.units.map(unit => ({ unit: unit.unit, hashes: unit.hashes }))));
  let excerpt = await git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...scopes]).catch(() => git(["diff", "--no-ext-diff", "--no-textconv", "--", ...scopes]));
  for (const path of [...new Set(names.split("\0").filter(Boolean))].sort()) {
    hash.update(JSON.stringify(path));
    try {
      const absolute = resolve(directory, path), stat = await lstat(absolute);
      hash.update(String(stat.mode));
      const content = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
      hash.update(String(content.length)).update(content);
      if (untracked.has(path) && Buffer.byteLength(excerpt) < 24_000) excerpt += `\n--- new file: ${path} ---\n${content.toString("utf8")}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("deleted"); }
  }
  const bytes = Buffer.from(excerpt);
  return { fingerprint: `sha256:${hash.digest("hex")}`, excerpt: bytes.length > 24_000
    ? `${bytes.subarray(0, 24_000).toString("utf8")}\n[EXCERPT TRUNCATED: report missing evidence; do not infer PASS]` : excerpt };
}
