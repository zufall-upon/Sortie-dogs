import { createHash } from "node:crypto";

export type ValidationScope = "targeted" | "full";
export type ValidationReason = "preflight" | "acceptance" | "retry";
export type ValidationOutcome = "passed" | "failed" | "timeout" | "interrupted";

export interface ValidationBudgetRequest {
  readonly run_id: string;
  readonly operation_id: string;
  readonly source_snapshot: string;
  readonly candidate: string;
  readonly command: readonly string[];
  readonly scope: ValidationScope;
  readonly expected_evidence: readonly string[];
  readonly reason: ValidationReason;
  readonly retry_of?: string;
  readonly changed_cause?: string;
}

export interface ValidationBudgetState {
  readonly limit: number;
  readonly consumed: number;
  readonly evidence_keys: readonly string[];
}

export interface ValidationBudgetDecision {
  readonly decision: "ALLOW" | "DENY";
  readonly reason: "invalid-contract" | "duplicate-evidence" | "budget-exhausted" | "retry-justification-required" | "allowed";
  readonly scope: ValidationScope | null;
  readonly evidence_key: string | null;
  readonly consumed: number;
}

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;

export function validationEvidenceKey(request: ValidationBudgetRequest): string {
  // Provenance (run/operation/candidate) is ledger metadata, not execution evidence.
  // Keeping it out makes retries survive task renames and worktree relocation.
  return `sha256:${createHash("sha256").update(JSON.stringify({ version: 2,
    source_snapshot: request.source_snapshot, command: request.command, scope: request.scope,
    expected_evidence: request.expected_evidence })).digest("hex")}`;
}

export function decideValidationBudget(request: unknown, state: ValidationBudgetState): ValidationBudgetDecision {
  if (!request || typeof request !== "object" || !Array.isArray((request as ValidationBudgetRequest).command) ||
    !Array.isArray((request as ValidationBudgetRequest).expected_evidence)) {
    return { decision: "DENY", reason: "invalid-contract", scope: null, evidence_key: null, consumed: state.consumed };
  }
  const value = request as ValidationBudgetRequest;
  const valid = id(value.run_id) && id(value.operation_id) && id(value.source_snapshot) && id(value.candidate) &&
    value.command.length > 0 && value.command.every(id) && (value.scope === "targeted" || value.scope === "full") &&
    value.expected_evidence.length > 0 && value.expected_evidence.every(id) &&
    (value.reason === "preflight" || value.reason === "acceptance" || value.reason === "retry") &&
    (value.reason !== "retry" || (id(value.retry_of) && id(value.changed_cause)));
  if (!valid) return { decision: "DENY", reason: value.reason === "retry" ? "retry-justification-required" : "invalid-contract", scope: null, evidence_key: null, consumed: state.consumed };
  const evidenceKey = validationEvidenceKey(value);
  if (state.evidence_keys.includes(evidenceKey)) return { decision: "DENY", reason: "duplicate-evidence", scope: value.scope, evidence_key: evidenceKey, consumed: state.consumed };
  if (!Number.isSafeInteger(state.limit) || state.limit < 0 || state.consumed >= state.limit) return { decision: "DENY", reason: "budget-exhausted", scope: value.scope, evidence_key: evidenceKey, consumed: state.consumed };
  return { decision: "ALLOW", reason: "allowed", scope: value.scope, evidence_key: evidenceKey, consumed: state.consumed + 1 };
}
