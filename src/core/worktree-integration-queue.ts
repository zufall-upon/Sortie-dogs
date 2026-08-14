import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ScopeLeaseError, ScopeLeaseRegistry, type ScopeLease } from "./scope-lease-registry.js";
import type {
  IntegrationQueueErrorCode,
  IntegrationQueueSnapshot,
  ParallelDispatchArchive,
  ParallelDispatchArchiveTask,
} from "./types.js";
import { WorktreeLifecycle } from "./worktree-lifecycle.js";

const VERSION = 2;
const MAX_ARCHIVED = 16;
const MAX_STATE = 1024 * 1024;
const MAX_PATCH = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const GIT_TIMEOUT = 60_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const HASH = /^[0-9a-f]{64}$/u;
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/u;
const LEASE_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/integration-queue-v2"] });

type StoredTask = {
  task_id: string;
  depends_on: string[];
  worktree_id: string;
  branch: string;
  base_sha: string;
  source_commit: string;
  changed_paths: string[];
  synthetic_commit: string | null;
};

type Queue = {
  owner_root: string;
  run_id: string;
  contract_fingerprint: string;
  archive_fingerprint: string;
  target_ref: string;
  target_base: string;
  phase: "queued" | "integrating" | "integrated" | "failed";
  candidate_head: string | null;
  failure_code: IntegrationQueueErrorCode | null;
  tasks: StoredTask[];
  cleanup_pending: string[];
  warnings: string[];
};

type State = { version: 2; revision: number; active: Queue | null; archived: Queue[] };

export interface WorktreeIntegrationQueueOptions {
  readonly repositoryRoot: string;
  readonly targetBranch?: string;
  readonly gitPath?: string;
}

