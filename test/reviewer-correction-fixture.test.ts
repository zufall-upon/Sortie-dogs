import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { exec, fixture } from "./helpers/reviewer-correction-fixture.ts";

test("Reviewer fixtures reuse only plain base inputs with independent Git and Mission state", async () => {
  const first = await fixture();
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  let firstDisposed = false;
  try {
    second = await fixture();
    const git = async (directory: string, ...args: string[]) => (await exec("git", args, { cwd: directory })).stdout.trim();
    const base = await git(first.directory, "rev-parse", "HEAD");
    assert.equal(await git(second.directory, "rev-parse", "HEAD"), base);
    for (const f of [first, second]) {
      assert.equal(await git(f.directory, "branch", "--show-current"), "base");
      assert.equal(await git(f.directory, "status", "--porcelain"), "");
      assert.equal(await git(f.directory, "remote"), "", "base fixture does not introduce remotes or tracking");
      assert.deepEqual(f.history, {});
      assert.equal(f.storage.size, 0);
      assert.equal(await readFile(join(f.directory, "result.txt"), "utf8"), "old\n");
    }
    const object = join(".git", "objects", base.slice(0, 2), base.slice(2));
    const [a, b] = await Promise.all([stat(join(first.directory, object)), stat(join(second.directory, object))]);
    assert.equal(a.nlink, 1); assert.equal(b.nlink, 1);
    if (process.platform !== "win32") assert.notEqual(a.ino, b.ino, "Git objects are not shared hardlinks");
    await writeFile(join(first.directory, "result.txt"), "first only\n");
    await git(first.directory, "add", "result.txt");
    assert.equal(await git(second.directory, "diff", "--cached"), "", "indexes are independent");
    await git(first.directory, "commit", "--quiet", "-m", "independent fixture");
    assert.notEqual(await git(first.directory, "rev-parse", "HEAD"), base);
    assert.equal(await git(second.directory, "rev-parse", "HEAD"), base);
    assert.equal(await readFile(join(second.directory, "result.txt"), "utf8"), "old\n");
    first.storage.set("first-only", true);
    first.agents.author!.outcome = "interrupted";
    await first.start();
    assert.equal(second.storage.has("first-only"), false);
    assert.equal(second.agents.author!.outcome, undefined);
    await first.dispose();
    firstDisposed = true;
    assert.equal(await git(second.directory, "status", "--porcelain"), "", "disposing a sibling preserves the fixture");
  } finally {
    if (!firstDisposed) await first.dispose();
    await second?.dispose();
  }
});
