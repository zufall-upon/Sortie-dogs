import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IntegrationQueueError,
  WorktreeIntegrationQueue,
} from "../dist/core/worktree-integration-queue.js";
import { WorktreeLifecycle } from "../dist/core/worktree-lifecycle.js";
import type { ParallelDispatchArchive, WorktreeCommitArtifact, WorktreeParallelTask } from "../src/core/types.ts";

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => execFile("git", args, {
    cwd, shell: false, windowsHide: true, encoding: "utf8",
  }, (error, stdout, stderr) => error === null ? resolvePromise(stdout) : reject(new Error(stderr))));
}

function findExecutable(name: string): Promise<string> {
  return new Promise((resolvePromise, reject) => execFile(process.platform === "win32" ? "where.exe" : "which", [name], {
    shell: false, windowsHide: true, encoding: "utf8",
  }, (error, stdout, stderr) => error === null ? resolvePromise(stdout.split(/\r?\n/u)[0]!) : reject(new Error(stderr))));
}

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `sortie-integration-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await git(repository, "init", "-q", "-b", "main");
  await git(repository, "config", "user.name", "Sortie Test");
  await git(repository, "config", "user.email", "sortie@example.invalid");
  await writeFile(join(repository, "shared.txt"), "base\n");
  await git(repository, "add", "shared.txt");
  await git(repository, "commit", "-q", "-m", "base");
  const base = (await git(repository, "rev-parse", "HEAD")).trim();
  await git(repository, "branch", "target", base);
  await git(repository, "switch", "-q", "-c", "controller");
  return { root, repository, base };
}

async function artifact(repository: string, base: string, id: string, path: string, content: string,
  command: readonly string[] = [process.execPath]): Promise<WorktreeCommitArtifact> {
  await git(repository, "switch", "-q", "-C", `artifact-${id}`, base);
  await writeFile(join(repository, path), content);
  await git(repository, "add", path);
  await git(repository, "commit", "-q", "-m", `artifact ${id}`);
  const commit = (await git(repository, "rev-parse", "HEAD")).trim();
  await git(repository, "switch", "-q", "controller");
  return {
    task_id: id, base_sha: base, commit_sha: commit, branch: `sortie/${id}`,
    changed_paths: [path], change_fingerprint: "a".repeat(64),
    validation: { command, exit_code: 0, validation_fingerprint: "b".repeat(64) },
  };
}

function archive(base: string, artifacts: readonly WorktreeCommitArtifact[], dependencies: Record<string, string[]> = {}, runID = "run-card06",
  managed: ReadonlySet<string> = new Set()): ParallelDispatchArchive {
  return {
    run_id: runID, owner_root: "root", contract_fingerprint: "c".repeat(64), cancelled: false,
    terminal_reason: "completed",
    tasks: artifacts.map((value) => ({
      task_id: value.task_id, depends_on: dependencies[value.task_id] ?? [], worktree_id: `worktree-${value.task_id}`,
      managed_path: managed.has(value.task_id) ? `managed-${value.task_id}` : null, branch: value.branch, base_sha: base, dispatch_id: `dispatch-${value.task_id}`,
      phase: "completed", call_id: null, child_session_id: null, outcome: "completed", artifact: value,
    })),
  };
}

function sourceRef(runID: string, taskID: string): string {
  const short = (value: string) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return `refs/sortie-dogs/integration-queue/${short(runID)}/${short(taskID)}`;
}

async function code(operation: Promise<unknown>, expected: IntegrationQueueError["code"]): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof IntegrationQueueError && error.code === expected);
}

async function prepareAccept(queue: WorktreeIntegrationQueue, runID: string) {
  const prepared = await queue.prepare("root", runID);
  assert.equal(prepared.phase, "prepared");
  return queue.accept("root", runID, {
    candidate_head: prepared.candidate_head!, review: "pass", review_fingerprint: "d".repeat(64),
  });
}

async function assertNoValidationWorktree(repository: string): Promise<void> {
  assert.doesNotMatch(await git(repository, "worktree", "list", "--porcelain"), /integration-queue-v2[\\/]validation-/u);
}

test("plumbing integrates deterministic topo order with atomic target update and clean checkout", async () => {
  const value = await fixture("success");
  try {
    const command = process.platform === "win32"
      ? [process.execPath]
      : [await findExecutable("git"), "diff", "--check"];
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n", command);
    const b = await artifact(value.repository, value.base, "b", "b.txt", "b\n", command);
    const c = await artifact(value.repository, value.base, "c", "c.txt", "c\n", command);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    const queued = await queue.enqueue("root", archive(value.base, [c, b, a], { b: ["a"] }));
    assert.deepEqual(queued.tasks.map(({ task_id }) => task_id), ["a", "c", "b"]);
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
    const prepared = await queue.prepare("root", "run-card06");
    assert.equal(prepared.phase, "prepared");
    assert.equal(prepared.validation.status, "pass");
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
    const accepted = await queue.accept("root", "run-card06", {
      candidate_head: prepared.candidate_head!, review: "pass", review_fingerprint: "d".repeat(64),
    });
    assert.equal(accepted.phase, "integrated");
    assert.equal((await git(value.repository, "rev-list", "--count", `${value.base}..target`)).trim(), "3");
    assert.match(await git(value.repository, "show", "target:a.txt"), /a/u);
    assert.match(await git(value.repository, "show", "target:b.txt"), /b/u);
    assert.match(await git(value.repository, "show", "target:c.txt"), /c/u);
    assert.equal(await git(value.repository, "status", "--porcelain"), "");
    assert.equal((await git(value.repository, "symbolic-ref", "--short", "HEAD")).trim(), "controller");
    assert.equal((await queue.accept("root", "run-card06", {
      candidate_head: accepted.candidate_head!, review: "pass", review_fingerprint: "d".repeat(64),
    })).candidate_head, accepted.candidate_head);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("conflict requests one bounded remediation and retains target", async () => {
  const value = await fixture("conflict");
  try {
    const a = await artifact(value.repository, value.base, "a", "shared.txt", "artifact-a\n");
    const b = await artifact(value.repository, value.base, "b", "shared.txt", "artifact-b\n");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a, b]));
    const stopped = await queue.prepare("root", "run-card06");
    assert.equal(stopped.phase, "remediation-required");
    assert.deepEqual(stopped.blocker?.conflict_paths, ["shared.txt"]);
    assert.equal(stopped.blocker?.task_id, "b");
    assert.deepEqual(stopped.blocker?.causal_task_ids, ["a"]);
    assert.equal(stopped.blocker?.attempts_remaining, 1);
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
    assert.equal((await queue.snapshot("root", "run-card06"))!.failure_code, "merge-conflict");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("canonical validation command mismatch fails closed without moving target", async () => {
  const value = await fixture("command-mismatch");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const b = await artifact(value.repository, value.base, "b", "b.txt", "b\n",
      [process.execPath, "-e", "process.exit(0)"]);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    const queued = await queue.enqueue("root", archive(value.base, [a, b], {}, "run-command-mismatch"));
    assert.equal(queued.phase, "failed");
    assert.equal(queued.failure_code, "validation-failed");
    assert.equal(queued.blocker?.code, "validation-failed");
    await code(queue.prepare("root", "run-command-mismatch"), "validation-failed");
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("combined validation nonzero persists failure evidence and removes its temporary worktree", async () => {
  const value = await fixture("validation-fail");
  try {
    const command = [process.execPath, "-e", "process.exit(7)"];
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n", command);
    const b = await artifact(value.repository, value.base, "b", "b.txt", "b\n", command);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a, b], {}, "run-validation-fail"));
    const failed = await queue.prepare("root", "run-validation-fail");
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure_code, "validation-failed");
    assert.equal(failed.blocker?.code, "validation-failed");
    assert.equal(failed.validation.status, "fail");
    assert.notEqual(failed.validation.exit_code, 0);
    assert.match(failed.validation.fingerprint!, /^[0-9a-f]{64}$/u);
    assert.equal(failed.validation.candidate_head, failed.candidate_head);
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
    await assertNoValidationWorktree(value.repository);
    const reopened = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    const persisted = await reopened.snapshot("root", "run-validation-fail");
    assert.deepEqual(persisted?.validation, failed.validation);
    assert.deepEqual(persisted?.blocker, failed.blocker);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("line-start conflict markers fail before acceptance without moving target", async () => {
  const value = await fixture("conflict-markers");
  try {
    const content = "before\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\nafter\n";
    const a = await artifact(value.repository, value.base, "a", "markers.txt", content);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a], {}, "run-conflict-markers"));
    const failed = await queue.prepare("root", "run-conflict-markers");
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure_code, "validation-failed");
    assert.equal(failed.blocker?.code, "validation-failed");
    assert.equal(failed.validation.status, "fail");
    assert.equal(failed.validation.exit_code, null);
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
    await assertNoValidationWorktree(value.repository);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("review failure survives reopen with evidence and leaves target unchanged", async () => {
  const value = await fixture("review-fail");
  try {
    const reviewFingerprint = "e".repeat(64);
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a], {}, "run-review-fail"));
    const prepared = await queue.prepare("root", "run-review-fail");
    assert.equal(prepared.phase, "prepared");
    await assertNoValidationWorktree(value.repository);
    const failed = await queue.accept("root", "run-review-fail", {
      candidate_head: prepared.candidate_head!, review: "fail", review_fingerprint: reviewFingerprint,
    });
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure_code, "review-failed");
    assert.equal(failed.blocker?.code, "review-failed");
    assert.deepEqual(failed.review, {
      status: "fail", fingerprint: reviewFingerprint, candidate_head: prepared.candidate_head,
    });
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
    const reopened = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    const persisted = await reopened.snapshot("root", "run-review-fail");
    assert.deepEqual(persisted?.review, failed.review);
    assert.equal(persisted?.failure_code, "review-failed");
    assert.equal(persisted?.blocker?.code, "review-failed");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("one direct-child remediation integrates with original provenance", async () => {
  const value = await fixture("remediation-success");
  try {
    const a = await artifact(value.repository, value.base, "a", "shared.txt", "artifact-a\n");
    const b = await artifact(value.repository, value.base, "b", "shared.txt", "artifact-b\n");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a, b], {}, "run-remediation-success"));
    const stopped = await queue.prepare("root", "run-remediation-success");
    assert.equal(stopped.blocker?.task_id, "b");
    assert.deepEqual(stopped.blocker?.conflict_paths, ["shared.txt"]);
    assert.deepEqual(stopped.blocker?.causal_task_ids, ["a"]);
    const replacement = await artifact(value.repository, stopped.blocker!.candidate_base, "b", "shared.txt", "resolved\n");
    const resumed = await queue.submitRemediation("root", "run-remediation-success", replacement);
    assert.equal(resumed.phase, "queued");
    assert.equal(resumed.remediation_attempts_used, 1);
    const prepared = await queue.prepare("root", "run-remediation-success");
    assert.equal(prepared.phase, "prepared");
    await assertNoValidationWorktree(value.repository);
    const accepted = await queue.accept("root", "run-remediation-success", {
      candidate_head: prepared.candidate_head!, review: "pass", review_fingerprint: "f".repeat(64),
    });
    assert.equal(accepted.phase, "integrated");
    assert.equal(await git(value.repository, "show", "target:shared.txt"), "resolved\n");
    assert.equal(accepted.tasks.find(({ task_id }) => task_id === "b")?.original_source_commit, b.commit_sha);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a second remediation submission is exhausted and cannot move target", async () => {
  const value = await fixture("remediation-exhausted");
  try {
    const a = await artifact(value.repository, value.base, "a", "shared.txt", "artifact-a\n");
    const b = await artifact(value.repository, value.base, "b", "shared.txt", "artifact-b\n");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a, b], {}, "run-remediation-exhausted"));
    const stopped = await queue.prepare("root", "run-remediation-exhausted");
    const replacement = await artifact(value.repository, stopped.blocker!.candidate_base, "b", "shared.txt", "resolved\n");
    await queue.submitRemediation("root", "run-remediation-exhausted", replacement);
    await code(queue.submitRemediation("root", "run-remediation-exhausted", replacement), "remediation-exhausted");
    const persisted = await queue.snapshot("root", "run-remediation-exhausted");
    assert.equal(persisted?.phase, "queued");
    assert.equal(persisted?.remediation_attempts_used, 1);
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("duplicate, incomplete, stale-base and queue ownership reject", async () => {
  const value = await fixture("reject");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const duplicate = { ...a, task_id: "b", branch: "sortie/b" };
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await code(queue.enqueue("root", archive(value.base, [a, duplicate])), "duplicate-artifact");
    const incomplete = archive(value.base, [a]);
    incomplete.tasks[0] = { ...incomplete.tasks[0]!, phase: "failed" };
    await code(queue.enqueue("root", incomplete), "invalid-archive");
    await git(value.repository, "switch", "-q", "--orphan", "unrelated");
    await writeFile(join(value.repository, "other.txt"), "other\n");
    await git(value.repository, "add", "other.txt");
    await git(value.repository, "commit", "-q", "-m", "other");
    const otherBase = (await git(value.repository, "rev-parse", "HEAD")).trim();
    await git(value.repository, "switch", "-q", "controller");
    const stale = await artifact(value.repository, otherBase, "z", "z.txt", "z\n");
    await code(queue.enqueue("root", archive(otherBase, [stale])), "stale-base");
    await queue.enqueue("root", archive(value.base, [a]));
    await code(queue.enqueue("other", { ...archive(value.base, [a]), owner_root: "other" }), "queue-owned");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("target movement before CAS rejects without overwrite", async () => {
  const value = await fixture("stale-target");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a]));
    const prepared = await queue.prepare("root", "run-card06");
    await git(value.repository, "switch", "-q", "target");
    await writeFile(join(value.repository, "target.txt"), "moved\n");
    await git(value.repository, "add", "target.txt");
    await git(value.repository, "commit", "-q", "-m", "move target");
    const moved = (await git(value.repository, "rev-parse", "HEAD")).trim();
    await git(value.repository, "switch", "-q", "controller");
    const stopped = await queue.accept("root", "run-card06", {
      candidate_head: prepared.candidate_head!, review: "pass", review_fingerprint: "d".repeat(64),
    });
    assert.equal(stopped.phase, "failed");
    assert.equal(stopped.failure_code, "stale-target");
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), moved);
    const reopened = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    assert.equal((await reopened.snapshot("root", "run-card06"))!.failure_code, "stale-target");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("target movement after enqueue persists stale failure before prepare", async () => {
  const value = await fixture("stale-before-prepare");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a]));
    await git(value.repository, "switch", "-q", "target");
    await writeFile(join(value.repository, "moved.txt"), "moved\n");
    await git(value.repository, "add", "moved.txt");
    await git(value.repository, "commit", "-q", "-m", "move before prepare");
    await git(value.repository, "switch", "-q", "controller");
    const stopped = await queue.prepare("root", "run-card06");
    assert.equal(stopped.failure_code, "stale-target");
    const reopened = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    assert.equal((await reopened.snapshot("root", "run-card06"))!.phase, "failed");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("concurrent enqueue is serialized and restart is idempotent", async () => {
  const value = await fixture("concurrent");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const input = archive(value.base, [a]);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    const results = await Promise.all([queue.enqueue("root", input), queue.enqueue("root", input)]);
    assert.deepEqual(results[0], results[1]);
    const accepted = await prepareAccept(queue, "run-card06");
    const restarted = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    const resumed = await restarted.accept("root", "run-card06", {
      candidate_head: accepted.candidate_head!, review: "pass", review_fingerprint: "d".repeat(64),
    });
    assert.equal(resumed.candidate_head, accepted.candidate_head);
    assert.equal((await git(value.repository, "rev-list", "--count", `${value.base}..target`)).trim(), "1");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("completed queue archives and releases its slot for a subsequent run", async () => {
  const value = await fixture("sequential");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    const first = await prepareAccept(queue, (await queue.enqueue("root", archive(value.base, [a], {}, "run-one"))).run_id);
    const nextBase = first.candidate_head!;
    const b = await artifact(value.repository, nextBase, "b", "b.txt", "b\n");
    await queue.enqueue("root", archive(nextBase, [b], {}, "run-two"));
    const second = await prepareAccept(queue, "run-two");
    assert.equal(second.phase, "integrated");
    assert.equal((await queue.snapshot("root", "run-one"))!.candidate_head, first.candidate_head);
    await code(queue.snapshot("other", "run-one"), "queue-owned");
    assert.equal((await queue.enqueue("root", archive(value.base, [a], {}, "run-one"))).candidate_head, first.candidate_head);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("source refs adopt exact artifacts and reject conflicting artifacts", async () => {
  const exact = await fixture("source-exact");
  try {
    const a = await artifact(exact.repository, exact.base, "a", "a.txt", "a\n");
    await git(exact.repository, "update-ref", sourceRef("run-card06", "a"), a.commit_sha);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: exact.repository, targetBranch: "target" });
    assert.equal((await queue.enqueue("root", archive(exact.base, [a]))).tasks[0]!.source_commit, a.commit_sha);
  } finally { await rm(exact.root, { recursive: true, force: true }); }

  const conflict = await fixture("source-conflict");
  try {
    const a = await artifact(conflict.repository, conflict.base, "a", "a.txt", "a\n");
    const other = await artifact(conflict.repository, conflict.base, "other", "other.txt", "other\n");
    await git(conflict.repository, "update-ref", sourceRef("run-card06", "a"), other.commit_sha);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: conflict.repository, targetBranch: "target" });
    await code(queue.enqueue("root", archive(conflict.base, [a])), "corrupt-state");
  } finally { await rm(conflict.root, { recursive: true, force: true }); }
});

test("linked worktree target checkout rejects without moving target", async () => {
  const value = await fixture("linked-target");
  const linked = join(value.root, "linked-target");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    await git(value.repository, "worktree", "add", "-q", linked, "target");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await code(queue.enqueue("root", archive(value.base, [a])), "target-checked-out");
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
  } finally {
    await git(value.repository, "worktree", "remove", linked).catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
});

test("primary target checkout rejects without moving target", async () => {
  const value = await fixture("primary-target");
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    await git(value.repository, "switch", "-q", "target");
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await code(queue.enqueue("root", archive(value.base, [a])), "target-checked-out");
    assert.equal((await git(value.repository, "rev-parse", "target")).trim(), value.base);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("cleanup reconciles lifecycle-complete worktrees after queue-save crash", async () => {
  const value = await fixture("cleanup-recovery");
  const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
  const originalCleanup = WorktreeIntegrationQueue.prototype.cleanup;
  try {
    const a = await artifact(value.repository, value.base, "a", "a.txt", "a\n");
    const b = await artifact(value.repository, value.base, "b", "b.txt", "b\n");
    const pin = await lifecycle.pinCleanBase();
    const managedTasks: WorktreeParallelTask[] = ["a", "b"].map((id) => ({
      task_id: `managed-${id}`, worktree: `worktree-${id}`, branch: `sortie/managed-${id}`,
      base_sha: pin.sha, depends_on: [], scope: { read: [], write: [`${id}.txt`] },
    }));
    const created = await lifecycle.createMany({ pin, tasks: managedTasks });
    assert.equal(created.length, 2);
    const queue = await WorktreeIntegrationQueue.open({ repositoryRoot: value.repository, targetBranch: "target" });
    await queue.enqueue("root", archive(value.base, [a, b], {}, "run-cleanup", new Set(["a", "b"])));
    WorktreeIntegrationQueue.prototype.cleanup = async function(owner, runID) {
      return (await this.snapshot(owner, runID))!;
    };
    const prepared = await queue.prepare("root", "run-cleanup");
    await queue.accept("root", "run-cleanup", {
      candidate_head: prepared.candidate_head!, review: "pass", review_fingerprint: "d".repeat(64),
    });
    WorktreeIntegrationQueue.prototype.cleanup = originalCleanup;
    await lifecycle.cleanup("worktree-a");
    await lifecycle.cleanup("worktree-b");
    const recovered = await queue.cleanup("root", "run-cleanup");
    assert.deepEqual(recovered.cleanup_pending, []);
    assert.equal((await queue.snapshot("root", "run-cleanup"))!.phase, "integrated");
    const next = await artifact(value.repository, recovered.candidate_head!, "next", "next.txt", "next\n");
    await queue.enqueue("root", archive(recovered.candidate_head!, [next], {}, "run-after-recovery"));
  } finally {
    WorktreeIntegrationQueue.prototype.cleanup = originalCleanup;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("source contains no checkout/reset/clean/merge/push integration commands", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/core/worktree-integration-queue.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /\["(?:checkout|reset|clean|merge|push)"/u);
});
