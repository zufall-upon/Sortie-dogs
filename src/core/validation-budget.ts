import { createHash } from "node:crypto";

export const VALIDATION_PROFILES = ["fast", "balanced", "assurance"] as const;
export type ValidationProfile = typeof VALIDATION_PROFILES[number];
export type ValidationScope = "static" | "targeted" | "related" | "canonical" | "full-suite" | "full";
export type ValidationOwner = "worker" | "coordinator";
export type ValidationReason = "preflight" | "acceptance" | "retry";
export type ValidationOutcome = "passed" | "failed" | "timeout" | "interrupted" | "cancelled";
export interface ValidationEnvironment {
  readonly platform: string;
  readonly arch: string;
  readonly runtime: string;
  readonly toolchain?: string;
}

export interface ValidationBudgetRequest {
  readonly run_id: string;
  readonly operation_id: string;
  readonly source_snapshot: string;
  readonly candidate: string;
  readonly command: readonly string[];
  readonly environment: ValidationEnvironment;
  readonly scope: ValidationScope;
  readonly owner: ValidationOwner;
  readonly expected_evidence: readonly string[];
  readonly marginal_value: {
    readonly unmet_criteria: readonly string[];
    readonly risk_hypothesis: string | null;
  };
  readonly reason: ValidationReason;
  readonly retry_of?: string;
  readonly changed_cause?: string;
}

export interface ValidationBudgetState {
  readonly limit: number;
  readonly consumed: number;
  readonly evidence_keys: readonly string[];
  /** Evidence that was attempted but is not eligible for reuse, or is still in flight. */
  readonly blocked_evidence_keys?: readonly string[];
  readonly prior_duration_ms?: number;
}

export interface ValidationBudgetDecision {
  readonly decision: "ALLOW" | "SKIP" | "DENY";
  readonly reason: "invalid-contract" | "duplicate-evidence" | "budget-exhausted" | "retry-justification-required" |
    "marginal-value-required" | "owner-mismatch" | "allowed";
  readonly scope: ValidationScope | null;
  readonly evidence_key: string | null;
  readonly consumed: number;
  readonly redundant_time_ms: number;
}

export function validationEvidenceState(events: readonly unknown[]): {
  readonly reusable: readonly string[];
  readonly blocked: readonly string[];
} {
  const active = new Map<string, string>();
  const reusable = new Set<string>();
  const blocked = new Set<string>();
  for (const value of events) {
    if (value === null || typeof value !== "object") continue;
    const event = value as Record<string, unknown>;
    if (event.kind === "validation.admission" && event.decision === "ALLOW" &&
      typeof event.reservation_id === "string" && typeof event.evidence_key === "string") {
      active.set(event.reservation_id, event.evidence_key);
      continue;
    }
    if (event.kind === "validation.settled" && typeof event.reservation_id === "string" &&
      typeof event.evidence_key === "string" && typeof event.outcome === "string") {
      active.delete(event.reservation_id);
      if (event.outcome === "passed" && event.exit_code === 0) {
        reusable.add(event.evidence_key);
        blocked.delete(event.evidence_key);
      } else {
        reusable.delete(event.evidence_key);
        blocked.add(event.evidence_key);
      }
    }
  }
  for (const evidenceKey of active.values()) blocked.add(evidenceKey);
  return { reusable: [...reusable], blocked: [...blocked] };
}

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const scopes = new Set<ValidationScope>(["static", "targeted", "related", "canonical", "full-suite", "full"]);
const normalizedScope = (scope: ValidationScope): Exclude<ValidationScope, "full"> => scope === "full" ? "canonical" : scope;

export function validationOwner(scope: ValidationScope): ValidationOwner {
  return ["canonical", "full-suite", "full"].includes(scope) ? "coordinator" : "worker";
}

export function selectValidationScope(input: {
  readonly profile: ValidationProfile;
  readonly canonical: boolean;
  readonly release: boolean;
  readonly explicit_risk: boolean;
}): Exclude<ValidationScope, "full"> {
  if (input.release || input.explicit_risk) return "full-suite";
  if (input.canonical) return "canonical";
  if (input.profile === "fast") return "static";
  if (input.profile === "assurance") return "related";
  return "targeted";
}

export function validationDurationGuidance(samples: readonly number[]): { readonly median_ms: number | null; readonly p90_ms: number | null } {
  const values = samples.filter(value => Number.isSafeInteger(value) && value >= 0).sort((left, right) => left - right);
  if (values.length === 0) return { median_ms: null, p90_ms: null };
  const percentile = (fraction: number) => values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]!;
  return { median_ms: percentile(0.5), p90_ms: percentile(0.9) };
}

