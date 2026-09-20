import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { ScopeLeaseError, ScopeLeaseRegistry, type ScopeLease } from "./scope-lease-registry.js";
import { verifyWorktreeCommitArtifact } from "./worktree-commit-artifact.js";
import { normalizeRelativePath } from "./path.js";
import { admitLunaFabric, type LunaFabricContract, type LunaFabricSolReason, type LunaFabricUnit } from "./luna-fabric-contract.js";
import {
  createLunaFabricScheduler,
  type LunaFabricSchedulerState,
} from "./luna-fabric-scheduler.js";
import type {
  ContainedValidationResult,
  ParallelDispatchArchive,
  ParallelDispatchDescriptor,
  ParallelDispatchOutcome,
  ParallelDispatchRoute,
  ParallelDispatchSnapshot,
  ParallelDispatchTaskPhase,
  WorktreeParallelContract,
  WorktreeCommitArtifact,
  WorktreeParallelTask,
} from "./types.js";
import { validateWorktreeParallelSchema } from "./validate-schema.js";
import { validateWorktreeParallelContract } from "./validate-worktree-parallel.js";
import { WorktreeLifecycle, WorktreeLifecycleError, type ManagedWorktree } from "./worktree-lifecycle.js";
import { runBudgetedContainedValidation } from "./worktree-commit-artifact.js";
import { inspectExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { appendRunFlightLedgerEvents, createRunFlightPlanPrefix, reconstructRunFlightLedger, RunFlightLedger, type RunFlightEventRecord } from "./run-flight-ledger.js";
import { EvidenceCapsuleStore } from "./evidence-capsule.js";
import { decideValidationBudget, validationDurationGuidance, validationEvidenceKey, validationEvidenceState, validationResultFingerprint,
  type ValidationBudgetRequest, type ValidationOutcome } from "./validation-budget.js";
import type { ChildTerminalEvidence } from "./child-terminal-reconciliation.js";
import { isChildTerminalIdentity, sameChildTerminalIdentity, type ChildTerminalIdentity } from "./child-terminal-reconciliation.js";
import { CancellableChildLifecycle } from "./child-lifecycle-runtime.js";
import { criticalPathTakeoverTrigger, proposeCriticalPathTakeover, type CriticalPathInput,
  type CriticalPathResult, type CriticalPathTakeoverTrigger } from "./critical-path.js";
import {
  selectWaveBoundaryReplay,
  WaveBoundaryReplayError,
  type FabricWaveBoundaryIdentity,
  type WaveBoundaryRecoveryBudget,
  type WaveBoundaryReplayReason,
} from "./wave-boundary-replay.js";

const VERSION = 5;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_TASKS = 5;
const MAX_FABRIC_UNITS = 64;
const MAX_ARCHIVES = 16;
const MAX_TEXT = 4096;
const MAX_COMMAND_ITEMS = 129;
const MAX_COMMAND_TEXT = 1000;
const LOCK_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const FABRIC_REF = /^refs\/sortie-dogs\/luna-fabric-candidates\/[0-9a-f]{16}$/u;
const PHASES = new Set<ParallelDispatchTaskPhase>([
  "pending", "reserved", "running", "completed", "failed", "suppressed", "abandoned",
]);
const OUTCOMES = new Set<ParallelDispatchOutcome>(["completed", "failed", "blocked", "cancelled"]);
const ROUTES = new Set<ParallelDispatchRoute>(["sol-serial", "luna-fabric"]);
const TERMINAL_REASONS = new Set(["completed", "cancelled", "failed"]);
const STATE_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/parallel-dispatch-state"] });
const PREPARE_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/parallel-dispatch-prepare"] });
const FABRIC_OPERATION_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/luna-fabric-operation"] });
const activeFabricValidations = new Set<string>();

export function decideFabricValidationAdmission(request: ValidationBudgetRequest, consumed: number,
  events: readonly unknown[]) {
  const evidenceKey = validationEvidenceKey(request);
  const evidence = validationEvidenceState(events);
  const passed = events.flatMap(value => {
    if (value === null || typeof value !== "object") return [];
    const event = value as Record<string, unknown>;
    return event.kind === "validation.settled" && event.evidence_key === evidenceKey && event.outcome === "passed" &&
      event.exit_code === 0 && typeof event.evidence_fingerprint === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(event.evidence_fingerprint)
      ? [{ fingerprint: event.evidence_fingerprint.slice("sha256:".length),
        duration_ms: typeof event.duration_ms === "number" ? event.duration_ms : undefined }] : [];
  });
  const guidance = validationDurationGuidance(passed.flatMap(({ duration_ms }) => duration_ms === undefined ? [] : [duration_ms]));
  const decision = decideValidationBudget(request, { limit: 1, consumed,
    evidence_keys: evidence.reusable, blocked_evidence_keys: evidence.blocked,
    prior_duration_ms: guidance.median_ms ?? undefined });
  if (decision.decision === "SKIP" && passed.length === 0) {
    return { ...decision, decision: "DENY" as const, reason: "evidence-proof-unavailable",
      redundant_time_ms: 0, reused_fingerprint: null };
  }
  return { ...decision, reused_fingerprint: decision.decision === "SKIP" ? passed.at(-1)!.fingerprint : null };
}

export interface FabricValidationSettlement {
  readonly outcome: ValidationOutcome;
  readonly exitCode: number | null;
  readonly duration_ms?: number;
}

export function finalizeFabricValidationSettlement(settlement: FabricValidationSettlement,
  postconditionsPassed: boolean): FabricValidationSettlement {
  return postconditionsPassed || settlement.outcome !== "passed"
    ? settlement
    : { ...settlement, outcome: "failed" };
}

export type ParallelDispatchErrorCode =
  | "invalid-contract"
  | "stale-base"
  | "dirty-tree"
  | "active-run"
  | "descriptor-mismatch"
  | "descriptor-replay"
  | "outcome-conflict"
  | "artifact-invalid"
  | "wave-not-ready"
  | "candidate-invalid"
  | "wave-integration-failed"
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

/** Runtime capacity and mapping limits that the pure admission policy cannot observe. */
export type FabricDispatchSolReason =
  | LunaFabricSolReason
  | "unit-count-exceeds-capacity"
  | "concurrent-scope-overlap"
  | "contract-unmappable"
  | "target-checked-out";

export type ParallelDispatchFabricPrepareResult =
  | {
      readonly status: "prepared";
      readonly snapshot: ParallelDispatchSnapshot;
      readonly fabric_fingerprint: string;
      readonly plan_id: string | null;
      readonly plan_binding_id: string | null;
      readonly width: number;
      readonly depth: number;
    }
  | { readonly status: "sol-serial"; readonly reason: FabricDispatchSolReason };

type StoredTask = {
  descriptor: ParallelDispatchDescriptor;
  worktree_id: string;
  phase: ParallelDispatchTaskPhase;
  call_id: string | null;
  child_session_id: string | null;
  outcome: ParallelDispatchOutcome | null;
  artifact: WorktreeCommitArtifact | null;
  artifact_accepted: boolean;
};

type StoredRun = {
  kind: "run";
  run_id: string;
  owner_root: string;
  project_root: string;
  contract_fingerprint: string;
  route: ParallelDispatchRoute;
  max_workers: number;
  cancelled: boolean;
  tasks: StoredTask[];
  fabric: StoredFabric | null;
  execution_plan: ExecutionPlan | null;
  plan_ledger: readonly RunFlightEventRecord[] | null;
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
  route: ParallelDispatchRoute;
  max_workers: number;
  create_attempted: boolean;
  tasks: PreparingTask[];
  fabric: StoredFabric | null;
  execution_plan: ExecutionPlan | null;
  plan_ledger: readonly RunFlightEventRecord[] | null;
};

type StoredFabricTransition = {
  phase: "cleanup" | "creating";
  candidate_base: string;
  completed_unit_ids: string[];
  cleanup_worktree_ids: string[];
  scheduler: LunaFabricSchedulerState;
  tasks: PreparingTask[];
};

type StoredFabricDemotion = {
  unit_id: string;
  luna_dispatch_id: string;
  luna_worktree_id: string;
  sol_dispatch_id: string;
  trigger: FabricDemotionTrigger;
};

type FabricDemotionTrigger = "terminal_quality_rescue" | CriticalPathTakeoverTrigger;

type StoredFabricDemotionTransition = {
  phase: "stopping" | "cleanup" | "creating";
  unit_id: string;
  failed_worktree_id: string;
  cleanup_worktree_ids: string[];
  task: PreparingTask;
  trigger: FabricDemotionTrigger;
  source_identity: ChildTerminalIdentity | null;
};

type StoredFabric = {
  authority_sha: string;
  target_branch: string;
  contract: LunaFabricContract;
  scheduler: LunaFabricSchedulerState;
  transition: StoredFabricTransition | null;
  demotion_transition: StoredFabricDemotionTransition | null;
  demotions: StoredFabricDemotion[];
  source_refs: Array<{ unit_id: string; ref: string; commit: string }>;
  candidate_ref: string;
  candidate_head: string;
  wave_heads: string[];
  validation: { command: string[]; status: "pending" | "running" | "pass" | "fail"; fingerprint: string | null };
  review: { status: "pending" | "pass" | "skip" | "fail"; fingerprint: string | null };
  promoted: boolean;
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
type State = { version: 5; revision: number; run: StoredRun | StoredPreparation | null; archived: StoredArchive[] };

type PendingFabricOutcome = {
  owner_root: string;
  call_id: string;
  child_session_id: string | null;
  descriptor: ParallelDispatchDescriptor;
  artifact: WorktreeCommitArtifact | null;
  outcome: ParallelDispatchOutcome | null;
};

type BuiltFabricCandidate = {
  readonly run_id: string;
  readonly candidate_base: string;
  readonly candidate_head: string;
  readonly fabric_identity: string;
  readonly artifact_identity: string;
};

export interface ParallelDispatchClaim {
  readonly run_id: string;
  readonly dispatch_id: string;
}

export interface ParallelDispatchCoordinatorOptions {
  readonly repositoryRoot: string;
  readonly gitPath?: string;
}

export type LiveFabricTakeoverResult =
  | { readonly status: "not-proposed"; readonly decision: CriticalPathResult }
  | { readonly status: "waiting"; readonly trigger: CriticalPathTakeoverTrigger; readonly reason: string;
      readonly snapshot: ParallelDispatchSnapshot }
  | { readonly status: "taken-over"; readonly trigger: CriticalPathTakeoverTrigger;
      readonly snapshot: ParallelDispatchSnapshot };

/** Read-only reconstruction of one accepted fabric boundary. It is never a dispatch instruction. */
export interface FabricWaveBoundaryReplayRecord {
  readonly reason: WaveBoundaryReplayReason;
  readonly boundary_event_hash: string;
  readonly route: "luna-fabric";
  readonly plan: ExecutionPlan;
  readonly plan_decisions: readonly {
    readonly plan_id: string;
    readonly proposal_id: string;
    readonly decision: "accepted" | "rejected";
    readonly gap_codes: readonly string[];
  }[];
  readonly scheduler: LunaFabricSchedulerState;
  readonly artifacts: FabricWaveBoundaryIdentity["artifacts"];
  readonly candidate_snapshot: FabricWaveBoundaryIdentity["candidate_snapshot"];
  readonly recovery_budget: WaveBoundaryRecoveryBudget;
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

function cloneArtifact(value: WorktreeCommitArtifact): WorktreeCommitArtifact {
  return Object.freeze({
    task_id: value.task_id,
    base_sha: value.base_sha,
    commit_sha: value.commit_sha,
    branch: value.branch,
    changed_paths: Object.freeze([...value.changed_paths]),
    change_fingerprint: value.change_fingerprint,
    validation: Object.freeze({
      command: Object.freeze([...value.validation.command]),
      exit_code: 0,
      validation_fingerprint: value.validation.validation_fingerprint,
    }),
  });
}

function validArtifact(value: unknown, descriptor: ParallelDispatchDescriptor): value is WorktreeCommitArtifact {
  if (!isRecord(value) || !exactKeys(value, [
    "base_sha", "branch", "change_fingerprint", "changed_paths", "commit_sha", "task_id", "validation",
  ]) || value.task_id !== descriptor.task_id || value.base_sha !== descriptor.base_sha || value.branch !== descriptor.branch ||
    typeof value.base_sha !== "string" || !SHA.test(value.base_sha) ||
    typeof value.commit_sha !== "string" || !SHA.test(value.commit_sha) || !validText(value.branch, 256) ||
    !validStringList(value.changed_paths, 256) || value.changed_paths.length === 0 || typeof value.change_fingerprint !== "string" ||
    !HASH.test(value.change_fingerprint) || !isRecord(value.validation) || !exactKeys(value.validation, [
      "command", "exit_code", "validation_fingerprint",
    ]) || !Array.isArray(value.validation.command) || value.validation.command.length === 0 ||
    value.validation.command.length > MAX_COMMAND_ITEMS ||
    !value.validation.command.every((entry) => validText(entry, MAX_COMMAND_TEXT)) ||
    value.validation.exit_code !== 0 || typeof value.validation.validation_fingerprint !== "string" ||
    !HASH.test(value.validation.validation_fingerprint)) return false;
  const paths = value.changed_paths;
  const identities = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]!;
    let normalized: string;
    try { normalized = normalizeRelativePath(path); } catch { return false; }
    const previous = index === 0 ? undefined : paths[index - 1]!;
    if (normalized !== path || (previous !== undefined && previous >= path)) return false;
    const identity = normalized.toLowerCase();
    if (identities.has(identity) || !descriptor.scope_write.some((write) =>
      identity === write || identity.startsWith(`${write}/`))) return false;
    identities.add(identity);
  }
  const command = value.validation.command;
  const validationFingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    command,
    exit_code: 0,
    task_id: descriptor.task_id,
    base_sha: descriptor.base_sha,
    change_fingerprint: value.change_fingerprint,
  })).digest("hex");
  if (!isAbsolute(command[0]!) || value.validation.validation_fingerprint !== validationFingerprint) return false;
  return true;
}

/** Materialize only one scheduler-selected wave. Pending DAG units never receive descriptors early. */
function fabricDispatchContract(
  contract: LunaFabricContract,
  fabricFingerprint: string,
  scheduler: LunaFabricSchedulerState,
): WorktreeParallelContract {
  if (scheduler.active === null) throw new ParallelDispatchError("invalid-contract", "Fabric scheduler has no active wave.");
  const byID = new Map(contract.units.map((unit) => [unit.unit_id, unit]));
  const units = scheduler.active.unit_ids.map((id) => byID.get(id)!);
  const prefix = `sortie-dogs/luna-fabric/${fabricFingerprint.slice(0, 16)}`;
  return {
    version: "0.1.0",
    mode: "parallel",
    max_workers: Math.max(2, units.length),
    tasks: units.map((unit) => ({
      task_id: unit.unit_id,
      worktree: `fabric-${fabricFingerprint.slice(0, 16)}-w${scheduler.active!.number}-l${scheduler.active!.lanes[unit.unit_id]}-${unit.unit_id}`,
      branch: `${prefix}/w${scheduler.active!.number}-l${scheduler.active!.lanes[unit.unit_id]}-${unit.unit_id}`,
      base_sha: scheduler.active!.base_sha,
      depends_on: [...unit.depends_on],
      scope: { read: [...unit.scope_read], write: [...unit.scope_write] },
    })),
    artifacts: [],
    failure: null,
    baseline_metrics: null,
  };
}

function validClaim(value: unknown): value is ParallelDispatchClaim {
  return isRecord(value) && exactKeys(value, ["dispatch_id", "run_id"]) &&
    typeof value.run_id === "string" && UUID.test(value.run_id) &&
    typeof value.dispatch_id === "string" && UUID.test(value.dispatch_id);
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
    Number.isInteger(value.parallel_units) && (value.parallel_units as number) >= 1 &&
    (value.parallel_units as number) <= MAX_TASKS && (value.attempt === 1 || value.attempt === 2) &&
    typeof value.contract_fingerprint === "string" && HASH.test(value.contract_fingerprint);
}

function validHeader(value: Record<string, unknown>): boolean {
  return typeof value.run_id === "string" && UUID.test(value.run_id) && validText(value.owner_root, 256) &&
    validText(value.project_root) && isAbsolute(value.project_root) &&
    typeof value.route === "string" && ROUTES.has(value.route as ParallelDispatchRoute) &&
    typeof value.contract_fingerprint === "string" && HASH.test(value.contract_fingerprint) &&
    Number.isInteger(value.max_workers) && (value.max_workers as number) >= 1 &&
    (value.max_workers as number) <= MAX_TASKS && Array.isArray(value.tasks) &&
    value.tasks.length >= 1 && value.tasks.length <= MAX_FABRIC_UNITS;
}

