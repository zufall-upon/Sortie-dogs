import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { missionReviewSource } from "../dist/plugin/mission-review.js";

const git = promisify(execFile);

test("mission review source ignores the shared tool environment", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-review-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await git("git", ["config", "user.name", "test"], { cwd: root });
    await writeFile(join(root, "product.py"), "base\n");
    await git("git", ["add", "product.py"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    await writeFile(join(root, "product.py"), "fixed\n");
    await writeFile(join(root, "added_test.py"), "assert True\n");
    const run = { units: [{ unit: { write: ["."] }, hashes: ["h"] }] } as never;
    const before = await missionReviewSource(root, run);
    await mkdir(join(root, ".sortie-env", "bin"), { recursive: true });
    await writeFile(join(root, ".sortie-env", "bin", "python"), "tool environment\n");
    const after = await missionReviewSource(root, run);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.match(after.excerpt, /new file: added_test\.py/u);
    assert.doesNotMatch(after.excerpt, /\.sortie-env/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
