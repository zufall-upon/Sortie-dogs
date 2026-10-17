import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureDockerWorkspaceSnapshot } from "../dist/plugin/docker-validation.js";

const exec = promisify(execFile);
const container = "0123456789abcdef01234567";

for (const mode of ["ignored-mode", "tracked-mode", "link-target", "hash-failure", "git-failure", "listing-failure", "stat-failure", "find-failure", "empty"]) {
  test(`Git-only Docker snapshot retains input identity and observation failures: ${mode}`, { skip: process.platform === "win32" }, async () => {
    await mkdir(resolve("_testenv"), { recursive: true });
    const root = await mkdtemp(resolve("_testenv/docker-git-fallback-"));
    const workspace = join(root, "task"), bin = join(root, "bin");
    const oldPath = process.env.PATH;
    const oldHashFailure = process.env.SORTIE_FIXTURE_HASH_FAILURE;
    const oldGitFailure = process.env.SORTIE_FIXTURE_GIT_FAILURE;
    const oldStatFailure = process.env.SORTIE_FIXTURE_STAT_FAILURE;
    const oldFindFailure = process.env.SORTIE_FIXTURE_FIND_FAILURE;
    try {
      await mkdir(workspace); await mkdir(bin);
      const git = (await exec("sh", ["-c", "command -v git"])).stdout.trim();
      const sha = (await exec("sh", ["-c", "command -v sha256sum"])).stdout.trim();
      const stat = (await exec("sh", ["-c", "command -v stat"])).stdout.trim();
      const find = (await exec("sh", ["-c", "command -v find"])).stdout.trim();
      await exec(git, ["init", "--quiet"], { cwd: workspace });
      await writeFile(join(workspace, ".gitignore"), "ignored*\n");
      await exec(git, ["add", ".gitignore"], { cwd: workspace });
      await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], { cwd: workspace });
      await writeFile(join(workspace, "ignored-check.sh"), "#!/bin/sh\nprintf 'PASS\\n'\n");
      await chmod(join(workspace, "ignored-check.sh"), 0o755);
      await writeFile(join(workspace, "ignored-quote' and\nnewline.txt"), "unusual names are ordinary input\n");
      // Only the availability probe is fault-injected. Execute the product's
      // real Git fallback shell, not a fabricated snapshot or digest.
      await writeFile(join(bin, "docker"), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);\nif(a[0]!=='exec'||a[1]!=='--workdir'||a[3]!==${JSON.stringify(container)}||a[4]!=='sh'||a[5]!=='-lc')process.exit(125);\nconst probe='if command -v python3 >/dev/null 2>&1; then';\nif(!a[6].includes(probe))process.exit(124);\nconst result=spawnSync('/bin/sh',['-c',a[6].replace(probe,'if false; then')],{cwd:a[2],env:process.env,stdio:'inherit'});\nprocess.exit(result.status??125);\n`);
      await writeFile(join(bin, "sha256sum"), `#!/bin/sh\nif [ -n "$SORTIE_FIXTURE_HASH_FAILURE" ]; then\n  for arg do [ "$arg" != "$SORTIE_FIXTURE_HASH_FAILURE" ] || exit 9; done\nfi\nexec ${JSON.stringify(sha)} "$@"\n`);
      await writeFile(join(bin, "git"), `#!/bin/sh\nif [ -n "$SORTIE_FIXTURE_GIT_FAILURE" ] && [ "$1" = "$SORTIE_FIXTURE_GIT_FAILURE" ]; then exit 9; fi\nexec ${JSON.stringify(git)} "$@"\n`);
      await writeFile(join(bin, "stat"), `#!/bin/sh\n[ "$SORTIE_FIXTURE_STAT_FAILURE" != yes ] || exit 9\nexec ${JSON.stringify(stat)} "$@"\n`);
      await writeFile(join(bin, "find"), `#!/bin/sh\n[ "$SORTIE_FIXTURE_FIND_FAILURE" != yes ] || exit 9\nexec ${JSON.stringify(find)} "$@"\n`);
      for (const name of ["docker", "git", "sha256sum", "stat", "find"]) await chmod(join(bin, name), 0o755);
      if (mode === "tracked-mode") {
        await writeFile(join(workspace, "tracked-check.sh"), "#!/bin/sh\nprintf 'PASS\\n'\n");
        await chmod(join(workspace, "tracked-check.sh"), 0o755);
        await exec(git, ["add", "tracked-check.sh"], { cwd: workspace });
        await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "tracked fixture"], { cwd: workspace });
        await exec(git, ["config", "core.filemode", "false"], { cwd: workspace });
      }
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      delete process.env.SORTIE_FIXTURE_HASH_FAILURE; delete process.env.SORTIE_FIXTURE_GIT_FAILURE; delete process.env.SORTIE_FIXTURE_STAT_FAILURE; delete process.env.SORTIE_FIXTURE_FIND_FAILURE;
      if (mode === "link-target") {
        await writeFile(join(root, "first"), "same bytes\n"); await writeFile(join(root, "second"), "same bytes\n");
        await symlink(join(root, "first"), join(workspace, "ignored-link"));
      }
      if (mode === "empty") {
        await unlink(join(workspace, "ignored-check.sh"));
        await unlink(join(workspace, "ignored-quote' and\nnewline.txt"));
      }
      const before = await captureDockerWorkspaceSnapshot(container, workspace);
      assert.ok(before);
      assert.deepEqual(await captureDockerWorkspaceSnapshot(container, workspace), before, "unchanged fallback is deterministic");
      if (mode === "empty") return;
      if (mode.endsWith("-mode")) {
        const check = mode === "tracked-mode" ? "tracked-check.sh" : "ignored-check.sh";
        assert.equal((await exec(`./${check}`, [], { cwd: workspace })).stdout, "PASS\n");
        await chmod(join(workspace, check), 0o644);
        await assert.rejects(exec(`./${check}`, [], { cwd: workspace }));
      } else if (mode === "link-target") {
        await unlink(join(workspace, "ignored-link"));
        await symlink(join(root, "second"), join(workspace, "ignored-link"));
        assert.equal(await readFile(join(workspace, "ignored-link"), "utf8"), "same bytes\n");
      } else if (mode === "hash-failure") process.env.SORTIE_FIXTURE_HASH_FAILURE = "ignored-check.sh";
      else if (mode === "stat-failure") process.env.SORTIE_FIXTURE_STAT_FAILURE = "yes";
      else if (mode === "find-failure") process.env.SORTIE_FIXTURE_FIND_FAILURE = "yes";
      else process.env.SORTIE_FIXTURE_GIT_FAILURE = mode === "listing-failure" ? "ls-files" : "diff";
      const after = await captureDockerWorkspaceSnapshot(container, workspace);
      if (mode.endsWith("failure")) assert.equal(after, undefined, "failed observation cannot mint an empty-data proof");
      else {
        assert.ok(after); assert.equal(after.source, before.source);
        assert.notEqual(after.candidate, before.candidate, "unchanged input bytes do not hide mode/link identity changes");
      }
    } finally {
      process.env.PATH = oldPath;
      if (oldHashFailure === undefined) delete process.env.SORTIE_FIXTURE_HASH_FAILURE; else process.env.SORTIE_FIXTURE_HASH_FAILURE = oldHashFailure;
      if (oldGitFailure === undefined) delete process.env.SORTIE_FIXTURE_GIT_FAILURE; else process.env.SORTIE_FIXTURE_GIT_FAILURE = oldGitFailure;
      if (oldStatFailure === undefined) delete process.env.SORTIE_FIXTURE_STAT_FAILURE; else process.env.SORTIE_FIXTURE_STAT_FAILURE = oldStatFailure;
      if (oldFindFailure === undefined) delete process.env.SORTIE_FIXTURE_FIND_FAILURE; else process.env.SORTIE_FIXTURE_FIND_FAILURE = oldFindFailure;
      await rm(root, { recursive: true, force: true });
    }
  });
}
