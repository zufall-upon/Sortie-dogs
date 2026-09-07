import {
  DEFAULT_MAX_EVIDENCE_CAPSULES,
  EvidenceCapsuleError,
  evaluateEvidenceCapsuleFreshness,
  evidenceCapsuleHash,
  type EvidenceCapsule,
} from "./evidence-capsule.js";
import {
  MAX_RUN_FLIGHT_EVENTS,
  reconstructRunFlightLedger,
  RunFlightLedgerError,
  type RunFlightEventRecord,
} from "./run-flight-ledger.js";

export const MAX_EVIDENCE_LEDGER_AUDIT_REFERENCES = DEFAULT_MAX_EVIDENCE_CAPSULES;
export const MAX_EVIDENCE_LEDGER_AUDIT_SOURCES = MAX_RUN_FLIGHT_EVENTS * 2;

export interface EvidenceLedgerAuditCapsuleSnapshot {
  readonly capsule_id: string;
  readonly capsule: EvidenceCapsule;
}

export interface EvidenceLedgerAuditSourceBlob {
  readonly path: string;
  readonly blob_hash: string;
}

export interface EvidenceLedgerAuditInput {
  readonly ledger_records: readonly RunFlightEventRecord[];
  readonly declared_capsule_ids: readonly string[];
  readonly capsule_snapshot: readonly EvidenceLedgerAuditCapsuleSnapshot[];
  readonly current_sources: readonly EvidenceLedgerAuditSourceBlob[];
  readonly authorized_source_paths: readonly string[];
}

export type EvidenceLedgerAuditRejectionCode =
  | "audit_capacity"
  | "ledger_invalid"
  | "ledger_capacity"
  | "ledger_sequence"
  | "ledger_transition"
  | "ledger_budget"
  | "ledger_conflict"
  | "undeclared_capsule"
  | "missing_capsule"
  | "duplicate_capsule_identity"
  | "capsule_invalid"
  | "capsule_oversize"
  | "capsule_hash_mismatch"
  | "source_scope"
  | "source_input_invalid"
  | "source_hash_conflict"
  | "source_missing"
  | "source_changed";

export interface EvidenceLedgerAuditRejection {
  readonly code: EvidenceLedgerAuditRejectionCode;
  readonly capsule_id?: string;
  readonly source_path?: string;
}

export type EvidenceLedgerAuditResult =
  | {
    readonly status: "accepted";
    readonly referenced_capsule_ids: readonly string[];
  }
  | {
    readonly status: "rejected";
    readonly referenced_capsule_ids: readonly string[];
    readonly reason: EvidenceLedgerAuditRejection;
  };

const rejected = (
  referencedCapsuleIds: readonly string[],
  reason: EvidenceLedgerAuditRejection,
): EvidenceLedgerAuditResult => ({ status: "rejected", referenced_capsule_ids: referencedCapsuleIds, reason });

function ledgerRejectionCode(error: RunFlightLedgerError): EvidenceLedgerAuditRejectionCode {
  switch (error.code) {
    case "capacity": return "ledger_capacity";
    case "sequence": return "ledger_sequence";
    case "transition": return "ledger_transition";
    case "budget": return "ledger_budget";
    case "conflict": return "ledger_conflict";
    case "invalid": return "ledger_invalid";
  }
}

function referencedCapsuleIds(records: readonly RunFlightEventRecord[]): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if ("references" in record.event) {
      for (const capsuleId of record.event.references.capsule_ids) ids.add(capsuleId);
    }
  }
  return [...ids];
}

function normalizedSourceIdentity(sourcePath: string): string {
  return sourcePath.replaceAll("\\", "/").split("/")
    .filter((segment) => segment !== "" && segment !== ".").join("/");
}

export function auditEvidenceLedgerReferences(input: EvidenceLedgerAuditInput): EvidenceLedgerAuditResult {
  if (input.declared_capsule_ids.length > MAX_EVIDENCE_LEDGER_AUDIT_REFERENCES ||
    input.capsule_snapshot.length > MAX_EVIDENCE_LEDGER_AUDIT_REFERENCES ||
    input.current_sources.length > MAX_EVIDENCE_LEDGER_AUDIT_SOURCES ||
    input.authorized_source_paths.length > MAX_EVIDENCE_LEDGER_AUDIT_SOURCES) {
    return rejected([], { code: "audit_capacity" });
  }

  try {
    reconstructRunFlightLedger(input.ledger_records);
  } catch (error) {
    return rejected([], { code: error instanceof RunFlightLedgerError ? ledgerRejectionCode(error) : "ledger_invalid" });
  }

  const referenced = referencedCapsuleIds(input.ledger_records);
  if (referenced.length > MAX_EVIDENCE_LEDGER_AUDIT_REFERENCES) {
    return rejected(referenced.slice(0, MAX_EVIDENCE_LEDGER_AUDIT_REFERENCES), { code: "audit_capacity" });
  }

  const referencedSet = new Set(referenced);
  const declarationCounts = new Map<string, number>();
  for (const capsuleId of input.declared_capsule_ids) {
    if (referencedSet.has(capsuleId)) declarationCounts.set(capsuleId, (declarationCounts.get(capsuleId) ?? 0) + 1);
  }
  const snapshotById = new Map<string, EvidenceCapsule>();
  for (const entry of input.capsule_snapshot) {
    if (!referencedSet.has(entry.capsule_id)) continue;
    if (snapshotById.has(entry.capsule_id)) {
      return rejected(referenced, { code: "duplicate_capsule_identity", capsule_id: entry.capsule_id });
    }
    snapshotById.set(entry.capsule_id, entry.capsule);
  }

  const currentHashes = new Map<string, string>();
  for (const source of input.current_sources) {
    const identity = normalizedSourceIdentity(source.path);
    const existing = currentHashes.get(identity);
    if (existing !== undefined && existing !== source.blob_hash) {
      return rejected(referenced, { code: "source_hash_conflict" });
    }
    currentHashes.set(identity, source.blob_hash);
  }

  for (const capsuleId of referenced) {
    const declarationCount = declarationCounts.get(capsuleId) ?? 0;
    if (declarationCount === 0) return rejected(referenced, { code: "undeclared_capsule", capsule_id: capsuleId });
    if (declarationCount > 1) return rejected(referenced, { code: "duplicate_capsule_identity", capsule_id: capsuleId });
    const capsule = snapshotById.get(capsuleId);
    if (capsule === undefined) return rejected(referenced, { code: "missing_capsule", capsule_id: capsuleId });

    try {
      if (evidenceCapsuleHash(capsule) !== capsuleId) {
        return rejected(referenced, { code: "capsule_hash_mismatch", capsule_id: capsuleId });
      }
    } catch (error) {
      const code = error instanceof EvidenceCapsuleError && error.code === "oversize" ? "capsule_oversize" : "capsule_invalid";
      return rejected(referenced, { code, capsule_id: capsuleId });
    }

    try {
      const freshness = evaluateEvidenceCapsuleFreshness(capsule, input.current_sources, input.authorized_source_paths);
      if (freshness.status === "stale") {
        const sourcePath = freshness.changed_relevant_paths[0];
        return rejected(referenced, {
          code: currentHashes.has(sourcePath) ? "source_changed" : "source_missing",
          capsule_id: capsuleId,
          source_path: sourcePath,
        });
      }
    } catch (error) {
      return rejected(referenced, {
        code: error instanceof EvidenceCapsuleError && error.code === "source_scope" ? "source_scope" : "source_input_invalid",
        capsule_id: capsuleId,
      });
    }
  }

  return { status: "accepted", referenced_capsule_ids: referenced };
}
