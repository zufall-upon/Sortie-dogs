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
  readonly task_id: string;
  readonly base_sha: string;
  readonly commit_sha: string;
  readonly branch: string;
  readonly changed_paths: readonly string[];
  readonly change_fingerprint: string;
  readonly validation: WorktreeCommitValidationEvidence;
}

export interface WorktreeCommitValidationEvidence {
  /** Absolute executable followed by its bounded argument vector. */
  readonly command: readonly string[];
  readonly exit_code: 0;
  readonly validation_fingerprint: string;
}

export interface WorktreeCommitValidationRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly timeout_ms?: number;
}

export interface WorktreeCommitProduceRequest {
  readonly descriptor: ParallelDispatchDescriptor;
  readonly managed_path: string;
  readonly validation: WorktreeCommitValidationRequest;
  readonly git_path?: string;
}

export interface WorktreeCommitVerifyRequest {
  readonly descriptor: ParallelDispatchDescriptor;
  readonly managed_path: string;
  readonly artifact: WorktreeCommitArtifact;
  readonly git_path?: string;
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

export type ParallelDispatchTaskPhase =
  | "pending"
  | "reserved"
  | "running"
  | "completed"
  | "failed"
  | "suppressed"
  | "abandoned";

export type ParallelDispatchOutcome = "completed" | "failed" | "blocked" | "cancelled";

/** Durable worker route identity. A run never changes its route after preparation. */
export type ParallelDispatchRoute = "sol-serial" | "luna-fabric";

export interface ParallelDispatchDescriptor {
  readonly run_id: string;
  readonly dispatch_id: string;
  readonly task_id: string;
  readonly managed_path: string;
  readonly branch: string;
  readonly base_sha: string;
  readonly depends_on: readonly string[];
  readonly scope_read: readonly string[];
  readonly scope_write: readonly string[];
  readonly parallel_group: string;
  readonly parallel_unit: string;
  readonly parallel_units: number;
  readonly attempt: 1 | 2;
  readonly contract_fingerprint: string;
}

export interface ParallelDispatchTaskSnapshot {
  readonly descriptor: ParallelDispatchDescriptor;
  readonly worktree_id: string;
  readonly phase: ParallelDispatchTaskPhase;
  readonly call_id: string | null;
  readonly child_session_id: string | null;
  readonly outcome: ParallelDispatchOutcome | null;
  readonly artifact: WorktreeCommitArtifact | null;
}

export interface ParallelDispatchFabricSnapshot {
  readonly total_units: number;
  readonly wave: number;
  readonly base_sha: string;
  readonly pending_unit_ids: readonly string[];
  readonly completed_unit_ids: readonly string[];
  readonly active_unit_ids: readonly string[];
  readonly unit_acceptance: Readonly<Record<string, readonly string[]>>;
  readonly lanes: Readonly<Record<string, number>>;
  readonly transition: "cleanup" | "creating" | null;
  readonly candidate_ref: string;
  readonly candidate_head: string;
  readonly wave_heads: readonly string[];
  readonly validation: {
    readonly command: readonly string[];
    readonly status: "pending" | "running" | "pass" | "fail";
    readonly fingerprint: string | null;
  };
  readonly review: {
    readonly status: "pending" | "pass" | "skip" | "fail";
    readonly fingerprint: string | null;
  };
  readonly promoted: boolean;
  readonly demotions: readonly {
    readonly unit_id: string;
    readonly luna_dispatch_id: string;
    readonly luna_worktree_id: string;
    readonly sol_dispatch_id: string;
  }[];
}

export interface ParallelDispatchSnapshot {
  readonly run_id: string;
  readonly owner_root: string;
  readonly project_root: string;
  readonly contract_fingerprint: string;
  readonly route: ParallelDispatchRoute;
  readonly max_workers: number;
  readonly cancelled: boolean;
  readonly archived: boolean;
  readonly terminal_reason: "completed" | "cancelled" | "failed" | null;
  readonly tasks: readonly ParallelDispatchTaskSnapshot[];
  readonly ready: readonly ParallelDispatchDescriptor[];
  readonly fabric?: ParallelDispatchFabricSnapshot;
}

export interface ParallelDispatchArchiveTask {
  readonly task_id: string;
  readonly depends_on: readonly string[];
  readonly worktree_id: string;
  readonly managed_path: string | null;
  readonly branch: string;
  readonly base_sha: string;
  readonly dispatch_id: string;
  readonly phase: ParallelDispatchTaskPhase;
  readonly call_id: string | null;
  readonly child_session_id: string | null;
  readonly outcome: ParallelDispatchOutcome | null;
  readonly artifact: WorktreeCommitArtifact | null;
}

export interface ParallelDispatchArchive {
  readonly run_id: string;
  readonly owner_root: string;
  readonly contract_fingerprint: string;
  readonly route: ParallelDispatchRoute;
  readonly cancelled: boolean;
  readonly terminal_reason: "completed" | "cancelled" | "failed";
  readonly tasks: readonly ParallelDispatchArchiveTask[];
  readonly fabric?: ParallelDispatchFabricSnapshot;
}

export type IntegrationQueuePhase =
  | "queued"
  | "preparing"
  | "remediation-required"
  | "prepared"
  | "integrated"
  | "failed";

export type IntegrationQueueErrorCode =
  | "invalid-archive"
  | "missing-dependency"
  | "dependency-cycle"
  | "duplicate-artifact"
  | "stale-base"
  | "merge-conflict"
  | "stale-target"
  | "dirty-tree"
  | "target-checked-out"
  | "queue-owned"
  | "queue-lease"
  | "corrupt-state"
  | "git-incompatible"
  | "validation-failed"
  | "review-failed"
  | "remediation-exhausted";

export type IntegrationQueueBlockerCode =
  | "merge-conflict"
  | "validation-failed"
  | "review-failed"
  | "remediation-exhausted";

export interface IntegrationQueueBlocker {
  readonly code: IntegrationQueueBlockerCode;
  readonly task_id: string;
  readonly candidate_base: string;
  readonly conflict_paths: readonly string[];
  readonly causal_task_ids: readonly string[];
  readonly attempts_remaining: 0 | 1;
}

export interface IntegrationQueueValidationSnapshot {
  readonly command: readonly string[];
  readonly status: "pending" | "pass" | "fail";
  readonly exit_code: number | null;
  readonly fingerprint: string | null;
  readonly candidate_head: string | null;
}

export interface IntegrationQueueReviewSnapshot {
  readonly status: "pending" | "pass" | "fail";
  readonly fingerprint: string | null;
  readonly candidate_head: string | null;
}

export interface ContainedValidationRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly timeout_ms: number;
}

