import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EvidenceCapsuleStore } from "./evidence-capsule.js";
import type { AcceptanceCompileGapCode, AcceptanceCompileResult } from "./acceptance-compiler.js";
import { LUNA_FABRIC_MAX_ACTIVE } from "./luna-fabric-scheduler.js";
import { normalizeRelativePath } from "./path.js";
import { CHILD_TERMINAL_EVIDENCE_FIELDS, isChildTerminalIdentity, reconcileChildTerminal, sameChildTerminalIdentity,
  type ChildTerminalIdentity, type ChildTerminalEvidence, type ChildTerminalDisposition } from "./child-terminal-reconciliation.js";
import type { TerminalRescueAcceptedBase } from "./terminal-rescue-policy.js";
import { validationEvidenceState, type ValidationBudgetRequest, type ValidationBudgetDecision, type ValidationOutcome, type ValidationScope } from "./validation-budget.js";
import { GOAL_BOUND_SCHEMA_VERSION, GoalBoundError, reduceGoalFlight, goalFingerprint, validGoalEvidence,
  type GoalEvidence, type GoalFlightEvent, type GoalFlightEventRecord, type GoalFlightState,
  type GoalValidationRetryAuthorization } from "./goal-bound.js";

export const RUN_FLIGHT_LEDGER_SCHEMA_VERSION = "0.1" as const;
export const MAX_RUN_FLIGHT_EVENTS = 2048;
export const MAX_RUN_FLIGHT_LEDGER_BYTES = 1024 * 1024;

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_TEXT = 256;

export type FlightRole = "implementation" | "review" | "advice" | "rescue";
export type RecoveryKind = "normal_remediation" | "adaptive_probe" | "read_only_diagnosis" | "model_rescue";
export type FailureCategory = "infrastructure" | "authorization" | "contract" | "cancellation" | "implementation";
export type TerminalDisposition = "continue" | "succeeded" | "failed" | "cancelled";
export type FlightStage = "planning" | "route" | "unit" | "wave" | "candidate" | "cleanup" | "recovery";

export interface FlightBudgetLimits {
  readonly recovery_actions: number;
  readonly probe_iterations: number;
  readonly model_attempts: number;
}

export interface FlightBudgetCharge extends FlightBudgetLimits {
  readonly kind: "implementation" | RecoveryKind;
}

export interface FlightResourceBudget {
  readonly time_ms: number;
  readonly cost_usd: number;
}

export interface FlightResourceUsage {
  readonly time_ms: number | null;
  readonly cost_usd: number | null;
}

export interface FlightReferenceSet {
  readonly capsule_ids: readonly string[];
  readonly artifact_ids: readonly string[];
}

export interface FlightObservation {
  readonly stage: FlightStage;
  readonly duration_ms: number | null;
  readonly usage: {
    readonly input_tokens: number | null;
    readonly cache_read_tokens: number | null;
    readonly output_tokens: number | null;
    readonly provenance: "measured" | "provider_estimate" | "unknown";
  };
  readonly estimated_cost: {
    readonly usd: number | null;
    readonly provenance: "provider_estimate" | "calculated" | "unknown";
  };
}

export interface FabricWaveArtifactEvidence {
  readonly unit_id: string;
  readonly commit_sha: string;
  readonly change_fingerprint: string;
  readonly validation_fingerprint: string;
}

export interface FabricWaveSchedulerEvidence {
  readonly wave: number;
  readonly base_sha: string;
  readonly pending: readonly string[];
  readonly completed: readonly string[];
  readonly active: { readonly number: number; readonly base_sha: string; readonly unit_ids: readonly string[];
    readonly lanes: Readonly<Record<string, number>> } | null;
  readonly lane_affinity: Readonly<Record<string, number>>;
}

export interface FabricCandidateSnapshotEvidence {
  readonly authority_sha: string;
  readonly target_branch: string;
  readonly candidate_ref: string;
  readonly candidate_head: string;
  readonly wave_heads: readonly string[];
}

interface EventBase { readonly at: string; }

export interface ChildFlightState {
  readonly identity: ChildTerminalIdentity;
  readonly deadline_ms: number;
  readonly stop_trigger: "deadline_expired" | "explicit_cancellation" | null;
  readonly terminal: { readonly disposition: ChildTerminalDisposition; readonly fingerprint: string } | null;
}

export interface DiagnosisLane {
  readonly lane_id: string;
  readonly diagnosis_id: string;
  readonly causal_class: string;
}
export interface DiagnosisSelection {
  readonly diagnosis_id: string;
  readonly capsule_id: string;
  readonly contract_id: string;
  readonly recovery_kind: Exclude<RecoveryKind, "read_only_diagnosis">;
  readonly proposal: string;
  readonly budget_request: FlightBudgetCharge;
}
export interface DiagnosisFlightState {
  readonly owner_root: string;
  readonly run_id: string;
  readonly swarm_id: string;
  readonly request_fingerprint: string;
  readonly unit_id: string;
  readonly failed_attempt_id: string;
  readonly candidate_id: string;
  readonly plan_id: string;
  readonly plan_binding_id: string;
  readonly source_capsule_id: string;
  readonly source_paths: readonly string[];
  readonly deadline_ms: number;
  readonly lanes: readonly DiagnosisLane[];
  readonly budget_charge: FlightBudgetCharge;
  readonly per_lane_resource_budget?: FlightResourceBudget;
  readonly dispatched: Readonly<Record<string, string>>;
  readonly findings: Readonly<Record<string, { capsule_id: string | null; verdict: "supported" | "excluded" | "unknown" }>>;
  readonly selection: DiagnosisSelection | null;
  readonly executed_attempt_id: string | null;
}

export type RunFlightEvent =
  | (EventBase & { readonly kind: "diagnosis.opened"; readonly swarm_id: string; readonly request_fingerprint: string; readonly owner_root: string;
      readonly unit_id: string; readonly failed_attempt_id: string; readonly candidate_id: string;
      readonly plan_id: string; readonly plan_binding_id: string; readonly source_capsule_id: string;
      readonly source_paths: readonly string[]; readonly deadline_ms: number; readonly lanes: readonly DiagnosisLane[];
      readonly budget_charge: FlightBudgetCharge; readonly per_lane_resource_budget?: FlightResourceBudget })
  | (EventBase & { readonly kind: "diagnosis.dispatched"; readonly swarm_id: string; readonly lane_id: string; readonly call_id: string })
  | (EventBase & { readonly kind: "diagnosis.finished"; readonly swarm_id: string; readonly lane_id: string;
      readonly capsule_id: string | null; readonly verdict: "supported" | "excluded" | "unknown"; readonly observation: FlightObservation })
  | (EventBase & { readonly kind: "diagnosis.selected"; readonly swarm_id: string; readonly selection: DiagnosisSelection })
  | (EventBase & { readonly kind: "child.registered"; readonly identity: ChildTerminalIdentity; readonly deadline_ms: number })
  | (EventBase & { readonly kind: "child.stop-requested"; readonly identity: ChildTerminalIdentity; readonly trigger: "deadline_expired" | "explicit_cancellation" })
  | (EventBase & { readonly kind: "child.terminal"; readonly identity: ChildTerminalIdentity; readonly disposition: ChildTerminalDisposition; readonly evidence: ChildTerminalEvidence })
  | (EventBase & { readonly kind: "run.planned"; readonly run_id: string; readonly initial_candidate_id: string; readonly budget_limits: FlightBudgetLimits; readonly resource_budget_limits?: FlightResourceBudget })
  | (EventBase & { readonly kind: "plan.compiled"; readonly plan_id: string; readonly proposal_id: string; readonly decision: "accepted" | "rejected"; readonly gap_codes: readonly AcceptanceCompileGapCode[] })
  | (EventBase & { readonly kind: "fabric.wave.accepted"; readonly plan_id: string; readonly plan_binding_id: string;
      readonly wave_index: number; readonly from_candidate_id: string; readonly candidate_id: string;
      readonly artifacts: readonly FabricWaveArtifactEvidence[]; readonly scheduler_before: FabricWaveSchedulerEvidence;
      readonly scheduler_after: FabricWaveSchedulerEvidence; readonly candidate_snapshot: FabricCandidateSnapshotEvidence })
  | (EventBase & { readonly kind: "route.selected"; readonly route_id: string; readonly candidate_id: string; readonly role: FlightRole; readonly model: string; readonly variant: string | null; readonly reason: "planning" | "implementation" | RecoveryKind })
  | (EventBase & { readonly kind: "wave.opened"; readonly wave_id: string; readonly wave_index: number; readonly candidate_id: string })
  | (EventBase & { readonly kind: "unit.opened"; readonly unit_id: string; readonly wave_id: string; readonly candidate_id: string; readonly references: FlightReferenceSet })
  | (EventBase & { readonly kind: "attempt.started"; readonly attempt_id: string; readonly predecessor_attempt_id: string | null; readonly unit_id: string; readonly candidate_id: string; readonly route_id: string; readonly role: FlightRole; readonly selected_model: string; readonly selected_variant: string | null; readonly child_id: string | null; readonly call_id: string; readonly budget_charge: FlightBudgetCharge; readonly resource_budget_request?: FlightResourceBudget; readonly remediation_contract_id?: string; readonly terminal_rescue_contract?: TerminalRescueAcceptedBase })
  | (EventBase & { readonly kind: "attempt.finished"; readonly attempt_id: string; readonly observed_model: string | null; readonly observed_variant: string | null; readonly failure: { readonly category: FailureCategory; readonly code: string } | null; readonly disposition: TerminalDisposition; readonly observation: FlightObservation; readonly references: FlightReferenceSet })
  | (EventBase & { readonly kind: "recovery.recorded"; readonly recovery_id: string; readonly failed_attempt_id: string; readonly kind_detail: RecoveryKind; readonly candidate_id: string })
   | (EventBase & { readonly kind: "validation.recorded"; readonly validation_id: string; readonly unit_id: string; readonly command_fingerprint: string; readonly result: "passed" | "failed"; readonly artifact_id: string | null })
   | (EventBase & { readonly kind: "validation.admission"; readonly reservation_id: string; readonly operation_id: string; readonly evidence_key: string; readonly scope: ValidationScope | null; readonly decision: "ALLOW" | "SKIP" | "DENY"; readonly reason: string; readonly consumed: number; readonly limit: number; readonly saved_ms?: number })
  | (EventBase & { readonly kind: "validation.settled"; readonly reservation_id: string; readonly operation_id: string; readonly evidence_key: string; readonly outcome: ValidationOutcome; readonly exit_code: number | null; readonly evidence_fingerprint?: string; readonly duration_ms?: number; readonly reason?: string })
  | (EventBase & { readonly kind: "unit.completed"; readonly unit_id: string; readonly disposition: "succeeded" | "failed" })
  | (EventBase & { readonly kind: "wave.completed"; readonly wave_id: string; readonly produced_candidate_id: string; readonly artifact_id: string })
  | (EventBase & { readonly kind: "candidate.advanced"; readonly from_candidate_id: string; readonly candidate_id: string; readonly wave_id: string; readonly artifact_id: string })
  | (EventBase & { readonly kind: "candidate.completed"; readonly candidate_id: string; readonly references: FlightReferenceSet })
  | (EventBase & { readonly kind: "cleanup.completed"; readonly run_id: string; readonly observation: FlightObservation })
  | (EventBase & { readonly kind: "run.completed"; readonly run_id: string; readonly disposition: "succeeded" | "failed" | "cancelled" });

