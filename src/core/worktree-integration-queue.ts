import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { ScopeLeaseError, ScopeLeaseRegistry, type ScopeLease } from "./scope-lease-registry.js";
import type {
  ContainedValidationResult,
  IntegrationQueueErrorCode,
  IntegrationQueueBlocker,
  IntegrationQueueSnapshot,
  ParallelDispatchArchive,
  ParallelDispatchArchiveTask,
  WorktreeCommitArtifact,
} from "./types.js";
import { runContainedValidation } from "./worktree-commit-artifact.js";
import { normalizeWorktreeScopePath } from "./worktree-scope.js";
import { WorktreeLifecycle } from "./worktree-lifecycle.js";

const VERSION = 3;
const MAX_ARCHIVED = 16;
const MAX_STATE = 1024 * 1024;
const MAX_PATCH = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const GIT_TIMEOUT = 60_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const HASH = /^[0-9a-f]{64}$/u;
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/u;
const MAX_COMMAND_PARTS = 129;
const MAX_COMMAND_TEXT = 1000;
const MAX_TASKS = 5;
const VALIDATION_TIMEOUT = 10 * 60_000;
const LEASE_TTL = VALIDATION_TIMEOUT + 2 * 60_000;
const LEASE_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/integration-queue-v2"] });

type StoredTask = {
  task_id: string;
  depends_on: string[];
  worktree_id: string;
  branch: string;
  base_sha: string;
  source_commit: string;
  original_source_commit: string;
  changed_paths: string[];
  validation_command: string[];
  synthetic_commit: string | null;
};

type StoredValidation = {
  command: string[];
  status: "pending" | "pass" | "fail";
  exit_code: number | null;
  fingerprint: string | null;
  candidate_head: string | null;
};

type StoredReview = {
  status: "pending" | "pass" | "fail";
  fingerprint: string | null;
  candidate_head: string | null;
};

type Queue = {
  owner_root: string;
  run_id: string;
  contract_fingerprint: string;
  archive_fingerprint: string;
  target_ref: string;
  target_base: string;
  phase: "queued" | "preparing" | "remediation-required" | "prepared" | "integrated" | "failed";
  candidate_head: string | null;
  candidate_ref: string;
  failure_code: IntegrationQueueErrorCode | null;
  validation: StoredValidation;
  review: StoredReview;
  blocker: IntegrationQueueBlocker | null;
  remediation_attempts_used: 0 | 1;
  tasks: StoredTask[];
  cleanup_pending: string[];
  warnings: string[];
};

type State = { version: 3; revision: number; active: Queue | null; archived: Queue[] };

class MergeConflictError extends Error {
  constructor(readonly paths: string[]) { super("merge-conflict"); }
}

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

function parseCommand(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_PARTS ||
    !value.every((part) => text(part, MAX_COMMAND_TEXT)) || !isAbsolute(value[0] as string)) throw new Error("command");
  return [...value] as string[];
}

function parseBlocker(value: unknown): IntegrationQueueBlocker | null {
  if (value === null) return null;
  const codes = ["merge-conflict", "validation-failed", "review-failed", "remediation-exhausted"];
  if (!record(value) || !keys(value, ["attempts_remaining", "candidate_base", "causal_task_ids", "code", "conflict_paths", "task_id"]) ||
    !codes.includes(value.code as string) || !text(value.task_id, 128) || typeof value.candidate_base !== "string" || !SHA.test(value.candidate_base) ||
    !Array.isArray(value.conflict_paths) || value.conflict_paths.length > 256 || !value.conflict_paths.every((path) => text(path, 1024)) ||
    !Array.isArray(value.causal_task_ids) || value.causal_task_ids.length > MAX_TASKS || !value.causal_task_ids.every((id) => text(id, 128)) ||
    ![0, 1].includes(value.attempts_remaining as number)) throw new Error("blocker");
  return value as unknown as IntegrationQueueBlocker;
}

