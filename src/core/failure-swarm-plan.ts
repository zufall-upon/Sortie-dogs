import type { FlightBudgetCharge, FlightBudgetLimits, RecoveryKind } from "./run-flight-ledger.js";

const MAX_IDENTITY_LENGTH = 256;

export interface FailureSwarmIdentity {
  readonly run_id: string;
  readonly unit_id: string;
  readonly attempt_id: string;
  readonly candidate_id: string;
}

export interface FailureSwarmLane {
  readonly lane_id: string;
  readonly access: "read_only" | "write";
  readonly available: boolean;
}

export interface FailureSwarmPlanInput {
  readonly identity: FailureSwarmIdentity;
  readonly remediation_status: "pending" | "completed";
  readonly canonical_result: "not_run" | "passed" | "failed";
  readonly cause: "known" | "unknown";
  readonly origin: "implementation" | "read_only_diagnosis";
  readonly prior_diagnosis_attempts: readonly FailureSwarmIdentity[];
  readonly causal_classes: readonly string[];
  readonly lanes: readonly FailureSwarmLane[];
  readonly max_lanes: number;
  readonly per_lane_budget_charge: FlightBudgetCharge;
  readonly budget_limits: FlightBudgetLimits;
  readonly budget_consumed: FlightBudgetLimits;
}

export interface FailureSwarmAssignment {
  readonly causal_class: string;
  readonly lane_id: string;
}

export interface FailureSwarmPlan {
  readonly identity: FailureSwarmIdentity;
  readonly recovery_kind: Extract<RecoveryKind, "read_only_diagnosis">;
  readonly assignments: readonly FailureSwarmAssignment[];
  readonly budget_reservation: {
    readonly status: "requested";
    readonly charge: FlightBudgetCharge;
    readonly remaining_after_reservation: FlightBudgetLimits;
  };
  readonly runtime_responsibilities: {
    readonly persist_attempt_history: true;
    readonly reserve_budget: true;
    readonly dispatch_read_only_lanes: true;
    readonly execute_diagnosis: true;
    readonly accept_diagnosis_results: true;
  };
}

export type FailureSwarmNonPlanReason =
  | "remediation_not_completed"
  | "canonical_failure_absent"
  | "cause_already_known"
  | "recursive_diagnosis"
  | "attempt_already_diagnosed"
  | "no_diagnosis_capacity";

export type FailureSwarmPlanOutcome =
  | { readonly status: "not_planned"; readonly reason: FailureSwarmNonPlanReason }
  | { readonly status: "rejected"; readonly reason: "invalid_input" | "invalid_identity" | "invalid_budget" | "budget_exceeded" }
  | { readonly status: "planned"; readonly plan: FailureSwarmPlan };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const isIdentityPart = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH && value.trim() === value;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function isIdentity(value: unknown): value is FailureSwarmIdentity {
  return isObject(value) && hasOnly(value, ["run_id", "unit_id", "attempt_id", "candidate_id"]) &&
    isIdentityPart(value.run_id) && isIdentityPart(value.unit_id) && isIdentityPart(value.attempt_id) &&
    isIdentityPart(value.candidate_id);
}

function isLane(value: unknown): value is FailureSwarmLane {
  return isObject(value) && hasOnly(value, ["lane_id", "access", "available"]) &&
    isIdentityPart(value.lane_id) && (value.access === "read_only" || value.access === "write") &&
    typeof value.available === "boolean";
}

function isBudget(value: unknown): value is FlightBudgetLimits {
  return isObject(value) && hasOnly(value, ["recovery_actions", "probe_iterations", "model_attempts"]) &&
    isCount(value.recovery_actions) && isCount(value.probe_iterations) && isCount(value.model_attempts);
}

function isPerLaneCharge(value: unknown): value is FlightBudgetCharge {
  return isObject(value) && hasOnly(value, ["kind", "recovery_actions", "probe_iterations", "model_attempts"]) &&
    value.kind === "read_only_diagnosis" && isCount(value.recovery_actions) && Number(value.recovery_actions) > 0 &&
    isCount(value.probe_iterations) && isCount(value.model_attempts);
}