function parseTransitionTasks(raw: unknown): PreparingTask[] {
  if (!Array.isArray(raw) || raw.length > MAX_TASKS) throw new Error("fabric-transition-tasks");
  const ids = new Set<string>();
  const worktrees = new Set<string>();
  const branches = new Set<string>();
  const dispatches = new Set<string>();
  return raw.map((value) => {
    if (!isRecord(value) || !exactKeys(value, [
      "base_sha", "branch", "depends_on", "dispatch_id", "lifecycle_identity", "scope_read", "scope_write", "task_id", "worktree_id",
    ]) || typeof value.dispatch_id !== "string" || !UUID.test(value.dispatch_id) ||
      !validText(value.task_id, 128) || !validText(value.worktree_id, 256) ||
      typeof value.lifecycle_identity !== "string" || !/^[0-9a-f]{16}$/u.test(value.lifecycle_identity) ||
      value.lifecycle_identity !== lifecycleIdentity(value.worktree_id) || !validText(value.branch, 256) ||
      typeof value.base_sha !== "string" || !SHA.test(value.base_sha) || !validStringList(value.depends_on, MAX_FABRIC_UNITS) ||
      !validStringList(value.scope_read, 256) || !validStringList(value.scope_write, 256) || value.scope_write.length === 0 ||
      ids.has(value.task_id) || worktrees.has(value.lifecycle_identity) || branches.has(value.branch.toLowerCase()) ||
      dispatches.has(value.dispatch_id)) throw new Error("fabric-transition-task");
    ids.add(value.task_id);
    worktrees.add(value.lifecycle_identity);
    branches.add(value.branch.toLowerCase());
    dispatches.add(value.dispatch_id);
    return value as unknown as PreparingTask;
  });
}

function parseFabric(raw: unknown, contractFingerprint: string): StoredFabric | null {
  if (raw === null) return null;
  if (!isRecord(raw) || !exactKeys(raw, [
    "authority_sha", "candidate_head", "candidate_ref", "contract", "demotion_transition", "demotions", "promoted",
    "review", "scheduler", "source_refs", "target_branch", "transition", "validation", "wave_heads",
  ]) || typeof raw.authority_sha !== "string" || !SHA.test(raw.authority_sha) || !validText(raw.target_branch, 256) ||
    typeof raw.candidate_ref !== "string" || !FABRIC_REF.test(raw.candidate_ref) ||
    typeof raw.candidate_head !== "string" || !SHA.test(raw.candidate_head) ||
    !validStringList(raw.wave_heads, MAX_FABRIC_UNITS) || !raw.wave_heads.every((head) => SHA.test(head)) ||
    new Set(raw.wave_heads).size !== raw.wave_heads.length || typeof raw.promoted !== "boolean" ||
    !Array.isArray(raw.demotions) || raw.demotions.length > MAX_FABRIC_UNITS ||
    !raw.demotions.every((entry) => isRecord(entry) && exactKeys(entry, ["luna_dispatch_id", "luna_worktree_id", "sol_dispatch_id", "trigger", "unit_id"]) &&
      validText(entry.unit_id, 128) && typeof entry.luna_dispatch_id === "string" && UUID.test(entry.luna_dispatch_id) &&
      validText(entry.luna_worktree_id, 256) && typeof entry.sol_dispatch_id === "string" && UUID.test(entry.sol_dispatch_id) &&
      ["terminal_quality_rescue", "live_deadline_exceeded", "live_repeated_failure"].includes(entry.trigger as string)) ||
    !Array.isArray(raw.source_refs) || raw.source_refs.length > MAX_FABRIC_UNITS ||
    !raw.source_refs.every((entry) => isRecord(entry) && exactKeys(entry, ["commit", "ref", "unit_id"]) &&
      validText(entry.unit_id, 128) && typeof entry.commit === "string" && SHA.test(entry.commit) &&
      typeof entry.ref === "string" && /^refs\/sortie-dogs\/luna-fabric-sources\/[0-9a-f]{16}\/[0-9a-f]{16}$/u.test(entry.ref)) ||
    !isRecord(raw.validation) || !exactKeys(raw.validation, ["command", "fingerprint", "status"]) ||
    !Array.isArray(raw.validation.command) || raw.validation.command.length > MAX_COMMAND_ITEMS ||
    !raw.validation.command.every((part) => validText(part, MAX_COMMAND_TEXT)) ||
    !["pending", "running", "pass", "fail"].includes(raw.validation.status as string) ||
    !(raw.validation.fingerprint === null || (typeof raw.validation.fingerprint === "string" && HASH.test(raw.validation.fingerprint))) ||
    !isRecord(raw.review) || !exactKeys(raw.review, ["fingerprint", "status"]) ||
    !["pending", "pass", "skip", "fail"].includes(raw.review.status as string) ||
    !(raw.review.fingerprint === null || (typeof raw.review.fingerprint === "string" && HASH.test(raw.review.fingerprint)))) {
    throw new Error("fabric");
  }
  const admission = admitLunaFabric(raw.contract);
  if (admission.route !== "luna-fabric" || admission.contract_fingerprint !== contractFingerprint ||
    admission.contract.provenance.target_sha !== raw.authority_sha ||
    admission.contract.provenance.target_branch !== raw.target_branch) throw new Error("fabric-contract");
  const scheduler = createLunaFabricScheduler(admission.contract, raw.authority_sha, raw.scheduler as LunaFabricSchedulerState).snapshot();
  let transition: StoredFabricTransition | null = null;
  if (raw.transition !== null) {
    if (!isRecord(raw.transition) || !exactKeys(raw.transition, [
      "candidate_base", "cleanup_worktree_ids", "completed_unit_ids", "phase", "scheduler", "tasks",
    ]) || (raw.transition.phase !== "cleanup" && raw.transition.phase !== "creating") ||
      typeof raw.transition.candidate_base !== "string" || !SHA.test(raw.transition.candidate_base) ||
      !validStringList(raw.transition.completed_unit_ids, MAX_FABRIC_UNITS) ||
      !validStringList(raw.transition.cleanup_worktree_ids, MAX_TASKS)) throw new Error("fabric-transition");
    const nextScheduler = createLunaFabricScheduler(
      admission.contract,
      raw.authority_sha,
      raw.transition.scheduler as LunaFabricSchedulerState,
    ).snapshot();
    const tasks = parseTransitionTasks(raw.transition.tasks);
    const active = nextScheduler.active?.unit_ids ?? [];
    const candidateBase = raw.transition.candidate_base;
    if (nextScheduler.base_sha !== candidateBase || tasks.length !== active.length ||
      tasks.some((task) => !active.includes(task.task_id) || task.base_sha !== candidateBase)) {
      throw new Error("fabric-transition-state");
    }
    transition = {
      phase: raw.transition.phase,
      candidate_base: raw.transition.candidate_base,
      completed_unit_ids: [...raw.transition.completed_unit_ids],
      cleanup_worktree_ids: [...raw.transition.cleanup_worktree_ids],
      scheduler: nextScheduler,
      tasks,
    };
  }
  let demotionTransition: StoredFabricDemotionTransition | null = null;
  if (raw.demotion_transition !== null) {
    if (!isRecord(raw.demotion_transition) || !exactKeys(raw.demotion_transition, [
      "cleanup_worktree_ids", "failed_worktree_id", "phase", "source_identity", "task", "trigger", "unit_id",
    ]) || !["stopping", "cleanup", "creating"].includes(raw.demotion_transition.phase as string) ||
      !validText(raw.demotion_transition.unit_id, 128) || !validText(raw.demotion_transition.failed_worktree_id, 256) ||
      !validStringList(raw.demotion_transition.cleanup_worktree_ids, MAX_TASKS) ||
      !["terminal_quality_rescue", "live_deadline_exceeded", "live_repeated_failure"].includes(raw.demotion_transition.trigger as string) ||
      !(raw.demotion_transition.source_identity === null || isChildTerminalIdentity(raw.demotion_transition.source_identity))) {
      throw new Error("fabric-demotion-transition");
    }
    const tasks = parseTransitionTasks([raw.demotion_transition.task]);
    if (tasks.length !== 1 || tasks[0]!.task_id !== raw.demotion_transition.unit_id) throw new Error("fabric-demotion-task");
    demotionTransition = { phase: raw.demotion_transition.phase as StoredFabricDemotionTransition["phase"], unit_id: raw.demotion_transition.unit_id,
      failed_worktree_id: raw.demotion_transition.failed_worktree_id,
      cleanup_worktree_ids: [...raw.demotion_transition.cleanup_worktree_ids], task: tasks[0]!,
      trigger: raw.demotion_transition.trigger as FabricDemotionTrigger,
      source_identity: raw.demotion_transition.source_identity as ChildTerminalIdentity | null };
  }
  const expectedHead = transition?.candidate_base ?? scheduler.base_sha;
  if (raw.candidate_head !== expectedHead ||
    (raw.wave_heads.length === 0 ? raw.candidate_head !== raw.authority_sha : raw.wave_heads.at(-1) !== raw.candidate_head) ||
    (["pending", "running"].includes(raw.validation.status as string)) !== (raw.validation.fingerprint === null) ||
    (raw.review.status === "pending") !== (raw.review.fingerprint === null) ||
    (raw.promoted && (raw.validation.status !== "pass" || !["pass", "skip"].includes(raw.review.status as string) ||
      scheduler.pending.length > 0 || scheduler.active !== null))) throw new Error("fabric-candidate-state");
  return {
    authority_sha: raw.authority_sha,
    target_branch: raw.target_branch,
    contract: admission.contract,
    scheduler,
    transition,
    demotion_transition: demotionTransition,
    demotions: raw.demotions as StoredFabricDemotion[],
    source_refs: raw.source_refs as StoredFabric["source_refs"],
    candidate_ref: raw.candidate_ref,
    candidate_head: raw.candidate_head,
    wave_heads: [...raw.wave_heads],
    validation: {
      command: [...raw.validation.command as string[]],
      status: raw.validation.status as StoredFabric["validation"]["status"],
      fingerprint: raw.validation.fingerprint as string | null,
    },
    review: {
      status: raw.review.status as StoredFabric["review"]["status"],
      fingerprint: raw.review.fingerprint as string | null,
    },
    promoted: raw.promoted,
  };
}

function parsePlanLedger(value: unknown, plan: ExecutionPlan | null, fabric: StoredFabric | null): readonly RunFlightEventRecord[] | null {
  if (plan === null && (value === undefined || value === null)) return null;
  if (plan === null || !Array.isArray(value) || value.length < 1) throw new Error("plan-ledger");
  const state = reconstructRunFlightLedger(value);
  const decision = state.plan_decisions[0];
  const legacy = value.length === 1;
  const latest = state.accepted_fabric_waves.at(-1);
  if (state.run_id !== null || state.plan_decisions.length !== 1 || decision?.decision !== "accepted" ||
    decision.plan_id !== plan.plan_id || decision.proposal_id !== plan.proposal_id ||
    (!legacy && (fabric === null || latest === undefined || latest.plan_binding_id !== plan.binding_id ||
      latest.candidate_id !== fabric.candidate_head || latest.wave_index !== fabric.wave_heads.length ||
      fingerprint(latest.scheduler_after) !== fingerprint(fabric.transition?.scheduler ?? fabric.scheduler) ||
      fingerprint(latest.candidate_snapshot.wave_heads) !== fingerprint(fabric.wave_heads)))) throw new Error("plan-ledger-identity");
  return value;
}

function parseRun(raw: unknown): StoredRun {
  if (!isRecord(raw) || !exactKeys(raw, [
    "cancelled", "contract_fingerprint", "fabric", "kind", "max_workers", "owner_root", "project_root", "route", "run_id", "tasks",
    ...(Object.hasOwn(raw, "execution_plan") ? ["execution_plan"] : []),
    ...(Object.hasOwn(raw, "plan_ledger") ? ["plan_ledger"] : []),
  ]) || raw.kind !== "run" || !validHeader(raw) || typeof raw.cancelled !== "boolean") throw new Error("run");
  const fabric = parseFabric(raw.fabric, raw.contract_fingerprint as string);
  const executionPlan = raw.execution_plan === undefined || raw.execution_plan === null
    ? null
    : fabric === null ? (() => { throw new Error("run-plan"); })() : inspectExecutionPlan(raw.execution_plan, fabric.contract);
  if ((raw.route === "luna-fabric") !== (fabric !== null) ||
    (fabric === null && ((raw.tasks as unknown[]).length > MAX_TASKS || (raw.tasks as unknown[]).length < 2 ||
      (raw.max_workers as number) < 2))) throw new Error("run-route");
  const ids = new Set<string>();
  const dispatches = new Set<string>();
  const calls = new Set<string>();
  const tasks: StoredTask[] = [];
  const rawTasks = raw.tasks as unknown[];
  for (const value of rawTasks) {
    if (!isRecord(value) || !exactKeys(value, ["artifact", "artifact_accepted", "call_id", "child_session_id", "descriptor", "outcome", "phase", "worktree_id"]) ||
      !validText(value.worktree_id, 256) || !validDescriptor(value.descriptor) || ids.has(value.descriptor.task_id) ||
      dispatches.has(value.descriptor.dispatch_id) || typeof value.phase !== "string" ||
      !PHASES.has(value.phase as ParallelDispatchTaskPhase) || !(value.call_id === null || validText(value.call_id, 256)) ||
      !(value.child_session_id === null || validText(value.child_session_id, 256)) ||
      !(value.outcome === null || (typeof value.outcome === "string" && OUTCOMES.has(value.outcome as ParallelDispatchOutcome))) ||
      typeof value.artifact_accepted !== "boolean" ||
      !(value.artifact === null || validArtifact(value.artifact, value.descriptor))) {
      throw new Error("task");
    }
    const task = value as unknown as StoredTask;
    const suppressedOutcomeValid = task.phase !== "suppressed" || task.outcome === null || task.outcome === "cancelled";
    if (task.descriptor.run_id !== raw.run_id || task.descriptor.contract_fingerprint !== raw.contract_fingerprint ||
      (fabric === null && (task.descriptor.parallel_units !== rawTasks.length || task.descriptor.attempt !== 1)) ||
      ((task.phase === "pending" || task.phase === "reserved") &&
        (task.call_id !== null || task.child_session_id !== null || task.outcome !== null)) ||
      (task.phase === "running" && (task.call_id === null || task.outcome !== null)) ||
      (["completed", "failed"].includes(task.phase) && (task.call_id === null || task.outcome === null)) ||
      (task.phase === "abandoned" && task.outcome !== null) || !suppressedOutcomeValid ||
      (task.artifact === null && task.artifact_accepted) ||
      (task.artifact !== null && task.child_session_id === null) ||
      (["pending", "reserved", "suppressed"].includes(task.phase) && (task.artifact !== null || task.artifact_accepted)) ||
      (task.phase === "completed" && (task.outcome !== "completed" || task.artifact === null || !task.artifact_accepted)) ||
      (task.phase === "failed" && task.outcome === "completed") ||
      (task.call_id !== null && calls.has(task.call_id))) throw new Error("task-state");
    ids.add(task.descriptor.task_id);
    dispatches.add(task.descriptor.dispatch_id);
    if (task.call_id !== null) calls.add(task.call_id);
    tasks.push({ ...task, descriptor: cloneDescriptor(task.descriptor),
      artifact: task.artifact === null ? null : cloneArtifact(task.artifact) });
  }
  if (tasks.some((task) => task.descriptor.depends_on.some((dependency) => !ids.has(dependency)))) throw new Error("dependency");
  if (fabric !== null) {
    const contractIDs = new Set(fabric.contract.units.map(({ unit_id }) => unit_id));
    const completed = new Set(fabric.scheduler.completed);
    const active = new Set(fabric.scheduler.active?.unit_ids ?? []);
    if (tasks.some((task) => !contractIDs.has(task.descriptor.task_id)) ||
      [...completed].some((id) => !tasks.some((task) => task.descriptor.task_id === id && task.phase === "completed")) ||
      [...active].some((id) => !tasks.some((task) => task.descriptor.task_id === id)) ||
      tasks.some((task) => task.phase !== "completed" && !active.has(task.descriptor.task_id)) ||
      tasks.some((task) => task.descriptor.attempt === 2 && !fabric.demotions.some((entry) =>
        entry.unit_id === task.descriptor.task_id && entry.sol_dispatch_id === task.descriptor.dispatch_id)) ||
      fabric.demotions.some((entry) => !tasks.some((task) => task.descriptor.task_id === entry.unit_id))) {
      throw new Error("fabric-run-state");
    }
  }
  return { ...(raw as unknown as StoredRun), tasks, fabric, execution_plan: executionPlan,
    plan_ledger: parsePlanLedger(raw.plan_ledger, executionPlan, fabric) };
}

