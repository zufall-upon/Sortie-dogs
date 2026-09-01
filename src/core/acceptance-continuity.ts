import { createHash } from "node:crypto";

export const ACCEPTANCE_CONTINUITY_EXTENSION = "sortie-dogs/acceptance-continuity" as const;
export const ACCEPTANCE_CONTINUITY_SCHEMA_VERSION = "0.1" as const;
export const ACCEPTANCE_CONTINUITY_AUTHORITY = "dispatch" as const;
export const MAX_ACCEPTANCE_CONTINUITY_BYTES = 32 * 1024;
export const MAX_ACCEPTANCE_CRITERIA = 24;

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const MAX_TASK_ID = 256;
const MAX_CRITERION = 2_000;

export interface AcceptanceContinuityLedger {
  readonly schema_version: "0.1";
  readonly authority: "dispatch";
  readonly task_id: string;
  readonly criteria: readonly string[];
  readonly fingerprint: string;
  readonly parent_fingerprint: "none" | string;
}

export interface AcceptanceContinuityInspection {
  readonly ledger: AcceptanceContinuityLedger | undefined;
  readonly error: "absent" | "malformed" | "oversize" | undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAcceptanceCriteria(criteria: readonly string[]): string[] {
  return criteria.map((criterion) => criterion.replace(/\r\n?/gu, "\n").normalize("NFC"));
}

export function acceptanceContinuityFingerprint(criteria: readonly string[]): string {
  const canonical = JSON.stringify(normalizeAcceptanceCriteria(criteria));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function inspectAcceptanceContinuity(handoff: unknown): AcceptanceContinuityInspection {
  if (!object(handoff) || !object(handoff.ext) || !(ACCEPTANCE_CONTINUITY_EXTENSION in handoff.ext)) {
    return { ledger: undefined, error: "absent" };
  }
  const raw = handoff.ext[ACCEPTANCE_CONTINUITY_EXTENSION];
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  } catch {
    return { ledger: undefined, error: "malformed" };
  }
  if (bytes > MAX_ACCEPTANCE_CONTINUITY_BYTES) return { ledger: undefined, error: "oversize" };
  if (!object(raw) || Object.keys(raw).some((key) => ![
    "schema_version", "authority", "task_id", "criteria", "fingerprint", "parent_fingerprint",
  ].includes(key)) || raw.schema_version !== ACCEPTANCE_CONTINUITY_SCHEMA_VERSION ||
    raw.authority !== ACCEPTANCE_CONTINUITY_AUTHORITY || typeof raw.task_id !== "string" ||
    raw.task_id.length === 0 || raw.task_id.length > MAX_TASK_ID || !Array.isArray(raw.criteria) ||
    raw.criteria.length === 0 || raw.criteria.length > MAX_ACCEPTANCE_CRITERIA ||
    !raw.criteria.every((criterion) => typeof criterion === "string" && criterion.length > 0 && criterion.length <= MAX_CRITERION) ||
    new Set(raw.criteria).size !== raw.criteria.length || typeof raw.fingerprint !== "string" ||
    !FINGERPRINT.test(raw.fingerprint) || !(raw.parent_fingerprint === "none" ||
      (typeof raw.parent_fingerprint === "string" && FINGERPRINT.test(raw.parent_fingerprint)))) {
    return { ledger: undefined, error: "malformed" };
  }
  const criteria = normalizeAcceptanceCriteria(raw.criteria as string[]);
  if (new Set(criteria).size !== criteria.length || acceptanceContinuityFingerprint(criteria) !== raw.fingerprint) {
    return { ledger: undefined, error: "malformed" };
  }
  return {
    ledger: {
      schema_version: ACCEPTANCE_CONTINUITY_SCHEMA_VERSION,
      authority: ACCEPTANCE_CONTINUITY_AUTHORITY,
      task_id: raw.task_id,
      criteria,
      fingerprint: raw.fingerprint,
      parent_fingerprint: raw.parent_fingerprint,
    },
    error: undefined,
  };
}