export type RunPlannedFlightEvent = Extract<RunFlightEvent, { readonly kind: "run.planned" }>;
export type PlanCompiledFlightEvent = Extract<RunFlightEvent, { readonly kind: "plan.compiled" }>;

export interface RunFlightLedgerInitialPrefixInput {
  readonly run_planned: RunPlannedFlightEvent;
  readonly plan_compiled: PlanCompiledFlightEvent;
}

export interface RunFlightEventRecord {
  readonly sequence: number;
  readonly previous_hash: string | null;
  readonly event_hash: string;
  readonly event: RunFlightEvent;
}

export interface RunFlightState {
  readonly diagnoses: readonly DiagnosisFlightState[];
  readonly children: readonly ChildFlightState[];
  readonly run_id: string | null;
  readonly current_candidate_id: string | null;
  readonly active_wave_id: string | null;
  readonly active_unit_id: string | null;
  readonly active_attempt_id: string | null;
  readonly last_attempt_id: string | null;
  readonly completed_wave_count: number;
  readonly budget_limits: FlightBudgetLimits | null;
  readonly budget_consumed: FlightBudgetLimits;
  readonly resource_budget_limits: FlightResourceBudget | null;
  readonly resource_budget_consumed: FlightResourceUsage;
  readonly resource_budget_reserved: FlightResourceUsage;
  readonly child_counts: Readonly<Record<FlightRole, number>>;
  readonly validation_reruns: number;
  readonly validation_budget: { readonly consumed: number; readonly reservations: number; readonly limit: number | null;
    readonly completed: number; readonly skipped: number; readonly rejected: number; readonly redundant_time_ms: number };
  readonly observations: readonly FlightObservation[];
  readonly terminal_disposition: "succeeded" | "failed" | "cancelled" | null;
  readonly plan_decisions: readonly { readonly plan_id: string; readonly proposal_id: string; readonly decision: "accepted" | "rejected"; readonly gap_codes: readonly AcceptanceCompileGapCode[] }[];
  readonly accepted_fabric_waves: readonly Extract<RunFlightEvent, { readonly kind: "fabric.wave.accepted" }>[];
}

export type RunFlightLedgerErrorCode = "invalid" | "capacity" | "sequence" | "transition" | "budget" | "conflict";

export class RunFlightLedgerError extends Error {
  readonly code: RunFlightLedgerErrorCode;
  constructor(code: RunFlightLedgerErrorCode, message: string) {
    super(message);
    this.name = "RunFlightLedgerError";
    this.code = code;
  }
}

export interface ValidationSkipReconciliation {
  readonly unit_id: string;
  readonly source: string;
  readonly candidate: string;
  readonly command: readonly string[];
  readonly evidence: readonly GoalEvidence[];
}

