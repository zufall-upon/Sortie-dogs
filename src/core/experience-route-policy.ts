export type ExperienceRoute = "sol-serial" | "luna-fabric" | "luna-fabric-with-escalation";

export type ExperienceFallbackReason =
  | "shape-unseen"
  | "sparse-evidence"
  | "unproven-evidence"
  | "evidence-window-mismatch"
  | "caller-baseline-route-mismatch"
  | "threshold-not-met";

export type ExperienceRejectionReason =
  | "invalid-input"
  | "invalid-number"
  | "unknown-route"
  | "duplicate-shape"
  | "ambiguous-policy-table"
  | "ambiguous-evidence";

export interface ExperiencePolicyRow {
  readonly shape: string;
  readonly baseline_route: ExperienceRoute;
  readonly policy_route: ExperienceRoute;
}

export interface ExperienceRoutePolicyTable {
  readonly version: string;
  readonly evidence_window: string;
  readonly minimum_samples: number;
  readonly duration_threshold: number;
  readonly cost_threshold: number;
  readonly rows: readonly ExperiencePolicyRow[];
}

export interface ExperienceEvidenceIdentity {
  readonly package: string;
  readonly fixture: string;
  readonly validation: string;
  readonly cache: string;
  readonly price_basis: string;
  readonly denominator: string;
}

export interface ExperienceRouteEvidence {
  readonly shape: string;
  readonly route: ExperienceRoute;
  readonly evidence_window: string;
  readonly identity: ExperienceEvidenceIdentity;
  readonly samples: number;
  readonly duration: {
    readonly metric_kind: "end-to-end-median";
    readonly milliseconds: number;
  };
  readonly cost: {
    readonly metric_kind: "estimated-cost-median";
    readonly amount: number;
    readonly price_basis: string;
    readonly denominator: string;
  };
}

export interface SelectExperienceRouteInput {
  readonly shape: string;
  readonly caller_heuristic_route: ExperienceRoute;
  readonly policy: ExperienceRoutePolicyTable;
  readonly evidence: readonly ExperienceRouteEvidence[];
}

interface ExperienceResultContext {
  readonly policy_version: string | null;
  readonly shape: string | null;
  readonly evidence_window: string | null;
  readonly evidence_identity: {
    readonly baseline: ExperienceEvidenceIdentity | null;
    readonly candidate: ExperienceEvidenceIdentity | null;
  };
  readonly authority: {
    readonly policy: "caller-declared";
    readonly evidence: "caller-matched";
    readonly execution: "not-performed";
  };
}

export type ExperienceRouteSelection =
  | (ExperienceResultContext & {
      readonly status: "proposed";
      readonly route: ExperienceRoute;
      readonly reason: "matched-evidence-within-thresholds";
    })
  | (ExperienceResultContext & {
      readonly status: "fallback";
      readonly route: ExperienceRoute;
      readonly reason: ExperienceFallbackReason;
    })
  | (ExperienceResultContext & {
      readonly status: "rejected";
      readonly route: ExperienceRoute | null;
      readonly reason: ExperienceRejectionReason;
    });

const ROUTES = new Set<ExperienceRoute>([
  "sol-serial",
  "luna-fabric",
  "luna-fabric-with-escalation",
]);

