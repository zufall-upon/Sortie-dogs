import type {
  FailureCategory,
  FlightObservation,
  RecoveryKind,
  TerminalDisposition,
} from "./run-flight-ledger.js";

export interface RecoveryOutcomeAttemptIdentity {
  readonly run_id: string;
  readonly unit_id: string;
  readonly attempt_id: string;
}

export interface RecoveryOutcomeProvenance {
  /** Caller-resolved ledger reference. This module does not authenticate it or perform ledger I/O. */
  readonly ledger_ref: string;
  readonly event_sequence: number;
}

export interface RecoveryOutcomeAttempt {
  readonly identity: RecoveryOutcomeAttemptIdentity;
  readonly task_shape: string;
  readonly recovery_kind: RecoveryKind | "implementation";
  readonly disposition: TerminalDisposition;
  readonly failure: { readonly category: FailureCategory; readonly code: string } | null;
  /** True means this attempt produced an accepted unit completion; null preserves unresolved status. */
  readonly accepted_completion: boolean | null;
  readonly intervention_count: number;
  readonly observation: FlightObservation;
  /** Caller-owned pricing basis for observation.estimated_cost.usd. */
  readonly cost_price_basis: string | null;
  readonly provenance: RecoveryOutcomeProvenance;
}

export interface RecoveryOutcomeAggregateInput {
  readonly attempts: readonly RecoveryOutcomeAttempt[];
  /** Explicit caller-selected bound. No module default is substituted. */
  readonly max_attempts: number;
}

export type RecoveryOutcomeAggregateRejectionCode =
  | "invalid-input"
  | "invalid-limit"
  | "limit-exceeded"
  | "duplicate-attempt"
  | "identity-conflict"
  | "invalid-number"
  | "overflow";

export interface RecoveryOutcomeCostBucket {
  readonly currency: "USD";
  readonly price_basis: string | null;
  readonly provenance: FlightObservation["estimated_cost"]["provenance"];
  readonly attempt_count: number;
  readonly observed_count: number;
  readonly missing_count: number;
  readonly known_sum: number;
  /** Null unless every cost in this distinct basis/provenance bucket was observed. */
  readonly complete_sum: number | null;
  /** Null unless the whole shape has one complete price basis and a non-zero accepted-unit denominator. */
  readonly cost_per_accepted_unit: number | null;
  readonly denominator_scope: "accepted-unit";
}

export interface RecoveryOutcomeShapeAggregate {
  readonly task_shape: string;
  readonly attempt_count: number;
  readonly unit_count: number;
  readonly failures: Readonly<Record<FailureCategory | "none", number>>;
  readonly rescue: {
    readonly attempt_count: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly unresolved: number;
  };
  readonly intervention_count: number;
  readonly completion: {
    readonly accepted_units: number;
    readonly not_accepted_units: number;
    readonly unknown_units: number;
  };
  readonly duration: {
    readonly observed_attempt_count: number;
    readonly missing_attempt_count: number;
    readonly known_sum_ms: number;
    readonly complete_sum_ms: number | null;
    readonly interpretation: "sum-of-attempt-observations-not-wall-clock";
  };
  readonly estimated_cost: {
    readonly currency: "USD";
    readonly missing_attempt_count: number;
    readonly buckets: readonly RecoveryOutcomeCostBucket[];
  };
  readonly provenance: readonly {
    readonly identity: RecoveryOutcomeAttemptIdentity;
    readonly ledger_ref: string;
    readonly event_sequence: number;
  }[];
}

export type RecoveryOutcomeAggregateResult =
  | { readonly status: "rejected"; readonly code: RecoveryOutcomeAggregateRejectionCode; readonly identity: RecoveryOutcomeAttemptIdentity | null }
  | { readonly status: "aggregated"; readonly shapes: readonly RecoveryOutcomeShapeAggregate[] };

const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "infrastructure", "authorization", "contract", "cancellation", "implementation",
];
const RECOVERY_KINDS: readonly (RecoveryKind | "implementation")[] = [
  "implementation", "normal_remediation", "adaptive_probe", "read_only_diagnosis", "model_rescue",
];
const DISPOSITIONS: readonly TerminalDisposition[] = ["continue", "succeeded", "failed", "cancelled"];
const STAGES: readonly FlightObservation["stage"][] = ["planning", "route", "unit", "wave", "candidate", "cleanup", "recovery"];
const USAGE_PROVENANCE: readonly FlightObservation["usage"]["provenance"][] = ["measured", "provider_estimate", "unknown"];
const COST_PROVENANCE: readonly FlightObservation["estimated_cost"]["provenance"][] = ["provider_estimate", "calculated", "unknown"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field));
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