export interface RunFlightEvidenceAccess {
  readonly store: EvidenceCapsuleStore;
  readonly declared_capsule_ids: readonly string[];
  readonly authorized_source_paths: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const enumValue = (value: unknown, values: readonly string[]): value is string => typeof value === "string" && values.includes(value);
const hash = (value: unknown): value is string => typeof value === "string" && HASH_PATTERN.test(value);
const GAP_CODES: readonly AcceptanceCompileGapCode[] = ["malformed_proposal", "duplicate_acceptance_id", "duplicate_unit_id", "duplicate_validation_id", "duplicate_coverage", "unknown_acceptance_id", "unknown_unit_id", "unknown_validation_id", "validation_unit_mismatch", "undeclared_capsule", "validation_evidence_missing", "uncovered_acceptance"];
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const PLAIN_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : isObject(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

function validRescueContract(value: unknown): boolean {
  return isObject(value) && only(value, ["candidate_id", "contract_id", "scope", "acceptance", "validation"]) &&
    text(value.candidate_id) && text(value.contract_id) && [value.scope, value.acceptance, value.validation]
      .every((items) => Array.isArray(items) && items.length > 0 && items.every(text));
}

function recordHash(sequence: number, previousHash: string | null, event: unknown): string {
  return `sha256:${createHash("sha256").update(canonical({ sequence, previous_hash: previousHash, event })).digest("hex")}`;
}

export function diagnosisContractHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function validDiagnosisPaths(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 || new Set(value).size !== value.length) return false;
  try { return value.every((entry) => typeof entry === "string" && entry.length <= 512 && normalizeRelativePath(entry) === entry); }
  catch { return false; }
}

function validDiagnosisSelection(value: unknown): value is DiagnosisSelection {
  return isObject(value) && only(value, ["diagnosis_id", "capsule_id", "contract_id", "recovery_kind", "proposal", "budget_request"]) &&
    text(value.diagnosis_id) && hash(value.capsule_id) && hash(value.contract_id) &&
    typeof value.proposal === "string" && value.proposal.length > 0 && value.proposal.length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(value.proposal) &&
    validCharge(value.budget_request) && value.budget_request.kind === value.recovery_kind &&
    enumValue(value.recovery_kind, ["normal_remediation", "adaptive_probe", "model_rescue"]);
}

function validBudget(value: unknown): value is FlightBudgetLimits {
  return isObject(value) && only(value, ["recovery_actions", "probe_iterations", "model_attempts"]) &&
    integer(value.recovery_actions) && integer(value.probe_iterations) && integer(value.model_attempts);
}

function validCharge(value: unknown): value is FlightBudgetCharge {
  return isObject(value) && only(value, ["kind", "recovery_actions", "probe_iterations", "model_attempts"]) &&
    enumValue(value.kind, ["implementation", "normal_remediation", "adaptive_probe", "read_only_diagnosis", "model_rescue"]) &&
    integer(value.recovery_actions) && integer(value.probe_iterations) && integer(value.model_attempts) &&
    (value.kind === "implementation" || Number(value.recovery_actions) > 0);
}

function validResourceBudget(value: unknown): value is FlightResourceBudget {
  return isObject(value) && only(value, ["time_ms", "cost_usd"]) && integer(value.time_ms) &&
    typeof value.cost_usd === "number" && Number.isFinite(value.cost_usd) && value.cost_usd >= 0;
}

function addResources(left: FlightResourceUsage, right: FlightResourceUsage): FlightResourceUsage {
  const time = left.time_ms === null || right.time_ms === null ? null : left.time_ms + right.time_ms;
  const cost = left.cost_usd === null || right.cost_usd === null ? null : left.cost_usd + right.cost_usd;
  return { time_ms: time !== null && Number.isSafeInteger(time) ? time : null,
    cost_usd: cost !== null && Number.isFinite(cost) ? cost : null };
}

function reservedResources(state: MutableState): FlightResourceUsage {
  return [...state.resource_reservations.values()].reduce<FlightResourceUsage>(addResources, { time_ms: 0, cost_usd: 0 });
}

function validReferences(value: unknown): value is FlightReferenceSet {
  return isObject(value) && only(value, ["capsule_ids", "artifact_ids"]) && Array.isArray(value.capsule_ids) && Array.isArray(value.artifact_ids) &&
    value.capsule_ids.length <= 64 && value.artifact_ids.length <= 64 && value.capsule_ids.every(hash) && value.artifact_ids.every(hash) &&
    new Set(value.capsule_ids).size === value.capsule_ids.length && new Set(value.artifact_ids).size === value.artifact_ids.length;
}

function validObservation(value: unknown): value is FlightObservation {
  if (!isObject(value) || !only(value, ["stage", "duration_ms", "usage", "estimated_cost"]) ||
    !enumValue(value.stage, ["planning", "route", "unit", "wave", "candidate", "cleanup", "recovery"]) ||
    !(value.duration_ms === null || integer(value.duration_ms)) || !isObject(value.usage) || !isObject(value.estimated_cost)) return false;
  const usage = value.usage;
  const cost = value.estimated_cost;
  return only(usage, ["input_tokens", "cache_read_tokens", "output_tokens", "provenance"]) &&
    [usage.input_tokens, usage.cache_read_tokens, usage.output_tokens].every((entry) => entry === null || integer(entry)) &&
    enumValue(usage.provenance, ["measured", "provider_estimate", "unknown"]) &&
    only(cost, ["usd", "provenance"]) && (cost.usd === null || (typeof cost.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0)) &&
    enumValue(cost.provenance, ["provider_estimate", "calculated", "unknown"]) &&
    (usage.provenance !== "unknown" || [usage.input_tokens, usage.cache_read_tokens, usage.output_tokens].every((entry) => entry === null)) &&
    (cost.provenance !== "unknown" || cost.usd === null);
}

function validFabricScheduler(value: unknown): value is FabricWaveSchedulerEvidence {
  if (!isObject(value) || !only(value, ["wave", "base_sha", "pending", "completed", "active", "lane_affinity"]) ||
    !integer(value.wave) || typeof value.base_sha !== "string" || !SHA_PATTERN.test(value.base_sha) ||
    !Array.isArray(value.pending) || !Array.isArray(value.completed)) return false;
  const pending = value.pending;
  const completed = value.completed;
  if (!pending.every(text) || !completed.every(text) ||
    new Set(pending).size !== pending.length || new Set(completed).size !== completed.length ||
    pending.some((id) => completed.includes(id)) || !isObject(value.lane_affinity) ||
    Object.keys(value.lane_affinity).some((key) => !text(key)) ||
    Object.values(value.lane_affinity).some((lane) => !integer(lane) || Number(lane) >= LUNA_FABRIC_MAX_ACTIVE)) return false;
  if (value.active === null) return true;
  return isObject(value.active) && only(value.active, ["number", "base_sha", "unit_ids", "lanes"]) &&
    integer(value.active.number) && value.active.number === value.wave && typeof value.active.base_sha === "string" &&
    SHA_PATTERN.test(value.active.base_sha) && value.active.base_sha === value.base_sha && Array.isArray(value.active.unit_ids) &&
    value.active.unit_ids.length > 0 && value.active.unit_ids.length <= LUNA_FABRIC_MAX_ACTIVE && value.active.unit_ids.every(text) &&
    new Set(value.active.unit_ids).size === value.active.unit_ids.length && value.active.unit_ids.every((id) => pending.includes(id)) &&
    isObject(value.active.lanes) && only(value.active.lanes, value.active.unit_ids) &&
    Object.values(value.active.lanes).every((lane) => integer(lane) && Number(lane) < LUNA_FABRIC_MAX_ACTIVE) &&
    new Set(Object.values(value.active.lanes)).size === value.active.unit_ids.length;
}

function validFabricWaveEvent(value: Record<string, unknown>, base: readonly string[]): boolean {
  if (!only(value, [...base, "plan_id", "plan_binding_id", "wave_index", "from_candidate_id", "candidate_id", "artifacts",
    "scheduler_before", "scheduler_after", "candidate_snapshot"]) || !hash(value.plan_id) || !hash(value.plan_binding_id) ||
    !integer(value.wave_index) || Number(value.wave_index) < 1 || typeof value.from_candidate_id !== "string" ||
    !SHA_PATTERN.test(value.from_candidate_id) || typeof value.candidate_id !== "string" || !SHA_PATTERN.test(value.candidate_id) ||
    value.from_candidate_id === value.candidate_id || !validFabricScheduler(value.scheduler_before) ||
    !validFabricScheduler(value.scheduler_after) || !Array.isArray(value.artifacts) || value.artifacts.length === 0 ||
    value.artifacts.length > LUNA_FABRIC_MAX_ACTIVE) return false;
  const artifacts = value.artifacts;
  if (!artifacts.every((artifact) => isObject(artifact) && only(artifact, ["unit_id", "commit_sha", "change_fingerprint", "validation_fingerprint"]) &&
    text(artifact.unit_id) && typeof artifact.commit_sha === "string" && SHA_PATTERN.test(artifact.commit_sha) &&
    typeof artifact.change_fingerprint === "string" && PLAIN_HASH_PATTERN.test(artifact.change_fingerprint) &&
    typeof artifact.validation_fingerprint === "string" && PLAIN_HASH_PATTERN.test(artifact.validation_fingerprint)) ||
    new Set(artifacts.map((artifact) => (artifact as FabricWaveArtifactEvidence).unit_id)).size !== artifacts.length) return false;
  const before = value.scheduler_before;
  const after = value.scheduler_after;
  if (before.active === null || before.active.number !== value.wave_index || before.base_sha !== value.from_candidate_id ||
    after.base_sha !== value.candidate_id || artifacts.map((artifact) => (artifact as FabricWaveArtifactEvidence).unit_id).join("\0") !== before.active.unit_ids.join("\0") ||
    before.active.unit_ids.some((id) => !after.completed.includes(id)) || before.active.unit_ids.some((id) => after.pending.includes(id))) return false;
  const snapshot = value.candidate_snapshot;
  return isObject(snapshot) && only(snapshot, ["authority_sha", "target_branch", "candidate_ref", "candidate_head", "wave_heads"]) &&
    typeof snapshot.authority_sha === "string" && SHA_PATTERN.test(snapshot.authority_sha) && text(snapshot.target_branch) &&
    text(snapshot.candidate_ref) && typeof snapshot.candidate_head === "string" && snapshot.candidate_head === value.candidate_id &&
    Array.isArray(snapshot.wave_heads) && snapshot.wave_heads.length === value.wave_index && snapshot.wave_heads.every((head) =>
      typeof head === "string" && SHA_PATTERN.test(head)) && new Set(snapshot.wave_heads).size === snapshot.wave_heads.length &&
    snapshot.wave_heads.at(-1) === value.candidate_id;
}

function validEvent(value: unknown): value is RunFlightEvent {
  if (!isObject(value) || !text(value.kind) || !text(value.at) || Number.isNaN(Date.parse(value.at))) return false;
  const base = ["kind", "at"];
  switch (value.kind) {
    case "diagnosis.opened": return only(value, [...base, "swarm_id", "request_fingerprint", "owner_root", "unit_id", "failed_attempt_id", "candidate_id",
      "plan_id", "plan_binding_id", "source_capsule_id", "source_paths", "deadline_ms", "lanes", "budget_charge", "per_lane_resource_budget"]) &&
      hash(value.swarm_id) && hash(value.request_fingerprint) && text(value.owner_root) && text(value.unit_id) && text(value.failed_attempt_id) && text(value.candidate_id) &&
      hash(value.plan_id) && hash(value.plan_binding_id) && hash(value.source_capsule_id) && validDiagnosisPaths(value.source_paths) && integer(value.deadline_ms) &&
      Array.isArray(value.lanes) && value.lanes.length > 0 && value.lanes.length <= LUNA_FABRIC_MAX_ACTIVE &&
      value.lanes.every((lane) => isObject(lane) && only(lane, ["lane_id", "diagnosis_id", "causal_class"]) && text(lane.lane_id) && hash(lane.diagnosis_id) &&
        typeof lane.causal_class === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(lane.causal_class)) &&
      validCharge(value.budget_charge) && value.budget_charge.kind === "read_only_diagnosis" &&
      value.budget_charge.recovery_actions >= value.lanes.length && value.budget_charge.model_attempts >= value.lanes.length &&
      (!Object.hasOwn(value, "per_lane_resource_budget") || validResourceBudget(value.per_lane_resource_budget));
    case "diagnosis.dispatched": return only(value, [...base, "swarm_id", "lane_id", "call_id"]) && hash(value.swarm_id) && text(value.lane_id) && text(value.call_id);
    case "diagnosis.finished": return only(value, [...base, "swarm_id", "lane_id", "capsule_id", "verdict", "observation"]) &&
      hash(value.swarm_id) && text(value.lane_id) && (value.capsule_id === null || hash(value.capsule_id)) &&
      enumValue(value.verdict, ["supported", "excluded", "unknown"]) && (value.capsule_id !== null || value.verdict === "unknown") &&
      validObservation(value.observation) && value.observation.stage === "recovery";
    case "diagnosis.selected": return only(value, [...base, "swarm_id", "selection"]) && hash(value.swarm_id) && validDiagnosisSelection(value.selection);
    case "child.registered": return only(value, [...base, "identity", "deadline_ms"]) && isChildTerminalIdentity(value.identity) && integer(value.deadline_ms);
    case "child.stop-requested": return only(value, [...base, "identity", "trigger"]) && isChildTerminalIdentity(value.identity) && enumValue(value.trigger, ["deadline_expired", "explicit_cancellation"]);
    case "child.terminal": return only(value, [...base, "identity", "disposition", "evidence"]) &&
      isObject(value.evidence) && only(value.evidence, CHILD_TERMINAL_EVIDENCE_FIELDS) &&
      isChildTerminalIdentity(value.identity) && reconcileChildTerminal({ current: value.identity,
        observation: { identity: value.identity, disposition: value.disposition }, evidence: value.evidence }).status === "ready";
    case "run.planned": return only(value, [...base, "run_id", "initial_candidate_id", "budget_limits", "resource_budget_limits"]) && text(value.run_id) && text(value.initial_candidate_id) && validBudget(value.budget_limits) && (!Object.hasOwn(value, "resource_budget_limits") || validResourceBudget(value.resource_budget_limits));
    case "plan.compiled": return only(value, [...base, "plan_id", "proposal_id", "decision", "gap_codes"]) && hash(value.plan_id) && hash(value.proposal_id) && enumValue(value.decision, ["accepted", "rejected"]) && Array.isArray(value.gap_codes) && value.gap_codes.length <= 128 && value.gap_codes.every((code) => enumValue(code, GAP_CODES)) && new Set(value.gap_codes).size === value.gap_codes.length && ((value.decision === "accepted" && value.gap_codes.length === 0) || (value.decision === "rejected" && value.gap_codes.length > 0));
    case "fabric.wave.accepted": return validFabricWaveEvent(value, base);
    case "route.selected": return only(value, [...base, "route_id", "candidate_id", "role", "model", "variant", "reason"]) && text(value.route_id) && text(value.candidate_id) && enumValue(value.role, ["implementation", "review", "advice", "rescue"]) && text(value.model) && nullableText(value.variant) && enumValue(value.reason, ["planning", "implementation", "normal_remediation", "adaptive_probe", "read_only_diagnosis", "model_rescue"]);
    case "wave.opened": return only(value, [...base, "wave_id", "wave_index", "candidate_id"]) && text(value.wave_id) && Number.isInteger(value.wave_index) && Number(value.wave_index) >= 1 && text(value.candidate_id);
    case "unit.opened": return only(value, [...base, "unit_id", "wave_id", "candidate_id", "references"]) && text(value.unit_id) && text(value.wave_id) && text(value.candidate_id) && validReferences(value.references);
    case "attempt.started": return only(value, [...base, "attempt_id", "predecessor_attempt_id", "unit_id", "candidate_id", "route_id", "role", "selected_model", "selected_variant", "child_id", "call_id", "budget_charge", "resource_budget_request", "remediation_contract_id", "terminal_rescue_contract"]) && text(value.attempt_id) && nullableText(value.predecessor_attempt_id) && text(value.unit_id) && text(value.candidate_id) && text(value.route_id) && enumValue(value.role, ["implementation", "review", "advice", "rescue"]) && text(value.selected_model) && nullableText(value.selected_variant) && nullableText(value.child_id) && text(value.call_id) && validCharge(value.budget_charge) && (!Object.hasOwn(value, "resource_budget_request") || validResourceBudget(value.resource_budget_request)) && (!Object.hasOwn(value, "remediation_contract_id") || hash(value.remediation_contract_id)) && (!Object.hasOwn(value, "terminal_rescue_contract") || validRescueContract(value.terminal_rescue_contract));
    case "attempt.finished": {
      if (!only(value, [...base, "attempt_id", "observed_model", "observed_variant", "failure", "disposition", "observation", "references"]) || !text(value.attempt_id) || !nullableText(value.observed_model) || !nullableText(value.observed_variant) || !enumValue(value.disposition, ["continue", "succeeded", "failed", "cancelled"]) || !validObservation(value.observation) || !validReferences(value.references)) return false;
      const failure = value.failure;
      return (failure === null && value.disposition === "succeeded") || (isObject(failure) && only(failure, ["category", "code"]) && enumValue(failure.category, ["infrastructure", "authorization", "contract", "cancellation", "implementation"]) && text(failure.code) && value.disposition !== "succeeded");
    }
    case "recovery.recorded": return only(value, [...base, "recovery_id", "failed_attempt_id", "kind_detail", "candidate_id"]) && text(value.recovery_id) && text(value.failed_attempt_id) && enumValue(value.kind_detail, ["normal_remediation", "adaptive_probe", "read_only_diagnosis", "model_rescue"]) && text(value.candidate_id);
    case "validation.recorded": return only(value, [...base, "validation_id", "unit_id", "command_fingerprint", "result", "artifact_id"]) && text(value.validation_id) && text(value.unit_id) && hash(value.command_fingerprint) && enumValue(value.result, ["passed", "failed"]) && (value.artifact_id === null || hash(value.artifact_id));
    case "validation.admission": return only(value, [...base, "reservation_id", "operation_id", "evidence_key", "scope", "decision", "reason", "consumed", "limit", "saved_ms"]) && text(value.reservation_id) && text(value.operation_id) && hash(value.evidence_key) && (value.scope === null || enumValue(value.scope, ["static", "targeted", "related", "canonical", "full-suite", "full"])) && enumValue(value.decision, ["ALLOW", "SKIP", "DENY"]) && text(value.reason) && integer(value.consumed) && integer(value.limit) && value.limit > 0 && value.consumed <= value.limit && (!Object.hasOwn(value, "saved_ms") || integer(value.saved_ms)) && (value.decision === "ALLOW" ? value.scope !== null && value.consumed > 0 : value.consumed >= 0);
    case "validation.settled": return only(value, [...base, "reservation_id", "operation_id", "evidence_key", "outcome", "exit_code", "evidence_fingerprint", "duration_ms", "reason"]) && text(value.reservation_id) && text(value.operation_id) && hash(value.evidence_key) && enumValue(value.outcome, ["passed", "failed", "timeout", "interrupted", "cancelled"]) && (value.exit_code === null || Number.isSafeInteger(value.exit_code)) && (!Object.hasOwn(value, "evidence_fingerprint") || hash(value.evidence_fingerprint)) && (!Object.hasOwn(value, "duration_ms") || integer(value.duration_ms)) && (!Object.hasOwn(value, "reason") || text(value.reason));
    case "unit.completed": return only(value, [...base, "unit_id", "disposition"]) && text(value.unit_id) && enumValue(value.disposition, ["succeeded", "failed"]);
    case "wave.completed": return only(value, [...base, "wave_id", "produced_candidate_id", "artifact_id"]) && text(value.wave_id) && text(value.produced_candidate_id) && hash(value.artifact_id);
    case "candidate.advanced": return only(value, [...base, "from_candidate_id", "candidate_id", "wave_id", "artifact_id"]) && text(value.from_candidate_id) && text(value.candidate_id) && text(value.wave_id) && hash(value.artifact_id);
    case "candidate.completed": return only(value, [...base, "candidate_id", "references"]) && text(value.candidate_id) && validReferences(value.references);
    case "cleanup.completed": return only(value, [...base, "run_id", "observation"]) && text(value.run_id) && validObservation(value.observation) && value.observation.stage === "cleanup";
    case "run.completed": return only(value, [...base, "run_id", "disposition"]) && text(value.run_id) && enumValue(value.disposition, ["succeeded", "failed", "cancelled"]);
    default: return false;
  }
}

interface MutableState {
  diagnoses: Map<string, DiagnosisFlightState>;
  children: Map<string, ChildFlightState>;
  run_id: string | null; current_candidate_id: string | null; active_wave_id: string | null; active_wave_route_id: string | null;
  last_attempt_id: string | null; completed_wave_count: number; budget_limits: FlightBudgetLimits | null;
  budget_consumed: FlightBudgetLimits; child_counts: Record<FlightRole, number>; validation_reruns: number; observations: FlightObservation[];
  terminal_disposition: "succeeded" | "failed" | "cancelled" | null; current_route_id: string | null;
  pending_candidate: { from: string; to: string; wave: string; artifact: string } | null; candidate_completed: boolean; cleanup_completed: boolean;
  ids: Set<string>; validation_fingerprints: Set<string>; attempts: Map<string, string>; units: Map<string, MutableUnitState>;
  plan_decisions: { plan_id: string; proposal_id: string; decision: "accepted" | "rejected"; gap_codes: AcceptanceCompileGapCode[] }[]; plan_ids: Set<string>; accepted_plan: string | null;
  accepted_fabric_waves: Extract<RunFlightEvent, { readonly kind: "fabric.wave.accepted" }>[];
  resource_budget_limits: FlightResourceBudget | null;
  validation_consumed: number; validation_limit: number | null; validation_reservations: Set<string>; validation_reservation_evidence: Map<string, string>;
  validation_active_evidence: Set<string>; validation_evidence: Set<string>;
  validation_completed: number; validation_skipped: number; validation_rejected: number; redundant_validation_time_ms: number;
  resource_budget_consumed: FlightResourceUsage;
  resource_reservations: Map<string, FlightResourceUsage>;
}

interface MutableUnitState {
  last_started: Extract<RunFlightEvent, { kind: "attempt.started" }> | null;
  last_failure: FailureCategory | null;
  rescue_used: boolean;
  last_recovery_kind: "implementation" | RecoveryKind | null;
  last_validation: "passed" | "failed" | null;
  wave_id: string;
  active_attempt_id: string | null;
  last_attempt_id: string | null;
  initial_predecessor_id: string | null;
  last_failed_attempt_id: string | null;
  last_disposition: TerminalDisposition | null;
  completed_disposition: "succeeded" | "failed" | null;
  budget_consumed: FlightBudgetLimits;
}

function initialState(): MutableState {
  return { run_id: null, current_candidate_id: null, active_wave_id: null, active_wave_route_id: null,
    last_attempt_id: null, completed_wave_count: 0, budget_limits: null, budget_consumed: { recovery_actions: 0, probe_iterations: 0, model_attempts: 0 },
    child_counts: { implementation: 0, review: 0, advice: 0, rescue: 0 }, validation_reruns: 0, observations: [], terminal_disposition: null,
    current_route_id: null, pending_candidate: null, candidate_completed: false, cleanup_completed: false,
    ids: new Set(), validation_fingerprints: new Set(), attempts: new Map(), units: new Map(), plan_decisions: [], plan_ids: new Set(), accepted_plan: null, accepted_fabric_waves: [],
     resource_budget_limits: null, resource_budget_consumed: { time_ms: 0, cost_usd: 0 }, resource_reservations: new Map(), children: new Map(), diagnoses: new Map(),
      validation_consumed: 0, validation_limit: null, validation_reservations: new Set(), validation_reservation_evidence: new Map(),
      validation_active_evidence: new Set(), validation_evidence: new Set(),
     validation_completed: 0, validation_skipped: 0, validation_rejected: 0, redundant_validation_time_ms: 0 };
}

function claim(state: MutableState, id: string): void {
  if (state.ids.has(id)) throw new RunFlightLedgerError("transition", `Duplicate durable identity: ${id}`);
  state.ids.add(id);
}

function requireTransition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RunFlightLedgerError("transition", message);
}

