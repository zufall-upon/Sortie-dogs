import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const helper = resolve("scripts/swebench-test-reset.py");
const run = (cwd: string, command: string, args: string[]) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("diagnostic resets restore tracked tests and remove new collisions without changing production or heredocs", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-test-reset-"));
  try {
    run(root, "git", ["init", "-q"]);
    await writeFile(join(root, "production.py"), "original\n");
    await writeFile(join(root, "existing test.py"), "original test\n");
    await writeFile(join(root, "deleted.py"), "restore me\n");
    run(root, "git", ["add", "."]);
    run(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]);
    const base = run(root, "git", ["rev-parse", "HEAD"]).trim();
    await writeFile(join(root, "production.py"), "candidate repair\n");
    await writeFile(join(root, "existing test.py"), "candidate test\n");
    await rm(join(root, "deleted.py"));
    await writeFile(join(root, "new-test.py"), "candidate new test\n");
    await writeFile(join(root, "other-test.py"), "unrelated candidate test\n");
    const heredoc = `cat > preserved.txt <<'FIXTURE'\ngit checkout ${base} production.py\nFIXTURE\n`;
    const input = `#!/bin/bash\nset -eu\ngit checkout ${base} -- 'existing test.py' deleted.py new-test.py\n${heredoc}`;
    await writeFile(join(root, "input.sh"), input);
    run(root, "python3", [helper, "--input", "input.sh", "--output", "output.sh", "--metadata", "metadata.json"]);
    const normalized = await readFile(join(root, "output.sh"), "utf8");
    assert.ok(normalized.includes(heredoc), "heredoc contents must remain byte-for-byte unchanged");
    run(root, "bash", ["output.sh"]);
    assert.equal(await readFile(join(root, "production.py"), "utf8"), "candidate repair\n");
    assert.equal(await readFile(join(root, "existing test.py"), "utf8"), "original test\n");
    assert.equal(await readFile(join(root, "deleted.py"), "utf8"), "restore me\n");
    await assert.rejects(readFile(join(root, "new-test.py")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "other-test.py"), "utf8"), "unrelated candidate test\n");
    assert.equal(await readFile(join(root, "preserved.txt"), "utf8"), `git checkout ${base} production.py\n`);
    const metadata = JSON.parse(await readFile(join(root, "metadata.json"), "utf8"));
    assert.equal(metadata.official_score, false);
    assert.equal(metadata.input_sha256, createHash("sha256").update(input).digest("hex"));
    assert.equal(metadata.output_sha256, createHash("sha256").update(normalized).digest("hex"));
    assert.throws(() => run(root, "python3", [helper, "--input", "input.sh", "--output", "output.sh", "--metadata", "metadata.json"]));
    assert.equal(await readFile(join(root, "input.sh"), "utf8"), input);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic reset rejects unsupported shell paths and missing base before removing files", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-test-reset-invalid-"));
  try {
    const base = "a".repeat(40);
    for (const operand of ["../outside.py", "/outside.py", ".git/config", "'$HOME/test.py'", "'a;touch sentinel'", "*.py", "--"]) {
      await writeFile(join(root, "input.sh"), `git checkout ${base} ${operand}\n`);
      assert.throws(() => run(root, "python3", [helper, "--input", "input.sh", "--output", "output.sh", "--metadata", "metadata.json"]));
      await assert.rejects(readFile(join(root, "output.sh")), { code: "ENOENT" });
    }
    for (const input of [`cat <<'END'\ngit checkout ${base} tests.py\n`, `cat <<A <<B\n`, "git checkout main tests.py\n", `echo '\ngit checkout ${base} keep.py\n'\n`]) {
      await writeFile(join(root, "input.sh"), input);
      assert.throws(() => run(root, "python3", [helper, "--input", "input.sh", "--output", "output.sh", "--metadata", "metadata.json"]));
    }
    run(root, "git", ["init", "-q"]);
    await writeFile(join(root, "keep.py"), "candidate test\n");
    await writeFile(join(root, "input.sh"), `git checkout ${base} keep.py\n`);
    run(root, "python3", [helper, "--input", "input.sh", "--output", "output.sh", "--metadata", "metadata.json"]);
    assert.throws(() => run(root, "bash", ["output.sh"]));
    assert.equal(await readFile(join(root, "keep.py"), "utf8"), "candidate test\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
