import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import nodeTest, { after, describe, type TestContext } from "node:test";

import {
  ParallelDispatchCoordinator,
  ParallelDispatchError,
} from "../../dist/core/worktree-parallel-dispatch.js";
import { produceWorktreeCommitArtifact } from "../../dist/core/worktree-commit-artifact.js";
import { WorktreeLifecycle } from "../../dist/core/worktree-lifecycle.js";
import { ScopeLeaseError, ScopeLeaseRegistry } from "../../dist/core/scope-lease-registry.js";
import { compileAcceptanceCoverage } from "../../dist/core/acceptance-compiler.js";
import { createExecutionPlan, executionPlanManifestFingerprint } from "../../dist/core/execution-plan.js";
import { reconstructRunFlightLedger, type RunFlightEventRecord } from "../../dist/core/run-flight-ledger.js";
import { CancellableChildLifecycle } from "../../dist/core/child-lifecycle-runtime.js";
import type { ChildTerminalEvidence } from "../../dist/core/child-terminal-reconciliation.js";
import type { ParallelDispatchDescriptor } from "../../src/core/types.ts";
import {
  acceptAndComplete,
  acceptAndCompleteMany,
  commit,
  contract,
  errorCode,
  fabricContract,
  fabricUnit,
  fixture,
  gitDiffCheck,
  openParallelCoordinator,
  run,
} from "../helpers/worktree-dispatch-fixture.ts";

export type RegisteredTest = {
  name: string;
  options?: { timeout?: number };
  phase?: "s01";
  run: (context: TestContext) => void | Promise<void>;
};

const isolatedCases: RegisteredTest[] = [];
const normalCases = new Set([
  "fork/join reserves only DAG-ready tasks and supports three bounded workers",
  "fabric preparation durably pins one coordinator execution plan and rejects resume drift",
  "admission and unowned concurrent overlap route the fabric to Sol without a worktree",
]);
const importedByNormalLayer = new URL(import.meta.url).searchParams.has("normal");

function lifecycleOf(coordinator: ParallelDispatchCoordinator): WorktreeLifecycle {
  return (coordinator as unknown as { lifecycle: WorktreeLifecycle }).lifecycle;
}

async function completeReadyArtifacts(coordinator: ParallelDispatchCoordinator, ready: readonly ParallelDispatchDescriptor[]): Promise<void> {
  const entries = ready.map((descriptor, index) => ({ descriptor, callID: `call-${index}`, childSessionID: `child-${index}` }));
  for (const { descriptor, callID } of entries) await coordinator.bindDispatch("root", callID, descriptor);
  // Independent setup artifacts use the existing bounded producer pool; scenarios remain serial.
  await acceptAndCompleteMany(coordinator, entries);
}

function registerCase(
  collection: RegisteredTest[],
  name: string,
  optionsOrRun: RegisteredTest["options"] | RegisteredTest["run"],
  run?: RegisteredTest["run"],
): void {
  if (typeof optionsOrRun === "function") collection.push({ name, run: optionsOrRun });
  else collection.push({ name, options: optionsOrRun, run: run! });
}

function test(name: string, run: RegisteredTest["run"]): void;
function test(name: string, options: RegisteredTest["options"], run: RegisteredTest["run"]): void;
function test(
  name: string,
  optionsOrRun: RegisteredTest["options"] | RegisteredTest["run"],
  run?: RegisteredTest["run"],
): void {
  registerCase(isolatedCases, name, optionsOrRun, run);
}

function s01Test(name: string, run: RegisteredTest["run"]): void;
function s01Test(name: string, options: RegisteredTest["options"], run: RegisteredTest["run"]): void;
function s01Test(
  name: string,
  optionsOrRun: RegisteredTest["options"] | RegisteredTest["run"],
  run?: RegisteredTest["run"],
): void {
  const before = isolatedCases.length;
  registerCase(isolatedCases, name, optionsOrRun, run);
  isolatedCases[before]!.phase = "s01";
}