export function passedValidationDurationGuidance(events: readonly unknown[], evidenceKey: string): {
  readonly median_ms: number | null;
  readonly p90_ms: number | null;
} {
  return validationDurationGuidance(events.flatMap(value => {
    if (value === null || typeof value !== "object") return [];
    const event = value as Record<string, unknown>;
    return event.kind === "validation.settled" && event.evidence_key === evidenceKey &&
      event.outcome === "passed" && event.exit_code === 0 && typeof event.duration_ms === "number"
      ? [event.duration_ms] : [];
  }));
}

export function validationEvidenceKey(request: ValidationBudgetRequest): string {
  // Run and operation identity are volatile. Owner and normalized scope are durable execution
  // provenance: worker-targeted evidence must never satisfy coordinator-canonical validation.
  return `sha256:${createHash("sha256").update(JSON.stringify({ version: 4,
    candidate: request.candidate, command: request.command, environment: request.environment,
    owner: request.owner, scope: normalizedScope(request.scope) })).digest("hex")}`;
}

export function validationResultFingerprint(request: ValidationBudgetRequest, outcome: ValidationOutcome,
  exitCode: number | null): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ version: 1,
    candidate: request.candidate, command: request.command, environment: request.environment,
    result: { outcome, exit_code: exitCode } })).digest("hex")}`;
}

export function decideValidationBudget(request: unknown, state: ValidationBudgetState): ValidationBudgetDecision {
  if (!request || typeof request !== "object" || !Array.isArray((request as ValidationBudgetRequest).command) ||
    !Array.isArray((request as ValidationBudgetRequest).expected_evidence)) {
    return { decision: "DENY", reason: "invalid-contract", scope: null, evidence_key: null, consumed: state.consumed,
      redundant_time_ms: 0 };
  }
  const value = request as ValidationBudgetRequest;
  const environment = value.environment;
  const marginal = value.marginal_value;
  const valid = id(value.run_id) && id(value.operation_id) && id(value.source_snapshot) && id(value.candidate) &&
    value.command.length > 0 && value.command.every(id) && scopes.has(value.scope) &&
    environment !== null && typeof environment === "object" && id(environment.platform) && id(environment.arch) &&
    id(environment.runtime) && (environment.toolchain === undefined || id(environment.toolchain)) &&
    (value.owner === "worker" || value.owner === "coordinator") &&
    value.expected_evidence.length > 0 && value.expected_evidence.every(id) &&
    marginal !== null && typeof marginal === "object" && Array.isArray(marginal.unmet_criteria) &&
    marginal.unmet_criteria.every(id) && new Set(marginal.unmet_criteria).size === marginal.unmet_criteria.length &&
    (marginal.risk_hypothesis === null || id(marginal.risk_hypothesis)) &&
    (value.reason === "preflight" || value.reason === "acceptance" || value.reason === "retry") &&
    (value.reason !== "retry" || (id(value.retry_of) && id(value.changed_cause)));
  if (!valid) return { decision: "DENY", reason: value.reason === "retry" ? "retry-justification-required" : "invalid-contract",
    scope: null, evidence_key: null, consumed: state.consumed, redundant_time_ms: 0 };
  if (value.owner !== validationOwner(value.scope)) return { decision: "DENY", reason: "owner-mismatch", scope: value.scope,
    evidence_key: validationEvidenceKey(value), consumed: state.consumed, redundant_time_ms: 0 };
  if (marginal.unmet_criteria.length === 0 && marginal.risk_hypothesis === null) {
    return { decision: "DENY", reason: "marginal-value-required", scope: value.scope,
      evidence_key: validationEvidenceKey(value), consumed: state.consumed, redundant_time_ms: 0 };
  }
  const evidenceKey = validationEvidenceKey(value);
  if (state.blocked_evidence_keys?.includes(evidenceKey)) return { decision: "DENY", reason: "duplicate-evidence", scope: normalizedScope(value.scope),
    evidence_key: evidenceKey, consumed: state.consumed, redundant_time_ms: 0 };
  if (state.evidence_keys.includes(evidenceKey)) return { decision: "SKIP", reason: "duplicate-evidence", scope: normalizedScope(value.scope),
    evidence_key: evidenceKey, consumed: state.consumed,
    redundant_time_ms: Number.isSafeInteger(state.prior_duration_ms) && Number(state.prior_duration_ms) >= 0 ? state.prior_duration_ms! : 0 };
  if (!Number.isSafeInteger(state.limit) || state.limit < 0 || state.consumed >= state.limit) return { decision: "DENY", reason: "budget-exhausted",
    scope: normalizedScope(value.scope), evidence_key: evidenceKey, consumed: state.consumed, redundant_time_ms: 0 };
  return { decision: "ALLOW", reason: "allowed", scope: normalizedScope(value.scope), evidence_key: evidenceKey,
    consumed: state.consumed + 1, redundant_time_ms: 0 };
}