const AUTHORITY = {
  policy: "caller-declared",
  evidence: "caller-matched",
  execution: "not-performed",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoute(value: unknown): value is ExperienceRoute {
  return typeof value === "string" && ROUTES.has(value as ExperienceRoute);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIdentity(value: unknown): value is ExperienceEvidenceIdentity {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.package) &&
    isNonEmptyString(value.fixture) &&
    isNonEmptyString(value.validation) &&
    isNonEmptyString(value.cache) &&
    isNonEmptyString(value.price_basis) &&
    isNonEmptyString(value.denominator);
}

function sameIdentity(left: ExperienceEvidenceIdentity, right: ExperienceEvidenceIdentity): boolean {
  return left.package === right.package &&
    left.fixture === right.fixture &&
    left.validation === right.validation &&
    left.cache === right.cache &&
    left.price_basis === right.price_basis &&
    left.denominator === right.denominator;
}

function context(
  version: string | null,
  shape: string | null,
  window: string | null,
  baseline: ExperienceEvidenceIdentity | null = null,
  candidate: ExperienceEvidenceIdentity | null = null,
): ExperienceResultContext {
  return {
    policy_version: version,
    shape,
    evidence_window: window,
    evidence_identity: { baseline, candidate },
    authority: AUTHORITY,
  };
}

function evidenceIsMissing(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return value.identity == null || value.samples == null || value.duration == null || value.cost == null;
}

function evidenceIssue(value: unknown): ExperienceRejectionReason | "unproven" | null {
  if (evidenceIsMissing(value)) return "unproven";
  if (!isRecord(value) || !isRecord(value.duration) || !isRecord(value.cost)) return "invalid-input";
  if (!isRoute(value.route)) return "unknown-route";
  if (!isNonEmptyString(value.shape) || !isNonEmptyString(value.evidence_window) || !isIdentity(value.identity)) {
    return "invalid-input";
  }
  if (!Number.isSafeInteger(value.samples) || (value.samples as number) < 0 ||
      !isFiniteNonNegative(value.duration.milliseconds) || !isFiniteNonNegative(value.cost.amount)) {
    return "invalid-number";
  }
  if (value.duration.metric_kind !== "end-to-end-median" ||
      value.cost.metric_kind !== "estimated-cost-median" ||
      !isNonEmptyString(value.cost.price_basis) || !isNonEmptyString(value.cost.denominator) ||
      value.cost.price_basis !== value.identity.price_basis || value.cost.denominator !== value.identity.denominator) {
    return "unproven";
  }
  return null;
}

export function selectExperienceRoute(input: unknown): ExperienceRouteSelection {
  if (!isRecord(input)) {
    return { status: "rejected", route: null, reason: "invalid-input", ...context(null, null, null) };
  }

  const shape = isNonEmptyString(input.shape) ? input.shape : null;
  const callerRoute = isRoute(input.caller_heuristic_route) ? input.caller_heuristic_route : null;
  const rawPolicy = input.policy;
  if (!isRecord(rawPolicy) || !shape || !isNonEmptyString(rawPolicy.version) ||
      !isNonEmptyString(rawPolicy.evidence_window) || !Array.isArray(rawPolicy.rows) ||
      !Number.isSafeInteger(rawPolicy.minimum_samples) || (rawPolicy.minimum_samples as number) < 1) {
    return {
      status: "rejected",
      route: callerRoute,
      reason: "invalid-input",
      ...context(isRecord(rawPolicy) && isNonEmptyString(rawPolicy.version) ? rawPolicy.version : null, shape,
        isRecord(rawPolicy) && isNonEmptyString(rawPolicy.evidence_window) ? rawPolicy.evidence_window : null),
    };
  }
  const version = rawPolicy.version;
  const window = rawPolicy.evidence_window;
  const minimumSamples = rawPolicy.minimum_samples as number;
  const baseContext = context(version, shape, window);

  if (!callerRoute) {
    return { status: "rejected", route: null, reason: "unknown-route", ...baseContext };
  }
  if (!isFiniteNonNegative(rawPolicy.duration_threshold) || rawPolicy.duration_threshold > 1 ||
      !isFiniteNonNegative(rawPolicy.cost_threshold) || rawPolicy.cost_threshold > 1) {
    return { status: "rejected", route: callerRoute, reason: "invalid-number", ...baseContext };
  }

  const rows = new Map<string, ExperiencePolicyRow>();
  for (const value of rawPolicy.rows) {
    if (!isRecord(value) || !isNonEmptyString(value.shape)) {
      return { status: "rejected", route: callerRoute, reason: "invalid-input", ...baseContext };
    }
    if (!isRoute(value.baseline_route) || !isRoute(value.policy_route)) {
      return { status: "rejected", route: callerRoute, reason: "unknown-route", ...baseContext };
    }
    if (value.baseline_route === value.policy_route) {
      return { status: "rejected", route: callerRoute, reason: "ambiguous-policy-table", ...baseContext };
    }
    if (rows.has(value.shape)) {
      return { status: "rejected", route: callerRoute, reason: "duplicate-shape", ...baseContext };
    }
    rows.set(value.shape, value as unknown as ExperiencePolicyRow);
  }

  const row = rows.get(shape);
  if (!row) {
    return { status: "fallback", route: callerRoute, reason: "shape-unseen", ...baseContext };
  }
  if (callerRoute !== row.baseline_route) {
    return { status: "fallback", route: callerRoute, reason: "caller-baseline-route-mismatch", ...baseContext };
  }
  if (!Array.isArray(input.evidence)) {
    return { status: "fallback", route: callerRoute, reason: "unproven-evidence", ...baseContext };
  }

  const matchingShape = input.evidence.filter((value) => isRecord(value) && value.shape === shape);
  if (matchingShape.some((value) => isRecord(value) && !isRoute(value.route))) {
    return { status: "rejected", route: callerRoute, reason: "unknown-route", ...baseContext };
  }

  const matching = matchingShape.filter((value) => isRecord(value) &&
    (value.route === row.baseline_route || value.route === row.policy_route));
  const baselineMatches = matching.filter((value) => isRecord(value) && value.route === row.baseline_route);
  const candidateMatches = matching.filter((value) => isRecord(value) && value.route === row.policy_route);
  if (baselineMatches.length !== 1 || candidateMatches.length !== 1 ||
      matching.length !== 2) {
    if (baselineMatches.length > 1 || candidateMatches.length > 1) {
      return { status: "rejected", route: callerRoute, reason: "ambiguous-evidence", ...baseContext };
    }
    return { status: "fallback", route: callerRoute, reason: "unproven-evidence", ...baseContext };
  }

  const baselineRaw = baselineMatches[0];
  const candidateRaw = candidateMatches[0];
  const baselineIssue = evidenceIssue(baselineRaw);
  const candidateIssue = evidenceIssue(candidateRaw);
  if (baselineIssue === "unproven" || candidateIssue === "unproven") {
    return { status: "fallback", route: callerRoute, reason: "unproven-evidence", ...baseContext };
  }
  if (baselineIssue || candidateIssue) {
    return {
      status: "rejected",
      route: callerRoute,
      reason: baselineIssue ?? candidateIssue ?? "invalid-input",
      ...baseContext,
    };
  }

  const baseline = baselineRaw as ExperienceRouteEvidence;
  const candidate = candidateRaw as ExperienceRouteEvidence;
  const evidenceContext = context(version, shape, window, baseline.identity, candidate.identity);
  if (baseline.evidence_window !== window || candidate.evidence_window !== window) {
    return { status: "fallback", route: callerRoute, reason: "evidence-window-mismatch", ...evidenceContext };
  }
  if (!sameIdentity(baseline.identity, candidate.identity)) {
    return { status: "fallback", route: callerRoute, reason: "unproven-evidence", ...evidenceContext };
  }
  if (baseline.samples < minimumSamples || candidate.samples < minimumSamples) {
    return { status: "fallback", route: callerRoute, reason: "sparse-evidence", ...evidenceContext };
  }

  const durationLimit = baseline.duration.milliseconds * rawPolicy.duration_threshold;
  const costLimit = baseline.cost.amount * rawPolicy.cost_threshold;
  if (!Number.isFinite(durationLimit) || !Number.isFinite(costLimit)) {
    return { status: "rejected", route: callerRoute, reason: "invalid-number", ...evidenceContext };
  }
  if (candidate.duration.milliseconds > durationLimit || candidate.cost.amount > costLimit) {
    return { status: "fallback", route: callerRoute, reason: "threshold-not-met", ...evidenceContext };
  }

  return {
    status: "proposed",
    route: row.policy_route,
    reason: "matched-evidence-within-thresholds",
    ...evidenceContext,
  };
}
