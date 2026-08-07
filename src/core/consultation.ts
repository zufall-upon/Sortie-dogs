export const CONSULTATION_CAPABILITIES = ["strategy", "sourceReview"] as const;

export type ConsultationCapability = typeof CONSULTATION_CAPABILITIES[number];

export const CONSULTATION_ROLE_POLICY = Object.freeze({
  strategy: "dog-advisor",
  sourceReview: "dog-reviewer",
} as const);

export const STRATEGY_TRIGGERS = [
  "architecture-choice",
  "cross-boundary-tradeoff",
  "material-uncertainty",
] as const;

export type StrategyTrigger = typeof STRATEGY_TRIGGERS[number];

export interface StrategyTriggerInput {
  readonly candidateId: string;
  readonly trigger?: StrategyTrigger;
  readonly callsForCandidate: number;
  readonly decisionAlreadyRecorded?: boolean;
  readonly mechanicalChange?: boolean;
  readonly sameTaskResume?: boolean;
}

/** Strategy is advisory, bounded to one call, and excluded when no design decision remains. */
export function shouldConsultStrategy(input: StrategyTriggerInput): boolean {
  return input.candidateId.length > 0 &&
    input.trigger !== undefined &&
    input.callsForCandidate < 1 &&
    input.decisionAlreadyRecorded !== true &&
    input.mechanicalChange !== true &&
    input.sameTaskResume !== true;
}

export const SOURCE_REVIEW_RISK_TAGS = [
  "security",
  "credential",
  "permission",
  "network",
  "public-api",
  "storage-compatibility",
  "package",
  "build",
  "release",
  "migration",
  "concurrency",
  "process-io",
  "write-gate",
  "authorization",
] as const;

export type SourceReviewRiskTag = typeof SOURCE_REVIEW_RISK_TAGS[number];

const riskTagSet = new Set<string>(SOURCE_REVIEW_RISK_TAGS);

export function isSourceReviewRiskTag(value: unknown): value is SourceReviewRiskTag {
  return typeof value === "string" && riskTagSet.has(value);
}

export function requiresSourceReview(riskTags: readonly SourceReviewRiskTag[]): boolean {
  return riskTags.length > 0;
}

export type SourceReviewRequirement =
  | "SKIP_LOW_RISK"
  | "WAIT_CANONICAL_VALIDATION"
  | "REVIEW_REQUIRED"
  | "REVIEW_TOO_LATE"
  | "RISK_TAGS_INVALID";

export interface SourceReviewRequirementInput {
  readonly riskTags: unknown;
  readonly canonicalValidationExit?: number;
  readonly stagingStarted: boolean;
}

/** Places required review strictly after canonical PASS and before staging. */
export function evaluateSourceReviewRequirement(
  input: SourceReviewRequirementInput,
): SourceReviewRequirement {
  if (!Array.isArray(input.riskTags)) return "RISK_TAGS_INVALID";
  const riskTags = [...input.riskTags];
  if (!riskTags.every(isSourceReviewRiskTag)) return "RISK_TAGS_INVALID";
  if (!requiresSourceReview(riskTags)) return "SKIP_LOW_RISK";
  if (input.canonicalValidationExit !== 0) return "WAIT_CANONICAL_VALIDATION";
  return input.stagingStarted ? "REVIEW_TOO_LATE" : "REVIEW_REQUIRED";
}

export type ReviewAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "REVIEW_UNAVAILABLE" };

export function evaluateReviewAvailability(required: boolean, available: boolean): ReviewAvailability {
  return required && !available ? { ok: false, code: "REVIEW_UNAVAILABLE" } : { ok: true };
}

export interface StrategyConsultationRequest {
  readonly requestId: string;
  readonly candidateId: string;
  readonly capability: "strategy";
  readonly agent: string;
  readonly question: string;
  readonly constraints: readonly string[];
  readonly options: readonly string[];
}

export interface ReviewArtifact {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly sourceFingerprint: string;
  readonly acceptance: readonly string[];
  readonly changedLogicSummary: readonly string[];
  readonly manifest: readonly string[];
  readonly riskTags: readonly SourceReviewRiskTag[];
  readonly riskBearingHunks: readonly string[];
  readonly validation: {
    readonly command: string;
    readonly exit: 0;
    readonly fingerprint: string;
  };
  readonly invariants: readonly string[];
}

export interface SourceReviewConsultationRequest {
  readonly requestId: string;
  readonly candidateId: string;
  readonly capability: "sourceReview";
  readonly agent: string;
  readonly artifact: ReviewArtifact;
}

