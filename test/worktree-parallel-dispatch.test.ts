import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ParallelDispatchCoordinator,
  ParallelDispatchError,
} from "../dist/core/worktree-parallel-dispatch.js";
import { produceWorktreeCommitArtifact } from "../dist/core/worktree-commit-artifact.js";
import { WorktreeLifecycle } from "../dist/core/worktree-lifecycle.js";
import { ScopeLeaseError, ScopeLeaseRegistry } from "../dist/core/scope-lease-registry.js";
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
  await writeFile(join(repository, "d.txt"), "base-d\n");
  await writeFile(join(repository, "e.txt"), "base-e\n");
  await run(repository, "init", "-q", "-b", "main");
  await run(repository, "config", "user.name", "Sortie Test");
  await run(repository, "config", "user.email", "sortie@example.invalid");
  await run(repository, "add", "base.txt", "a.txt", "b.txt", "c.txt", "d.txt", "e.txt");
  await run(repository, "commit", "-q", "-m", "base");
  return { root, repository, sha: (await run(repository, "rev-parse", "HEAD")).trim() };
}

function contract(sha: string, dependencies: readonly (readonly string[])[] = [[], ["a"], []]): WorktreeParallelContract {
  const ids = ["a", "b", "c", "d", "e"].slice(0, dependencies.length);
  return {
    version: "0.1.0",
    mode: "parallel",
    max_workers: Math.min(5, ids.length),
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

function fabricUnit(id: string, order: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unit_id: id,
    acceptance_items: [`own ${id}`],
    scope_read: ["base.txt"],
    scope_write: [`${id}.txt`],
    depends_on: [],
    validation: { level: "targeted", command: [process.execPath, "-e", "process.exit(0)"] },
    shared_path_keys: [],
    exclusive_resources: [],
    scheduler_order: order,
    ...overrides,
  };
}

function fabricContract(sha: string, units: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: "0.8.0",
    provenance: {
      source: "dog-coordinator",
      acceptance_fingerprint: "b".repeat(64),
      target_branch: "main",
      target_sha: sha,
    },
    acceptance_items: units.flatMap((unit) => unit.acceptance_items as string[]),
    effects: [],
    shared_paths: [],
    units,
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

test("five independent units reserve five durable descriptors from one exact base", async () => {
  const value = await fixture("five-lanes");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], [], [], [], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.snapshot.max_workers, 5);
    assert.equal(prepared.snapshot.tasks.length, 5);
    assert.equal(prepared.snapshot.ready.length, 5);
    assert.equal(new Set(prepared.snapshot.ready.map(({ managed_path }) => managed_path)).size, 5);
    assert.ok(prepared.snapshot.ready.every(({ base_sha, parallel_units }) =>
      base_sha === value.sha && parallel_units === 5));

    const state = JSON.parse(await readFile(
      join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json"),
      "utf8",
    )) as { run: { tasks: unknown[]; max_workers: number; route: string } };
    assert.equal(state.run.max_workers, 5);
    assert.equal(state.run.tasks.length, 5);
    assert.equal(state.run.route, "sol-serial");
    assert.equal(prepared.snapshot.route, "sol-serial");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("parallel state authority retries transient lease mutex contention", async () => {
  const value = await fixture("state-lock-retry");
  const originalAcquire = ScopeLeaseRegistry.prototype.acquire;
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepare(contract(value.sha, [[], ["a"]]), "root");
    assert.equal(prepared.status, "prepared");
    let contended = true;
    ScopeLeaseRegistry.prototype.acquire = async function (
      ...args: Parameters<ScopeLeaseRegistry["acquire"]>
    ) {
      if (contended) {
        contended = false;
        throw new ScopeLeaseError("lock-timeout", "simulated transient mutex contention");
      }
      return await originalAcquire.apply(this, args);
    };
    assert.equal((await coordinator.snapshot("root"))?.run_id, prepared.snapshot.run_id);
    assert.equal(contended, false);
  } finally {
    ScopeLeaseRegistry.prototype.acquire = originalAcquire;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an admitted fabric contract prepares one durable luna-fabric run", async () => {
  const value = await fixture("fabric-prepare");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const units = ["a", "b", "c", "d", "e"].map((id, index) => fabricUnit(id, index));
    const prepared = await coordinator.prepareFabric(fabricContract(value.sha, units), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.snapshot.route, "luna-fabric");
    assert.equal(prepared.width, 5);
    assert.equal(prepared.depth, 1);
    assert.deepEqual(prepared.snapshot.fabric?.unit_acceptance.a, ["own a"]);
    assert.match(prepared.fabric_fingerprint, /^[0-9a-f]{64}$/u);
    assert.deepEqual(prepared.snapshot.ready.map(({ task_id }) => task_id), ["a", "b", "c", "d", "e"]);
    assert.ok(prepared.snapshot.tasks.every(({ descriptor }) =>
      descriptor.branch.startsWith(`sortie-dogs/luna-fabric/${prepared.fabric_fingerprint.slice(0, 16)}/`) &&
      descriptor.base_sha === value.sha));

    const state = JSON.parse(await readFile(
      join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json"),
      "utf8",
    )) as { run: { route: string } };
    assert.equal(state.run.route, "luna-fabric");
    const archived = await coordinator.cancel("root", prepared.snapshot.run_id);
    assert.equal(archived!.route, "luna-fabric");
    assert.equal((await coordinator.archives("root"))[0]!.route, "luna-fabric");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("admission and unowned concurrent overlap route the fabric to Sol without a worktree", async () => {
  const value = await fixture("fabric-sol");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const overlapping = [
      fabricUnit("a", 0, { scope_write: ["a.txt"] }),
      fabricUnit("b", 1, { scope_write: ["a.txt"] }),
    ];
    for (const [candidate, reason] of [
      [{}, "malformed-contract"],
      [fabricContract(value.sha, [fabricUnit("a", 0)]), "fewer-than-two-units"],
      [fabricContract(value.sha, overlapping), "shared-path-unowned"],
    ] as const) {
      assert.deepEqual(await coordinator.prepareFabric(candidate, "root"), { status: "sol-serial", reason });
    }
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1);
    assert.equal(await coordinator.snapshot("root"), undefined);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a six-unit fabric advances only at the barrier into a fresh exact-base worktree", async () => {
  const value = await fixture("fabric-waves");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const units = ["a", "b", "c", "d", "e"].map((id, index) => fabricUnit(id, index));
    units.push(fabricUnit("f", 5, { depends_on: ["a"] }));
    const prepared = await coordinator.prepareFabric(fabricContract(value.sha, units), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.snapshot.fabric?.total_units, 6);
    assert.equal(prepared.snapshot.ready.length, 5);
    assert.equal(prepared.snapshot.tasks.some(({ descriptor }) => descriptor.task_id === "f"), false);
    const firstPaths = prepared.snapshot.ready.map(({ managed_path }) => managed_path);
    const firstBranches = prepared.snapshot.ready.map(({ branch }) => branch);
    for (const [index, descriptor] of prepared.snapshot.ready.entries()) {
      await coordinator.bindDispatch("root", `call-${index}`, descriptor);
      const completed = await acceptAndComplete(coordinator, descriptor, `call-${index}`, `child-${index}`);
      assert.equal(completed.snapshot!.tasks.some(({ descriptor: task }) => task.task_id === "f"), false);
    }
    for (const path of firstPaths) assert.notEqual(await stat(path).catch(() => undefined), undefined);
    const advanced = await coordinator.integrateFabricWave("root", prepared.snapshot.run_id);
    const candidate = advanced.fabric!.candidate_head;
    assert.equal(advanced.archived, false);
    assert.deepEqual(advanced.ready.map(({ task_id }) => task_id), ["f"]);
    assert.equal(advanced.ready[0]!.base_sha, candidate);
    assert.equal(firstPaths.includes(advanced.ready[0]!.managed_path), false);
    assert.equal(advanced.ready[0]!.parallel_units, 1);
    for (const path of firstPaths) assert.equal(await stat(path).catch(() => undefined), undefined);
    for (const branch of firstBranches) await assert.rejects(run(value.repository, "rev-parse", "--verify", `refs/heads/${branch}`));
    assert.equal((await run(value.repository, "rev-parse", "HEAD")).trim(), value.sha);
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);

    const restarted = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const recovered = await restarted.snapshot("root", prepared.snapshot.run_id);
    assert.deepEqual(recovered?.ready, advanced.ready);
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fabric claims validation once and resumes acceptance after a completed target CAS", async () => {
  const value = await fixture("fabric-promote");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const units = [fabricUnit("a", 0), fabricUnit("b", 1)];
    const prepared = await coordinator.prepareFabric(fabricContract(value.sha, units), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await errorCode(coordinator.integrateFabricWave("root", prepared.snapshot.run_id), "wave-not-ready");
    for (const [index, descriptor] of prepared.snapshot.ready.entries()) {
      await coordinator.bindDispatch("root", `call-${index}`, descriptor);
      await acceptAndComplete(coordinator, descriptor, `call-${index}`, `child-${index}`);
    }

    const integrated = await coordinator.integrateFabricWave("root", prepared.snapshot.run_id);
    const candidate = integrated.fabric!.candidate_head;
    assert.notEqual(candidate, value.sha);
    assert.equal(integrated.fabric!.candidate_ref.startsWith("refs/sortie-dogs/luna-fabric-candidates/"), true);
    assert.equal((await run(value.repository, "rev-parse", integrated.fabric!.candidate_ref)).trim(), candidate);
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);
    assert.equal((await run(value.repository, "show", `${candidate}:a.txt`)).trim(), "a");
    assert.equal((await run(value.repository, "show", `${candidate}:b.txt`)).trim(), "b");

    const validationCount = join(value.root, "validation-count.txt");
    const validation = () => coordinator.validateFabricCandidate(
      "root", prepared.snapshot.run_id, process.execPath,
      ["-e", "const fs=require('node:fs');fs.appendFileSync(process.argv[1],'x');setTimeout(()=>{if(fs.readFileSync('a.txt','utf8').trim()!=='a'||fs.readFileSync('b.txt','utf8').trim()!=='b')process.exitCode=1},250)", validationCount],
    );
    const attempts = await Promise.allSettled([validation(), validation()]);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
    const successful = attempts.find(({ status }) => status === "fulfilled");
    const conflicting = attempts.find(({ status }) => status === "rejected");
    assert.equal(conflicting?.status, "rejected");
    if (conflicting?.status === "rejected") {
      assert.equal(conflicting.reason instanceof ParallelDispatchError && conflicting.reason.code, "outcome-conflict");
    }
    assert.equal(await readFile(validationCount, "utf8"), "x");
    assert.equal(successful?.status, "fulfilled");
    if (successful?.status !== "fulfilled") return;
    const validated = successful.value;
    assert.equal(validated.fabric!.validation.status, "pass");
    assert.match(validated.fabric!.validation.fingerprint!, /^[0-9a-f]{64}$/u);
    assert.equal((await coordinator.validateFabricCandidate(
      "root", prepared.snapshot.run_id, process.execPath, ["-e", "process.exit(9)"],
    )).fabric!.validation.status, "pass");

    await run(value.repository, "checkout", "--detach", value.sha);
    // A process may stop after the target CAS but before durable promotion state is written.
    await run(value.repository, "update-ref", "refs/heads/main", candidate, value.sha);
    const accepted = await coordinator.acceptFabricCandidate(
      "root", prepared.snapshot.run_id, candidate, "skip", "d".repeat(64),
    );
    assert.equal(accepted.archived, true);
    assert.equal(accepted.terminal_reason, "completed");
    assert.equal(accepted.fabric!.promoted, true);
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), candidate);
    await assert.rejects(run(value.repository, "rev-parse", "--verify", integrated.fabric!.candidate_ref));
    assert.deepEqual(
      await coordinator.acceptFabricCandidate("root", prepared.snapshot.run_id, candidate, "skip", "d".repeat(64)),
      accepted,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a failed Luna unit demotes once to a fresh Sol worktree and joins the same hidden candidate", async () => {
  const value = await fixture("fabric-demotion");
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [failed, sibling] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "luna-a", failed!);
    await coordinator.completeCall("root", "luna-a", "child-a", "failed");
    await coordinator.bindDispatch("root", "luna-b", sibling!);
    await acceptAndComplete(coordinator, sibling!, "luna-b", "child-b");

    const demoted = await coordinator.demoteFailedFabricUnit("root", prepared.snapshot.run_id, "a");
    assert.deepEqual(demoted.ready.map(({ task_id, attempt }) => ({ task_id, attempt })), [{ task_id: "a", attempt: 2 }]);
    assert.equal(demoted.ready[0]!.managed_path === failed!.managed_path, false);
    assert.deepEqual(demoted.fabric!.demotions.map(({ unit_id, luna_dispatch_id, sol_dispatch_id }) =>
      ({ unit_id, luna_dispatch_id, sol_dispatch_id })), [{
        unit_id: "a", luna_dispatch_id: failed!.dispatch_id, sol_dispatch_id: demoted.ready[0]!.dispatch_id,
      }]);
    assert.equal(await stat(failed!.managed_path).catch(() => undefined), undefined);
    assert.equal(await stat(sibling!.managed_path).catch(() => undefined), undefined);

    const restarted = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const replay = await restarted.demoteFailedFabricUnit("root", prepared.snapshot.run_id, "a");
    assert.deepEqual(replay.ready, demoted.ready);
    await restarted.bindDispatch("root", "sol-a", replay.ready[0]!);
    await acceptAndComplete(restarted, replay.ready[0]!, "sol-a", "child-sol-a");
    const integrated = await restarted.integrateFabricWave("root", prepared.snapshot.run_id);
    assert.equal((await run(value.repository, "show", `${integrated.fabric!.candidate_head}:a.txt`)).trim(), "a");
    assert.equal((await run(value.repository, "show", `${integrated.fabric!.candidate_head}:b.txt`)).trim(), "b");
    await restarted.validateFabricCandidate("root", prepared.snapshot.run_id, process.execPath, ["-e", "process.exit(0)"]);
    await run(value.repository, "checkout", "--detach", value.sha);
    await restarted.acceptFabricCandidate(
      "root", prepared.snapshot.run_id, integrated.fabric!.candidate_head, "skip", "e".repeat(64),
    );
    assert.equal((await run(value.repository, "for-each-ref", "--format=%(refname)",
      "refs/sortie-dogs/luna-fabric-sources/")).trim(), "");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("restart adopts a Sol demotion worktree created after durable intent", async () => {
  const value = await fixture("fabric-demotion-restart");
  const original = WorktreeLifecycle.prototype.createManyAtBase;
  let injected = true;
  try {
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [failed, sibling] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "luna-a", failed!);
    await coordinator.completeCall("root", "luna-a", "child-a", "failed");
    await coordinator.bindDispatch("root", "luna-b", sibling!);
    await acceptAndComplete(coordinator, sibling!, "luna-b", "child-b");
    WorktreeLifecycle.prototype.createManyAtBase = async function (...args): Promise<Awaited<ReturnType<typeof original>>> {
      const managed = await original.apply(this, args);
      if (injected) { injected = false; throw new Error("injected demotion exit"); }
      return managed;
    };
    await errorCode(coordinator.demoteFailedFabricUnit("root", prepared.snapshot.run_id, "a"), "lifecycle-failed");
    WorktreeLifecycle.prototype.createManyAtBase = original;

    const restarted = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const recovered = await restarted.snapshot("root", prepared.snapshot.run_id);
    assert.deepEqual(recovered!.ready.map(({ task_id, attempt }) => ({ task_id, attempt })), [{ task_id: "a", attempt: 2 }]);
    assert.equal(recovered!.fabric!.demotions.length, 1);
  } finally {
    WorktreeLifecycle.prototype.createManyAtBase = original;
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

    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
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
      join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json"),
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
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
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
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
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