export class IntegrationQueueError extends Error {
  constructor(readonly code: IntegrationQueueErrorCode, message: string) {
    super(message);
    this.name = "IntegrationQueueError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function text(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function cleanGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}

function parseTask(value: unknown): StoredTask {
  if (!record(value) || !keys(value, [
    "base_sha", "branch", "changed_paths", "depends_on", "source_commit", "synthetic_commit", "task_id", "worktree_id",
  ]) || !text(value.task_id, 128) || !text(value.worktree_id, 256) || !text(value.branch, 256) ||
    typeof value.base_sha !== "string" || !SHA.test(value.base_sha) ||
    typeof value.source_commit !== "string" || !SHA.test(value.source_commit) ||
    !(value.synthetic_commit === null || (typeof value.synthetic_commit === "string" && SHA.test(value.synthetic_commit))) ||
    !Array.isArray(value.depends_on) || value.depends_on.length > 3 || !value.depends_on.every((item) => text(item, 128)) ||
    !Array.isArray(value.changed_paths) || value.changed_paths.length > 256 ||
    !value.changed_paths.every((item) => text(item, 1024))) throw new Error("task");
  return value as unknown as StoredTask;
}

function parseQueue(value: unknown): Queue {
  const queue = value;
  if (!record(queue) || !keys(queue, [
    "archive_fingerprint", "candidate_head", "cleanup_pending", "contract_fingerprint", "failure_code", "owner_root",
    "phase", "run_id", "target_base", "target_ref", "tasks", "warnings",
  ]) || !text(queue.owner_root, 256) || !text(queue.run_id, 128) || typeof queue.contract_fingerprint !== "string" ||
    !HASH.test(queue.contract_fingerprint) || typeof queue.archive_fingerprint !== "string" || !HASH.test(queue.archive_fingerprint) ||
    typeof queue.target_ref !== "string" || !REF.test(queue.target_ref) || typeof queue.target_base !== "string" ||
    !SHA.test(queue.target_base) || !["queued", "integrating", "integrated", "failed"].includes(queue.phase as string) ||
    !(queue.candidate_head === null || (typeof queue.candidate_head === "string" && SHA.test(queue.candidate_head))) ||
    !(queue.failure_code === null || text(queue.failure_code, 64)) || !Array.isArray(queue.tasks) ||
    queue.tasks.length === 0 || queue.tasks.length > 3 || !Array.isArray(queue.cleanup_pending) ||
    !queue.cleanup_pending.every((item) => text(item, 256)) || !Array.isArray(queue.warnings) ||
    queue.warnings.length > 3 || !queue.warnings.every((item) => text(item, 512))) throw new Error("queue");
  const tasks = queue.tasks.map(parseTask);
  if (new Set(tasks.map(({ task_id }) => task_id)).size !== tasks.length ||
    new Set(tasks.map(({ source_commit }) => source_commit)).size !== tasks.length) throw new Error("identities");
  return { ...queue, tasks } as Queue;
}

function parseState(value: unknown): State {
  if (!record(value) || !keys(value, ["active", "archived", "revision", "version"]) || value.version !== VERSION ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.archived) ||
    value.archived.length > MAX_ARCHIVED) throw new Error("state");
  const active = value.active === null ? null : parseQueue(value.active);
  const archived = value.archived.map(parseQueue);
  if (archived.some((queue) => queue.phase !== "integrated" || queue.cleanup_pending.length !== 0) ||
    new Set(archived.map(({ run_id }) => run_id)).size !== archived.length) throw new Error("archive");
  return { version: 2, revision: value.revision as number, active, archived };
}

function validateArchive(archive: ParallelDispatchArchive): void {
  if (!record(archive) || !text(archive.owner_root, 256) || !text(archive.run_id, 128) ||
    typeof archive.contract_fingerprint !== "string" || !HASH.test(archive.contract_fingerprint) || archive.cancelled ||
    archive.terminal_reason !== "completed" || !Array.isArray(archive.tasks) || archive.tasks.length === 0 || archive.tasks.length > 3) {
    throw new IntegrationQueueError("invalid-archive", "Only a bounded completed parallel archive can be enqueued.");
  }
  const ids = new Set<string>();
  const commits = new Set<string>();
  for (const candidate of archive.tasks as readonly unknown[]) {
    if (!record(candidate) || !text(candidate.task_id, 128) || !Array.isArray(candidate.depends_on) ||
      !candidate.depends_on.every((item) => text(item, 128)) || !text(candidate.worktree_id, 256) || !text(candidate.branch, 256) ||
      typeof candidate.base_sha !== "string" || !SHA.test(candidate.base_sha) || candidate.phase !== "completed" ||
      candidate.outcome !== "completed" || !record(candidate.artifact) ||
      candidate.artifact.task_id !== candidate.task_id || candidate.artifact.base_sha !== candidate.base_sha ||
      candidate.artifact.branch !== candidate.branch || typeof candidate.artifact.commit_sha !== "string" ||
      !SHA.test(candidate.artifact.commit_sha)) {
      throw new IntegrationQueueError("invalid-archive", "Archive task or artifact identity is invalid.");
    }
    const task = candidate as unknown as ParallelDispatchArchiveTask;
    if (!text(task.task_id, 128) || !Array.isArray(task.depends_on) ||
      !task.depends_on.every((item) => text(item, 128)) || !text(task.worktree_id, 256) || !text(task.branch, 256) ||
      typeof task.base_sha !== "string" || !SHA.test(task.base_sha) || task.phase !== "completed" || task.outcome !== "completed" ||
      task.artifact === null || task.artifact.task_id !== task.task_id || task.artifact.base_sha !== task.base_sha ||
      task.artifact.branch !== task.branch || !SHA.test(task.artifact.commit_sha)) {
      throw new IntegrationQueueError("invalid-archive", "Archive task or artifact identity is invalid.");
    }
    if (ids.has(task.task_id)) throw new IntegrationQueueError("invalid-archive", "Archive contains duplicate task IDs.");
    if (commits.has(task.artifact.commit_sha)) throw new IntegrationQueueError("duplicate-artifact", "Archive contains duplicate artifact commits.");
    ids.add(task.task_id);
    commits.add(task.artifact.commit_sha);
  }
  for (const task of archive.tasks) for (const dependency of task.depends_on) {
    if (!ids.has(dependency)) throw new IntegrationQueueError("missing-dependency", "Archive dependency is absent.");
  }
}

function orderedTasks(tasks: readonly ParallelDispatchArchiveTask[]): ParallelDispatchArchiveTask[] {
  const remaining = new Map(tasks.map((task) => [task.task_id, task]));
  const done = new Set<string>();
  const result: ParallelDispatchArchiveTask[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) => task.depends_on.every((id) => done.has(id)))
      .sort((left, right) => left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0);
    if (ready.length === 0) throw new IntegrationQueueError("dependency-cycle", "Archive dependencies contain a cycle.");
    for (const task of ready) { remaining.delete(task.task_id); done.add(task.task_id); result.push(task); }
  }
  return result;
}

