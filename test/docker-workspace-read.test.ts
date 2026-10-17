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

for (const mode of ["directory-page", "escaped-directory-page", "escaped-file", "long-line", "empty-file", "line-shapes", "line-boundary", "unborn-root", "committed-root", "spaced-unborn-root", "spaced-committed-root", "carriage-committed-root", "external-file-link", "external-file-chain", "external-directory-link"]) test(`native candidate reader handles its declared output bounds: ${mode}`, {
  skip: process.platform === "win32" || (mode === "long-line" && process.platform !== "linux"),
}, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/docker-workspace-read-"));
  const workspace = join(root, mode.startsWith("spaced-") ? "task " : mode.startsWith("carriage-") ? "task\r" : "task"), bin = join(root, "bin");
  const repository = mode.endsWith("-root"), cwd = repository ? join(workspace, "nested") : workspace;
  const priorPath = process.env.PATH;
  try {
    await mkdir(workspace); await mkdir(bin);
    // Execute the actual fixed snapshot and Python reader, with the same
    // isolated container Git discovery boundary; no fabricated output or model.
    await writeFile(join(bin, "docker"), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);\nif(a[0]!=='exec'||a[1]!=='--workdir'||a[3]!==${JSON.stringify(container)})process.exit(125);\n// Test-only memory pressure on the reader, not snapshots or product policy.\nif(${mode === "long-line"}&&a[4]==='python3'&&a[7]==='-c')a[8]='import resource; resource.setrlimit(resource.RLIMIT_AS, (64*1024*1024, 64*1024*1024))\\n'+a[8];\nconst r=spawnSync(a[4],a.slice(5),{cwd:a[2],env:{...process.env,GIT_CEILING_DIRECTORIES:${JSON.stringify(root)}},stdio:'inherit'});\nprocess.exit(r.status??125);\n`);
    await chmod(join(bin, "docker"), 0o755);
    const directory = mode.endsWith("directory-page");
    const names = Array.from({ length: 2001 }, (_, i) => `${String(i).padStart(4, "0")}-${mode === "escaped-directory-page" ? String.fromCharCode(1).repeat(250) : "entry".repeat(40)}`);
    const bytes = mode === "long-line" ? Buffer.concat([Buffer.alloc(48 * 1024 * 1024, 0x61), Buffer.from("\nαβγ\nlast")])
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
    if (mode.startsWith("external-")) {
      await writeFile(join(root, "external.txt"), "captured external input\n");
      await writeFile(join(root, "uncaptured.txt"), "not candidate input\n");
      await mkdir(join(root, "deep", "leaf"), { recursive: true });
      await mkdir(join(root, "deep", "task"));
      await symlink(join(root, "deep", "leaf"), join(root, "external-hop"));
      await symlink(join(root, "uncaptured.txt"), join(root, "deep", "task", "input-link"));
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
    if (mode.startsWith("external-file-")) {
      for (const path of [join(root, "external.txt"), join(root, "uncaptured.txt"), "../uncaptured.txt", "input-link/../uncaptured.txt", "../external-hop/../task/input-link"]) {
        await assert.rejects(readDockerWorkspaceFile(container, cwd, candidate.candidate, path), /file-outside-candidate-workspace/);
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