function parsePreparation(raw: unknown): StoredPreparation {
  if (!isRecord(raw) || !exactKeys(raw, [
    "contract_fingerprint", "create_attempted", "fabric", "kind", "max_workers", "owner_root", "project_root", "route", "run_id", "tasks",
    ...(Object.hasOwn(raw, "execution_plan") ? ["execution_plan"] : []),
    ...(Object.hasOwn(raw, "plan_ledger") ? ["plan_ledger"] : []),
  ]) || raw.kind !== "preparing" || !validHeader(raw) || typeof raw.create_attempted !== "boolean") throw new Error("preparation");
  const fabric = parseFabric(raw.fabric, raw.contract_fingerprint as string);
  const executionPlan = raw.execution_plan === undefined || raw.execution_plan === null
    ? null
    : fabric === null ? (() => { throw new Error("preparation-plan"); })() : inspectExecutionPlan(raw.execution_plan, fabric.contract);
  if ((raw.route === "luna-fabric") !== (fabric !== null) || (raw.tasks as unknown[]).length > MAX_TASKS ||
    (fabric === null && ((raw.tasks as unknown[]).length < 2 || (raw.max_workers as number) < 2))) {
    throw new Error("preparation-route");
  }
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
  return { ...(raw as unknown as StoredPreparation), tasks, fabric, execution_plan: executionPlan,
    plan_ledger: parsePlanLedger(raw.plan_ledger, executionPlan, fabric) };
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
  return { version: 5, revision: raw.revision as number, run, archived };
}

export class ParallelDispatchCoordinator {
  private readonly statePath: string;
  private readonly registry: ScopeLeaseRegistry;
  private queue = Promise.resolve();
  private readonly pendingFabricOutcomes = new Map<string, Map<string, PendingFabricOutcome>>();
  private readonly automaticFabricReplays = new Map<string, FabricWaveBoundaryReplayRecord>();

