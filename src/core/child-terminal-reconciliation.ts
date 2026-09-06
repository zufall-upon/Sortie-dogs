import { createHash } from "node:crypto";

export type ChildTerminalDisposition = "continue" | "succeeded" | "failed" | "cancelled";
export type ChildTerminalEvidenceState = "satisfied" | "unsatisfied" | "unknown";
export type ChildTerminalEvidenceName =
  | "terminal"
  | "tools_quiescent"
  | "artifact_window_closed"
  | "writer_released"
  | "gate_released"
  | "lease_released"
  | "worktree_released";

export interface ChildTerminalIdentity {
  readonly run_id: string;
  readonly unit_id: string;
  readonly attempt_id: string;
  readonly predecessor_attempt_id: string | null;
  readonly candidate_id: string;
  readonly route_id: string;
  readonly child_id: string;
  readonly call_id: string;
}

export interface ChildTerminalObservation {
  readonly identity: ChildTerminalIdentity;
  readonly disposition: ChildTerminalDisposition;
  /** Informational only. Time is deliberately excluded from the terminal fingerprint. */
  readonly observed_at?: string;
}

export type ChildTerminalEvidence = Readonly<Record<ChildTerminalEvidenceName, ChildTerminalEvidenceState>>;

export interface ChildTerminalReconciliationInput {
  readonly current: ChildTerminalIdentity;
  readonly observation: ChildTerminalObservation;
  readonly evidence: ChildTerminalEvidence;
  readonly settled_fingerprint?: string | null;
}

export type ChildTerminalReconciliationReason =
  | "terminal_ready"
  | "terminal_replayed"
  | "evidence_unknown"
  | "evidence_unsatisfied"
  | "evidence_unsatisfied_and_unknown"
  | "identity_missing"
  | "identity_invalid"
  | "late_terminal"
  | "identity_conflict"
  | "invalid_disposition"
  | "invalid_evidence"
  | "invalid_settled_fingerprint"
  | "settled_conflict";

export interface ChildTerminalReconciliationResult {
  readonly status: "ready" | "withheld" | "rejected";
  readonly reason: ChildTerminalReconciliationReason;
  readonly unknown: readonly ChildTerminalEvidenceName[];
  readonly blocking: readonly ChildTerminalEvidenceName[];
  readonly fingerprint: string | null;
  readonly replayed: boolean;
  readonly emitTerminalEvent: boolean;
}

const IDENTITY_FIELDS = [
  "run_id",
  "unit_id",
  "attempt_id",
  "predecessor_attempt_id",
  "candidate_id",
  "route_id",
  "child_id",
  "call_id",
] as const;

const CONTEXT_IDENTITY_FIELDS = ["run_id", "unit_id", "candidate_id", "route_id", "child_id", "call_id"] as const;

export const CHILD_TERMINAL_EVIDENCE_FIELDS: readonly ChildTerminalEvidenceName[] = Object.freeze([
  "terminal",
  "tools_quiescent",
  "artifact_window_closed",
  "writer_released",
  "gate_released",
  "lease_released",
  "worktree_released",
]);

const DISPOSITIONS: readonly ChildTerminalDisposition[] = ["continue", "succeeded", "failed", "cancelled"];
const EVIDENCE_STATES: readonly ChildTerminalEvidenceState[] = ["satisfied", "unsatisfied", "unknown"];
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejected(reason: ChildTerminalReconciliationReason, fingerprint: string | null = null): ChildTerminalReconciliationResult {
  return { status: "rejected", reason, unknown: [], blocking: [], fingerprint, replayed: false, emitTerminalEvent: false };
}

function identityProblem(value: unknown): "identity_missing" | "identity_invalid" | null {
  if (!isRecord(value)) return "identity_missing";
  for (const field of IDENTITY_FIELDS) {
    if (!(field in value)) return "identity_missing";
    const item = value[field];
    if (field === "predecessor_attempt_id") {
      if (item !== null && (typeof item !== "string" || item.length === 0)) return "identity_invalid";
    } else if (typeof item !== "string" || item.length === 0) return "identity_invalid";
  }
  return null;
}

