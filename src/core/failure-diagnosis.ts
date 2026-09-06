import type { FlightBudgetCharge, FlightBudgetLimits, RecoveryKind } from "./run-flight-ledger.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_TEXT = 1000;
const RECOVERY_KINDS: readonly RecoveryKind[] = [
  "normal_remediation",
  "adaptive_probe",
  "read_only_diagnosis",
  "model_rescue",
];

export interface FailureDiagnosisCandidate {
  readonly diagnosis_id: string;
  readonly capsule_id: string;
  readonly recovery_kind: RecoveryKind;
  readonly proposal: string;
  readonly budget_request: FlightBudgetCharge;
}

export interface FailureDiagnosisSelection {
  readonly diagnosis_id: string;
  readonly capsule_id: string;
}

export interface FailureDiagnosisInput {
  readonly candidates: readonly FailureDiagnosisCandidate[];
  readonly coordinator_selection: FailureDiagnosisSelection | null;
  readonly budget_limits: FlightBudgetLimits;
  readonly budget_consumed: FlightBudgetLimits;
}

export interface FailureDiagnosisProposal {
  readonly diagnosis_id: string;
  readonly capsule_id: string;
  readonly recovery_kind: RecoveryKind;
  readonly proposal: string;
  readonly budget_reservation: {
    readonly status: "requested";
    readonly charge: FlightBudgetCharge;
    readonly remaining_after_reservation: FlightBudgetLimits;
  };
  readonly runtime_responsibilities: {
    readonly capsule_validation: true;
    readonly duplicate_execution_suppression: true;
  };
}

export type FailureDiagnosisOutcome =
  | { readonly status: "selection_required"; readonly reason: "coordinator_selection_missing" }
  | { readonly status: "rejected"; readonly reason: "invalid_input" | "invalid_selection" | "invalid_budget" | "budget_exceeded" }
  | { readonly status: "proposed"; readonly proposal: FailureDiagnosisProposal };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const isText = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function isBudget(value: unknown): value is FlightBudgetLimits {
  return isObject(value) && hasOnly(value, ["recovery_actions", "probe_iterations", "model_attempts"]) &&
    isCount(value.recovery_actions) && isCount(value.probe_iterations) && isCount(value.model_attempts);
}

function isCharge(value: unknown): value is FlightBudgetCharge {
  return isObject(value) && hasOnly(value, ["kind", "recovery_actions", "probe_iterations", "model_attempts"]) &&
    typeof value.kind === "string" && RECOVERY_KINDS.includes(value.kind as RecoveryKind) &&
    isCount(value.recovery_actions) && isCount(value.probe_iterations) && isCount(value.model_attempts) &&
    Number(value.recovery_actions) > 0;
}

function isCandidate(value: unknown): value is FailureDiagnosisCandidate {
  return isObject(value) && hasOnly(value, ["diagnosis_id", "capsule_id", "recovery_kind", "proposal", "budget_request"]) &&
    isText(value.diagnosis_id) && typeof value.capsule_id === "string" && HASH_PATTERN.test(value.capsule_id) &&
    typeof value.recovery_kind === "string" && RECOVERY_KINDS.includes(value.recovery_kind as RecoveryKind) &&
    isText(value.proposal, MAX_TEXT) && isCharge(value.budget_request) && value.budget_request.kind === value.recovery_kind;
}

function isSelection(value: unknown): value is FailureDiagnosisSelection {
  return isObject(value) && hasOnly(value, ["diagnosis_id", "capsule_id"]) && isText(value.diagnosis_id) &&
    typeof value.capsule_id === "string" && HASH_PATTERN.test(value.capsule_id);
}

function addWithinLimit(consumed: number, requested: number, limit: number): number | null {
  const total = consumed + requested;
  return Number.isSafeInteger(total) && total <= limit ? total : null;
}

/**
 * Converts one explicit coordinator selection into one inert proposal. The caller remains responsible
 * for evidence-capsule validation, duplicate execution suppression, reservation, and execution.
 */
export function diagnoseFailure(input: unknown): FailureDiagnosisOutcome {
  if (!isObject(input) || !hasOnly(input, ["candidates", "coordinator_selection", "budget_limits", "budget_consumed"]) ||
    !Array.isArray(input.candidates) || input.candidates.length === 0 || !input.candidates.every(isCandidate)) {
    return { status: "rejected", reason: "invalid_input" };
  }
  if (!isBudget(input.budget_limits) || !isBudget(input.budget_consumed)) {
    return { status: "rejected", reason: "invalid_budget" };
  }
  if (input.coordinator_selection === null) {
    return { status: "selection_required", reason: "coordinator_selection_missing" };
  }
  if (!isSelection(input.coordinator_selection)) return { status: "rejected", reason: "invalid_selection" };
  const selection = input.coordinator_selection;

  const ids = new Set<string>();
  const duplicateIdentity = input.candidates.some((candidate) => {
    const identity = `${candidate.diagnosis_id}\u0000${candidate.capsule_id}`;
    if (ids.has(identity)) return true;
    ids.add(identity);
    return false;
  });
  const matches = input.candidates.filter((candidate) =>
    candidate.diagnosis_id === selection.diagnosis_id && candidate.capsule_id === selection.capsule_id);
  if (duplicateIdentity || matches.length !== 1) return { status: "rejected", reason: "invalid_selection" };

  const selected = matches[0]!;
  const recoveryActions = addWithinLimit(input.budget_consumed.recovery_actions, selected.budget_request.recovery_actions, input.budget_limits.recovery_actions);
  const probeIterations = addWithinLimit(input.budget_consumed.probe_iterations, selected.budget_request.probe_iterations, input.budget_limits.probe_iterations);
  const modelAttempts = addWithinLimit(input.budget_consumed.model_attempts, selected.budget_request.model_attempts, input.budget_limits.model_attempts);
  if (recoveryActions === null || probeIterations === null || modelAttempts === null) {
    return { status: "rejected", reason: "budget_exceeded" };
  }

  return {
    status: "proposed",
    proposal: {
      diagnosis_id: selected.diagnosis_id,
      capsule_id: selected.capsule_id,
      recovery_kind: selected.recovery_kind,
      proposal: selected.proposal,
      budget_reservation: {
        status: "requested",
        charge: { ...selected.budget_request },
        remaining_after_reservation: {
          recovery_actions: input.budget_limits.recovery_actions - recoveryActions,
          probe_iterations: input.budget_limits.probe_iterations - probeIterations,
          model_attempts: input.budget_limits.model_attempts - modelAttempts,
        },
      },
      runtime_responsibilities: { capsule_validation: true, duplicate_execution_suppression: true },
    },
  };
}
