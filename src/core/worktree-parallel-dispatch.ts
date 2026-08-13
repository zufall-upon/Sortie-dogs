import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { ScopeLeaseError, ScopeLeaseRegistry, type ScopeLease } from "./scope-lease-registry.js";
import type {
  ParallelDispatchArchive,
  ParallelDispatchDescriptor,
  ParallelDispatchOutcome,
  ParallelDispatchSnapshot,
  ParallelDispatchTaskPhase,
  WorktreeParallelContract,
  WorktreeParallelTask,
} from "./types.js";
import { validateWorktreeParallelSchema } from "./validate-schema.js";
import { validateWorktreeParallelContract } from "./validate-worktree-parallel.js";
import { WorktreeLifecycle, WorktreeLifecycleError, type ManagedWorktree } from "./worktree-lifecycle.js";

const VERSION = 2;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_TASKS = 3;
const MAX_ARCHIVES = 16;
const MAX_TEXT = 4096;
const LOCK_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const PHASES = new Set<ParallelDispatchTaskPhase>([
  "pending", "reserved", "running", "completed", "failed", "suppressed", "abandoned",
]);
const OUTCOMES = new Set<ParallelDispatchOutcome>(["completed", "failed", "blocked", "cancelled"]);
const TERMINAL_REASONS = new Set(["completed", "cancelled", "failed"]);
const STATE_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/parallel-dispatch-state"] });
const PREPARE_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/parallel-dispatch-prepare"] });

export type ParallelDispatchErrorCode =
  | "invalid-contract"
  | "stale-base"
  | "dirty-tree"
  | "active-run"
  | "descriptor-mismatch"
  | "descriptor-replay"
  | "outcome-conflict"
  | "corrupt-state"
  | "state-locked"
  | "lifecycle-failed";

export class ParallelDispatchError extends Error {
  readonly code: ParallelDispatchErrorCode;

  constructor(code: ParallelDispatchErrorCode, message: string) {
    super(message);
    this.name = "ParallelDispatchError";
    this.code = code;
  }
}

export type ParallelDispatchPrepareResult =
  | { readonly status: "prepared"; readonly snapshot: ParallelDispatchSnapshot }
  | { readonly status: "serial-fallback"; readonly reason: "scope-overlap" | "dependency-ambiguous" };

type StoredTask = {
  descriptor: ParallelDispatchDescriptor;
  worktree_id: string;
  phase: ParallelDispatchTaskPhase;
  call_id: string | null;
  child_session_id: string | null;
  outcome: ParallelDispatchOutcome | null;
};

type StoredRun = {
  kind: "run";
  run_id: string;
  owner_root: string;
  project_root: string;
  contract_fingerprint: string;
  max_workers: number;
  cancelled: boolean;
  tasks: StoredTask[];
};

type PreparingTask = {
  dispatch_id: string;
  task_id: string;
  worktree_id: string;
  lifecycle_identity: string;
  branch: string;
  base_sha: string;
  depends_on: string[];
  scope_read: string[];
  scope_write: string[];
};

type StoredPreparation = {
  kind: "preparing";
  run_id: string;
  owner_root: string;
  project_root: string;
  contract_fingerprint: string;
  max_workers: number;
  create_attempted: boolean;
  tasks: PreparingTask[];
};

type StoredRunArchive = {
  kind: "run";
  terminal_reason: "completed" | "cancelled" | "failed";
  run: StoredRun;
};

type StoredPreparationArchive = {
  kind: "preparation";
  terminal_reason: "failed";
  preparation: StoredPreparation;
  inventory: Array<{ task_id: string; managed_path: string | null; phase: string | null }>;
};

type StoredArchive = StoredRunArchive | StoredPreparationArchive;
type State = { version: 2; revision: number; run: StoredRun | StoredPreparation | null; archived: StoredArchive[] };

export interface ParallelDispatchCoordinatorOptions {
  readonly repositoryRoot: string;
  readonly gitPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function lifecycleIdentity(value: string): string {
  return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 16);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function cloneDescriptor(value: ParallelDispatchDescriptor): ParallelDispatchDescriptor {
  return Object.freeze({
    ...value,
    depends_on: Object.freeze([...value.depends_on]),
    scope_read: Object.freeze([...value.scope_read]),
    scope_write: Object.freeze([...value.scope_write]),
  });
}

function validStringList(value: unknown, maximum = MAX_TASKS): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((entry) => validText(entry, 512));
}

function validDescriptor(value: unknown): value is ParallelDispatchDescriptor {
  if (!isRecord(value) || !exactKeys(value, [
    "attempt", "base_sha", "branch", "contract_fingerprint", "depends_on", "dispatch_id", "managed_path",
    "parallel_group", "parallel_unit", "parallel_units", "run_id", "scope_read", "scope_write", "task_id",
  ])) return false;
  return typeof value.run_id === "string" && UUID.test(value.run_id) &&
    typeof value.dispatch_id === "string" && UUID.test(value.dispatch_id) &&
    validText(value.task_id, 128) && validText(value.managed_path) && isAbsolute(value.managed_path) &&
    validText(value.branch, 256) && typeof value.base_sha === "string" && SHA.test(value.base_sha) &&
    validStringList(value.depends_on) && validStringList(value.scope_read, 256) &&
    validStringList(value.scope_write, 256) && value.scope_write.length > 0 &&
    value.parallel_group === value.run_id && value.parallel_unit === value.task_id &&
    Number.isInteger(value.parallel_units) && (value.parallel_units as number) >= 2 &&
    (value.parallel_units as number) <= MAX_TASKS && value.attempt === 1 &&
    typeof value.contract_fingerprint === "string" && HASH.test(value.contract_fingerprint);
}