export function isChildTerminalIdentity(value: unknown): value is ChildTerminalIdentity {
  return identityProblem(value) === null && isRecord(value) &&
    Object.keys(value).every((key) => (IDENTITY_FIELDS as readonly string[]).includes(key));
}

export function sameChildTerminalIdentity(left: ChildTerminalIdentity, right: ChildTerminalIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function terminalFingerprint(
  identity: ChildTerminalIdentity,
  disposition: ChildTerminalDisposition,
  evidence: ChildTerminalEvidence,
): string {
  const canonical = JSON.stringify({
    run_id: identity.run_id,
    unit_id: identity.unit_id,
    attempt_id: identity.attempt_id,
    predecessor_attempt_id: identity.predecessor_attempt_id,
    candidate_id: identity.candidate_id,
    route_id: identity.route_id,
    child_id: identity.child_id,
    call_id: identity.call_id,
    disposition,
    terminal: evidence.terminal,
    tools_quiescent: evidence.tools_quiescent,
    artifact_window_closed: evidence.artifact_window_closed,
    writer_released: evidence.writer_released,
    gate_released: evidence.gate_released,
    lease_released: evidence.lease_released,
    worktree_released: evidence.worktree_released,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Pure decision support only. The caller retains authority for stopping tools,
 * releasing resources, appending a terminal event, and admitting a next writer.
 */
export function reconcileChildTerminal(input: unknown): ChildTerminalReconciliationResult {
  if (!isRecord(input)) return rejected("identity_missing");
  const currentProblem = identityProblem(input.current);
  if (currentProblem !== null) return rejected(currentProblem);
  if (!isRecord(input.observation)) return rejected("identity_missing");
  const observedProblem = identityProblem(input.observation.identity);
  if (observedProblem !== null) return rejected(observedProblem);

  const current = input.current as unknown as ChildTerminalIdentity;
  const observation = input.observation as unknown as ChildTerminalObservation;
  if (CONTEXT_IDENTITY_FIELDS.some((field) => observation.identity[field] !== current[field])) {
    return rejected("identity_conflict");
  }
  if (observation.identity.attempt_id !== current.attempt_id) return rejected("late_terminal");
  if (observation.identity.predecessor_attempt_id !== current.predecessor_attempt_id) return rejected("identity_conflict");
  if (typeof observation.disposition !== "string" || !DISPOSITIONS.includes(observation.disposition as ChildTerminalDisposition)) {
    return rejected("invalid_disposition");
  }

  if (!isRecord(input.evidence)) return rejected("invalid_evidence");
  const evidenceRecord = input.evidence;
  if (CHILD_TERMINAL_EVIDENCE_FIELDS.some((field) => !EVIDENCE_STATES.includes(evidenceRecord[field] as ChildTerminalEvidenceState))) {
    return rejected("invalid_evidence");
  }
  const evidence = evidenceRecord as unknown as ChildTerminalEvidence;
  const fingerprint = terminalFingerprint(current, observation.disposition, evidence);

  const settled = input.settled_fingerprint;
  if (settled !== undefined && settled !== null && (typeof settled !== "string" || !HASH_PATTERN.test(settled))) {
    return rejected("invalid_settled_fingerprint", fingerprint);
  }
  if (typeof settled === "string" && settled !== fingerprint) return rejected("settled_conflict", fingerprint);

  const unknown = CHILD_TERMINAL_EVIDENCE_FIELDS.filter((field) => evidence[field] === "unknown");
  const blocking = CHILD_TERMINAL_EVIDENCE_FIELDS.filter((field) => evidence[field] === "unsatisfied");
  if (unknown.length > 0 || blocking.length > 0) {
    const reason = unknown.length > 0 && blocking.length > 0
      ? "evidence_unsatisfied_and_unknown"
      : unknown.length > 0 ? "evidence_unknown" : "evidence_unsatisfied";
    return { status: "withheld", reason, unknown, blocking, fingerprint, replayed: false, emitTerminalEvent: false };
  }

  const replayed = settled === fingerprint;
  return {
    status: "ready",
    reason: replayed ? "terminal_replayed" : "terminal_ready",
    unknown: [],
    blocking: [],
    fingerprint,
    replayed,
    emitTerminalEvent: !replayed,
  };
}