function chargeRecoveryBudget(state: MutableState, charge: FlightBudgetCharge): void {
  requireTransition(state.budget_limits !== null, "Recovery budget is not configured.");
  const next = { recovery_actions: state.budget_consumed.recovery_actions + charge.recovery_actions,
    probe_iterations: state.budget_consumed.probe_iterations + charge.probe_iterations,
    model_attempts: state.budget_consumed.model_attempts + charge.model_attempts };
  if (!Object.values(next).every(integer) || (Object.keys(next) as (keyof FlightBudgetLimits)[]).some((key) => next[key] > state.budget_limits![key])) {
    throw new RunFlightLedgerError("budget", "Cumulative recovery budget exceeded.");
  }
  state.budget_consumed = next;
}

function reserveResourceBudget(state: MutableState, key: string, request?: FlightResourceBudget): void {
  const reservation = request ?? { time_ms: null, cost_usd: null };
  if (state.resource_budget_limits !== null) {
    const total = addResources(addResources(state.resource_budget_consumed, reservedResources(state)), reservation);
    if (total.time_ms === null || total.cost_usd === null || total.time_ms > state.resource_budget_limits.time_ms ||
      total.cost_usd > state.resource_budget_limits.cost_usd) throw new RunFlightLedgerError("budget", "Cumulative time or cost budget is unknown or exhausted.");
  }
  state.resource_reservations.set(key, reservation);
}

