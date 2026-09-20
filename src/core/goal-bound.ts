import { createHash } from "node:crypto";
import { CONTRACT_TEXT_LIMITS } from "./contract-limits.ts";
import type { ValidationOutcome, ValidationScope } from "./validation-budget.js";
import type { GoalReport } from "./goal-report.js";

export const GOAL_BOUND_SCHEMA_VERSION = "0.1" as const;
export const GOAL_BOUND_METADATA_KEY = "sortie-dogs.goal-bound/v1" as const;

export type GoalDeliveryMode = "planning-only" | "mvp-first" | "repair-first" | "controlled-change";
export type GoalStopReason = "completed" | "stopped" | "stop_budget" | "stop_no_progress" |
  "external_dependency" | "awaiting_user" | "agent_changed" | "persistence_unavailable";
export type GoalPhase = "active" | "stopped" | "terminal";

export interface GoalBudget {
  readonly max_units: number;
  readonly time_ms: number | null;
  readonly cost_usd: number | null;
  readonly source: "policy-default" | "accepted-plan" | "user-revision";
}

export interface GoalEvidence {
  readonly evidence_id: string;
  readonly goal_id: string;
  readonly goal_revision: number;
  readonly scope_epoch: number;
  readonly acceptance_fingerprint: string;
  readonly measurement: {
    readonly criterion_ids: readonly string[];
    readonly target: string;
    readonly entrypoint: string;
    readonly workload: string;
    readonly oracle_coverage: readonly string[];
    readonly build_boundary: "included" | "excluded" | "not-applicable";
  };
  readonly identity: { readonly source: string; readonly candidate: string; readonly fixture: string };
  /** Host-owned snapshot recipe. Required when acceptance binds to the current protected source/candidate. */
  readonly protected_binding?: {
    readonly manifest_hash: string;
    readonly project_root: string;
    readonly manifest_path: string;
    readonly source_paths: readonly string[];
    readonly candidate_paths: readonly string[];
  };
  readonly execution: {
    readonly command: readonly string[];
    readonly exit_code: number | null;
    readonly outcome: "pass" | "fail" | "skip" | "cancel";
    readonly started_at: string;
    readonly ended_at: string;
    readonly units: readonly string[];
  };
  readonly proof_scope: "requested-full" | "supporting-proxy" | "document-deliverable" | "expected-negative";
}

export interface GoalAcceptanceCriterion {
  readonly criterion_id: string;
  readonly target: string;
  readonly entrypoint: string;
  readonly workload: string;
  readonly oracle_coverage: readonly string[];
  readonly build_boundary: "included" | "excluded" | "not-applicable";
  readonly source: string;
  readonly candidate: string;
  readonly source_binding?: "declared" | "current-protected";
  readonly candidate_binding?: "declared" | "current-protected";
  readonly validation_command?: string;
  readonly fixture: string;
  readonly proof_scope: "requested-full" | "document-deliverable" | "expected-negative";
  readonly expected_outcome: "pass" | "fail";
}

export interface GoalAcceptanceContract {
  readonly criteria: readonly GoalAcceptanceCriterion[];
}

export interface GoalTerminalReceipt {
  readonly goal_id: string;
  readonly terminal_revision: number;
  readonly acceptance_fingerprint: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly status: "succeeded" | "stopped";
  readonly stop_reason: GoalStopReason;
  readonly unit_ids: readonly string[];
  readonly session_ids: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly milestone_at: string | null;
}

