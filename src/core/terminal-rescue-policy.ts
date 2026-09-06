import type {
  FailureCategory,
  FlightBudgetLimits,
  FlightRole,
  RecoveryKind,
} from "./run-flight-ledger.js";
import {
  reconcileChildTerminal,
  type ChildTerminalIdentity,
  type ChildTerminalReconciliationInput,
} from "./child-terminal-reconciliation.js";

export interface TerminalRescueTarget {
  readonly model: string;
  readonly variant: string | null;
}

export interface TerminalRescueResourceBudget {
  readonly time_ms: number;
  readonly cost_usd: number;
}

export interface TerminalRescueBudget {
  readonly counters: FlightBudgetLimits;
  readonly resources: TerminalRescueResourceBudget;
}

export interface TerminalRescueAcceptedBase {
  readonly candidate_id: string;
  readonly contract_id: string;
  readonly scope: readonly string[];
  readonly acceptance: readonly string[];
  readonly validation: readonly string[];
}

export interface TerminalRescuePriorAttempt {
  readonly identity: ChildTerminalIdentity;
  readonly role: FlightRole;
  readonly recovery_kind: RecoveryKind | "implementation";
  readonly disposition: "continue" | "succeeded" | "failed" | "cancelled";
  readonly failure: {
    readonly category: FailureCategory | "unknown";
    readonly code: string;
  } | null;
}

export interface TerminalRescuePolicyInput {
  readonly prior_attempt: TerminalRescuePriorAttempt;
  /** The authoritative evidence input consumed by reconcileChildTerminal; not a self-reported boolean. */
  readonly terminal_reconciliation: ChildTerminalReconciliationInput;
  readonly accepted_base: TerminalRescueAcceptedBase;
  /** Null means the caller could not resolve an available rescue target. */
  readonly available_target: TerminalRescueTarget | null;
  readonly explicit_override: boolean;
  readonly unit_rescue_count: number;
  readonly active_run_rescue_count: number;
  readonly budget_limits: TerminalRescueBudget;
  readonly budget_consumed: TerminalRescueBudget;
  readonly budget_request: TerminalRescueBudget;
}

export type TerminalRescueNonRescueReason =
  | "invalid_input"
  | "prior_executor_not_normal_worker"
  | "normal_remediation_not_exhausted"
  | "prior_attempt_not_failed"
  | "terminal_not_reconciled"
  | "terminal_identity_conflict"
  | "infrastructure_failure"
  | "authorization_failure"
  | "contract_failure"
  | "cancellation_failure"
  | "unknown_failure"
  | "target_unavailable"
  | "explicit_override"
  | "unit_rescue_already_used"
  | "run_rescue_active"
  | "budget_exhausted";

export interface TerminalRescueProposal {
  readonly kind: "terminal_rescue_proposal";
  readonly target: TerminalRescueTarget;
  readonly accepted_base_candidate_id: string;
  readonly contract_id: string;
  readonly scope: readonly string[];
  readonly acceptance: readonly string[];
  readonly validation: readonly string[];
  readonly predecessor_identity: ChildTerminalIdentity;
  readonly budget_request: TerminalRescueBudget;
  readonly obligations: readonly [
    "stop_confirmed",
    "writer_exclusive",
    "final_validation",
    "final_review",
    "candidate_cas",
  ];
}

export type TerminalRescuePolicyResult =
  | { readonly status: "proposed"; readonly proposal: TerminalRescueProposal }
  | { readonly status: "non_rescue"; readonly reason: TerminalRescueNonRescueReason };

const COUNTERS: readonly (keyof FlightBudgetLimits)[] = ["recovery_actions", "probe_iterations", "model_attempts"];
const IDENTITY_FIELDS: readonly (keyof ChildTerminalIdentity)[] = [
  "run_id", "unit_id", "attempt_id", "predecessor_attempt_id", "candidate_id", "route_id", "child_id", "call_id",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonRescue(reason: TerminalRescueNonRescueReason): TerminalRescuePolicyResult {
  return { status: "non_rescue", reason };
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validCounters(value: unknown): value is FlightBudgetLimits {
  return isRecord(value) && COUNTERS.every((key) => safeNonNegativeInteger(value[key]));
}

function validResources(value: unknown): value is TerminalRescueResourceBudget {
  return isRecord(value) && safeNonNegativeInteger(value.time_ms) && finiteNonNegative(value.cost_usd);
}

function validBudget(value: unknown): value is TerminalRescueBudget {
  return isRecord(value) && validCounters(value.counters) && validResources(value.resources);
}

function validStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text);
}

function validAcceptedBase(value: unknown): value is TerminalRescueAcceptedBase {
  return isRecord(value) && text(value.candidate_id) && text(value.contract_id) &&
    validStringList(value.scope) && validStringList(value.acceptance) && validStringList(value.validation);
}

function validTarget(value: unknown): value is TerminalRescueTarget {
  return isRecord(value) && text(value.model) && (value.variant === null || text(value.variant));
}

function validIdentity(value: unknown): value is ChildTerminalIdentity {
  if (!isRecord(value)) return false;
  return IDENTITY_FIELDS.every((field) => field === "predecessor_attempt_id"
    ? value[field] === null || text(value[field])
    : text(value[field]));
}