test("fork/join reserves only DAG-ready tasks and supports three bounded workers", async () => {
  const value = await fixture("join");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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
    const coordinator = await openParallelCoordinator(value.repository);
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

test("orphaned state authority expires inside the next CLI acquisition budget", async () => {
  const value = await fixture("orphaned-state-authority");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const lease = await (coordinator as unknown as { acquire(): Promise<{ close(): void }> }).acquire();
    lease.close(); // Simulate process loss: stop heartbeats without releasing the durable lease.
    const path = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "authority", "scope-leases.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    assert.equal(state.leases.length, 1);
    assert.ok(state.leases[0].expiresAt - state.leases[0].createdAt < 30_000);
    const restarted = await openParallelCoordinator(value.repository);
    assert.equal(await restarted.snapshot("root"), undefined);
    assert.equal(JSON.parse(await readFile(path, "utf8")).leases.length, 0);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("parallel state authority retries transient lease mutex contention", async () => {
  const value = await fixture("state-lock-retry");
  let registry: ScopeLeaseRegistry | undefined;
  let originalAcquire: ScopeLeaseRegistry["acquire"] | undefined;
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepare(contract(value.sha, [[], ["a"]]), "root");
    assert.equal(prepared.status, "prepared");
    let contended = true;
    registry = (coordinator as unknown as { registry: ScopeLeaseRegistry }).registry;
    originalAcquire = registry.acquire.bind(registry);
    registry.acquire = async (...args: Parameters<ScopeLeaseRegistry["acquire"]>) => {
      if (contended) {
        contended = false;
        throw new ScopeLeaseError("lock-timeout", "simulated transient mutex contention");
      }
      return await originalAcquire!(...args);
    };
    assert.equal((await coordinator.snapshot("root"))?.run_id, prepared.snapshot.run_id);
    assert.equal(contended, false);
  } finally {
    if (registry !== undefined && originalAcquire !== undefined) registry.acquire = originalAcquire;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("five concurrent fabric binds skip recovery authority for a stable active run", async () => {
  const value = await fixture("stable-bind-contention");
  const patched: Array<{ registry: ScopeLeaseRegistry; acquire: ScopeLeaseRegistry["acquire"] }> = [];
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const units = ["a", "b", "c", "d", "e"].map((id, index) => fabricUnit(id, index));
    const prepared = await coordinator.prepareFabric(fabricContract(value.sha, units), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const acquiredScopes: string[][] = [];
    const coordinators = await Promise.all(prepared.snapshot.ready.map(async () =>
      await openParallelCoordinator(value.repository)));
    for (const candidate of coordinators) {
      const registry = (candidate as unknown as { registry: ScopeLeaseRegistry }).registry;
      const acquire = registry.acquire.bind(registry);
      patched.push({ registry, acquire });
      registry.acquire = async (...args: Parameters<ScopeLeaseRegistry["acquire"]>) => {
        acquiredScopes.push([...args[0].scope.write]);
        return await acquire(...args);
      };
    }
    await Promise.all(prepared.snapshot.ready.map(async (descriptor, index) =>
      await coordinators[index]!.bindDispatch("root", `call-${index}`, descriptor)));
    assert.equal(acquiredScopes.filter((scope) => scope.includes("sortie-dogs/parallel-dispatch-prepare")).length, 0);
    assert.ok(acquiredScopes.filter((scope) => scope.includes("sortie-dogs/parallel-dispatch-state")).length >= 5);
    assert.ok((await coordinator.snapshot("root", prepared.snapshot.run_id))!.tasks.every(({ phase }) => phase === "running"));
  } finally {
    for (const { registry, acquire } of patched) registry.acquire = acquire;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fabric bind fails closed when recovery state changes after its authority read", async () => {
  const value = await fixture("bind-recovery-race");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const units = [fabricUnit("a", 0), fabricUnit("b", 1)];
    const prepared = await coordinator.prepareFabric(fabricContract(value.sha, units), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    type MutableState = {
      run: null | { kind: string; fabric: null | { transition: unknown } };
    };
    const internal = coordinator as unknown as { load(): Promise<MutableState> };
    const originalLoad = internal.load.bind(coordinator);
    let loads = 0;
    internal.load = async () => {
      const state = await originalLoad();
      loads += 1;
      if (loads === 3 && state.run?.kind === "run" && state.run.fabric !== null) state.run.fabric.transition = {};
      return state;
    };
    await errorCode(coordinator.bindDispatch("root", "call-a", prepared.snapshot.ready[0]!), "outcome-conflict");
    internal.load = originalLoad;
    assert.equal((await coordinator.snapshot("root", prepared.snapshot.run_id))!.tasks[0]!.phase, "reserved");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an admitted fabric contract prepares one durable luna-fabric run", async () => {
  const value = await fixture("fabric-prepare");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const units = ["a", "b"].map((id, index) => fabricUnit(id, index));
    const prepared = await coordinator.prepareFabric(fabricContract(value.sha, units), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.snapshot.route, "luna-fabric");
    assert.equal(prepared.width, 2);
    assert.equal(prepared.depth, 1);
    assert.deepEqual(prepared.snapshot.fabric?.unit_acceptance.a, ["own a"]);
    assert.match(prepared.fabric_fingerprint, /^[0-9a-f]{64}$/u);
    assert.deepEqual(prepared.snapshot.ready.map(({ task_id }) => task_id), ["a", "b"]);
    assert.equal(new Set(prepared.snapshot.ready.map(({ managed_path }) => managed_path)).size, 2);
    assert.equal(prepared.snapshot.tasks.filter(({ artifact }) => artifact !== null).length, 0);
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

test("fabric preparation durably pins one coordinator execution plan and rejects resume drift", { timeout: 60_000 }, async () => {
  const value = await fixture("fabric-plan-binding");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const candidate = fabricContract(value.sha, [
      fabricUnit("a", 0, { acceptance_items: ["own-a"] }),
      fabricUnit("b", 1, { acceptance_items: ["own-b"] }),
    ]);
    const capsule = `sha256:${"c".repeat(64)}`;
    const acceptance = `sha256:${"b".repeat(64)}`;
    const compileInput = {
      version: "0.1",
      provenance: { producer: "dog-coordinator", acceptance_fingerprint: acceptance, capsule_inputs_exclude_secrets: true },
      unit_ids: ["a", "b"], declared_capsule_ids: [capsule],
      acceptance_items: ["a", "b"].map((id) => ({ acceptance_id: `own-${id}`, observable_criterion: `observe ${id}` })),
      validations: ["a", "b"].map((id) => ({ validation_id: `v-${id}`, unit_id: id, command_fingerprint: `sha256:${"d".repeat(64)}`, references: { capsule_ids: [capsule], artifact_ids: [] } })),
      coverage: ["a", "b"].map((id) => ({ acceptance_id: `own-${id}`, unit_id: id, validation_ids: [`v-${id}`] })),
    };
    const manifestFingerprint = executionPlanManifestFingerprint({ write: ["a.txt", "b.txt"] });
    const rejected = compileAcceptanceCoverage({ ...compileInput, coverage: [] });
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") return;
    assert.ok(rejected.gaps.some(({ code }) => code === "uncovered_acceptance"));
    assert.throws(() => createExecutionPlan(rejected, candidate, manifestFingerprint), {
      code: "compile-rejected",
    });
    assert.equal(await coordinator.snapshot("root"), undefined);
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1);
    const proposal = compileAcceptanceCoverage(compileInput);
    const plan = createExecutionPlan(proposal, candidate, manifestFingerprint);
    const prepared = await coordinator.prepareFabric(candidate, "root", plan);
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.plan_id, plan.plan_id);
    assert.equal(prepared.plan_binding_id, plan.binding_id);
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      run: { execution_plan: { binding_id: string }; plan_ledger: RunFlightEventRecord[] };
    };
    assert.equal(state.run.execution_plan.binding_id, plan.binding_id);
    assert.deepEqual(reconstructRunFlightLedger(state.run.plan_ledger).plan_decisions, [{
      plan_id: prepared.plan_id, proposal_id: plan.proposal_id, decision: "accepted", gap_codes: [],
    }]);
    assert.equal(reconstructRunFlightLedger(state.run.plan_ledger).budget_limits, null);
    const restarted = await openParallelCoordinator(value.repository);
    const resumed = await restarted.prepareFabric(candidate, "root", plan);
    assert.equal(resumed.status, "prepared");
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).run.plan_ledger, state.run.plan_ledger);
    const changed = structuredClone(plan);
    changed.operation_manifest_fingerprint = `sha256:${"e".repeat(64)}`;
    await errorCode(restarted.prepareFabric(candidate, "root", changed), "invalid-contract");
    const rebound = createExecutionPlan(proposal, candidate, executionPlanManifestFingerprint({ write: ["other.txt"] }));
    await errorCode(restarted.prepareFabric(candidate, "root", rebound), "active-run");
    const durable = await readFile(statePath, "utf8");
    for (const mutate of [
      (value: typeof state) => { value.run.plan_ledger = []; },
      (value: typeof state) => { value.run.plan_ledger[0]!.event_hash = `sha256:${"f".repeat(64)}`; },
    ]) {
      const corrupted = JSON.parse(durable) as typeof state;
      mutate(corrupted);
      await writeFile(statePath, JSON.stringify(corrupted));
      await errorCode(restarted.snapshot("root", prepared.snapshot.run_id), "corrupt-state");
      await writeFile(statePath, durable);
    }
    await restarted.cancel("root", prepared.snapshot.run_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("admission and unowned concurrent overlap route the fabric to Sol without a worktree", async () => {
  const value = await fixture("fabric-sol");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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

s01Test("a six-unit fabric advances only at the barrier into a fresh exact-base worktree", async (t) => {
  const value = await fixture("fabric-waves");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const units = ["a", "b", "c", "d", "e"].map((id, index) =>
      fabricUnit(id, index, { acceptance_items: [`own-${id}`] }));
    units.push(fabricUnit("f", 5, { depends_on: ["a"], acceptance_items: ["own-f"] }));
    const candidateContract = fabricContract(value.sha, units);
    const capsule = `sha256:${"c".repeat(64)}`;
    const proposal = compileAcceptanceCoverage({
      version: "0.1",
      provenance: { producer: "dog-coordinator", acceptance_fingerprint: `sha256:${"b".repeat(64)}`, capsule_inputs_exclude_secrets: true },
      unit_ids: units.map((unit) => unit.unit_id as string),
      declared_capsule_ids: [capsule],
      acceptance_items: units.map((unit) => ({ acceptance_id: (unit.acceptance_items as string[])[0]!, observable_criterion: `observe ${unit.unit_id as string}` })),
      validations: units.map((unit) => ({ validation_id: `v-${unit.unit_id as string}`, unit_id: unit.unit_id as string,
        command_fingerprint: `sha256:${"d".repeat(64)}`, references: { capsule_ids: [capsule], artifact_ids: [] } })),
      coverage: units.map((unit) => ({ acceptance_id: (unit.acceptance_items as string[])[0]!, unit_id: unit.unit_id as string,
        validation_ids: [`v-${unit.unit_id as string}`] })),
    });
    const plan = createExecutionPlan(proposal, candidateContract,
      executionPlanManifestFingerprint({ write: units.flatMap((unit) => unit.scope_write as string[]) }));
    const prepared = await coordinator.prepareFabric(candidateContract, "root", plan);
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.snapshot.fabric?.total_units, 6);
    assert.equal(prepared.snapshot.ready.length, 5);
    assert.equal(prepared.snapshot.tasks.some(({ descriptor }) => descriptor.task_id === "f"), false);
    const firstPaths = prepared.snapshot.ready.map(({ managed_path }) => managed_path);
    const firstBranches = prepared.snapshot.ready.map(({ branch }) => branch);
    await Promise.all(prepared.snapshot.ready.map(async (descriptor, index) =>
      await coordinator.bindDispatch("root", `call-${index}`, descriptor)));
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
    const beforeBatch = JSON.parse(await readFile(statePath, "utf8")) as { revision: number };
    const first = prepared.snapshot.ready[0]!;
    await writeFile(join(first.managed_path, "a.txt"), "a\n");
    const firstArtifact = await produceWorktreeCommitArtifact({
      descriptor: first, managed_path: first.managed_path, validation: gitDiffCheck,
    });
    const acceptedArtifactSnapshot = await coordinator.acceptArtifact("root", "call-0", "child-0", first, firstArtifact);
    assert.deepEqual(acceptedArtifactSnapshot.tasks
      .find(({ descriptor }) => descriptor.dispatch_id === first.dispatch_id)!.artifact, firstArtifact);
    const firstRestart = await openParallelCoordinator(value.repository);
    const replayed = await firstRestart.acceptArtifact("root", "call-0", "child-0", first, firstArtifact);
    assert.deepEqual(replayed.tasks.find(({ descriptor }) => descriptor.dispatch_id === first.dispatch_id)!.artifact, firstArtifact);
    await errorCode(firstRestart.acceptArtifact("root", "call-0", "other-child", first, firstArtifact), "outcome-conflict");
    await errorCode(firstRestart.acceptArtifact("root", "call-0", "child-0", first, {
      ...firstArtifact, change_fingerprint: "f".repeat(64),
    }), "outcome-conflict");
    await errorCode(firstRestart.acceptArtifact("root", "call-0", "child-0", {
      ...first, base_sha: "f".repeat(40),
    }, firstArtifact), "descriptor-mismatch");
    await firstRestart.completeCall("root", "call-0", "child-0", "completed", {
      run_id: first.run_id, dispatch_id: first.dispatch_id,
    });
    await errorCode(firstRestart.completeCall("root", "call-0", "child-0", "failed", {
      run_id: first.run_id, dispatch_id: first.dispatch_id,
    }), "outcome-conflict");
    const firstWave = await acceptAndCompleteMany(firstRestart, prepared.snapshot.ready.slice(1).map((descriptor, index) => ({
      descriptor,
      callID: `call-${index + 1}`,
      childSessionID: `child-${index + 1}`,
    })));
    const afterBatch = JSON.parse(await readFile(statePath, "utf8")) as {
      revision: number;
      run: { tasks: Array<{ phase: string; artifact: unknown }> };
    };
    assert.equal(afterBatch.revision, beforeBatch.revision + 6);
    assert.ok(afterBatch.run.tasks.every(({ phase, artifact }) => phase === "completed" && artifact !== null));
    assert.ok(firstWave.every(({ snapshot }) =>
      snapshot!.tasks.some(({ descriptor: task }) => task.task_id === "f") === false));
    for (const path of firstPaths) assert.notEqual(await stat(path).catch(() => undefined), undefined);
    const counter = join(value.root, "must-not-run.txt");
    const candidateBuilder = firstRestart as unknown as {
      buildFabricCandidate(runID: string, base: string, tasks: readonly unknown[]): Promise<string>;
    };
    const originalBuildFabricCandidate = candidateBuilder.buildFabricCandidate.bind(firstRestart);
    let buildFabricCandidateCalls = 0;
    candidateBuilder.buildFabricCandidate = async (...args) => {
      buildFabricCandidateCalls += 1;
      return await originalBuildFabricCandidate(...args);
    };
    const advanced = await firstRestart.integrateFabricWaveAndValidate(
      "root", prepared.snapshot.run_id, process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", counter],
    );
    assert.equal(buildFabricCandidateCalls, 1);
    candidateBuilder.buildFabricCandidate = originalBuildFabricCandidate;
    const candidate = advanced.fabric!.candidate_head;
    const firstBoundaryState = JSON.parse(await readFile(statePath, "utf8")) as { run: { plan_ledger: RunFlightEventRecord[] } };
    const firstBoundary = reconstructRunFlightLedger(firstBoundaryState.run.plan_ledger);
    assert.equal(firstBoundary.accepted_fabric_waves.length, 1);
    assert.equal(firstBoundary.accepted_fabric_waves[0]!.candidate_id, candidate);
    assert.deepEqual(firstBoundary.accepted_fabric_waves[0]!.artifacts.map(({ unit_id }) => unit_id), ["a", "b", "c", "d", "e"]);
    const firstReplay = await firstRestart.inspectFabricWaveBoundaryReplay("root", prepared.snapshot.run_id);
    assert.equal(firstReplay?.reason, "latest_accepted_boundary");
    assert.equal(firstReplay?.route, "luna-fabric");
    assert.deepEqual(firstReplay?.plan, plan);
    assert.deepEqual(firstReplay?.plan_decisions.map(({ plan_id, decision }) => ({ plan_id, decision })), [
      { plan_id: plan.plan_id, decision: "accepted" },
    ]);
    assert.deepEqual(firstReplay?.scheduler, firstBoundary.accepted_fabric_waves[0]!.scheduler_after);
    assert.deepEqual(firstReplay?.artifacts, firstBoundary.accepted_fabric_waves[0]!.artifacts);
    assert.deepEqual(firstReplay?.candidate_snapshot, firstBoundary.accepted_fabric_waves[0]!.candidate_snapshot);
    assert.equal(firstReplay?.recovery_budget.budget_limits, null);
    let nonFinalVerified = false;
    await t.test("integrateFabricWaveAndValidate advances non-final waves without running supplied validation", async () => {
      assert.equal(advanced.archived, false);
      assert.deepEqual(advanced.ready.map(({ task_id }) => task_id), ["f"]);
      assert.equal(new Set(advanced.ready.map(({ managed_path }) => managed_path)).size, 1);
      assert.equal(advanced.ready[0]!.base_sha, candidate);
      assert.equal(firstPaths.includes(advanced.ready[0]!.managed_path), false);
      assert.equal(advanced.ready[0]!.parallel_units, 1);
      assert.equal(advanced.fabric!.validation.status, "pending");
      await assert.rejects(stat(counter));
      nonFinalVerified = true;
    });
    assert.equal(nonFinalVerified, true);
    for (const path of firstPaths) assert.equal(await stat(path).catch(() => undefined), undefined);
    for (const branch of firstBranches) {
      assert.equal(await stat(join(value.repository, ".git", "refs", "heads", ...branch.split("/"))).catch(() => undefined), undefined);
    }
    assert.equal((await readFile(join(value.repository, ".git", "HEAD"), "utf8")).trim(), "ref: refs/heads/main");
    assert.equal((await readFile(join(value.repository, ".git", "refs", "heads", "main"), "utf8")).trim(), value.sha);

    let restarted!: ParallelDispatchCoordinator;
    await t.test("automatic boundary recovery is read-only and rejects a corrupt ledger before resuming", async () => {
      const savedState = await readFile(statePath, "utf8");
      const worktrees = await run(value.repository, "worktree", "list", "--porcelain");
      const recovery = await openParallelCoordinator(value.repository);
      const recovered = await recovery.snapshot("root", prepared.snapshot.run_id);
      assert.deepEqual(recovered, advanced);
      assert.deepEqual(await recovery.inspectFabricWaveBoundaryReplay("root", prepared.snapshot.run_id), firstReplay);
      assert.equal(await readFile(statePath, "utf8"), savedState);
      assert.equal(await run(value.repository, "worktree", "list", "--porcelain"), worktrees);
      assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);

      const corrupted = JSON.parse(savedState);
      corrupted.run.plan_ledger.reverse();
      const corruptedState = JSON.stringify(corrupted);
      try {
        await writeFile(statePath, corruptedState);
        await errorCode(recovery.snapshot("root", prepared.snapshot.run_id), "corrupt-state");
        assert.equal(await readFile(statePath, "utf8"), corruptedState);
        assert.equal(await run(value.repository, "worktree", "list", "--porcelain"), worktrees);
        assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);
      } finally {
        await writeFile(statePath, savedState);
      }
    });
    await t.test("restart replays the next wave and integrates its verified artifact once", async () => {
      restarted = await openParallelCoordinator(value.repository);
      const singleton = advanced.ready[0]!;
      await restarted.bindDispatch("root", "call-f", singleton);
      await acceptAndComplete(restarted, singleton, "call-f", "child-f");
      await restarted.integrateFabricWave("root", prepared.snapshot.run_id);
    });
    const validated = await restarted.integrateFabricWaveAndValidate(
      "root", prepared.snapshot.run_id, process.execPath,
      ["-e", "if(require('node:fs').readFileSync('f.txt','utf8').trim()!=='f')process.exitCode=1"],
    );
    let finalVerified = false;
    const reopenedBoundaryState = JSON.parse(await readFile(statePath, "utf8")) as { run: { plan_ledger: RunFlightEventRecord[] } };
    const reopenedBoundaries = reconstructRunFlightLedger(reopenedBoundaryState.run.plan_ledger).accepted_fabric_waves;
    assert.equal(reopenedBoundaries.length, 2);
    assert.equal(reopenedBoundaries[1]!.from_candidate_id, candidate);
    assert.equal(reopenedBoundaries[1]!.candidate_id, validated.fabric!.candidate_head);
    assert.deepEqual(reopenedBoundaries[1]!.artifacts.map(({ unit_id }) => unit_id), ["f"]);
    const automaticReplay = await restarted.inspectFabricWaveBoundaryReplay("root", prepared.snapshot.run_id);
    const diagnosticReplay = await restarted.inspectFabricWaveBoundaryReplay(
      "root", prepared.snapshot.run_id, firstReplay!.boundary_event_hash,
    );
    assert.equal(automaticReplay?.reason, "latest_accepted_boundary");
    assert.equal(automaticReplay?.candidate_snapshot.candidate_head, validated.fabric!.candidate_head);
    assert.equal(diagnosticReplay?.reason, "diagnostic_override");
    assert.equal(diagnosticReplay?.candidate_snapshot.candidate_head, candidate);
    assert.equal((await readFile(join(value.repository, ".git", "refs", "heads", "main"), "utf8")).trim(), value.sha);
    assert.equal(validated.ready.length, 0);
    await t.test("integrateFabricWaveAndValidate integrates the final wave and validates without changing target", () => {
      assert.equal(validated.fabric!.active_unit_ids.length, 0);
      assert.equal(validated.fabric!.validation.status, "pass");
      assert.notEqual(validated.fabric!.candidate_head, value.sha);
      finalVerified = true;
    });
    assert.equal(finalVerified, true);
    assert.equal((await readFile(join(value.repository, ".git", "refs", "heads", "main"), "utf8")).trim(), value.sha);
    await writeFile(join(value.repository, ".git", "HEAD"), `${value.sha}\n`);
    const accepted = await restarted.acceptFabricCandidate(
      "root", prepared.snapshot.run_id, validated.fabric!.candidate_head, "skip", "f".repeat(64),
    );
    assert.equal(accepted.archived, true);
    assert.equal(accepted.terminal_reason, "completed");
    assert.equal(
      (await readFile(join(value.repository, ".git", "refs", "heads", "main"), "utf8")).trim(),
      validated.fabric!.candidate_head,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fabric claims validation once and resumes acceptance after a completed target CAS", async (t) => {
  const value = await fixture("fabric-promote");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const units = [fabricUnit("a", 0), fabricUnit("b", 1)];
    const prepared = await coordinator.prepareFabric(fabricContract(value.sha, units), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await errorCode(coordinator.integrateFabricWave("root", prepared.snapshot.run_id), "wave-not-ready");
    await completeReadyArtifacts(coordinator, prepared.snapshot.ready);

    const integrated = await coordinator.integrateFabricWave("root", prepared.snapshot.run_id);
    const candidate = integrated.fabric!.candidate_head;
    assert.notEqual(candidate, value.sha);
    assert.equal(integrated.fabric!.candidate_ref.startsWith("refs/sortie-dogs/luna-fabric-candidates/"), true);
    assert.equal((await run(value.repository, "rev-parse", integrated.fabric!.candidate_ref)).trim(), candidate);
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);
    assert.equal((await run(value.repository, "show", `${candidate}:a.txt`)).trim(), "a");
    assert.equal((await run(value.repository, "show", `${candidate}:b.txt`)).trim(), "b");

    const validationCount = join(value.root, "validation-count.txt");
    const validationArgs = ["-e", "const fs=require('node:fs');fs.appendFileSync(process.argv[1],'x');setTimeout(()=>{if(fs.readFileSync('a.txt','utf8').trim()!=='a'||fs.readFileSync('b.txt','utf8').trim()!=='b')process.exitCode=1},250)", validationCount];
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      revision: number;
      run: { fabric: { validation: { command: string[]; status: string; fingerprint: string | null } } };
    };
    state.revision += 1;
    state.run.fabric.validation = { command: [process.execPath, ...validationArgs], status: "running", fingerprint: null };
    await writeFile(statePath, JSON.stringify(state));
    const validation = () => coordinator.validateFabricCandidate(
      "root", prepared.snapshot.run_id, process.execPath, validationArgs,
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
    await t.test("integrateFabricWaveAndValidate reclaims an interrupted durable validation and replays exactly once", async () => {
      const replayed = await coordinator.integrateFabricWaveAndValidate(
        "root", prepared.snapshot.run_id, process.execPath, validationArgs,
      );
      assert.equal(replayed.fabric!.validation.status, "pass");
      assert.equal(await readFile(validationCount, "utf8"), "x");
    });
    await errorCode(coordinator.validateFabricCandidate(
      "root", prepared.snapshot.run_id, process.execPath, ["-e", "process.exit(9)"],
    ), "outcome-conflict");

    const targetBeforeRejectedPromotion = (await run(value.repository, "rev-parse", "refs/heads/main")).trim();
    const indexBeforeRejectedPromotion = (await run(value.repository, "write-tree")).trim();
    const worktreeBeforeRejectedPromotion = await run(value.repository, "status", "--porcelain=v1");
    await errorCode(coordinator.acceptFabricCandidate(
      "root", prepared.snapshot.run_id, candidate, "skip", "d".repeat(64),
    ), "candidate-invalid");
    const retained = await coordinator.snapshot("root", prepared.snapshot.run_id);
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), targetBeforeRejectedPromotion);
    assert.equal((await run(value.repository, "write-tree")).trim(), indexBeforeRejectedPromotion);
    assert.equal(await run(value.repository, "status", "--porcelain=v1"), worktreeBeforeRejectedPromotion);
    assert.equal((await run(value.repository, "rev-parse", integrated.fabric!.candidate_ref)).trim(), candidate);
    assert.equal(retained?.fabric?.candidate_head, candidate);
    assert.equal(retained?.fabric?.candidate_ref, integrated.fabric!.candidate_ref);
    assert.equal(retained?.fabric?.promoted, false);
    assert.equal(retained?.fabric?.review.status, "pending");

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

test("failed fabric target promotion releases its review claim for cancellation", async () => {
  const value = await fixture("fabric-promotion-conflict");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await completeReadyArtifacts(coordinator, prepared.snapshot.ready);
    const validated = await coordinator.integrateFabricWaveAndValidate(
      "root", prepared.snapshot.run_id, process.execPath, ["-e", "process.exit(0)"],
    );
    const candidate = validated.fabric!.candidate_head;

    await run(value.repository, "checkout", "--detach", value.sha);
    await writeFile(join(value.repository, "base.txt"), "moved\n");
    await run(value.repository, "add", "base.txt");
    await commit(value.repository, "-q", "-m", "move target");
    const moved = (await run(value.repository, "rev-parse", "HEAD")).trim();
    await run(value.repository, "checkout", "--detach", value.sha);
    await run(value.repository, "update-ref", "refs/heads/main", moved, value.sha);

    await errorCode(coordinator.acceptFabricCandidate(
      "root", prepared.snapshot.run_id, candidate, "pass", "d".repeat(64),
    ), "candidate-invalid");
    assert.equal((await coordinator.snapshot("root", prepared.snapshot.run_id))!.fabric!.review.status, "pending");
    const cancelled = await coordinator.cancel("root", prepared.snapshot.run_id);
    assert.equal(cancelled?.archived, true);
    assert.equal(cancelled?.terminal_reason, "cancelled");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fabric operation authority heartbeats throughout validation", async () => {
  const value = await fixture("fabric-validation-heartbeat");
  let registry: ScopeLeaseRegistry | undefined;
  let originalAcquire: ScopeLeaseRegistry["acquire"] | undefined;
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await completeReadyArtifacts(coordinator, prepared.snapshot.ready);
    await coordinator.integrateFabricWave("root", prepared.snapshot.run_id);
    registry = (coordinator as unknown as { registry: ScopeLeaseRegistry }).registry;
    originalAcquire = registry.acquire.bind(registry);
    registry.acquire = async (...args: Parameters<ScopeLeaseRegistry["acquire"]>) =>
      await originalAcquire!({ ...args[0], ttlMs: 2_000 });
    const started = join(value.root, "validation-started.txt");
    const validation = coordinator.validateFabricCandidate(
      "root", prepared.snapshot.run_id, process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'x');setTimeout(()=>{},5000)", started],
    );
    while (await stat(started).catch(() => undefined) === undefined) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
    await assert.rejects(
      registry.acquire({ scope: { read: [], write: ["sortie-dogs/luna-fabric-operation"] }, ttlMs: 2_000 }),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "scope-conflict",
    );
    assert.equal((await validation).fabric!.validation.status, "pass");
  } finally {
    if (registry !== undefined && originalAcquire !== undefined) registry.acquire = originalAcquire;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed fabric validation archives cleanly and releases the active slot", async () => {
  const value = await fixture("fabric-validation-fail");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const candidateContract = fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]);
    const prepared = await coordinator.prepareFabric(candidateContract, "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await completeReadyArtifacts(coordinator, prepared.snapshot.ready);
    const integrated = await coordinator.integrateFabricWave("root", prepared.snapshot.run_id);
    const failed = await coordinator.validateFabricCandidate(
      "root", prepared.snapshot.run_id, process.execPath,
      ["-e", "require('node:fs').writeFileSync('validation-dirty.txt','dirty');process.exit(7)"],
    );
    assert.equal(failed.archived, true);
    assert.equal(failed.terminal_reason, "failed");
    assert.equal(failed.fabric!.validation.status, "fail");
    await assert.rejects(run(value.repository, "rev-parse", "--verify", integrated.fabric!.candidate_ref));
    assert.equal((await run(value.repository, "for-each-ref", "--format=%(refname)",
      "refs/sortie-dogs/luna-fabric-sources/")).trim(), "");
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1);
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);
    const next = await coordinator.prepareFabric(candidateContract, "root-next");
    assert.equal(next.status, "prepared");
    if (next.status === "prepared") await coordinator.cancel("root-next", next.snapshot.run_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed fabric review archives cleanly without moving the target", async () => {
  const value = await fixture("fabric-review-fail");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await completeReadyArtifacts(coordinator, prepared.snapshot.ready);
    const validated = await coordinator.integrateFabricWaveAndValidate(
      "root", prepared.snapshot.run_id, process.execPath, ["-e", "process.exit(0)"],
    );
    const rejected = await coordinator.acceptFabricCandidate(
      "root", prepared.snapshot.run_id, validated.fabric!.candidate_head, "fail", "a".repeat(64),
    );
    assert.equal(rejected.archived, true);
    assert.equal(rejected.terminal_reason, "failed");
    assert.equal(rejected.fabric!.review.status, "fail");
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);
    await assert.rejects(run(value.repository, "rev-parse", "--verify", validated.fabric!.candidate_ref));
    assert.equal((await run(value.repository, "for-each-ref", "--format=%(refname)",
      "refs/sortie-dogs/luna-fabric-sources/")).trim(), "");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrateFabricWaveAndValidate rejects a relative executable before wave mutation", async () => {
  const value = await fixture("fabric-combined-invalid");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await completeReadyArtifacts(coordinator, prepared.snapshot.ready);
    const before = await coordinator.snapshot("root", prepared.snapshot.run_id);
    await errorCode(
      coordinator.integrateFabricWaveAndValidate("root", prepared.snapshot.run_id, "node"),
      "invalid-contract",
    );
    assert.deepEqual(await coordinator.snapshot("root", prepared.snapshot.run_id), before);
    const integrated = await coordinator.integrateFabricWave("root", prepared.snapshot.run_id);
    assert.equal(integrated.fabric!.validation.status, "pending");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrateFabricWaveAndValidate retries validation after final integration response loss", async () => {
  const value = await fixture("fabric-combined-retry-integration");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    await completeReadyArtifacts(coordinator, prepared.snapshot.ready);
    const integrated = await coordinator.integrateFabricWave("root", prepared.snapshot.run_id);
    const retried = await coordinator.integrateFabricWaveAndValidate(
      "root", prepared.snapshot.run_id, process.execPath, ["-e", "process.exit(0)"],
    );
    assert.equal(retried.fabric!.candidate_head, integrated.fabric!.candidate_head);
    assert.equal(retried.fabric!.validation.status, "pass");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a failed Luna unit demotes once to a fresh Sol worktree and joins the same hidden candidate", async () => {
  const value = await fixture("fabric-demotion");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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

    const restarted = await openParallelCoordinator(value.repository);
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
  let injected = true;
  let restoreLifecycle = (): void => {};
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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
    const lifecycle = lifecycleOf(coordinator);
    const original = lifecycle.createManyAtBase;
    lifecycle.createManyAtBase = async (...args): Promise<Awaited<ReturnType<typeof original>>> => {
      const managed = await original.apply(lifecycle, args);
      if (injected) { injected = false; throw new Error("injected demotion exit"); }
      return managed;
    };
    restoreLifecycle = () => { lifecycle.createManyAtBase = original; };
    await errorCode(coordinator.demoteFailedFabricUnit("root", prepared.snapshot.run_id, "a"), "lifecycle-failed");
    restoreLifecycle();

    const restarted = await openParallelCoordinator(value.repository);
    const recovered = await restarted.snapshot("root", prepared.snapshot.run_id);
    assert.deepEqual(recovered!.ready.map(({ task_id, attempt }) => ({ task_id, attempt })), [{ task_id: "a", attempt: 2 }]);
    assert.equal(recovered!.fabric!.demotions.length, 1);
  } finally {
    restoreLifecycle();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("live critical takeover stops only its source and durably resumes one attempt-2 descriptor", async () => {
  const value = await fixture("fabric-live-takeover");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepareFabric(
      fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root",
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [source, sibling] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "call-a", source!);
    await coordinator.bindDispatch("root", "call-b", sibling!);
    const acceptedSibling = await acceptAndComplete(coordinator, sibling!, "call-b", "child-b");
    const siblingPath = sibling!.managed_path;
    const sourceIdentity = {
      run_id: source!.run_id, unit_id: source!.task_id, attempt_id: source!.dispatch_id,
      predecessor_attempt_id: null, candidate_id: source!.base_sha, route_id: source!.parallel_group,
      child_id: "child-a", call_id: "call-a",
    };
    const ledger = await coordinator.childLedger("root", source!, "call-a", "child-a");
    let stopped = false;
    const evidence = (): ChildTerminalEvidence => ({
      terminal: stopped ? "satisfied" : "unsatisfied",
      tools_quiescent: stopped ? "satisfied" : "unsatisfied",
      artifact_window_closed: "satisfied", gate_released: "satisfied", lease_released: "satisfied",
      writer_released: "satisfied", worktree_released: "satisfied",
    });
    const lifecycle = await CancellableChildLifecycle.open({ identity: sourceIdentity, deadline_ms: Date.now() + 60_000 }, ledger, {
      observe: async () => ({ observation: { identity: sourceIdentity, disposition: "cancelled" }, evidence: evidence() }),
      stop: async () => { stopped = true; },
      release: async () => { await coordinator.releaseChildWorktree("root", source!, "call-a", "child-a", evidence()); },
      terminal: async () => { await coordinator.completeCall("root", "call-a", "child-a", "cancelled"); },
    });
    const observation = { active_takeover_count: 0, units: [
      { unit_id: "a", depends_on: [], state: "active", executor: "luna", deadline: "deadline_exceeded", failures: "not_repeated" },
      { unit_id: "b", depends_on: [], state: "completed", executor: "luna", deadline: "within_deadline", failures: "not_repeated" },
    ] } as const;
    let taken = await coordinator.takeoverCriticalFabricUnit("root", source!.run_id, observation, sourceIdentity, lifecycle);
    const finishBy = Date.now() + 60_000;
    while (taken.status === "waiting" && Date.now() < finishBy) {
      taken = await coordinator.takeoverCriticalFabricUnit("root", source!.run_id, observation, sourceIdentity, lifecycle);
    }
    assert.equal(taken.status, "taken-over");
    assert.equal(taken.trigger, "live_deadline_exceeded");
    assert.deepEqual(taken.snapshot.ready.map(({ task_id, attempt, base_sha }) => ({ task_id, attempt, base_sha })), [
      { task_id: "a", attempt: 2, base_sha: prepared.snapshot.fabric!.candidate_head },
    ]);
    assert.equal(await stat(source!.managed_path).catch(() => undefined), undefined);
    assert.equal(await stat(siblingPath).catch(() => undefined), undefined);
    const retainedSibling = taken.snapshot.tasks.find(({ descriptor }) => descriptor.task_id === "b")!;
    assert.equal(retainedSibling.phase, "completed");
    assert.equal(retainedSibling.outcome, "completed");
    assert.deepEqual(retainedSibling.artifact, acceptedSibling.artifact);
    assert.equal((await run(value.repository, "rev-parse", `${acceptedSibling.artifact.commit_sha}^{commit}`)).trim(),
      acceptedSibling.artifact.commit_sha);
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);
    const reopened = await openParallelCoordinator(value.repository);
    const replay = await reopened.takeoverCriticalFabricUnit("root", source!.run_id, observation, sourceIdentity, lifecycle);
    assert.equal(replay.status, "taken-over");
    if (replay.status === "taken-over") assert.deepEqual(replay.snapshot.ready, taken.snapshot.ready);
    await reopened.cancel("root", source!.run_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("deadline takeover resumes from the last accepted candidate and completes one reviewed CAS", async () => {
  const profileStarted = performance.now();
  const stages: Array<{ name: string; duration_ms: number; total_ms: number }> = [];
  const stage = async <T>(name: string, action: () => T | Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await action();
    } finally {
      const now = performance.now();
      stages.push({ name, duration_ms: now - started, total_ms: now - profileStarted });
    }
  };
  let takeoverCalls = 0;
  let takeoverLoopIterations = 0;
  const value = await stage("fixture-setup", async () => await fixture("fabric-live-takeover-after-wave"));
  try {
    const coordinator = await stage("coordinator-open", async () => await openParallelCoordinator(value.repository));
    const units = [
      fabricUnit("seed", 0),
      fabricUnit("critical", 1, { depends_on: ["seed"] }),
      fabricUnit("sibling", 2, { depends_on: ["seed"] }),
      fabricUnit("final", 3, { depends_on: ["critical", "sibling"] }),
    ];
    const prepared = await stage("dag-prepare", async () =>
      await coordinator.prepareFabric(fabricContract(value.sha, units), "root"));
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const seed = prepared.snapshot.ready[0]!;
    await stage("bind-seed", async () => await coordinator.bindDispatch("root", "call-seed", seed));
    await stage("accept-seed", async () => await acceptAndComplete(coordinator, seed, "call-seed", "child-seed"));
    const firstWave = await stage("integrate-wave1", async () =>
      await coordinator.integrateFabricWave("root", prepared.snapshot.run_id));
    const acceptedBase = firstWave.fabric!.candidate_head;
    assert.notEqual(acceptedBase, value.sha);

    const source = firstWave.ready.find(({ task_id }) => task_id === "critical")!;
    const sibling = firstWave.ready.find(({ task_id }) => task_id === "sibling")!;
    assert.equal(source.base_sha, acceptedBase);
    await stage("bind-critical", async () => await coordinator.bindDispatch("root", "call-critical", source));
    await stage("bind-sibling", async () => await coordinator.bindDispatch("root", "call-sibling", sibling));
    const acceptedSibling = await stage("accept-sibling", async () =>
      await acceptAndComplete(coordinator, sibling, "call-sibling", "child-sibling"));
    const sourceIdentity = { run_id: source.run_id, unit_id: source.task_id, attempt_id: source.dispatch_id,
      predecessor_attempt_id: null, candidate_id: source.base_sha, route_id: source.parallel_group,
      child_id: "child-critical", call_id: "call-critical" };
    const ledger = await coordinator.childLedger("root", source, "call-critical", "child-critical");
    let stopped = false;
    const evidence = (): ChildTerminalEvidence => ({ terminal: stopped ? "satisfied" : "unsatisfied",
      tools_quiescent: stopped ? "satisfied" : "unsatisfied", artifact_window_closed: "satisfied",
      gate_released: "satisfied", lease_released: "satisfied", writer_released: "satisfied", worktree_released: "satisfied" });
    const lifecycle = await stage("lifecycle-open", async () => await CancellableChildLifecycle.open({ identity: sourceIdentity, deadline_ms: Date.now() - 1 }, ledger, {
      observe: async () => ({ observation: { identity: sourceIdentity, disposition: "cancelled" }, evidence: evidence() }),
      stop: async () => { stopped = true; },
      release: async () => { await coordinator.releaseChildWorktree("root", source, "call-critical", "child-critical", evidence()); },
      // Live takeover owns the durable failed transition after lifecycle terminal confirmation.
      terminal: async () => {},
    }));
    const observation = await stage("critical-path-input", async () =>
      await coordinator.criticalPathInput("root", source.run_id, sourceIdentity));
    takeoverCalls += 1;
    let takeover = await stage(`takeover-call-${takeoverCalls}`, async () =>
      await coordinator.takeoverCriticalFabricUnit("root", source.run_id, observation, sourceIdentity, lifecycle));
    const finishBy = Date.now() + 60_000;
    while (takeover.status === "waiting" && Date.now() < finishBy) {
      takeoverLoopIterations += 1;
      takeoverCalls += 1;
      takeover = await stage(`takeover-call-${takeoverCalls}`, async () =>
        await coordinator.takeoverCriticalFabricUnit("root", source.run_id, observation, sourceIdentity, lifecycle));
    }
    assert.equal(takeover.status, "taken-over");
    if (takeover.status !== "taken-over") return;
    assert.equal(takeover.trigger, "live_deadline_exceeded");
    const sol = takeover.snapshot.ready.find(({ task_id }) => task_id === "critical")!;
    assert.equal(sol.attempt, 2);
    assert.equal(sol.base_sha, acceptedBase);
    assert.deepEqual(sol.scope_read, source.scope_read);
    assert.deepEqual(sol.scope_write, source.scope_write);
    assert.deepEqual(takeover.snapshot.tasks.find(({ descriptor }) => descriptor.task_id === "sibling")!.artifact,
      acceptedSibling.artifact);
    const replay = await stage("replay-takeover", async () =>
      await coordinator.takeoverCriticalFabricUnit("root", source.run_id, observation, sourceIdentity, lifecycle));
    assert.equal(replay.status, "taken-over");
    assert.equal(takeover.snapshot.fabric!.demotions.length, 1);

    await stage("bind-sol", async () => await coordinator.bindDispatch("root", "call-sol", sol));
    await stage("accept-sol", async () => await acceptAndComplete(coordinator, sol, "call-sol", "child-sol"));
    const secondWave = await stage("integrate-wave2", async () =>
      await coordinator.integrateFabricWave("root", source.run_id));
    const final = secondWave.ready.find(({ task_id }) => task_id === "final")!;
    await stage("bind-final", async () => await coordinator.bindDispatch("root", "call-final", final));
    await stage("accept-final", async () => await acceptAndComplete(coordinator, final, "call-final", "child-final"));
    const validated = await stage("integrate-validate", async () => await coordinator.integrateFabricWaveAndValidate(
      "root", source.run_id, process.execPath, ["-e", "process.exit(0)"],
    ));
    assert.equal(validated.fabric!.validation.status, "pass");
    assert.equal((await run(value.repository, "rev-parse", "refs/heads/main")).trim(), value.sha);
    await stage("detach", async () => await run(value.repository, "checkout", "--detach", value.sha));
    const accepted = await stage("accept-cas", async () => await coordinator.acceptFabricCandidate(
      "root", source.run_id, validated.fabric!.candidate_head, "pass", "a".repeat(64),
    ));
    assert.equal(accepted.terminal_reason, "completed");
    assert.equal(accepted.fabric!.promoted, true);
    await stage("replay-assertions", async () => {
      assert.deepEqual(await coordinator.acceptFabricCandidate(
        "root", source.run_id, validated.fabric!.candidate_head, "pass", "a".repeat(64),
      ), accepted);
      await assert.rejects(coordinator.acceptFabricCandidate(
        "root", source.run_id, validated.fabric!.candidate_head, "pass", "b".repeat(64),
      ), { code: "outcome-conflict" });
      assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1);
    });
  } finally {
    await stage("cleanup", async () => await rm(value.root, { recursive: true, force: true }));
    console.log("SORTIE_DEADLINE_PROFILE", JSON.stringify({
      schema_version: 1,
      case: "deadline takeover resumes from the last accepted candidate and completes one reviewed CAS",
      total_ms: performance.now() - profileStarted,
      takeover_calls: takeoverCalls,
      takeover_loop_iterations: takeoverLoopIterations,
      stages,
    }));
  }
});

test("failure suppresses descendants while independent work continues and cancellation is bounded", async () => {
  const value = await fixture("failure");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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
    const coordinator = await openParallelCoordinator(value.repository);
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
    const first = await openParallelCoordinator(value.repository);
    const prepared = await first.prepare(contract(value.sha, [[], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const descriptor = prepared.snapshot.ready[0]!;
    await first.bindDispatch("root", "host-call", descriptor);

    const restarted = await openParallelCoordinator(value.repository);
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
    const coordinator = await openParallelCoordinator(value.repository);
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
      openParallelCoordinator(value.repository),
      openParallelCoordinator(value.repository),
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
  let injected = true;
  let restoreLifecycle = (): void => {};
  try {
    const candidate = contract(value.sha, [[], []]);
    const first = await openParallelCoordinator(value.repository);
    const lifecycle = lifecycleOf(first);
    const original = lifecycle.createMany;
    lifecycle.createMany = async (...args): Promise<Awaited<ReturnType<typeof original>>> => {
      const managed = await original.apply(lifecycle, args);
      if (injected) {
        injected = false;
        throw new Error("injected process exit after lifecycle create");
      }
      return managed;
    };
    restoreLifecycle = () => { lifecycle.createMany = original; };
    await assert.rejects(first.prepare(candidate, "root"), /injected process exit/u);
    const before = await run(value.repository, "worktree", "list", "--porcelain");
    assert.equal(before.match(/^worktree /gmu)?.length, 3);

    const restarted = await openParallelCoordinator(value.repository);
    const prepared = await restarted.prepare(candidate, "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.equal(prepared.snapshot.tasks.length, 2);
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")), before);
  } finally {
    restoreLifecycle();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("terminal and cancelled runs archive ownership and release the active slot", async () => {
  const value = await fixture("archive");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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
    const coordinator = await openParallelCoordinator(value.repository);
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
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepare(contract(value.sha, [[], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [first, second] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "call-a", first!);
    await writeFile(join(first!.managed_path, "a.txt"), "accepted\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor: first!,
      managed_path: first!.managed_path,
      validation: gitDiffCheck,
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

    const restarted = await openParallelCoordinator(value.repository);
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
  let lifecycleCalls = 0;
  const restoreLifecycles: Array<() => void> = [];
  const injectLifecycle = (coordinator: ParallelDispatchCoordinator): void => {
    const lifecycle = lifecycleOf(coordinator);
    const original = lifecycle.acceptCommit;
    lifecycle.acceptCommit = async (...args): Promise<void> => {
      lifecycleCalls += 1;
      if (lifecycleCalls === 1) throw new Error("injected process exit before lifecycle acceptance");
      await original.apply(lifecycle, args);
      if (lifecycleCalls === 3 || lifecycleCalls === 5) throw new Error("injected process exit after lifecycle acceptance");
    };
    restoreLifecycles.push(() => { lifecycle.acceptCommit = original; });
  };
  try {
    const coordinator = await openParallelCoordinator(value.repository);
    injectLifecycle(coordinator);
    const prepared = await coordinator.prepare(contract(value.sha, [[], [], []]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const [first, second, third] = prepared.snapshot.ready;
    await coordinator.bindDispatch("root", "call-a", first!);
    await writeFile(join(first!.managed_path, "a.txt"), "first\n");
    const firstArtifact = await produceWorktreeCommitArtifact({
      descriptor: first!, managed_path: first!.managed_path,
      validation: gitDiffCheck,
    });
    await errorCode(coordinator.acceptArtifact("root", "call-a", "child-a", first!, firstArtifact), "lifecycle-failed");
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
    const provisional = JSON.parse(await readFile(statePath, "utf8")) as {
      run: { tasks: Array<{ artifact: unknown; artifact_accepted: boolean }> };
    };
    assert.deepEqual(provisional.run.tasks[0]!.artifact, firstArtifact);
    assert.equal(provisional.run.tasks[0]!.artifact_accepted, false);

    await coordinator.acceptArtifact("root", "call-a", "child-a", first!, firstArtifact);
    const restarted = await openParallelCoordinator(value.repository);
    injectLifecycle(restarted);
    await restarted.completeCall("root", "call-a", "child-a", "completed", {
      run_id: first!.run_id, dispatch_id: first!.dispatch_id,
    });

    await restarted.bindDispatch("root", "call-b", second!);
    await writeFile(join(second!.managed_path, "b.txt"), "second\n");
    const secondArtifact = await produceWorktreeCommitArtifact({
      descriptor: second!, managed_path: second!.managed_path,
      validation: gitDiffCheck,
    });
    await errorCode(restarted.acceptArtifact("root", "call-b", "child-b", second!, secondArtifact), "lifecycle-failed");
    const secondRestart = await openParallelCoordinator(value.repository);
    injectLifecycle(secondRestart);
    await secondRestart.acceptArtifact("root", "call-b", "child-b", second!, secondArtifact);
    await secondRestart.completeCall("root", "call-b", "child-b", "completed", {
      run_id: second!.run_id, dispatch_id: second!.dispatch_id,
    });

    await secondRestart.bindDispatch("root", "call-c", third!);
    await writeFile(join(third!.managed_path, "c.txt"), "third\n");
    const thirdArtifact = await produceWorktreeCommitArtifact({
      descriptor: third!, managed_path: third!.managed_path,
      validation: gitDiffCheck,
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

    const reopened = await openParallelCoordinator(value.repository);
    const archive = await reopened.snapshot("root", prepared.snapshot.run_id);
    assert.equal(archive!.terminal_reason, "failed");
    assert.deepEqual(archive!.tasks.find(({ descriptor }) => descriptor.dispatch_id === third!.dispatch_id)!.artifact, thirdArtifact);
  } finally {
    for (const restore of restoreLifecycles) restore();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("durable artifact parser rejects semantic corruption without consulting the checkout", async () => {
  const value = await fixture("artifact-corrupt");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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
      validation: gitDiffCheck,
    });
    await coordinator.acceptArtifact("root", "call", "child", descriptor, artifact);
    assert.deepEqual(artifact.changed_paths, ["upper/A.txt"]);
    const statePath = join(value.repository, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
    const pristine = JSON.parse(await readFile(statePath, "utf8")) as Record<string, any>;
    assert.deepEqual((await (await openParallelCoordinator(value.repository))
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
      const reopened = await openParallelCoordinator(value.repository);
      await errorCode(reopened.snapshot("root", prepared.snapshot.run_id), "corrupt-state");
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("completion without artifact fails and tampering is rejected before lifecycle acceptance", async () => {
  const value = await fixture("artifact-failclosed");
  try {
    const coordinator = await openParallelCoordinator(value.repository);
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
      validation: gitDiffCheck,
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
    const coordinator = await openParallelCoordinator(value.repository);
    const prepared = await coordinator.prepare(contract(value.sha, [[], ["a"]]), "root");
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const descriptor = prepared.snapshot.ready[0]!;
    await coordinator.bindDispatch("root", "call", descriptor);
    await writeFile(join(descriptor.managed_path, "a.txt"), "durable\n");
    const artifact = await produceWorktreeCommitArtifact({
      descriptor,
      managed_path: descriptor.managed_path,
      validation: gitDiffCheck,
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

export function worktreeDispatchCases(layer: "normal" | "integration" | "s01" | "remaining"): readonly RegisteredTest[] {
  return isolatedCases.filter((candidate) => {
    const normal = normalCases.has(candidate.name);
    if (layer === "normal") return normal;
    if (layer === "s01") return !normal && candidate.phase === "s01";
    if (layer === "remaining") return !normal && candidate.phase !== "s01";
    return !normal;
  });
}

function registerNormalWorktreeDispatchCases(): void {
  describe("worktree dispatch", { concurrency: Math.min(4, availableParallelism()) }, () => {
    for (const candidate of worktreeDispatchCases("normal")) {
      nodeTest(candidate.name, candidate.options ?? {}, candidate.run);
    }
  });
}

function registerIntegrationWorktreeDispatchCases(): void {
  const selectedPhase = process.env.SORTIE_WORKTREE_DISPATCH_PHASE;
  const s01Cases = worktreeDispatchCases("s01");
  const remainingCases = worktreeDispatchCases("remaining");
  const activity = {
    s01: 0,
    remaining: 0,
    overlap: 0,
    s01Started: 0,
    s01Finished: 0,
    remainingStarted: 0,
    remainingFinished: 0,
  };
  const trackedRun = (group: "s01" | "remaining", candidate: RegisteredTest): RegisteredTest["run"] =>
    async (context) => {
      const other = group === "s01" ? "remaining" : "s01";
      if (group === "remaining") assert.equal(activity.s01, 0);
      if (activity[`${group}Started`] === 0) activity[`${group}Started`] = performance.now();
      activity[group] += 1;
      if (activity[other] > 0) activity.overlap += 1;
      try {
        await candidate.run(context);
      } finally {
        activity[group] -= 1;
        activity[`${group}Finished`] = performance.now();
        assert.equal(activity.overlap, 0);
      }
    };
  const reportActivity = () => {
    assert.equal(activity.s01, 0);
    assert.equal(activity.remaining, 0);
    assert.equal(activity.overlap, 0);
    console.log("SORTIE_INTEGRATION_GROUPS", JSON.stringify({
      s01_duration_ms: activity.s01Started === 0 ? 0 : Math.round(activity.s01Finished - activity.s01Started),
      remaining_duration_ms: activity.remainingStarted === 0 ? 0 : Math.round(activity.remainingFinished - activity.remainingStarted),
      overlap: activity.overlap,
    }));
  };
  if (selectedPhase === "s01") {
    describe("six-unit and interrupted durable integration scenarios", { concurrency: 1 }, () => {
      for (const candidate of s01Cases) {
        nodeTest(candidate.name, candidate.options ?? {}, trackedRun("s01", candidate));
      }
      after(reportActivity);
    });
    return;
  }
  if (selectedPhase === "remaining") {
    describe("remaining worktree dispatch integration scenarios", { concurrency: 1 }, () => {
      for (const candidate of remainingCases) {
        nodeTest(candidate.name, candidate.options ?? {}, trackedRun("remaining", candidate));
      }
      after(reportActivity);
    });
    return;
  }
  describe("worktree dispatch integration barrier", { concurrency: false }, () => {
    describe("six-unit and interrupted durable integration scenarios", { concurrency: 1 }, () => {
      for (const candidate of s01Cases) nodeTest(candidate.name, candidate.options ?? {}, trackedRun("s01", candidate));
    });
    describe("remaining worktree dispatch integration scenarios", { concurrency: 1 }, () => {
      for (const candidate of remainingCases) nodeTest(candidate.name, candidate.options ?? {}, trackedRun("remaining", candidate));
    });
    after(reportActivity);
  });
}

if (!importedByNormalLayer) registerIntegrationWorktreeDispatchCases();
