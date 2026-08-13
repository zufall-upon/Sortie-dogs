import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ParallelDispatchCoordinator,
  ParallelDispatchError,
} from "../dist/core/worktree-parallel-dispatch.js";
import { produceWorktreeCommitArtifact } from "../dist/core/worktree-commit-artifact.js";
import { WorktreeLifecycle } from "../dist/core/worktree-lifecycle.js";
import type {
  ParallelDispatchDescriptor,
  WorktreeParallelContract,
} from "../src/core/types.ts";

function run(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, shell: false, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolvePromise(stdout);
      else reject(new Error(`git failed: ${stderr}`));
    });
  });
}

async function fixture(name: string): Promise<{ root: string; repository: string; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), `sortie-dispatch-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "base.txt"), "base\n");
  await writeFile(join(repository, "a.txt"), "base-a\n");
  await writeFile(join(repository, "b.txt"), "base-b\n");
  await writeFile(join(repository, "c.txt"), "base-c\n");
  await run(repository, "init", "-q");
  await run(repository, "config", "user.name", "Sortie Test");
  await run(repository, "config", "user.email", "sortie@example.invalid");
  await run(repository, "add", "base.txt", "a.txt", "b.txt", "c.txt");
  await run(repository, "commit", "-q", "-m", "base");
  return { root, repository, sha: (await run(repository, "rev-parse", "HEAD")).trim() };
}

function contract(sha: string, dependencies: readonly (readonly string[])[] = [[], ["a"], []]): WorktreeParallelContract {
  const ids = ["a", "b", "c"].slice(0, dependencies.length);
  return {
    version: "0.1.0",
    mode: "parallel",
    max_workers: Math.min(3, ids.length),
    tasks: ids.map((id, index) => ({
      task_id: id,
      worktree: `dispatch-${id}`,
      branch: `sortie/dispatch-${id}`,
      base_sha: sha,
      depends_on: [...dependencies[index]!],
      scope: { read: ["base.txt"], write: [`${id}.txt`] },
    })),
    artifacts: [],
    failure: null,
    baseline_metrics: null,
  };
}

async function errorCode(operation: Promise<unknown>, code: ParallelDispatchError["code"]): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof ParallelDispatchError && error.code === code);
}

async function acceptAndComplete(
  coordinator: ParallelDispatchCoordinator,
  descriptor: ParallelDispatchDescriptor,
  callID: string,
  childSessionID: string,
) {
  await writeFile(join(descriptor.managed_path, `${descriptor.task_id}.txt`), `${descriptor.task_id}\n`);
  const artifact = await produceWorktreeCommitArtifact({
    descriptor,
    managed_path: descriptor.managed_path,
    validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
  });
  await coordinator.acceptArtifact("root", callID, childSessionID, descriptor, artifact);
  return {
    artifact,
    snapshot: await coordinator.completeCall("root", callID, childSessionID, "completed", {
      run_id: descriptor.run_id,
      dispatch_id: descriptor.dispatch_id,
    }),
  };
}

test("fork/join reserves only DAG-ready tasks and supports three bounded workers", async () => {
  const value = await fixture("join");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.deepEqual(prepared.snapshot.ready.map(({ task_id }) => task_id), ["a", "c"]);
    assert.equal(prepared.snapshot.tasks.length, 3);
    assert.equal(new Set(prepared.snapshot.ready.map(({ managed_path }) => managed_path)).size, 2);
    assert.ok(prepared.snapshot.ready.every(Object.isFrozen));

    const [a, c] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "call-a", a!);
    await coordinator.bindDispatch("root", "call-c", c!);
    assert.equal((await coordinator.snapshot("root"))!.ready.length, 0);
    await acceptAndComplete(coordinator, c!, "call-c", "child-c");
    assert.equal((await coordinator.snapshot("root"))!.ready.length, 0);
    const { snapshot: joined } = await acceptAndComplete(coordinator, a!, "call-a", "child-a");
    assert.deepEqual(joined!.ready.map(({ task_id }) => task_id), ["b"]);
    assert.equal(joined!.tasks.find(({ descriptor }) => descriptor.task_id === "a")!.outcome, "completed");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failure suppresses descendants while independent work continues and cancellation is bounded", async () => {
  const value = await fixture("failure");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const a = prepared.snapshot.ready.find(({ task_id }) => task_id === "a")!;
    const c = prepared.snapshot.ready.find(({ task_id }) => task_id === "c")!;
    await coordinator.bindDispatch("root", "call-a", a);
    const failed = await coordinator.completeCall("root", "call-a", "child-a", "failed");
    assert.equal(failed!.tasks.find(({ descriptor }) => descriptor.task_id === "b")!.phase, "suppressed");
    assert.equal(failed!.tasks.find(({ descriptor }) => descriptor.task_id === "c")!.phase, "reserved");
    const cancelled = await coordinator.cancel("root", prepared.snapshot.run_id);
    assert.equal(cancelled!.cancelled, true);
    assert.equal(cancelled!.tasks.find(({ descriptor }) => descriptor.task_id === "c")!.phase, "suppressed");
    await errorCode(coordinator.bindDispatch("root", "call-c", c), "descriptor-replay");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("descriptor replay, wrong descriptor, duplicate and late outcomes fail closed", async () => {
  const value = await fixture("replay");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const descriptor = prepared.snapshot.ready[0]!;
    const wrong = { ...descriptor, branch: "sortie/forged" } as ParallelDispatchDescriptor;
    await errorCode(coordinator.bindDispatch("root", "call-wrong", wrong), "descriptor-mismatch");
    await coordinator.bindDispatch("root", "call", descriptor);
    await errorCode(coordinator.bindDispatch("root", "other-call", descriptor), "descriptor-replay");
    const { snapshot: first } = await acceptAndComplete(coordinator, descriptor, "call", "child");
    const duplicate = await coordinator.completeCall("root", "call", "child", "completed", {
      run_id: descriptor.run_id,
      dispatch_id: descriptor.dispatch_id,
    });
    assert.deepEqual(duplicate, first);
    await errorCode(coordinator.completeCall("root", "call", "child", "failed"), "outcome-conflict");
    await errorCode(coordinator.completeCall("root", "call", "other-child", "completed", {
      run_id: descriptor.run_id,
      dispatch_id: descriptor.dispatch_id,
    }), "outcome-conflict");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("restart preserves running work and explicit reconcile abandons rather than redispatches", async () => {
  const value = await fixture("restart");
  try {
    const first = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await first.prepare(contract(value.sha, [[], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const descriptor = prepared.snapshot.ready[0]!;
    await first.bindDispatch("root", "host-call", descriptor);

    const restarted = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const before = await restarted.snapshot("root", prepared.snapshot.run_id);
    assert.equal(before!.tasks.find(({ descriptor: task }) => task.dispatch_id === descriptor.dispatch_id)!.phase, "running");
    assert.equal(before!.ready.some(({ dispatch_id }) => dispatch_id === descriptor.dispatch_id), false);
    const joined = await restarted.reconcile("root", new Set(["host-call"]), prepared.snapshot.run_id);
    assert.equal(joined!.tasks.find(({ descriptor: task }) => task.dispatch_id === descriptor.dispatch_id)!.phase, "running");
    const abandoned = await restarted.reconcile("root", new Set(), prepared.snapshot.run_id);
    assert.equal(abandoned!.tasks.find(({ descriptor: task }) => task.dispatch_id === descriptor.dispatch_id)!.phase, "abandoned");
    await errorCode(restarted.bindDispatch("root", "new-call", descriptor), "descriptor-replay");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("preflight fallback creates no worktree while schema, dirty, stale and corrupt state stop", async () => {
  const value = await fixture("preflight");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const overlap = contract(value.sha, [[], []]);
    overlap.tasks[1]!.scope.write = [...overlap.tasks[0]!.scope.write];
    assert.deepEqual(await coordinator.prepare(overlap, "root"), {
      status: "serial-fallback",
      reason: "scope-overlap",
    });
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1);

    const cyclic = contract(value.sha, [["b"], ["a"]]);
    await errorCode(coordinator.prepare(cyclic, "root"), "invalid-contract");
    await writeFile(join(value.repository, "dirty.txt"), "dirty\n");
    await errorCode(coordinator.prepare(contract(value.sha, [[], []]), "root"), "dirty-tree");
    await rm(join(value.repository, "dirty.txt"));
    const stale = contract("a".repeat(40), [[], []]);
    await errorCode(coordinator.prepare(stale, "root"), "stale-base");

    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v3", "state.json");
    await writeFile(statePath, "{corrupt");
    await errorCode(coordinator.snapshot("root"), "corrupt-state");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("separate coordinator instances serialize prepare and retain one immutable run", async () => {
  const value = await fixture("compete");
  try {
    const [left, right] = await Promise.all([
      ParallelDispatchCoordinator.open({ repositoryRoot: value.repository }),
      ParallelDispatchCoordinator.open({ repositoryRoot: value.repository }),
    ]);
    const candidate = contract(value.sha, [[], []]);
    const results = await Promise.all([
      left.prepare(candidate, "root"),
      right.prepare(candidate, "root"),
    ]);
    assert.ok(results.every(({ status }) => status === "prepared"));
    if (results[0]!.status !== "prepared" || results[1]!.status !== "prepared") return;
    assert.equal(results[0]!.snapshot.run_id, results[1]!.snapshot.run_id);
    assert.deepEqual(
      results[0]!.snapshot.tasks.map(({ descriptor }) => descriptor.dispatch_id),
      results[1]!.snapshot.tasks.map(({ descriptor }) => descriptor.dispatch_id),
    );
    await errorCode(right.prepare(candidate, "other-root"), "active-run");
    const source = JSON.parse(await readFile(
      join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v3", "state.json"),
      "utf8",
    )) as { run: { tasks: unknown[] } };
    assert.equal(source.run.tasks.length, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("restart adopts exact worktrees created after durable intent and never creates duplicates", async () => {
  const value = await fixture("prepare-restart");
  const original = WorktreeLifecycle.prototype.createMany;
  let injected = true;
  WorktreeLifecycle.prototype.createMany = async function (...args): Promise<Awaited<ReturnType<typeof original>>> {
    const managed = await original.apply(this, args);
    if (injected) {
      injected = false;
      throw new Error("injected process exit after lifecycle create");
    }
    return managed;
  };
  try {
    const candidate = contract(value.sha, [[], []]);
    const first = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    await assert.rejects(first.prepare(candidate, "root"), /injected process exit/u);
    const before = await run(value.repository, "worktree", "list", "--porcelain");
    assert.equal(before.match(/^worktree /gmu)?.length, 3);

    const restarted = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await restarted.prepare(candidate, "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.snapshot.tasks.length, 2);
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")), before);
  } finally {
    WorktreeLifecycle.prototype.createMany = original;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("terminal and cancelled runs archive ownership and release the active slot", async () => {
  const value = await fixture("archive");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const first = await coordinator.prepare(contract(value.sha, [[], [], []]), "root");
    assert.equal(first.status, "prepared");
    if (first.status !== "prepared") return;
    for (const [index, descriptor] of first.snapshot.ready.entries()) {
      await coordinator.bindDispatch("root", `call-${index}`, descriptor);
      const { snapshot: terminal } = await acceptAndComplete(
        coordinator, descriptor, `call-${index}`, `child-${index}`,
      );
      if (index === first.snapshot.ready.length - 1) {
        assert.equal(terminal!.archived, true);
        assert.equal(terminal!.terminal_reason, "completed");
      }
    }
    assert.equal((await coordinator.snapshot("root")), undefined);
    const firstArchive = await coordinator.snapshot("root", first.snapshot.run_id);
    assert.equal(firstArchive!.archived, true);
    assert.ok(firstArchive!.tasks.every(({ descriptor }) => descriptor.managed_path.length > 0));

    const secondContract = contract(value.sha, [[], []]);
    secondContract.max_workers = 2;
    secondContract.tasks[0]!.scope.read.push("other.txt");
    const second = await coordinator.prepare(secondContract, "root");
    assert.equal(second.status, "prepared");
    if (second.status !== "prepared") return;
    assert.notEqual(second.snapshot.run_id, first.snapshot.run_id);
    assert.ok(second.snapshot.tasks.every(({ descriptor }) =>
      first.snapshot.tasks.some(({ descriptor: archived }) => descriptor.managed_path === archived.managed_path)));
    assert.equal(first.snapshot.tasks.length, 3);
    const cancelled = await coordinator.cancel("root", second.snapshot.run_id);
    assert.equal(cancelled!.archived, true);
    assert.equal(cancelled!.terminal_reason, "cancelled");
    assert.ok(cancelled!.tasks.every(({ phase, outcome }) => phase === "suppressed" && outcome === "cancelled"));
    const archives = await coordinator.archives("root");
    assert.deepEqual(archives.map(({ terminal_reason }) => terminal_reason), ["completed", "cancelled"]);
    assert.ok(archives.every(({ tasks }) => tasks.every(({ worktree_id, managed_path }) =>
      worktree_id.length > 0 && managed_path !== null)));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("cancellation preserves running join and archives only after its outcome", async () => {
  const value = await fixture("cancel-running");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const running = prepared.snapshot.ready[0]!;
    await coordinator.bindDispatch("root", "running-call", running);
    const cancelled = await coordinator.cancel("root", prepared.snapshot.run_id);
    assert.equal(cancelled!.archived, false);
    assert.equal(cancelled!.ready.length, 0);
    assert.equal(cancelled!.tasks.find(({ descriptor }) => descriptor.dispatch_id === running.dispatch_id)!.phase, "running");
    assert.equal(cancelled!.tasks.find(({ descriptor }) => descriptor.dispatch_id !== running.dispatch_id)!.phase, "suppressed");
    const nextContract = contract(value.sha, [[], []]);
    nextContract.max_workers = 2;
    nextContract.tasks[0]!.scope.read.push("other.txt");
    await errorCode(coordinator.prepare(nextContract, "root"), "active-run");
    const terminal = await coordinator.completeCall("root", "running-call", "child", "completed");
    assert.equal(terminal!.archived, true);
    assert.equal(terminal!.terminal_reason, "cancelled");
    const next = await coordinator.prepare(nextContract, "root");
    assert.equal(next.status, "prepared");
    if (next.status === "prepared") assert.notEqual(next.snapshot.run_id, prepared.snapshot.run_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verified artifacts survive restart and archive as bounded deeply frozen evidence", async () => {
  const value = await fixture("artifact-archive");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [first, second] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "call-a", first!);
    await writeFile(join(first!.managed_path, "a.txt"), "accepted\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: first!,
      managed_path: first!.managed_path,
      validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    const accepted = await coordinator.acceptArtifact("root", "call-a", "child-a", first!, artifact);
    const evidence = accepted.tasks.find(({ descriptor }) => descriptor.dispatch_id === first!.dispatch_id)!.artifact!;
    assert.deepEqual(evidence, artifact);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.changed_paths), true);
    assert.equal(Object.isFrozen(evidence.validation), true);
    assert.equal(Object.isFrozen(evidence.validation.command), true);
    assert.deepEqual(Object.keys(evidence).sort(), [
      "base_sha", "branch", "change_fingerprint", "changed_paths", "commit_sha", "task_id", "validation",
    ]);

    const restarted = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const reopened = await restarted.snapshot("root", prepared.snapshot.run_id);
    assert.deepEqual(reopened!.tasks.find(({ descriptor }) => descriptor.dispatch_id === first!.dispatch_id)!.artifact, artifact);
    await restarted.acceptArtifact("root", "call-a", "child-a", first!, artifact);
    await errorCode(restarted.acceptArtifact("root", "call-a", "child-a", first!, {
      ...artifact,
      change_fingerprint: "f".repeat(64),
    }), "outcome-conflict");
    await restarted.completeCall("root", "call-a", "child-a", "completed", {
      run_id: first!.run_id,
      dispatch_id: first!.dispatch_id,
    });
    await restarted.bindDispatch("root", "call-b", second!);
    const { snapshot: terminal } = await acceptAndComplete(restarted, second!, "call-b", "child-b");
    assert.equal(terminal!.archived, true);
    const archived = (await restarted.archives("root")).find(({ run_id }) => run_id === prepared.snapshot.run_id)!;
    const archivedArtifact = archived.tasks.find(({ dispatch_id }) => dispatch_id === first!.dispatch_id)!.artifact!;
    assert.deepEqual(archivedArtifact, artifact);
    assert.equal(Object.isFrozen(archivedArtifact.changed_paths), true);
    assert.equal(Object.isFrozen(archivedArtifact.validation.command), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("artifact acceptance survives both lifecycle crash windows and completion cannot consume provisional evidence", async () => {
  const value = await fixture("artifact-two-phase");
  const original = WorktreeLifecycle.prototype.acceptCommit;
  let lifecycleCalls = 0;
  WorktreeLifecycle.prototype.acceptCommit = async function (...args): Promise<void> {
    lifecycleCalls += 1;
    if (lifecycleCalls === 1) throw new Error("injected process exit before lifecycle acceptance");
    await original.apply(this, args);
    if (lifecycleCalls === 3 || lifecycleCalls === 5) throw new Error("injected process exit after lifecycle acceptance");
  };
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], [], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [first, second, third] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "call-a", first!);
    await writeFile(join(first!.managed_path, "a.txt"), "first\n");
    const firstArtifact = await produceWorktreeCommitArtifact({
      descriptor: first!, managed_path: first!.managed_path,
      validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    await errorCode(coordinator.acceptArtifact("root", "call-a", "child-a", first!, firstArtifact), "lifecycle-failed");
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v3", "state.json");
    const provisional = JSON.parse(await readFile(statePath, "utf8")) as {
      run: { tasks: Array<{ artifact: unknown; artifact_accepted: boolean }> };
    };
    assert.deepEqual(provisional.run.tasks[0]!.artifact, firstArtifact);
    assert.equal(provisional.run.tasks[0]!.artifact_accepted, false);

    await coordinator.acceptArtifact("root", "call-a", "child-a", first!, firstArtifact);
    const restarted = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    await restarted.completeCall("root", "call-a", "child-a", "completed", {
      run_id: first!.run_id, dispatch_id: first!.dispatch_id,
    });

    await restarted.bindDispatch("root", "call-b", second!);
    await writeFile(join(second!.managed_path, "b.txt"), "second\n");
    const secondArtifact = await produceWorktreeCommitArtifact({
      descriptor: second!, managed_path: second!.managed_path,
      validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    await errorCode(restarted.acceptArtifact("root", "call-b", "child-b", second!, secondArtifact), "lifecycle-failed");
    const secondRestart = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    await secondRestart.acceptArtifact("root", "call-b", "child-b", second!, secondArtifact);
    await secondRestart.completeCall("root", "call-b", "child-b", "completed", {
      run_id: second!.run_id, dispatch_id: second!.dispatch_id,
    });

    await secondRestart.bindDispatch("root", "call-c", third!);
    await writeFile(join(third!.managed_path, "c.txt"), "third\n");
    const thirdArtifact = await produceWorktreeCommitArtifact({
      descriptor: third!, managed_path: third!.managed_path,
      validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    await errorCode(secondRestart.acceptArtifact("root", "call-c", "child-c", third!, thirdArtifact), "lifecycle-failed");
    const terminal = await secondRestart.completeCall("root", "call-c", "child-c", "completed", {
      run_id: third!.run_id, dispatch_id: third!.dispatch_id,
    });
    const failed = terminal!.tasks.find(({ descriptor }) => descriptor.dispatch_id === third!.dispatch_id)!;
    assert.equal(failed.phase, "failed");
    assert.equal(failed.outcome, "failed");
    assert.deepEqual(failed.artifact, thirdArtifact);
    assert.equal(terminal!.archived, true);

    const reopened = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const archive = await reopened.snapshot("root", prepared.snapshot.run_id);
    assert.equal(archive!.terminal_reason, "failed");
    assert.deepEqual(archive!.tasks.find(({ descriptor }) => descriptor.dispatch_id === third!.dispatch_id)!.artifact, thirdArtifact);
  } finally {
    WorktreeLifecycle.prototype.acceptCommit = original;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("durable artifact parser rejects semantic corruption without consulting the checkout", async () => {
  const value = await fixture("artifact-corrupt");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const candidate = contract(value.sha, [[], []]);
    candidate.tasks[0]!.scope.write = ["upper"];
    const prepared = await coordinator.prepare(candidate, "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const descriptor = prepared.snapshot.ready[0]!;
    await coordinator.bindDispatch("root", "call", descriptor);
    await mkdir(join(descriptor.managed_path, "upper"));
    await writeFile(join(descriptor.managed_path, "upper", "A.txt"), "accepted\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor, managed_path: descriptor.managed_path,
      validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    await coordinator.acceptArtifact("root", "call", "child", descriptor, artifact);
    assert.deepEqual(artifact.changed_paths, ["upper/A.txt"]);
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v3", "state.json");
    const pristine = JSON.parse(await readFile(statePath, "utf8")) as Record<string, any>;
    assert.deepEqual((await (await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository }))
      .snapshot("root", prepared.snapshot.run_id))!.tasks[0]!.artifact, artifact);
    const corruptions: Array<(state: Record<string, any>) => void> = [
      (state) => { state.run.tasks[0].artifact.validation.command[0] = "node"; },
      (state) => { state.run.tasks[0].artifact.changed_paths = ["outside.txt"]; },
      (state) => { state.run.tasks[0].artifact.changed_paths = ["./a.txt"]; },
      (state) => { state.run.tasks[0].artifact.changed_paths = ["a.txt", "A.txt"]; },
      (state) => { state.run.tasks[0].artifact.validation.validation_fingerprint = "f".repeat(64); },
      (state) => { state.run.tasks[0].artifact = null; },
      (state) => { delete state.run.tasks[0].artifact_accepted; },
    ];
    for (const corrupt of corruptions) {
      const state = structuredClone(pristine);
      corrupt(state);
      await writeFile(statePath, JSON.stringify(state));
      const reopened = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
      await errorCode(reopened.snapshot("root", prepared.snapshot.run_id), "corrupt-state");
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("completion without artifact fails and tampering is rejected before lifecycle acceptance", async () => {
  const value = await fixture("artifact-failclosed");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [first, second] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "missing-call", first!);
    const failed = await coordinator.completeCall("root", "missing-call", "missing-child", "completed", {
      run_id: first!.run_id,
      dispatch_id: first!.dispatch_id,
    });
    const failedTask = failed!.tasks.find(({ descriptor }) => descriptor.dispatch_id === first!.dispatch_id)!;
    assert.equal(failedTask.phase, "failed");
    assert.equal(failedTask.outcome, "failed");
    assert.equal(failedTask.artifact, null);

    await coordinator.bindDispatch("root", "tamper-call", second!);
    await writeFile(join(second!.managed_path, "b.txt"), "candidate\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: second!,
      managed_path: second!.managed_path,
      validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    await errorCode(coordinator.acceptArtifact("root", "tamper-call", "tamper-child", second!, {
      ...artifact,
      commit_sha: "a".repeat(40),
    }), "artifact-invalid");
    const beforeFailure = await coordinator.snapshot("root", prepared.snapshot.run_id);
    assert.equal(beforeFailure!.tasks.find(({ descriptor }) => descriptor.dispatch_id === second!.dispatch_id)!.artifact, null);
    const terminal = await coordinator.completeCall("root", "tamper-call", "tamper-child", "failed");
    assert.equal(terminal!.tasks.find(({ descriptor }) => descriptor.dispatch_id === second!.dispatch_id)!.artifact, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("reconciliation retains accepted artifact evidence on abandonment without releasing descendants", async () => {
  const value = await fixture("artifact-abandon");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], ["a"]]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const descriptor = prepared.snapshot.ready[0]!;
    await coordinator.bindDispatch("root", "call", descriptor);
    await writeFile(join(descriptor.managed_path, "a.txt"), "durable\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor,
      managed_path: descriptor.managed_path,
      validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    await coordinator.acceptArtifact("root", "call", "child", descriptor, artifact);
    const abandoned = await coordinator.reconcile("root", new Set(), prepared.snapshot.run_id);
    const task = abandoned!.tasks.find(({ descriptor: entry }) => entry.dispatch_id === descriptor.dispatch_id)!;
    assert.equal(task.phase, "abandoned");
    assert.deepEqual(task.artifact, artifact);
    assert.equal(abandoned!.ready.length, 0);
    assert.equal(abandoned!.tasks.find(({ descriptor: entry }) => entry.task_id === "b")!.phase, "suppressed");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