function applyEvent(state: MutableState, event: RunFlightEvent): void {
  requireTransition(state.terminal_disposition === null, "No event may follow run completion.");
  switch (event.kind) {
    case "diagnosis.opened": {
      const unit = state.units.get(event.unit_id);
      requireTransition(unit !== undefined && unit.active_attempt_id === null && unit.completed_disposition === null &&
        unit.last_failed_attempt_id === event.failed_attempt_id && unit.last_recovery_kind === "normal_remediation" &&
        unit.last_validation === "failed" && event.candidate_id === state.current_candidate_id && state.accepted_plan === event.plan_id,
        "Diagnosis requires the current failed canonical validation after normal remediation.");
      requireTransition(![...state.diagnoses.values()].some((entry) => entry.failed_attempt_id === event.failed_attempt_id), "Attempt already diagnosed.");
      const reservedLanes = [...state.diagnoses.values()].reduce((count, entry) => count +
        entry.lanes.filter((lane) => !Object.hasOwn(entry.findings, lane.lane_id)).length, 0);
      requireTransition(reservedLanes + event.lanes.length <= LUNA_FABRIC_MAX_ACTIVE, "Diagnosis lane capacity exceeded.");
      for (const key of ["lane_id", "diagnosis_id", "causal_class"] as const) {
        requireTransition(new Set(event.lanes.map((lane) => lane[key])).size === event.lanes.length, "Diagnosis lanes must be distinct.");
      }
      claim(state, event.swarm_id);
      chargeRecoveryBudget(state, event.budget_charge);
      for (const lane of event.lanes) {
        claim(state, lane.diagnosis_id);
        reserveResourceBudget(state, `diagnosis:${lane.diagnosis_id}`, event.per_lane_resource_budget);
      }
      const { kind: _kind, at: _at, ...opened } = event;
      state.diagnoses.set(event.swarm_id, { ...opened, run_id: state.run_id!, dispatched: {}, findings: {}, selection: null, executed_attempt_id: null });
      break;
    }
    case "diagnosis.dispatched": {
      const swarm = state.diagnoses.get(event.swarm_id);
      requireTransition(swarm !== undefined && swarm.selection === null && swarm.lanes.some((lane) => lane.lane_id === event.lane_id) &&
        !Object.hasOwn(swarm.dispatched, event.lane_id) && !Object.values(swarm.dispatched).includes(event.call_id), "Diagnosis dispatch is invalid or duplicated.");
      state.diagnoses.set(event.swarm_id, { ...swarm, dispatched: { ...swarm.dispatched, [event.lane_id]: event.call_id } });
      break;
    }
    case "diagnosis.finished": {
      const swarm = state.diagnoses.get(event.swarm_id);
      const lane = swarm?.lanes.find((entry) => entry.lane_id === event.lane_id);
      requireTransition(swarm !== undefined && lane !== undefined && Object.hasOwn(swarm.dispatched, event.lane_id) &&
        !Object.hasOwn(swarm.findings, event.lane_id) && state.children.get(lane.diagnosis_id)?.terminal != null,
        "Diagnosis must finish once after child reconciliation.");
      state.resource_reservations.delete(`diagnosis:${lane.diagnosis_id}`);
      state.resource_budget_consumed = addResources(state.resource_budget_consumed, { time_ms: event.observation.duration_ms, cost_usd: event.observation.estimated_cost.usd });
      state.observations.push(event.observation);
      state.diagnoses.set(event.swarm_id, { ...swarm, findings: { ...swarm.findings, [event.lane_id]: { capsule_id: event.capsule_id, verdict: event.verdict } } });
      break;
    }
    case "diagnosis.selected": {
      const swarm = state.diagnoses.get(event.swarm_id);
      const lane = swarm?.lanes.find((entry) => entry.diagnosis_id === event.selection.diagnosis_id);
      const unit = swarm === undefined ? undefined : state.units.get(swarm.unit_id);
      requireTransition(swarm !== undefined && lane !== undefined && swarm.selection === null &&
        swarm.lanes.every((entry) => Object.hasOwn(swarm.findings, entry.lane_id)) &&
        swarm.findings[lane.lane_id]?.capsule_id === event.selection.capsule_id && swarm.findings[lane.lane_id]?.verdict === "supported" &&
        unit?.active_attempt_id === null && unit.last_failed_attempt_id === swarm.failed_attempt_id && swarm.candidate_id === state.current_candidate_id,
        "Only one supported diagnosis can authorize the current repair.");
      state.diagnoses.set(event.swarm_id, { ...swarm, selection: { ...event.selection } });
      break;
    }
    case "child.registered": {
      requireTransition((state.run_id === null || state.run_id === event.identity.run_id) &&
        [...state.children.values()].every((child) => child.identity.run_id === event.identity.run_id) &&
        !state.children.has(event.identity.attempt_id), "Child attempt is already registered or belongs to another run.");
      if ([...state.diagnoses.values()].some((entry) => entry.lanes.some((lane) => lane.diagnosis_id === event.identity.attempt_id))) {
        requireTransition(![...state.children.values()].some((entry) => entry.identity.child_id === event.identity.child_id), "Diagnosis requires a fresh child session.");
      }
      const attempt = state.units.get(event.identity.unit_id)?.last_started;
      if (attempt?.terminal_rescue_contract !== undefined && attempt.attempt_id === event.identity.attempt_id) {
        requireTransition(attempt.call_id === event.identity.call_id && attempt.candidate_id === event.identity.candidate_id &&
          attempt.route_id === event.identity.route_id && attempt.predecessor_attempt_id === event.identity.predecessor_attempt_id &&
          ![...state.children.values()].some((child) => child.identity.child_id === event.identity.child_id),
        "Terminal rescue child must match its reserved attempt and use a fresh session.");
        if (attempt.child_id === null) state.child_counts.rescue += 1;
      }
      state.children.set(event.identity.attempt_id, { identity: { ...event.identity }, deadline_ms: event.deadline_ms,
        stop_trigger: null, terminal: null });
      if ([...state.diagnoses.values()].some((entry) => entry.lanes.some((lane) => lane.diagnosis_id === event.identity.attempt_id))) state.child_counts.advice += 1;
      break;
    }
    case "child.stop-requested":
    case "child.terminal": {
      const child = state.children.get(event.identity.attempt_id);
      requireTransition(child !== undefined && child.terminal === null && sameChildTerminalIdentity(child.identity, event.identity),
        "Child lifecycle identity or terminal state changed.");
      if (event.kind === "child.stop-requested") {
        requireTransition(child.stop_trigger === null, "Child stop was already requested.");
        state.children.set(event.identity.attempt_id, { ...child, stop_trigger: event.trigger });
      } else {
        const terminal = reconcileChildTerminal({ current: child.identity,
          observation: { identity: event.identity, disposition: event.disposition }, evidence: event.evidence });
        requireTransition(terminal.status === "ready" && terminal.fingerprint !== null, "Child resources are not reconciled.");
        state.children.set(event.identity.attempt_id, { ...child,
          terminal: { disposition: event.disposition, fingerprint: terminal.fingerprint } });
      }
      break;
    }
    case "run.planned":
      requireTransition(state.run_id === null && [...state.children.values()].every((child) => child.identity.run_id === event.run_id), "run.planned must be the first and only planning event."); claim(state, event.run_id); claim(state, event.initial_candidate_id);
      state.run_id = event.run_id; state.current_candidate_id = event.initial_candidate_id; state.budget_limits = event.budget_limits;
      state.resource_budget_limits = event.resource_budget_limits ?? null; break;
    case "plan.compiled":
      requireTransition(state.active_wave_id === null && state.current_route_id === null && !state.plan_ids.has(event.plan_id) && state.accepted_plan === null, "Plan decision must be unique and precede routing.");
      state.plan_ids.add(event.plan_id); if (event.decision === "accepted") state.accepted_plan = event.plan_id;
      state.plan_decisions.push({ plan_id: event.plan_id, proposal_id: event.proposal_id, decision: event.decision, gap_codes: [...event.gap_codes] }); break;
    case "fabric.wave.accepted": {
      const previous = state.accepted_fabric_waves.at(-1);
      requireTransition(state.run_id === null && state.accepted_plan === event.plan_id &&
        event.wave_index === state.accepted_fabric_waves.length + 1 &&
        (previous === undefined ? event.candidate_snapshot.authority_sha === event.from_candidate_id :
          (previous.plan_binding_id === event.plan_binding_id &&
          previous.candidate_id === event.from_candidate_id && canonical(previous.scheduler_after) === canonical(event.scheduler_before) &&
          previous.candidate_snapshot.authority_sha === event.candidate_snapshot.authority_sha &&
          previous.candidate_snapshot.target_branch === event.candidate_snapshot.target_branch &&
          previous.candidate_snapshot.candidate_ref === event.candidate_snapshot.candidate_ref &&
          canonical([...previous.candidate_snapshot.wave_heads, event.candidate_id]) === canonical(event.candidate_snapshot.wave_heads))),
        "Accepted fabric wave is missing, reordered, or conflicts with its plan and candidate lineage.");
      state.accepted_fabric_waves.push(structuredClone(event));
      state.current_candidate_id = event.candidate_id;
      state.completed_wave_count += 1;
      break;
    }
    case "route.selected":
      requireTransition(state.run_id !== null && state.active_wave_id === null && !state.candidate_completed && event.candidate_id === state.current_candidate_id, "Route must target the current candidate between waves."); claim(state, event.route_id); state.current_route_id = event.route_id; break;
    case "wave.opened":
      requireTransition(state.current_route_id !== null && state.active_wave_id === null && state.pending_candidate === null && event.candidate_id === state.current_candidate_id && event.wave_index === state.completed_wave_count + 1, "Wave order or candidate is invalid."); claim(state, event.wave_id); state.active_wave_id = event.wave_id; state.active_wave_route_id = state.current_route_id; state.current_route_id = null; break;
    case "unit.opened": {
      requireTransition(state.active_wave_id === event.wave_id && event.candidate_id === state.current_candidate_id, "Unit must open in the active wave and candidate."); claim(state, event.unit_id);
      const openUnits = [...state.units.values()].filter((unit) => unit.completed_disposition === null);
      if (openUnits.length > 0) for (const unit of openUnits) if (unit.last_attempt_id === null) unit.initial_predecessor_id = null;
      state.units.set(event.unit_id, {
        last_recovery_kind: null, last_validation: null, last_started: null, last_failure: null, rescue_used: false,
        wave_id: event.wave_id, active_attempt_id: null, last_attempt_id: null,
        initial_predecessor_id: openUnits.length === 0 ? state.last_attempt_id : null,
        last_failed_attempt_id: null, last_disposition: null, completed_disposition: null,
        budget_consumed: { recovery_actions: 0, probe_iterations: 0, model_attempts: 0 },
      });
      break;
    }
    case "attempt.started": {
      const unit = state.units.get(event.unit_id);
      const expectedPredecessor = unit?.last_attempt_id ?? unit?.initial_predecessor_id ?? null;
      requireTransition(unit !== undefined && unit.completed_disposition === null && unit.active_attempt_id === null && event.candidate_id === state.current_candidate_id && event.predecessor_attempt_id === expectedPredecessor, "Attempt predecessor, unit, or candidate is invalid.");
      requireTransition(event.route_id === state.active_wave_route_id, "Attempt route does not match the active wave route."); claim(state, event.attempt_id);
      if (event.terminal_rescue_contract !== undefined) {
        const prior = unit.last_started;
        const child = prior === null ? undefined : state.children.get(prior.attempt_id);
        requireTransition(prior?.role === "implementation" && unit.last_recovery_kind === "normal_remediation" &&
          unit.last_disposition === "failed" && unit.last_failure === "implementation" && unit.last_validation === "failed" &&
          !unit.rescue_used && child?.terminal?.disposition === "failed" &&
          child.identity.run_id === state.run_id && child.identity.unit_id === event.unit_id &&
          child.identity.candidate_id === event.candidate_id && child.identity.route_id === event.route_id &&
          child.identity.call_id === prior.call_id && (prior.child_id === null || child.identity.child_id === prior.child_id),
        "Terminal rescue requires the reconciled failed normal remediation and canonical validation.");
        requireTransition(![...state.units.values()].some((other) => other.active_attempt_id !== null && other.last_started?.role === "rescue"),
          "Only one terminal rescue may be active in a run.");
        requireTransition(event.role === "rescue" && event.budget_charge.kind === "model_rescue" &&
          event.budget_charge.model_attempts > 0 && event.resource_budget_request !== undefined &&
          state.resource_budget_limits !== null && event.terminal_rescue_contract.candidate_id === event.candidate_id,
        "Terminal rescue must preserve its accepted candidate and reserve a measured resource budget.");
      }
      const selected = [...state.diagnoses.values()].find((entry) => entry.unit_id === event.unit_id && entry.failed_attempt_id === expectedPredecessor);
      if (selected !== undefined) {
        const directRescue = selected.selection === null && event.remediation_contract_id === undefined && event.budget_charge.kind === "model_rescue" &&
          selected.lanes.every((lane) => Object.hasOwn(selected.findings, lane.lane_id) && selected.findings[lane.lane_id]!.verdict !== "supported");
        if (!directRescue) {
          requireTransition(selected.selection !== null && selected.executed_attempt_id === null &&
            event.remediation_contract_id === selected.selection.contract_id &&
            canonical(event.budget_charge) === canonical(selected.selection.budget_request), "Repair is not the single authorized diagnosis selection.");
          state.diagnoses.set(selected.swarm_id, { ...selected, executed_attempt_id: event.attempt_id });
        }
      } else if (event.remediation_contract_id !== undefined) {
        throw new RunFlightLedgerError("transition", "Remediation contract does not belong to this predecessor.");
      }
      chargeRecoveryBudget(state, event.budget_charge);
      reserveResourceBudget(state, event.attempt_id, event.resource_budget_request);
      unit.last_recovery_kind = event.budget_charge.kind; unit.last_validation = null;
      unit.last_started = event;
      unit.rescue_used ||= event.budget_charge.kind === "model_rescue";
      unit.budget_consumed = { recovery_actions: unit.budget_consumed.recovery_actions + event.budget_charge.recovery_actions, probe_iterations: unit.budget_consumed.probe_iterations + event.budget_charge.probe_iterations, model_attempts: unit.budget_consumed.model_attempts + event.budget_charge.model_attempts };
      unit.active_attempt_id = event.attempt_id; unit.last_attempt_id = event.attempt_id; unit.last_disposition = null;
      state.last_attempt_id = event.attempt_id; state.attempts.set(event.attempt_id, event.unit_id);
      if (event.child_id !== null) state.child_counts[event.role] += 1;
      break;
    }
    case "attempt.finished": {
      const unitId = state.attempts.get(event.attempt_id);
      const unit = unitId === undefined ? undefined : state.units.get(unitId);
      requireTransition(unit !== undefined && unit.active_attempt_id === event.attempt_id, "Attempt finish does not match the active attempt.");
      if (unit.last_started?.terminal_rescue_contract !== undefined) {
        requireTransition(state.children.get(event.attempt_id)?.terminal?.disposition === event.disposition,
          "Terminal rescue cannot finish before its child and writer are reconciled.");
      }
      // Preserve actual overruns and missing measurements; only a subsequent attempt is denied.
      state.resource_reservations.delete(event.attempt_id);
      state.resource_budget_consumed = addResources(state.resource_budget_consumed, {
        time_ms: event.observation.duration_ms, cost_usd: event.observation.estimated_cost.usd,
      });
      unit.active_attempt_id = null; unit.last_failed_attempt_id = event.failure === null ? null : event.attempt_id; unit.last_disposition = event.disposition;
      unit.last_failure = event.failure?.category ?? null;
      state.observations.push(event.observation); break;
    }
    case "recovery.recorded": {
      const unitId = state.attempts.get(event.failed_attempt_id);
      const unit = unitId === undefined ? undefined : state.units.get(unitId);
      requireTransition(unit !== undefined && unit.last_failed_attempt_id === event.failed_attempt_id && unit.last_disposition === "continue" && event.candidate_id === state.current_candidate_id && unit.active_attempt_id === null, "Recovery must reference the latest continuable failed attempt and current candidate."); claim(state, event.recovery_id); break;
    }
    case "validation.recorded": {
      const unit = state.units.get(event.unit_id);
      requireTransition(unit !== undefined && unit.completed_disposition === null && unit.active_attempt_id === null, "Validation must belong to an open idle unit."); claim(state, event.validation_id);
      unit.last_validation = event.result;
      if (state.validation_fingerprints.has(event.command_fingerprint)) state.validation_reruns += 1; else state.validation_fingerprints.add(event.command_fingerprint); break;
    }
    case "validation.admission": {
      requireTransition(!state.validation_reservations.has(event.reservation_id), "Validation reservation is duplicated.");
      if (event.decision === "ALLOW") {
        requireTransition(!state.validation_evidence.has(event.evidence_key) && !state.validation_active_evidence.has(event.evidence_key), "Validation evidence is duplicated.");
        requireTransition(event.limit === (state.validation_limit ?? event.limit) && event.consumed === state.validation_consumed + 1 && event.consumed <= event.limit, "Validation budget reservation is stale or exhausted.");
        state.validation_consumed = event.consumed; state.validation_limit = event.limit; state.validation_reservations.add(event.reservation_id);
        state.validation_reservation_evidence.set(event.reservation_id, event.evidence_key); state.validation_active_evidence.add(event.evidence_key);
      } else if (event.decision === "SKIP") {
        requireTransition(state.validation_evidence.has(event.evidence_key) && !state.validation_active_evidence.has(event.evidence_key) && event.consumed === state.validation_consumed,
          "Skipped validation must reuse unchanged evidence without budget spend.");
        state.validation_skipped += 1; state.redundant_validation_time_ms += event.saved_ms ?? 0;
      } else { requireTransition(event.consumed === state.validation_consumed, "Rejected validation cannot consume budget."); state.validation_rejected += 1; }
      break;
    }
    case "validation.settled": {
      requireTransition(state.validation_reservations.has(event.reservation_id) &&
        state.validation_reservation_evidence.get(event.reservation_id) === event.evidence_key, "Validation settlement has no reservation.");
      requireTransition(event.outcome !== "passed" || event.exit_code === 0,
        "Passed validation settlement requires exit code zero.");
      state.validation_reservations.delete(event.reservation_id); state.validation_reservation_evidence.delete(event.reservation_id);
      state.validation_active_evidence.delete(event.evidence_key);
      if (event.outcome === "passed") state.validation_evidence.add(event.evidence_key);
      state.validation_completed += 1; break;
    }
    case "unit.completed": {
      const unit = state.units.get(event.unit_id);
      const matchingDisposition = event.disposition === "succeeded" ? unit?.last_disposition === "succeeded" : unit?.last_disposition === "failed" || unit?.last_disposition === "cancelled";
      requireTransition(unit !== undefined && unit.completed_disposition === null && unit.active_attempt_id === null && unit.last_attempt_id !== null && matchingDisposition, "Unit completion does not match its terminal attempt."); unit.completed_disposition = event.disposition; break;
    }
    case "wave.completed":
      requireTransition(state.active_wave_id === event.wave_id && state.units.size > 0 && [...state.units.values()].every((unit) => unit.wave_id === event.wave_id && unit.completed_disposition !== null) && event.produced_candidate_id !== state.current_candidate_id, "Wave completion is missing units or has a conflicting candidate.");
      state.pending_candidate = { from: state.current_candidate_id!, to: event.produced_candidate_id, wave: event.wave_id, artifact: event.artifact_id }; state.active_wave_id = null; state.active_wave_route_id = null; state.completed_wave_count += 1; break;
    case "candidate.advanced":
      requireTransition(state.pending_candidate !== null && event.from_candidate_id === state.pending_candidate.from && event.candidate_id === state.pending_candidate.to && event.wave_id === state.pending_candidate.wave && event.artifact_id === state.pending_candidate.artifact, "Candidate transition conflicts with the completed wave.");
      claim(state, event.candidate_id); state.current_candidate_id = event.candidate_id; state.pending_candidate = null; state.last_attempt_id = null; state.units.clear(); state.attempts.clear(); break;
    case "candidate.completed":
      requireTransition(state.active_wave_id === null && state.pending_candidate === null && event.candidate_id === state.current_candidate_id && state.completed_wave_count > 0, "Only the current integrated candidate may complete."); state.candidate_completed = true; break;
    case "cleanup.completed":
      requireTransition(state.candidate_completed && !state.cleanup_completed && event.run_id === state.run_id, "Cleanup must follow candidate completion."); state.cleanup_completed = true; state.observations.push(event.observation); break;
    case "run.completed":
      requireTransition(state.cleanup_completed && event.run_id === state.run_id &&
        [...state.children.values()].every((child) => child.terminal !== null), "Run completion must follow child reconciliation and cleanup."); state.terminal_disposition = event.disposition; break;
  }
}