function validIdentity(value: unknown): value is RecoveryOutcomeAttemptIdentity {
  return isRecord(value) && only(value, ["run_id", "unit_id", "attempt_id"]) &&
    text(value.run_id) && text(value.unit_id) && text(value.attempt_id);
}

function validProvenance(value: unknown): value is RecoveryOutcomeProvenance {
  return isRecord(value) && only(value, ["ledger_ref", "event_sequence"]) &&
    text(value.ledger_ref) && Number.isSafeInteger(value.event_sequence) && Number(value.event_sequence) > 0;
}

function validObservation(value: unknown): value is FlightObservation {
  if (!isRecord(value) || !only(value, ["stage", "duration_ms", "usage", "estimated_cost"]) ||
    !STAGES.includes(value.stage as FlightObservation["stage"]) ||
    !(value.duration_ms === null || safeNonNegativeInteger(value.duration_ms)) ||
    !isRecord(value.usage) || !isRecord(value.estimated_cost)) return false;
  const usage = value.usage;
  const cost = value.estimated_cost;
  const tokens = [usage.input_tokens, usage.cache_read_tokens, usage.output_tokens];
  return only(usage, ["input_tokens", "cache_read_tokens", "output_tokens", "provenance"]) &&
    tokens.every((entry) => entry === null || safeNonNegativeInteger(entry)) &&
    USAGE_PROVENANCE.includes(usage.provenance as FlightObservation["usage"]["provenance"]) &&
    (usage.provenance !== "unknown" || tokens.every((entry) => entry === null)) &&
    only(cost, ["usd", "provenance"]) && (cost.usd === null || finiteNonNegative(cost.usd)) &&
    COST_PROVENANCE.includes(cost.provenance as FlightObservation["estimated_cost"]["provenance"]) &&
    (cost.provenance !== "unknown" || cost.usd === null);
}

function validAttempt(value: unknown): value is RecoveryOutcomeAttempt {
  if (!isRecord(value) || !only(value, [
    "identity", "task_shape", "recovery_kind", "disposition", "failure", "accepted_completion",
    "intervention_count", "observation", "cost_price_basis", "provenance",
  ]) || !validIdentity(value.identity) || !text(value.task_shape) ||
    !RECOVERY_KINDS.includes(value.recovery_kind as RecoveryKind | "implementation") ||
    !DISPOSITIONS.includes(value.disposition as TerminalDisposition) ||
    !(value.accepted_completion === null || typeof value.accepted_completion === "boolean") ||
    !safeNonNegativeInteger(value.intervention_count) || !validObservation(value.observation) ||
    !(value.cost_price_basis === null || text(value.cost_price_basis)) || !validProvenance(value.provenance)) return false;
  const failure = value.failure;
  if (failure === null ? value.disposition !== "succeeded" : value.disposition === "succeeded") return false;
  if (value.accepted_completion === true && value.disposition !== "succeeded") return false;
  if (value.observation.estimated_cost.usd !== null && value.cost_price_basis === null) return false;
  return failure === null || (isRecord(failure) && only(failure, ["category", "code"]) &&
    FAILURE_CATEGORIES.includes(failure.category as FailureCategory) && text(failure.code));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Length-prefixing prevents collisions when identifiers contain separators. */
function compoundKey(parts: readonly (string | number | null)[]): string {
  return parts.map((part) => {
    const value = part === null ? "" : String(part);
    return `${part === null ? -1 : value.length}:${value}`;
  }).join("");
}

function identityKey(identity: RecoveryOutcomeAttemptIdentity): string {
  return compoundKey([identity.run_id, identity.unit_id, identity.attempt_id]);
}

function unitKey(identity: RecoveryOutcomeAttemptIdentity): string {
  return compoundKey([identity.run_id, identity.unit_id]);
}

function reject(code: RecoveryOutcomeAggregateRejectionCode, identity: RecoveryOutcomeAttemptIdentity | null = null): RecoveryOutcomeAggregateResult {
  return { status: "rejected", code, identity };
}

function checkedIntegerAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function checkedFiniteAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isFinite(result) ? result : null;
}

interface MutableCostBucket {
  currency: "USD";
  price_basis: string | null;
  provenance: FlightObservation["estimated_cost"]["provenance"];
  attempt_count: number;
  observed_count: number;
  missing_count: number;
  known_sum: number;
}