function validHeader(value: Record<string, unknown>): boolean {
  return typeof value.run_id === "string" && UUID.test(value.run_id) && validText(value.owner_root, 256) &&
    validText(value.project_root) && isAbsolute(value.project_root) &&
    typeof value.contract_fingerprint === "string" && HASH.test(value.contract_fingerprint) &&
    Number.isInteger(value.max_workers) && (value.max_workers as number) >= 2 &&
    (value.max_workers as number) <= MAX_TASKS && Array.isArray(value.tasks) &&
    value.tasks.length >= 2 && value.tasks.length <= MAX_TASKS;
}

function parseRun(raw: unknown): StoredRun {
  if (!isRecord(raw) || !exactKeys(raw, [
    "cancelled", "contract_fingerprint", "kind", "max_workers", "owner_root", "project_root", "run_id", "tasks",
  ]) || raw.kind !== "run" || !validHeader(raw) || typeof raw.cancelled !== "boolean") throw new Error("run");
  const ids = new Set<string>();
  const dispatches = new Set<string>();
  const calls = new Set<string>();
  const tasks: StoredTask[] = [];
  const rawTasks = raw.tasks as unknown[];
  for (const value of rawTasks) {
    if (!isRecord(value) || !exactKeys(value, ["call_id", "child_session_id", "descriptor", "outcome", "phase", "worktree_id"]) ||
      !validText(value.worktree_id, 256) || !validDescriptor(value.descriptor) || ids.has(value.descriptor.task_id) ||
      dispatches.has(value.descriptor.dispatch_id) || typeof value.phase !== "string" ||
      !PHASES.has(value.phase as ParallelDispatchTaskPhase) || !(value.call_id === null || validText(value.call_id, 256)) ||
      !(value.child_session_id === null || validText(value.child_session_id, 256)) ||
      !(value.outcome === null || (typeof value.outcome === "string" && OUTCOMES.has(value.outcome as ParallelDispatchOutcome)))) {
      throw new Error("task");
    }
    const task = value as unknown as StoredTask;
    const suppressedOutcomeValid = task.phase !== "suppressed" || task.outcome === null || task.outcome === "cancelled";
    if (task.descriptor.run_id !== raw.run_id || task.descriptor.contract_fingerprint !== raw.contract_fingerprint ||
      task.descriptor.parallel_units !== rawTasks.length ||
      ((task.phase === "pending" || task.phase === "reserved") &&
        (task.call_id !== null || task.child_session_id !== null || task.outcome !== null)) ||
      (task.phase === "running" && (task.call_id === null || task.outcome !== null)) ||
      (["completed", "failed"].includes(task.phase) && (task.call_id === null || task.outcome === null)) ||
      (task.phase === "abandoned" && task.outcome !== null) || !suppressedOutcomeValid ||
      (task.call_id !== null && calls.has(task.call_id))) throw new Error("task-state");
    ids.add(task.descriptor.task_id);
    dispatches.add(task.descriptor.dispatch_id);
    if (task.call_id !== null) calls.add(task.call_id);
    tasks.push({ ...task, descriptor: cloneDescriptor(task.descriptor) });
  }
  if (tasks.some((task) => task.descriptor.depends_on.some((dependency) => !ids.has(dependency)))) throw new Error("dependency");
  return { ...(raw as unknown as StoredRun), tasks };
}

function parsePreparation(raw: unknown): StoredPreparation {
  if (!isRecord(raw) || !exactKeys(raw, [
    "contract_fingerprint", "create_attempted", "kind", "max_workers", "owner_root", "project_root", "run_id", "tasks",
  ]) || raw.kind !== "preparing" || !validHeader(raw) || typeof raw.create_attempted !== "boolean") throw new Error("preparation");
  const ids = new Set<string>();
  const worktrees = new Set<string>();
  const branches = new Set<string>();
  const dispatches = new Set<string>();
  const tasks: PreparingTask[] = [];
  for (const value of raw.tasks as unknown[]) {
    if (!isRecord(value) || !exactKeys(value, [
      "base_sha", "branch", "depends_on", "dispatch_id", "lifecycle_identity", "scope_read", "scope_write", "task_id", "worktree_id",
    ]) || typeof value.dispatch_id !== "string" || !UUID.test(value.dispatch_id) ||
      !validText(value.task_id, 128) || !validText(value.worktree_id, 256) ||
      typeof value.lifecycle_identity !== "string" || !/^[0-9a-f]{16}$/u.test(value.lifecycle_identity) ||
      value.lifecycle_identity !== lifecycleIdentity(value.worktree_id) || !validText(value.branch, 256) ||
      typeof value.base_sha !== "string" || !SHA.test(value.base_sha) || !validStringList(value.depends_on) ||
      !validStringList(value.scope_read, 256) || !validStringList(value.scope_write, 256) || value.scope_write.length === 0 ||
      ids.has(value.task_id) || worktrees.has(value.lifecycle_identity) || branches.has(value.branch.toLowerCase()) || dispatches.has(value.dispatch_id)) {
      throw new Error("preparing-task");
    }
    ids.add(value.task_id);
    worktrees.add(value.lifecycle_identity);
    branches.add(value.branch.toLowerCase());
    dispatches.add(value.dispatch_id);
    tasks.push(value as unknown as PreparingTask);
  }
  if (tasks.some((task) => task.depends_on.some((dependency) => !ids.has(dependency)))) throw new Error("preparing-dependency");
  return { ...(raw as unknown as StoredPreparation), tasks };
}