function publicState(state: MutableState): RunFlightState {
  const openUnits = [...state.units.entries()].filter(([, unit]) => unit.completed_disposition === null);
  const soleUnit = openUnits.length === 1 ? openUnits[0] : undefined;
  return { run_id: state.run_id, current_candidate_id: state.current_candidate_id, active_wave_id: state.active_wave_id, active_unit_id: soleUnit?.[0] ?? null,
    active_attempt_id: soleUnit?.[1].active_attempt_id ?? null, last_attempt_id: openUnits.length > 1 ? null : soleUnit?.[1].last_attempt_id ?? state.last_attempt_id, completed_wave_count: state.completed_wave_count,
    budget_limits: state.budget_limits, budget_consumed: { ...state.budget_consumed }, child_counts: { ...state.child_counts },
     validation_reruns: state.validation_reruns, validation_budget: { consumed: state.validation_consumed,
       reservations: state.validation_reservations.size, limit: state.validation_limit, completed: state.validation_completed,
       skipped: state.validation_skipped, rejected: state.validation_rejected,
       redundant_time_ms: state.redundant_validation_time_ms }, observations: state.observations.map((entry) => structuredClone(entry)), terminal_disposition: state.terminal_disposition,
    plan_decisions: state.plan_decisions.map((entry) => ({ ...entry, gap_codes: [...entry.gap_codes] })),
    resource_budget_limits: state.resource_budget_limits === null ? null : { ...state.resource_budget_limits },
    resource_budget_consumed: { ...state.resource_budget_consumed }, resource_budget_reserved: reservedResources(state),
    children: structuredClone([...state.children.values()]), diagnoses: structuredClone([...state.diagnoses.values()]),
    accepted_fabric_waves: structuredClone(state.accepted_fabric_waves) };
}

export function reconstructRunFlightLedger(records: readonly RunFlightEventRecord[]): RunFlightState {
  if (records.length > MAX_RUN_FLIGHT_EVENTS) throw new RunFlightLedgerError("capacity", "Ledger event capacity exceeded.");
  const state = initialState();
  let previous: string | null = null;
  records.forEach((record, index) => {
    if (!isObject(record) || !only(record, ["sequence", "previous_hash", "event_hash", "event"]) || record.sequence !== index + 1 || record.previous_hash !== previous || !hash(record.event_hash) || !validEvent(record.event)) throw new RunFlightLedgerError("sequence", "Ledger sequence is missing, reordered, or malformed.");
    const expected = recordHash(record.sequence, record.previous_hash, record.event);
    if (record.event_hash !== expected) throw new RunFlightLedgerError("conflict", "Ledger event content conflicts with its immutable hash chain.");
    applyEvent(state, record.event); previous = record.event_hash;
  });
  return publicState(state);
}

/** Compilation can precede run allocation; no execution budget is invented for planning evidence. */
export function createRunFlightPlanPrefix(event: PlanCompiledFlightEvent): readonly RunFlightEventRecord[] {
  if (!validEvent(event) || event.kind !== "plan.compiled") {
    throw new RunFlightLedgerError("invalid", "Planning evidence must be a compile decision.");
  }
  const record = { sequence: 1, previous_hash: null, event_hash: recordHash(1, null, event), event: structuredClone(event) };
  reconstructRunFlightLedger([record]);
  return [record];
}

export function appendRunFlightLedgerEvents(
  records: readonly RunFlightEventRecord[],
  events: readonly RunFlightEvent[],
): readonly RunFlightEventRecord[] {
  reconstructRunFlightLedger(records);
  let previousHash = records.at(-1)?.event_hash ?? null;
  const appended = events.map((event, index): RunFlightEventRecord => {
    if (!validEvent(event)) throw new RunFlightLedgerError("invalid", "Event does not match the closed ledger schema.");
    const sequence = records.length + index + 1;
    const record = { sequence, previous_hash: previousHash, event_hash: recordHash(sequence, previousHash, event),
      event: structuredClone(event) };
    previousHash = record.event_hash;
    return record;
  });
  const next = [...structuredClone(records), ...appended];
  reconstructRunFlightLedger(next);
  if (next.length > MAX_RUN_FLIGHT_EVENTS || Buffer.byteLength(canonical({ schema_version: RUN_FLIGHT_LEDGER_SCHEMA_VERSION, events: next })) > MAX_RUN_FLIGHT_LEDGER_BYTES) {
    throw new RunFlightLedgerError("capacity", "Ledger capacity exceeded.");
  }
  return next;
}