  private constructor(
    private readonly repositoryRoot: string,
    private readonly lifecycle: WorktreeLifecycle,
    private readonly stateRoot: string,
    private readonly gitPath: string,
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
    const stateRoot = join(common, "sortie-dogs", "parallel-dispatch-v5");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o700).catch(() => undefined);
    return new ParallelDispatchCoordinator(repositoryRoot, lifecycle, stateRoot, gitPath);
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
    return { status: "prepared", snapshot: await this.prepareRun(contract, "sol-serial", ownerRoot) };
  }

  /**
   * Prepare one admitted Luna fabric contract. Admission is pure, so runtime capacity and the
   * concurrent-worktree disjointness this release can honor are enforced here and route to Sol.
   */
  async prepareFabric(value: unknown, ownerRoot: string, executionPlanValue?: unknown): Promise<ParallelDispatchFabricPrepareResult> {
    if (!validText(ownerRoot, 256)) throw new ParallelDispatchError("invalid-contract", "Coordinator root identity is invalid.");
    const admission = admitLunaFabric(value);
    if (admission.route !== "luna-fabric") return { status: "sol-serial", reason: admission.reason };
    let executionPlan: ExecutionPlan | null = null;
    if (executionPlanValue !== undefined) {
      try { executionPlan = inspectExecutionPlan(executionPlanValue, admission.contract); }
      catch { throw new ParallelDispatchError("invalid-contract", "Execution plan binding does not match the admitted fabric contract."); }
    }
    const scheduler = createLunaFabricScheduler(admission.contract, admission.contract.provenance.target_sha);
    if (scheduler.nextWave() === null) return { status: "sol-serial", reason: "contract-unmappable" };
    const schedulerState = scheduler.snapshot();
    const contract = fabricDispatchContract(admission.contract, admission.contract_fingerprint, schedulerState);
    const fabric: StoredFabric = {
      authority_sha: admission.contract.provenance.target_sha,
      target_branch: admission.contract.provenance.target_branch,
      contract: admission.contract,
      scheduler: schedulerState,
      transition: null,
      demotion_transition: null,
      demotions: [],
      source_refs: [],
      candidate_ref: `refs/sortie-dogs/luna-fabric-candidates/${admission.contract_fingerprint.slice(0, 16)}`,
      candidate_head: admission.contract.provenance.target_sha,
      wave_heads: [],
      validation: { command: [], status: "pending", fingerprint: null },
      review: { status: "pending", fingerprint: null },
      promoted: false,
    };
    await this.assertFabricAuthority(fabric);
    return {
      status: "prepared",
      snapshot: await this.prepareRun(contract, "luna-fabric", ownerRoot, fabric, admission.contract_fingerprint,
        schedulerState.active!.unit_ids.length, executionPlan),
      fabric_fingerprint: admission.contract_fingerprint,
      plan_id: executionPlan?.plan_id ?? null,
      plan_binding_id: executionPlan?.binding_id ?? null,
      width: Math.min(MAX_TASKS, admission.width),
      depth: admission.depth,
    };
  }

  private async prepareRun(
    contract: WorktreeParallelContract,
    route: ParallelDispatchRoute,
    ownerRoot: string,
    fabric: StoredFabric | null = null,
    fingerprintOverride?: string,
    maxWorkersOverride?: number,
    executionPlan: ExecutionPlan | null = null,
  ): Promise<ParallelDispatchSnapshot> {
    const contractFingerprint = fingerprintOverride ?? fingerprint(contract);
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
        if (state.run.kind !== "run" || state.run.owner_root !== ownerRoot || state.run.route !== route ||
          state.run.contract_fingerprint !== contractFingerprint ||
          state.run.execution_plan?.binding_id !== executionPlan?.binding_id) {
          throw new ParallelDispatchError("active-run", "Another durable parallel run already owns this repository.");
        }
        return { result: this.publicSnapshot(state.run), changed: false };
      });
      if (existing !== undefined) return existing;

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
        const runID = randomUUID();
        const value: StoredPreparation = {
          kind: "preparing",
          run_id: runID,
          owner_root: ownerRoot,
          project_root: this.repositoryRoot,
          contract_fingerprint: contractFingerprint,
          route,
          max_workers: maxWorkersOverride ?? contract.max_workers,
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
          fabric: fabric === null ? null : {
            ...fabric,
            candidate_ref: `refs/sortie-dogs/luna-fabric-candidates/${fingerprint(runID).slice(0, 16)}`,
          },
          execution_plan: executionPlan,
          plan_ledger: executionPlan === null ? null : createRunFlightPlanPrefix({
            kind: "plan.compiled", at: new Date().toISOString(), plan_id: executionPlan.plan_id,
            proposal_id: executionPlan.proposal_id, decision: "accepted", gap_codes: [],
          }),
        };
        state.run = value;
        return { result: value, changed: true };
      });

      const snapshot = await this.recoverPreparation(preparation.run_id, true);
      if (snapshot === undefined) throw new ParallelDispatchError("lifecycle-failed", "Managed worktree preparation could not be finalized.");
      return snapshot;
    });
  }

  async integrateFabricWave(ownerRoot: string, runID: string): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Fabric run identity is invalid.");
    }
    await this.recoverWithAuthority();
    const evidence = await this.transaction((state) => {
      const run = this.requireRun(state, ownerRoot, runID);
      if (run.fabric === null || run.fabric.transition !== null || run.fabric.demotion_transition !== null || run.cancelled) {
        throw new ParallelDispatchError("descriptor-mismatch", "Run is not ready for fabric integration.");
      }
      const active = run.fabric.scheduler.active?.unit_ids ?? [];
      const tasks = active.map((id) => run.tasks.find((task) => task.descriptor.task_id === id));
      if (active.length === 0 || tasks.some((task) => task === undefined || task.phase !== "completed" ||
        task.artifact === null || !task.artifact_accepted)) {
        throw new ParallelDispatchError("wave-not-ready", "Every active fabric unit must complete before integration.");
      }
      return { result: {
        fabric: run.fabric,
        contract_fingerprint: run.contract_fingerprint,
        tasks: tasks.map((task) => ({ ...task!, descriptor: cloneDescriptor(task!.descriptor),
          artifact: cloneArtifact(task!.artifact!) })),
      }, changed: false };
    });
    await this.assertFabricAuthority(evidence.fabric);
    const candidate = await this.buildFabricCandidate(runID, evidence.fabric.candidate_head, evidence.tasks);
    const builtCandidate = this.builtFabricCandidate(
      runID, evidence.contract_fingerprint, evidence.fabric, evidence.tasks, candidate,
    );
    const currentRef = await this.readRef(evidence.fabric.candidate_ref);
    if (currentRef === evidence.fabric.candidate_head) {
      try {
        await this.git(["update-ref", evidence.fabric.candidate_ref, candidate, evidence.fabric.candidate_head]);
      } catch {
        if (await this.readRef(evidence.fabric.candidate_ref) !== candidate) {
          throw new ParallelDispatchError("wave-integration-failed", "Hidden candidate CAS failed.");
        }
      }
    } else if (currentRef !== candidate) {
      throw new ParallelDispatchError("wave-integration-failed", "Hidden candidate ref does not match the deterministic wave result.");
    }
    return this.advanceFabricWave(ownerRoot, runID, candidate, builtCandidate);
  }

  async integrateFabricWaveAndValidate(
    ownerRoot: string,
    runID: string,
    executable: string,
    args: readonly string[] = [],
    timeoutMs = 10 * 60_000,
  ): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) || !isAbsolute(executable) ||
      !Array.isArray(args) || args.length > 128 || !args.every((arg) => validText(arg, MAX_COMMAND_TEXT)) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
      throw new ParallelDispatchError("invalid-contract", "Final fabric validation request is invalid.");
    }
    const existing = await this.snapshot(ownerRoot, runID);
    const fabric = existing?.fabric;
    const complete = fabric !== undefined && fabric.active_unit_ids.length === 0 &&
      fabric.pending_unit_ids.length === 0 && fabric.transition === null;
    if (complete) return this.validateFabricCandidate(ownerRoot, runID, executable, args, timeoutMs);
    const snapshot = await this.integrateFabricWave(ownerRoot, runID);
    if ((snapshot.fabric?.active_unit_ids.length ?? 0) !== 0) return snapshot;
    return this.validateFabricCandidate(ownerRoot, runID, executable, args, timeoutMs);
  }

  /** Stop one observed critical Luna attempt, then reuse the durable Sol demotion recovery. */
  async criticalPathInput(ownerRoot: string, runID: string, sourceIdentity: ChildTerminalIdentity): Promise<CriticalPathInput> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) || !isChildTerminalIdentity(sourceIdentity)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Critical path observation identity is invalid.");
    }
    await this.recoverWithAuthority();
    return this.transaction((state) => {
      const run = this.requireRun(state, ownerRoot, runID);
      if (run.fabric === null || run.cancelled) {
        throw new ParallelDispatchError("descriptor-mismatch", "Critical path observation requires an active fabric run.");
      }
      const source = run.tasks.find((entry) => entry.descriptor.dispatch_id === sourceIdentity.attempt_id);
      if (source === undefined || source.descriptor.task_id !== sourceIdentity.unit_id || source.phase !== "running" ||
        source.descriptor.attempt !== 1 || source.call_id !== sourceIdentity.call_id ||
        source.child_session_id !== sourceIdentity.child_id || source.descriptor.base_sha !== sourceIdentity.candidate_id ||
        source.descriptor.parallel_group !== sourceIdentity.route_id) {
        throw new ParallelDispatchError("outcome-conflict", "Critical path source observation conflicts with durable state.");
      }
      const pendingWave = this.pendingFabricOutcomes.get(run.run_id);
      const unitState = (task: StoredTask | undefined): "pending" | "active" | "completed" | "cancelled" => {
        if (task === undefined || task.phase === "pending" || task.phase === "reserved") return "pending";
        if (task.phase === "completed") return "completed";
        if (task.phase !== "running") return "cancelled";
        const pending = pendingWave?.get(task.descriptor.dispatch_id);
        return pending?.outcome === "completed" && pending.artifact !== null ? "completed" :
          pending?.outcome !== null && pending?.outcome !== undefined ? "cancelled" : "active";
      };
      return { result: {
        active_takeover_count: run.fabric.demotion_transition === null ? 0 : 1,
        units: run.fabric.contract.units.map((unit) => {
          const task = run.tasks.find((entry) => entry.descriptor.task_id === unit.unit_id);
          return {
            unit_id: unit.unit_id,
            depends_on: unit.depends_on,
            state: unitState(task),
            executor: task?.descriptor.attempt === 2 ? "other" as const : "luna" as const,
            deadline: task?.descriptor.dispatch_id === sourceIdentity.attempt_id ? "deadline_exceeded" as const : "unknown" as const,
            failures: "unknown" as const,
          };
        }),
      }, changed: false };
    });
  }

  /** Stop one observed critical Luna attempt, then reuse the durable Sol demotion recovery. */
  async takeoverCriticalFabricUnit(
    ownerRoot: string,
    runID: string,
    observation: CriticalPathInput,
    sourceIdentity: ChildTerminalIdentity,
    lifecycle: CancellableChildLifecycle,
  ): Promise<LiveFabricTakeoverResult> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) || !isChildTerminalIdentity(sourceIdentity) ||
      !(lifecycle instanceof CancellableChildLifecycle) ||
      !sameChildTerminalIdentity(sourceIdentity, lifecycle.descriptor.identity)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Live fabric takeover identity is invalid.");
    }
    await this.recoverWithAuthority();
    const intent = await this.transaction<
      | { kind: "intent"; trigger: CriticalPathTakeoverTrigger; settled_dispatch_ids: readonly string[] }
      | { kind: "completed"; trigger: CriticalPathTakeoverTrigger; snapshot: ParallelDispatchSnapshot }
      | { kind: "none"; decision: CriticalPathResult }
    >((state) => {
      const run = this.requireRun(state, ownerRoot, runID);
      if (run.fabric === null || run.cancelled || run.fabric.transition !== null) {
        throw new ParallelDispatchError("descriptor-mismatch", "Run is not ready for live fabric takeover.");
      }
      const current = run.fabric.demotion_transition;
      if (current !== null) {
        if (current.phase !== "stopping" || current.unit_id !== sourceIdentity.unit_id ||
          current.source_identity === null || !sameChildTerminalIdentity(current.source_identity, sourceIdentity) ||
          current.trigger === "terminal_quality_rescue") {
          throw new ParallelDispatchError("outcome-conflict", "Another durable fabric takeover is active.");
        }
        return { result: { kind: "intent" as const, trigger: current.trigger as CriticalPathTakeoverTrigger,
          settled_dispatch_ids: [] }, changed: false };
      }
      const completedTakeover = run.fabric.demotions.find((entry) =>
        entry.luna_dispatch_id === sourceIdentity.attempt_id && entry.unit_id === sourceIdentity.unit_id &&
        entry.trigger !== "terminal_quality_rescue");
      if (completedTakeover !== undefined) {
        return { result: { kind: "completed" as const, trigger: completedTakeover.trigger as CriticalPathTakeoverTrigger,
          snapshot: this.publicSnapshot(run) }, changed: false };
      }
      const decision = proposeCriticalPathTakeover(observation);
      if (decision.status !== "proposed") return { result: { kind: "none" as const, decision }, changed: false };
      const task = run.tasks.find((entry) => entry.descriptor.task_id === decision.unit_id);
      const unit = run.fabric.contract.units.find((entry) => entry.unit_id === decision.unit_id);
      const observed = observation.units.find((entry) => entry.unit_id === decision.unit_id);
      const contractIDs = new Set(run.fabric.contract.units.map((entry) => entry.unit_id));
      if (observation.units.length !== contractIDs.size || observation.active_takeover_count !== 0 ||
        observation.units.some((entry) => !contractIDs.has(entry.unit_id)) || task === undefined || unit === undefined ||
        observed === undefined || observed.state !== "active" || task.phase !== "running" || task.descriptor.attempt !== 1 ||
        task.artifact !== null || task.call_id !== sourceIdentity.call_id ||
        (task.child_session_id !== null && task.child_session_id !== sourceIdentity.child_id) ||
        sourceIdentity.run_id !== run.run_id || sourceIdentity.unit_id !== task.descriptor.task_id ||
        sourceIdentity.attempt_id !== task.descriptor.dispatch_id || sourceIdentity.predecessor_attempt_id !== null ||
        sourceIdentity.candidate_id !== run.fabric.candidate_head || sourceIdentity.candidate_id !== task.descriptor.base_sha ||
        sourceIdentity.route_id !== task.descriptor.parallel_group ||
        run.fabric.demotions.some((entry) => entry.unit_id === decision.unit_id)) {
        throw new ParallelDispatchError("outcome-conflict", "Live fabric takeover observation conflicts with durable state.");
      }
      for (const contractUnit of run.fabric.contract.units) {
        const entry = observation.units.find((candidate) => candidate.unit_id === contractUnit.unit_id)!;
        if (entry.depends_on.length !== contractUnit.depends_on.length ||
          entry.depends_on.some((dependency, index) => dependency !== contractUnit.depends_on[index])) {
          throw new ParallelDispatchError("outcome-conflict", "Live fabric takeover graph conflicts with the accepted contract.");
        }
      }
      const trigger = criticalPathTakeoverTrigger(decision);
      // The normal wave barrier intentionally keeps sibling terminal outcomes in memory until every
      // lane settles. A deadline takeover is that barrier's exceptional completion path: preserve
      // already accepted siblings durably before replacing only the straggler.
      const pendingWave = this.pendingFabricOutcomes.get(run.run_id);
      const settled = run.tasks.filter((entry) => entry.descriptor.dispatch_id !== sourceIdentity.attempt_id &&
        entry.phase === "running" && pendingWave?.get(entry.descriptor.dispatch_id)?.outcome === "completed" &&
        pendingWave.get(entry.descriptor.dispatch_id)!.artifact !== null);
      for (const entry of settled) this.applyFabricOutcome(run, entry, pendingWave!.get(entry.descriptor.dispatch_id)!);
      this.planFabricDemotion(run, decision.unit_id, trigger, sourceIdentity, settled.map((entry) => entry.worktree_id));
      return { result: { kind: "intent" as const, trigger,
        settled_dispatch_ids: settled.map((entry) => entry.descriptor.dispatch_id) }, changed: true };
    });
    if (intent.kind === "none") return { status: "not-proposed", decision: intent.decision };
    if (intent.kind === "completed") return { status: "taken-over", trigger: intent.trigger, snapshot: intent.snapshot };
    const pendingWave = this.pendingFabricOutcomes.get(runID);
    for (const dispatchID of intent.settled_dispatch_ids) pendingWave?.delete(dispatchID);
    if (pendingWave?.size === 0) this.pendingFabricOutcomes.delete(runID);
    const stopped = await lifecycle.stopForTakeover(sourceIdentity);
    if (stopped.status !== "terminal") {
      const snapshot = await this.snapshot(ownerRoot, runID);
      if (snapshot === undefined) throw new ParallelDispatchError("outcome-conflict", "Live fabric takeover disappeared.");
      return { status: "waiting", trigger: intent.trigger, reason: stopped.reason, snapshot };
    }
    await this.transaction((state) => {
      const run = this.requireRun(state, ownerRoot, runID);
      const transition = run.fabric?.demotion_transition;
      const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === sourceIdentity.attempt_id);
      if (run.fabric === null || transition === null || transition === undefined || transition.phase !== "stopping" ||
        transition.source_identity === null || !sameChildTerminalIdentity(transition.source_identity, sourceIdentity) ||
        task === undefined || task.descriptor.attempt !== 1) {
        throw new ParallelDispatchError("outcome-conflict", "Live fabric takeover changed after source termination.");
      }
      task.phase = "failed";
      task.child_session_id = sourceIdentity.child_id;
      task.outcome = stopped.state.terminal?.disposition === "failed" ? "failed" : "cancelled";
      transition.phase = "cleanup";
      return { result: undefined, changed: true };
    });
    await this.withPrepareAuthority(async () => { await this.recoverFabricDemotion(runID); });
    const snapshot = await this.snapshot(ownerRoot, runID);
    if (snapshot === undefined) throw new ParallelDispatchError("outcome-conflict", "Live fabric takeover disappeared.");
    return { status: "taken-over", trigger: intent.trigger, snapshot };
  }

  async demoteFailedFabricUnit(ownerRoot: string, runID: string, unitID: string): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) || !validText(unitID, 128)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Fabric demotion identity is invalid.");
    }
    await this.recoverWithAuthority();
    const existing = await this.transaction((state) => {
      const run = this.requireRun(state, ownerRoot, runID);
      if (run.fabric === null || run.cancelled || run.fabric.transition !== null) {
        throw new ParallelDispatchError("descriptor-mismatch", "Run is not ready for fabric demotion.");
      }
      const task = run.tasks.find((entry) => entry.descriptor.task_id === unitID);
      if (task?.descriptor.attempt === 2) return { result: this.publicSnapshot(run), changed: false };
      if (run.fabric.demotion_transition !== null) return { result: undefined, changed: false };
      const active = new Set(run.fabric.scheduler.active?.unit_ids ?? []);
      if (!active.has(unitID) || task === undefined || task.phase !== "failed" || task.outcome === "cancelled" || task.descriptor.attempt !== 1 ||
        run.tasks.some((entry) => active.has(entry.descriptor.task_id) &&
          (entry.phase === "pending" || entry.phase === "reserved" || entry.phase === "running"))) {
        throw new ParallelDispatchError("wave-not-ready", "Fabric unit is not ready for Sol demotion.");
      }
      const completed = run.tasks.filter((entry) => active.has(entry.descriptor.task_id) && entry.phase === "completed" &&
        entry.artifact !== null && entry.artifact_accepted);
      this.planFabricDemotion(run, unitID, "terminal_quality_rescue", null,
        completed.map((entry) => entry.worktree_id));
      return { result: undefined, changed: true };
    });
    if (existing !== undefined) return existing;
    await this.withPrepareAuthority(async () => { await this.recoverFabricDemotion(runID); });
    const snapshot = await this.snapshot(ownerRoot, runID);
    if (snapshot === undefined) throw new ParallelDispatchError("outcome-conflict", "Fabric demotion disappeared.");
    return snapshot;
  }

  private planFabricDemotion(
    run: StoredRun,
    unitID: string,
    trigger: FabricDemotionTrigger,
    sourceIdentity: ChildTerminalIdentity | null,
    cleanupWorktreeIDs: string[],
  ): void {
    if (run.fabric === null) throw new ParallelDispatchError("descriptor-mismatch", "Fabric demotion requires a fabric run.");
    const task = run.tasks.find((entry) => entry.descriptor.task_id === unitID)!;
    const unit = run.fabric.contract.units.find((entry) => entry.unit_id === unitID)!;
    const fingerprintPrefix = run.contract_fingerprint.slice(0, 16);
    const worktreeID = `fabric-${fingerprintPrefix}-w${run.fabric.scheduler.wave}-sol-${unitID}`;
    const planned: PreparingTask = {
      dispatch_id: randomUUID(), task_id: unitID, worktree_id: worktreeID,
      lifecycle_identity: lifecycleIdentity(worktreeID),
      branch: `sortie-dogs/luna-fabric/${fingerprintPrefix}/w${run.fabric.scheduler.wave}-sol-${unitID}`,
      base_sha: run.fabric.scheduler.base_sha, depends_on: [...unit.depends_on],
      scope_read: [...unit.scope_read], scope_write: [...unit.scope_write],
    };
    const active = new Set(run.fabric.scheduler.active?.unit_ids ?? []);
    for (const entry of run.tasks.filter((candidate) => active.has(candidate.descriptor.task_id) &&
      candidate.phase === "completed" && candidate.artifact !== null && candidate.artifact_accepted)) {
      const ref = `refs/sortie-dogs/luna-fabric-sources/${fingerprint(run.run_id).slice(0, 16)}/${fingerprint(entry.descriptor.task_id).slice(0, 16)}`;
      if (!run.fabric.source_refs.some((source) => source.ref === ref)) {
        run.fabric.source_refs.push({ unit_id: entry.descriptor.task_id, ref, commit: entry.artifact!.commit_sha });
      }
    }
    run.fabric.demotion_transition = {
      phase: trigger === "terminal_quality_rescue" ? "cleanup" : "stopping",
      unit_id: unitID,
      failed_worktree_id: task.worktree_id,
      cleanup_worktree_ids: [...cleanupWorktreeIDs],
      task: planned,
      trigger,
      source_identity: sourceIdentity === null ? null : structuredClone(sourceIdentity),
    };
  }

  private async advanceFabricWave(
    ownerRoot: string,
    runID: string,
    candidateBase: string,
    builtCandidate?: BuiltFabricCandidate,
  ): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) || !SHA.test(candidateBase)) {
      throw new ParallelDispatchError("candidate-invalid", "Fabric wave advancement is invalid.");
    }
    await this.recoverWithAuthority();
    const evidence = await this.transaction((state) => {
      const run = this.requireRun(state, ownerRoot, runID);
      if (run.fabric === null || run.route !== "luna-fabric" || run.cancelled) {
        throw new ParallelDispatchError("descriptor-mismatch", "Run is not an active Luna fabric.");
      }
      if (run.fabric.transition !== null) {
        if (run.fabric.transition.candidate_base !== candidateBase) {
          throw new ParallelDispatchError("candidate-invalid", "Another fabric wave advancement is active.");
        }
        return { result: undefined, changed: false };
      }
      const active = run.fabric.scheduler.active?.unit_ids ?? [];
      const tasks = active.map((id) => run.tasks.find((task) => task.descriptor.task_id === id));
      if (active.length === 0 || tasks.some((task) => task === undefined || task.phase !== "completed" ||
        task.artifact === null || !task.artifact_accepted)) {
        throw new ParallelDispatchError("wave-not-ready", "Every active fabric unit must complete before the wave advances.");
      }
      return { result: {
        fabric: run.fabric,
        contract_fingerprint: run.contract_fingerprint,
        tasks: tasks.map((task) => ({ ...task!, descriptor: cloneDescriptor(task!.descriptor),
          artifact: cloneArtifact(task!.artifact!) })),
      }, changed: false };
    });
    if (evidence !== undefined) {
      await this.assertFabricCandidate(
        evidence.fabric, runID, evidence.contract_fingerprint, candidateBase, evidence.tasks, builtCandidate,
      );
      await this.transaction((state) => {
        const run = this.requireRun(state, ownerRoot, runID);
        if (run.fabric === null || run.fabric.transition !== null ||
          fingerprint(run.fabric.scheduler) !== fingerprint(evidence.fabric.scheduler)) {
          throw new ParallelDispatchError("outcome-conflict", "Fabric wave changed while advancement was verified.");
        }
        const scheduler = createLunaFabricScheduler(run.fabric.contract, run.fabric.authority_sha, run.fabric.scheduler);
        const active = [...(run.fabric.scheduler.active?.unit_ids ?? [])];
        scheduler.advance({ candidate_base: candidateBase, completed_unit_ids: active });
        scheduler.nextWave();
        const next = scheduler.snapshot();
        const contract = next.active === null ? undefined
          : fabricDispatchContract(run.fabric.contract, run.contract_fingerprint, next);
        const tasks: PreparingTask[] = (contract?.tasks ?? []).map((task) => ({
          dispatch_id: randomUUID(),
          task_id: task.task_id,
          worktree_id: task.worktree,
          lifecycle_identity: lifecycleIdentity(task.worktree),
          branch: task.branch,
          base_sha: task.base_sha,
          depends_on: [...task.depends_on],
          scope_read: [...task.scope.read],
          scope_write: [...task.scope.write],
        }));
        run.fabric.transition = {
          phase: "cleanup",
          candidate_base: candidateBase,
          completed_unit_ids: active,
          cleanup_worktree_ids: active.map((id) =>
            run.tasks.find((task) => task.descriptor.task_id === id)!.worktree_id),
          scheduler: next,
          tasks,
        };
        run.fabric.candidate_head = candidateBase;
        if (run.fabric.wave_heads.at(-1) !== candidateBase) run.fabric.wave_heads.push(candidateBase);
        if (run.execution_plan !== null && run.plan_ledger !== null) {
          run.plan_ledger = appendRunFlightLedgerEvents(run.plan_ledger, [{
            kind: "fabric.wave.accepted",
            at: new Date().toISOString(),
            plan_id: run.execution_plan.plan_id,
            plan_binding_id: run.execution_plan.binding_id,
            wave_index: evidence.fabric.scheduler.active!.number,
            from_candidate_id: evidence.fabric.candidate_head,
            candidate_id: candidateBase,
            artifacts: evidence.tasks.map((task) => ({
              unit_id: task.descriptor.task_id,
              commit_sha: task.artifact!.commit_sha,
              change_fingerprint: task.artifact!.change_fingerprint,
              validation_fingerprint: task.artifact!.validation.validation_fingerprint,
            })),
            scheduler_before: evidence.fabric.scheduler,
            scheduler_after: next,
            candidate_snapshot: {
              authority_sha: run.fabric.authority_sha,
              target_branch: run.fabric.target_branch,
              candidate_ref: run.fabric.candidate_ref,
              candidate_head: candidateBase,
              wave_heads: [...run.fabric.wave_heads],
            },
          }]);
        }
        return { result: undefined, changed: true };
      });
    }
    await this.withPrepareAuthority(async () => { await this.recoverFabricTransition(runID, builtCandidate); });
    const snapshot = await this.snapshot(ownerRoot, runID);
    if (snapshot === undefined) throw new ParallelDispatchError("outcome-conflict", "Fabric wave advancement disappeared.");
    return snapshot;
  }

  async validateFabricCandidate(
    ownerRoot: string,
    runID: string,
    executable: string,
    args: readonly string[] = [],
    timeoutMs = 10 * 60_000,
  ): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) || !isAbsolute(executable) ||
      !Array.isArray(args) || args.length > 128 || !args.every((arg) => validText(arg, MAX_COMMAND_TEXT)) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
      throw new ParallelDispatchError("invalid-contract", "Final fabric validation request is invalid.");
    }
    const requestedCommand = [executable, ...args];
    const claimKey = `${this.stateRoot}\u0000${runID}`;
    if (activeFabricValidations.has(claimKey)) {
      throw new ParallelDispatchError("outcome-conflict", "Final fabric validation is already running.");
    }
    activeFabricValidations.add(claimKey);
    try {
      return await this.withFabricOperationAuthority(async (lease) => {
        let claimed = false;
        let authorityLost = false;
        const assertAuthority = async (): Promise<void> => {
          try { await lease.assertHeld(); }
          catch {
            authorityLost = true;
            throw new ParallelDispatchError("state-locked", "Fabric validation authority was lost.");
          }
        };
        try {
          await this.recoverWithAuthority();
          const evidence = await this.transaction<
            | { kind: "archived"; snapshot: ParallelDispatchSnapshot }
            | { kind: "active"; fabric: StoredFabric; replay: boolean }
          >((state) => {
            const archived = this.findRunArchive(state, ownerRoot, runID);
            if (archived !== undefined) {
              const fabric = archived.run.fabric;
              if (fabric === null || !["pass", "fail"].includes(fabric.validation.status) ||
                JSON.stringify(fabric.validation.command) !== JSON.stringify(requestedCommand)) {
                throw new ParallelDispatchError("outcome-conflict", "Archived fabric validation does not match.");
              }
              return { result: { kind: "archived", snapshot: this.publicSnapshot(
                archived.run, true, archived.terminal_reason,
              ) }, changed: false };
            }
            const run = this.requireRun(state, ownerRoot, runID);
            if (run.fabric === null || run.fabric.transition !== null || run.fabric.demotion_transition !== null ||
              run.fabric.scheduler.active !== null ||
              run.fabric.scheduler.pending.length !== 0 || run.fabric.promoted) {
              throw new ParallelDispatchError("wave-not-ready", "Fabric candidate is not ready for final validation.");
            }
            if (run.fabric.validation.status !== "pending") {
              if (JSON.stringify(run.fabric.validation.command) !== JSON.stringify(requestedCommand)) {
                throw new ParallelDispatchError("outcome-conflict", "Fabric validation command does not match the replay request.");
              }
              return { result: { kind: "active", fabric: run.fabric,
                replay: run.fabric.validation.status !== "running" }, changed: false };
            }
            run.fabric.validation = { command: requestedCommand, status: "running", fingerprint: null };
            return { result: { kind: "active", fabric: run.fabric, replay: false }, changed: true };
          });
          if (evidence.kind === "archived") return evidence.snapshot;
          if (evidence.replay) {
            if (evidence.fabric.validation.status === "fail") {
              return await this.finalizeFailedFabricValidation(ownerRoot, runID, evidence.fabric, lease);
            }
            const snapshot = await this.snapshot(ownerRoot, runID);
            if (snapshot === undefined) throw new ParallelDispatchError("outcome-conflict", "Validated fabric candidate disappeared.");
            return snapshot;
          }
          claimed = true;
          await assertAuthority();
          await this.assertFabricAuthority(evidence.fabric);
          if (await this.readRef(evidence.fabric.candidate_ref) !== evidence.fabric.candidate_head) {
            throw new ParallelDispatchError("candidate-invalid", "Hidden candidate ref changed before validation.");
          }
          const path = join(this.stateRoot, `fabric-validation-${randomUUID()}`);
          let added = false;
          let result;
          let pendingSettlement: FabricValidationSettlement | undefined;
          let settlementPersisted = false;
          const validationRequest: ValidationBudgetRequest = { run_id: runID, operation_id: runID,
            source_snapshot: evidence.fabric.candidate_head, candidate: evidence.fabric.candidate_head,
            command: requestedCommand, environment: { platform: process.platform, arch: process.arch, runtime: process.version },
            scope: "canonical", owner: "coordinator",
            expected_evidence: ["source_snapshot", "command", "scope", "exit_code", "clean_worktree"],
            marginal_value: { unmet_criteria: ["fabric-candidate"], risk_hypothesis: null }, reason: "acceptance" };
          const persistSettlement = async (settlement: FabricValidationSettlement): Promise<void> => {
            await this.transaction((state) => {
              const run = this.requireRun(state, ownerRoot, runID);
              // The enclosing fabric validation transition durably settles legacy/direct runs.
              if (run.plan_ledger === null) return { result: undefined, changed: false };
              run.plan_ledger = appendRunFlightLedgerEvents(run.plan_ledger, [{ kind: "validation.settled", at: new Date().toISOString(),
                reservation_id: validationEvidenceKey(validationRequest), operation_id: validationRequest.operation_id,
                evidence_key: validationEvidenceKey(validationRequest), outcome: settlement.outcome, exit_code: settlement.exitCode,
                evidence_fingerprint: validationResultFingerprint(validationRequest, settlement.outcome, settlement.exitCode),
                ...(settlement.duration_ms === undefined ? {} : { duration_ms: settlement.duration_ms }), reason: settlement.outcome }]);
              return { result: undefined, changed: true };
            });
            settlementPersisted = true;
          };
          try {
            await this.gitBuffer(["worktree", "add", "--detach", path, evidence.fabric.candidate_head]);
            added = true;
            const beforeHead = (await this.gitBuffer(["rev-parse", "--verify", "HEAD^{commit}"], undefined, path)).toString("utf8").trim();
            const beforeStatus = await this.gitBuffer(["status", "--porcelain=v1", "--untracked-files=normal"], undefined, path);
            if (beforeHead !== evidence.fabric.candidate_head || beforeStatus.length !== 0) throw new Error("validation-worktree");
            result = await runBudgetedContainedValidation({ executable, args, cwd: path, timeout_ms: timeoutMs }, {
              request: validationRequest,
              reserve: async () => {
                let reservation: { decision: "ALLOW" | "SKIP" | "DENY"; reservation_id: string | null; reason: string;
                  reused?: ContainedValidationResult } =
                  { decision: "DENY", reservation_id: null, reason: "invalid-contract" };
                await this.transaction((state) => {
                  const run = this.requireRun(state, ownerRoot, runID);
                  // Legacy/direct fabric runs have no compiled-plan ledger. Their durable
                  // validation.running claim is still the single reservation authority.
                  if (run.plan_ledger === null) {
                    reservation = { decision: "ALLOW", reservation_id: validationEvidenceKey(validationRequest), reason: "allowed" };
                    return { result: undefined, changed: false };
                  }
                   const current = reconstructRunFlightLedger(run.plan_ledger);
                   const decision = decideFabricValidationAdmission(validationRequest, current.validation_budget.consumed,
                     run.plan_ledger.map(({ event }) => event));
                  const reservationId = decision.decision === "ALLOW" ? validationEvidenceKey(validationRequest) : null;
                  run.plan_ledger = appendRunFlightLedgerEvents(run.plan_ledger, [{ kind: "validation.admission", at: new Date().toISOString(),
                    reservation_id: reservationId ?? `deny-${validationEvidenceKey(validationRequest)}`, operation_id: validationRequest.operation_id,
                     evidence_key: decision.evidence_key ?? `sha256:${"0".repeat(64)}`, scope: decision.scope, decision: decision.decision,
                     reason: decision.reason, consumed: decision.consumed, limit: 1, saved_ms: decision.redundant_time_ms }]);
                   reservation = { decision: decision.decision, reservation_id: reservationId, reason: decision.reason,
                     ...(decision.decision === "SKIP" && decision.reused_fingerprint !== null ? { reused: Object.freeze({ ok: true as const,
                       command: Object.freeze([...requestedCommand]), exit_code: 0 as const,
                       fingerprint: decision.reused_fingerprint, error: null }) } : {}) };
                  return { result: undefined, changed: true };
                });
                return reservation;
              },
               settle: async (outcome, exitCode, duration_ms) => {
                 pendingSettlement = { outcome, exitCode, ...(duration_ms === undefined ? {} : { duration_ms }) };
               },
            });
            const afterHead = (await this.gitBuffer(["rev-parse", "--verify", "HEAD^{commit}"], undefined, path)).toString("utf8").trim();
            const afterStatus = await this.gitBuffer(["status", "--porcelain=v1", "--untracked-files=normal"], undefined, path);
            const postconditionsPassed = afterHead === evidence.fabric.candidate_head && afterStatus.length === 0;
            if (pendingSettlement !== undefined) {
              await persistSettlement(finalizeFabricValidationSettlement(pendingSettlement, postconditionsPassed));
            }
            if (!postconditionsPassed) {
              result = { ...result, ok: false as const, error: "execution-failed" as const };
            }
          } catch {
            if (pendingSettlement !== undefined && !settlementPersisted) {
              await persistSettlement(finalizeFabricValidationSettlement(pendingSettlement, false)).catch(() => undefined);
            }
            throw new ParallelDispatchError("candidate-invalid", "Final fabric validation worktree failed closed.");
          } finally {
            if (added) {
              await this.gitBuffer(["worktree", "remove", "--force", path]).catch(() => undefined);
            }
          }
          if (result === undefined) throw new ParallelDispatchError("candidate-invalid", "Final fabric validation produced no result.");
          await assertAuthority();
          const snapshot = await this.transaction((state) => {
            const run = this.requireRun(state, ownerRoot, runID);
            if (run.fabric === null || run.fabric.candidate_head !== evidence.fabric.candidate_head ||
              run.fabric.validation.status !== "running" ||
              JSON.stringify(run.fabric.validation.command) !== JSON.stringify(result.command)) {
              throw new ParallelDispatchError("outcome-conflict", "Fabric candidate changed during final validation.");
            }
            run.fabric.validation = {
              command: [...result.command],
              status: result.ok ? "pass" : "fail",
              fingerprint: result.fingerprint,
            };
            return { result: this.publicSnapshot(run), changed: true };
          });
          claimed = false;
          return result.ok ? snapshot
            : await this.finalizeFailedFabricValidation(ownerRoot, runID, evidence.fabric, lease);
        } catch (error) {
          if (claimed && !authorityLost) {
            await this.transaction((state) => {
              const run = state.run;
              if (run?.kind === "run" && run.run_id === runID && run.owner_root === ownerRoot && run.fabric !== null &&
                run.fabric.validation.status === "running" &&
                JSON.stringify(run.fabric.validation.command) === JSON.stringify(requestedCommand)) {
                run.fabric.validation = { command: [], status: "pending", fingerprint: null };
                return { result: undefined, changed: true };
              }
              return { result: undefined, changed: false };
            }).catch(() => undefined);
          }
          throw error;
        }
      });
    } finally {
      activeFabricValidations.delete(claimKey);
    }
  }

  private async finalizeFailedFabricValidation(
    ownerRoot: string,
    runID: string,
    fabric: StoredFabric,
    lease: ScopeLease,
  ): Promise<ParallelDispatchSnapshot> {
    await lease.assertHeld().catch(() => { throw new ParallelDispatchError("state-locked", "Fabric validation authority was lost."); });
    if (await this.readRef(fabric.candidate_ref) === fabric.candidate_head) {
      await this.git(["update-ref", "-d", fabric.candidate_ref, fabric.candidate_head]);
    }
    await this.deleteFabricSourceRefs(fabric);
    return this.transaction((state) => {
      const run = this.requireRun(state, ownerRoot, runID);
      if (run.fabric === null || run.fabric.candidate_head !== fabric.candidate_head ||
        run.fabric.validation.status !== "fail" || run.fabric.validation.fingerprint === null) {
        throw new ParallelDispatchError("outcome-conflict", "Failed fabric validation changed during cleanup.");
      }
      return { result: this.archiveIfTerminal(state, run), changed: true };
    });
  }

  async acceptFabricCandidate(
    ownerRoot: string,
    runID: string,
    candidateHead: string,
    review: "pass" | "skip" | "fail",
    reviewFingerprint: string,
  ): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) || !SHA.test(candidateHead) ||
      !["pass", "skip", "fail"].includes(review) || !HASH.test(reviewFingerprint)) {
      throw new ParallelDispatchError("invalid-contract", "Final fabric review decision is invalid.");
    }
    return this.withFabricOperationAuthority(async (lease) => {
      await this.recoverWithAuthority();
      const evidence = await this.transaction<
        { kind: "archived"; snapshot: ParallelDispatchSnapshot } | { kind: "active"; fabric: StoredFabric }
      >((state) => {
        const archived = this.findRunArchive(state, ownerRoot, runID);
        if (archived !== undefined) {
          const fabric = archived.run.fabric;
          if (fabric === null || fabric.candidate_head !== candidateHead ||
            fabric.review.status !== review || fabric.review.fingerprint !== reviewFingerprint ||
            (review !== "fail" && !fabric.promoted)) {
            throw new ParallelDispatchError("outcome-conflict", "Archived fabric review does not match.");
          }
          return { result: { kind: "archived", snapshot: this.publicSnapshot(archived.run, true, archived.terminal_reason) }, changed: false };
        }
        const run = this.requireRun(state, ownerRoot, runID);
        if (run.fabric === null || run.fabric.candidate_head !== candidateHead ||
          run.fabric.validation.status !== "pass" || run.fabric.validation.fingerprint === null ||
          run.fabric.transition !== null || run.fabric.demotion_transition !== null ||
          run.fabric.scheduler.active !== null || run.fabric.scheduler.pending.length !== 0) {
          throw new ParallelDispatchError("candidate-invalid", "Validated final fabric candidate is absent.");
        }
        if (run.fabric.review.status === "pending") {
          run.fabric.review = { status: review, fingerprint: reviewFingerprint };
          return { result: { kind: "active", fabric: run.fabric }, changed: true };
        }
        if (run.fabric.review.status !== review || run.fabric.review.fingerprint !== reviewFingerprint ||
          run.fabric.promoted) {
          throw new ParallelDispatchError("outcome-conflict", "A different fabric review decision is already claimed.");
        }
        return { result: { kind: "active", fabric: run.fabric }, changed: false };
      });
      if (evidence.kind === "archived") return evidence.snapshot;
      const fabric = evidence.fabric;
      if (review === "fail") {
        await lease.assertHeld().catch(() => { throw new ParallelDispatchError("state-locked", "Fabric review authority was lost."); });
        if (await this.readRef(fabric.candidate_ref) === candidateHead) {
          await this.git(["update-ref", "-d", fabric.candidate_ref, candidateHead]);
        }
        await this.deleteFabricSourceRefs(fabric);
        return this.transaction((state) => {
          const run = this.requireRun(state, ownerRoot, runID);
          if (run.fabric === null || run.fabric.candidate_head !== candidateHead ||
            run.fabric.review.status !== review || run.fabric.review.fingerprint !== reviewFingerprint) {
            throw new ParallelDispatchError("outcome-conflict", "Fabric candidate changed during review.");
          }
          return { result: this.archiveIfTerminal(state, run), changed: true };
        });
      }
      const targetRef = `refs/heads/${fabric.target_branch}`;
      try {
        const target = await this.readRef(targetRef);
        const primary = await this.lifecycle.pinCleanBase().catch(() => undefined);
        if (primary?.sha !== fabric.authority_sha || (target !== fabric.authority_sha && target !== candidateHead) ||
          await this.targetCheckedOut(targetRef)) {
          throw new ParallelDispatchError("candidate-invalid", "Final target is stale, dirty, or checked out.");
        }
        await lease.assertHeld().catch(() => { throw new ParallelDispatchError("state-locked", "Fabric promotion authority was lost."); });
        if (target === fabric.authority_sha) {
          try { await this.git(["update-ref", targetRef, candidateHead, fabric.authority_sha]); }
          catch {
            if (await this.readRef(targetRef) !== candidateHead) {
              throw new ParallelDispatchError("candidate-invalid", "Final target CAS was lost.");
            }
          }
        }
        if (await this.readRef(fabric.candidate_ref) === candidateHead) {
          await this.git(["update-ref", "-d", fabric.candidate_ref, candidateHead]);
        }
        await this.deleteFabricSourceRefs(fabric);
        return this.transaction((state) => {
          const run = this.requireRun(state, ownerRoot, runID);
          if (run.fabric === null || run.fabric.candidate_head !== candidateHead ||
            run.fabric.review.status !== review || run.fabric.review.fingerprint !== reviewFingerprint || run.cancelled) {
            throw new ParallelDispatchError("outcome-conflict", "Fabric candidate changed during promotion.");
          }
          run.fabric.promoted = true;
          return { result: this.archiveIfTerminal(state, run), changed: true };
        });
      } catch (error) {
        if (await this.readRef(targetRef).catch(() => undefined) !== candidateHead) {
          await this.transaction((state) => {
            const run = state.run;
            if (run?.owner_root !== ownerRoot || run.run_id !== runID || run.fabric === null ||
              run.fabric.candidate_head !== candidateHead || run.fabric.promoted ||
              run.fabric.review.status !== review || run.fabric.review.fingerprint !== reviewFingerprint) {
              return { result: undefined, changed: false };
            }
            run.fabric.review = { status: "pending", fingerprint: null };
            return { result: undefined, changed: true };
          }).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async bindDispatch(ownerRoot: string, callID: string, descriptor: ParallelDispatchDescriptor): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !validText(callID, 256) || !validDescriptor(descriptor)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Parallel dispatch descriptor is invalid.");
    }
    await this.recoverWithAuthority();
    const state = await this.load();
    const run = state.run?.kind === "run" && state.run.owner_root === ownerRoot &&
      state.run.run_id === descriptor.run_id ? state.run : undefined;
    const fabric = run?.fabric ?? null;
    const fabricFingerprint = fabric === null ? null : fingerprint(fabric);
    if (fabric !== null) await this.assertFabricAuthority(fabric);
    return this.transaction((state) => {
      if (state.run === null && this.findRunArchive(state, ownerRoot, descriptor.run_id) !== undefined) {
        throw new ParallelDispatchError("descriptor-replay", "Parallel dispatch run is already archived.");
      }
      const run = this.requireRun(state, ownerRoot, descriptor.run_id);
      if ((run.fabric === null ? null : fingerprint(run.fabric)) !== fabricFingerprint ||
        (run.fabric !== null && (run.fabric.transition !== null || run.fabric.demotion_transition !== null))) {
        throw new ParallelDispatchError("outcome-conflict", "Fabric recovery state changed during dispatch binding.");
      }
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

  async acceptArtifact(
    ownerRoot: string,
    callID: string,
    childSessionID: string,
    descriptor: ParallelDispatchDescriptor,
    artifact: WorktreeCommitArtifact,
  ): Promise<ParallelDispatchSnapshot> {
    if (!validText(ownerRoot, 256) || !validText(callID, 256) || !validText(childSessionID, 256) ||
      !validDescriptor(descriptor) || !isRecord(artifact)) {
      throw new ParallelDispatchError("artifact-invalid", "Commit artifact claim is invalid.");
    }
    await this.recoverWithAuthority();
    const authorizationState = await this.load();
    const authorized = (() => {
      const state = authorizationState;
      const archived = state.run === null ? this.findRunArchive(state, ownerRoot, descriptor.run_id) : undefined;
      if (archived !== undefined) {
        const task = archived.run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
        if (task !== undefined && task.call_id === callID && task.child_session_id === childSessionID &&
          task.artifact_accepted && task.artifact !== null && fingerprint(task.artifact) === fingerprint(artifact)) {
          return undefined;
        }
        throw new ParallelDispatchError("outcome-conflict", "Archived dispatch artifact does not match.");
      }
      const run = this.requireRun(state, ownerRoot, descriptor.run_id);
      const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
      if (task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor)) {
        throw new ParallelDispatchError("descriptor-mismatch", "Artifact descriptor does not match durable state.");
      }
      if (task.artifact !== null) {
        if (task.artifact_accepted && (task.phase === "running" || task.phase === "completed") && task.call_id === callID &&
          task.child_session_id === childSessionID &&
          fingerprint(task.artifact) === fingerprint(artifact)) {
          return undefined;
        }
        if (task.phase !== "running" || task.call_id !== callID || task.child_session_id !== childSessionID ||
          fingerprint(task.artifact) !== fingerprint(artifact)) {
          throw new ParallelDispatchError("outcome-conflict", "A different artifact or outcome was already recorded.");
        }
      }
      if (task.phase !== "running" || task.call_id !== callID ||
        (task.child_session_id !== null && task.child_session_id !== childSessionID)) {
        throw new ParallelDispatchError("descriptor-replay", "Artifact is not authorized for the active dispatch.");
      }
      return { worktreeID: task.worktree_id, descriptor: cloneDescriptor(task.descriptor), fabric: run.fabric };
    })();
    if (authorized === undefined) {
      const snapshot = await this.snapshot(ownerRoot, descriptor.run_id);
      if (snapshot === undefined) throw new ParallelDispatchError("outcome-conflict", "Artifact outcome disappeared.");
      return snapshot;
    }
    if (!validArtifact(artifact, descriptor)) {
      throw new ParallelDispatchError("artifact-invalid", "Commit artifact claim is invalid.");
    }
    if (authorized.fabric !== null) await this.assertFabricAuthority(authorized.fabric);
    try {
      await verifyWorktreeCommitArtifact({
        descriptor: authorized.descriptor,
        managed_path: authorized.descriptor.managed_path,
        artifact,
      });
    } catch {
      throw new ParallelDispatchError("artifact-invalid", "Commit artifact verification failed.");
    }
    if (authorized.fabric !== null) {
      try {
        await this.lifecycle.acceptCommit(
          authorized.worktreeID,
          authorized.descriptor.managed_path,
          authorized.descriptor.base_sha,
          artifact.commit_sha,
          authorized.descriptor.branch,
        );
      } catch {
        throw new ParallelDispatchError("lifecycle-failed", "Verified commit could not be accepted by worktree lifecycle.");
      }
      return this.transaction((state) => {
        const run = this.requireRun(state, ownerRoot, descriptor.run_id);
        const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
        if (run.fabric === null || task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor) ||
          task.phase !== "running" || task.call_id !== callID ||
          (task.child_session_id !== null && task.child_session_id !== childSessionID)) {
          throw new ParallelDispatchError("outcome-conflict", "Dispatch changed while its artifact was being accepted.");
        }
        if (task.artifact !== null && fingerprint(task.artifact) !== fingerprint(artifact)) {
          throw new ParallelDispatchError("outcome-conflict", "A competing artifact was already recorded.");
        }
        task.child_session_id = childSessionID;
        task.artifact = cloneArtifact(artifact);
        task.artifact_accepted = true;
        return { result: this.publicSnapshot(run), changed: true };
      });
    }
    const preAccepted = await this.transaction((state) => {
      if (state.run === null || state.run.kind !== "run" || state.run.owner_root !== ownerRoot ||
        state.run.run_id !== descriptor.run_id) {
        throw new ParallelDispatchError("outcome-conflict", "Dispatch changed while its artifact was being accepted.");
      }
      const run = state.run;
      const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
      if (task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor) ||
        task.phase !== "running" || task.call_id !== callID ||
        (task.child_session_id !== null && task.child_session_id !== childSessionID)) {
        throw new ParallelDispatchError("outcome-conflict", "Dispatch changed while its artifact was being accepted.");
      }
      if (task.artifact !== null && fingerprint(task.artifact) !== fingerprint(artifact)) {
        throw new ParallelDispatchError("outcome-conflict", "A competing artifact was already recorded.");
      }
      if (task.artifact_accepted) return { result: true, changed: false };
      if (task.artifact !== null) return { result: false, changed: false };
      task.child_session_id = childSessionID;
      task.artifact = cloneArtifact(artifact);
      task.artifact_accepted = false;
      return { result: false, changed: true };
    });
    if (preAccepted) {
      const snapshot = await this.snapshot(ownerRoot, descriptor.run_id);
      if (snapshot === undefined) throw new ParallelDispatchError("outcome-conflict", "Artifact outcome disappeared.");
      return snapshot;
    }
    try {
      await this.lifecycle.acceptCommit(
        authorized.worktreeID,
        authorized.descriptor.managed_path,
        authorized.descriptor.base_sha,
        artifact.commit_sha,
        authorized.descriptor.branch,
      );
    } catch {
      throw new ParallelDispatchError("lifecycle-failed", "Verified commit could not be accepted by worktree lifecycle.");
    }
    return this.transaction((state) => {
      if (state.run === null || state.run.kind !== "run" || state.run.owner_root !== ownerRoot ||
        state.run.run_id !== descriptor.run_id) {
        throw new ParallelDispatchError("outcome-conflict", "Dispatch changed while its artifact was being accepted.");
      }
      const run = this.requireRun(state, ownerRoot, descriptor.run_id);
      const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
      if (task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor) ||
        task.phase !== "running" || task.call_id !== callID || task.child_session_id !== childSessionID) {
        throw new ParallelDispatchError("outcome-conflict", "Dispatch changed while its artifact was being accepted.");
      }
      if (task.artifact === null || fingerprint(task.artifact) !== fingerprint(artifact)) {
        throw new ParallelDispatchError("outcome-conflict", "A competing artifact was already recorded.");
      }
      if (task.artifact_accepted) return { result: this.publicSnapshot(run), changed: false };
      task.artifact_accepted = true;
      return { result: this.publicSnapshot(run), changed: true };
    });
  }

  async completeCall(
    ownerRoot: string,
    callID: string,
    childSessionID: string | undefined,
    outcome: ParallelDispatchOutcome,
    claimed?: ParallelDispatchClaim,
  ): Promise<ParallelDispatchSnapshot | undefined> {
    if (!validText(ownerRoot, 256) || !validText(callID, 256) ||
      (childSessionID !== undefined && !validText(childSessionID, 256)) || !OUTCOMES.has(outcome) ||
      (claimed !== undefined && !validClaim(claimed))) {
      throw new ParallelDispatchError("outcome-conflict", "Parallel outcome is invalid.");
    }
    await this.recoverWithAuthority();
    const fabricResult = await this.completeFabricCall(ownerRoot, callID, childSessionID, outcome, claimed);
    if (fabricResult.handled) return fabricResult.snapshot;
    return this.transaction((state) => {
      if (state.run === null || state.run.kind !== "run" || state.run.owner_root !== ownerRoot) {
        const archived = state.archived.find((entry): entry is StoredRunArchive => entry.kind === "run" &&
          entry.run.owner_root === ownerRoot && entry.run.tasks.some((task) => task.call_id === callID));
        if (archived === undefined) return { result: undefined, changed: false };
        const task = archived.run.tasks.find((entry) => entry.call_id === callID)!;
        let effective = outcome;
        if (effective === "completed" && (claimed === undefined || claimed.run_id !== archived.run.run_id ||
          claimed.dispatch_id !== task.descriptor.dispatch_id || childSessionID === undefined ||
          task.child_session_id !== childSessionID || task.artifact === null || !task.artifact_accepted)) effective = "failed";
        if (task.outcome !== effective || (childSessionID !== undefined && task.child_session_id !== childSessionID)) {
          throw new ParallelDispatchError("outcome-conflict", "A different terminal outcome was already recorded.");
        }
        return { result: this.publicSnapshot(archived.run, true, archived.terminal_reason), changed: false };
      }
      const run = state.run;
      const task = run.tasks.find((entry) => entry.call_id === callID);
      if (task === undefined) return { result: undefined, changed: false };
      let effective = outcome;
      if (effective === "completed" && (claimed === undefined || claimed.run_id !== run.run_id ||
        claimed.dispatch_id !== task.descriptor.dispatch_id || childSessionID === undefined ||
        task.child_session_id !== childSessionID || task.artifact === null || !task.artifact_accepted)) effective = "failed";
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

  async childLedger(ownerRoot: string, descriptor: ParallelDispatchDescriptor, callID: string, childID: string): Promise<RunFlightLedger> {
    if (!validText(childID, 256)) throw new ParallelDispatchError("descriptor-mismatch", "Child identity is invalid.");
    await this.transaction((state) => {
      const run = state.run?.kind === "run" && state.run.run_id === descriptor.run_id
        ? this.requireRun(state, ownerRoot, descriptor.run_id)
        : this.findRunArchive(state, ownerRoot, descriptor.run_id)?.run;
      if (run === undefined) throw new ParallelDispatchError("descriptor-mismatch", "Child run is unavailable.");
      const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
      if (task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor) || task.call_id !== callID ||
        (task.child_session_id === null && task.phase !== "running") ||
        (task.child_session_id !== null && task.child_session_id !== childID)) {
        throw new ParallelDispatchError("descriptor-mismatch", "Child lifecycle does not match its durable dispatch.");
      }
      const changed = task.child_session_id === null;
      task.child_session_id = childID;
      return { result: undefined, changed };
    });
    return RunFlightLedger.open(join(this.stateRoot, "children", `${descriptor.dispatch_id}.json`), {
      store: new EvidenceCapsuleStore(join(this.stateRoot, "capsules")), declared_capsule_ids: [],
      authorized_source_paths: descriptor.scope_read,
    });
  }

  async releaseChildWorktree(ownerRoot: string, descriptor: ParallelDispatchDescriptor, callID: string,
    childID: string, evidence: ChildTerminalEvidence, discardOwnedChanges = false): Promise<void> {
    if (["terminal", "tools_quiescent", "artifact_window_closed", "writer_released", "gate_released", "lease_released"]
      .some((key) => evidence[key as keyof ChildTerminalEvidence] !== "satisfied")) {
      throw new ParallelDispatchError("outcome-conflict", "Child release lacks quiescence evidence.");
    }
    const release = await this.transaction((state) => {
      const run = state.run?.kind === "run" && state.run.run_id === descriptor.run_id
        ? this.requireRun(state, ownerRoot, descriptor.run_id)
        : this.findRunArchive(state, ownerRoot, descriptor.run_id)?.run;
      if (run === undefined) throw new ParallelDispatchError("descriptor-mismatch", "Child run is unavailable.");
      const task = run.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
      if (task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor) ||
        task.call_id !== callID || task.child_session_id !== childID) {
        throw new ParallelDispatchError("descriptor-mismatch", "Child release identity changed.");
      }
      let ref: string | undefined;
      if (task.artifact !== null) {
        ref = run.fabric === null
          ? `refs/sortie-dogs/child-artifacts/${fingerprint(run.run_id).slice(0, 16)}/${fingerprint(descriptor.dispatch_id).slice(0, 16)}`
          : `refs/sortie-dogs/luna-fabric-sources/${fingerprint(run.run_id).slice(0, 16)}/${fingerprint(descriptor.task_id).slice(0, 16)}`;
        if (run.fabric !== null && !run.fabric.source_refs.some((entry) => entry.ref === ref)) {
          run.fabric.source_refs.push({ unit_id: descriptor.task_id, ref, commit: task.artifact.commit_sha });
          return { result: { worktree: task.worktree_id, ref, commit: task.artifact.commit_sha,
            managedPath: task.descriptor.managed_path, baseSha: task.descriptor.base_sha,
            branch: task.descriptor.branch, scopeWrite: task.descriptor.scope_write }, changed: true };
        }
      }
      return { result: { worktree: task.worktree_id, ref, commit: task.artifact?.commit_sha,
        managedPath: task.descriptor.managed_path, baseSha: task.descriptor.base_sha,
        branch: task.descriptor.branch, scopeWrite: task.descriptor.scope_write }, changed: false };
    });
    if (release.ref !== undefined && release.commit !== undefined) {
      const existing = await this.readRef(release.ref);
      if (existing === undefined) await this.git(["update-ref", release.ref, release.commit, ""]);
      else if (existing !== release.commit) throw new ParallelDispatchError("outcome-conflict", "Accepted child artifact ref changed.");
    }
    if (await this.lifecycle.hasManagedWorktree(release.worktree)) {
      if (discardOwnedChanges && release.commit === undefined) {
        await this.lifecycle.discardOwnedChanges(release.worktree, release.managedPath, release.baseSha,
          release.branch, release.scopeWrite);
      }
      await this.lifecycle.cleanup(release.worktree);
    }
  }

  async cleanupSuppressed(ownerRoot: string, runID: string): Promise<void> {
    const snapshot = await this.snapshot(ownerRoot, runID);
    if (snapshot === undefined) throw new ParallelDispatchError("descriptor-mismatch", "Cancelled run is unavailable.");
    for (const task of snapshot.tasks) {
      if (task.phase === "suppressed" && task.call_id === null && task.child_session_id === null && task.artifact === null &&
        await this.lifecycle.hasManagedWorktree(task.worktree_id)) await this.lifecycle.cleanup(task.worktree_id);
    }
  }

  async childWorktreeReleased(descriptor: ParallelDispatchDescriptor): Promise<boolean> {
    const snapshot = await this.transaction((state) => {
      const run = state.run?.kind === "run" && state.run.run_id === descriptor.run_id ? state.run :
        state.archived.find((entry): entry is StoredRunArchive => entry.kind === "run" && entry.run.run_id === descriptor.run_id)?.run;
      const task = run?.tasks.find((entry) => entry.descriptor.dispatch_id === descriptor.dispatch_id);
      if (task === undefined || fingerprint(task.descriptor) !== fingerprint(descriptor)) {
        throw new ParallelDispatchError("descriptor-mismatch", "Child worktree identity changed.");
      }
      return { result: task.worktree_id, changed: false };
    });
    return !(await this.lifecycle.hasManagedWorktree(snapshot));
  }

  async cancel(ownerRoot: string, runID?: string): Promise<ParallelDispatchSnapshot | undefined> {
    if (!validText(ownerRoot, 256) || (runID !== undefined && (!validText(runID, 64) || !UUID.test(runID)))) {
      throw new ParallelDispatchError("descriptor-mismatch", "Parallel run identity is invalid.");
    }
    return this.withFabricOperationAuthority(async () => {
      await this.recoverWithAuthority();
      return this.transaction((state) => {
        if (state.run === null) {
          const archived = runID === undefined ? undefined : this.findRunArchive(state, ownerRoot, runID);
          return { result: archived === undefined ? undefined : this.publicSnapshot(archived.run, true, archived.terminal_reason), changed: false };
        }
        const run = this.requireRun(state, ownerRoot, runID);
        if (run.cancelled) return { result: this.publicSnapshot(run), changed: false };
        if (run.fabric !== null && run.fabric.review.status !== "pending" && !run.fabric.promoted) {
          throw new ParallelDispatchError("outcome-conflict", "A fabric review decision is already claimed.");
        }
        run.cancelled = true;
        for (const task of run.tasks) {
          if (task.phase === "pending" || task.phase === "reserved") {
            task.phase = "suppressed";
            task.outcome = "cancelled";
          }
        }
        return { result: this.archiveIfTerminal(state, run), changed: true };
      });
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

  /**
   * Observe the same read-only descriptor used by automatic recovery, or select a historical
   * accepted boundary for diagnosis. A diagnostic override never replaces the automatic record.
   */
  async inspectFabricWaveBoundaryReplay(
    ownerRoot: string,
    runID: string,
    boundaryEventHash?: string,
  ): Promise<FabricWaveBoundaryReplayRecord | undefined> {
    if (!validText(ownerRoot, 256) || !UUID.test(runID) ||
      (boundaryEventHash !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(boundaryEventHash))) {
      throw new ParallelDispatchError("invalid-contract", "Fabric replay inspection identity is invalid.");
    }
    const state = await this.load();
    const run = state.run?.kind === "run" && state.run.run_id === runID
      ? state.run
      : this.findRunArchive(state, ownerRoot, runID)?.run;
    if (run === undefined || run.owner_root !== ownerRoot) return undefined;
    const replay = this.reconstructFabricBoundary(run, boundaryEventHash);
    if (boundaryEventHash === undefined && replay !== undefined) this.automaticFabricReplays.set(runID, replay);
    return replay;
  }

  async archives(ownerRoot: string): Promise<readonly ParallelDispatchArchive[]> {
    await this.recoverWithAuthority();
    return this.transaction((state) => ({
      result: Object.freeze(state.archived.filter((entry) => this.archiveOwner(entry) === ownerRoot).map((entry) => this.publicArchive(entry))),
      changed: false,
    }));
  }

  /** Return one terminal run archive without exposing active or preparation state as an archive. */
  async archive(ownerRoot: string, runID: string): Promise<ParallelDispatchArchive | undefined> {
    if (!validText(ownerRoot, 256) || !validText(runID, 64) || !UUID.test(runID)) {
      throw new ParallelDispatchError("descriptor-mismatch", "Parallel run identity is invalid.");
    }
    await this.recoverWithAuthority();
    return this.transaction((state) => {
      const archive = this.findRunArchive(state, ownerRoot, runID);
      return { result: archive === undefined ? undefined : this.publicArchive(archive), changed: false };
    });
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
      const pending = run.fabric === null ? undefined : this.pendingFabricOutcomes.get(run.run_id);
      if (pending !== undefined) {
        for (const task of run.tasks) {
          const candidate = pending.get(task.descriptor.dispatch_id);
          if (task.phase !== "running" || candidate?.outcome === null || candidate?.outcome === undefined) continue;
          this.applyFabricOutcome(run, task, candidate);
          changed = true;
        }
      }
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
      const result = changed ? this.archiveIfTerminal(state, run) : this.publicSnapshot(run);
      if (changed && pending !== undefined) this.pendingFabricOutcomes.delete(run.run_id);
      return { result, changed };
    });
  }

  private fabricOutcome(runID: string, task: StoredTask): PendingFabricOutcome {
    let wave = this.pendingFabricOutcomes.get(runID);
    if (wave === undefined) {
      wave = new Map();
      this.pendingFabricOutcomes.set(runID, wave);
    }
    let pending = wave.get(task.descriptor.dispatch_id);
    if (pending === undefined) {
      pending = {
        owner_root: "",
        call_id: task.call_id!,
        child_session_id: task.child_session_id,
        descriptor: cloneDescriptor(task.descriptor),
        artifact: task.artifact === null ? null : cloneArtifact(task.artifact),
        outcome: null,
      };
      wave.set(task.descriptor.dispatch_id, pending);
    }
    return pending;
  }

  private applyFabricOutcome(run: StoredRun, task: StoredTask, pending: PendingFabricOutcome): void {
    if (pending.artifact !== null) {
      task.artifact = cloneArtifact(pending.artifact);
      task.artifact_accepted = true;
    }
    if (pending.child_session_id !== null) task.child_session_id = pending.child_session_id;
    task.outcome = pending.outcome;
    task.phase = pending.outcome === "completed" ? "completed" : "failed";
    if (task.phase === "failed") this.suppressDescendants(run, task.descriptor.task_id);
  }

  private async completeFabricCall(
    ownerRoot: string,
    callID: string,
    childSessionID: string | undefined,
    outcome: ParallelDispatchOutcome,
    claimed: ParallelDispatchClaim | undefined,
  ): Promise<{ handled: boolean; snapshot: ParallelDispatchSnapshot | undefined }> {
    const source = await this.load();
    const run = source.run?.kind === "run" && source.run.owner_root === ownerRoot ? source.run : undefined;
    const task = run?.tasks.find((entry) => entry.call_id === callID);
    if (run?.fabric === null || run === undefined || task === undefined || task.phase !== "running") {
      return { handled: false, snapshot: undefined };
    }
    const pending = this.fabricOutcome(run.run_id, task);
    if ((pending.owner_root !== "" && pending.owner_root !== ownerRoot) || pending.call_id !== callID ||
      (pending.child_session_id !== null && childSessionID !== undefined && pending.child_session_id !== childSessionID)) {
      throw new ParallelDispatchError("outcome-conflict", "A different terminal outcome was already recorded.");
    }
    pending.owner_root = ownerRoot;
    if (childSessionID !== undefined) pending.child_session_id = childSessionID;
    let effective = outcome;
    if (effective === "completed" && (claimed === undefined || claimed.run_id !== run.run_id ||
      claimed.dispatch_id !== task.descriptor.dispatch_id || childSessionID === undefined ||
      pending.child_session_id !== childSessionID || pending.artifact === null)) effective = "failed";
    if (pending.outcome !== null && pending.outcome !== effective) {
      throw new ParallelDispatchError("outcome-conflict", "A different terminal outcome was already recorded.");
    }
    pending.outcome = effective;
    const active = run.fabric.scheduler.active?.unit_ids ?? [];
    const wave = this.pendingFabricOutcomes.get(run.run_id)!;
    const ready = active.every((id) => {
      const activeTask = run.tasks.find((entry) => entry.descriptor.task_id === id);
      return activeTask !== undefined && (activeTask.phase !== "running" ||
        wave.get(activeTask.descriptor.dispatch_id)?.outcome !== null &&
        wave.get(activeTask.descriptor.dispatch_id)?.outcome !== undefined);
    });
    if (!ready) return { handled: true, snapshot: this.publicSnapshot(run) };
    const result = await this.transaction<{ handled: boolean; snapshot: ParallelDispatchSnapshot | undefined }>((state) => {
      const durableRun = this.requireRun(state, ownerRoot, run.run_id);
      if (durableRun.fabric === null) throw new ParallelDispatchError("outcome-conflict", "Fabric outcome changed before its wave barrier.");
      let changed = false;
      for (const id of active) {
        const activeTask = durableRun.tasks.find((entry) => entry.descriptor.task_id === id)!;
        const candidate = wave.get(activeTask.descriptor.dispatch_id);
        if (activeTask.phase === "running") {
          if (candidate?.outcome === null || candidate?.outcome === undefined || activeTask.call_id !== candidate.call_id ||
            fingerprint(activeTask.descriptor) !== fingerprint(candidate.descriptor)) {
            throw new ParallelDispatchError("outcome-conflict", "Fabric outcome changed before its wave barrier.");
          }
          this.applyFabricOutcome(durableRun, activeTask, candidate);
          changed = true;
        } else if (candidate !== undefined && (activeTask.outcome !== candidate.outcome ||
          activeTask.call_id !== candidate.call_id || fingerprint(activeTask.descriptor) !== fingerprint(candidate.descriptor) ||
          activeTask.child_session_id !== candidate.child_session_id ||
          (candidate.artifact !== null && (activeTask.artifact === null ||
            fingerprint(activeTask.artifact) !== fingerprint(candidate.artifact))))) {
          throw new ParallelDispatchError("outcome-conflict", "Fabric outcome changed before its wave barrier.");
        }
      }
      if (!changed) return { result: { handled: true, snapshot: this.publicSnapshot(durableRun) }, changed: false };
      this.reserveReady(durableRun);
      const snapshot = this.archiveIfTerminal(state, durableRun);
      return { result: { handled: true, snapshot }, changed: true };
    });
    this.pendingFabricOutcomes.delete(run.run_id);
    return result;
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
    const state = await this.load();
    if (state.run?.kind === "run") {
      const replay = this.reconstructFabricBoundary(state.run);
      if (replay !== undefined) this.automaticFabricReplays.set(state.run.run_id, replay);
    }
    if (state.run?.kind !== "preparing" && (state.run?.kind !== "run" || state.run.fabric === null ||
      (state.run.fabric.demotion_transition === null && state.run.fabric.transition === null))) return;
    await this.withPrepareAuthority(async () => {
      await this.recoverPreparation(undefined, true);
      await this.recoverFabricDemotion();
      await this.recoverFabricTransition();
    });
  }

  private reconstructFabricBoundary(
    run: StoredRun,
    boundaryEventHash?: string,
  ): FabricWaveBoundaryReplayRecord | undefined {
    if (run.fabric === null || run.execution_plan === null || run.plan_ledger === null) return undefined;
    let selected;
    try {
      selected = selectWaveBoundaryReplay(run.plan_ledger,
        boundaryEventHash === undefined ? undefined : { boundary_event_hash: boundaryEventHash });
    } catch (error) {
      if (error instanceof WaveBoundaryReplayError && error.code === "boundary_missing" && boundaryEventHash === undefined) {
        return undefined;
      }
      if (error instanceof WaveBoundaryReplayError && ["invalid_override", "unknown_override"].includes(error.code)) {
        throw new ParallelDispatchError("invalid-contract", error.message);
      }
      throw new ParallelDispatchError("corrupt-state", "Accepted fabric replay ledger is invalid.");
    }
    const boundary = selected.boundary;
    if (!("event_kind" in boundary) || boundary.event_kind !== "fabric.wave.accepted" ||
      boundary.plan_id !== run.execution_plan.plan_id || boundary.plan_binding_id !== run.execution_plan.binding_id) {
      throw new ParallelDispatchError("corrupt-state", "Accepted fabric replay boundary conflicts with its execution plan.");
    }
    if (boundaryEventHash === undefined) {
      const scheduler = run.fabric.transition?.scheduler ?? run.fabric.scheduler;
      if (fingerprint(boundary.scheduler_after) !== fingerprint(scheduler) ||
        boundary.candidate_snapshot.authority_sha !== run.fabric.authority_sha ||
        boundary.candidate_snapshot.target_branch !== run.fabric.target_branch ||
        boundary.candidate_snapshot.candidate_ref !== run.fabric.candidate_ref ||
        boundary.candidate_snapshot.candidate_head !== run.fabric.candidate_head ||
        fingerprint(boundary.candidate_snapshot.wave_heads) !== fingerprint(run.fabric.wave_heads)) {
        throw new ParallelDispatchError("corrupt-state", "Latest accepted fabric replay boundary conflicts with durable candidate state.");
      }
    }
    return structuredClone({
      reason: selected.reason,
      boundary_event_hash: boundary.event_hash,
      route: "luna-fabric" as const,
      plan: run.execution_plan,
      plan_decisions: selected.state.plan_decisions,
      scheduler: boundary.scheduler_after,
      artifacts: boundary.artifacts,
      candidate_snapshot: boundary.candidate_snapshot,
      recovery_budget: selected.recovery_budget,
    });
  }

  private async recoverFabricDemotion(expectedRunID?: string): Promise<void> {
    const recovery = await this.transaction((state) => {
      const run = state.run;
      if (run?.kind !== "run" || run.fabric?.demotion_transition === null || run.fabric === null) {
        return { result: undefined, changed: false };
      }
      if (expectedRunID !== undefined && run.run_id !== expectedRunID) {
        throw new ParallelDispatchError("active-run", "Another durable fabric demotion is active.");
      }
      return { result: { run_id: run.run_id, owner_root: run.owner_root, fabric: run.fabric,
        transition: run.fabric.demotion_transition }, changed: false };
    });
    if (recovery === undefined) return;
    if (recovery.transition.phase === "stopping") return;
    await this.assertFabricAuthority(recovery.fabric);
    for (const source of recovery.fabric.source_refs) {
      const current = await this.readRef(source.ref);
      if (current === undefined) await this.git(["update-ref", source.ref, source.commit, ""]);
      else if (current !== source.commit) throw new ParallelDispatchError("candidate-invalid", "Fabric source ref changed.");
    }
    for (const worktreeID of recovery.transition.cleanup_worktree_ids) {
      if (await this.lifecycle.hasManagedWorktree(worktreeID)) {
        try { await this.lifecycle.cleanup(worktreeID); }
        catch { throw new ParallelDispatchError("lifecycle-failed", "Completed sibling cleanup blocked Sol demotion."); }
      }
    }
    if (await this.lifecycle.hasManagedWorktree(recovery.transition.failed_worktree_id)) {
      await this.lifecycle.cleanup(recovery.transition.failed_worktree_id).catch(() => undefined);
    }
    await this.transaction((state) => {
      const run = this.requireRun(state, recovery.owner_root, recovery.run_id);
      if (run.fabric?.demotion_transition === null || run.fabric === null) {
        throw new ParallelDispatchError("outcome-conflict", "Fabric demotion changed during cleanup.");
      }
      run.fabric.demotion_transition.phase = "creating";
      return { result: undefined, changed: true };
    });
    const task = recovery.transition.task;
    const inventory = await this.lifecycle.reconcile().catch(() => undefined);
    const match = inventory?.find((entry) => entry.identity === task.lifecycle_identity &&
      entry.branch === task.branch && entry.baseSha === task.base_sha);
    let managed: ManagedWorktree;
    if (match?.phase === "ready") managed = match;
    else if (match === undefined) {
      try {
        [managed] = await this.lifecycle.createManyAtBase({
          authority: { repositoryRoot: this.repositoryRoot, sha: recovery.fabric.authority_sha },
          baseSha: task.base_sha,
          tasks: [{ task_id: task.task_id, worktree: task.worktree_id, branch: task.branch,
            base_sha: task.base_sha, depends_on: [...task.depends_on],
            scope: { read: [...task.scope_read], write: [...task.scope_write] } }],
        });
      } catch {
        throw new ParallelDispatchError("lifecycle-failed", "Fresh Sol demotion worktree could not be prepared.");
      }
    } else throw new ParallelDispatchError("lifecycle-failed", "Sol demotion worktree is ambiguous.");
    await this.transaction((state) => {
      const run = this.requireRun(state, recovery.owner_root, recovery.run_id);
      const transition = run.fabric?.demotion_transition;
      const failed = run.tasks.find((entry) => entry.descriptor.task_id === task.task_id);
      if (run.fabric === null || transition === null || transition === undefined || failed === undefined || failed.phase !== "failed" ||
        transition.task.dispatch_id !== task.dispatch_id) {
        throw new ParallelDispatchError("outcome-conflict", "Fabric demotion changed during worktree creation.");
      }
      const lunaDispatchID = failed.descriptor.dispatch_id;
      const lunaWorktreeID = failed.worktree_id;
      failed.worktree_id = task.worktree_id;
      failed.descriptor = cloneDescriptor({ ...failed.descriptor, dispatch_id: task.dispatch_id,
        managed_path: managed.path, branch: task.branch, base_sha: task.base_sha, attempt: 2 });
      failed.phase = "pending"; failed.call_id = null; failed.child_session_id = null;
      failed.outcome = null; failed.artifact = null; failed.artifact_accepted = false;
      run.fabric.demotions.push({ unit_id: task.task_id, luna_dispatch_id: lunaDispatchID,
        luna_worktree_id: lunaWorktreeID, sol_dispatch_id: task.dispatch_id, trigger: transition.trigger });
      run.fabric.demotion_transition = null;
      this.reserveReady(run);
      return { result: undefined, changed: true };
    });
  }

  private async assertFabricCandidate(
    fabric: StoredFabric,
    runID: string,
    contractFingerprint: string,
    candidateBase: string,
    tasks: readonly StoredTask[],
    builtCandidate?: BuiltFabricCandidate,
  ): Promise<void> {
    try {
      await this.assertFabricAuthority(fabric);
      const candidate = (await this.git(["rev-parse", "--verify", `${candidateBase}^{commit}`])).trim();
      let expected: string;
      if (builtCandidate === undefined) {
        expected = await this.buildFabricCandidate(runID, fabric.scheduler.base_sha, tasks);
      } else {
        const current = this.builtFabricCandidate(
          runID, contractFingerprint, fabric, tasks, candidateBase,
        );
        if (fingerprint(current) !== fingerprint(builtCandidate)) throw new Error("built-candidate-identity");
        expected = builtCandidate.candidate_head;
      }
      if (candidate !== candidateBase || candidateBase !== expected || candidateBase === fabric.scheduler.base_sha ||
        await this.readRef(fabric.candidate_ref) !== candidateBase) throw new Error("identity");
      await this.git(["merge-base", "--is-ancestor", fabric.authority_sha, candidateBase]);
    } catch {
      throw new ParallelDispatchError("candidate-invalid", "Candidate does not contain the completed wave or target authority changed.");
    }
  }

  private builtFabricCandidate(
    runID: string,
    contractFingerprint: string,
    fabric: StoredFabric,
    tasks: readonly StoredTask[],
    candidateHead: string,
  ): BuiltFabricCandidate {
    return {
      run_id: runID,
      candidate_base: fabric.scheduler.base_sha,
      candidate_head: candidateHead,
      fabric_identity: fingerprint({
        authority_sha: fabric.authority_sha,
        target_branch: fabric.target_branch,
        candidate_ref: fabric.candidate_ref,
        contract_fingerprint: contractFingerprint,
        scheduler: fabric.scheduler,
      }),
      artifact_identity: fingerprint(tasks.map((task) => ({
        task_id: task.descriptor.task_id,
        base_sha: task.descriptor.base_sha,
        scope_write: task.descriptor.scope_write,
        artifact: task.artifact,
      }))),
    };
  }

  private async buildFabricCandidate(
    runID: string,
    base: string,
    tasks: readonly StoredTask[],
  ): Promise<string> {
    if (tasks.length === 0) return base;
    let head = base;
    const indexPath = join(this.stateRoot, `.fabric-index-${randomUUID()}`);
    const indexEnvironment = this.cleanGitEnvironment({ GIT_INDEX_FILE: indexPath });
    try {
      // Commit objects are immutable; collect their timestamps once for this build only.
      const commits = [...new Set(tasks.map((task) => task.artifact!.commit_sha))];
      const metadata = (await this.gitBuffer([
        "show", "-s", "--no-walk=unsorted", "--format=%H%x00%ct", ...commits, "--",
      ])).toString("utf8").trimEnd();
      const timestamps = new Map<string, string>();
      for (const line of metadata.split(/\r?\n/u)) {
        const fields = line.split("\0");
        if (fields.length !== 2 || !SHA.test(fields[0]!) || !/^\d{1,12}$/u.test(fields[1]!) || timestamps.has(fields[0]!)) {
          throw new Error("identity");
        }
        timestamps.set(fields[0]!, fields[1]!);
      }
      if (timestamps.size !== commits.length || commits.some((commit) => !timestamps.has(commit))) throw new Error("identity");
      await this.gitBuffer(["read-tree", base], indexEnvironment);
      for (const task of tasks) {
        const artifact = task.artifact!;
        const nonce = randomUUID();
        const patchPath = join(this.stateRoot, `.fabric-patch-${nonce}`);
        const messagePath = join(this.stateRoot, `.fabric-message-${nonce}`);
        try {
          const patch = await this.gitBuffer([
            "diff-tree", "-p", "--binary", "--full-index", "--no-ext-diff", "--no-renames",
            artifact.base_sha, artifact.commit_sha, "--",
          ]);
          if (patch.byteLength > 8 * 1024 * 1024) {
            throw new ParallelDispatchError("wave-integration-failed", "Fabric artifact patch exceeds the practical bound.");
          }
          await writeFile(patchPath, patch, { flag: "wx", mode: 0o600 });
          await this.gitBuffer(["apply", "--cached", "--3way", "--binary", patchPath], indexEnvironment);
          const tree = (await this.gitBuffer(["write-tree"], indexEnvironment)).toString("utf8").trim();
          const timestamp = timestamps.get(artifact.commit_sha);
          if (!SHA.test(tree) || timestamp === undefined) throw new Error("identity");
          const message = `Sortie fabric integration: ${task.descriptor.task_id}\n\n` +
            `Sortie-Run: ${runID}\nSortie-Task: ${task.descriptor.task_id}\n` +
            `Sortie-Artifact: ${artifact.commit_sha}\nSortie-Base: ${artifact.base_sha}\n`;
          await writeFile(messagePath, message, { flag: "wx", mode: 0o600 });
          const commitEnvironment = this.cleanGitEnvironment({
            GIT_AUTHOR_NAME: "Sortie Fabric",
            GIT_AUTHOR_EMAIL: "sortie@example.invalid",
            GIT_COMMITTER_NAME: "Sortie Fabric",
            GIT_COMMITTER_EMAIL: "sortie@example.invalid",
            GIT_AUTHOR_DATE: `${timestamp} +0000`,
            GIT_COMMITTER_DATE: `${timestamp} +0000`,
          });
          const commit = (await this.gitBuffer(["commit-tree", tree, "-p", head, "-F", messagePath], commitEnvironment))
            .toString("utf8").trim();
          if (!SHA.test(commit)) throw new Error("commit");
          head = commit;
        } finally {
          await Promise.all([patchPath, messagePath].map((path) => rm(path, { force: true }).catch(() => undefined)));
        }
      }
      return head;
    } catch (error) {
      if (error instanceof ParallelDispatchError) throw error;
      throw new ParallelDispatchError("wave-integration-failed", "Fabric artifact could not be applied to the hidden candidate.");
    } finally {
      await Promise.all([indexPath, `${indexPath}.lock`].map((path) => rm(path, { force: true }).catch(() => undefined)));
    }
  }

  private cleanGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^GIT_/iu.test(key)) delete environment[key];
    return { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
  }

  private gitBuffer(args: readonly string[], environment = this.cleanGitEnvironment(), cwd = this.repositoryRoot): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => execFile(this.gitPath, [...args], {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      timeout: 30_000,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error === null) resolvePromise(stdout);
      else reject(error);
    }));
  }

  private async assertFabricAuthority(fabric: StoredFabric): Promise<void> {
    await this.git(["check-ref-format", `refs/heads/${fabric.target_branch}`]);
    const target = (await this.git(["rev-parse", "--verify", `refs/heads/${fabric.target_branch}^{commit}`])).trim();
    let authority;
    try {
      authority = await this.lifecycle.pinCleanBase();
    } catch (error) {
      if (error instanceof WorktreeLifecycleError && error.code === "dirty-tree") {
        throw new ParallelDispatchError("dirty-tree", "Primary checkout is dirty.");
      }
      throw error;
    }
    if (target !== fabric.authority_sha || authority.sha !== fabric.authority_sha) {
      throw new ParallelDispatchError("candidate-invalid", "Fabric target authority changed.");
    }
  }

  private async recoverFabricTransition(
    expectedRunID?: string,
    builtCandidate?: BuiltFabricCandidate,
  ): Promise<void> {
    const recovery = await this.transaction((state) => {
      const run = state.run;
      if (run?.kind !== "run") {
        return { result: undefined, changed: false };
      }
      const fabric = run.fabric;
      if (fabric === null || fabric.transition === null) return { result: undefined, changed: false };
      if (expectedRunID !== undefined && run.run_id !== expectedRunID) {
        throw new ParallelDispatchError("active-run", "Another durable parallel run owns fabric recovery.");
      }
      const transition = fabric.transition;
      const tasks = transition.completed_unit_ids.map((id) =>
        run.tasks.find((task) => task.descriptor.task_id === id));
      if (tasks.some((task) => task?.artifact === null || task === undefined)) {
        throw new ParallelDispatchError("corrupt-state", "Fabric transition lost wave artifacts.");
      }
      return { result: {
        run_id: run.run_id,
        owner_root: run.owner_root,
        contract_fingerprint: run.contract_fingerprint,
        fabric,
        transition,
        tasks: tasks as StoredTask[],
      }, changed: false };
    });
    if (recovery === undefined) return;
    await this.assertFabricCandidate(
      recovery.fabric,
      recovery.run_id,
      recovery.contract_fingerprint,
      recovery.transition.candidate_base,
      recovery.tasks,
      builtCandidate,
    );

    for (const worktreeID of recovery.transition.cleanup_worktree_ids) {
      try {
        if (await this.lifecycle.hasManagedWorktree(worktreeID)) await this.lifecycle.cleanup(worktreeID);
      } catch {
        throw new ParallelDispatchError("lifecycle-failed", "Completed fabric wave cleanup is incomplete.");
      }
    }
    await this.transaction((state) => {
      const run = this.requireRun(state, recovery.owner_root, recovery.run_id);
      if (run.fabric === null || run.fabric.transition === null ||
        fingerprint(run.fabric.transition) !== fingerprint(recovery.transition)) {
        throw new ParallelDispatchError("outcome-conflict", "Fabric transition changed during cleanup.");
      }
      if (run.fabric.transition.phase === "cleanup") run.fabric.transition.phase = "creating";
      return { result: undefined, changed: run.fabric.transition.phase !== recovery.transition.phase };
    });

    const planned = recovery.transition.tasks;
    let managed: readonly ManagedWorktree[] = [];
    if (planned.length > 0) {
      const inventory = await this.lifecycle.reconcile().catch(() => undefined);
      if (inventory === undefined) throw new ParallelDispatchError("lifecycle-failed", "Fabric worktree inventory is unavailable.");
      const matches = planned.map((task) => inventory.find((entry) => entry.identity === task.lifecycle_identity &&
        entry.branch === task.branch && entry.baseSha === task.base_sha));
      if (matches.every((entry) => entry !== undefined && entry.phase === "ready")) {
        managed = matches as ManagedWorktree[];
      } else if (matches.every((entry) => entry === undefined)) {
        try {
          managed = await this.lifecycle.createManyAtBase({
            authority: { repositoryRoot: this.repositoryRoot, sha: recovery.fabric.authority_sha },
            baseSha: recovery.transition.candidate_base,
            tasks: planned.map((task) => ({
              task_id: task.task_id,
              worktree: task.worktree_id,
              branch: task.branch,
              base_sha: task.base_sha,
              depends_on: [...task.depends_on],
              scope: { read: [...task.scope_read], write: [...task.scope_write] },
            })),
          });
        } catch {
          throw new ParallelDispatchError("lifecycle-failed", "Fresh fabric wave worktrees could not be prepared.");
        }
      } else {
        throw new ParallelDispatchError("lifecycle-failed", "Fabric transition has partial or mismatched worktrees.");
      }
    }

    await this.transaction((state) => {
      const run = this.requireRun(state, recovery.owner_root, recovery.run_id);
      if (run.fabric === null || run.fabric.transition === null ||
        run.fabric.transition.candidate_base !== recovery.transition.candidate_base ||
        fingerprint(run.fabric.transition.tasks) !== fingerprint(planned)) {
        throw new ParallelDispatchError("outcome-conflict", "Fabric transition changed during worktree creation.");
      }
      const transition = run.fabric.transition;
      for (const [index, task] of transition.tasks.entries()) {
        run.tasks.push({
          worktree_id: task.worktree_id,
          descriptor: cloneDescriptor({
            run_id: run.run_id,
            dispatch_id: task.dispatch_id,
            task_id: task.task_id,
            managed_path: managed[index]!.path,
            branch: task.branch,
            base_sha: task.base_sha,
            depends_on: [...task.depends_on],
            scope_read: [...task.scope_read],
            scope_write: [...task.scope_write],
            parallel_group: run.run_id,
            parallel_unit: task.task_id,
            parallel_units: transition.tasks.length,
            attempt: 1,
            contract_fingerprint: run.contract_fingerprint,
          }),
          phase: "pending",
          call_id: null,
          child_session_id: null,
          outcome: null,
          artifact: null,
          artifact_accepted: false,
        });
      }
      run.fabric.scheduler = transition.scheduler;
      run.fabric.transition = null;
      if (transition.tasks.length > 0) run.max_workers = transition.tasks.length;
      this.reserveReady(run);
      return { result: this.archiveIfTerminal(state, run), changed: true };
    });
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
    if (preparation.fabric !== null) await this.ensureCandidateRef(preparation.fabric);
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
      const tasks = this.contractTasks(preparation);
      if (preparation.fabric === null) {
        await this.lifecycle.createMany({
          pin: { repositoryRoot: this.repositoryRoot, sha: preparation.tasks[0]!.base_sha },
          tasks,
        });
      } else {
        await this.lifecycle.createManyAtBase({
          authority: { repositoryRoot: this.repositoryRoot, sha: preparation.fabric.authority_sha },
          baseSha: preparation.tasks[0]!.base_sha,
          tasks,
        });
      }
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
      route: preparation.route,
      max_workers: preparation.max_workers,
      cancelled: false,
      fabric: preparation.fabric,
      execution_plan: preparation.execution_plan,
      plan_ledger: preparation.plan_ledger,
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
        artifact: null,
        artifact_accepted: false,
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
    const fabricActive = run.fabric === null
      ? undefined
      : new Set(run.fabric.scheduler.active?.unit_ids ?? []);
    for (const task of run.tasks) {
      if (available <= 0) break;
      const ready = fabricActive === undefined
        ? task.descriptor.depends_on.every((dependency) =>
          run.tasks.find((candidate) => candidate.descriptor.task_id === dependency)?.phase === "completed")
        : fabricActive.has(task.descriptor.task_id);
      if (task.phase === "pending" && ready) {
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
    if (!run.cancelled && run.fabric !== null && run.fabric.scheduler.active !== null &&
      run.tasks.some(({ phase, descriptor }) => phase === "failed" && descriptor.attempt === 1 &&
        run.fabric!.scheduler.active!.unit_ids.includes(descriptor.task_id))) {
      return this.publicSnapshot(run);
    }
    if (!run.cancelled && run.fabric !== null && run.fabric.transition === null &&
      run.tasks.every(({ phase }) => phase === "completed")) {
      if (run.fabric.scheduler.pending.length > 0 || (!run.fabric.promoted &&
        run.fabric.validation.status !== "fail" && run.fabric.review.status !== "fail")) {
        return this.publicSnapshot(run);
      }
    }
    const fabricFailed = run.fabric !== null && (run.fabric.validation.status === "fail" || run.fabric.review.status === "fail");
    const terminalReason = run.cancelled ? "cancelled" : !fabricFailed && run.tasks.every(({ phase }) => phase === "completed")
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
      depends_on: Object.freeze([...task.descriptor.depends_on]),
      worktree_id: task.worktree_id,
      managed_path: task.descriptor.managed_path,
      branch: task.descriptor.branch,
      base_sha: task.descriptor.base_sha,
      dispatch_id: task.descriptor.dispatch_id,
      phase: task.phase,
      call_id: task.call_id,
      child_session_id: task.child_session_id,
      outcome: task.outcome,
      artifact: task.artifact === null ? null : cloneArtifact(task.artifact),
    })) : archive.preparation.tasks.map((task, index) => ({
      task_id: task.task_id,
      depends_on: Object.freeze([...task.depends_on]),
      worktree_id: task.worktree_id,
      managed_path: archive.inventory[index]?.managed_path ?? null,
      branch: task.branch,
      base_sha: task.base_sha,
      dispatch_id: task.dispatch_id,
      phase: "abandoned" as const,
      call_id: null,
      child_session_id: null,
      outcome: null,
      artifact: null,
    }));
    const fabric = source.fabric === null ? undefined : this.publicFabric(source.fabric);
    return Object.freeze({
      run_id: source.run_id,
      owner_root: source.owner_root,
      contract_fingerprint: source.contract_fingerprint,
      route: source.route,
      cancelled: archive.kind === "run" ? archive.run.cancelled : false,
      terminal_reason: archive.terminal_reason,
      tasks: Object.freeze(tasks.map((task) => Object.freeze(task))),
      ...(fabric === undefined ? {} : { fabric }),
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
      artifact: task.artifact === null ? null : cloneArtifact(task.artifact),
    }));
    const fabric = run.fabric === null ? undefined : this.publicFabric(run.fabric);
    return Object.freeze({
      run_id: run.run_id,
      owner_root: run.owner_root,
      project_root: run.project_root,
      contract_fingerprint: run.contract_fingerprint,
      route: run.route,
      max_workers: run.max_workers,
      cancelled: run.cancelled,
      archived,
      terminal_reason: terminalReason,
      tasks: Object.freeze(tasks),
      ready: Object.freeze(tasks.filter(({ phase }) => phase === "reserved").map(({ descriptor }) => descriptor)),
      ...(fabric === undefined ? {} : { fabric }),
    });
  }

  private publicFabric(fabric: StoredFabric): NonNullable<ParallelDispatchSnapshot["fabric"]> {
    const active = fabric.scheduler.active;
    return Object.freeze({
      total_units: fabric.contract.units.length,
      wave: fabric.scheduler.wave,
      base_sha: fabric.scheduler.base_sha,
      pending_unit_ids: Object.freeze([...fabric.scheduler.pending]),
      completed_unit_ids: Object.freeze([...fabric.scheduler.completed]),
      active_unit_ids: Object.freeze([...(active?.unit_ids ?? [])]),
      unit_acceptance: Object.freeze(Object.fromEntries(fabric.contract.units.map((unit) => [
        unit.unit_id,
        Object.freeze([...unit.acceptance_items]),
      ]))),
      lanes: Object.freeze({ ...(active?.lanes ?? {}) }),
      transition: fabric.transition?.phase ?? (fabric.demotion_transition?.phase === "stopping"
        ? "cleanup" : fabric.demotion_transition?.phase) ?? null,
      candidate_ref: fabric.candidate_ref,
      candidate_head: fabric.candidate_head,
      wave_heads: Object.freeze([...fabric.wave_heads]),
      validation: Object.freeze({ command: Object.freeze([...fabric.validation.command]),
        status: fabric.validation.status, fingerprint: fabric.validation.fingerprint }),
      review: Object.freeze({ ...fabric.review }),
      promoted: fabric.promoted,
      demotions: Object.freeze(fabric.demotions.map((entry) => Object.freeze({
        unit_id: entry.unit_id,
        luna_dispatch_id: entry.luna_dispatch_id,
        luna_worktree_id: entry.luna_worktree_id,
        sol_dispatch_id: entry.sol_dispatch_id,
      }))),
    });
  }

  private async load(): Promise<State> {
    try {
      const source = await readFile(this.statePath);
      if (source.byteLength > MAX_STATE_BYTES) throw new Error("oversized");
      return parseState(JSON.parse(source.toString("utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 5, revision: 0, run: null, archived: [] };
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

  // Heartbeats retain live ownership. A crashed CLI must not leave a lease whose expiry exceeds
  // the next CLI's acquisition budget; keep room for mutex acquisition and filesystem latency.
  private async acquire(scope = STATE_SCOPE, ttlMs = Math.floor(LOCK_TIMEOUT_MS / 2)): Promise<ScopeLease> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        return await this.registry.acquire({
          ownerId: `parallel-dispatch:${process.pid}:${randomUUID()}`,
          scope,
          ttlMs,
        });
      } catch (error) {
        if (!(error instanceof ScopeLeaseError) ||
          (error.code !== "scope-conflict" && error.code !== "lock-timeout") || Date.now() >= deadline) {
          throw new ParallelDispatchError("state-locked", "Parallel state authority could not be acquired.");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
  }

  private async git(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await promisify(execFile)(this.gitPath, [...args], {
        cwd: this.repositoryRoot,
        shell: false,
        windowsHide: true,
        timeout: 30_000,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch {
      throw new ParallelDispatchError("candidate-invalid", "Fabric Git identity check failed.");
    }
  }

  private async readRef(ref: string): Promise<string | undefined> {
    try {
      const { stdout } = await promisify(execFile)(this.gitPath, ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: this.repositoryRoot, shell: false, windowsHide: true, timeout: 30_000, encoding: "utf8",
      });
      const value = stdout.trim();
      return SHA.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async targetCheckedOut(targetRef: string): Promise<boolean> {
    const output = (await this.gitBuffer(["worktree", "list", "--porcelain", "-z"])).toString("utf8");
    return output.split("\0").some((field) => field === `branch ${targetRef}`);
  }

  private async deleteFabricSourceRefs(fabric: StoredFabric): Promise<void> {
    for (const source of fabric.source_refs) {
      if (await this.readRef(source.ref) === source.commit) {
        await this.git(["update-ref", "-d", source.ref, source.commit]);
      }
    }
  }

  private async ensureCandidateRef(fabric: StoredFabric): Promise<void> {
    await this.assertFabricAuthority(fabric);
    const existing = await this.readRef(fabric.candidate_ref);
    if (existing === fabric.candidate_head) return;
    if (existing !== undefined) throw new ParallelDispatchError("corrupt-state", "Hidden candidate ref has unexpected identity.");
    try {
      await this.git(["update-ref", fabric.candidate_ref, fabric.candidate_head, ""]);
    } catch {
      if (await this.readRef(fabric.candidate_ref) !== fabric.candidate_head) {
        throw new ParallelDispatchError("corrupt-state", "Hidden candidate ref creation conflicted.");
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

  private async withFabricOperationAuthority<T>(operation: (lease: ScopeLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(FABRIC_OPERATION_SCOPE, 30_000);
    let failure: unknown;
    let result: T | undefined;
    try { result = await operation(lease); } catch (error) { failure = error; }
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
