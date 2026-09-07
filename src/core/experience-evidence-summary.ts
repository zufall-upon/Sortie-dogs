import type {
  ExperienceEvidenceIdentity,
  ExperienceRoute,
  ExperienceRouteEvidence,
} from "./experience-route-policy.js";

export interface ExperienceRunObservation {
  /** Caller-owned identity. Uniqueness is enforced across the complete input. */
  readonly run_id: string;
  readonly completed: boolean;
  readonly shape: string;
  readonly route: ExperienceRoute;
  readonly evidence_window: string;
  readonly identity: ExperienceEvidenceIdentity;
  /** End-to-end duration for the complete run, including failed attempts. */
  readonly duration_ms: number | null;
  /** Caller-declared estimated cost for the complete run, including failed attempts. */
  readonly estimated_cost_amount: number | null;
}

export interface SummarizeExperienceEvidenceInput {
  readonly observations: readonly ExperienceRunObservation[];
}

export type ExperienceEvidenceSummaryRejectionReason =
  | "invalid-input"
  | "invalid-identity"
  | "duplicate-run-identity"
  | "unknown-route"
  | "invalid-number";

export type ExperienceEvidenceSummaryResult =
  | {
      readonly status: "summarized";
      readonly reason: "complete-caller-observations";
      readonly evidence: readonly ExperienceRouteEvidence[];
    }
  | {
      readonly status: "inconclusive";
      readonly reason: "empty-observations" | "incomplete-run" | "missing-observation";
      readonly evidence: readonly [];
    }
  | {
      readonly status: "rejected";
      readonly reason: ExperienceEvidenceSummaryRejectionReason;
      readonly evidence: readonly [];
    };

const ROUTES: readonly ExperienceRoute[] = [
  "sol-serial",
  "luna-fabric",
  "luna-fabric-with-escalation",
];

const OBSERVATION_FIELDS = [
  "run_id",
  "completed",
  "shape",
  "route",
  "evidence_window",
  "identity",
  "duration_ms",
  "estimated_cost_amount",
] as const;

const IDENTITY_FIELDS = ["package", "fixture", "validation", "cache", "price_basis", "denominator"] as const;
const EMPTY_EVIDENCE: readonly [] = Object.freeze([]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRoute(value: unknown): value is ExperienceRoute {
  return typeof value === "string" && ROUTES.includes(value as ExperienceRoute);
}

function isIdentity(value: unknown): value is ExperienceEvidenceIdentity {
  return isRecord(value) && hasOnly(value, IDENTITY_FIELDS) &&
    isText(value.package) && isText(value.fixture) && isText(value.validation) &&
    isText(value.cache) && isText(value.price_basis) && isText(value.denominator);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Length-prefixing keeps grouping unambiguous when values contain separators. */
function compoundKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

function groupKey(observation: ExperienceRunObservation): string {
  return compoundKey([
    observation.shape,
    observation.route,
    observation.evidence_window,
    observation.identity.package,
    observation.identity.fixture,
    observation.identity.validation,
    observation.identity.cache,
    observation.identity.price_basis,
    observation.identity.denominator,
  ]);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const upper = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[upper];
  const lowerValue = sorted[upper - 1];
  const upperValue = sorted[upper];
  return lowerValue + (upperValue - lowerValue) / 2;
}

function reject(reason: ExperienceEvidenceSummaryRejectionReason): ExperienceEvidenceSummaryResult {
  return Object.freeze({ status: "rejected", reason, evidence: EMPTY_EVIDENCE });
}

function inconclusive(reason: "empty-observations" | "incomplete-run" | "missing-observation"):
ExperienceEvidenceSummaryResult {
  return Object.freeze({ status: "inconclusive", reason, evidence: EMPTY_EVIDENCE });
}

/**
 * Purely summarizes caller-supplied observations. It performs no measurement, pricing, route
 * selection, budget change, or promotion authorization. Cost and completeness remain caller claims.
 */
export function summarizeExperienceEvidence(input: unknown): ExperienceEvidenceSummaryResult {
  if (!isRecord(input) || !hasOnly(input, ["observations"]) || !Array.isArray(input.observations)) {
    return reject("invalid-input");
  }
  if (input.observations.length === 0) return inconclusive("empty-observations");

  const observations: ExperienceRunObservation[] = [];
  const runIds = new Set<string>();
  let hasIncompleteRun = false;
  let hasMissingObservation = false;

  for (const value of input.observations) {
    if (!isRecord(value) || !hasOnly(value, OBSERVATION_FIELDS)) return reject("invalid-input");
    if (!isText(value.run_id) || !isIdentity(value.identity)) return reject("invalid-identity");
    if (runIds.has(value.run_id)) return reject("duplicate-run-identity");
    runIds.add(value.run_id);
    if (!isRoute(value.route)) return reject("unknown-route");
    if (!isText(value.shape) || !isText(value.evidence_window) || typeof value.completed !== "boolean") {
      return reject("invalid-input");
    }
    if (value.duration_ms !== null && !isFiniteNonNegative(value.duration_ms)) return reject("invalid-number");
    if (value.estimated_cost_amount !== null && !isFiniteNonNegative(value.estimated_cost_amount)) {
      return reject("invalid-number");
    }
    if (!value.completed) hasIncompleteRun = true;
    if (value.duration_ms === null || value.estimated_cost_amount === null) hasMissingObservation = true;
    observations.push(value as unknown as ExperienceRunObservation);
  }

  if (hasIncompleteRun) return inconclusive("incomplete-run");
  if (hasMissingObservation) return inconclusive("missing-observation");

  const groups = new Map<string, ExperienceRunObservation[]>();
  for (const observation of observations) {
    const key = groupKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  const evidence = [...groups.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, group]): ExperienceRouteEvidence => {
      const first = group[0];
      const identity = Object.freeze({ ...first.identity });
      return Object.freeze({
        shape: first.shape,
        route: first.route,
        evidence_window: first.evidence_window,
        identity,
        samples: group.length,
        duration: Object.freeze({
          metric_kind: "end-to-end-median",
          milliseconds: median(group.map((observation) => observation.duration_ms as number)),
        }),
        cost: Object.freeze({
          metric_kind: "estimated-cost-median",
          amount: median(group.map((observation) => observation.estimated_cost_amount as number)),
          price_basis: identity.price_basis,
          denominator: identity.denominator,
        }),
      });
    });

  return Object.freeze({
    status: "summarized",
    reason: "complete-caller-observations",
    evidence: Object.freeze(evidence),
  });
}
