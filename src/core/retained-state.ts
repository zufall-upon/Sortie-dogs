export const RETAINED_STATE_EXTENSION = "sortie-dogs/retained-state" as const;
export const RETAINED_STATE_SCHEMA_VERSION = "0.1" as const;
export const RETAINED_STATE_AUTHORITY = "shadow" as const;
export const MAX_RETAINED_STATE_BYTES = 16 * 1024;
export const MAX_RETAINED_STATE_ITEMS = 12;
export const MAX_RETAINED_STATE_WARNINGS = 8;

const MAX_SHORT = 256;
const MAX_TEXT = 1000;

export interface RetainedValidationAttempt {
  readonly command: string;
  readonly exit: number | null;
  readonly fingerprint: string;
}

export interface NextEvidenceDecision {
  readonly schema_version: "0.1";
  readonly authority: "shadow";
  readonly gap_id: string;
  readonly blocked_acceptance: string;
  readonly question: string;
  readonly expected_discrimination: string;
  readonly action: string;
  readonly stop_condition: string;
}

export interface AdmissionReceipt {
  readonly evidence_id: string;
  readonly source_agent: string;
  readonly source_revision: string;
  readonly evidence_fingerprint: string;
  readonly supports: readonly string[];
  readonly contradicts: readonly string[];
  readonly freshness_basis: string;
  readonly status: "recorded" | "recorded_with_warnings";
  readonly warnings: readonly string[];
}

export interface RetainedStateCapsule {
  readonly schema_version: "0.1";
  readonly authority: "shadow";
  readonly task_id: string;
  readonly acceptance_fingerprint: string;
  readonly source_manifest: "none" | readonly string[];
  readonly operation_manifest: "none" | string;
  readonly validation_history: readonly RetainedValidationAttempt[];
  readonly blockers: readonly string[];
  readonly next_action: string;
  readonly next_evidence_decision?: NextEvidenceDecision;
  readonly admissions?: readonly AdmissionReceipt[];
}

export interface RetainedStateWarning {
  readonly code: "malformed" | "oversize" | "optional_invalid";
  readonly message: string;
}

export interface RetainedStateInspection {
  readonly capsule: RetainedStateCapsule | undefined;
  readonly warnings: readonly RetainedStateWarning[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const isBoundedList = (value: unknown, max = MAX_RETAINED_STATE_ITEMS): value is unknown[] =>
  Array.isArray(value) && value.length <= max;
const isSourceManifest = (value: unknown): value is "none" | string[] =>
  value === "none" || (isBoundedList(value) && value.length === new Set(value).size && value.every((item) => isText(item, 512)));

function validAttempt(value: unknown): value is RetainedValidationAttempt {
  const exit = isObject(value) ? value.exit : undefined;
  return isObject(value) && isText(value.command, 1000) && (exit === null || (typeof exit === "number" && Number.isInteger(exit) && exit >= -1 && exit <= 255)) && isText(value.fingerprint, MAX_SHORT);
}

function validDecision(value: unknown): value is NextEvidenceDecision {
  return isObject(value) && value.schema_version === "0.1" && value.authority === "shadow" &&
    isText(value.gap_id, MAX_SHORT) && isText(value.blocked_acceptance) && isText(value.question) &&
    isText(value.expected_discrimination) && isText(value.action) && isText(value.stop_condition);
}

function validAdmission(value: unknown): value is AdmissionReceipt {
  return isObject(value) && isText(value.evidence_id, MAX_SHORT) && isText(value.source_agent, MAX_SHORT) &&
    isText(value.source_revision, MAX_SHORT) && isText(value.evidence_fingerprint, MAX_SHORT) &&
    isBoundedList(value.supports) && value.supports.every((item) => isText(item, MAX_SHORT)) &&
    isBoundedList(value.contradicts) && value.contradicts.every((item) => isText(item, MAX_SHORT)) &&
    isText(value.freshness_basis) && (value.status === "recorded" || value.status === "recorded_with_warnings") &&
    isBoundedList(value.warnings, MAX_RETAINED_STATE_WARNINGS) && value.warnings.every((item) => isText(item, MAX_SHORT));
}

export function inspectRetainedStateCapsule(handoff: unknown): RetainedStateInspection {
  if (!isObject(handoff) || !isObject(handoff.ext) || !(RETAINED_STATE_EXTENSION in handoff.ext)) {
    return { capsule: undefined, warnings: [] };
  }
  const raw = handoff.ext[RETAINED_STATE_EXTENSION];
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength; } catch { return { capsule: undefined, warnings: [{ code: "malformed", message: "Retained state was ignored because it is malformed." }] }; }
  if (bytes > MAX_RETAINED_STATE_BYTES) return { capsule: undefined, warnings: [{ code: "oversize", message: "Retained state was ignored because it exceeds its bound." }] };
  if (!isObject(raw) || raw.schema_version !== "0.1" || raw.authority !== "shadow" || !isText(raw.task_id, MAX_SHORT) ||
    !isText(raw.acceptance_fingerprint, MAX_SHORT) || !isSourceManifest(raw.source_manifest) ||
    !(raw.operation_manifest === "none" || isText(raw.operation_manifest, 512)) ||
    !isBoundedList(raw.validation_history) || !raw.validation_history.every(validAttempt) ||
    !isBoundedList(raw.blockers) || !raw.blockers.every((item) => isText(item)) || !isText(raw.next_action)) {
    return { capsule: undefined, warnings: [{ code: "malformed", message: "Retained state was ignored because it is malformed." }] };
  }
  const capsule: {
    schema_version: "0.1";
    authority: "shadow";
    task_id: string;
    acceptance_fingerprint: string;
    source_manifest: "none" | string[];
    operation_manifest: "none" | string;
    validation_history: RetainedValidationAttempt[];
    blockers: string[];
    next_action: string;
    next_evidence_decision?: NextEvidenceDecision;
    admissions?: AdmissionReceipt[];
  } = {
    schema_version: "0.1",
    authority: "shadow",
    task_id: raw.task_id,
    acceptance_fingerprint: raw.acceptance_fingerprint,
    source_manifest: structuredClone(raw.source_manifest),
    operation_manifest: raw.operation_manifest,
    validation_history: structuredClone(raw.validation_history),
    blockers: structuredClone(raw.blockers),
    next_action: raw.next_action,
  };
  const warnings: RetainedStateWarning[] = [];
  if ("next_evidence_decision" in raw) {
    if (validDecision(raw.next_evidence_decision)) capsule.next_evidence_decision = structuredClone(raw.next_evidence_decision);
    else warnings.push({ code: "optional_invalid", message: "An optional retained-state decision was ignored." });
  }
  if ("admissions" in raw) {
    if (isBoundedList(raw.admissions)) {
      const validAdmissions = raw.admissions.filter(validAdmission);
      if (validAdmissions.length > 0 || raw.admissions.length === 0) capsule.admissions = structuredClone(validAdmissions) as AdmissionReceipt[];
      if (validAdmissions.length !== raw.admissions.length) warnings.push({ code: "optional_invalid", message: "Invalid retained-state admission receipts were ignored." });
    } else warnings.push({ code: "optional_invalid", message: "Optional retained-state admission receipts were ignored." });
  }
  return { capsule, warnings };
}