function parseArchive(raw: unknown): StoredArchive {
  if (!isRecord(raw) || typeof raw.terminal_reason !== "string" || !TERMINAL_REASONS.has(raw.terminal_reason)) {
    throw new Error("archive");
  }
  if (raw.kind === "run" && exactKeys(raw, ["kind", "run", "terminal_reason"])) {
    return { kind: "run", terminal_reason: raw.terminal_reason as StoredRunArchive["terminal_reason"], run: parseRun(raw.run) };
  }
  if (raw.kind === "preparation" && raw.terminal_reason === "failed" &&
    exactKeys(raw, ["inventory", "kind", "preparation", "terminal_reason"]) && Array.isArray(raw.inventory) &&
    raw.inventory.length <= MAX_TASKS && raw.inventory.every((entry) => isRecord(entry) &&
      exactKeys(entry, ["managed_path", "phase", "task_id"]) && validText(entry.task_id, 128) &&
      (entry.managed_path === null || (validText(entry.managed_path) && isAbsolute(entry.managed_path))) &&
      (entry.phase === null || validText(entry.phase, 32)))) {
    return { kind: "preparation", terminal_reason: "failed", preparation: parsePreparation(raw.preparation),
      inventory: raw.inventory as StoredPreparationArchive["inventory"] };
  }
  throw new Error("archive");
}

function parseState(raw: unknown): State {
  if (!isRecord(raw) || !exactKeys(raw, ["archived", "revision", "run", "version"]) || raw.version !== VERSION ||
    !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !Array.isArray(raw.archived) ||
    raw.archived.length > MAX_ARCHIVES) throw new Error("state");
  const run = raw.run === null ? null : isRecord(raw.run) && raw.run.kind === "preparing"
    ? parsePreparation(raw.run) : parseRun(raw.run);
  const archived = raw.archived.map(parseArchive);
  const runIDs = archived.map((entry) => entry.kind === "run" ? entry.run.run_id : entry.preparation.run_id);
  if (new Set(runIDs).size !== runIDs.length || (run !== null && runIDs.includes(run.run_id))) throw new Error("archive-identity");
  return { version: 2, revision: raw.revision as number, run, archived };
}

export class ParallelDispatchCoordinator {
  private readonly statePath: string;
  private readonly registry: ScopeLeaseRegistry;
  private queue = Promise.resolve();

  private constructor(
    private readonly repositoryRoot: string,
    private readonly lifecycle: WorktreeLifecycle,
    private readonly stateRoot: string,
  ) {
    this.statePath = join(stateRoot, "state.json");
    this.registry = new ScopeLeaseRegistry(join(stateRoot, "authority"));
  }