export type ConsultationRequest = StrategyConsultationRequest | SourceReviewConsultationRequest;

export interface StrategyConsultationResult {
  readonly requestId: string;
  readonly candidateId: string;
  readonly capability: "strategy";
  readonly status: "completed";
  readonly recommendation: string;
  readonly considerations: readonly string[];
}

export interface UnavailableConsultationResult {
  readonly requestId: string;
  readonly candidateId: string;
  readonly capability: ConsultationCapability;
  readonly status: "unavailable";
}

export type ReviewVerdictKind = "PASS" | "MUST_FIX" | "BLOCKED";
export type ReviewFindingSeverity = "major" | "medium";

export interface ReviewFinding {
  readonly severity: ReviewFindingSeverity;
  readonly path: string;
  readonly evidence: string;
  readonly requiredFix: string;
}

export interface ReviewVerdict {
  readonly verdict: ReviewVerdictKind;
  readonly sourceFingerprint: string;
  readonly findings: readonly ReviewFinding[];
}

export interface SourceReviewConsultationResult {
  readonly requestId: string;
  readonly candidateId: string;
  readonly capability: "sourceReview";
  readonly status: "completed";
  readonly review: ReviewVerdict;
}

export type ConsultationResult =
  | StrategyConsultationResult
  | SourceReviewConsultationResult
  | UnavailableConsultationResult;

/**
 * Sole consultation transport boundary. The host supplies this adapter; core passes only the
 * provider-, model-, variant-, and transport-neutral request and result envelopes above.
 */
export interface ConsultationAdapter {
  consult(request: ConsultationRequest): Promise<ConsultationResult>;
}

export const MAX_REVIEW_ARTIFACT_BYTES = 30_720;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T; readonly bytes?: number }
  | { readonly ok: false; readonly code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyStringList(value: unknown): value is readonly string[] {
  return isStringList(value) && value.length > 0;
}

/** Strict bounded schema; unknown fields and opaque/raw payloads are rejected. */
export function validateReviewArtifact(
  value: unknown,
  maxBytes = MAX_REVIEW_ARTIFACT_BYTES,
): ValidationResult<ReviewArtifact> {
  let bytes: number;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { ok: false, code: "ARTIFACT_NOT_JSON" };
    bytes = Buffer.byteLength(serialized, "utf8");
  } catch {
    return { ok: false, code: "ARTIFACT_NOT_JSON" };
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_REVIEW_ARTIFACT_BYTES) {
    return { ok: false, code: "ARTIFACT_LIMIT_INVALID" };
  }
  if (bytes > maxBytes) return { ok: false, code: "ARTIFACT_TOO_LARGE" };
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "candidateId",
    "sourceFingerprint",
    "acceptance",
    "changedLogicSummary",
    "manifest",
    "riskTags",
    "riskBearingHunks",
    "validation",
    "invariants",
  ])) return { ok: false, code: "ARTIFACT_SCHEMA_INVALID" };
  if (
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.candidateId) ||
    !isNonEmptyString(value.sourceFingerprint) ||
    !isStringList(value.acceptance) ||
    !isNonEmptyStringList(value.changedLogicSummary) ||
    !isStringList(value.manifest) ||
    !Array.isArray(value.riskTags) ||
    !value.riskTags.every(isSourceReviewRiskTag) ||
    !isStringList(value.riskBearingHunks) ||
    !isRecord(value.validation) ||
    !hasExactKeys(value.validation, ["command", "exit", "fingerprint"]) ||
    !isNonEmptyString(value.validation.command) ||
    value.validation.exit !== 0 ||
    !isNonEmptyString(value.validation.fingerprint) ||
    !isStringList(value.invariants)
  ) return { ok: false, code: "ARTIFACT_SCHEMA_INVALID" };
  return { ok: true, value: value as unknown as ReviewArtifact, bytes };
}

export function validateReviewVerdict(value: unknown): ValidationResult<ReviewVerdict> {
  if (!isRecord(value) || !hasExactKeys(value, ["verdict", "sourceFingerprint", "findings"])) {
    return { ok: false, code: "VERDICT_SCHEMA_INVALID" };
  }
  if (
    !["PASS", "MUST_FIX", "BLOCKED"].includes(value.verdict as string) ||
    !isNonEmptyString(value.sourceFingerprint) ||
    !Array.isArray(value.findings)
  ) return { ok: false, code: "VERDICT_SCHEMA_INVALID" };
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      !hasExactKeys(finding, ["severity", "path", "evidence", "requiredFix"]) ||
      (finding.severity !== "major" && finding.severity !== "medium") ||
      !isNonEmptyString(finding.path) ||
      !isNonEmptyString(finding.evidence) ||
      !isNonEmptyString(finding.requiredFix)
    ) return { ok: false, code: "VERDICT_SCHEMA_INVALID" };
  }
  if (value.verdict === "PASS" && value.findings.length !== 0) {
    return { ok: false, code: "PASS_WITH_FINDINGS" };
  }
  if (value.verdict !== "PASS" && value.findings.length === 0) {
    return { ok: false, code: "NON_PASS_WITHOUT_FINDINGS" };
  }
  return { ok: true, value: value as unknown as ReviewVerdict };
}