function parseValidation(value: unknown): StoredValidation {
  if (!record(value) || !keys(value, ["candidate_head", "command", "exit_code", "fingerprint", "status"]) ||
    !["pending", "pass", "fail"].includes(value.status as string) ||
    !(value.exit_code === null || Number.isInteger(value.exit_code)) ||
    !(value.fingerprint === null || (typeof value.fingerprint === "string" && HASH.test(value.fingerprint))) ||
    !(value.candidate_head === null || (typeof value.candidate_head === "string" && SHA.test(value.candidate_head)))) throw new Error("validation");
  return { command: parseCommand(value.command), status: value.status as StoredValidation["status"], exit_code: value.exit_code as number | null,
    fingerprint: value.fingerprint as string | null, candidate_head: value.candidate_head as string | null };
}

function parseReview(value: unknown): StoredReview {
  if (!record(value) || !keys(value, ["candidate_head", "fingerprint", "status"]) || !["pending", "pass", "fail"].includes(value.status as string) ||
    !(value.fingerprint === null || (typeof value.fingerprint === "string" && HASH.test(value.fingerprint))) ||
    !(value.candidate_head === null || (typeof value.candidate_head === "string" && SHA.test(value.candidate_head)))) throw new Error("review");
  return value as unknown as StoredReview;
}

function cleanGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}

function parseTask(value: unknown): StoredTask {
  if (!record(value) || !keys(value, [
    "base_sha", "branch", "changed_paths", "depends_on", "original_source_commit", "source_commit", "synthetic_commit", "task_id",
    "validation_command", "worktree_id",
  ]) || !text(value.task_id, 128) || !text(value.worktree_id, 256) || !text(value.branch, 256) ||
    typeof value.base_sha !== "string" || !SHA.test(value.base_sha) ||
    typeof value.source_commit !== "string" || !SHA.test(value.source_commit) ||
    typeof value.original_source_commit !== "string" || !SHA.test(value.original_source_commit) ||
    !(value.synthetic_commit === null || (typeof value.synthetic_commit === "string" && SHA.test(value.synthetic_commit))) ||
    !Array.isArray(value.depends_on) || value.depends_on.length > MAX_TASKS || !value.depends_on.every((item) => text(item, 128)) ||
    !Array.isArray(value.changed_paths) || value.changed_paths.length > 256 ||
    !value.changed_paths.every((item) => text(item, 1024))) throw new Error("task");
  return { ...value, validation_command: parseCommand(value.validation_command) } as unknown as StoredTask;
}

function parseQueue(value: unknown): Queue {
  const queue = value;
  if (!record(queue) || !keys(queue, [
    "archive_fingerprint", "blocker", "candidate_head", "candidate_ref", "cleanup_pending", "contract_fingerprint", "failure_code", "owner_root",
    "phase", "remediation_attempts_used", "review", "run_id", "target_base", "target_ref", "tasks", "validation", "warnings",
  ]) || !text(queue.owner_root, 256) || !text(queue.run_id, 128) || typeof queue.contract_fingerprint !== "string" ||
    !HASH.test(queue.contract_fingerprint) || typeof queue.archive_fingerprint !== "string" || !HASH.test(queue.archive_fingerprint) ||
    typeof queue.target_ref !== "string" || !REF.test(queue.target_ref) || typeof queue.target_base !== "string" ||
    !SHA.test(queue.target_base) || !["queued", "preparing", "remediation-required", "prepared", "integrated", "failed"].includes(queue.phase as string) ||
    typeof queue.candidate_ref !== "string" || !/^refs\/sortie-dogs\/integration-candidates\/[0-9a-f]{16}$/u.test(queue.candidate_ref) ||
    !(queue.candidate_head === null || (typeof queue.candidate_head === "string" && SHA.test(queue.candidate_head))) ||
    !(queue.failure_code === null || text(queue.failure_code, 64)) || !Array.isArray(queue.tasks) ||
    queue.tasks.length === 0 || queue.tasks.length > MAX_TASKS || !Array.isArray(queue.cleanup_pending) ||
    !queue.cleanup_pending.every((item) => text(item, 256)) || !Array.isArray(queue.warnings) ||
    queue.warnings.length > MAX_TASKS || !queue.warnings.every((item) => text(item, 512)) || ![0, 1].includes(queue.remediation_attempts_used as number)) throw new Error("queue");
  const tasks = queue.tasks.map(parseTask);
  if (new Set(tasks.map(({ task_id }) => task_id)).size !== tasks.length ||
    new Set(tasks.map(({ source_commit }) => source_commit)).size !== tasks.length) throw new Error("identities");
  return { ...queue, tasks, validation: parseValidation(queue.validation), review: parseReview(queue.review), blocker: parseBlocker(queue.blocker) } as Queue;
}

