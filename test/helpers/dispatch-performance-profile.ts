import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

type Phase =
  | "fixture"
  | "coordinator_open"
  | "worktree_prepare"
  | "bind"
  | "artifact"
  | "accept"
  | "complete"
  | "cleanup";

type SpawnKind = "git" | "node" | "powershell" | "other";

type GitCommandStats = {
  started: number;
  completed: number;
  failed: number;
  totalChildMs: number;
  repeatedCalls: number;
};

type Totals = {
  spawnCount: number;
  spawnKinds: Record<SpawnKind, number>;
  stateSaveCount: number;
  stateSaveDurationMs: number;
};

const emptyKinds = (): Record<SpawnKind, number> => ({ git: 0, node: 0, powershell: 0, other: 0 });
const rounded = (value: number): number => Math.round(value * 100) / 100;
const gitCommands = new Set([
  "add", "branch", "cat-file", "check-ignore", "check-ref-format", "checkout", "clean", "commit",
  "config", "diff", "for-each-ref", "hash-object", "init", "ls-files", "merge", "merge-base",
  "merge-tree", "mktree", "read-tree", "rev-list", "rev-parse", "show", "show-ref", "status",
  "symbolic-ref", "update-index", "update-ref", "verify-commit", "worktree", "write-tree",
]);
const gitGlobalOptionsWithValue = new Set([
  "-c", "-C", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree",
]);

function classifyGitCommand(args: unknown): string {
  if (!Array.isArray(args)) return "other";
  let index = 0;
  const first = args[0];
  if (typeof first === "string" && ["git", "git.exe"].includes(basename(first).toLowerCase())) index += 1;
  while (index < args.length) {
    const value = args[index];
    if (typeof value !== "string") return "other";
    if (gitGlobalOptionsWithValue.has(value)) {
      index += 2;
      continue;
    }
    if (value.startsWith("-")) {
      index += 1;
      continue;
    }
    return gitCommands.has(value) ? value : "other";
  }
  return "other";
}

function emptyGitCommandStats(): GitCommandStats {
  return { started: 0, completed: 0, failed: 0, totalChildMs: 0, repeatedCalls: 0 };
}

function classifySpawn(file: unknown): SpawnKind {
  const name = typeof file === "string" ? basename(file).toLowerCase() : "";
  if (name === "git" || name === "git.exe") return "git";
  if (name === "node" || name === "node.exe") return "node";
  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name)) return "powershell";
  return "other";
}