function sameIdentity(left: FailureSwarmIdentity, right: FailureSwarmIdentity): boolean {
  return left.run_id === right.run_id && left.unit_id === right.unit_id && left.attempt_id === right.attempt_id &&
    left.candidate_id === right.candidate_id;
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function multiplyCount(value: number, count: number): number | null {
  const total = value * count;
  return Number.isSafeInteger(total) ? total : null;
}

function reserve(consumed: number, requested: number, limit: number): { used: number; remaining: number } | null {
  const used = consumed + requested;
  return Number.isSafeInteger(used) && used <= limit ? { used, remaining: limit - used } : null;
}

/**
 * Builds an inert, deterministic read-only diagnosis proposal. The caller must persist history,
 * reserve the requested budget, dispatch the lanes, execute diagnosis, and accept its results.
 */
export function planFailureSwarm(input: unknown): FailureSwarmPlanOutcome {
  if (!isObject(input) || !hasOnly(input, [
    "identity", "remediation_status", "canonical_result", "cause", "origin", "prior_diagnosis_attempts",
    "causal_classes", "lanes", "max_lanes", "per_lane_budget_charge", "budget_limits", "budget_consumed",
  ]) || !["pending", "completed"].includes(String(input.remediation_status)) ||
    !["not_run", "passed", "failed"].includes(String(input.canonical_result)) ||
    !["known", "unknown"].includes(String(input.cause)) ||
    !["implementation", "read_only_diagnosis"].includes(String(input.origin)) ||
    !Array.isArray(input.prior_diagnosis_attempts) || !Array.isArray(input.causal_classes) ||
    !Array.isArray(input.lanes) || !isCount(input.max_lanes)) {
    return { status: "rejected", reason: "invalid_input" };
  }
  if (!isIdentity(input.identity) || !input.prior_diagnosis_attempts.every(isIdentity)) {
    return { status: "rejected", reason: "invalid_identity" };
  }
  const currentIdentity = input.identity;
  if (!input.causal_classes.every(isIdentityPart) || !input.lanes.every(isLane)) {
    return { status: "rejected", reason: "invalid_input" };
  }
  const laneIds = input.lanes.map((lane) => lane.lane_id);
  const historyIds = input.prior_diagnosis_attempts.map((identity) =>
    `${identity.run_id}\u0000${identity.unit_id}\u0000${identity.attempt_id}\u0000${identity.candidate_id}`);
  if (duplicate(input.causal_classes) || duplicate(laneIds) || duplicate(historyIds)) {
    return { status: "rejected", reason: "invalid_identity" };
  }
  if (!isBudget(input.budget_limits) || !isBudget(input.budget_consumed) ||
    !isPerLaneCharge(input.per_lane_budget_charge) ||
    input.budget_consumed.recovery_actions > input.budget_limits.recovery_actions ||
    input.budget_consumed.probe_iterations > input.budget_limits.probe_iterations ||
    input.budget_consumed.model_attempts > input.budget_limits.model_attempts) {
    return { status: "rejected", reason: "invalid_budget" };
  }

  if (input.remediation_status !== "completed") return { status: "not_planned", reason: "remediation_not_completed" };
  if (input.canonical_result !== "failed") return { status: "not_planned", reason: "canonical_failure_absent" };
  if (input.cause !== "unknown") return { status: "not_planned", reason: "cause_already_known" };
  if (input.origin === "read_only_diagnosis") return { status: "not_planned", reason: "recursive_diagnosis" };
  if (input.prior_diagnosis_attempts.some((identity) => sameIdentity(identity, currentIdentity))) {
    return { status: "not_planned", reason: "attempt_already_diagnosed" };
  }

  const causalClasses = [...input.causal_classes].sort();
  const lanes = input.lanes.filter((lane) => lane.available && lane.access === "read_only")
    .map((lane) => lane.lane_id).sort();
  const assignmentCount = Math.min(causalClasses.length, lanes.length, input.max_lanes);
  if (assignmentCount === 0) return { status: "not_planned", reason: "no_diagnosis_capacity" };

  const recoveryActions = multiplyCount(input.per_lane_budget_charge.recovery_actions, assignmentCount);
  const probeIterations = multiplyCount(input.per_lane_budget_charge.probe_iterations, assignmentCount);
  const modelAttempts = multiplyCount(input.per_lane_budget_charge.model_attempts, assignmentCount);
  if (recoveryActions === null || probeIterations === null || modelAttempts === null) {
    return { status: "rejected", reason: "invalid_budget" };
  }
  const recoveryReservation = reserve(input.budget_consumed.recovery_actions, recoveryActions, input.budget_limits.recovery_actions);
  const probeReservation = reserve(input.budget_consumed.probe_iterations, probeIterations, input.budget_limits.probe_iterations);
  const modelReservation = reserve(input.budget_consumed.model_attempts, modelAttempts, input.budget_limits.model_attempts);
  if (recoveryReservation === null || probeReservation === null || modelReservation === null) {
    return { status: "rejected", reason: "budget_exceeded" };
  }

  return {
    status: "planned",
    plan: {
      identity: { ...currentIdentity },
      recovery_kind: "read_only_diagnosis",
      assignments: causalClasses.slice(0, assignmentCount).map((causalClass, index) => ({
        causal_class: causalClass,
        lane_id: lanes[index]!,
      })),
      budget_reservation: {
        status: "requested",
        charge: {
          kind: "read_only_diagnosis",
          recovery_actions: recoveryActions,
          probe_iterations: probeIterations,
          model_attempts: modelAttempts,
        },
        remaining_after_reservation: {
          recovery_actions: recoveryReservation.remaining,
          probe_iterations: probeReservation.remaining,
          model_attempts: modelReservation.remaining,
        },
      },
      runtime_responsibilities: {
        persist_attempt_history: true,
        reserve_budget: true,
        dispatch_read_only_lanes: true,
        execute_diagnosis: true,
        accept_diagnosis_results: true,
      },
    },
  };
}
