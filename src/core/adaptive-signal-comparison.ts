export type AdaptiveSignalImprovementDirection = "increase" | "decrease";

export interface AdaptiveSignalDefinition {
  readonly signal_id: string;
  readonly improvement_direction: AdaptiveSignalImprovementDirection;
  readonly absolute_improvement_threshold: number;
}

export interface AdaptiveSignalObservation {
  readonly signal_id: string;
  readonly value: number | null;
}

export interface AdaptiveSignalComparisonInput {
  readonly signal: AdaptiveSignalDefinition;
  readonly baseline: AdaptiveSignalObservation;
  readonly current: AdaptiveSignalObservation;
}

export type AdaptiveSignalComparisonOutcome =
  | "improved"
  | "unchanged"
  | "worse"
  | "inconclusive";

export type AdaptiveSignalComparisonRejectionReason =
  | "invalid-input"
  | "invalid-signal-identity"
  | "invalid-improvement-direction"
  | "invalid-improvement-threshold"
  | "invalid-observation"
  | "numeric-overflow";

export type AdaptiveSignalComparisonResult =
  | { readonly status: "compared"; readonly outcome: AdaptiveSignalComparisonOutcome }
  | { readonly status: "rejected"; readonly reason: AdaptiveSignalComparisonRejectionReason };

const INPUT_KEYS = ["signal", "baseline", "current"] as const;
const SIGNAL_KEYS = [
  "signal_id",
  "improvement_direction",
  "absolute_improvement_threshold",
] as const;
const OBSERVATION_KEYS = ["signal_id", "value"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const isSignalId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

const reject = (reason: AdaptiveSignalComparisonRejectionReason): AdaptiveSignalComparisonResult =>
  ({ status: "rejected", reason });

/**
 * Compares two declared observations without probing, validation, or runtime side effects.
 * The result is evidence classification only; it does not establish convergence or authorize promotion.
 */
export function compareAdaptiveSignal(input: unknown): AdaptiveSignalComparisonResult {
  if (!isObject(input) || !hasOnlyKeys(input, INPUT_KEYS)
    || !Object.hasOwn(input, "signal") || !isObject(input.signal)
    || !Object.hasOwn(input, "baseline") || !isObject(input.baseline)
    || !Object.hasOwn(input, "current") || !isObject(input.current)
    || !hasOnlyKeys(input.signal, SIGNAL_KEYS)
    || !hasOnlyKeys(input.baseline, OBSERVATION_KEYS)
    || !hasOnlyKeys(input.current, OBSERVATION_KEYS)) {
    return reject("invalid-input");
  }

  const { signal, baseline, current } = input;
  if (!Object.hasOwn(signal, "signal_id") || !isSignalId(signal.signal_id)
    || !Object.hasOwn(baseline, "signal_id") || !isSignalId(baseline.signal_id)
    || !Object.hasOwn(current, "signal_id") || !isSignalId(current.signal_id)
    || signal.signal_id !== baseline.signal_id || signal.signal_id !== current.signal_id) {
    return reject("invalid-signal-identity");
  }
  if (!Object.hasOwn(signal, "improvement_direction")
    || (signal.improvement_direction !== "increase" && signal.improvement_direction !== "decrease")) {
    return reject("invalid-improvement-direction");
  }
  if (!Object.hasOwn(signal, "absolute_improvement_threshold")
    || typeof signal.absolute_improvement_threshold !== "number"
    || !Number.isFinite(signal.absolute_improvement_threshold)
    || signal.absolute_improvement_threshold < 0) {
    return reject("invalid-improvement-threshold");
  }

  if (!Object.hasOwn(baseline, "value") || !Object.hasOwn(current, "value")
    || (baseline.value !== null
      && (typeof baseline.value !== "number" || !Number.isFinite(baseline.value)))
    || (current.value !== null
      && (typeof current.value !== "number" || !Number.isFinite(current.value)))) {
    return reject("invalid-observation");
  }
  if (baseline.value === null || current.value === null) {
    return { status: "compared", outcome: "inconclusive" };
  }

  const directedDifference = signal.improvement_direction === "increase"
    ? current.value - baseline.value
    : baseline.value - current.value;
  if (!Number.isFinite(directedDifference)) return reject("numeric-overflow");
  if (directedDifference < 0) return { status: "compared", outcome: "worse" };
  if (directedDifference === 0 || directedDifference < signal.absolute_improvement_threshold) {
    return { status: "compared", outcome: "unchanged" };
  }
  return { status: "compared", outcome: "improved" };
}
