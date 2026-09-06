import {
  reconcileChildTerminal,
  type ChildTerminalEvidence,
  type ChildTerminalIdentity,
  type ChildTerminalObservation,
  type ChildTerminalReconciliationReason,
} from "./child-terminal-reconciliation.js";

export interface ChildCancellationPlanInput {
  readonly current: ChildTerminalIdentity;
  readonly observation: ChildTerminalObservation;
  readonly evidence: ChildTerminalEvidence;
  readonly settled_fingerprint?: string | null;
  /** Caller-supplied monotonic or wall-clock milliseconds. Must share a clock domain with now_ms. */
  readonly deadline_ms: number;
  /** Caller-supplied current time; this planner never reads a clock. */
  readonly now_ms: number;
  readonly cancellation_requested: boolean;
  /** Durable stop-request history. Exact identity matching provides replay suppression. */
  readonly prior_stop_requests: readonly ChildTerminalIdentity[];
}

export type ChildCancellationTrigger = "deadline_expired" | "explicit_cancellation";

export interface ChildCancellationStopProposal {
  readonly identity: ChildTerminalIdentity;
  readonly trigger: ChildCancellationTrigger;
  readonly runtime_responsibilities: {
    readonly persist_stop_request_for_idempotency: true;
    readonly stop_normal_process_tree: true;
    readonly verify_actual_cancellation_and_no_leaks: true;
  };
}

export type ChildCancellationNonProposalReason =
  | "artifact_window_open"
  | "artifact_window_unknown"
  | "terminal_unknown"
  | "terminal_already_observed"
  | "cancellation_not_requested"
  | "stop_already_requested";

export type ChildCancellationPlanOutcome =
  | { readonly status: "not_proposed"; readonly reason: ChildCancellationNonProposalReason }
  | { readonly status: "rejected"; readonly reason: "invalid_input" | "invalid_time" }
  | {
    readonly status: "rejected";
    readonly reason: "terminal_reconciliation_rejected";
    readonly reconciliation_reason: ChildTerminalReconciliationReason;
  }
  | { readonly status: "proposed"; readonly proposal: ChildCancellationStopProposal };

const INPUT_KEYS = [
  "current",
  "observation",
  "evidence",
  "settled_fingerprint",
  "deadline_ms",
  "now_ms",
  "cancellation_requested",
  "prior_stop_requests",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyInputKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => (INPUT_KEYS as readonly string[]).includes(key));
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameIdentity(left: unknown, right: ChildTerminalIdentity): boolean {
  if (!isRecord(left)) return false;
  return left.run_id === right.run_id && left.unit_id === right.unit_id &&
    left.attempt_id === right.attempt_id && left.predecessor_attempt_id === right.predecessor_attempt_id &&
    left.candidate_id === right.candidate_id && left.route_id === right.route_id &&
    left.child_id === right.child_id && left.call_id === right.call_id;
}

/**
 * Produces an inert stop proposal. It performs no I/O, clock read, process stop, release,
 * ledger append, writer admission, or target mutation. A satisfied terminal observation only
 * makes stopping unnecessary; it does not independently assert that every resource is released.
 */
export function planChildCancellation(input: unknown): ChildCancellationPlanOutcome {
  if (!isRecord(input) || !hasOnlyInputKeys(input) || typeof input.cancellation_requested !== "boolean" ||
    !Array.isArray(input.prior_stop_requests)) {
    return { status: "rejected", reason: "invalid_input" };
  }
  if (!isTime(input.deadline_ms) || !isTime(input.now_ms)) {
    return { status: "rejected", reason: "invalid_time" };
  }

  const reconciliation = reconcileChildTerminal({
    current: input.current,
    observation: input.observation,
    evidence: input.evidence,
    settled_fingerprint: input.settled_fingerprint,
  });
  if (reconciliation.status === "rejected") {
    return {
      status: "rejected",
      reason: "terminal_reconciliation_rejected",
      reconciliation_reason: reconciliation.reason,
    };
  }

  const current = input.current as ChildTerminalIdentity;
  const evidence = input.evidence as ChildTerminalEvidence;
  if (evidence.artifact_window_closed === "unsatisfied") {
    return { status: "not_proposed", reason: "artifact_window_open" };
  }
  if (evidence.artifact_window_closed === "unknown") {
    return { status: "not_proposed", reason: "artifact_window_unknown" };
  }
  if (evidence.terminal === "unknown") return { status: "not_proposed", reason: "terminal_unknown" };
  if (evidence.terminal === "satisfied") {
    return { status: "not_proposed", reason: "terminal_already_observed" };
  }

  const expired = input.now_ms >= input.deadline_ms;
  if (!expired && !input.cancellation_requested) {
    return { status: "not_proposed", reason: "cancellation_not_requested" };
  }
  if (input.prior_stop_requests.some((identity) => sameIdentity(identity, current))) {
    return { status: "not_proposed", reason: "stop_already_requested" };
  }

  return {
    status: "proposed",
    proposal: {
      identity: { ...current },
      trigger: input.cancellation_requested ? "explicit_cancellation" : "deadline_expired",
      runtime_responsibilities: {
        persist_stop_request_for_idempotency: true,
        stop_normal_process_tree: true,
        verify_actual_cancellation_and_no_leaks: true,
      },
    },
  };
}