  static async open(options: ParallelDispatchCoordinatorOptions): Promise<ParallelDispatchCoordinator> {
    if (!isRecord(options) || !exactKeys(options, ["repositoryRoot", ...(options.gitPath === undefined ? [] : ["gitPath"])]) ||
      !validText(options.repositoryRoot) || (options.gitPath !== undefined && !validText(options.gitPath))) {
      throw new ParallelDispatchError("invalid-contract", "Parallel coordinator options are invalid.");
    }
    const repositoryRoot = await realpath(options.repositoryRoot).catch(() => undefined);
    if (repositoryRoot === undefined) throw new ParallelDispatchError("invalid-contract", "Repository root does not exist.");
    const gitPath = options.gitPath ?? "git";
    const lifecycle = await WorktreeLifecycle.open({ repositoryRoot, ...(options.gitPath === undefined ? {} : { gitPath }) });
    let common: string;
    try {
      const { stdout } = await promisify(execFile)(gitPath, ["rev-parse", "--git-common-dir"], {
        cwd: repositoryRoot, shell: false, windowsHide: true, timeout: 30_000, encoding: "utf8",
      });
      common = await realpath(resolve(repositoryRoot, stdout.trim()));
    } catch {
      throw new ParallelDispatchError("invalid-contract", "Git common directory is unavailable.");
    }
    const stateRoot = join(common, "sortie-dogs", "parallel-dispatch-v2");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o700).catch(() => undefined);
    return new ParallelDispatchCoordinator(repositoryRoot, lifecycle, stateRoot);
  }

  async prepare(contract: WorktreeParallelContract, ownerRoot: string): Promise<ParallelDispatchPrepareResult> {
    if (!validText(ownerRoot, 256)) throw new ParallelDispatchError("invalid-contract", "Coordinator root identity is invalid.");
    const schema = validateWorktreeParallelSchema(contract);
    if (!schema.ok) throw new ParallelDispatchError("invalid-contract", "Parallel contract schema is invalid.");
    if (contract.mode !== "parallel" || contract.tasks.length < 2 || contract.tasks.length > MAX_TASKS ||
      contract.max_workers < 2 || contract.max_workers > contract.tasks.length || contract.artifacts.length !== 0 ||
      contract.failure !== null) throw new ParallelDispatchError("invalid-contract", "Parallel dispatch contract is not a card04 input.");
    const semantic = validateWorktreeParallelContract(contract);
    if (!semantic.ok) {
      const codes = new Set(semantic.diagnostics.map(({ code }) => code));
      if ([...codes].every((code) => code === "WTP006_SCOPE_OVERLAP")) {
        return { status: "serial-fallback", reason: "scope-overlap" };
      }
      const selfDependency = contract.tasks.some((task) => task.depends_on.includes(task.task_id));
      if (!selfDependency && [...codes].every((code) => code === "WTP002_DEPENDENCY_UNKNOWN")) {
        return { status: "serial-fallback", reason: "dependency-ambiguous" };
      }
      throw new ParallelDispatchError("invalid-contract", "Parallel contract semantics are invalid.");
    }
    const contractFingerprint = fingerprint(contract);
    return this.withPrepareAuthority(async () => {
      const hadPreparation = await this.transaction((state) => ({
        result: state.run?.kind === "preparing",
        changed: false,
      }));
      const recovered = await this.recoverPreparation(undefined, true);
      if (hadPreparation && recovered === undefined) {
        throw new ParallelDispatchError("lifecycle-failed", "Durable worktree preparation stopped during reconciliation.");
      }
      const existing = await this.transaction((state) => {
        if (state.run === null) return { result: undefined, changed: false };
        if (state.run.kind !== "run" || state.run.owner_root !== ownerRoot ||
          state.run.contract_fingerprint !== contractFingerprint) {
          throw new ParallelDispatchError("active-run", "Another durable parallel run already owns this repository.");
        }
        return { result: this.publicSnapshot(state.run), changed: false };
      });
      if (existing !== undefined) return { status: "prepared", snapshot: existing } as const;

      const preparation = await this.transaction(async (state) => {
        if (state.run !== null) throw new ParallelDispatchError("active-run", "Another durable parallel run already owns this repository.");
        let pin;
        try {
          pin = await this.lifecycle.pinCleanBase();
        } catch (error) {
          if (error instanceof WorktreeLifecycleError && error.code === "dirty-tree") {
            throw new ParallelDispatchError("dirty-tree", "Primary checkout is dirty.");
          }
          throw error;
        }
        if (contract.tasks.some((task) => task.base_sha !== pin.sha)) {
          throw new ParallelDispatchError("stale-base", "Contract base does not match the clean primary checkout.");
        }
        const value: StoredPreparation = {
          kind: "preparing",
          run_id: randomUUID(),
          owner_root: ownerRoot,
          project_root: this.repositoryRoot,
          contract_fingerprint: contractFingerprint,
          max_workers: contract.max_workers,
          create_attempted: false,
          tasks: contract.tasks.map((task) => ({
            dispatch_id: randomUUID(),
            task_id: task.task_id,
            worktree_id: task.worktree,
            lifecycle_identity: lifecycleIdentity(task.worktree),
            branch: task.branch,
            base_sha: task.base_sha,
            depends_on: [...task.depends_on],
            scope_read: [...task.scope.read],
            scope_write: [...task.scope.write],
          })),
        };
        state.run = value;
        return { result: value, changed: true };
      });

      const snapshot = await this.recoverPreparation(preparation.run_id, true);
      if (snapshot === undefined) throw new ParallelDispatchError("lifecycle-failed", "Managed worktree preparation could not be finalized.");
      return { status: "prepared", snapshot } as const;
    });
  }

  async bindDispatch(ownerRoot: string, callID: string, descriptor: ParallelDispatchDescriptor): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !validText(callID, 256) || !validDescriptor(descriptor)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Parallel dispatch descriptor is invalid.");
    }
    await this.recoverWithAuthority();
    return this.transaction((state) => {
      if (state.run === null && this.findRunArchive(state, ownerRoot, descriptor.run_id) !== undefined) {
        throw new ParallelDispatchError("descriptor-replay", "Parallel dispatch run is already archived.");
      }
      const run = this.requireRun(state, ownerRoot, descriptor.run_id);
      const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
      if (task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor)) {
        throw new ParallelDispatchError("descriptor-mismatch", "Parallel dispatch descriptor does not match durable state.");
      }
      if (task.phase === "running" && task.call_id === callID) return { result: this.publicSnapshot(run), changed: false };
      if (task.phase !== "reserved" || task.call_id !== null || run.cancelled ||
        run.tasks.some((entry) => entry.call_id === callID)) {
        throw new ParallelDispatchError("descriptor-replay", "Parallel dispatch descriptor was already consumed or is not ready.");
      }
      task.phase = "running";
      task.call_id = callID;
      return { result: this.publicSnapshot(run), changed: true };
    });
  }

  async completeCall(
    ownerRoot: string,
    callID: string,
    childSessionID: string | undefined,
    outcome: ParallelDispatchOutcome,
    claimed?: { readonly run_id: string; readonly dispatch_id: string },
  ): Promise<ParallelDispatchSnapshot | undefined> {
    if (!validText(ownerRoot, 256) || !validText(callID, 256) ||
      (childSessionID !== undefined && !validText(childSessionID, 256)) || !OUTCOMES.has(outcome)) {
      throw new ParallelDispatchError("outcome-conflict", "Parallel outcome is invalid.");
    }
    await this.recoverWithAuthority();
    return this.transaction((state) => {
      if (state.run === null || state.run.kind !== "run" || state.run.owner_root !== ownerRoot) {
        const archived = state.archived.find((entry): entry is StoredRunArchive => entry.kind === "run" &&
          entry.run.owner_root === ownerRoot && entry.run.tasks.some((task) => task.call_id === callID));
        if (archived === undefined) return { result: undefined, changed: false };
        const task = archived.run.tasks.find((entry) => entry.call_id === callID)!;
        const effective = claimed !== undefined &&
          (claimed.run_id !== archived.run.run_id || claimed.dispatch_id !== task.descriptor.dispatch_id) ? "failed" : outcome;
        if (task.outcome !== effective || (childSessionID !== undefined && task.child_session_id !== childSessionID)) {
          throw new ParallelDispatchError("outcome-conflict", "A different terminal outcome was already recorded.");
        }
        return { result: this.publicSnapshot(archived.run, true, archived.terminal_reason), changed: false };
      }
      const run = state.run;
      const task = run.tasks.find((entry) => entry.call_id === callID);
      if (task === undefined) return { result: undefined, changed: false };
      const effective = claimed !== undefined &&
        (claimed.run_id !== run.run_id || claimed.dispatch_id !== task.descriptor.dispatch_id) ? "failed" : outcome;
      if (task.phase === "completed" || task.phase === "failed") {
        if (task.outcome !== effective || (childSessionID !== undefined && task.child_session_id !== childSessionID)) {
          throw new ParallelDispatchError("outcome-conflict", "A different terminal outcome was already recorded.");
        }
        return { result: this.publicSnapshot(run), changed: false };
      }
      if (task.phase !== "running") throw new ParallelDispatchError("outcome-conflict", "Dispatch is not running.");
      if (task.child_session_id !== null && childSessionID !== undefined && task.child_session_id !== childSessionID) {
        throw new ParallelDispatchError("outcome-conflict", "Child session identity does not match.");
      }
      if (childSessionID !== undefined) task.child_session_id = childSessionID;
      task.outcome = effective;
      task.phase = effective === "completed" ? "completed" : "failed";
      if (task.phase === "failed") this.suppressDescendants(run, task.descriptor.task_id);
      this.reserveReady(run);
      return { result: this.archiveIfTerminal(state, run), changed: true };
    });
  }

  async cancel(ownerRoot: string, runID?: string): Promise<ParallelDispatchSnapshot | undefined> {
    if (!validText(ownerRoot, 256) || (runID !== undefined && (!validText(runID, 64) || !UUID.test(runID)))) {
      throw new ParallelDispatchError("descriptor-mismatch", "Parallel run identity is invalid.");
    }
    await this.recoverWithAuthority();
    return this.transaction((state) => {
      if (state.run === null) {
        const archived = runID === undefined ? undefined : this.findRunArchive(state, ownerRoot, runID);
        return { result: archived === undefined ? undefined : this.publicSnapshot(archived.run, true, archived.terminal_reason), changed: false };
      }
      const run = this.requireRun(state, ownerRoot, runID);
      if (run.cancelled) return { result: this.publicSnapshot(run), changed: false };
      run.cancelled = true;
      for (const task of run.tasks) {
        if (task.phase === "pending" || task.phase === "reserved") {
          task.phase = "suppressed";
          task.outcome = "cancelled";
        }
      }
      return { result: this.archiveIfTerminal(state, run), changed: true };
    });
  }

  async snapshot(ownerRoot: string, runID?: string): Promise<ParallelDispatchSnapshot | undefined> {
    await this.recoverWithAuthority();
    return this.transaction((state) => {
      if (state.run?.kind === "run" && state.run.owner_root === ownerRoot &&
        (runID === undefined || state.run.run_id === runID)) return { result: this.publicSnapshot(state.run), changed: false };
      const archived = runID === undefined ? undefined : this.findRunArchive(state, ownerRoot, runID);
      return { result: archived === undefined ? undefined : this.publicSnapshot(archived.run, true, archived.terminal_reason), changed: false };
    });
  }

  async archives(ownerRoot: string): Promise<readonly ParallelDispatchArchive[]> {
    await this.recoverWithAuthority();
    return this.transaction((state) => ({
      result: Object.freeze(state.archived.filter((entry) => this.archiveOwner(entry) === ownerRoot).map((entry) => this.publicArchive(entry))),
      changed: false,
    }));
  }

  async reconcile(
    ownerRoot: string,
    activeCallIDs: ReadonlySet<string>,
    runID?: string,
  ): Promise<ParallelDispatchSnapshot | undefined> {
    await this.recoverWithAuthority();
    const inventory = await this.lifecycle.reconcile().catch(() => undefined);
    return this.transaction((state) => {
      if (state.run === null || state.run.kind !== "run" || state.run.owner_root !== ownerRoot ||
        (runID !== undefined && state.run.run_id !== runID)) {
        const archived = runID === undefined ? undefined : this.findRunArchive(state, ownerRoot, runID);
        return { result: archived === undefined ? undefined : this.publicSnapshot(archived.run, true, archived.terminal_reason), changed: false };
      }
      const run = state.run;
      let changed = false;
      for (const task of run.tasks) {
        if (task.phase === "running" && task.call_id !== null && !activeCallIDs.has(task.call_id)) {
          task.phase = "abandoned";
          task.outcome = null;
          this.suppressDescendants(run, task.descriptor.task_id);
          changed = true;
        } else if ((task.phase === "pending" || task.phase === "reserved") &&
          (inventory === undefined || !inventory.some((entry) => entry.phase === "ready" &&
            entry.identity === lifecycleIdentity(task.worktree_id) && samePath(entry.path, task.descriptor.managed_path) &&
            entry.branch === task.descriptor.branch && entry.baseSha === task.descriptor.base_sha))) {
          task.phase = "abandoned";
          this.suppressDescendants(run, task.descriptor.task_id);
          changed = true;
        }
      }
      if (changed) this.reserveReady(run);
      return { result: changed ? this.archiveIfTerminal(state, run) : this.publicSnapshot(run), changed };
    });
  }

  private contractTasks(preparation: StoredPreparation): WorktreeParallelTask[] {
    return preparation.tasks.map((task) => ({
      task_id: task.task_id,
      worktree: task.worktree_id,
      branch: task.branch,
      base_sha: task.base_sha,
      depends_on: [...task.depends_on],
      scope: { read: [...task.scope_read], write: [...task.scope_write] },
    }));
  }

  private async recoverWithAuthority(): Promise<void> {
    await this.withPrepareAuthority(async () => { await this.recoverPreparation(undefined, true); });
  }

  private async recoverPreparation(
    expectedRunID?: string,
    retryEmpty = false,
  ): Promise<ParallelDispatchSnapshot | undefined> {
    const preparation = await this.transaction((state) => ({
      result: state.run?.kind === "preparing" ? state.run : undefined,
      changed: false,
    }));
    if (preparation === undefined) return undefined;
    if (expectedRunID !== undefined && preparation.run_id !== expectedRunID) {
      throw new ParallelDispatchError("active-run", "Another durable parallel run already owns this repository.");
    }
    const inventory = await this.lifecycle.reconcile().catch(() => undefined);
    const resolution = await this.transaction<ParallelDispatchSnapshot | "create" | undefined>((state) => {
      if (state.run?.kind !== "preparing" || state.run.run_id !== preparation.run_id ||
        state.run.contract_fingerprint !== preparation.contract_fingerprint ||
        fingerprint(state.run.tasks) !== fingerprint(preparation.tasks)) {
        if (state.run?.kind === "run" && state.run.run_id === preparation.run_id) {
          return { result: this.publicSnapshot(state.run), changed: false };
        }
        throw new ParallelDispatchError("active-run", "Parallel preparation authority changed.");
      }
      const matches = this.preparationMatches(preparation, inventory);
      if (matches !== undefined && matches.every((entry) => entry !== undefined && entry.phase === "ready") &&
        new Set(matches.map((entry) => resolve(entry!.path))).size === matches.length) {
        const run = this.finalizePreparation(preparation, matches as ManagedWorktree[]);
        this.reserveReady(run);
        state.run = run;
        return { result: this.publicSnapshot(run), changed: true };
      }
      const absent = matches?.every((entry) => entry === undefined) === true;
      if (retryEmpty && absent && !preparation.create_attempted) {
        state.run.create_attempted = true;
        return { result: "create" as const, changed: true };
      }
      this.archivePreparation(state, preparation, matches);
      return { result: undefined, changed: true };
    });
    if (resolution !== "create") return resolution;
    try {
      await this.lifecycle.createMany({
        pin: { repositoryRoot: this.repositoryRoot, sha: preparation.tasks[0]!.base_sha },
        tasks: this.contractTasks(preparation),
      });
    } catch (error) {
      // Unexpected failures model process interruption: leave intent for exact restart adoption.
      if (!(error instanceof WorktreeLifecycleError)) throw error;
      await this.recoverPreparation(expectedRunID, false);
      if (error.code === "dirty-tree") throw new ParallelDispatchError("dirty-tree", "Primary checkout became dirty.");
      if (error.code === "stale-base") throw new ParallelDispatchError("stale-base", "Primary checkout moved after the base pin.");
      throw new ParallelDispatchError("lifecycle-failed", "Managed worktrees could not be prepared.");
    }
    return this.recoverPreparation(expectedRunID, false);
  }

  private preparationMatches(
    preparation: StoredPreparation,
    inventory: readonly ManagedWorktree[] | undefined,
  ): Array<ManagedWorktree | undefined> | undefined {
    if (inventory === undefined) return undefined;
    return preparation.tasks.map((task) => inventory.find((entry) =>
      entry.identity === task.lifecycle_identity && entry.branch === task.branch && entry.baseSha === task.base_sha));
  }

  private finalizePreparation(preparation: StoredPreparation, managed: readonly ManagedWorktree[]): StoredRun {
    return {
      kind: "run",
      run_id: preparation.run_id,
      owner_root: preparation.owner_root,
      project_root: preparation.project_root,
      contract_fingerprint: preparation.contract_fingerprint,
      max_workers: preparation.max_workers,
      cancelled: false,
      tasks: preparation.tasks.map((task, index) => ({
        worktree_id: task.worktree_id,
        descriptor: cloneDescriptor({
          run_id: preparation.run_id,
          dispatch_id: task.dispatch_id,
          task_id: task.task_id,
          managed_path: managed[index]!.path,
          branch: task.branch,
          base_sha: task.base_sha,
          depends_on: [...task.depends_on],
          scope_read: [...task.scope_read],
          scope_write: [...task.scope_write],
          parallel_group: preparation.run_id,
          parallel_unit: task.task_id,
          parallel_units: preparation.tasks.length,
          attempt: 1,
          contract_fingerprint: preparation.contract_fingerprint,
        }),
        phase: "pending",
        call_id: null,
        child_session_id: null,
        outcome: null,
      })),
    };
  }

  private archivePreparation(
    state: State,
    preparation: StoredPreparation,
    matches: Array<ManagedWorktree | undefined> | undefined,
  ): void {
    this.pushArchive(state, {
      kind: "preparation",
      terminal_reason: "failed",
      preparation,
      inventory: preparation.tasks.map((task, index) => ({
        task_id: task.task_id,
        managed_path: matches?.[index]?.path ?? null,
        phase: matches?.[index]?.phase ?? null,
      })),
    });
    state.run = null;
  }

  private requireRun(state: State, ownerRoot: string, runID?: string): StoredRun {
    if (state.run === null || state.run.kind !== "run" || state.run.owner_root !== ownerRoot ||
      (runID !== undefined && state.run.run_id !== runID)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Parallel run identity does not match durable state.");
    }
    return state.run;
  }

  private reserveReady(run: StoredRun): void {
    if (run.cancelled) return;
    let available = run.max_workers - run.tasks.filter(({ phase }) => phase === "reserved" || phase === "running").length;
    if (available <= 0) return;
    for (const task of run.tasks) {
      if (available <= 0) break;
      if (task.phase === "pending" && task.descriptor.depends_on.every((dependency) =>
        run.tasks.find((candidate) => candidate.descriptor.task_id === dependency)?.phase === "completed")) {
        task.phase = "reserved";
        available -= 1;
      }
    }
  }

  private suppressDescendants(run: StoredRun, taskID: string): void {
    const suppressed = new Set([taskID]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of run.tasks) {
        if ((task.phase === "pending" || task.phase === "reserved") &&
          task.descriptor.depends_on.some((dependency) => suppressed.has(dependency))) {
          task.phase = "suppressed";
          task.outcome = null;
          suppressed.add(task.descriptor.task_id);
          changed = true;
        }
      }
    }
  }

  private archiveIfTerminal(state: State, run: StoredRun): ParallelDispatchSnapshot {
    if (run.tasks.some(({ phase }) => phase === "pending" || phase === "reserved" || phase === "running")) {
      return this.publicSnapshot(run);
    }
    const terminalReason = run.cancelled ? "cancelled" : run.tasks.every(({ phase }) => phase === "completed")
      ? "completed" : "failed";
    this.pushArchive(state, { kind: "run", terminal_reason: terminalReason, run });
    state.run = null;
    return this.publicSnapshot(run, true, terminalReason);
  }

  private pushArchive(state: State, archive: StoredArchive): void {
    state.archived.push(archive);
    if (state.archived.length > MAX_ARCHIVES) state.archived.splice(0, state.archived.length - MAX_ARCHIVES);
  }

  private findRunArchive(state: State, ownerRoot: string, runID: string): StoredRunArchive | undefined {
    return state.archived.find((entry): entry is StoredRunArchive =>
      entry.kind === "run" && entry.run.owner_root === ownerRoot && entry.run.run_id === runID);
  }

  private archiveOwner(archive: StoredArchive): string {
    return archive.kind === "run" ? archive.run.owner_root : archive.preparation.owner_root;
  }

  private publicArchive(archive: StoredArchive): ParallelDispatchArchive {
    const source = archive.kind === "run" ? archive.run : archive.preparation;
    const tasks = archive.kind === "run" ? archive.run.tasks.map((task) => ({
      task_id: task.descriptor.task_id,
      worktree_id: task.worktree_id,
      managed_path: task.descriptor.managed_path,
      branch: task.descriptor.branch,
      base_sha: task.descriptor.base_sha,
      dispatch_id: task.descriptor.dispatch_id,
      phase: task.phase,
      call_id: task.call_id,
      child_session_id: task.child_session_id,
      outcome: task.outcome,
    })) : archive.preparation.tasks.map((task, index) => ({
      task_id: task.task_id,
      worktree_id: task.worktree_id,
      managed_path: archive.inventory[index]?.managed_path ?? null,
      branch: task.branch,
      base_sha: task.base_sha,
      dispatch_id: task.dispatch_id,
      phase: "abandoned" as const,
      call_id: null,
      child_session_id: null,
      outcome: null,
    }));
    return Object.freeze({
      run_id: source.run_id,
      owner_root: source.owner_root,
      contract_fingerprint: source.contract_fingerprint,
      cancelled: archive.kind === "run" ? archive.run.cancelled : false,
      terminal_reason: archive.terminal_reason,
      tasks: Object.freeze(tasks.map((task) => Object.freeze(task))),
    });
  }

  private publicSnapshot(
    run: StoredRun,
    archived = false,
    terminalReason: ParallelDispatchSnapshot["terminal_reason"] = null,
  ): ParallelDispatchSnapshot {
    const tasks = run.tasks.map((task) => Object.freeze({
      descriptor: cloneDescriptor(task.descriptor),
      worktree_id: task.worktree_id,
      phase: task.phase,
      call_id: task.call_id,
      child_session_id: task.child_session_id,
      outcome: task.outcome,
    }));
    return Object.freeze({
      run_id: run.run_id,
      owner_root: run.owner_root,
      project_root: run.project_root,
      contract_fingerprint: run.contract_fingerprint,
      max_workers: run.max_workers,
      cancelled: run.cancelled,
      archived,
      terminal_reason: terminalReason,
      tasks: Object.freeze(tasks),
      ready: Object.freeze(tasks.filter(({ phase }) => phase === "reserved").map(({ descriptor }) => descriptor)),
    });
  }

  private async load(): Promise<State> {
    try {
      const source = await readFile(this.statePath);
      if (source.byteLength > MAX_STATE_BYTES) throw new Error("oversized");
      return parseState(JSON.parse(source.toString("utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, revision: 0, run: null, archived: [] };
      throw new ParallelDispatchError("corrupt-state", "Parallel dispatch state is corrupt or unsupported.");
    }
  }

  private async save(state: State, lease: ScopeLease): Promise<void> {
    const source = JSON.stringify(state);
    if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) {
      throw new ParallelDispatchError("corrupt-state", "Parallel dispatch state exceeds its bound.");
    }
    await lease.assertHeld().catch(() => { throw new ParallelDispatchError("state-locked", "Parallel state authority was lost."); });
    const temporary = join(this.stateRoot, `.state.${randomUUID()}.tmp`);
    let moved = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
      await lease.assertHeld().catch(() => { throw new ParallelDispatchError("state-locked", "Parallel state authority was lost."); });
      await rename(temporary, this.statePath);
      moved = true;
      await chmod(this.statePath, 0o600).catch(() => undefined);
      const directory = await open(this.stateRoot, "r").catch(() => undefined);
      try { await directory?.sync().catch(() => undefined); } finally { await directory?.close().catch(() => undefined); }
    } finally {
      if (!moved) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async acquire(scope = STATE_SCOPE): Promise<ScopeLease> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        return await this.registry.acquire({
          ownerId: `parallel-dispatch:${process.pid}:${randomUUID()}`,
          scope,
          ttlMs: 10 * 60_000,
        });
      } catch (error) {
        if (!(error instanceof ScopeLeaseError) || error.code !== "scope-conflict" || Date.now() >= deadline) {
          throw new ParallelDispatchError("state-locked", "Parallel state authority could not be acquired.");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
  }

  private async withPrepareAuthority<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(PREPARE_SCOPE);
    let failure: unknown;
    let result: T | undefined;
    try { result = await operation(); } catch (error) { failure = error; }
    await lease.release().catch(() => lease.close());
    if (failure !== undefined) throw failure;
    return result as T;
  }

  private async transaction<T>(
    operation: (state: State) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
  ): Promise<T> {
    const queued = this.queue.then(async () => {
      const lease = await this.acquire();
      let failure: unknown;
      let result: T | undefined;
      try {
        const state = await this.load();
        const operationResult = await operation(state);
        result = operationResult.result;
        if (operationResult.changed) {
          state.revision += 1;
          await this.save(state, lease);
        }
      } catch (error) {
        failure = error;
      }
      await lease.release().catch(() => lease.close());
      if (failure !== undefined) throw failure;
      return result as T;
    });
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}