export function createRunFlightLedgerInitialPrefix(input: unknown): readonly RunFlightEventRecord[] {
  if (!isObject(input) || !only(input, ["run_planned", "plan_compiled"]) ||
    !validEvent(input.run_planned) || input.run_planned.kind !== "run.planned" ||
    !validEvent(input.plan_compiled) || input.plan_compiled.kind !== "plan.compiled") {
    throw new RunFlightLedgerError("invalid", "Initial ledger prefix does not match the closed planning schema.");
  }
  const events: readonly [RunPlannedFlightEvent, PlanCompiledFlightEvent] = [
    structuredClone(input.run_planned),
    structuredClone(input.plan_compiled),
  ];
  if (events.length > MAX_RUN_FLIGHT_EVENTS) throw new RunFlightLedgerError("capacity", "Ledger event capacity exceeded.");
  let previousHash: string | null = null;
  const records = events.map((event, index): RunFlightEventRecord => {
    const sequence = index + 1;
    const record: RunFlightEventRecord = {
      sequence,
      previous_hash: previousHash,
      event_hash: recordHash(sequence, previousHash, event),
      event,
    };
    previousHash = record.event_hash;
    return record;
  });
  reconstructRunFlightLedger(records);
  const body = canonical({ schema_version: RUN_FLIGHT_LEDGER_SCHEMA_VERSION, events: records });
  if (Buffer.byteLength(body) > MAX_RUN_FLIGHT_LEDGER_BYTES) throw new RunFlightLedgerError("capacity", "Ledger byte capacity exceeded.");
  return records;
}

function capsuleIds(event: RunFlightEvent): readonly string[] {
  if (event.kind === "diagnosis.opened") return [event.source_capsule_id];
  return "references" in event ? event.references.capsule_ids : [];
}

