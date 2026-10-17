import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureDockerWorkspaceSnapshot, readDockerWorkspaceFile } from "../dist/plugin/docker-validation.js";

const exec = promisify(execFile);
const container = "0123456789abcdef01234567";

for (const variant of ["directory-page", "escaped-directory-page", "escaped-file", "long-line", "empty-file", "line-shapes", "line-boundary", "unborn-root", "committed-root", "spaced-unborn-root", "spaced-committed-root", "carriage-committed-root", "external-file-link", "external-file-chain", "external-file-git-metadata", "external-file-git-alias", "external-file-nested-git", "external-directory-link", "git-only-escaped-file", "git-only-directory-page", "git-only-escaped-directory-page", "git-only-long-line", "git-only-empty-file", "git-only-line-shapes", "git-only-line-boundary", "git-only-external-file-link", "git-only-external-file-chain", "git-only-external-file-git-metadata", "git-only-external-file-git-alias", "git-only-external-file-nested-git", "git-only-external-directory-link", "git-only-read-failure", "git-only-change-during-read", "python-reader-failure", "binary-file", "git-only-binary-file", "git-only-empty-directory", "git-only-invalid-name", "git-only-coreutils-file", "git-only-coreutils-directory-page"]) test(`native candidate reader handles its declared output bounds: ${variant}`, {
  skip: process.platform === "win32" || (variant.endsWith("long-line") && process.platform !== "linux"),
}, async () => {
  const noPython = variant.startsWith("git-only-");
  const mode = noPython ? variant.slice("git-only-".length) : variant;
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/docker-workspace-read-"));
  const workspace = join(root, mode.startsWith("spaced-") ? "task " : mode.startsWith("carriage-") ? "task\r" : "task"), bin = join(root, "bin");
  const repository = mode.endsWith("-root"), cwd = repository ? join(workspace, "nested") : workspace;
  const priorPath = process.env.PATH;
  try {
    await mkdir(workspace); await mkdir(bin);
    if (mode.startsWith("coreutils-")) {
      const find = (await exec("sh", ["-c", "command -v find"])).stdout.trim();
      await writeFile(join(bin, "find"), `#!/bin/sh\nfor arg do [ "$arg" != -printf ] || exit 9; done\nexec ${JSON.stringify(find)} "$@"\n`);
      await chmod(join(bin, "find"), 0o755);
    }
    // Execute the actual fixed snapshot and Python reader, with the same
    // isolated container Git discovery boundary; no fabricated output or model.
    await writeFile(join(bin, "docker"), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nconst a=process.argv.slice(2);\nif(a[0]!=='exec'||a[1]!=='--workdir'||a[3]!==${JSON.stringify(container)})process.exit(125);\nif(${noPython}){\nif(a[4]==='python3')process.exit(127);\nif(a[4]==='sh'&&a[6]==='command -v python3 >/dev/null 2>&1')process.exit(1);\nif(a[4]==='sh')a[6]=a[6].replace('if command -v python3 >/dev/null 2>&1; then','if false; then');\n}\nif(${variant === "python-reader-failure"}&&a[4]==='python3')process.exit(9);\n// Test-only memory pressure on the reader, not snapshots or product policy.\nif(${mode === "long-line"}&&a[4]==='python3'&&a[7]==='-c')a[8]='import resource; resource.setrlimit(resource.RLIMIT_AS, (64*1024*1024, 64*1024*1024))\\n'+a[8];\nconst r=spawnSync(a[4],a.slice(5),{cwd:a[2],env:{...process.env,GIT_CEILING_DIRECTORIES:${JSON.stringify(root)}},stdio:'inherit'});\nif(a[4]==='sh'&&a[6].includes('SORTIE_READ_V1')){\nif(${variant === "git-only-read-failure"})process.exit(9);\nif(${variant === "git-only-change-during-read"})writeFileSync(${JSON.stringify(join(workspace, "escaped.txt"))},'changed during read');\n}\nprocess.exit(r.status??125);\n`);
    await chmod(join(bin, "docker"), 0o755);
    const directory = mode.endsWith("directory-page");
    const names = Array.from({ length: 2001 }, (_, i) => `${String(i).padStart(4, "0")}-${mode === "escaped-directory-page" ? String.fromCharCode(1).repeat(250) : "entry".repeat(40)}`);
    if (directory) names.push("with\nnewline", "\ue000", "\ufeffbom", "\u{10000}");
    const bytes = mode === "binary-file" ? Buffer.from([0, 10, 255, 0, 226, 130, 172, 13, 10, 0])
      : mode === "long-line" ? Buffer.concat([Buffer.alloc(48 * 1024 * 1024, 0x61), Buffer.from("\nαβγ\nlast")])
      : mode === "empty-file" ? Buffer.alloc(0)
      : mode === "line-shapes" ? Buffer.from(`\n\r\nαβγ\n${"x".repeat(63988)}😀\nlast`)
      : mode === "line-boundary" ? Buffer.from(`${"x".repeat(63999)}\nlast\n`)
      : Buffer.alloc(64000, 1);
    if (directory) {
      for (let i = 0; i < names.length; i += 100) await Promise.all(names.slice(i, i + 100).map(name => writeFile(join(workspace, name), "")));
      assert.ok(Buffer.byteLength(JSON.stringify(names.slice(0, 2000))) > 256 * 1024, "valid requested page really exceeds the old stdout cap");
    } else await writeFile(join(workspace, "escaped.txt"), bytes);
    if (repository) {
      await mkdir(cwd);
      await exec("git", ["init", "--quiet"], { cwd: workspace });
      if (mode.endsWith("committed-root")) {
        await exec("git", ["add", "escaped.txt"], { cwd: workspace });
        await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], { cwd: workspace });
      }
    }
    if (mode === "empty-directory") await mkdir(join(workspace, "empty"));
    if (mode === "invalid-name") await writeFile(Buffer.concat([Buffer.from(join(workspace, "invalid-")), Buffer.from([255])]), "input\n");
    if (noPython) {
      await exec("git", ["init", "--quiet"], { cwd: workspace });
      await exec("git", ["add", "."], { cwd: workspace });
      await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Git-only fixture"], { cwd: workspace });
      if (directory) names.unshift(".git");
    }
    if (mode.startsWith("external-")) {
      await writeFile(join(root, "external.txt"), "captured external input\n");
      await writeFile(join(root, "uncaptured.txt"), "not candidate input\n");
      await mkdir(join(root, "deep", "leaf"), { recursive: true });
      await mkdir(join(root, "deep", "task"));
      await symlink(join(root, "deep", "leaf"), join(root, "external-hop"));
      await symlink(join(root, "uncaptured.txt"), join(root, "deep", "task", "input-link"));
      if (mode === "external-file-nested-git") {
        await mkdir(join(workspace, "sub", ".git"), { recursive: true });
        await symlink(join(root, "external.txt"), join(workspace, "sub", ".git", "nested-link"));
      }
      if (mode === "external-file-git-metadata" || mode === "external-file-git-alias") {
        await mkdir(join(workspace, ".git"), { recursive: true });
        await symlink(join(root, "uncaptured.txt"), join(workspace, ".git", "excluded-link"));
        if (mode === "external-file-git-alias") await symlink(join(workspace, ".git"), join(workspace, "git-metadata-alias"));
      }
      if (mode === "external-directory-link") {
        await mkdir(join(root, "external-directory"));
        await symlink(join(root, "external-directory"), join(workspace, "input-link"));
      } else {
        if (mode === "external-file-chain") await symlink(join(root, "external.txt"), join(root, "intermediate"));
        await symlink(join(root, mode === "external-file-chain" ? "intermediate" : "external.txt"), join(workspace, "input-link"));
      }
    }
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    const candidate = await captureDockerWorkspaceSnapshot(container, cwd);
    if (mode === "external-directory-link") {
      assert.equal(candidate, undefined, "uncaptured external directory trees remain unavailable");
      return;
    }
    assert.ok(candidate);
    if (mode === "empty-directory") {
      const empty = await readDockerWorkspaceFile(container, cwd, candidate.candidate, "empty");
      assert.deepEqual(empty.entries, []); assert.equal(empty.total, 0);
      return;
    }
    if (mode === "invalid-name") {
      await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate, "."), { code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
      assert.deepEqual(await captureDockerWorkspaceSnapshot(container, cwd), candidate);
      return;
    }
    if (variant === "git-only-read-failure" || variant === "python-reader-failure") {
      await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate, "escaped.txt"),
        variant === "python-reader-failure" ? { code: 9 } : /docker-candidate-read-failed:9/);
      assert.deepEqual(await captureDockerWorkspaceSnapshot(container, cwd), candidate);
      return;
    }
    if (variant === "git-only-change-during-read") {
      await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate, "escaped.txt"), /candidate-changed-during-read/);
      return;
    }
    if (mode.startsWith("external-file-")) {
      if (mode === "external-file-git-metadata" || mode === "external-file-git-alias") {
        await writeFile(join(root, "uncaptured.txt"), "changed but still not captured\n");
        assert.deepEqual(await captureDockerWorkspaceSnapshot(container, cwd), candidate, "Git bookkeeping referents are not candidate input");
        await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate,
          mode === "external-file-git-metadata" ? ".git/excluded-link" : "git-metadata-alias/excluded-link"), /file-outside-candidate-workspace/);
      }
      for (const path of [join(root, "external.txt"), join(root, "uncaptured.txt"), "../uncaptured.txt", "input-link/../uncaptured.txt", "../external-hop/../task/input-link"]) {
        await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate, path), /file-outside-candidate-workspace/);
      }
      if (mode === "external-file-nested-git") {
        const nested = await readDockerWorkspaceFile(container, cwd, candidate.candidate, "sub/.git/nested-link");
        assert.deepEqual(nested.lines, [[1, "captured external input\n"]], "only root Git bookkeeping is pruned by snapshot");
      }
      const read = await readDockerWorkspaceFile(container, cwd, candidate.candidate, "input-link");
      assert.deepEqual(read.lines, [[1, "captured external input\n"]]);
      assert.equal(read.sha256, createHash("sha256").update("captured external input\n").digest("hex"));
      assert.equal(read.workspace.candidate, candidate.candidate, "read does not replace the protected candidate");
      const absolute = await readDockerWorkspaceFile(container, cwd, candidate.candidate, join(workspace, "input-link"));
      assert.deepEqual(absolute.lines, read.lines, "absolute candidate-local link is the same admitted input");
      assert.equal(absolute.sha256, read.sha256);
      await writeFile(join(root, "external.txt"), "changed external input\n");
      await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate, "input-link"), /candidate-stale/);
      const fresh = await captureDockerWorkspaceSnapshot(container, cwd);
      assert.ok(fresh);
      if (mode === "external-file-chain") {
        await writeFile(join(root, "retargeted.txt"), "changed external input\n");
        await unlink(join(root, "intermediate"));
        await symlink(join(root, "retargeted.txt"), join(root, "intermediate"));
      } else {
        await unlink(join(workspace, "input-link"));
        await symlink(join(root, "uncaptured.txt"), join(workspace, "input-link"));
      }
      await assert.rejects(readDockerWorkspaceFile(container, cwd, fresh.candidate, "input-link"), /candidate-stale/);
      return;
    }
    if (repository) {
      assert.deepEqual(await captureDockerWorkspaceSnapshot(container, cwd), candidate, "unchanged observation is deterministic");
      await writeFile(join(workspace, "escaped.txt"), "changed root input\n");
      const after = await captureDockerWorkspaceSnapshot(container, cwd);
      assert.ok(after);
      assert.notEqual(after.candidate, candidate.candidate, "nested cwd cannot omit the root input when Git has no HEAD yet");
      assert.equal(after.repository_root, workspace);
      await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate, "escaped.txt"), /candidate-stale/);
      const read = await readDockerWorkspaceFile(container, cwd, after.candidate, "escaped.txt");
      assert.deepEqual(read.lines, [[1, "changed root input\n"]]);
      return;
    }
    if (directory) {
      const first = await readDockerWorkspaceFile(container, workspace, candidate.candidate, ".", 1, 2000);
      assert.equal(first.kind, "directory"); assert.equal(first.total, names.length);
      assert.deepEqual(first.entries, names.slice(0, 2000));
      const tail = await readDockerWorkspaceFile(container, workspace, candidate.candidate, ".", 2001, 2000);
      assert.deepEqual(tail.entries, names.slice(2000));
      await writeFile(join(workspace, "changed.txt"), "changed candidate\n");
    } else {
      const file = await readDockerWorkspaceFile(container, workspace, candidate.candidate, "escaped.txt", 1, 2000);
      const logical: Buffer[] = [];
      for (let start = 0; start < bytes.length;) {
        const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline + 1;
        logical.push(bytes.subarray(start, end)); start = end;
      }
      const expected = (offset: number, limit: number): [number, string][] => {
        let budget = 64000;
        return logical.slice(offset - 1, offset - 1 + limit).flatMap((line, i) => {
          if (!budget) return [];
          const retained = line.subarray(0, budget); budget -= retained.length;
          return [[offset + i, retained.toString("utf8")] as [number, string]];
        });
      };
      assert.equal(file.kind, "file"); assert.equal(file.total_lines, logical.length);
      assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(file.lines, expected(1, 2000));
      const tail = await readDockerWorkspaceFile(container, workspace, candidate.candidate, "escaped.txt", 2, 2);
      assert.deepEqual(tail.lines, expected(2, 2));
      assert.equal(tail.total_lines, logical.length); assert.equal(tail.sha256, file.sha256);
      await writeFile(join(workspace, "escaped.txt"), "changed candidate\n");
    }
    await assert.rejects(readDockerWorkspaceFile(container, workspace, candidate.candidate, "."), /candidate-stale/);
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});