interface GoalEventBase { readonly at: string }
export interface GoalValidationRetryAuthorization {
  readonly authority: "operator-repair-validation-retry";
  readonly operator_run_id: string;
  readonly unit_id: string;
  readonly operator_generation: number;
  readonly plan_hash: string;
  readonly control_hash: string;
  readonly goal_fingerprint: string;
  readonly repair_fingerprint: string;
}
export interface GoalValidationReopen extends GoalValidationRetryAuthorization {
  readonly prior_reservation_id: string;
  readonly prior_operation_id: string;
}
export type GoalFlightEvent =
  | (GoalEventBase & { readonly kind: "goal.accepted"; readonly goal_id: string; readonly revision: 1;
      readonly scope_epoch: 1; readonly acceptance_fingerprint: string; readonly origin_user_message_id: string;
      readonly origin_session_id: string; readonly selected_agent: string; readonly delivery: GoalDeliveryMode;
      readonly budget: GoalBudget; readonly acceptance_contract: GoalAcceptanceContract | null })
  | (GoalEventBase & { readonly kind: "goal.user-continued"; readonly goal_id: string;
      readonly origin_user_message_id: string; readonly session_id: string; readonly selected_agent: string })
  | (GoalEventBase & { readonly kind: "goal.revised"; readonly goal_id: string; readonly revision: number;
       readonly scope_epoch: number; readonly acceptance_fingerprint: string; readonly origin_user_message_id: string;
       readonly session_id: string; readonly selected_agent: string; readonly delivery: GoalDeliveryMode;
       readonly budget: GoalBudget; readonly acceptance_contract: GoalAcceptanceContract | null;
       readonly reset_no_progress?: boolean })
  | (GoalEventBase & { readonly kind: "ticket.issued"; readonly ticket_id: string; readonly goal_id: string;
      readonly revision: number; readonly scope_epoch: number; readonly checkpoint: string; readonly sequence: number;
      readonly session_id: string; readonly origin_user_message_id: string })
  | (GoalEventBase & { readonly kind: "ticket.consumed"; readonly ticket_id: string; readonly goal_id: string;
      readonly receiving_message_id: string; readonly session_id: string; readonly origin_user_message_id: string })
  | (GoalEventBase & { readonly kind: "dispatch.reserved"; readonly reservation_id: string; readonly goal_id: string;
      readonly unit_id: string; readonly session_id: string; readonly ticket_id: string | null })
  | (GoalEventBase & { readonly kind: "unit.settled"; readonly reservation_id: string; readonly receipt_id: string;
      readonly goal_id: string; readonly unit_id: string; readonly disposition: "succeeded" | "failed" | "cancelled";
      /** Missing on pre-v0.9.1 ledgers and therefore interpreted as an acceptance result. */
      readonly result_class?: "acceptance" | "process-defect" | "interrupted";
      readonly progress_fingerprint: string | null; readonly evidence: readonly GoalEvidence[];
       readonly elapsed_ms: number | null; readonly cost_usd: number | null })
  | (GoalEventBase & { readonly kind: "unit.evidence-reconciled"; readonly goal_id: string; readonly unit_id: string;
      readonly previous_receipt_id: string; readonly evidence: readonly GoalEvidence[] })
  | (GoalEventBase & { readonly kind: "validation.admission"; readonly goal_id: string; readonly reservation_id: string;
       readonly operation_id: string; readonly evidence_key: string; readonly scope: ValidationScope | null;
       readonly decision: "ALLOW" | "SKIP" | "DENY"; readonly reason: string; readonly consumed: number; readonly limit: number;
       readonly saved_ms?: number;
       readonly reopen?: GoalValidationReopen })
  | (GoalEventBase & { readonly kind: "validation.settled"; readonly goal_id: string; readonly reservation_id: string;
       readonly operation_id: string; readonly evidence_key: string; readonly outcome: ValidationOutcome; readonly exit_code: number | null;
       readonly evidence_fingerprint?: string; readonly duration_ms?: number; readonly reason?: string })
  | (GoalEventBase & { readonly kind: "goal.replanned"; readonly goal_id: string; readonly revision: number;
      readonly reason: "no-progress" })
  | (GoalEventBase & { readonly kind: "goal.terminal"; readonly goal_id: string; readonly receipt: GoalTerminalReceipt })
  | (GoalEventBase & { readonly kind: "goal.reported"; readonly goal_id: string; readonly report: GoalReport });

export interface GoalFlightEventRecord {
  readonly sequence: number;
  readonly previous_hash: string | null;
  readonly event_hash: string;
  readonly event: GoalFlightEvent;
}

export interface GoalTicketState {
  readonly ticket_id: string;
  readonly revision: number;
  readonly scope_epoch: number;
  readonly checkpoint: string;
  readonly sequence: number;
  readonly session_id: string;
  readonly origin_user_message_id: string;
  readonly receiving_message_id: string | null;
}