test("profiles one representative two-unit fabric dispatch", { timeout: 45_000 }, async (t) => {
  const startedAt = performance.now();
  const originalSpawn = ChildProcess.prototype.spawn;
  const totals: Totals = { spawnCount: 0, spawnKinds: emptyKinds(), stateSaveCount: 0, stateSaveDurationMs: 0 };
  const activeChildren = new Map<ChildProcess, SpawnKind>();
  const gitStats = new Map<Phase | "startup", Map<string, GitCommandStats>>();
  const gitSignatures = new Map<Phase | "startup", Set<string>>();
  let currentPhase: Phase | "startup" = "startup";
  let fixtureRoot: string | undefined;
  let coordinator: import("../../src/core/worktree-parallel-dispatch.ts").ParallelDispatchCoordinator | undefined;
  let runID: string | undefined;
  let originalSave: ((state: unknown, lease: unknown) => Promise<void>) | undefined;
  let budgetReached = false;
  let signalAborted = false;
  let finalized = false;

  const commandStats = (phase: Phase | "startup", command: string): GitCommandStats => {
    let phaseStats = gitStats.get(phase);
    if (phaseStats === undefined) {
      phaseStats = new Map();
      gitStats.set(phase, phaseStats);
    }
    let stats = phaseStats.get(command);
    if (stats === undefined) {
      stats = emptyGitCommandStats();
      phaseStats.set(command, stats);
    }
    return stats;
  };
  const summarizedGitStats = (phase: Phase | "startup"): Record<string, unknown>[] =>
    [...(gitStats.get(phase)?.entries() ?? [])]
      .sort((left, right) => right[1].started - left[1].started || left[0].localeCompare(right[0]))
      .map(([command, stats]) => ({
        command,
        started: stats.started,
        completed: stats.completed,
        failed: stats.failed,
        total_child_ms: rounded(stats.totalChildMs),
        repeated_calls: stats.repeatedCalls,
        safely_omittable_calls: 0,
      }));

  const emit = (value: Record<string, unknown>): void => console.log(JSON.stringify(value));
  const checkpoint = setInterval(() => emit({
    event: "checkpoint",
    active_phase: currentPhase,
    elapsed_ms: rounded(performance.now() - startedAt),
    spawn_count: totals.spawnCount,
    state_save_count: totals.stateSaveCount,
    active_child_count: activeChildren.size,
  }), 5_000);
  checkpoint.unref();

  const budget = setTimeout(() => {
    budgetReached = true;
    emit({
      event: "budget_reached",
      active_phase: currentPhase,
      elapsed_ms: rounded(performance.now() - startedAt),
      spawn_count: totals.spawnCount,
      state_save_count: totals.stateSaveCount,
      active_child_count: activeChildren.size,
    });
    for (const child of activeChildren.keys()) child.kill();
  }, 42_000);
  budget.unref();

  const onAbort = (): void => {
    if (finalized) return;
    signalAborted = true;
    emit({
      event: "test_abort",
      active_phase: currentPhase,
      elapsed_ms: rounded(performance.now() - startedAt),
      spawn_count: totals.spawnCount,
      state_save_count: totals.stateSaveCount,
      active_child_count: activeChildren.size,
    });
    for (const [child, kind] of activeChildren) if (kind === "git") child.kill();
  };
  t.signal.addEventListener("abort", onAbort, { once: true });

  ChildProcess.prototype.spawn = function observedSpawn(options): boolean {
    if (signalAborted) throw new Error("Profile test aborted; refusing a new subprocess.");
    const kind = classifySpawn(options.file);
    const spawnPhase = currentPhase;
    const childStarted = performance.now();
    let observedGitStats: GitCommandStats | undefined;
    try {
      if (kind === "git") {
        const command = classifyGitCommand(options.args);
        observedGitStats = commandStats(spawnPhase, command);
        observedGitStats.started += 1;
        let signatures = gitSignatures.get(spawnPhase);
        if (signatures === undefined) {
          signatures = new Set();
          gitSignatures.set(spawnPhase, signatures);
        }
        const signature = JSON.stringify([options.cwd ?? null, options.args ?? []]);
        if (signatures.has(signature)) observedGitStats.repeatedCalls += 1;
        else if (signatures.size < 512) signatures.add(signature);
      }
    } catch {
      observedGitStats = undefined;
    }
    totals.spawnCount += 1;
    totals.spawnKinds[kind] += 1;
    activeChildren.set(this, kind);
    this.once("close", (code, signal) => {
      activeChildren.delete(this);
      if (observedGitStats !== undefined) {
        observedGitStats.completed += 1;
        observedGitStats.totalChildMs += performance.now() - childStarted;
        if (code !== 0 || signal !== null) observedGitStats.failed += 1;
      }
    });
    try {
      return originalSpawn.call(this, options);
    } catch (error) {
      activeChildren.delete(this);
      if (observedGitStats !== undefined) {
        observedGitStats.failed += 1;
        observedGitStats.totalChildMs += performance.now() - childStarted;
      }
      throw error;
    }
  };

  const measure = async <T>(phase: Phase, operation: () => Promise<T>): Promise<T> => {
    currentPhase = phase;
    const phaseStarted = performance.now();
    const beforeSpawn = totals.spawnCount;
    const beforeSaves = totals.stateSaveCount;
    const beforeSaveDuration = totals.stateSaveDurationMs;
    const beforeKinds = { ...totals.spawnKinds };
    emit({ event: "phase_started", phase, elapsed_ms: rounded(phaseStarted - startedAt) });
    const result = await operation();
    const spawnKinds = emptyKinds();
    for (const kind of Object.keys(spawnKinds) as SpawnKind[]) {
      spawnKinds[kind] = totals.spawnKinds[kind] - beforeKinds[kind];
    }
    emit({
      event: "phase_completed",
      phase,
      duration_ms: rounded(performance.now() - phaseStarted),
      spawn_count: totals.spawnCount - beforeSpawn,
      spawn_kinds: spawnKinds,
      git_commands: summarizedGitStats(phase),
      state_save_count: totals.stateSaveCount - beforeSaves,
      state_save_duration_ms: rounded(totals.stateSaveDurationMs - beforeSaveDuration),
    });
    return result;
  };

  try {
    const helpers = await import("./worktree-dispatch-fixture.ts");
    const artifactModule = await import("../../dist/core/worktree-commit-artifact.js");
    const value = await measure("fixture", async () => await helpers.fixture("phase-profile"));
    fixtureRoot = value.root;

    const dispatch = await import("../../dist/core/worktree-parallel-dispatch.js");
    coordinator = await measure("coordinator_open", async () =>
      await dispatch.ParallelDispatchCoordinator.open({ repositoryRoot: value.repository }));

    type CoordinatorInternal = {
      save(state: unknown, lease: unknown): Promise<void>;
    };
    const internal = coordinator as unknown as CoordinatorInternal;
    originalSave = internal.save;
    internal.save = async function observedSave(state: unknown, lease: unknown): Promise<void> {
      const saveStarted = performance.now();
      totals.stateSaveCount += 1;
      try {
        await originalSave!.call(coordinator, state, lease);
      } finally {
        totals.stateSaveDurationMs += performance.now() - saveStarted;
      }
    };

    const prepared = await measure("worktree_prepare", async () => await coordinator!.prepareFabric(
      helpers.fabricContract(value.sha, [helpers.fabricUnit("a", 0), helpers.fabricUnit("b", 1)]),
      "root",
    ));
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    runID = prepared.snapshot.run_id;
    const descriptors = prepared.snapshot.ready;
    assert.equal(descriptors.length, 2);

    await measure("bind", async () => {
      await Promise.all(descriptors.map(async (descriptor, index) =>
        await coordinator!.bindDispatch("root", `profile-call-${index}`, descriptor)));
    });

    const artifacts = await measure("artifact", async () => await Promise.all(descriptors.map(async (descriptor) => {
      await writeFile(join(descriptor.managed_path, `${descriptor.task_id}.txt`), `${descriptor.task_id}\n`);
      return await artifactModule.produceWorktreeCommitArtifact({
        descriptor,
        managed_path: descriptor.managed_path,
        validation: helpers.gitDiffCheck,
      });
    })));

    await measure("accept", async () => {
      await Promise.all(descriptors.map(async (descriptor, index) => await coordinator!.acceptArtifact(
        "root",
        `profile-call-${index}`,
        `profile-child-${index}`,
        descriptor,
        artifacts[index]!,
      )));
    });

    await measure("complete", async () => {
      await Promise.all(descriptors.map(async (descriptor, index) => await coordinator!.completeCall(
        "root",
        `profile-call-${index}`,
        `profile-child-${index}`,
        "completed",
        { run_id: descriptor.run_id, dispatch_id: descriptor.dispatch_id },
      )));
    });
    assert.equal(budgetReached, false, "The 42 second workload budget was reached.");
  } finally {
    clearInterval(checkpoint);
    clearTimeout(budget);
    let cleanupCompleted = false;
    try {
      if (!signalAborted) {
        await measure("cleanup", async () => {
          if (coordinator !== undefined && runID !== undefined) await coordinator.cancel("root", runID);
          if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
        });
        cleanupCompleted = true;
      } else if (fixtureRoot !== undefined) {
        await rm(fixtureRoot, { recursive: true, force: true });
        cleanupCompleted = true;
      }
    } finally {
      if (coordinator !== undefined && originalSave !== undefined) {
        (coordinator as unknown as { save: typeof originalSave }).save = originalSave;
      }
      ChildProcess.prototype.spawn = originalSpawn;
      finalized = true;
      t.signal.removeEventListener("abort", onAbort);
      emit({
        event: "profile_completed",
        status: budgetReached || signalAborted ? "incomplete" : "completed",
        elapsed_ms: rounded(performance.now() - startedAt),
        spawn_count: totals.spawnCount,
        spawn_kinds: totals.spawnKinds,
        git_commands_by_phase: Object.fromEntries(
          [...gitStats.keys()].map((phase) => [phase, summarizedGitStats(phase)]),
        ),
        state_save_count: totals.stateSaveCount,
        state_save_duration_ms: rounded(totals.stateSaveDurationMs),
        cleanup_completed: cleanupCompleted,
        active_child_count: activeChildren.size,
      });
      assert.equal(activeChildren.size, 0, "Profile left a tracked child process active.");
    }
  }
});