export class RunFlightLedger {
  readonly #filePath: string;
  readonly #evidence: RunFlightEvidenceAccess | undefined;
  readonly #goalMode: boolean;
  #tail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, evidence: RunFlightEvidenceAccess | undefined, goalMode = false) {
    this.#filePath = filePath; this.#evidence = evidence; this.#goalMode = goalMode;
  }

  static async open(filePath: string, evidence: RunFlightEvidenceAccess): Promise<RunFlightLedger> {
    const ledger = new RunFlightLedger(filePath, evidence);
    await ledger.read();
    return ledger;
  }

  /** Root goal checkpoints share this owner and lock/write discipline without inventing a Git run. */
  static async openGoal(filePath: string): Promise<RunFlightLedger> {
    const ledger = new RunFlightLedger(filePath, undefined, true);
    await ledger.readGoal();
    return ledger;
  }

  /** Read-only Career inventory: validates one existing goal ledger without opening another store. */
  static async readGoalFile(filePath: string): Promise<{ readonly records: readonly GoalFlightEventRecord[]; readonly state: GoalFlightState }> {
    return new RunFlightLedger(filePath, undefined, true).readGoal();
  }

  async read(): Promise<{ readonly records: readonly RunFlightEventRecord[]; readonly state: RunFlightState }> {
    if (this.#goalMode) throw new RunFlightLedgerError("invalid", "Goal ledger requires readGoal().");
    const records = await this.#readRecords();
    await this.#verifyCapsules(records);
    return { records: structuredClone(records), state: reconstructRunFlightLedger(records) };
  }

  async append(event: RunFlightEvent): Promise<RunFlightState> {
    if (this.#goalMode) throw new RunFlightLedgerError("invalid", "Goal ledger requires appendGoal().");
    if (!validEvent(event)) throw new RunFlightLedgerError("invalid", "Event does not match the closed ledger schema.");
    let resolve!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((done) => { resolve = done; });
    await previous;
    try { return await this.#appendLocked(structuredClone(event)); } finally { resolve(); }
  }

  async appendCompileResult(result: AcceptanceCompileResult, at: string): Promise<RunFlightState> {
    return this.append({ kind: "plan.compiled", at, plan_id: result.plan_id, proposal_id: result.proposal_id, decision: result.status, gap_codes: result.status === "accepted" ? [] : [...new Set(result.gaps.map((entry) => entry.code))] });
  }

  async reserveValidation(request: ValidationBudgetRequest, limit: number,
    skipReconciliation?: ValidationSkipReconciliation): Promise<ValidationBudgetDecision & { readonly reservation_id: string | null }> {
    const { decideValidationBudget, passedValidationDurationGuidance, validationEvidenceKey } = await import("./validation-budget.js");
    const evidenceKey = validationEvidenceKey(request);
    if (this.#goalMode) {
      const snapshot = await this.readGoal();
      const evidence = validationEvidenceState(snapshot.records.map(({ event }) => event));
      const guidance = passedValidationDurationGuidance(snapshot.records.map(({ event }) => event), evidenceKey);
      const decision = decideValidationBudget(request, { limit, consumed: snapshot.state.validation_budget.consumed,
        evidence_keys: evidence.reusable, blocked_evidence_keys: evidence.blocked, prior_duration_ms: guidance.median_ms ?? undefined });
      const reservation_id = decision.decision === "ALLOW" ? randomUUID() : null;
      const admission = { kind: "validation.admission" as const, at: new Date().toISOString(), goal_id: snapshot.state.goal_id!,
        reservation_id: reservation_id ?? `${decision.decision === "SKIP" ? "skip" : "deny"}-${randomUUID()}`, operation_id: request.operation_id,
        evidence_key: decision.evidence_key ?? `sha256:${"0".repeat(64)}`, scope: decision.scope, decision: decision.decision,
        reason: decision.reason, consumed: decision.consumed, limit, saved_ms: decision.redundant_time_ms };
      if (decision.decision === "SKIP" && skipReconciliation !== undefined) {
        await this.#appendGoalWithSkipReconciliation(admission, skipReconciliation);
      }
      else await this.appendGoal(admission);
      return { ...decision, reservation_id };
    }
    const snapshot = await this.read();
    const current = snapshot.state;
    const evidence = validationEvidenceState(snapshot.records.map(({ event }) => event));
    const guidance = passedValidationDurationGuidance(snapshot.records.map(({ event }) => event), evidenceKey);
    const decision = decideValidationBudget(request, { limit, consumed: current.validation_budget.consumed,
      evidence_keys: evidence.reusable, blocked_evidence_keys: evidence.blocked, prior_duration_ms: guidance.median_ms ?? undefined });
    const reservation_id = decision.decision === "ALLOW" ? randomUUID() : null;
    await this.append({ kind: "validation.admission", at: new Date().toISOString(),
      reservation_id: reservation_id ?? `${decision.decision === "SKIP" ? "skip" : "deny"}-${randomUUID()}`,
      operation_id: request.operation_id, evidence_key: decision.evidence_key ?? "sha256:" + "0".repeat(64), scope: decision.scope,
      decision: decision.decision, reason: decision.reason, consumed: decision.consumed, limit,
      saved_ms: decision.redundant_time_ms });
    return { ...decision, reservation_id };
  }

  /** Internal operator retry path. Generic reserveValidation remains strict evidence-key dedupe. */
  async reserveInterruptedValidationRetry(request: ValidationBudgetRequest, limit: number,
    authorization: GoalValidationRetryAuthorization,
    skipReconciliation?: ValidationSkipReconciliation): Promise<ValidationBudgetDecision & { readonly reservation_id: string | null }> {
    if (!this.#goalMode) throw new RunFlightLedgerError("invalid", "Interrupted validation retry requires a goal ledger.");
    const { decideValidationBudget, validationEvidenceKey } = await import("./validation-budget.js");
    const snapshot = await this.readGoal(), evidenceKey = validationEvidenceKey(request);
    const evidence = validationEvidenceState(snapshot.records.map(({ event }) => event));
    const admissions = snapshot.records.filter(({ event }) => event.kind === "validation.admission" &&
      event.decision === "ALLOW" && event.evidence_key === evidenceKey);
    const alreadyReopened = admissions.some(({ event }) => event.kind === "validation.admission" && event.reopen !== undefined);
    const prior = admissions.at(-1)?.event;
    const settlement = prior?.kind === "validation.admission" ? snapshot.records.find(({ event }) =>
      event.kind === "validation.settled" && event.reservation_id === prior.reservation_id)?.event : undefined;
    const bound = snapshot.state.goal_id !== null && request.run_id === snapshot.state.goal_id &&
      authorization.goal_fingerprint === snapshot.state.acceptance_fingerprint &&
      request.expected_evidence.includes(`unit:${authorization.unit_id}`);
    if (!bound || alreadyReopened || prior?.kind !== "validation.admission" || settlement?.kind !== "validation.settled" ||
        settlement.operation_id !== prior.operation_id || settlement.evidence_key !== evidenceKey || settlement.outcome !== "interrupted") {
      return this.reserveValidation(request, limit, skipReconciliation);
    }
    const decision = decideValidationBudget(request, { limit, consumed: snapshot.state.validation_budget.consumed,
      evidence_keys: evidence.reusable.filter(key => key !== evidenceKey),
      blocked_evidence_keys: evidence.blocked.filter(key => key !== evidenceKey) });
    const reservation_id = decision.decision === "ALLOW" ? randomUUID() : null;
    await this.appendGoal({ kind: "validation.admission", at: new Date().toISOString(), goal_id: snapshot.state.goal_id,
      reservation_id: reservation_id ?? `deny-${randomUUID()}`, operation_id: request.operation_id,
      evidence_key: decision.evidence_key ?? `sha256:${"0".repeat(64)}`, scope: decision.scope,
      decision: decision.decision, reason: decision.reason, consumed: decision.consumed, limit,
      saved_ms: decision.redundant_time_ms,
      ...(decision.decision === "ALLOW" ? { reopen: { ...authorization, prior_reservation_id: prior.reservation_id,
        prior_operation_id: prior.operation_id } } : {}) });
    return { ...decision, reservation_id };
  }

  async settleValidation(reservation_id: string, request: ValidationBudgetRequest, outcome: ValidationOutcome,
    exit_code: number | null, duration_ms?: number): Promise<RunFlightState | GoalFlightState> {
    const { validationEvidenceKey, validationResultFingerprint } = await import("./validation-budget.js");
    const evidenceKey = validationEvidenceKey(request), evidenceFingerprint = validationResultFingerprint(request, outcome, exit_code);
    if (this.#goalMode) {
      const goalID = (await this.readGoal()).state.goal_id;
      if (goalID === null) throw new RunFlightLedgerError("invalid", "Goal validation requires an active goal.");
      await this.appendGoal({ kind: "validation.settled", at: new Date().toISOString(), goal_id: goalID,
        reservation_id, operation_id: request.operation_id, evidence_key: evidenceKey, outcome, exit_code,
        evidence_fingerprint: evidenceFingerprint, ...(duration_ms === undefined ? {} : { duration_ms }), reason: outcome });
      return (await this.readGoal()).state;
    }
    return this.append({ kind: "validation.settled", at: new Date().toISOString(), reservation_id, operation_id: request.operation_id,
      evidence_key: evidenceKey, outcome, exit_code, evidence_fingerprint: evidenceFingerprint,
      ...(duration_ms === undefined ? {} : { duration_ms }), reason: outcome });
  }

  async readGoal(): Promise<{ readonly records: readonly GoalFlightEventRecord[]; readonly state: GoalFlightState }> {
    if (!this.#goalMode) throw new RunFlightLedgerError("invalid", "Run ledger does not expose goal checkpoints.");
    const records = await this.#readGoalRecords();
    return { records: structuredClone(records), state: reduceGoalFlight(records) };
  }

  async appendGoal(event: GoalFlightEvent): Promise<GoalFlightState> {
    if (!this.#goalMode) throw new RunFlightLedgerError("invalid", "Run ledger cannot append goal checkpoints.");
    let resolveTail!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((done) => { resolveTail = done; });
    await previous;
    try { return await this.#appendGoalLocked(structuredClone(event)); } finally { resolveTail(); }
  }

  async #appendGoalWithSkipReconciliation(event: Extract<GoalFlightEvent, { readonly kind: "validation.admission" }>,
    reconciliation: ValidationSkipReconciliation | undefined): Promise<GoalFlightState> {
    let resolveTail!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { resolveTail = resolve; });
    await previous;
    try {
      return await this.#appendGoalLocked(event, (state) => {
        if (reconciliation === undefined || reconciliation.evidence.length === 0 || state.goal_id !== event.goal_id ||
          reconciliation.evidence.some(entry => !validGoalEvidence(entry, state) ||
            !entry.execution.units.includes(reconciliation.unit_id) || entry.identity.source !== reconciliation.source ||
            entry.identity.candidate !== reconciliation.candidate ||
            entry.execution.command.length !== reconciliation.command.length ||
            entry.execution.command.some((part, index) => part !== reconciliation.command[index]))) {
          throw new RunFlightLedgerError("transition", "Settled-pass reconciliation is unavailable or stale.");
        }
      });
    } finally { resolveTail(); }
  }

  async #appendLocked(event: RunFlightEvent): Promise<RunFlightState> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const lockPath = `${this.#filePath}.lock`;
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await open(lockPath, "wx"); break; }
      catch (error) {
        if (!isObject(error) || error.code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!handle) throw new RunFlightLedgerError("conflict", "Ledger lock remained busy.");
    try {
      const records = await this.#readRecords();
      if (event.kind.startsWith("diagnosis.") && "swarm_id" in event) {
        const prior = records.find(({ event: stored }) => stored.kind === event.kind && "swarm_id" in stored && stored.swarm_id === event.swarm_id &&
          (!("lane_id" in event) || ("lane_id" in stored && stored.lane_id === event.lane_id)));
        if (prior !== undefined) {
          if (recordHash(1, null, { ...event, at: prior.event.at }) !== recordHash(1, null, prior.event)) throw new RunFlightLedgerError("transition", "Diagnosis record conflicts with its accepted identity.");
          return reconstructRunFlightLedger(records);
        }
      }
      if ("identity" in event && event.kind.startsWith("child.")) {
        const previous = records.find(({ event: stored }) => stored.kind === event.kind && "identity" in stored &&
          stored.identity.attempt_id === event.identity.attempt_id);
        if (previous !== undefined) {
          if (recordHash(1, null, { ...event, at: previous.event.at }) !== recordHash(1, null, previous.event)) {
            throw new RunFlightLedgerError("transition", "A different child lifecycle event is already recorded.");
          }
          return reconstructRunFlightLedger(records);
        }
      }
      await this.#verifyEventCapsules(event);
      const sequence = records.length + 1;
      const previousHash = records.at(-1)?.event_hash ?? null;
      const record: RunFlightEventRecord = { sequence, previous_hash: previousHash, event_hash: recordHash(sequence, previousHash, event), event };
      const next = [...records, record];
      const state = reconstructRunFlightLedger(next);
      const body = canonical({ schema_version: RUN_FLIGHT_LEDGER_SCHEMA_VERSION, events: next });
      if (Buffer.byteLength(body) > MAX_RUN_FLIGHT_LEDGER_BYTES) throw new RunFlightLedgerError("capacity", "Ledger byte capacity exceeded.");
      const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
      try { await rename(temporary, this.#filePath); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
      return state;
    } finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
  }

  async #appendGoalLocked(event: GoalFlightEvent, guard?: (state: GoalFlightState) => void): Promise<GoalFlightState> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const lockPath = `${this.#filePath}.lock`;
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await open(lockPath, "wx"); break; }
      catch (error) {
        if (!isObject(error) || error.code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!handle) throw new RunFlightLedgerError("conflict", "Ledger lock remained busy.");
    try {
      const records = await this.#readGoalRecords();
      if (guard !== undefined) guard(reduceGoalFlight(records));
      if (event.kind === "goal.accepted") {
        const prior = records.find(({ event: stored }) => stored.kind === "goal.accepted" &&
          stored.origin_user_message_id === event.origin_user_message_id);
        if (prior !== undefined) {
          if (recordHash(1, null, { ...event, at: prior.event.at }) !== recordHash(1, null, prior.event)) {
            throw new RunFlightLedgerError("transition", "Accepted goal conflicts with its durable user message identity.");
          }
          return reduceGoalFlight(records);
        }
      }
      if (event.kind === "goal.reported" && records.some(({ event: stored }) => stored.kind === "goal.reported" &&
        stored.goal_id === event.goal_id && stored.report?.terminal_key === event.report.terminal_key)) {
        return reduceGoalFlight(records);
      }
      if (event.kind === "goal.reported") {
        const { validGoalReport } = await import("./goal-report.js");
        const state = reduceGoalFlight(records);
        if (state.receipt === null || event.goal_id !== state.goal_id || !validGoalReport(event.report) ||
          event.report.terminal_key !== goalFingerprint(state.receipt)) {
          throw new RunFlightLedgerError("invalid", "Report is not bound to the current terminal receipt.");
        }
      }
      const sequence = records.length + 1;
      const previousHash = records.at(-1)?.event_hash ?? null;
      const record: GoalFlightEventRecord = { sequence, previous_hash: previousHash,
        event_hash: recordHash(sequence, previousHash, event), event };
      const next = [...records, record];
      let state: GoalFlightState;
      try { state = reduceGoalFlight(next); }
      catch (error) {
        if (error instanceof GoalBoundError) throw new RunFlightLedgerError(
          error.code === "budget" ? "budget" : error.code === "invalid" ? "invalid" : "transition", error.message);
        throw error;
      }
      const body = canonical({ schema_version: GOAL_BOUND_SCHEMA_VERSION, goal_events: next });
      if (next.length > MAX_RUN_FLIGHT_EVENTS || Buffer.byteLength(body) > MAX_RUN_FLIGHT_LEDGER_BYTES) {
        throw new RunFlightLedgerError("capacity", "Goal ledger capacity exceeded.");
      }
      const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
      try { await rename(temporary, this.#filePath); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
      return state;
    } finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
  }

  async #readRecords(): Promise<RunFlightEventRecord[]> {
    let raw: string;
    try { raw = await readFile(this.#filePath, "utf8"); }
    catch (error) { if (isObject(error) && error.code === "ENOENT") return []; throw error; }
    if (Buffer.byteLength(raw) > MAX_RUN_FLIGHT_LEDGER_BYTES) throw new RunFlightLedgerError("capacity", "Ledger byte capacity exceeded.");
    let document: unknown;
    try { document = JSON.parse(raw); } catch { throw new RunFlightLedgerError("invalid", "Ledger is not valid JSON."); }
    if (!isObject(document) || !only(document, ["schema_version", "events"]) || document.schema_version !== RUN_FLIGHT_LEDGER_SCHEMA_VERSION || !Array.isArray(document.events)) throw new RunFlightLedgerError("invalid", "Ledger document does not match the closed schema.");
    reconstructRunFlightLedger(document.events as RunFlightEventRecord[]);
    return document.events as RunFlightEventRecord[];
  }

  async #readGoalRecords(): Promise<GoalFlightEventRecord[]> {
    let raw: string;
    try { raw = await readFile(this.#filePath, "utf8"); }
    catch (error) { if (isObject(error) && error.code === "ENOENT") return []; throw error; }
    if (Buffer.byteLength(raw) > MAX_RUN_FLIGHT_LEDGER_BYTES) throw new RunFlightLedgerError("capacity", "Goal ledger capacity exceeded.");
    let document: unknown;
    try { document = JSON.parse(raw); } catch { throw new RunFlightLedgerError("invalid", "Goal ledger is not valid JSON."); }
    if (!isObject(document) || !only(document, ["schema_version", "goal_events"]) ||
      document.schema_version !== GOAL_BOUND_SCHEMA_VERSION || !Array.isArray(document.goal_events)) {
      throw new RunFlightLedgerError("invalid", "Goal ledger document does not match the closed schema.");
    }
    const records = document.goal_events as GoalFlightEventRecord[];
    let previous: string | null = null;
    records.forEach((record, index) => {
      if (!isObject(record) || !only(record, ["sequence", "previous_hash", "event_hash", "event"]) ||
        record.sequence !== index + 1 || record.previous_hash !== previous || !hash(record.event_hash) ||
        record.event_hash !== recordHash(record.sequence, record.previous_hash, record.event)) {
        throw new RunFlightLedgerError("conflict", "Goal ledger hash chain is malformed.");
      }
      previous = record.event_hash;
    });
    try { reduceGoalFlight(records); }
    catch (error) {
      if (error instanceof GoalBoundError) throw new RunFlightLedgerError(error.code === "invalid" ? "invalid" : "transition", error.message);
      throw error;
    }
    return records;
  }

  async #verifyCapsules(records: readonly RunFlightEventRecord[]): Promise<void> {
    for (const record of records) await this.#verifyEventCapsules(record.event);
  }

  async #verifyEventCapsules(event: RunFlightEvent): Promise<void> {
    if (event.kind === "diagnosis.finished" && event.capsule_id !== null) {
      // The coordinator's accepted finding event declares this newly created, scope-checked capsule.
      await this.#evidence!.store.lookup({ capsule_id: event.capsule_id, declared_capsule_ids: [event.capsule_id],
        authorized_source_paths: this.#evidence!.authorized_source_paths });
    } else await this.#verifyCapsuleIds(capsuleIds(event));
  }

  async #verifyCapsuleIds(ids: readonly string[]): Promise<void> {
    for (const capsuleId of ids) await this.#evidence!.store.lookup({ capsule_id: capsuleId, declared_capsule_ids: this.#evidence!.declared_capsule_ids, authorized_source_paths: this.#evidence!.authorized_source_paths });
  }
}
