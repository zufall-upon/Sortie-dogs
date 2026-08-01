export type HandoffVersion = "0.1.0";

export type HandoffProfile = "minimal" | "full";

export interface HandoffTask {
  title: string;
  objective: string;
}

export interface HandoffScope {
  paths: string[];
  excludes?: string[];
}

export interface HandoffBlocker {
  reason: string;
  needed: string;
}

export interface HandoffState {
  done: string[];
  next: string[];
  blocked: HandoffBlocker[];
}

export interface HandoffSource {
  path: string;
  rev: string;
  hash?: string;
}

export type RiskSeverity = "low" | "medium" | "high";

export interface HandoffRisk {
  severity: RiskSeverity;
  description: string;
  mitigation?: string;
}

export type VerificationStatus = "pass" | "fail" | "not_run";

export interface HandoffVerification {
  check: string;
  status: VerificationStatus;
  exit_code?: number | null;
  summary: string;
}

export interface Handoff {
  version: HandoffVersion;
  profile: HandoffProfile;
  ext?: Record<string, unknown>;
  id: string;
  created_at: string;
  task: HandoffTask;
  scope?: HandoffScope;
  state: HandoffState;
  sources?: HandoffSource[];
  risks: HandoffRisk[];
  verification: HandoffVerification[];
}

export type OperationManifestVersion = "0.1.0";

export interface OperationManifest {
  version: OperationManifestVersion;
  task_id: string;
  read: string[];
  write: string[];
  validation: string[];
}

export type SchemaKind = "handoff" | "operation-manifest";

export type SchemaDiagnosticCode = `schema_${string}`;

/** A structural validation diagnostic, intentionally separate from semantic lint. */
export interface SchemaDiagnostic {
  code: SchemaDiagnosticCode;
  severity: "error";
  pointer: string;
  message: string;
}

export interface SchemaValidationSuccess<T> {
  ok: true;
  value: T;
  diagnostics: [];
}

export interface SchemaValidationFailure {
  ok: false;
  value: unknown;
  diagnostics: SchemaDiagnostic[];
}

export type SchemaValidationResult<T> =
  | SchemaValidationSuccess<T>
  | SchemaValidationFailure;

export type SemanticIssueCode =
  | "verification_exit_code_mismatch"
  | "source_hash_length_mismatch";

export interface SemanticIssue {
  code: SemanticIssueCode;
  path: string;
  message: string;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  code: SemanticIssueCode;
  severity: Severity;
  pointer: string;
  message: string;
}

export interface LintOptions {
  codes?: readonly SemanticIssueCode[];
  severity?: Partial<Record<SemanticIssueCode, Severity>>;
}

export interface LintResult {
  diagnostics: Diagnostic[];
  counts: Record<Severity, number>;
  ok: boolean;
}
