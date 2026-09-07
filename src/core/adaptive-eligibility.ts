import type {
  AdaptiveRemediationPlatform,
  AdaptiveRemediationSelection,
} from "./types.js";

type Observation = boolean | null;

export interface AdaptiveEligibilityInput {
  readonly platform: AdaptiveRemediationPlatform;
  readonly canonical_validation_expensive: Observation;
  readonly repeatable_typed_signal: Observation;
  readonly signal_id: string | null;
  readonly signal_definition: string | null;
  readonly patch_reversible: Observation;
  readonly patch_isolated: Observation;
  readonly scope_bounded: Observation;
  readonly security_sensitive: Observation;
  readonly schema_migration: Observation;
  readonly release_or_publication: Observation;
  readonly irreversible_external_operation: Observation;
  readonly explicit_standard_override: Observation;
}

export type AdaptiveEligibilityDetailReason =
  | "eligible"
  | "explicit-standard-override"
  | "security-sensitive"
  | "schema-migration"
  | "release-or-publication"
  | "irreversible-external-operation"
  | "canonical-validation-not-expensive"
  | "canonical-validation-unknown"
  | "signal-not-repeatable"
  | "signal-repeatability-unknown"
  | "signal-undefined"
  | "patch-not-reversible"
  | "patch-reversibility-unknown"
  | "patch-not-isolated"
  | "patch-isolation-unknown"
  | "scope-not-bounded"
  | "scope-bounds-unknown"
  | "risk-status-unknown";

export type AdaptiveEligibilityRejectionReason = "invalid-input" | "unsupported-platform";

export type AdaptiveEligibilityOutcome =
  | {
      readonly status: "selected";
      readonly selection: AdaptiveRemediationSelection;
      readonly detail_reason: AdaptiveEligibilityDetailReason;
    }
  | {
      readonly status: "rejected";
      readonly selection: null;
      readonly reason: AdaptiveEligibilityRejectionReason;
    };

const INPUT_KEYS = [
  "platform",
  "canonical_validation_expensive",
  "repeatable_typed_signal",
  "signal_id",
  "signal_definition",
  "patch_reversible",
  "patch_isolated",
  "scope_bounded",
  "security_sensitive",
  "schema_migration",
  "release_or_publication",
  "irreversible_external_operation",
  "explicit_standard_override",
] as const;

const OBSERVATION_KEYS = [
  "canonical_validation_expensive",
  "repeatable_typed_signal",
  "patch_reversible",
  "patch_isolated",
  "scope_bounded",
  "security_sensitive",
  "schema_migration",
  "release_or_publication",
  "irreversible_external_operation",
  "explicit_standard_override",
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isObservation = (value: unknown): value is Observation =>
  value === true || value === false || value === null;

const isOptionalIdentifier = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length > 0 && value.trim() === value);

function selection(
  platform: AdaptiveRemediationPlatform,
  mode: AdaptiveRemediationSelection["mode"],
  reason: AdaptiveRemediationSelection["reason"],
  detailReason: AdaptiveEligibilityDetailReason,
): AdaptiveEligibilityOutcome {
  return {
    status: "selected",
    selection: { mode, reason, activation_reason: detailReason, platform },
    detail_reason: detailReason,
  };
}

/**
 * Selects an inert remediation mode from declared eligibility observations only.
 * It does not probe the platform, construct a runtime contract, or perform remediation.
 */
export function selectAdaptiveRemediation(input: unknown): AdaptiveEligibilityOutcome {
  if (!isObject(input) || Object.keys(input).some((key) => !INPUT_KEYS.includes(key as typeof INPUT_KEYS[number])) ||
    !OBSERVATION_KEYS.every((key) => Object.hasOwn(input, key) && isObservation(input[key])) ||
    !Object.hasOwn(input, "signal_id") || !isOptionalIdentifier(input.signal_id) ||
    !Object.hasOwn(input, "signal_definition") || !isOptionalIdentifier(input.signal_definition)) {
    return { status: "rejected", selection: null, reason: "invalid-input" };
  }

  if (input.platform !== "windows" && input.platform !== "wsl") {
    return { status: "rejected", selection: null, reason: "unsupported-platform" };
  }
  const platform = input.platform;

  if (input.explicit_standard_override === true) {
    return selection(platform, "standard", "unsafe-target", "explicit-standard-override");
  }
  if (input.security_sensitive === true) {
    return selection(platform, "standard", "unsafe-target", "security-sensitive");
  }
  if (input.schema_migration === true) {
    return selection(platform, "standard", "unsafe-target", "schema-migration");
  }
  if (input.release_or_publication === true) {
    return selection(platform, "standard", "unsafe-target", "release-or-publication");
  }
  if (input.irreversible_external_operation === true) {
    return selection(platform, "standard", "unsafe-target", "irreversible-external-operation");
  }
  if ([
    input.security_sensitive,
    input.schema_migration,
    input.release_or_publication,
    input.irreversible_external_operation,
    input.explicit_standard_override,
  ].some((value) => value === null)) {
    return selection(platform, "standard", "unsafe-target", "risk-status-unknown");
  }

  if (input.canonical_validation_expensive !== true) {
    return selection(
      platform,
      "standard",
      "validation-ineligible",
      input.canonical_validation_expensive === false
        ? "canonical-validation-not-expensive"
        : "canonical-validation-unknown",
    );
  }
  if (input.repeatable_typed_signal !== true) {
    return selection(
      platform,
      "standard",
      "validation-ineligible",
      input.repeatable_typed_signal === false ? "signal-not-repeatable" : "signal-repeatability-unknown",
    );
  }
  if (input.signal_id === null || input.signal_definition === null) {
    return selection(platform, "standard", "validation-ineligible", "signal-undefined");
  }
  if (input.patch_reversible !== true) {
    return selection(
      platform,
      "standard",
      "unsafe-target",
      input.patch_reversible === false ? "patch-not-reversible" : "patch-reversibility-unknown",
    );
  }
  if (input.patch_isolated !== true) {
    return selection(
      platform,
      "standard",
      "scope-ineligible",
      input.patch_isolated === false ? "patch-not-isolated" : "patch-isolation-unknown",
    );
  }
  if (input.scope_bounded !== true) {
    return selection(
      platform,
      "standard",
      "scope-ineligible",
      input.scope_bounded === false ? "scope-not-bounded" : "scope-bounds-unknown",
    );
  }

  return selection(platform, "adaptive-remediation", "eligible-auto", "eligible");
}
