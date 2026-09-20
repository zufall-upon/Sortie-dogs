import assert from "node:assert/strict";
import { ChildProcess, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  produceWorktreeCommitArtifact,
  recoverWorktreeCommitArtifact,
  runBudgetedContainedValidation,
  runContainedValidation,
  verifyWorktreeCommitArtifact,
  WorktreeCommitArtifactError,
} from "../dist/core/worktree-commit-artifact.js";
import { WorktreeLifecycle, WorktreeLifecycleError } from "../dist/core/worktree-lifecycle.js";
import type { ParallelDispatchDescriptor, WorktreeCommitArtifact, WorktreeParallelTask } from "../src/core/types.ts";

function run(executable: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((done, reject) => {
    execFile(executable, args, { cwd, shell: false, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error === null) done(stdout);
      else reject(new Error("Fixture command failed."));
    });
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return run("git", args, cwd);
}

type Fixture = {
  root: string;
  repository: string;
  lifecycle: WorktreeLifecycle;
  worktreeId: string;
  path: string;
  base: string;
  branch: string;
  descriptor: ParallelDispatchDescriptor;
};

async function fixture(name: string, scope = ["src"]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `sortie-artifact-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "value.txt"), "base\n");
  await writeFile(join(repository, ".gitignore"), "ignored/\n");
  await git(repository, "init", "-q");
  await git(repository, "config", "user.name", "Sortie Test");
  await git(repository, "config", "user.email", "sortie@example.invalid");
  await git(repository, "add", ".gitignore", "src/value.txt");
  await git(repository, "commit", "-q", "-m", "base");
  const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: repository });
  const pin = await lifecycle.pinCleanBase();
  const worktreeId = `worker-${name}`;
  const branch = `sortie/${name}`;
  const task = (id: string, index: number): WorktreeParallelTask => ({
    task_id: `task-${name}-${index}`,
    worktree: id,
    branch: index === 0 ? branch : `sortie/${name}-other`,
    base_sha: pin.sha,
    depends_on: [],
    scope: { read: [], write: index === 0 ? scope : ["other"] },
  });
  const created = await lifecycle.createMany({ pin, tasks: [task(worktreeId, 0), task(`other-${name}`, 1)] });
  const path = created[0]!.path;
  const descriptor: ParallelDispatchDescriptor = Object.freeze({
    run_id: randomUUID(),
    dispatch_id: randomUUID(),
    task_id: `task-${name}-0`,
    managed_path: path,
    branch,
    base_sha: pin.sha,
    depends_on: Object.freeze([]),
    scope_read: Object.freeze([]),
    scope_write: Object.freeze(scope),
    parallel_group: "placeholder",
    parallel_unit: `task-${name}-0`,
    parallel_units: 2,
    attempt: 1,
    contract_fingerprint: "a".repeat(64),
  });
  const exactDescriptor = Object.freeze({ ...descriptor, parallel_group: descriptor.run_id });
  return { root, repository, lifecycle, worktreeId, path, base: pin.sha, branch, descriptor: exactDescriptor };
}

const validation = (): { executable: string; args: string[]; timeout_ms: number } => ({
  executable: process.execPath,
  args: ["-e", "process.exit(0)"],
  timeout_ms: 5_000,
});

async function artifactError(operation: Promise<unknown>, code: string): Promise<Error> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  assert.equal(caught instanceof WorktreeCommitArtifactError && caught.code === code, true,
    caught instanceof WorktreeCommitArtifactError ? caught.code : String(caught));
  assert.doesNotMatch(String((caught as Error).message), /raw-secret|fatal:|diff --git/iu);
  return caught as Error;
}

async function removeFixture(value: Fixture): Promise<void> {
  await rm(value.root, { recursive: true, force: true });
}

async function assertProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail("Descendant process remained alive.");
}

test("produces frozen evidence, reverifies it, accepts lifecycle commit, and cleans up", async () => {
  const value = await fixture("valid");
  try {
    await git(value.repository, "config", "--unset", "user.name");
    await git(value.repository, "config", "--unset", "user.email");
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: value.descriptor, managed_path: value.path, validation: validation(),
    });
    assert.equal(Object.isFrozen(artifact), true);
    assert.equal(Object.isFrozen(artifact.changed_paths), true);
    assert.equal(Object.isFrozen(artifact.validation), true);
    assert.equal(Object.isFrozen(artifact.validation.command), true);
    assert.deepEqual(artifact.changed_paths, ["src/value.txt"]);
    assert.equal(artifact.branch, value.branch);
    assert.equal(artifact.validation.exit_code, 0);
    assert.match(artifact.change_fingerprint, /^[0-9a-f]{64}$/u);
    assert.match(artifact.validation.validation_fingerprint, /^[0-9a-f]{64}$/u);
    assert.equal("stdout" in artifact.validation || "stderr" in artifact.validation, false);
    assert.equal((await git(value.path, "log", "-1", "--format=%an <%ae>")).trim(),
      "Sortie Fabric <sortie@example.invalid>");
    const verified = await verifyWorktreeCommitArtifact({
      descriptor: value.descriptor, managed_path: value.path, artifact,
    });
    assert.deepEqual(verified, artifact);
    await value.lifecycle.acceptCommit(value.worktreeId, value.path, value.base, artifact.commit_sha, value.branch);
    await value.lifecycle.acceptCommit(value.worktreeId, value.path, value.base, artifact.commit_sha, value.branch);
    await value.lifecycle.cleanup(value.worktreeId);
    await value.lifecycle.cleanup(`other-valid`);
  } finally {
    await removeFixture(value);
  }
});

test("budgeted validation reuses valid SKIP evidence without spawning and records measured duration", async () => {
  let settled = false;
  const reused = Object.freeze({ ok: true as const, command: Object.freeze([process.execPath, "prior"]),
    exit_code: 0 as const, fingerprint: "passed-fingerprint", error: null });
  const skipped = await runBudgetedContainedValidation({ executable: process.execPath, args: ["-e", "process.exit(41)"], cwd: process.cwd(), timeout_ms: 5_000 }, {
    request: {} as never,
    reserve: async () => ({ decision: "SKIP" as const, reservation_id: null, reason: "duplicate-evidence", reused }),
    settle: async () => { settled = true; },
  });
  assert.equal(skipped, reused);
  assert.equal(settled, false);

  const unsupported = await runBudgetedContainedValidation({ executable: process.execPath, cwd: process.cwd(), timeout_ms: 5_000 }, {
    request: {} as never,
    reserve: async () => ({ decision: "SKIP" as const, reservation_id: null, reason: "duplicate-evidence" }),
    settle: async () => { settled = true; },
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, "invalid-request");

  let duration: number | undefined;
  const passed = await runBudgetedContainedValidation({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 20)"], cwd: process.cwd(), timeout_ms: 5_000 }, {
    request: {} as never,
    reserve: async () => ({ decision: "ALLOW" as const, reservation_id: "reservation", reason: "allowed" }),
    settle: async (_outcome, _exitCode, measured) => { duration = measured; },
  });
  assert.equal(passed.ok, true);
  assert.equal(passed.exit_code, 0);
  assert.equal(Number.isSafeInteger(duration) && duration! >= 0, true);
});

test("artifact settled-pass reuse skips process launch and settlement while preserving artifact invariants", async () => {
  const value = await fixture("reuse-passed");
  try {
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    const marker = join(value.root, "validator-ran.txt");
    let afterValidation = false;
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: value.descriptor,
      managed_path: value.path,
      validation: { executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker], timeout_ms: 5_000 },
    }, {
      signal: new AbortController().signal,
      enterProtectedPhase: () => undefined,
      beforeValidation: async () => ({ decision: "reuse-passed" }),
      afterValidation: async () => { afterValidation = true; },
    });
    assert.equal(await stat(marker).catch(() => undefined), undefined);
    assert.equal(afterValidation, false);
    assert.deepEqual(artifact.validation.command, [process.execPath,
      "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker]);
    assert.deepEqual(await verifyWorktreeCommitArtifact({ descriptor: value.descriptor,
      managed_path: value.path, artifact }), artifact);
  } finally {
    await removeFixture(value);
  }
});

test("recovers only the exact clean generated direct-child commit", async (t) => {
  await t.test("same request", async () => {
    const value = await fixture("recover-valid");
    try {
      assert.equal(await recoverWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, validation: validation(),
      }), undefined);
      await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
      const original = await produceWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, validation: validation(),
      });
      await writeFile(join(value.path, `handoff.${value.descriptor.task_id}.json`), "{}\n");
      await writeFile(join(value.path, `${value.descriptor.task_id}.operation-manifest.json`), "{}\n");
      const message = await git(value.path, "log", "-1", "--format=%B");
      assert.match(message, /^sortie: task-recover-valid-0 \[validation:[0-9a-f]{24}\]\n\n$/u);
      assert.doesNotMatch(message, /process\.exit|node|-[eE]/u);
      const recovered = await recoverWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, validation: validation(),
      });
      assert.deepEqual(recovered, original);
      assert.equal(Object.isFrozen(recovered), true);
      assert.deepEqual(await verifyWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, artifact: recovered!,
      }), original);
      await artifactError(recoverWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path,
        validation: { executable: process.execPath, args: ["-e", "process.exit(1)"], timeout_ms: 5_000 },
      }), "verification-failed");
    } finally { await removeFixture(value); }
  });
  for (const kind of ["dirty", "message", "divergent"] as const) await t.test(kind, async () => {
    const value = await fixture(`recover-${kind}`);
    try {
      if (kind === "dirty") {
        await writeFile(join(value.path, "src", "value.txt"), "committed\n");
        await git(value.path, "add", "--", "src/value.txt");
        await git(value.path, "commit", "-q", "-m", "wrong");
        await writeFile(join(value.path, "src", "value.txt"), "dirty\n");
        await artifactError(recoverWorktreeCommitArtifact({
          descriptor: value.descriptor, managed_path: value.path, validation: validation(),
        }), "invalid-state");
        return;
      }
      await writeFile(join(value.path, "src", "value.txt"), "first\n");
      await git(value.path, "add", "--", "src/value.txt");
      await git(value.path, "commit", "-q", "-m", kind === "message" ? "wrong" : "first");
      if (kind === "divergent") {
        await writeFile(join(value.path, "src", "value.txt"), "second\n");
        await git(value.path, "add", "--", "src/value.txt");
        await git(value.path, "commit", "-q", "-m", "second");
      }
      await artifactError(recoverWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, validation: validation(),
      }), "verification-failed");
    } finally { await removeFixture(value); }
  });
});

test("accepts scoped additions and rejects empty, staged, and out-of-scope worker states", async (t) => {
  await t.test("empty", async () => {
    const value = await fixture("empty");
    try {
      await artifactError(produceWorktreeCommitArtifact({ descriptor: value.descriptor, managed_path: value.path, validation: validation() }), "invalid-state");
    } finally { await removeFixture(value); }
  });
  await t.test("staged", async () => {
    const value = await fixture("staged");
    try {
      await writeFile(join(value.path, "src", "value.txt"), "staged\n");
      await git(value.path, "add", "--", "src/value.txt");
      await artifactError(produceWorktreeCommitArtifact({ descriptor: value.descriptor, managed_path: value.path, validation: validation() }), "invalid-state");
    } finally { await removeFixture(value); }
  });
  await t.test("scoped addition", async () => {
    const value = await fixture("addition");
    try {
      await writeFile(join(value.path, "src", "new.txt"), "new\n");
      const artifact = await produceWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, validation: validation(),
      });
      assert.deepEqual(artifact.changed_paths, ["src/new.txt"]);
      assert.equal((await git(value.path, "show", `${artifact.commit_sha}:src/new.txt`)), "new\n");
      assert.deepEqual(await verifyWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, artifact,
      }), artifact);
    } finally { await removeFixture(value); }
  });
  await t.test("outside", async () => {
    const value = await fixture("outside", ["other"]);
    try {
      await writeFile(join(value.path, "src", "value.txt"), "outside\n");
      await artifactError(produceWorktreeCommitArtifact({ descriptor: value.descriptor, managed_path: value.path, validation: validation() }), "invalid-state");
    } finally { await removeFixture(value); }
  });
  await t.test("outside untracked", async () => {
    const value = await fixture("outside-untracked", ["other"]);
    try {
      await writeFile(join(value.path, "src", "new.txt"), "outside\n");
      await artifactError(produceWorktreeCommitArtifact({ descriptor: value.descriptor, managed_path: value.path, validation: validation() }), "invalid-state");
    } finally { await removeFixture(value); }
  });
});

test("validation-time drift of a scoped new file is rejected", async () => {
  const value = await fixture("addition-drift");
  try {
    const added = join(value.path, "src", "new.txt");
    await writeFile(added, "before\n");
    await artifactError(produceWorktreeCommitArtifact({
      descriptor: value.descriptor,
      managed_path: value.path,
      validation: { executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'after\\n')", added], timeout_ms: 5_000 },
    }), "validation-failed");
    assert.equal(await readFile(added, "utf8"), "after\n");
    assert.equal((await git(value.path, "rev-parse", "HEAD")).trim(), value.base);
  } finally { await removeFixture(value); }
});

test("protected commit rejects index drift after validation", async () => {
  const value = await fixture("protected-index-drift");
  try {
    const path = join(value.path, "src", "value.txt");
    await writeFile(path, "validated\n");
    await artifactError(produceWorktreeCommitArtifact({
      descriptor: value.descriptor, managed_path: value.path, validation: validation(),
    }, {
      signal: new AbortController().signal,
      enterProtectedPhase: () => { writeFileSync(path, "changed before staging\n"); },
    }), "invalid-state");
    assert.equal((await git(value.path, "rev-parse", "HEAD")).trim(), value.base);
  } finally { await removeFixture(value); }
});

test("fingerprint base query is shared locally while validation and verify stay fresh", async () => {
  const value = await fixture("fingerprint-base-query");
  const originalSpawn = ChildProcess.prototype.spawn;
  let treeQueries = 0;
  let baseQueries = 0;
  ChildProcess.prototype.spawn = function observedSpawn(options): boolean {
    const args = Array.isArray(options.args) ? options.args : [];
    const commandIndex = args.indexOf("ls-tree");
    if (commandIndex >= 0) {
      treeQueries += 1;
      if (args[commandIndex + 3] === value.base) baseQueries += 1;
    }
    return originalSpawn.call(this, options);
  };
  try {
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: value.descriptor, managed_path: value.path, validation: validation(),
    });
    assert.equal(treeQueries, 5);
    assert.equal(baseQueries, 4);
    const fingerprint = artifact.change_fingerprint;
    const verified = await verifyWorktreeCommitArtifact({
      descriptor: value.descriptor, managed_path: value.path, artifact,
    });
    assert.equal(verified.change_fingerprint, fingerprint);
    assert.equal(treeQueries, 7);
    assert.equal(baseQueries, 5);
  } finally {
    ChildProcess.prototype.spawn = originalSpawn;
    await removeFixture(value);
  }
});

test("branch and head identity uses one exact Git process", async () => {
  const value = await fixture("branch-head-process");
  const originalSpawn = ChildProcess.prototype.spawn;
  let combinedQueries = 0;
  let symbolicQueries = 0;
  ChildProcess.prototype.spawn = function observedSpawn(options): boolean {
    const args = Array.isArray(options.args) ? options.args : [];
    const commandIndex = args.indexOf("rev-parse");
    if (commandIndex >= 0 && args.slice(commandIndex, commandIndex + 4).join("\0") ===
      "rev-parse\0HEAD^{commit}\0--symbolic-full-name\0HEAD") combinedQueries += 1;
    if (args.includes("symbolic-ref")) symbolicQueries += 1;
    return originalSpawn.call(this, options);
  };
  try {
    assert.equal(await recoverWorktreeCommitArtifact({
      descriptor: value.descriptor, managed_path: value.path, validation: validation(),
    }), undefined);
    assert.equal(combinedQueries, 1);
    assert.equal(symbolicQueries, 0);
  } finally {
    ChildProcess.prototype.spawn = originalSpawn;
    await removeFixture(value);
  }
});

test("branch and head identity rejects detached and malformed Git output", async (t) => {
  await t.test("detached", async () => {
    const value = await fixture("branch-head-detached");
    try {
      await git(value.path, "checkout", "--detach", "-q");
      await artifactError(recoverWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, validation: validation(),
      }), "invalid-state");
    } finally { await removeFixture(value); }
  });

  const malformed = [
    { name: "missing", command: ["rev-parse", "HEAD"] },
    { name: "extra", command: ["rev-parse", "HEAD", "HEAD", "HEAD"] },
    { name: "invalid", command: ["rev-parse", "HEAD", "HEAD"] },
    { name: "empty", command: ["for-each-ref", "--format=", "--count=1"] },
  ] as const;
  for (const item of malformed) await t.test(item.name, async () => {
    const value = await fixture(`branch-head-${item.name}`);
    const originalSpawn = ChildProcess.prototype.spawn;
    ChildProcess.prototype.spawn = function malformedSpawn(options): boolean {
      const args = Array.isArray(options.args) ? options.args : [];
      const commandIndex = args.indexOf("rev-parse");
      if (commandIndex >= 0 && args.slice(commandIndex, commandIndex + 4).join("\0") ===
        "rev-parse\0HEAD^{commit}\0--symbolic-full-name\0HEAD") {
        args.splice(commandIndex, 4, ...item.command);
      }
      return originalSpawn.call(this, options);
    };
    try {
      await artifactError(recoverWorktreeCommitArtifact({
        descriptor: value.descriptor, managed_path: value.path, validation: validation(),
      }), "invalid-state");
    } finally {
      ChildProcess.prototype.spawn = originalSpawn;
      await removeFixture(value);
    }
  });
});

test("Linux systemd fallback preserves timeout evidence and a clean validation environment", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux-only fallback evidence");
  const timeout = await runContainedValidation({
    cwd: process.cwd(), executable: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"], timeout_ms: 100,
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.exit_code, 238);

  const value = await fixture("clean-environment");
  process.env.SORTIE_VALIDATION_SECRET = "must-not-leak";
  try {
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: value.descriptor,
      managed_path: value.path,
      validation: {
        executable: process.execPath,
        args: ["-e", "process.exit(process.env.SORTIE_VALIDATION_SECRET === undefined ? 0 : 1)"],
        timeout_ms: 5_000,
      },
    });
    assert.equal(artifact.validation.exit_code, 0);
  } finally {
    delete process.env.SORTIE_VALIDATION_SECRET;
    await removeFixture(value);
  }
});

test("validation failures retain edits and never disclose output", async (t) => {
  await t.test("nonzero", async () => {
    const value = await fixture("nonzero");
    try {
      await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
      await artifactError(produceWorktreeCommitArtifact({
        descriptor: value.descriptor,
        managed_path: value.path,
        validation: { executable: process.execPath, args: ["-e", "console.error('raw-secret');process.exit(7)"], timeout_ms: 5_000 },
      }), "validation-failed");
      assert.equal((await git(value.path, "rev-parse", "HEAD")).trim(), value.base);
      assert.match(await git(value.path, "status", "--porcelain"), /src\/value\.txt/u);
    } finally { await removeFixture(value); }
  });
  await t.test("timeout", async () => {
    const value = await fixture("timeout");
    try {
      await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
      const pidFile = join(value.root, "descendant.pid");
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });",
        "if (process.platform !== 'linux') writeFileSync(process.argv[1], String(child.pid));",
        "else { const match = /^NSpid:\\s+([0-9]+)\\s+[0-9]+/mu.exec(readFileSync('/proc/' + child.pid + '/status', 'utf8')); if (match) writeFileSync(process.argv[1], match[1]); }",
        "setInterval(()=>{},1000);",
      ].join("");
      await artifactError(produceWorktreeCommitArtifact({
        descriptor: value.descriptor,
        managed_path: value.path,
        validation: { executable: process.execPath, args: ["-e", script, pidFile], timeout_ms: 250 },
      }), "validation-failed");
      assert.equal((await git(value.path, "rev-parse", "HEAD")).trim(), value.base);
      const recorded = await readFile(pidFile, "utf8").catch(() => undefined);
      if (recorded !== undefined) await assertProcessGone(Number.parseInt(recorded, 10));
    } finally { await removeFixture(value); }
  });
  await t.test("successful parent cannot leave a SIGTERM-ignoring descendant", async () => {
    const value = await fixture("descendant");
    try {
      await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
      const pidFile = join(value.root, "descendant.pid");
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore', detached: true });",
        "if (process.platform !== 'linux') writeFileSync(process.argv[1], String(child.pid));",
        "else { const match = /^NSpid:\\s+([0-9]+)/mu.exec(readFileSync('/proc/' + child.pid + '/status', 'utf8')); if (match) writeFileSync(process.argv[1], match[1]); }",
      ].join("");
      await artifactError(produceWorktreeCommitArtifact({
        descriptor: value.descriptor,
        managed_path: value.path,
        validation: { executable: process.execPath, args: ["-e", script, pidFile], timeout_ms: 5_000 },
      }), "validation-failed");
      await assertProcessGone(Number.parseInt(await readFile(pidFile, "utf8"), 10));
    } finally { await removeFixture(value); }
  });
});

test("host cancellation stops contained validation before the protected commit phase", async () => {
  const value = await fixture("host-cancel");
  const controller = new AbortController();
  let protectedEntries = 0;
  try {
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    const production = produceWorktreeCommitArtifact({
      descriptor: value.descriptor,
      managed_path: value.path,
      validation: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeout_ms: 60_000 },
    }, { signal: controller.signal, enterProtectedPhase: () => { protectedEntries += 1; } });
    setTimeout(() => controller.abort(), 100).unref();
    await artifactError(production, "validation-failed");
    assert.equal(protectedEntries, 0);
    assert.equal((await git(value.path, "rev-parse", "HEAD")).trim(), value.base);
    assert.match(await git(value.path, "status", "--porcelain"), /src\/value\.txt/u);
  } finally { await removeFixture(value); }
});

test("cancellation after the protected boundary cannot rewrite a successful artifact", async () => {
  const value = await fixture("protected-success");
  const controller = new AbortController();
  let protectedEntries = 0;
  try {
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: value.descriptor, managed_path: value.path, validation: validation(),
    }, { signal: controller.signal, enterProtectedPhase: () => { protectedEntries += 1; controller.abort(); } });
    assert.equal(protectedEntries, 1);
    assert.notEqual(artifact.commit_sha, value.base);
    assert.equal(artifact.validation.exit_code, 0);
  } finally { await removeFixture(value); }
});

test("validation evidence accepts exactly 129 bounded command items and rejects oversized text", async (t) => {
  await t.test("boundary", async () => {
    const value = await fixture("command-boundary");
    try {
      await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
      const args = ["-e", "process.exit(0)", ...Array<string>(126).fill("x")];
      const artifact = await produceWorktreeCommitArtifact({
        descriptor: value.descriptor,
        managed_path: value.path,
        validation: { executable: process.execPath, args, timeout_ms: 5_000 },
      });
      assert.equal(artifact.validation.command.length, 129);
      assert.equal(Math.max(...artifact.validation.command.map((item) => item.length)) <= 1000, true);
    } finally { await removeFixture(value); }
  });
  await t.test("oversized item", async () => {
    const value = await fixture("command-oversized");
    try {
      await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
      await artifactError(produceWorktreeCommitArtifact({
        descriptor: value.descriptor,
        managed_path: value.path,
        validation: { executable: process.execPath, args: ["x".repeat(1001)], timeout_ms: 5_000 },
      }), "invalid-request");
    } finally { await removeFixture(value); }
  });
});

test("reverify detects artifact field tampering and postcommit dirt", async () => {
  const value = await fixture("tamper");
  try {
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    const artifact = await produceWorktreeCommitArtifact({ descriptor: value.descriptor, managed_path: value.path, validation: validation() });
    const cases: WorktreeCommitArtifact[] = [
      { ...artifact, branch: "sortie/forged" },
      { ...artifact, commit_sha: value.base },
      { ...artifact, change_fingerprint: "0".repeat(64) },
      { ...artifact, changed_paths: ["src/forged.txt"] },
      { ...artifact, validation: { ...artifact.validation, validation_fingerprint: "0".repeat(64) } },
      { ...artifact, validation: { ...artifact.validation, command: [resolve(process.execPath), "--forged"] } },
    ];
    for (const candidate of cases) {
      await artifactError(verifyWorktreeCommitArtifact({ descriptor: value.descriptor, managed_path: value.path, artifact: candidate }), "verification-failed");
    }
    await writeFile(join(value.path, "src", "value.txt"), "dirty\n");
    await artifactError(verifyWorktreeCommitArtifact({ descriptor: value.descriptor, managed_path: value.path, artifact }), "verification-failed");
  } finally { await removeFixture(value); }
});

test("branch, head, base, and lifecycle direct-child mismatches fail closed", async () => {
  const value = await fixture("identity");
  try {
    await writeFile(join(value.path, "src", "value.txt"), "implemented\n");
    await artifactError(produceWorktreeCommitArtifact({
      descriptor: { ...value.descriptor, branch: "sortie/wrong" }, managed_path: value.path, validation: validation(),
    }), "invalid-state");
    await artifactError(produceWorktreeCommitArtifact({
      descriptor: { ...value.descriptor, base_sha: "0".repeat(40) }, managed_path: value.path, validation: validation(),
    }), "invalid-state");
    await assert.rejects(value.lifecycle.acceptCommit(value.worktreeId, value.path, value.base, value.base, value.branch),
      (error: unknown) => error instanceof WorktreeLifecycleError && error.code === "invalid-request");
    await git(value.path, "add", "--", "src/value.txt");
    await git(value.path, "commit", "-q", "-m", "child");
    await writeFile(join(value.path, "src", "value.txt"), "grandchild\n");
    await git(value.path, "add", "--", "src/value.txt");
    await git(value.path, "commit", "-q", "-m", "grandchild");
    const grandchild = (await git(value.path, "rev-parse", "HEAD")).trim();
    await assert.rejects(value.lifecycle.acceptCommit(value.worktreeId, value.path, value.base, grandchild, value.branch),
      (error: unknown) => error instanceof WorktreeLifecycleError && error.code === "unsafe-cleanup");
    assert.equal(await realpath(value.path), value.path);
  } finally { await removeFixture(value); }
});