export class WorktreeIntegrationQueue {
  private readonly statePath: string;
  private readonly registry: ScopeLeaseRegistry;
  private serial = Promise.resolve();

  private constructor(
    private readonly repositoryRoot: string,
    private readonly gitPath: string,
    private readonly targetRef: string,
    private readonly stateRoot: string,
    private readonly lifecycle: WorktreeLifecycle,
  ) {
    this.statePath = join(stateRoot, "state.json");
    this.registry = new ScopeLeaseRegistry(join(stateRoot, "authority"));
  }

  static async open(options: WorktreeIntegrationQueueOptions): Promise<WorktreeIntegrationQueue> {
    if (!record(options) || !keys(options, ["repositoryRoot", ...(options.targetBranch === undefined ? [] : ["targetBranch"]),
      ...(options.gitPath === undefined ? [] : ["gitPath"])]) || !text(options.repositoryRoot) ||
      (options.targetBranch !== undefined && !text(options.targetBranch, 256)) ||
      (options.gitPath !== undefined && !text(options.gitPath, 1024))) {
      throw new IntegrationQueueError("invalid-archive", "Integration queue options are invalid.");
    }
    const root = await realpath(options.repositoryRoot).catch(() => undefined);
    if (root === undefined) throw new IntegrationQueueError("git-incompatible", "Repository root does not exist.");
    const gitPath = options.gitPath ?? "git";
    const bootstrap = (args: readonly string[]) => WorktreeIntegrationQueue.runGitAt(gitPath, root, args);
    let common: string;
    let branch = options.targetBranch;
    try {
      common = await realpath(resolve(root, (await bootstrap(["rev-parse", "--git-common-dir"])).toString("utf8").trim()));
      branch ??= (await bootstrap(["symbolic-ref", "--quiet", "--short", "HEAD"])).toString("utf8").trim();
      await bootstrap(["check-ref-format", "--branch", branch]);
      await bootstrap(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    } catch {
      throw new IntegrationQueueError("git-incompatible", "Target branch or Git common directory is unavailable.");
    }
    const stateRoot = join(common, "sortie-dogs", "integration-queue-v2");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o700).catch(() => undefined);
    const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: root, ...(options.gitPath === undefined ? {} : { gitPath }) });
    return new WorktreeIntegrationQueue(root, gitPath, `refs/heads/${branch}`, stateRoot, lifecycle);
  }

  async enqueue(ownerRoot: string, archive: ParallelDispatchArchive): Promise<IntegrationQueueSnapshot> {
    validateArchive(archive);
    if (!text(ownerRoot, 256) || archive.owner_root !== ownerRoot) {
      throw new IntegrationQueueError("invalid-archive", "Archive owner does not match queue owner.");
    }
    const order = orderedTasks(archive.tasks);
    const archiveFingerprint = fingerprint(archive);
    return this.transaction(async (state) => {
      const prior = state.archived.find(({ run_id }) => run_id === archive.run_id);
      if (prior !== undefined) {
        if (prior.owner_root !== ownerRoot) throw new IntegrationQueueError("queue-owned", "Another owner controls the archived run.");
        if (prior.archive_fingerprint !== archiveFingerprint) {
          throw new IntegrationQueueError("duplicate-artifact", "Archived run identity does not match this archive.");
        }
        return { result: this.publicSnapshot(prior), changed: false };
      }
      if (state.active !== null) {
        if (state.active.owner_root !== ownerRoot) throw new IntegrationQueueError("queue-owned", "Another owner controls the queue.");
        if (state.active.run_id !== archive.run_id || state.active.archive_fingerprint !== archiveFingerprint) {
          throw new IntegrationQueueError("queue-owned", "A different run already controls the queue.");
        }
        return { result: this.publicSnapshot(state.active), changed: false };
      }
      const targetBase = (await this.git(["rev-parse", "--verify", `${this.targetRef}^{commit}`])).toString("utf8").trim();
      await this.assertTargetSafe(targetBase);
      for (const task of order) await this.verifyArtifact(task, targetBase);
      const queue: Queue = {
        owner_root: ownerRoot,
        run_id: archive.run_id,
        contract_fingerprint: archive.contract_fingerprint,
        archive_fingerprint: archiveFingerprint,
        target_ref: this.targetRef,
        target_base: targetBase,
        phase: "queued",
        candidate_head: null,
        failure_code: null,
        tasks: order.map((task) => ({
          task_id: task.task_id,
          depends_on: [...task.depends_on],
          worktree_id: task.worktree_id,
          branch: task.branch,
          base_sha: task.base_sha,
          source_commit: task.artifact!.commit_sha,
          changed_paths: [...task.artifact!.changed_paths],
          synthetic_commit: null,
        })),
        cleanup_pending: order.filter(({ managed_path }) => managed_path !== null).map(({ worktree_id }) => worktree_id),
        warnings: [],
      };
      for (const task of queue.tasks) {
        const sourceRef = `refs/sortie-dogs/integration-queue/${fingerprint(queue.run_id).slice(0, 16)}/${fingerprint(task.task_id).slice(0, 16)}`;
        await this.ensureSourceRef(sourceRef, task.source_commit);
      }
      state.active = queue;
      return { result: this.publicSnapshot(queue), changed: true };
    });
  }

  async integrate(ownerRoot: string, runID: string): Promise<IntegrationQueueSnapshot> {
    let integrated: IntegrationQueueSnapshot;
    try {
      integrated = await this.transaction(async (state, lease) => {
       const archived = this.findArchived(state, ownerRoot, runID);
       if (archived !== undefined) return { result: this.publicSnapshot(archived), changed: false };
       const queue = this.requireQueue(state, ownerRoot, runID);
      const currentTarget = (await this.git(["rev-parse", "--verify", `${queue.target_ref}^{commit}`])).toString("utf8").trim();
      if (queue.candidate_head !== null && currentTarget === queue.candidate_head) {
        queue.phase = "integrated";
        queue.failure_code = null;
        return { result: this.publicSnapshot(queue), changed: true };
      }
      if (queue.phase === "integrated") return { result: this.publicSnapshot(queue), changed: false };
      if (queue.phase === "failed") throw new IntegrationQueueError(queue.failure_code!, "Integration previously failed closed.");
      if (currentTarget !== queue.target_base) return this.fail(queue, "stale-target", "Target changed after enqueue.");
      queue.phase = "integrating";
      await this.saveRevision(state, lease);
      let head = queue.target_base;
      for (let index = 0; index < queue.tasks.length; index += 1) {
        const task = queue.tasks[index]!;
        if (task.synthetic_commit !== null) {
          await this.verifySynthetic(task, head, queue);
          head = task.synthetic_commit;
          continue;
        }
        try {
          head = await this.applyArtifact(queue, task, head, index);
        } catch (error) {
          if (error instanceof IntegrationQueueError) return this.fail(queue, error.code, error.message);
          throw error;
        }
        task.synthetic_commit = head;
        await this.saveRevision(state, lease);
      }
      queue.candidate_head = head;
      await this.saveRevision(state, lease);
       await this.assertTargetSafe(queue.target_base);
      const beforeCAS = (await this.git(["rev-parse", "--verify", `${queue.target_ref}^{commit}`])).toString("utf8").trim();
      if (beforeCAS !== queue.target_base) return this.fail(queue, "stale-target", "Target changed before atomic acceptance.");
      try {
        await this.git(["update-ref", queue.target_ref, head, queue.target_base]);
      } catch {
        return this.fail(queue, "stale-target", "Atomic target comparison failed.");
      }
      queue.phase = "integrated";
      queue.failure_code = null;
      return { result: this.publicSnapshot(queue), changed: true };
      });
    } catch (error) {
      if (error instanceof IntegrationQueueError && ["merge-conflict", "stale-target", "target-checked-out", "git-incompatible", "corrupt-state"].includes(error.code)) {
        await this.transaction((state) => {
          const queue = this.requireQueue(state, ownerRoot, runID);
          queue.phase = "failed";
          queue.failure_code = error.code;
          return { result: undefined, changed: true };
        });
      }
      throw error;
    }
    return integrated.phase === "integrated" ? this.cleanup(ownerRoot, runID) : integrated;
  }

  async cleanup(ownerRoot: string, runID: string): Promise<IntegrationQueueSnapshot> {
    return this.transaction(async (state) => {
      const archived = this.findArchived(state, ownerRoot, runID);
      if (archived !== undefined) return { result: this.publicSnapshot(archived), changed: false };
      const queue = this.requireQueue(state, ownerRoot, runID);
      if (queue.phase !== "integrated") throw new IntegrationQueueError("invalid-archive", "Cleanup requires accepted integration.");
      await this.lifecycle.reconcile();
      const pending: string[] = [];
      const warnings: string[] = [];
      for (const id of queue.cleanup_pending) {
        if (!await this.lifecycle.hasManagedWorktree(id)) continue;
        try {
          await this.lifecycle.cleanup(id);
        } catch {
          await this.lifecycle.reconcile();
          if (await this.lifecycle.hasManagedWorktree(id)) {
            pending.push(id);
            warnings.push(`cleanup-pending:${id}`);
          }
        }
      }
      const changed = pending.length !== queue.cleanup_pending.length || warnings.join("\n") !== queue.warnings.join("\n");
      queue.cleanup_pending = pending;
      queue.warnings = warnings;
      const snapshot = this.publicSnapshot(queue);
      if (pending.length === 0) {
        for (const task of queue.tasks) task.changed_paths = [];
        state.archived.push(queue);
        if (state.archived.length > MAX_ARCHIVED) state.archived.splice(0, state.archived.length - MAX_ARCHIVED);
        state.active = null;
        return { result: snapshot, changed: true };
      }
      return { result: snapshot, changed };
    });
  }

  async snapshot(ownerRoot: string, runID: string): Promise<IntegrationQueueSnapshot | undefined> {
    return this.transaction((state) => {
      if (state.active?.run_id === runID) {
        const queue = this.requireQueue(state, ownerRoot, runID);
        return { result: this.publicSnapshot(queue), changed: false };
      }
      const archived = this.findArchived(state, ownerRoot, runID);
      return { result: archived === undefined ? undefined : this.publicSnapshot(archived), changed: false };
    });
  }

  private async verifyArtifact(task: ParallelDispatchArchiveTask, target: string): Promise<void> {
    const artifact = task.artifact!;
    try {
      await this.git(["cat-file", "-e", `${artifact.commit_sha}^{commit}`]);
      const parents = (await this.git(["rev-list", "--parents", "-n", "1", artifact.commit_sha])).toString("utf8").trim().split(" ");
      if (parents.length !== 2 || parents[0] !== artifact.commit_sha || parents[1] !== artifact.base_sha) throw new Error("parent");
      const ancestor = await this.gitStatus(["merge-base", "--is-ancestor", artifact.base_sha, target]);
      if (ancestor !== 0) throw new IntegrationQueueError("stale-base", "Artifact base is not an ancestor of the pinned target.");
      const changed = (await this.git(["diff-tree", "--no-commit-id", "--name-only", "-z", artifact.base_sha, artifact.commit_sha, "--"]))
        .toString("utf8").split("\0").filter(Boolean).sort();
      if (JSON.stringify(changed) !== JSON.stringify([...artifact.changed_paths].sort())) throw new Error("paths");
      const duplicate = (await this.git(["log", "--format=%H", "--fixed-strings", `--grep=Sortie-Artifact: ${artifact.commit_sha}`, target, "--"]))
        .toString("utf8").trim();
      if (duplicate.length > 0) throw new IntegrationQueueError("duplicate-artifact", "Artifact provenance already exists on target.");
    } catch (error) {
      if (error instanceof IntegrationQueueError) throw error;
      throw new IntegrationQueueError("invalid-archive", "Artifact Git identity does not match its archive.");
    }
  }

  private async applyArtifact(queue: Queue, task: StoredTask, parent: string, _index: number): Promise<string> {
    const indexPath = join(this.stateRoot, `.index.${randomUUID()}`);
    const env = cleanGitEnvironment({ GIT_INDEX_FILE: indexPath });
    try {
      await this.git(["read-tree", parent], env);
      const patch = await this.git(["diff-tree", "-p", "--binary", "--full-index", "--no-ext-diff", "--no-renames",
        task.base_sha, task.source_commit, "--"], undefined, MAX_PATCH);
      if (patch.byteLength > MAX_PATCH) throw new IntegrationQueueError("git-incompatible", "Artifact patch exceeds the practical bound.");
      const applied = await this.gitInput(["apply", "--cached", "--3way", "--binary", "-"], patch, env) as number;
      if (applied !== 0) throw new IntegrationQueueError("merge-conflict", "Artifact does not apply cleanly to the synthetic tip.");
      const tree = (await this.git(["write-tree"], env)).toString("utf8").trim();
      const timestamp = (await this.git(["show", "-s", "--format=%ct", task.source_commit])).toString("utf8").trim();
      if (!/^\d{1,12}$/u.test(timestamp)) throw new IntegrationQueueError("git-incompatible", "Source timestamp is unavailable.");
      const message = this.commitMessage(queue, task);
      const commitEnv = cleanGitEnvironment({
        GIT_AUTHOR_NAME: "Sortie Integration Queue", GIT_AUTHOR_EMAIL: "sortie@example.invalid",
        GIT_COMMITTER_NAME: "Sortie Integration Queue", GIT_COMMITTER_EMAIL: "sortie@example.invalid",
        GIT_AUTHOR_DATE: `${timestamp} +0000`, GIT_COMMITTER_DATE: `${timestamp} +0000`,
      });
      const result = await this.gitInput(["commit-tree", tree, "-p", parent], Buffer.from(message), commitEnv, true) as { code: number; output: Buffer };
      const commit = result.output.toString("utf8").trim();
      if (result.code !== 0 || !SHA.test(commit)) throw new IntegrationQueueError("git-incompatible", "Synthetic commit creation failed.");
      return commit;
    } finally {
      await rm(indexPath, { force: true }).catch(() => undefined);
      await rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
    }
  }

  private commitMessage(queue: Queue, task: StoredTask): string {
    return `Sortie integration: ${task.task_id}\n\nSortie-Run: ${queue.run_id}\nSortie-Task: ${task.task_id}\n` +
      `Sortie-Artifact: ${task.source_commit}\nSortie-Base: ${task.base_sha}\n`;
  }

  private async verifySynthetic(task: StoredTask, parent: string, queue: Queue): Promise<void> {
    try {
      const identity = (await this.git(["rev-list", "--parents", "-n", "1", task.synthetic_commit!])).toString("utf8").trim();
      if (identity !== `${task.synthetic_commit} ${parent}`) throw new Error("parent");
      const message = (await this.git(["show", "-s", "--format=%B", task.synthetic_commit!])).toString("utf8");
      if (message.trimEnd() !== this.commitMessage(queue, task).trimEnd()) throw new Error("message");
    } catch {
      throw new IntegrationQueueError("corrupt-state", "Persisted synthetic commit cannot be resumed safely.");
    }
  }

  private fail(queue: Queue, code: IntegrationQueueErrorCode, message: string): never {
    queue.phase = "failed";
    queue.failure_code = code;
    throw new IntegrationQueueError(code, message);
  }

  private requireQueue(state: State, owner: string, runID: string): Queue {
    if (state.active === null || state.active.owner_root !== owner || state.active.run_id !== runID) {
      throw new IntegrationQueueError("queue-owned", "Queue ownership or run identity does not match.");
    }
    return state.active;
  }

  private findArchived(state: State, owner: string, runID: string): Queue | undefined {
    const queue = state.archived.find(({ run_id }) => run_id === runID);
    if (queue !== undefined && queue.owner_root !== owner) {
      throw new IntegrationQueueError("queue-owned", "Archived run ownership does not match.");
    }
    return queue;
  }

  private publicSnapshot(queue: Queue): IntegrationQueueSnapshot {
    return Object.freeze({
      owner_root: queue.owner_root, run_id: queue.run_id, target_ref: queue.target_ref, target_base: queue.target_base,
      phase: queue.phase, candidate_head: queue.candidate_head, failure_code: queue.failure_code,
      tasks: Object.freeze(queue.tasks.map((task) => Object.freeze({
        task_id: task.task_id, source_commit: task.source_commit, synthetic_commit: task.synthetic_commit,
        integrated: task.synthetic_commit !== null,
      }))),
      cleanup_pending: Object.freeze([...queue.cleanup_pending]), warnings: Object.freeze([...queue.warnings]),
    });
  }

  private async ensureSourceRef(sourceRef: string, commit: string): Promise<void> {
    const existing = await this.gitStatus(["rev-parse", "--verify", sourceRef], true) as { code: number; output: Buffer };
    if (existing.code === 0) {
      if (existing.output.toString("utf8").trim() !== commit) {
        throw new IntegrationQueueError("corrupt-state", "Source ref already identifies a different artifact.");
      }
      return;
    }
    try { await this.git(["update-ref", sourceRef, commit, ""]); }
    catch {
      const raced = await this.gitStatus(["rev-parse", "--verify", sourceRef], true) as { code: number; output: Buffer };
      if (raced.code !== 0 || raced.output.toString("utf8").trim() !== commit) {
        throw new IntegrationQueueError("corrupt-state", "Source ref creation conflicted with another artifact.");
      }
    }
  }

  private async assertTargetSafe(pinnedTarget: string): Promise<void> {
    const status = (await this.git(["status", "--porcelain=v1", "--untracked-files=normal"])).toString("utf8");
    if (status.length > 0) throw new IntegrationQueueError("dirty-tree", "Primary checkout is dirty.");
    const output = await this.git(["worktree", "list", "--porcelain", "-z"]);
    if (output.byteLength > MAX_GIT_OUTPUT) throw new IntegrationQueueError("git-incompatible", "Worktree list exceeds its bound.");
    const fields = output.toString("utf8").split("\0");
    let bare = false;
    let seen = false;
    let head: string | null = null;
    let branch: string | null = null;
    const inspect = () => {
      if (!seen) return;
      if (!bare && (head === null || !SHA.test(head))) {
        throw new IntegrationQueueError("git-incompatible", "Worktree list contains an invalid HEAD.");
      }
      if (!bare && branch === this.targetRef) {
        throw new IntegrationQueueError("target-checked-out", "Target is checked out by a worktree.");
      }
    };
    for (const field of fields) {
      if (field.startsWith("worktree ")) {
        inspect(); seen = true; bare = false; head = null; branch = null;
        if (!text(field.slice(9), 4096)) throw new IntegrationQueueError("git-incompatible", "Worktree path is invalid.");
      }
      else if (field.startsWith("HEAD ")) head = field.slice(5);
      else if (field.startsWith("branch ")) branch = field.slice(7);
      else if (field === "bare") bare = true;
      else if (field !== "" && field !== "detached" && !field.startsWith("locked") && !field.startsWith("prunable")) {
        throw new IntegrationQueueError("git-incompatible", "Worktree list format is unsupported.");
      }
    }
    inspect();
    if (!seen) throw new IntegrationQueueError("git-incompatible", "Worktree list is empty.");
  }

  private static runGitAt(gitPath: string, cwd: string, args: readonly string[]): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => execFile(gitPath, [...args], {
      cwd, env: cleanGitEnvironment(), shell: false, windowsHide: true, timeout: GIT_TIMEOUT, maxBuffer: MAX_GIT_OUTPUT,
      encoding: "buffer",
    }, (error, stdout) => error === null ? resolvePromise(stdout as Buffer) : reject(error)));
  }

  private git(args: readonly string[], env?: NodeJS.ProcessEnv, maxBuffer = MAX_GIT_OUTPUT): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => execFile(this.gitPath, [...args], {
      cwd: this.repositoryRoot, env: env ?? cleanGitEnvironment(), shell: false, windowsHide: true,
      timeout: GIT_TIMEOUT, maxBuffer, encoding: "buffer",
    }, (error, stdout) => error === null ? resolvePromise(stdout as Buffer) : reject(error)));
  }

  private async gitStatus(args: readonly string[], output = false): Promise<number | { code: number; output: Buffer }> {
    return new Promise((resolvePromise) => execFile(this.gitPath, [...args], {
      cwd: this.repositoryRoot, env: cleanGitEnvironment(), shell: false, windowsHide: true,
      timeout: GIT_TIMEOUT, maxBuffer: MAX_GIT_OUTPUT, encoding: "buffer",
    }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 2;
      resolvePromise(output ? { code, output: stdout as Buffer } : code);
    }));
  }

  private gitInput(
    args: readonly string[], input: Buffer, env: NodeJS.ProcessEnv, capture = false,
  ): Promise<number | { code: number; output: Buffer }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.gitPath, [...args], { cwd: this.repositoryRoot, env, shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill(), GIT_TIMEOUT);
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_GIT_OUTPUT) stdout.push(chunk); else child.kill(); });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        const result = code ?? 2;
        resolvePromise(capture ? { code: result, output: Buffer.concat(stdout) } : result);
      });
      child.stdin.end(input);
    });
  }

  private async load(): Promise<State> {
    try {
      const source = await readFile(this.statePath);
      if (source.byteLength > MAX_STATE) throw new Error("size");
      return parseState(JSON.parse(source.toString("utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, revision: 0, active: null, archived: [] };
      throw new IntegrationQueueError("corrupt-state", "Integration queue state is corrupt or unsupported.");
    }
  }

  private async save(state: State, lease: ScopeLease): Promise<void> {
    const source = JSON.stringify(state);
    if (Buffer.byteLength(source) > MAX_STATE) throw new IntegrationQueueError("corrupt-state", "Queue state exceeds its bound.");
    await lease.assertHeld().catch(() => { throw new IntegrationQueueError("queue-lease", "Queue authority was lost."); });
    const temporary = join(this.stateRoot, `.state.${randomUUID()}.tmp`);
    let moved = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.statePath);
      moved = true;
      await chmod(this.statePath, 0o600).catch(() => undefined);
      const directory = await open(this.stateRoot, "r").catch(() => undefined);
      try { await directory?.sync().catch(() => undefined); } finally { await directory?.close().catch(() => undefined); }
    } finally { if (!moved) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async saveRevision(state: State, lease: ScopeLease): Promise<void> {
    state.revision += 1;
    await this.save(state, lease);
  }

  private async acquire(): Promise<ScopeLease> {
    try {
      return await this.registry.acquire({ ownerId: `integration-queue:${process.pid}:${randomUUID()}`, scope: LEASE_SCOPE, ttlMs: 10 * 60_000 });
    } catch (error) {
      if (error instanceof ScopeLeaseError) throw new IntegrationQueueError("queue-lease", "Queue authority is held by another operation.");
      throw error;
    }
  }

  private async transaction<T>(operation: (
    state: State, lease: ScopeLease,
  ) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }): Promise<T> {
    const queued = this.serial.then(async () => {
      const lease = await this.acquire();
      try {
        const state = await this.load();
        const result = await operation(state, lease);
        if (result.changed) await this.saveRevision(state, lease);
        return result.result;
      } finally { await lease.release().catch(() => lease.close()); }
    });
    this.serial = queued.then(() => undefined, () => undefined);
    return queued;
  }
}