export interface GoalFlightState {
  readonly goal_id: string | null;
  readonly revision: number;
  readonly scope_epoch: number;
  readonly acceptance_fingerprint: string | null;
  readonly origin_user_message_id: string | null;
  readonly latest_user_message_id: string | null;
  readonly selected_agent: string | null;
  readonly delivery: GoalDeliveryMode | null;
  readonly budget: GoalBudget | null;
  readonly acceptance_contract: GoalAcceptanceContract | null;
  readonly consumed_units: number;
  readonly consumed_time_ms: number | null;
  readonly consumed_cost_usd: number | null;
  readonly phase: GoalPhase;
  readonly stop_reason: GoalStopReason | null;
  readonly no_progress_results: number;
  readonly replan_used: boolean;
  readonly replan_required: boolean;
  readonly tickets: readonly GoalTicketState[];
  readonly outstanding_reservations: readonly { readonly reservation_id: string; readonly unit_id: string; readonly session_id: string }[];
  readonly validation_budget: { readonly consumed: number; readonly reservations: readonly { readonly reservation_id: string; readonly operation_id: string; readonly evidence_key: string }[]; readonly evidence_keys: readonly string[]; readonly limit: number | null;
    readonly completed: number; readonly skipped: number; readonly rejected: number; readonly redundant_time_ms: number;
    readonly durations_ms: readonly number[] };
  readonly unit_ids: readonly string[];
  readonly session_ids: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly satisfied_criteria: readonly string[];
  readonly receipt: GoalTerminalReceipt | null;
}

export class GoalBoundError extends Error {
  readonly code: "invalid" | "transition" | "budget" | "ticket" | "evidence";
  constructor(code: GoalBoundError["code"], message: string) {
    super(message); this.code = code; this.name = "GoalBoundError";
  }
}

const HASH = /^sha256:[a-f0-9]{64}$/u;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const commandText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= CONTRACT_TEXT_LIMITS.command;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const instant = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));

export function goalFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) :
    typeof item === "object" && item !== null
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical((item as Record<string, unknown>)[key])]))
      : item;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

export function selectGoalDelivery(input: {
  readonly declared_intent: "design" | "registration" | "implementation" | "repair" | "controlled-change";
  readonly requested_usable_path_established: boolean;
  readonly irreversible_or_major_scope: boolean;
  readonly explicit_mode?: GoalDeliveryMode;
}): GoalDeliveryMode {
  if (input.declared_intent === "design" || input.declared_intent === "registration") return "planning-only";
  if (input.declared_intent === "controlled-change" || input.irreversible_or_major_scope) return "controlled-change";
  if (input.explicit_mode !== undefined) return input.explicit_mode;
  if (input.declared_intent === "repair") return "repair-first";
  return "mvp-first";
}