export interface ReviewGateInput {
  readonly phase: "initial" | "verification";
  readonly candidateId: string;
  readonly currentSourceFingerprint: string;
  readonly artifact: unknown;
  readonly verdict: unknown;
  readonly reviewedFingerprints: readonly string[];
  /** The configured budget applies independently to each explicit review phase. */
  readonly maxCallsPerCandidate: number;
  readonly callsForPhase: number;
  readonly initialVerdict?: ReviewVerdictKind;
  readonly initialArtifact?: unknown;
  readonly remediationApplied?: boolean;
  readonly maxArtifactBytes?: number;
}

export type ReviewGateResult =
  | { readonly ok: true; readonly permitStage: boolean; readonly verdict: ReviewVerdictKind }
  | { readonly ok: false; readonly code: string };

/** Enforces one initial review and, only after remediation, one verification review. */
export function evaluateReviewGate(input: ReviewGateInput): ReviewGateResult {
  if (
    !Number.isInteger(input.maxCallsPerCandidate) ||
    input.maxCallsPerCandidate <= 0 ||
    !Number.isInteger(input.callsForPhase) ||
    input.callsForPhase < 0
  ) return { ok: false, code: "REVIEW_BUDGET_INVALID" };
  if (input.callsForPhase >= input.maxCallsPerCandidate) {
    return { ok: false, code: "REVIEW_BUDGET_EXHAUSTED" };
  }
  const artifact = validateReviewArtifact(input.artifact, input.maxArtifactBytes);
  if (!artifact.ok) return artifact;
  const verdict = validateReviewVerdict(input.verdict);
  if (!verdict.ok) return verdict;
  if (artifact.value.candidateId !== input.candidateId) return { ok: false, code: "CANDIDATE_MISMATCH" };
  if (artifact.value.sourceFingerprint !== input.currentSourceFingerprint) {
    return { ok: false, code: "STALE_FINGERPRINT" };
  }
  if (verdict.value.sourceFingerprint !== artifact.value.sourceFingerprint) {
    return { ok: false, code: "FINGERPRINT_MISMATCH" };
  }
  if (input.reviewedFingerprints.includes(artifact.value.sourceFingerprint)) {
    return { ok: false, code: "FINGERPRINT_REUSED" };
  }
  if (input.phase === "initial") {
    if (input.reviewedFingerprints.length !== 0) return { ok: false, code: "REVIEW_LIMIT_REACHED" };
  } else if (
    input.reviewedFingerprints.length !== 1 ||
    input.initialVerdict !== "MUST_FIX" ||
    input.remediationApplied !== true
  ) {
    return { ok: false, code: "VERIFICATION_NOT_ALLOWED" };
  } else {
    const initialArtifact = validateReviewArtifact(input.initialArtifact, input.maxArtifactBytes);
    if (!initialArtifact.ok) return { ok: false, code: "INITIAL_ARTIFACT_INVALID" };
    if (!sameReviewScope(initialArtifact.value, artifact.value)) {
      return { ok: false, code: "REVIEW_SCOPE_MISMATCH" };
    }
  }
  return {
    ok: true,
    permitStage: verdict.value.verdict === "PASS",
    verdict: verdict.value.verdict,
  };
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameReviewScope(initial: ReviewArtifact, verification: ReviewArtifact): boolean {
  return initial.schemaVersion === verification.schemaVersion &&
    initial.candidateId === verification.candidateId &&
    sameStringList(initial.acceptance, verification.acceptance) &&
    sameStringList(initial.changedLogicSummary, verification.changedLogicSummary) &&
    sameStringList(initial.manifest, verification.manifest) &&
    sameStringList(initial.riskTags, verification.riskTags) &&
    sameStringList(initial.riskBearingHunks, verification.riskBearingHunks) &&
    sameStringList(initial.invariants, verification.invariants) &&
    initial.validation.command === verification.validation.command;
}