function sameIdentity(left: ChildTerminalIdentity, right: ChildTerminalIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function validPriorAttempt(value: unknown): value is TerminalRescuePriorAttempt {
  if (!isRecord(value) || !validIdentity(value.identity) ||
    !["implementation", "review", "advice", "rescue"].includes(value.role as string) ||
    !["implementation", "normal_remediation", "adaptive_probe", "read_only_diagnosis", "model_rescue"].includes(value.recovery_kind as string) ||
    !["continue", "succeeded", "failed", "cancelled"].includes(value.disposition as string)) return false;
  if (value.failure === null) return true;
  return isRecord(value.failure) &&
    ["infrastructure", "authorization", "contract", "cancellation", "implementation", "unknown"].includes(value.failure.category as string) &&
    text(value.failure.code);
}

function budgetFits(limits: TerminalRescueBudget, consumed: TerminalRescueBudget, request: TerminalRescueBudget): boolean {
  for (const key of COUNTERS) {
    const total = consumed.counters[key] + request.counters[key];
    if (!Number.isSafeInteger(total) || total > limits.counters[key]) return false;
  }
  const time = consumed.resources.time_ms + request.resources.time_ms;
  const cost = consumed.resources.cost_usd + request.resources.cost_usd;
  return Number.isSafeInteger(time) && time <= limits.resources.time_ms &&
    Number.isFinite(cost) && cost <= limits.resources.cost_usd;
}

function frozenIdentity(identity: ChildTerminalIdentity): ChildTerminalIdentity {
  return Object.freeze({ ...identity });
}

function frozenBudget(budget: TerminalRescueBudget): TerminalRescueBudget {
  return Object.freeze({ counters: Object.freeze({ ...budget.counters }), resources: Object.freeze({ ...budget.resources }) });
}

/**
 * Pure reservation advice only. The runtime retains dispatch/cancellation authority, confirms budget
 * consumption, starts from the accepted base, and performs stop/writer/validation/review/CAS obligations.
 */
export function proposeTerminalRescue(input: unknown): TerminalRescuePolicyResult {
  if (!isRecord(input) || !validPriorAttempt(input.prior_attempt) ||
    !validAcceptedBase(input.accepted_base) ||
    !(input.available_target === null || validTarget(input.available_target)) ||
    typeof input.explicit_override !== "boolean" ||
    !safeNonNegativeInteger(input.unit_rescue_count) || !safeNonNegativeInteger(input.active_run_rescue_count) ||
    !validBudget(input.budget_limits) || !validBudget(input.budget_consumed) || !validBudget(input.budget_request)) {
    return nonRescue("invalid_input");
  }

  const prior = input.prior_attempt;
  if (prior.role !== "implementation") return nonRescue("prior_executor_not_normal_worker");
  if (prior.recovery_kind !== "normal_remediation") return nonRescue("normal_remediation_not_exhausted");
  if (prior.disposition !== "failed") return nonRescue(prior.disposition === "cancelled" ? "cancellation_failure" : "prior_attempt_not_failed");
  if (!isRecord(input.terminal_reconciliation)) return nonRescue("terminal_not_reconciled");
  const terminal = reconcileChildTerminal(input.terminal_reconciliation);
  if (!validIdentity(input.terminal_reconciliation.current) || !sameIdentity(prior.identity, input.terminal_reconciliation.current)) {
    return nonRescue("terminal_identity_conflict");
  }
  if (!isRecord(input.terminal_reconciliation.observation) ||
    input.terminal_reconciliation.observation.disposition !== prior.disposition) {
    return nonRescue("terminal_identity_conflict");
  }
  if (terminal.status !== "ready") return nonRescue("terminal_not_reconciled");

  const category = prior.failure?.category ?? "unknown";
  if (category === "infrastructure") return nonRescue("infrastructure_failure");
  if (category === "authorization") return nonRescue("authorization_failure");
  if (category === "contract") return nonRescue("contract_failure");
  if (category === "cancellation") return nonRescue("cancellation_failure");
  if (category === "unknown") return nonRescue("unknown_failure");
  if (input.explicit_override) return nonRescue("explicit_override");
  if (input.available_target === null) return nonRescue("target_unavailable");
  if (input.unit_rescue_count > 0) return nonRescue("unit_rescue_already_used");
  if (input.active_run_rescue_count > 0) return nonRescue("run_rescue_active");
  if (input.budget_request.counters.recovery_actions === 0 || input.budget_request.counters.model_attempts === 0) {
    return nonRescue("invalid_input");
  }
  if (!budgetFits(input.budget_limits, input.budget_consumed, input.budget_request)) return nonRescue("budget_exhausted");

  const base = input.accepted_base;
  const obligations = Object.freeze([
    "stop_confirmed", "writer_exclusive", "final_validation", "final_review", "candidate_cas",
  ] as const);
  const proposal: TerminalRescueProposal = Object.freeze({
    kind: "terminal_rescue_proposal",
    target: Object.freeze({ ...input.available_target }),
    accepted_base_candidate_id: base.candidate_id,
    contract_id: base.contract_id,
    scope: Object.freeze([...base.scope]),
    acceptance: Object.freeze([...base.acceptance]),
    validation: Object.freeze([...base.validation]),
    predecessor_identity: frozenIdentity(prior.identity),
    budget_request: frozenBudget(input.budget_request),
    obligations,
  });
  return Object.freeze({ status: "proposed", proposal });
}