function validAcceptanceContract(value: GoalAcceptanceContract | null): boolean {
  return value === null || (Array.isArray(value.criteria) && value.criteria.length > 0 &&
    new Set(value.criteria.map(({ criterion_id }) => criterion_id)).size === value.criteria.length &&
    value.criteria.every((criterion) => text(criterion.criterion_id) && text(criterion.target) &&
      text(criterion.entrypoint) && text(criterion.workload) && criterion.oracle_coverage.length > 0 &&
      criterion.oracle_coverage.every(text) && new Set(criterion.oracle_coverage).size === criterion.oracle_coverage.length &&
      (criterion.build_boundary === "included" || criterion.build_boundary === "excluded" || criterion.build_boundary === "not-applicable") &&
      text(criterion.source) && text(criterion.candidate) && text(criterion.fixture) &&
      (criterion.source_binding === undefined || criterion.source_binding === "declared" || criterion.source_binding === "current-protected") &&
      (criterion.candidate_binding === undefined || criterion.candidate_binding === "declared" || criterion.candidate_binding === "current-protected") &&
      (criterion.validation_command === undefined || commandText(criterion.validation_command)) &&
      (criterion.proof_scope === "requested-full" || criterion.proof_scope === "document-deliverable" || criterion.proof_scope === "expected-negative") &&
      (criterion.expected_outcome === "pass" || criterion.expected_outcome === "fail")));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validGoalEvidence(value: GoalEvidence, state: Pick<GoalFlightState, "goal_id" | "revision" | "scope_epoch" | "acceptance_fingerprint" | "acceptance_contract">): boolean {
  if (typeof value !== "object" || value === null || typeof value.measurement !== "object" || value.measurement === null ||
    typeof value.identity !== "object" || value.identity === null || typeof value.execution !== "object" || value.execution === null ||
    !Array.isArray(value.measurement.criterion_ids) || !Array.isArray(value.measurement.oracle_coverage) ||
    !Array.isArray(value.execution.command) || !Array.isArray(value.execution.units)) return false;
  const criteria = state.acceptance_contract?.criteria.filter(({ criterion_id }) =>
    value.measurement.criterion_ids.includes(criterion_id)) ?? [];
  const protectedBinding = value.protected_binding;
  const protectedBindingValid = protectedBinding !== undefined && HASH.test(protectedBinding.manifest_hash) &&
    text(protectedBinding.project_root) && text(protectedBinding.manifest_path) && Array.isArray(protectedBinding.source_paths) &&
    protectedBinding.source_paths.every(text) && Array.isArray(protectedBinding.candidate_paths) &&
    protectedBinding.candidate_paths.every(text);
  const matches = criteria.length > 0 && criteria.length === value.measurement.criterion_ids.length &&
    criteria.every((criterion) => criterion.target === value.measurement.target &&
      criterion.entrypoint === value.measurement.entrypoint && criterion.workload === value.measurement.workload &&
      sameStrings(criterion.oracle_coverage, value.measurement.oracle_coverage) &&
      criterion.build_boundary === value.measurement.build_boundary &&
      (criterion.source_binding === "current-protected"
        ? protectedBindingValid && HASH.test(value.identity.source)
        : criterion.source === value.identity.source) &&
      (criterion.candidate_binding === "current-protected"
        ? protectedBindingValid && HASH.test(value.identity.candidate)
        : criterion.candidate === value.identity.candidate) &&
      (criterion.validation_command === undefined ||
        (value.execution.command.length === 1 && value.execution.command[0] === criterion.validation_command)) &&
      criterion.fixture === value.identity.fixture &&
      criterion.proof_scope === value.proof_scope && criterion.expected_outcome === value.execution.outcome);
  return text(value.evidence_id) && value.goal_id === state.goal_id && value.goal_revision === state.revision &&
    value.scope_epoch === state.scope_epoch && value.acceptance_fingerprint === state.acceptance_fingerprint &&
    value.measurement.criterion_ids.length > 0 && value.measurement.criterion_ids.every(text) &&
    new Set(value.measurement.criterion_ids).size === value.measurement.criterion_ids.length &&
    text(value.measurement.target) && text(value.measurement.entrypoint) && text(value.measurement.workload) &&
    value.measurement.oracle_coverage.length > 0 && value.measurement.oracle_coverage.every(text) &&
    text(value.identity.source) && text(value.identity.candidate) && text(value.identity.fixture) &&
    value.execution.command.length > 0 && value.execution.command.every(commandText) &&
    value.execution.exit_code === 0 && instant(value.execution.started_at) &&
    instant(value.execution.ended_at) && Date.parse(value.execution.ended_at) >= Date.parse(value.execution.started_at) &&
    value.execution.units.length > 0 && value.execution.units.every(text) &&
    new Set(value.execution.units).size === value.execution.units.length && matches;
}

function initial(): GoalFlightState {
  return { goal_id: null, revision: 0, scope_epoch: 0, acceptance_fingerprint: null,
    origin_user_message_id: null, latest_user_message_id: null, selected_agent: null, delivery: null, budget: null,
    acceptance_contract: null, consumed_units: 0,
    consumed_time_ms: 0, consumed_cost_usd: 0, phase: "stopped", stop_reason: null,
    no_progress_results: 0, replan_used: false, replan_required: false, tickets: [],
    outstanding_reservations: [], validation_budget: { consumed: 0, reservations: [], evidence_keys: [], limit: null,
      completed: 0, skipped: 0, rejected: 0, redundant_time_ms: 0, durations_ms: [] },
    unit_ids: [], session_ids: [], evidence_refs: [], satisfied_criteria: [], receipt: null };
}

function requireState(condition: boolean, code: GoalBoundError["code"], message: string): asserts condition {
  if (!condition) throw new GoalBoundError(code, message);
}

function addUnique(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values : [...values, value];
}

export function reduceGoalFlight(records: readonly GoalFlightEventRecord[]): GoalFlightState {
  let state = initial();
  let replanRevision: number | null = null;
  let legacyResetRevision = false;
  let previous: string | null = null;
  const processDefects = new Map<string, { unitID: string; revision: number; epoch: number }>();
  const validationAdmissions = new Map<string, Extract<GoalFlightEvent, { readonly kind: "validation.admission" }>>();
  const validationSettlements = new Map<string, Extract<GoalFlightEvent, { readonly kind: "validation.settled" }>>();
  const reopenedValidationEvidence = new Set<string>();
  for (const [index, record] of records.entries()) {
    requireState(record.sequence === index + 1 && record.previous_hash === previous && HASH.test(record.event_hash), "invalid", "Goal ledger chain is malformed.");
    previous = record.event_hash;
    const event = record.event;
    // Optional presentation records never participate in execution replay. Writers validate them;
    // older/newer telemetry definitions must not prevent an existing goal from resuming.
    if (event.kind === "goal.reported") continue;
    requireState(instant(event.at), "invalid", "Goal event timestamp is invalid.");
    if (event.kind === "goal.accepted") {
      requireState(state.goal_id === null || state.phase === "terminal" || state.phase === "stopped",
        "transition", "An active goal already owns this root.");
      requireState(text(event.goal_id) && HASH.test(event.acceptance_fingerprint) && text(event.origin_user_message_id) &&
        text(event.origin_session_id) && text(event.selected_agent) && event.budget.max_units > 0 &&
        validAcceptanceContract(event.acceptance_contract), "invalid", "Accepted goal identity is incomplete.");
      state = { ...initial(), goal_id: event.goal_id, revision: 1, scope_epoch: 1,
        acceptance_fingerprint: event.acceptance_fingerprint, origin_user_message_id: event.origin_user_message_id,
        latest_user_message_id: event.origin_user_message_id, selected_agent: event.selected_agent,
        delivery: event.delivery, budget: event.budget, acceptance_contract: event.acceptance_contract, phase: "active",
        session_ids: [event.origin_session_id] };
      replanRevision = null;
      legacyResetRevision = false;
      processDefects.clear();
      validationAdmissions.clear();
      validationSettlements.clear();
      reopenedValidationEvidence.clear();
      continue;
    }
    requireState(state.goal_id !== null && event.goal_id === state.goal_id, "transition", "Goal identity mismatch.");
    if (event.kind === "goal.user-continued") {
      requireState(state.phase !== "terminal" && text(event.origin_user_message_id) && text(event.session_id) && text(event.selected_agent), "transition", "Terminal goals cannot continue.");
      state = { ...state, latest_user_message_id: event.origin_user_message_id, selected_agent: event.selected_agent,
        session_ids: addUnique(state.session_ids, event.session_id), phase: "active", stop_reason: null, receipt: null,
        tickets: [] };
    } else if (event.kind === "goal.revised") {
       requireState(state.phase !== "terminal" && event.revision === state.revision + 1 && event.scope_epoch === state.scope_epoch + 1 &&
         HASH.test(event.acceptance_fingerprint) && event.budget.max_units >= state.consumed_units &&
         event.budget.max_units >= state.validation_budget.consumed &&
         validAcceptanceContract(event.acceptance_contract) &&
         (event.reset_no_progress === undefined || typeof event.reset_no_progress === "boolean"),
         "transition", "Scope revision is stale or resets consumed budget.");
      state = { ...state, revision: event.revision, scope_epoch: event.scope_epoch,
        acceptance_fingerprint: event.acceptance_fingerprint, latest_user_message_id: event.origin_user_message_id,
        selected_agent: event.selected_agent, delivery: event.delivery, budget: event.budget,
        validation_budget: { ...state.validation_budget,
          limit: state.validation_budget.limit === null ? null : event.budget.max_units },
        acceptance_contract: event.acceptance_contract,
        session_ids: addUnique(state.session_ids, event.session_id), phase: "active", stop_reason: null,
        receipt: null, tickets: [], ...(event.reset_no_progress === true
          ? { no_progress_results: 0, replan_required: false, replan_used: false }
          : {}) };
      if (event.reset_no_progress === true) replanRevision = null;
      legacyResetRevision = event.reset_no_progress === undefined;
    } else if (event.kind === "ticket.issued") {
      requireState(state.phase === "active" && event.revision === state.revision && event.scope_epoch === state.scope_epoch &&
        event.origin_user_message_id === state.latest_user_message_id && event.sequence === state.tickets.length + 1 &&
        !state.tickets.some((ticket) => ticket.receiving_message_id === null), "ticket", "Continuation ticket is stale, future, or duplicates an outstanding ticket.");
      state = { ...state, tickets: [...state.tickets, { ...event, receiving_message_id: null }] };
    } else if (event.kind === "ticket.consumed") {
      const ticket = state.tickets.find((candidate) => candidate.ticket_id === event.ticket_id);
      requireState(state.phase === "active" && ticket !== undefined && ticket.receiving_message_id === null &&
        ticket.session_id === event.session_id && ticket.origin_user_message_id === event.origin_user_message_id &&
        ticket.revision === state.revision && ticket.scope_epoch === state.scope_epoch, "ticket", "Continuation ticket is unknown, stale, duplicate, or cross-origin.");
      state = { ...state, tickets: state.tickets.map((candidate) => candidate.ticket_id === event.ticket_id
        ? { ...candidate, receiving_message_id: event.receiving_message_id } : candidate),
        session_ids: addUnique(state.session_ids, event.session_id) };
    } else if (event.kind === "dispatch.reserved") {
      // A short-lived pre-marker runtime reset no-progress on revision but persisted no flag.
      // A later accepted dispatch proves that reset; older revisions followed by an explicit
      // replan retain their original semantics.
      if (legacyResetRevision && state.replan_required && state.replan_used && replanRevision !== null && state.revision > replanRevision) {
        state = { ...state, no_progress_results: 0, replan_required: false, replan_used: false };
        replanRevision = null;
      }
      requireState(state.phase === "active" && !state.replan_required, "transition", "Dispatch requires terminal handling or one bounded replan.");
      requireState(state.budget !== null && state.consumed_units + state.outstanding_reservations.length < state.budget.max_units, "budget", "Goal unit budget exhausted.");
      requireState(state.budget.time_ms === null || (state.consumed_time_ms !== null && state.consumed_time_ms < state.budget.time_ms), "budget", "Goal time budget is exhausted or usage is unknown.");
      requireState(state.budget.cost_usd === null || (state.consumed_cost_usd !== null && state.consumed_cost_usd < state.budget.cost_usd), "budget", "Goal cost budget is exhausted or usage is unknown.");
      requireState(!state.outstanding_reservations.some((entry) => entry.reservation_id === event.reservation_id), "transition", "Dispatch reservation already exists.");
      if (event.ticket_id !== null) requireState(state.tickets.some((ticket) => ticket.ticket_id === event.ticket_id && ticket.receiving_message_id !== null), "ticket", "Dispatch ticket was not consumed.");
      state = { ...state, outstanding_reservations: [...state.outstanding_reservations,
        { reservation_id: event.reservation_id, unit_id: event.unit_id, session_id: event.session_id }],
        session_ids: addUnique(state.session_ids, event.session_id) };
    } else if (event.kind === "unit.settled") {
      const reservation = state.outstanding_reservations.find((entry) => entry.reservation_id === event.reservation_id);
      requireState(reservation?.unit_id === event.unit_id, "transition", "Unit settlement is unknown or duplicate.");
      requireState(event.evidence.every((entry) => validGoalEvidence(entry, state)), "evidence", "Unit evidence is not bound to the current goal revision.");
      requireState(event.evidence.every((entry) => entry.execution.units.includes(event.unit_id)), "evidence", "Unit evidence does not identify its reserved unit.");
      const newCriteria = event.evidence.flatMap((entry) => entry.measurement.criterion_ids)
        .filter((criterionID) => !state.satisfied_criteria.includes(criterionID));
      const progress = newCriteria.length > 0;
      requireState(event.progress_fingerprint === (progress ? goalFingerprint(event.evidence) : null), "evidence", "Progress fingerprint does not represent newly accepted evidence.");
      const acceptanceFailure = event.disposition === "failed" &&
        (event.result_class === undefined || event.result_class === "acceptance");
      const nextNoProgress = progress ? 0 : acceptanceFailure
        ? state.no_progress_results + 1
        : state.no_progress_results;
      const elapsed = state.consumed_time_ms === null || event.elapsed_ms === null ? null : state.consumed_time_ms + event.elapsed_ms;
      const cost = state.consumed_cost_usd === null || event.cost_usd === null ? null : state.consumed_cost_usd + event.cost_usd;
      state = { ...state, consumed_units: state.consumed_units + 1, consumed_time_ms: elapsed, consumed_cost_usd: cost,
        no_progress_results: nextNoProgress, replan_required: nextNoProgress >= 2,
        outstanding_reservations: state.outstanding_reservations.filter((entry) => entry.reservation_id !== event.reservation_id),
        unit_ids: addUnique(state.unit_ids, event.unit_id),
        evidence_refs: event.evidence.reduce((refs, evidence) => addUnique(refs, evidence.evidence_id), state.evidence_refs),
        satisfied_criteria: event.evidence.reduce((ids, evidence) => evidence.measurement.criterion_ids.reduce(addUnique, ids), state.satisfied_criteria) };
      if (event.result_class === "process-defect" && event.evidence.length === 0 && event.disposition !== "cancelled") {
        processDefects.set(event.receipt_id, { unitID: event.unit_id, revision: state.revision, epoch: state.scope_epoch });
      }
    } else if (event.kind === "unit.evidence-reconciled") {
      const old = processDefects.get(event.previous_receipt_id);
      requireState(state.phase === "active" && state.receipt === null && old?.unitID === event.unit_id &&
        old.revision === state.revision && old.epoch === state.scope_epoch && state.outstanding_reservations.length === 0,
        "transition", "Evidence reconciliation requires a current settled process defect.");
      requireState(event.evidence.length > 0 && event.evidence.every(entry => validGoalEvidence(entry, state) && entry.execution.units.includes(event.unit_id)),
        "evidence", "Reconciled evidence must retain the current goal and unit identity.");
      processDefects.delete(event.previous_receipt_id);
      state = { ...state, evidence_refs: event.evidence.reduce((refs, evidence) => addUnique(refs, evidence.evidence_id), state.evidence_refs),
        satisfied_criteria: event.evidence.reduce((ids, evidence) => evidence.measurement.criterion_ids.reduce(addUnique, ids), state.satisfied_criteria) };
    } else if (event.kind === "validation.admission") {
      requireState(event.limit > 0 && Number.isSafeInteger(event.limit) && Number.isSafeInteger(event.consumed) &&
        event.consumed >= 0 && event.consumed <= event.limit && event.operation_id.length > 0 && event.evidence_key.length > 0,
        "invalid", "Validation admission is malformed.");
      if (event.decision === "ALLOW") {
        const reopen = event.reopen;
        const prior = reopen === undefined ? undefined : validationAdmissions.get(reopen.prior_reservation_id);
        const settlement = reopen === undefined ? undefined : validationSettlements.get(reopen.prior_reservation_id);
        const validReopen = reopen !== undefined && reopen.authority === "operator-repair-validation-retry" &&
          text(reopen.operator_run_id) && text(reopen.unit_id) && Number.isSafeInteger(reopen.operator_generation) &&
          reopen.operator_generation > 0 && /^[a-f0-9]{64}$/u.test(reopen.plan_hash) && HASH.test(reopen.control_hash) &&
          reopen.goal_fingerprint === state.acceptance_fingerprint && HASH.test(reopen.repair_fingerprint) &&
          prior?.decision === "ALLOW" && prior.evidence_key === event.evidence_key && prior.operation_id === reopen.prior_operation_id &&
          settlement?.operation_id === reopen.prior_operation_id && settlement.evidence_key === event.evidence_key &&
          settlement.outcome === "interrupted" && event.operation_id !== reopen.prior_operation_id &&
          !reopenedValidationEvidence.has(event.evidence_key);
        const duplicate = state.validation_budget.evidence_keys.includes(event.evidence_key);
        const inFlight = state.validation_budget.reservations.some((entry) => entry.evidence_key === event.evidence_key);
        const blocked = [...validationSettlements.values()].some((entry) =>
          entry.evidence_key === event.evidence_key && entry.outcome !== "passed");
        requireState(event.scope !== null && event.consumed === state.validation_budget.consumed + 1 &&
          (state.validation_budget.limit === null || event.limit >= state.validation_budget.limit) &&
          ((!duplicate && !blocked && !inFlight && reopen === undefined) || (validReopen && !inFlight)) &&
          !state.validation_budget.reservations.some((entry) => entry.reservation_id === event.reservation_id),
          "budget", "Validation admission is stale, duplicated, or exhausted.");
        state = { ...state, validation_budget: { ...state.validation_budget, consumed: event.consumed, limit: event.limit,
          reservations: [...state.validation_budget.reservations,
            { reservation_id: event.reservation_id, operation_id: event.operation_id, evidence_key: event.evidence_key }] } };
        validationAdmissions.set(event.reservation_id, event);
        if (reopen !== undefined) reopenedValidationEvidence.add(event.evidence_key);
      } else {
        requireState(event.reopen === undefined && event.consumed === state.validation_budget.consumed,
          "invalid", "Skipped or denied validation cannot carry reopen authority or consume budget.");
        const saved = event.saved_ms ?? 0;
        requireState(Number.isSafeInteger(saved) && saved >= 0, "invalid", "Validation saved duration is invalid.");
        if (event.decision === "SKIP") {
          requireState(state.validation_budget.evidence_keys.includes(event.evidence_key) &&
            !state.validation_budget.reservations.some((entry) => entry.evidence_key === event.evidence_key) && event.scope !== null,
            "evidence", "Skipped validation must reference existing unchanged evidence.");
          state = { ...state, validation_budget: { ...state.validation_budget,
            skipped: state.validation_budget.skipped + 1,
            redundant_time_ms: state.validation_budget.redundant_time_ms + saved } };
        } else {
          requireState(saved === 0, "invalid", "Rejected validation cannot claim saved execution time.");
          state = { ...state, validation_budget: { ...state.validation_budget,
            rejected: state.validation_budget.rejected + 1 } };
        }
      }
    } else if (event.kind === "validation.settled") {
      const reservation = state.validation_budget.reservations.find((entry) => entry.reservation_id === event.reservation_id);
      requireState(reservation?.operation_id === event.operation_id && reservation.evidence_key === event.evidence_key,
        "transition", "Validation settlement is unknown or mismatched.");
      requireState((event.evidence_fingerprint === undefined || HASH.test(event.evidence_fingerprint)) &&
        (event.duration_ms === undefined || Number.isSafeInteger(event.duration_ms) && event.duration_ms >= 0) &&
        (event.reason === undefined || text(event.reason)) && (event.outcome !== "passed" || event.exit_code === 0),
        "invalid", "Validation settlement evidence is malformed.");
      state = { ...state, validation_budget: { ...state.validation_budget,
        evidence_keys: event.outcome === "passed" ? addUnique(state.validation_budget.evidence_keys, event.evidence_key) : state.validation_budget.evidence_keys,
        completed: state.validation_budget.completed + 1,
        durations_ms: event.outcome !== "passed" || event.exit_code !== 0 || event.duration_ms === undefined
          ? state.validation_budget.durations_ms : [...state.validation_budget.durations_ms, event.duration_ms],
        reservations: state.validation_budget.reservations.filter((entry) => entry.reservation_id !== event.reservation_id) } };
      validationSettlements.set(event.reservation_id, event);
    } else if (event.kind === "goal.replanned") {
      requireState(state.phase === "active" && state.replan_required && !state.replan_used && event.revision === state.revision, "transition", "Bounded replan is unavailable.");
      state = { ...state, replan_used: true, replan_required: false, no_progress_results: 0 };
      replanRevision = event.revision;
    } else if (event.kind === "goal.terminal") {
      const allAccepted = state.acceptance_contract !== null && state.acceptance_contract.criteria.every(({ criterion_id }) =>
        state.satisfied_criteria.includes(criterion_id));
      requireState(state.phase !== "terminal" && state.outstanding_reservations.length === 0 && event.receipt.goal_id === state.goal_id &&
        event.receipt.terminal_revision === state.revision && event.receipt.acceptance_fingerprint === state.acceptance_fingerprint &&
        event.receipt.unit_ids.every((id) => state.unit_ids.includes(id)) && event.receipt.session_ids.every((id) => state.session_ids.includes(id)) &&
        event.receipt.evidence_refs.every((id) => state.evidence_refs.includes(id)) &&
        (event.receipt.status !== "succeeded" || (event.receipt.stop_reason === "completed" && allAccepted && !state.replan_required)) &&
        (event.receipt.status !== "stopped" || event.receipt.stop_reason !== "completed"), "transition", "Terminal receipt is not bound to settled goal state.");
      state = { ...state, phase: event.receipt.status === "succeeded" ? "terminal" : "stopped",
        stop_reason: event.receipt.stop_reason, tickets: [], receipt: event.receipt };
    }
  }
  return state;
}
