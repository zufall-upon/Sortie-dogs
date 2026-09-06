import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EvidenceCapsuleStore } from "./evidence-capsule.js";
import type { AcceptanceCompileGapCode, AcceptanceCompileResult } from "./acceptance-compiler.js";
import { LUNA_FABRIC_MAX_ACTIVE } from "./luna-fabric-scheduler.js";
import { normalizeRelativePath } from "./path.js";
import { CHILD_TERMINAL_EVIDENCE_FIELDS, isChildTerminalIdentity, reconcileChildTerminal, sameChildTerminalIdentity,
  type ChildTerminalIdentity, type ChildTerminalEvidence, type ChildTerminalDisposition } from "./child-terminal-reconciliation.js";

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
  | (EventBase & { readonly kind: "route.selected"; readonly route_id: string; readonly candidate_id: string; readonly role: FlightRole; readonly model: string; readonly variant: string | null; readonly reason: "planning" | "implementation" | RecoveryKind })
  | (EventBase & { readonly kind: "wave.opened"; readonly wave_id: string; readonly wave_index: number; readonly candidate_id: string })
  | (EventBase & { readonly kind: "unit.opened"; readonly unit_id: string; readonly wave_id: string; readonly candidate_id: string; readonly references: FlightReferenceSet })
  | (EventBase & { readonly kind: "attempt.started"; readonly attempt_id: string; readonly predecessor_attempt_id: string | null; readonly unit_id: string; readonly candidate_id: string; readonly route_id: string; readonly role: FlightRole; readonly selected_model: string; readonly selected_variant: string | null; readonly child_id: string | null; readonly call_id: string; readonly budget_charge: FlightBudgetCharge; readonly resource_budget_request?: FlightResourceBudget; readonly remediation_contract_id?: string })
  | (EventBase & { readonly kind: "attempt.finished"; readonly attempt_id: string; readonly observed_model: string | null; readonly observed_variant: string | null; readonly failure: { readonly category: FailureCategory; readonly code: string } | null; readonly disposition: TerminalDisposition; readonly observation: FlightObservation; readonly references: FlightReferenceSet })
  | (EventBase & { readonly kind: "recovery.recorded"; readonly recovery_id: string; readonly failed_attempt_id: string; readonly kind_detail: RecoveryKind; readonly candidate_id: string })
  | (EventBase & { readonly kind: "validation.recorded"; readonly validation_id: string; readonly unit_id: string; readonly command_fingerprint: string; readonly result: "passed" | "failed"; readonly artifact_id: string | null })
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
  readonly observations: readonly FlightObservation[];
  readonly terminal_disposition: "succeeded" | "failed" | "cancelled" | null;
  readonly plan_decisions: readonly { readonly plan_id: string; readonly proposal_id: string; readonly decision: "accepted" | "rejected"; readonly gap_codes: readonly AcceptanceCompileGapCode[] }[];
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

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : isObject(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

function recordHash(sequence: number, previousHash: string | null, event: RunFlightEvent): string {
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
    case "route.selected": return only(value, [...base, "route_id", "candidate_id", "role", "model", "variant", "reason"]) && text(value.route_id) && text(value.candidate_id) && enumValue(value.role, ["implementation", "review", "advice", "rescue"]) && text(value.model) && nullableText(value.variant) && enumValue(value.reason, ["planning", "implementation", "normal_remediation", "adaptive_probe", "read_only_diagnosis", "model_rescue"]);
    case "wave.opened": return only(value, [...base, "wave_id", "wave_index", "candidate_id"]) && text(value.wave_id) && Number.isInteger(value.wave_index) && Number(value.wave_index) >= 1 && text(value.candidate_id);
    case "unit.opened": return only(value, [...base, "unit_id", "wave_id", "candidate_id", "references"]) && text(value.unit_id) && text(value.wave_id) && text(value.candidate_id) && validReferences(value.references);
    case "attempt.started": return only(value, [...base, "attempt_id", "predecessor_attempt_id", "unit_id", "candidate_id", "route_id", "role", "selected_model", "selected_variant", "child_id", "call_id", "budget_charge", "resource_budget_request", "remediation_contract_id"]) && text(value.attempt_id) && nullableText(value.predecessor_attempt_id) && text(value.unit_id) && text(value.candidate_id) && text(value.route_id) && enumValue(value.role, ["implementation", "review", "advice", "rescue"]) && text(value.selected_model) && nullableText(value.selected_variant) && nullableText(value.child_id) && text(value.call_id) && validCharge(value.budget_charge) && (!Object.hasOwn(value, "resource_budget_request") || validResourceBudget(value.resource_budget_request)) && (!Object.hasOwn(value, "remediation_contract_id") || hash(value.remediation_contract_id));
    case "attempt.finished": {
      if (!only(value, [...base, "attempt_id", "observed_model", "observed_variant", "failure", "disposition", "observation", "references"]) || !text(value.attempt_id) || !nullableText(value.observed_model) || !nullableText(value.observed_variant) || !enumValue(value.disposition, ["continue", "succeeded", "failed", "cancelled"]) || !validObservation(value.observation) || !validReferences(value.references)) return false;
      const failure = value.failure;
      return (failure === null && value.disposition === "succeeded") || (isObject(failure) && only(failure, ["category", "code"]) && enumValue(failure.category, ["infrastructure", "authorization", "contract", "cancellation", "implementation"]) && text(failure.code) && value.disposition !== "succeeded");
    }
    case "recovery.recorded": return only(value, [...base, "recovery_id", "failed_attempt_id", "kind_detail", "candidate_id"]) && text(value.recovery_id) && text(value.failed_attempt_id) && enumValue(value.kind_detail, ["normal_remediation", "adaptive_probe", "read_only_diagnosis", "model_rescue"]) && text(value.candidate_id);
    case "validation.recorded": return only(value, [...base, "validation_id", "unit_id", "command_fingerprint", "result", "artifact_id"]) && text(value.validation_id) && text(value.unit_id) && hash(value.command_fingerprint) && enumValue(value.result, ["passed", "failed"]) && (value.artifact_id === null || hash(value.artifact_id));
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
  resource_budget_limits: FlightResourceBudget | null;
  resource_budget_consumed: FlightResourceUsage;
  resource_reservations: Map<string, FlightResourceUsage>;
}

interface MutableUnitState {
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
    ids: new Set(), validation_fingerprints: new Set(), attempts: new Map(), units: new Map(), plan_decisions: [], plan_ids: new Set(), accepted_plan: null,
    resource_budget_limits: null, resource_budget_consumed: { time_ms: 0, cost_usd: 0 }, resource_reservations: new Map(), children: new Map(), diagnoses: new Map() };
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
    case "route.selected":
      requireTransition(state.run_id !== null && state.active_wave_id === null && !state.candidate_completed && event.candidate_id === state.current_candidate_id, "Route must target the current candidate between waves."); claim(state, event.route_id); state.current_route_id = event.route_id; break;
    case "wave.opened":
      requireTransition(state.current_route_id !== null && state.active_wave_id === null && state.pending_candidate === null && event.candidate_id === state.current_candidate_id && event.wave_index === state.completed_wave_count + 1, "Wave order or candidate is invalid."); claim(state, event.wave_id); state.active_wave_id = event.wave_id; state.active_wave_route_id = state.current_route_id; state.current_route_id = null; break;
    case "unit.opened": {
      requireTransition(state.active_wave_id === event.wave_id && event.candidate_id === state.current_candidate_id, "Unit must open in the active wave and candidate."); claim(state, event.unit_id);
      const openUnits = [...state.units.values()].filter((unit) => unit.completed_disposition === null);
      if (openUnits.length > 0) for (const unit of openUnits) if (unit.last_attempt_id === null) unit.initial_predecessor_id = null;
      state.units.set(event.unit_id, {
        last_recovery_kind: null, last_validation: null,
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
      // Preserve actual overruns and missing measurements; only a subsequent attempt is denied.
      state.resource_reservations.delete(event.attempt_id);
      state.resource_budget_consumed = addResources(state.resource_budget_consumed, {
        time_ms: event.observation.duration_ms, cost_usd: event.observation.estimated_cost.usd,
      });
      unit.active_attempt_id = null; unit.last_failed_attempt_id = event.failure === null ? null : event.attempt_id; unit.last_disposition = event.disposition; state.observations.push(event.observation); break;
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
    validation_reruns: state.validation_reruns, observations: state.observations.map((entry) => structuredClone(entry)), terminal_disposition: state.terminal_disposition,
    plan_decisions: state.plan_decisions.map((entry) => ({ ...entry, gap_codes: [...entry.gap_codes] })),
    resource_budget_limits: state.resource_budget_limits === null ? null : { ...state.resource_budget_limits },
    resource_budget_consumed: { ...state.resource_budget_consumed }, resource_budget_reserved: reservedResources(state),
    children: structuredClone([...state.children.values()]), diagnoses: structuredClone([...state.diagnoses.values()]) };
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
  readonly #evidence: RunFlightEvidenceAccess;
  #tail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, evidence: RunFlightEvidenceAccess) { this.#filePath = filePath; this.#evidence = evidence; }

  static async open(filePath: string, evidence: RunFlightEvidenceAccess): Promise<RunFlightLedger> {
    const ledger = new RunFlightLedger(filePath, evidence);
    await ledger.read();
    return ledger;
  }

  async read(): Promise<{ readonly records: readonly RunFlightEventRecord[]; readonly state: RunFlightState }> {
    const records = await this.#readRecords();
    await this.#verifyCapsules(records);
    return { records: structuredClone(records), state: reconstructRunFlightLedger(records) };
  }

  async append(event: RunFlightEvent): Promise<RunFlightState> {
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

  async #verifyCapsules(records: readonly RunFlightEventRecord[]): Promise<void> {
    for (const record of records) await this.#verifyEventCapsules(record.event);
  }

  async #verifyEventCapsules(event: RunFlightEvent): Promise<void> {
    if (event.kind === "diagnosis.finished" && event.capsule_id !== null) {
      // The coordinator's accepted finding event declares this newly created, scope-checked capsule.
      await this.#evidence.store.lookup({ capsule_id: event.capsule_id, declared_capsule_ids: [event.capsule_id],
        authorized_source_paths: this.#evidence.authorized_source_paths });
    } else await this.#verifyCapsuleIds(capsuleIds(event));
  }

  async #verifyCapsuleIds(ids: readonly string[]): Promise<void> {
    for (const capsuleId of ids) await this.#evidence.store.lookup({ capsule_id: capsuleId, declared_capsule_ids: this.#evidence.declared_capsule_ids, authorized_source_paths: this.#evidence.authorized_source_paths });
  }
}
