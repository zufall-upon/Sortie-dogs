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

export type WorktreeParallelVersion = "0.1.0";
export type WorktreeParallelMode = "parallel" | "single-worker";
export type WorktreeParallelFailureCode =
  | "stale-base"
  | "scope-overlap"
  | "dirty-tree"
  | "abandoned-worker"
  | "merge-conflict";

export interface WorktreeFileScope {
  read: string[];
  write: string[];
}

export interface WorktreeParallelTask {
  task_id: string;
  worktree: string;
  branch: string;
  base_sha: string;
  depends_on: string[];
  scope: WorktreeFileScope;
}

export interface WorktreeCommitArtifact {
  task_id: string;
  base_sha: string;
  commit_sha: string;
  changed_paths: string[];
}

export interface WorktreeParallelMetrics {
  wall_clock_ms: number;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  conflict_count: number;
  validation_count: number;
}

export interface WorktreeParallelFailure {
  code: WorktreeParallelFailureCode;
  task_id: string;
  fallback: "stop" | "single-worker";
  detail: string;
}

export interface WorktreeParallelContract {
  version: WorktreeParallelVersion;
  mode: WorktreeParallelMode;
  max_workers: number;
  tasks: WorktreeParallelTask[];
  artifacts: WorktreeCommitArtifact[];
  failure: WorktreeParallelFailure | null;
  baseline_metrics: WorktreeParallelMetrics | null;
}

export type SchemaKind = "handoff" | "operation-manifest" | "worktree-parallel";

export type WorktreeParallelContractIssueCode =
  | "WTP001_DUPLICATE_IDENTITY"
  | "WTP002_DEPENDENCY_UNKNOWN"
  | "WTP003_DEPENDENCY_CYCLE"
  | "WTP004_MODE_WORKER_MISMATCH"
  | "WTP005_PATH_INVALID"
  | "WTP006_SCOPE_OVERLAP"
  | "WTP007_ARTIFACT_MISMATCH"
  | "WTP008_FAILURE_POLICY";

export interface WorktreeParallelContractIssue {
  code: WorktreeParallelContractIssueCode;
  pointer: string;
  message: string;
}

export interface WorktreeParallelContractValidationResult {
  ok: boolean;
  diagnostics: WorktreeParallelContractIssue[];
}

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
  | "H001"
  | "H002"
  | "H003"
  | "H004"
  | "H005"
  | "H006"
  | "H007"
  | "H008"
  | "H009"
  | "H010";

export type ManifestDiagnosticCode =
  | "H001_PATH_RELATIVE"
  | "H011_VALIDATION_MISSING"
  | "M002_SCOPE_NOT_ALLOWED"
  | "M003_SOURCE_NOT_DECLARED"
  | "M004_VERIFICATION_NOT_DECLARED"
  | "M005_CHANGED_PATH_NOT_WRITABLE"
  | "M007_CHANGED_PATHS_MISSING";

export type DiagnosticCode = SemanticIssueCode | ManifestDiagnosticCode;

export interface SemanticIssue {
  code: SemanticIssueCode;
  path: string;
  message: string;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  pointer: string;
  message: string;
}

export interface ManifestDiagnostic extends Diagnostic {
  code: ManifestDiagnosticCode;
  severity: "error" | "warning";
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

/** A diagnostic after the CLI has associated it with an input document. */
export interface CliDiagnostic {
  file: string;
  code: string;
  severity: Severity;
  pointer: string;
  message: string;
}