interface MutableShape {
  task_shape: string;
  attempts: RecoveryOutcomeAttempt[];
}

/**
 * Pure deterministic aggregation over caller-resolved, bounded ledger observations. Failed attempts
 * remain in every applicable total. Missing duration/cost stays explicit; attempt-duration sums are
 * never represented as wall-clock runtime, and unlike pricing bases are never merged.
 */
export function aggregateRecoveryOutcomes(input: unknown): RecoveryOutcomeAggregateResult {
  if (!isRecord(input) || !only(input, ["attempts", "max_attempts"]) || !Array.isArray(input.attempts)) {
    return reject("invalid-input");
  }
  if (!Number.isSafeInteger(input.max_attempts) || Number(input.max_attempts) < 0) return reject("invalid-limit");
  if (input.attempts.length > Number(input.max_attempts)) return reject("limit-exceeded");

  const attempts: RecoveryOutcomeAttempt[] = [];
  for (const value of input.attempts) {
    if (!validAttempt(value)) {
      const identity = isRecord(value) && validIdentity(value.identity) ? value.identity : null;
      const numericFailure = isRecord(value) && (
        !(value.intervention_count === undefined || safeNonNegativeInteger(value.intervention_count)) ||
        (isRecord(value.observation) && !(value.observation.duration_ms === null || safeNonNegativeInteger(value.observation.duration_ms))) ||
        (isRecord(value.observation) && isRecord(value.observation.estimated_cost) &&
          !(value.observation.estimated_cost.usd === null || finiteNonNegative(value.observation.estimated_cost.usd)))
      );
      return reject(numericFailure ? "invalid-number" : "invalid-input", identity);
    }
    attempts.push(value);
  }
  attempts.sort((left, right) => compareCodeUnits(identityKey(left.identity), identityKey(right.identity)));

  const seenAttempts = new Set<string>();
  const attemptOwners = new Map<string, string>();
  const unitShapes = new Map<string, string>();
  const provenanceOwners = new Map<string, string>();
  for (const attempt of attempts) {
    const identity = identityKey(attempt.identity);
    if (seenAttempts.has(identity)) return reject("duplicate-attempt", attempt.identity);
    seenAttempts.add(identity);
    const runAttempt = compoundKey([attempt.identity.run_id, attempt.identity.attempt_id]);
    const owner = attemptOwners.get(runAttempt);
    if (owner !== undefined && owner !== unitKey(attempt.identity)) return reject("identity-conflict", attempt.identity);
    attemptOwners.set(runAttempt, unitKey(attempt.identity));
    const unit = unitKey(attempt.identity);
    const shape = unitShapes.get(unit);
    if (shape !== undefined && shape !== attempt.task_shape) return reject("identity-conflict", attempt.identity);
    unitShapes.set(unit, attempt.task_shape);
    const provenance = compoundKey([attempt.provenance.ledger_ref, attempt.provenance.event_sequence]);
    const provenanceOwner = provenanceOwners.get(provenance);
    if (provenanceOwner !== undefined && provenanceOwner !== identity) return reject("identity-conflict", attempt.identity);
    provenanceOwners.set(provenance, identity);
  }

  const byShape = new Map<string, MutableShape>();
  for (const attempt of attempts) {
    const aggregate = byShape.get(attempt.task_shape) ?? { task_shape: attempt.task_shape, attempts: [] };
    aggregate.attempts.push(attempt);
    byShape.set(attempt.task_shape, aggregate);
  }

  const shapes: RecoveryOutcomeShapeAggregate[] = [];
  for (const mutable of [...byShape.values()].sort((left, right) => compareCodeUnits(left.task_shape, right.task_shape))) {
    const failures: Record<FailureCategory | "none", number> = {
      infrastructure: 0, authorization: 0, contract: 0, cancellation: 0, implementation: 0, none: 0,
    };
    const rescue = { attempt_count: 0, succeeded: 0, failed: 0, cancelled: 0, unresolved: 0 };
    let interventionCount = 0;
    let knownDuration = 0;
    let durationObserved = 0;
    const unitCompletion = new Map<string, { accepted: boolean; unknown: boolean }>();
    const costBuckets = new Map<string, MutableCostBucket>();
    let missingCostCount = 0;

    for (const attempt of mutable.attempts) {
      failures[attempt.failure?.category ?? "none"] += 1;
      if (attempt.recovery_kind === "model_rescue") {
        rescue.attempt_count += 1;
        if (attempt.disposition === "succeeded") rescue.succeeded += 1;
        else if (attempt.disposition === "failed") rescue.failed += 1;
        else if (attempt.disposition === "cancelled") rescue.cancelled += 1;
        else rescue.unresolved += 1;
      }
      const nextInterventions = checkedIntegerAdd(interventionCount, attempt.intervention_count);
      if (nextInterventions === null) return reject("overflow", attempt.identity);
      interventionCount = nextInterventions;
      if (attempt.observation.duration_ms !== null) {
        const nextDuration = checkedIntegerAdd(knownDuration, attempt.observation.duration_ms);
        if (nextDuration === null) return reject("overflow", attempt.identity);
        knownDuration = nextDuration;
        durationObserved += 1;
      }
      const unit = unitKey(attempt.identity);
      const completion = unitCompletion.get(unit) ?? { accepted: false, unknown: false };
      if (attempt.accepted_completion === true) {
        if (completion.accepted) return reject("identity-conflict", attempt.identity);
        completion.accepted = true;
      } else if (attempt.accepted_completion === null) completion.unknown = true;
      unitCompletion.set(unit, completion);

      const cost = attempt.observation.estimated_cost;
      const bucketKey = compoundKey([attempt.cost_price_basis, cost.provenance]);
      const bucket = costBuckets.get(bucketKey) ?? {
        currency: "USD", price_basis: attempt.cost_price_basis, provenance: cost.provenance,
        attempt_count: 0, observed_count: 0, missing_count: 0, known_sum: 0,
      };
      bucket.attempt_count += 1;
      if (cost.usd === null) {
        bucket.missing_count += 1;
        missingCostCount += 1;
      } else {
        const nextCost = checkedFiniteAdd(bucket.known_sum, cost.usd);
        if (nextCost === null) return reject("overflow", attempt.identity);
        bucket.known_sum = nextCost;
        bucket.observed_count += 1;
      }
      costBuckets.set(bucketKey, bucket);
    }

    let acceptedUnits = 0;
    let unknownUnits = 0;
    for (const completion of unitCompletion.values()) {
      if (completion.accepted) acceptedUnits += 1;
      else if (completion.unknown) unknownUnits += 1;
    }
    const notAcceptedUnits = unitCompletion.size - acceptedUnits - unknownUnits;
    const singleCompleteCostBasis = costBuckets.size === 1 && missingCostCount === 0 && acceptedUnits > 0;
    const buckets = [...costBuckets.values()]
      .sort((left, right) => compareCodeUnits(
        compoundKey([left.price_basis, left.provenance]), compoundKey([right.price_basis, right.provenance]),
      ))
      .map((bucket): RecoveryOutcomeCostBucket => Object.freeze({
        ...bucket,
        complete_sum: bucket.missing_count === 0 ? bucket.known_sum : null,
        cost_per_accepted_unit: singleCompleteCostBasis ? bucket.known_sum / acceptedUnits : null,
        denominator_scope: "accepted-unit",
      }));
    if (buckets.some((bucket) => bucket.cost_per_accepted_unit !== null && !Number.isFinite(bucket.cost_per_accepted_unit))) {
      return reject("overflow");
    }

    shapes.push(Object.freeze({
      task_shape: mutable.task_shape,
      attempt_count: mutable.attempts.length,
      unit_count: unitCompletion.size,
      failures: Object.freeze(failures),
      rescue: Object.freeze(rescue),
      intervention_count: interventionCount,
      completion: Object.freeze({ accepted_units: acceptedUnits, not_accepted_units: notAcceptedUnits, unknown_units: unknownUnits }),
      duration: Object.freeze({
        observed_attempt_count: durationObserved,
        missing_attempt_count: mutable.attempts.length - durationObserved,
        known_sum_ms: knownDuration,
        complete_sum_ms: durationObserved === mutable.attempts.length ? knownDuration : null,
        interpretation: "sum-of-attempt-observations-not-wall-clock",
      }),
      estimated_cost: Object.freeze({ currency: "USD", missing_attempt_count: missingCostCount, buckets: Object.freeze(buckets) }),
      provenance: Object.freeze(mutable.attempts.map((attempt) => Object.freeze({
        identity: Object.freeze({ ...attempt.identity }),
        ledger_ref: attempt.provenance.ledger_ref,
        event_sequence: attempt.provenance.event_sequence,
      }))),
    }));
  }

  return Object.freeze({ status: "aggregated", shapes: Object.freeze(shapes) });
}