export type ContainedValidationErrorCode = "invalid-request" | "execution-failed";

export type ContainedValidationResult =
  | {
    readonly ok: true;
    readonly command: readonly string[];
    readonly exit_code: 0;
    readonly fingerprint: string;
    readonly error: null;
  }
  | {
    readonly ok: false;
    readonly command: readonly string[];
    readonly exit_code: number | null;
    readonly fingerprint: string;
    readonly error: ContainedValidationErrorCode;
  };

export interface IntegrationQueueTaskSnapshot {
  readonly task_id: string;
  readonly source_commit: string;
  readonly original_source_commit: string;
  readonly synthetic_commit: string | null;
  readonly integrated: boolean;
}

export interface IntegrationQueueSnapshot {
  readonly owner_root: string;
  readonly run_id: string;
  readonly target_ref: string;
  readonly target_base: string;
  readonly phase: IntegrationQueuePhase;
  readonly candidate_head: string | null;
  readonly candidate_ref: string;
  readonly failure_code: IntegrationQueueErrorCode | null;
  readonly validation: IntegrationQueueValidationSnapshot;
  readonly review: IntegrationQueueReviewSnapshot;
  readonly blocker: IntegrationQueueBlocker | null;
  readonly remediation_attempts_used: 0 | 1;
  readonly tasks: readonly IntegrationQueueTaskSnapshot[];
  readonly cleanup_pending: readonly string[];
  readonly warnings: readonly string[];
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