function parseState(value: unknown): State {
  if (!record(value) || !keys(value, ["active", "archived", "revision", "version"]) || value.version !== VERSION ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.archived) ||
    value.archived.length > MAX_ARCHIVED) throw new Error("state");
  const active = value.active === null ? null : parseQueue(value.active);
  const archived = value.archived.map(parseQueue);
  if (archived.some((queue) => queue.phase !== "integrated" || queue.cleanup_pending.length !== 0) ||
    new Set(archived.map(({ run_id }) => run_id)).size !== archived.length) throw new Error("archive");
  return { version: 3, revision: value.revision as number, active, archived };
}

function validateArchive(archive: ParallelDispatchArchive): void {
  if (!record(archive) || !text(archive.owner_root, 256) || !text(archive.run_id, 128) ||
    typeof archive.contract_fingerprint !== "string" || !HASH.test(archive.contract_fingerprint) || archive.cancelled ||
    archive.terminal_reason !== "completed" || !Array.isArray(archive.tasks) || archive.tasks.length === 0 || archive.tasks.length > MAX_TASKS) {
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
      !SHA.test(candidate.artifact.commit_sha) || !record(candidate.artifact.validation) ||
      !Array.isArray(candidate.artifact.validation.command)) {
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
    try { parseCommand(task.artifact.validation.command); } catch {
      throw new IntegrationQueueError("invalid-archive", "Artifact validation command is invalid.");
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
        candidate_ref: `refs/sortie-dogs/integration-candidates/${fingerprint(archive.run_id).slice(0, 16)}`,
        failure_code: null,
        validation: { command: [...order[0]!.artifact!.validation.command], status: "pending", exit_code: null, fingerprint: null, candidate_head: null },
        review: { status: "pending", fingerprint: null, candidate_head: null },
        blocker: null,
        remediation_attempts_used: 0,
        tasks: order.map((task) => ({
          task_id: task.task_id,
          depends_on: [...task.depends_on],
          worktree_id: task.worktree_id,
          branch: task.branch,
          base_sha: task.base_sha,
          source_commit: task.artifact!.commit_sha,
          original_source_commit: task.artifact!.commit_sha,
          changed_paths: [...task.artifact!.changed_paths],
          validation_command: [...task.artifact!.validation.command],
          synthetic_commit: null,
        })),
        cleanup_pending: order.filter(({ managed_path }) => managed_path !== null).map(({ worktree_id }) => worktree_id),
        warnings: [],
      };
      if (!queue.tasks.every(({ validation_command }) => JSON.stringify(validation_command) === JSON.stringify(queue.validation.command))) {
        queue.phase = "failed";
        queue.failure_code = "validation-failed";
        queue.blocker = this.blocker("validation-failed", queue.tasks.find(({ validation_command }) =>
          JSON.stringify(validation_command) !== JSON.stringify(queue.validation.command))!, queue.target_base, [], [], 0);
      }
      for (const task of queue.tasks) {
        const sourceRef = `refs/sortie-dogs/integration-queue/${fingerprint(queue.run_id).slice(0, 16)}/${fingerprint(task.task_id).slice(0, 16)}`;
        await this.ensureSourceRef(sourceRef, task.source_commit);
      }
      state.active = queue;
      return { result: this.publicSnapshot(queue), changed: true };
    });
  }

  /** Compatibility entry point: builds and validates a candidate but never updates the target. */
  async integrate(ownerRoot: string, runID: string): Promise<IntegrationQueueSnapshot> {
    return this.prepare(ownerRoot, runID);
  }

  async prepare(ownerRoot: string, runID: string): Promise<IntegrationQueueSnapshot> {
    return this.transaction(async (state, lease) => {
      const archived = this.findArchived(state, ownerRoot, runID);
      if (archived !== undefined) return { result: this.publicSnapshot(archived), changed: false };
      const queue = this.requireQueue(state, ownerRoot, runID);
      const currentTarget = await this.targetHead(queue);
      if (queue.candidate_head !== null && currentTarget === queue.candidate_head && queue.review.status === "pass") {
        queue.phase = "integrated";
        queue.failure_code = null;
        return { result: this.publicSnapshot(queue), changed: true };
      }
      if (queue.phase === "integrated" || queue.phase === "prepared") return { result: this.publicSnapshot(queue), changed: false };
      if (queue.phase === "failed" || queue.phase === "remediation-required") {
        throw new IntegrationQueueError(queue.failure_code!, "Queue is not preparable in its current phase.");
      }
      if (currentTarget !== queue.target_base) {
        queue.phase = "failed";
        queue.failure_code = "stale-target";
        return { result: this.publicSnapshot(queue), changed: true };
      }
      try { await this.assertTargetSafe(queue.target_base); }
      catch (error) {
        if (!(error instanceof IntegrationQueueError)) throw error;
        queue.phase = "failed";
        queue.failure_code = error.code;
        return { result: this.publicSnapshot(queue), changed: true };
      }
      queue.phase = "preparing";
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
          if (error instanceof MergeConflictError) {
            const exhausted = queue.remediation_attempts_used === 1;
            queue.phase = exhausted ? "failed" : "remediation-required";
            queue.failure_code = exhausted ? "remediation-exhausted" : "merge-conflict";
            const conflicts = [...new Set(error.paths)].sort();
            const causal = queue.tasks.slice(0, index).filter((prior) =>
              prior.changed_paths.some((path) => conflicts.includes(path))).map(({ task_id }) => task_id);
            queue.blocker = this.blocker(exhausted ? "remediation-exhausted" : "merge-conflict", task, head,
              conflicts, causal, exhausted ? 0 : 1);
            return { result: this.publicSnapshot(queue), changed: true };
          }
          if (error instanceof IntegrationQueueError) {
            queue.phase = "failed";
            queue.failure_code = error.code;
            return { result: this.publicSnapshot(queue), changed: true };
          }
          throw error;
        }
        task.synthetic_commit = head;
        await this.saveRevision(state, lease);
      }
      queue.candidate_head = head;
      let validation: ContainedValidationResult;
      try {
        await this.ensureSourceRef(queue.candidate_ref, head);
        await this.saveRevision(state, lease);
        if (await this.hasConflictMarkers(queue, head)) {
          queue.validation = { ...queue.validation, status: "fail", exit_code: null,
            fingerprint: fingerprint([head, "conflict-marker"]), candidate_head: head };
          queue.phase = "failed";
          queue.failure_code = "validation-failed";
          queue.blocker = this.blocker("validation-failed", queue.tasks.at(-1)!, head, [], [], 0);
          return { result: this.publicSnapshot(queue), changed: true };
        }
        validation = await this.validateCandidate(queue);
      } catch (error) {
        if (!(error instanceof IntegrationQueueError)) throw error;
        queue.phase = "failed";
        queue.failure_code = error.code;
        return { result: this.publicSnapshot(queue), changed: true };
      }
      queue.validation = { command: [...validation.command], status: validation.ok ? "pass" : "fail",
        exit_code: validation.exit_code, fingerprint: validation.fingerprint, candidate_head: head };
      if (!validation.ok) {
        queue.phase = "failed";
        queue.failure_code = "validation-failed";
        queue.blocker = this.blocker("validation-failed", queue.tasks.at(-1)!, head, [], [], 0);
      } else {
        queue.phase = "prepared";
        queue.failure_code = null;
        queue.blocker = null;
      }
      return { result: this.publicSnapshot(queue), changed: true };
    });
  }

  async accept(ownerRoot: string, runID: string, decision: {
    readonly candidate_head: string; readonly review: "pass" | "fail"; readonly review_fingerprint: string;
  }): Promise<IntegrationQueueSnapshot> {
    const accepted = await this.transaction(async (state, lease) => {
      const archived = this.findArchived(state, ownerRoot, runID);
      if (archived !== undefined) return { result: this.publicSnapshot(archived), changed: false };
      const queue = this.requireQueue(state, ownerRoot, runID);
      if (!record(decision) || !keys(decision, ["candidate_head", "review", "review_fingerprint"]) ||
        typeof decision.candidate_head !== "string" || !SHA.test(decision.candidate_head) ||
        !["pass", "fail"].includes(decision.review) || !HASH.test(decision.review_fingerprint)) {
        throw new IntegrationQueueError("invalid-archive", "Review decision is invalid.");
      }
      const currentTarget = await this.targetHead(queue);
      if (queue.candidate_head !== null && currentTarget === queue.candidate_head && queue.review.status === "pass") {
        queue.phase = "integrated";
        return { result: this.publicSnapshot(queue), changed: true };
      }
      if (queue.phase !== "prepared" || queue.candidate_head !== decision.candidate_head || queue.validation.status !== "pass" ||
        queue.validation.candidate_head !== decision.candidate_head) throw new IntegrationQueueError("validation-failed", "Prepared validation evidence is absent.");
      queue.review = { status: decision.review, fingerprint: decision.review_fingerprint, candidate_head: decision.candidate_head };
      await this.saveRevision(state, lease);
      if (decision.review === "fail") {
        queue.phase = "failed"; queue.failure_code = "review-failed";
        queue.blocker = this.blocker("review-failed", queue.tasks.at(-1)!, decision.candidate_head, [], [], 0);
        return { result: this.publicSnapshot(queue), changed: true };
      }
      try { await this.assertTargetSafe(queue.target_base); }
      catch (error) {
        if (!(error instanceof IntegrationQueueError)) throw error;
        queue.phase = "failed";
        queue.failure_code = error.code;
        return { result: this.publicSnapshot(queue), changed: true };
      }
      if (await this.targetHead(queue) !== queue.target_base) {
        queue.phase = "failed";
        queue.failure_code = "stale-target";
        return { result: this.publicSnapshot(queue), changed: true };
      }
      try { await this.git(["update-ref", queue.target_ref, decision.candidate_head, queue.target_base]); }
      catch {
        queue.phase = "failed";
        const afterFailure = await this.targetHead(queue).catch(() => undefined);
        queue.failure_code = afterFailure === queue.target_base ? "git-incompatible" :
          afterFailure === undefined ? "git-incompatible" : "stale-target";
        return { result: this.publicSnapshot(queue), changed: true };
      }
      queue.phase = "integrated"; queue.failure_code = null; queue.blocker = null;
      return { result: this.publicSnapshot(queue), changed: true };
    });
    return accepted.phase === "integrated" ? this.cleanup(ownerRoot, runID) : accepted;
  }

  async submitRemediation(ownerRoot: string, runID: string, artifact: WorktreeCommitArtifact): Promise<IntegrationQueueSnapshot> {
    return this.transaction(async (state) => {
      const queue = this.requireQueue(state, ownerRoot, runID);
      const blocker = queue.blocker;
      if (queue.phase !== "remediation-required" || blocker === null || blocker.attempts_remaining !== 1 ||
        queue.remediation_attempts_used !== 0) throw new IntegrationQueueError("remediation-exhausted", "Remediation is unavailable.");
      const taskIndex = queue.tasks.findIndex(({ task_id }) => task_id === blocker.task_id);
      const task = queue.tasks[taskIndex];
      if (task === undefined || !record(artifact) || artifact.task_id !== task.task_id || artifact.base_sha !== blocker.candidate_base ||
        artifact.validation.exit_code !== 0 || JSON.stringify(artifact.validation.command) !== JSON.stringify(queue.validation.command) ||
        !text(artifact.branch, 256) || !SHA.test(artifact.commit_sha) || !HASH.test(artifact.change_fingerprint) ||
        artifact.changed_paths.length === 0 || artifact.changed_paths.length > 256) {
        throw new IntegrationQueueError("invalid-archive", "Replacement artifact identity is invalid.");
      }
      const allowed = new Set(task.changed_paths.map(normalizeWorktreeScopePath));
      let replacementPaths: string[];
      try { replacementPaths = artifact.changed_paths.map((path) => { const normalized = normalizeWorktreeScopePath(path); if (!allowed.has(normalized)) throw new Error(); return path; }); }
      catch { throw new IntegrationQueueError("invalid-archive", "Replacement broadens the failing task scope."); }
      const replacement = { ...task, base_sha: artifact.base_sha, source_commit: artifact.commit_sha, branch: artifact.branch,
        changed_paths: replacementPaths, validation_command: [...artifact.validation.command] };
      await this.verifyStoredArtifact(replacement, blocker.candidate_base);
      const replacementRef = `refs/sortie-dogs/integration-queue/${fingerprint(queue.run_id).slice(0, 16)}/${fingerprint(`${task.task_id}:remediation`).slice(0, 16)}`;
      await this.ensureSourceRef(replacementRef, replacement.source_commit);
      queue.tasks[taskIndex] = replacement;
      for (let index = taskIndex; index < queue.tasks.length; index += 1) queue.tasks[index]!.synthetic_commit = null;
      queue.candidate_head = null;
      queue.validation = { ...queue.validation, status: "pending", exit_code: null, fingerprint: null, candidate_head: null };
      queue.review = { status: "pending", fingerprint: null, candidate_head: null };
      queue.remediation_attempts_used = 1; queue.phase = "queued"; queue.failure_code = null; queue.blocker = null;
      return { result: this.publicSnapshot(queue), changed: true };
    });
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

  private async verifyStoredArtifact(task: StoredTask, target: string): Promise<void> {
    try {
      await this.git(["cat-file", "-e", `${task.source_commit}^{commit}`]);
      const parents = (await this.git(["rev-list", "--parents", "-n", "1", task.source_commit])).toString("utf8").trim().split(" ");
      if (parents.length !== 2 || parents[0] !== task.source_commit || parents[1] !== task.base_sha) throw new Error();
      const changed = (await this.git(["diff-tree", "--no-commit-id", "--name-only", "-z", task.base_sha, task.source_commit, "--"]))
        .toString("utf8").split("\0").filter(Boolean).sort();
      if (JSON.stringify(changed) !== JSON.stringify([...task.changed_paths].sort())) throw new Error();
      if (await this.gitStatus(["merge-base", "--is-ancestor", task.base_sha, target]) !== 0) throw new Error();
    } catch { throw new IntegrationQueueError("invalid-archive", "Replacement artifact Git identity is invalid."); }
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
      if (applied !== 0) {
        const conflicts = (await this.git(["ls-files", "-u", "-z"], env)).toString("utf8").split("\0").filter(Boolean)
          .map((entry) => entry.slice(entry.indexOf("\t") + 1)).filter((path) => text(path, 1024));
        throw new MergeConflictError([...new Set(conflicts)].sort());
      }
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

  private blocker(code: IntegrationQueueBlocker["code"], task: StoredTask, candidateBase: string,
    conflictPaths: string[], causalTaskIDs: string[], attempts: 0 | 1): IntegrationQueueBlocker {
    return { code, task_id: task.task_id, candidate_base: candidateBase, conflict_paths: conflictPaths,
      causal_task_ids: [...new Set(causalTaskIDs)], attempts_remaining: attempts };
  }

  private async targetHead(queue: Queue): Promise<string> {
    return (await this.git(["rev-parse", "--verify", `${queue.target_ref}^{commit}`])).toString("utf8").trim();
  }

  private async hasConflictMarkers(queue: Queue, candidate: string): Promise<boolean> {
    for (const path of [...new Set(queue.tasks.flatMap(({ changed_paths }) => changed_paths))]) {
      const sizeText = (await this.git(["cat-file", "-s", `${candidate}:${path}`]).catch(() => Buffer.from("0"))).toString("utf8").trim();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024) continue;
      const content = await this.git(["show", `${candidate}:${path}`], undefined, 1024 * 1024);
      if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/mu.test(content.toString("utf8"))) return true;
    }
    return false;
  }

  private async validateCandidate(queue: Queue): Promise<ContainedValidationResult> {
    const path = join(this.stateRoot, `validation-${randomUUID()}`);
    let added = false;
    try {
      await this.git(["worktree", "add", "--detach", path, queue.candidate_head!]);
      added = true;
      const beforeHead = (await WorktreeIntegrationQueue.runGitAt(this.gitPath, path, ["rev-parse", "--verify", "HEAD^{commit}"])).toString("utf8").trim();
      const beforeStatus = await WorktreeIntegrationQueue.runGitAt(this.gitPath, path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
      if (beforeHead !== queue.candidate_head || beforeStatus.length !== 0) throw new IntegrationQueueError("validation-failed", "Validation worktree is not exact and clean.");
      const result = await runContainedValidation({ executable: queue.validation.command[0]!, args: queue.validation.command.slice(1),
        cwd: path, timeout_ms: VALIDATION_TIMEOUT });
      const afterHead = (await WorktreeIntegrationQueue.runGitAt(this.gitPath, path, ["rev-parse", "--verify", "HEAD^{commit}"])).toString("utf8").trim();
      const afterStatus = await WorktreeIntegrationQueue.runGitAt(this.gitPath, path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
      if (afterHead !== queue.candidate_head || afterStatus.length !== 0) {
        return { ok: false, command: result.command, exit_code: result.exit_code,
          fingerprint: result.fingerprint, error: "execution-failed" };
      }
      return result;
    } finally {
      if (added) {
        const clean = await WorktreeIntegrationQueue.runGitAt(this.gitPath, path, ["status", "--porcelain=v1", "--untracked-files=normal"])
          .then((output) => output.length === 0, () => false);
        if (clean) {
          try { await this.git(["worktree", "remove", path]); }
          catch { throw new IntegrationQueueError("validation-failed", "Validation worktree removal failed."); }
        } else {
          throw new IntegrationQueueError("validation-failed", "Validation worktree was not clean after validation.");
        }
      }
    }
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
      candidate_ref: queue.candidate_ref,
      validation: Object.freeze({ ...queue.validation, command: Object.freeze([...queue.validation.command]) }),
      review: Object.freeze({ ...queue.review }),
      blocker: queue.blocker === null ? null : Object.freeze({ ...queue.blocker,
        conflict_paths: Object.freeze([...queue.blocker.conflict_paths]), causal_task_ids: Object.freeze([...queue.blocker.causal_task_ids]) }),
      remediation_attempts_used: queue.remediation_attempts_used,
      tasks: Object.freeze(queue.tasks.map((task) => Object.freeze({
        task_id: task.task_id, source_commit: task.source_commit, original_source_commit: task.original_source_commit,
        synthetic_commit: task.synthetic_commit,
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 3, revision: 0, active: null, archived: [] };
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
      return await this.registry.acquire({ ownerId: `integration-queue:${process.pid}:${randomUUID()}`, scope: LEASE_SCOPE, ttlMs: LEASE_TTL });
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
