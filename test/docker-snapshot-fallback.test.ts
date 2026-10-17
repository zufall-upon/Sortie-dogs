import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureDockerWorkspaceSnapshot } from "../dist/plugin/docker-validation.js";

const exec = promisify(execFile);
const container = "0123456789abcdef01234567";

for (const mode of ["ignored-mode", "tracked-mode", "tracked-assume-unchanged", "tracked-skip-worktree", "tracked-byte-failure", "regular-listing-failure", "stable-file-recreation", "unborn-symbolic-ref-failure", "unborn-ref-probe-failure", "unborn-empty-tree-failure", "unborn-diff-failure", "unborn-broken-ref-failure", "unborn-detached-failure", "committed-head-failure", "tracked-link-mode", "python-link-mode", "tracked-link-chain", "python-link-chain", "tracked-link-swap", "python-link-swap", "tracked-link-referent-failure", "python-link-observation-failure", "python-link-io-failure", "python-link-dangling", "python-link-not-directory", "python-link-loop", "tracked-link-permission-failure", "python-link-permission-failure", "tracked-link-dangling", "tracked-link-not-directory", "tracked-link-loop", "tracked-link-special-failure", "python-link-special-failure", "internal-directory-chain", "python-internal-directory-chain", "tracked-link-bytes", "tracked-link-failure", "internal-directory-link", "untracked-internal-directory-link", "external-directory-link", "untracked-external-directory-link", "tracked-deletion", "link-target", "hash-failure", "git-failure", "listing-failure", "stat-failure", "find-failure", "empty"]) {
  test(`${mode.startsWith("python-") ? "Python" : "Git-only"} Docker snapshot retains input identity and observation failures: ${mode}`, { skip: process.platform === "win32" || (mode.endsWith("link-permission-failure") && process.getuid?.() === 0) }, async () => {
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
      if (!mode.startsWith("unborn-")) await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], { cwd: workspace });
      await writeFile(join(workspace, "ignored-check.sh"), "#!/bin/sh\nprintf 'PASS\\n'\n");
      await chmod(join(workspace, "ignored-check.sh"), 0o755);
      await writeFile(join(workspace, "ignored-quote' and\nnewline.txt"), "unusual names are ordinary input\n");
      // Inject only producer faults, never a snapshot/digest. Normal Python
      // cases run unchanged; the two stat faults preserve every other syscall.
      const statFault = `import errno\n_real_stat = os.stat\ndef _fixture_stat(path, *args, **kwargs):\n    fault = os.environ.get("SORTIE_FIXTURE_STAT_FAILURE")\n    if os.fspath(path).endswith("/tracked-link") and fault in ("python-permission", "python-io"):\n        raise OSError(errno.EACCES if fault == "python-permission" else errno.EIO, "fixture referent observation", path)\n    return _real_stat(path, *args, **kwargs)\nos.stat = _fixture_stat\n`;
      await writeFile(join(bin, "docker"), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);\nif(a[0]!=='exec'||a[1]!=='--workdir'||a[3]!==${JSON.stringify(container)}||a[4]!=='sh'||a[5]!=='-lc')process.exit(125);\nconst probe='if command -v python3 >/dev/null 2>&1; then';\nif(!a[6].includes(probe))process.exit(124);\nif(${mode === "python-link-observation-failure" || mode === "python-link-io-failure"})a[6]=a[6].replace('import hashlib, json, os, stat, subprocess','import hashlib, json, os, stat, subprocess\\n'+${JSON.stringify(statFault)});\nconst result=spawnSync('/bin/sh',['-c',${mode.startsWith("python-")} ? a[6] : a[6].replace(probe,'if false; then')],{cwd:a[2],env:process.env,stdio:'inherit'});\nprocess.exit(result.status??125);\n`);
      await writeFile(join(bin, "sha256sum"), `#!/bin/sh\nif [ -n "$SORTIE_FIXTURE_HASH_FAILURE" ]; then\n  for arg do [ "$arg" != "$SORTIE_FIXTURE_HASH_FAILURE" ] || exit 9; done\nfi\nexec ${JSON.stringify(sha)} "$@"\n`);
      await writeFile(join(bin, "git"), `#!/bin/sh\nif [ "$SORTIE_FIXTURE_GIT_FAILURE" = head-tree ] && [ "$1" = rev-parse ] && [ "$2" = --verify ]; then exit 9; fi\nif [ -n "$SORTIE_FIXTURE_GIT_FAILURE" ] && [ "$1" = "$SORTIE_FIXTURE_GIT_FAILURE" ]; then exit 9; fi\nexec ${JSON.stringify(git)} "$@"\n`);
      await writeFile(join(bin, "stat"), `#!/bin/sh\n[ "$SORTIE_FIXTURE_STAT_FAILURE" != yes ] || exit 9\nif [ "$SORTIE_FIXTURE_STAT_FAILURE" = referent ] && [ "$1" = -L ]; then exit 9; fi\nexec ${JSON.stringify(stat)} "$@"\n`);
      await writeFile(join(bin, "find"), `#!/bin/sh\n[ "$SORTIE_FIXTURE_FIND_FAILURE" != yes ] || exit 9\nif [ "$SORTIE_FIXTURE_FIND_FAILURE" = regular ]; then\n  for arg do [ "$arg" != f ] || exit 9; done\nfi\nexec ${JSON.stringify(find)} "$@"\n`);
      for (const name of ["docker", "git", "sha256sum", "stat", "find"]) await chmod(join(bin, name), 0o755);
      if (mode === "tracked-mode" || mode === "tracked-assume-unchanged" || mode === "tracked-skip-worktree" || mode === "tracked-byte-failure") {
        await writeFile(join(workspace, "tracked-check.sh"), "#!/bin/sh\nprintf 'PASS\\n'\n" + (mode === "tracked-mode" ? "" : "exit 0\n"));
        await chmod(join(workspace, "tracked-check.sh"), 0o755);
        await exec(git, ["add", "tracked-check.sh"], { cwd: workspace });
        await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "tracked fixture"], { cwd: workspace });
        if (mode === "tracked-mode") await exec(git, ["config", "core.filemode", "false"], { cwd: workspace });
        else if (mode !== "tracked-byte-failure") await exec(git, ["update-index", mode === "tracked-assume-unchanged" ? "--assume-unchanged" : "--skip-worktree", "tracked-check.sh"], { cwd: workspace });
      }
      if (mode.endsWith("link-chain") || mode.endsWith("link-swap")) {
        for (const name of ["first", "second"]) {
          await mkdir(join(root, name));
          await writeFile(join(root, name, "runner.sh"), '#!/bin/sh\nreadlink -f "$0"\n');
          await chmod(join(root, name, "runner.sh"), 0o755);
        }
        await symlink(join(root, "first", "runner.sh"), join(root, "current"));
        await symlink(join(root, "current"), join(workspace, "tracked-link"));
        if (mode.endsWith("link-swap")) {
          await symlink(join(root, "second", "runner.sh"), join(root, "other"));
          await symlink(join(root, "other"), join(workspace, "other-link"));
          await exec(git, ["add", "other-link"], { cwd: workspace });
        }
        await exec(git, ["add", "tracked-link"], { cwd: workspace });
        await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "link chain fixture"], { cwd: workspace });
      }
      if (mode.endsWith("link-mode") || mode === "tracked-link-referent-failure" || ["python-link-observation-failure", "python-link-io-failure"].includes(mode) || mode.endsWith("link-dangling") || mode.endsWith("link-not-directory") || mode.endsWith("link-loop") || mode.endsWith("link-permission-failure") || mode.endsWith("link-special-failure")) {
        const parent = mode.endsWith("link-permission-failure") ? join(root, "restricted") : root;
        if (parent !== root) await mkdir(parent);
        await writeFile(join(parent, "reference.sh"), "#!/bin/sh\nprintf 'PASS\\n'\n");
        await chmod(join(parent, "reference.sh"), 0o755);
        await symlink(join(parent, "reference.sh"), join(workspace, "tracked-link"));
        await exec(git, ["add", "tracked-link"], { cwd: workspace });
        await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "executable link fixture"], { cwd: workspace });
      }
      if (mode === "tracked-link-bytes" || mode === "tracked-link-failure") {
        await writeFile(join(root, "reference.txt"), "before\n");
        await symlink(join(root, "reference.txt"), join(workspace, "tracked-link"));
        await exec(git, ["add", "tracked-link"], { cwd: workspace });
        await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "tracked link fixture"], { cwd: workspace });
      }
      if (mode.endsWith("directory-chain")) {
        for (const name of ["first", "second"]) {
          await mkdir(join(workspace, name));
          await writeFile(join(workspace, name, "input.txt"), `${name}\n`);
        }
        await symlink(join(workspace, "first"), join(root, "directory-current"));
        await symlink(join(root, "directory-current"), join(workspace, "tracked-directory"));
        await exec(git, ["add", "tracked-directory"], { cwd: workspace });
        await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "directory chain fixture"], { cwd: workspace });
      }
      if (mode.endsWith("directory-link")) {
        const target = join(mode.includes("internal-directory") ? workspace : root, "linked-directory");
        await mkdir(target); await writeFile(join(target, "input.txt"), "before\n");
        await symlink(target, join(workspace, "tracked-directory"));
        if (!mode.startsWith("untracked-")) {
          await exec(git, ["add", "tracked-directory"], { cwd: workspace });
          await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "directory link fixture"], { cwd: workspace });
        }
      }
      if (mode === "stable-file-recreation") {
        await writeFile(join(workspace, "order-a"), "alpha\n");
        await writeFile(join(workspace, "order-b"), "beta\n");
      }
      if (mode === "tracked-deletion") {
        await writeFile(join(workspace, "obsolete.txt"), "deleted candidate input\n");
        await exec(git, ["add", "obsolete.txt"], { cwd: workspace });
        await exec(git, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "deletion fixture"], { cwd: workspace });
        await unlink(join(workspace, "obsolete.txt"));
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
      if (mode.includes("external-directory-link")) { assert.equal(before, undefined, "external directory bytes are not silently omitted"); return; }
      assert.ok(before);
      assert.deepEqual(await captureDockerWorkspaceSnapshot(container, workspace), before, "unchanged fallback is deterministic");
      if (mode === "empty" || mode === "tracked-deletion") return;
      if (mode === "stable-file-recreation") {
        const content = (await exec("cat", ["order-a", "order-b"], { cwd: workspace })).stdout;
        await unlink(join(workspace, "order-a")); await unlink(join(workspace, "order-b"));
        await writeFile(join(workspace, "order-b"), "beta\n"); await writeFile(join(workspace, "order-a"), "alpha\n");
        assert.equal((await exec("cat", ["order-a", "order-b"], { cwd: workspace })).stdout, content);
        assert.deepEqual(await captureDockerWorkspaceSnapshot(container, workspace), before, "recreating identical inputs is not an inode/time/order edit");
        return;
      }
      if (mode === "tracked-assume-unchanged" || mode === "tracked-skip-worktree") {
        assert.match((await exec(git, ["ls-files", "-v", "tracked-check.sh"], { cwd: workspace })).stdout,
          mode === "tracked-assume-unchanged" ? /^h / : /^S /, "the actual index visibility flag is active");
        assert.equal((await exec("./tracked-check.sh", [], { cwd: workspace })).stdout, "PASS\n");
        const permissions = (await exec(stat, ["-c", "%a", "tracked-check.sh"], { cwd: workspace })).stdout;
        const size = (await readFile(join(workspace, "tracked-check.sh"))).length;
        await writeFile(join(workspace, "tracked-check.sh"), "#!/bin/sh\nprintf 'FAIL\\n'\nexit 7\n");
        assert.equal((await readFile(join(workspace, "tracked-check.sh"))).length, size, "actual same-size byte changes, not size-only metadata");
        await assert.rejects(exec("./tracked-check.sh", [], { cwd: workspace }), { code: 7 });
        assert.equal((await exec(stat, ["-c", "%a", "tracked-check.sh"], { cwd: workspace })).stdout, permissions);
      } else if (mode === "unborn-broken-ref-failure") {
        const ref = (await exec(git, ["symbolic-ref", "HEAD"], { cwd: workspace })).stdout.trim();
        await writeFile(join(workspace, ".git", ref), `${"1".repeat(40)}\n`);
      } else if (mode === "unborn-detached-failure") {
        await writeFile(join(workspace, ".git", "HEAD"), `${"1".repeat(40)}\n`);
      } else if (mode === "unborn-symbolic-ref-failure") process.env.SORTIE_FIXTURE_GIT_FAILURE = "symbolic-ref";
      else if (mode === "unborn-ref-probe-failure") process.env.SORTIE_FIXTURE_GIT_FAILURE = "show-ref";
      else if (mode === "unborn-empty-tree-failure") process.env.SORTIE_FIXTURE_GIT_FAILURE = "hash-object";
      else if (mode === "unborn-diff-failure") process.env.SORTIE_FIXTURE_GIT_FAILURE = "diff";
      else if (mode === "committed-head-failure") process.env.SORTIE_FIXTURE_GIT_FAILURE = "head-tree";
      else if (mode.endsWith("directory-chain")) {
        assert.equal((await exec("cat", ["tracked-directory/input.txt"], { cwd: workspace })).stdout, "first\n");
        await unlink(join(root, "directory-current"));
        await symlink(join(workspace, "second"), join(root, "directory-current"));
        assert.equal((await exec("cat", ["tracked-directory/input.txt"], { cwd: workspace })).stdout, "second\n");
      } else if (mode.endsWith("link-chain") || mode.endsWith("link-swap")) {
        if (mode.endsWith("link-swap")) {
          assert.equal((await exec("./other-link", [], { cwd: workspace })).stdout, `${join(root, "second", "runner.sh")}\n`);
          await unlink(join(root, "other"));
          await symlink(join(root, "first", "runner.sh"), join(root, "other"));
          assert.equal((await exec("./other-link", [], { cwd: workspace })).stdout, `${join(root, "first", "runner.sh")}\n`);
        }
        assert.equal((await exec("./tracked-link", [], { cwd: workspace })).stdout, `${join(root, "first", "runner.sh")}\n`);
        await unlink(join(root, "current"));
        await symlink(join(root, "second", "runner.sh"), join(root, "current"));
        assert.equal((await exec("./tracked-link", [], { cwd: workspace })).stdout, `${join(root, "second", "runner.sh")}\n`);
      } else if (mode.endsWith("link-mode")) {
        assert.equal((await exec("./tracked-link", [], { cwd: workspace })).stdout, "PASS\n");
        await chmod(join(root, "reference.sh"), 0o644);
        await assert.rejects(exec("./tracked-link", [], { cwd: workspace }), { code: "EACCES" });
      } else if (mode.endsWith("-mode")) {
        const check = mode === "tracked-mode" ? "tracked-check.sh" : "ignored-check.sh";
        assert.equal((await exec(`./${check}`, [], { cwd: workspace })).stdout, "PASS\n");
        await chmod(join(workspace, check), 0o644);
        await assert.rejects(exec(`./${check}`, [], { cwd: workspace }));
      } else if (mode.includes("internal-directory-link")) {
        await writeFile(join(workspace, "linked-directory", "input.txt"), "after\n");
      } else if (mode === "tracked-link-failure") {
        process.env.SORTIE_FIXTURE_HASH_FAILURE = "./tracked-link";
      } else if (mode === "tracked-link-bytes") {
        assert.equal(await readFile(join(workspace, "tracked-link"), "utf8"), "before\n");
        await writeFile(join(root, "reference.txt"), "after\n");
        assert.equal(await readFile(join(workspace, "tracked-link"), "utf8"), "after\n");
      } else if (mode === "link-target") {
        await unlink(join(workspace, "ignored-link"));
        await symlink(join(root, "second"), join(workspace, "ignored-link"));
        assert.equal(await readFile(join(workspace, "ignored-link"), "utf8"), "same bytes\n");
      } else if (mode.endsWith("link-special-failure")) {
        await unlink(join(root, "reference.sh"));
        await exec("mkfifo", [join(root, "reference.sh")]);
      } else if (mode.endsWith("link-permission-failure")) {
        assert.equal((await exec("./tracked-link", [], { cwd: workspace })).stdout, "PASS\n");
        await chmod(join(root, "restricted"), 0);
        await assert.rejects(exec("./tracked-link", [], { cwd: workspace }), { code: "EACCES" });
      } else if (mode.endsWith("link-dangling")) await unlink(join(root, "reference.sh"));
      else if (mode.endsWith("link-not-directory") || mode.endsWith("link-loop")) {
        await unlink(join(workspace, "tracked-link"));
        await symlink(mode.endsWith("link-loop") ? "tracked-link" : join(root, "reference.sh", "missing"), join(workspace, "tracked-link"));
      } else if (mode === "python-link-observation-failure") process.env.SORTIE_FIXTURE_STAT_FAILURE = "python-permission";
      else if (mode === "python-link-io-failure") process.env.SORTIE_FIXTURE_STAT_FAILURE = "python-io";
      else if (mode === "tracked-link-referent-failure") process.env.SORTIE_FIXTURE_STAT_FAILURE = "referent";
      else if (mode === "tracked-byte-failure") process.env.SORTIE_FIXTURE_HASH_FAILURE = "./tracked-check.sh";
      else if (mode === "regular-listing-failure") process.env.SORTIE_FIXTURE_FIND_FAILURE = "regular";
      else if (mode === "hash-failure") process.env.SORTIE_FIXTURE_HASH_FAILURE = "ignored-check.sh";
      else if (mode === "stat-failure") process.env.SORTIE_FIXTURE_STAT_FAILURE = "yes";
      else if (mode === "find-failure") process.env.SORTIE_FIXTURE_FIND_FAILURE = "yes";
      else process.env.SORTIE_FIXTURE_GIT_FAILURE = mode === "listing-failure" ? "ls-files" : "diff";
      const after = await captureDockerWorkspaceSnapshot(container, workspace);
      if (mode.endsWith("failure")) assert.equal(after, undefined, "failed observation cannot mint an empty-data proof");
      else {
        assert.ok(after);
        if (!mode.startsWith("python-")) assert.equal(after.source, before.source);
        assert.notEqual(after.candidate, before.candidate, "changed input bytes or mode/link identity cannot leave proof fresh");
      }
    } finally {
      process.env.PATH = oldPath;
      if (oldHashFailure === undefined) delete process.env.SORTIE_FIXTURE_HASH_FAILURE; else process.env.SORTIE_FIXTURE_HASH_FAILURE = oldHashFailure;
      if (oldGitFailure === undefined) delete process.env.SORTIE_FIXTURE_GIT_FAILURE; else process.env.SORTIE_FIXTURE_GIT_FAILURE = oldGitFailure;
      if (oldStatFailure === undefined) delete process.env.SORTIE_FIXTURE_STAT_FAILURE; else process.env.SORTIE_FIXTURE_STAT_FAILURE = oldStatFailure;
      if (oldFindFailure === undefined) delete process.env.SORTIE_FIXTURE_FIND_FAILURE; else process.env.SORTIE_FIXTURE_FIND_FAILURE = oldFindFailure;
      if (mode.endsWith("link-permission-failure")) await chmod(join(root, "restricted"), 0o755).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
