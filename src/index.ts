export { lintHandoff } from "./core/validate-semantics.js";
export { validateWorktreeParallelContract } from "./core/validate-worktree-parallel.js";
export {
  LUNA_FABRIC_CONTRACT_VERSION,
  admitLunaFabric,
} from "./core/luna-fabric-contract.js";
export type {
  LunaFabricAdmission,
  LunaFabricContract,
  LunaFabricDiagnostic,
  LunaFabricExternalEffect,
  LunaFabricProvenance,
  LunaFabricSharedPath,
  LunaFabricSolReason,
  LunaFabricUnit,
  LunaFabricValidation,
} from "./core/luna-fabric-contract.js";
export {
  LUNA_FABRIC_MAX_ACTIVE,
  LunaFabricScheduler,
  createLunaFabricScheduler,
} from "./core/luna-fabric-scheduler.js";
export type {
  LunaFabricAdvance,
  LunaFabricSchedulerState,
  LunaFabricWave,
} from "./core/luna-fabric-scheduler.js";
export { validateWorktreeParallelSchema } from "./core/validate-schema.js";
export {
  ScopeLeaseError,
  ScopeLeaseRegistry,
} from "./core/scope-lease-registry.js";
export type {
  ScopeLease,
  ScopeLeaseAcquireRequest,
  ScopeLeaseRegistryOptions,
  ScopeLeaseErrorCode,
} from "./core/scope-lease-registry.js";
export {
  normalizeWorktreeScope,
  normalizeWorktreeScopePath,
  worktreeScopesConflict,
  worktreeScopesOverlap,
} from "./core/worktree-scope.js";
export type { WorktreeScope } from "./core/worktree-scope.js";
export {
  WorktreeLifecycle,
  WorktreeLifecycleError,
} from "./core/worktree-lifecycle.js";
export {
  ParallelDispatchCoordinator,
  ParallelDispatchError,
} from "./core/worktree-parallel-dispatch.js";
export {
  WorktreeIntegrationQueue,
  IntegrationQueueError,
} from "./core/worktree-integration-queue.js";
export * from "./core/worktree-commit-artifact.js";
export type {
  FabricDispatchSolReason,
  ParallelDispatchCoordinatorOptions,
  ParallelDispatchErrorCode,
  ParallelDispatchFabricPrepareResult,
  ParallelDispatchPrepareResult,
  ParallelDispatchClaim,
} from "./core/worktree-parallel-dispatch.js";
export type {
  ManagedWorktree,
  WorktreeBasePin,
  WorktreeCreateRequest,
  WorktreeLifecycleErrorCode,
  WorktreeLifecycleOptions,
  WorktreeLifecyclePhase,
  WorktreeSetupHook,
} from "./core/worktree-lifecycle.js";
export {
  initializeProject,
  ProjectInitializationError,
} from "./core/initialize.js";
export type {
  InitializationStatus,
  InitializeProjectResult,
  ProjectInitializationErrorCode,
} from "./core/initialize.js";
export { SortieDogsPlugin } from "./plugin/index.js";
export { SortieDogsV010Plugin, createProfiledPlugin } from "./plugin/profiled.js";
export * from "./core/runtime-profile.js";
export { OperatorRuntime, parseOperatorPlan, OPERATOR_LIMITS } from "./core/operator-runtime.js";
export type { OperatorPlan, OperatorState, OperatorUnit, OperatorTask } from "./core/operator-runtime.js";
/*
 * The OpenCode entry at "sortie-dogs/plugin" must export the plugin factory alone, so every other
 * plugin runtime symbol is public here instead.
 */
export {
  FreshSessionRequiredError,
  HandoffDeniedError,
  InvalidModelTargetError,
  ModelRoutingDeniedError,
  isExplicitTaskHandoff,
} from "./plugin/index.js";
export type {
  FreshSessionAction,
  FreshSessionReason,
  FreshSessionResult,
  HandoffDenialReason,
  OpenCodeEvent,
  OpenCodeHooks,
  OpenCodePlugin,
  OpenCodePluginInput,
  SortieDogsPluginOptions,
} from "./plugin/index.js";
export {
  CONSULTATION_CAPABILITIES,
  CONSULTATION_ROLE_POLICY,
  MAX_REVIEW_ARTIFACT_BYTES,
  SOURCE_REVIEW_RISK_TAGS,
  STRATEGY_TRIGGERS,
  evaluateReviewAvailability,
  evaluateReviewGate,
  evaluateSourceReviewRequirement,
  isSourceReviewRiskTag,
  requiresSourceReview,
  shouldConsultStrategy,
  validateReviewArtifact,
  validateReviewVerdict,
} from "./core/consultation.js";
export type {
  ConsultationAdapter,
  ConsultationCapability,
  ConsultationRequest,
  ConsultationResult,
  ReviewArtifact,
  ReviewAvailability,
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewGateInput,
  ReviewGateResult,
  ReviewVerdict,
  ReviewVerdictKind,
  SourceReviewConsultationRequest,
  SourceReviewConsultationResult,
  SourceReviewRequirement,
  SourceReviewRequirementInput,
  SourceReviewRiskTag,
  StrategyConsultationRequest,
  StrategyConsultationResult,
  StrategyTrigger,
  StrategyTriggerInput,
  UnavailableConsultationResult,
  ValidationResult,
} from "./core/consultation.js";
export type * from "./core/types.js";
export {
  ACCEPTANCE_CONTINUITY_AUTHORITY,
  ACCEPTANCE_CONTINUITY_EXTENSION,
  ACCEPTANCE_CONTINUITY_SCHEMA_VERSION,
  acceptanceContinuityFingerprint,
  inspectAcceptanceContinuity,
  MAX_ACCEPTANCE_CONTINUITY_BYTES,
  MAX_ACCEPTANCE_CRITERIA,
  normalizeAcceptanceCriteria,
} from "./core/acceptance-continuity.js";
export type {
  AcceptanceContinuityInspection,
  AcceptanceContinuityLedger,
} from "./core/acceptance-continuity.js";
export {
  inspectRetainedStateCapsule,
  MAX_RETAINED_STATE_BYTES,
  MAX_RETAINED_STATE_ITEMS,
  MAX_RETAINED_STATE_WARNINGS,
  RETAINED_STATE_AUTHORITY,
  RETAINED_STATE_EXTENSION,
  RETAINED_STATE_SCHEMA_VERSION,
} from "./core/retained-state.js";
export {
  canonicalizeEvidenceCapsule,
  DEFAULT_MAX_EVIDENCE_CAPSULES,
  EVIDENCE_CAPSULE_SCHEMA_VERSION,
  EvidenceCapsuleError,
  EvidenceCapsuleStore,
  evaluateEvidenceCapsuleFreshness,
  evidenceCapsuleHash,
  MAX_EVIDENCE_CAPSULE_BYTES,
  MAX_EVIDENCE_CAPSULE_ITEMS,
} from "./core/evidence-capsule.js";
export {
  createExecutionPlan,
  EXECUTION_PLAN_VERSION,
  ExecutionPlanError,
  executionPlanManifestFingerprint,
  inspectExecutionPlan,
} from "./core/execution-plan.js";
export type {
  ExecutionPlan,
  ExecutionPlanErrorCode,
} from "./core/execution-plan.js";
export {
  ACCEPTANCE_COMPILER_VERSION,
  compileAcceptanceCoverage,
  MAX_ACCEPTANCE_COMPILE_GAPS,
  MAX_ACCEPTANCE_COMPILE_ITEMS,
} from "./core/acceptance-compiler.js";
export type {
  AcceptanceCompileCoverage,
  AcceptanceCompileGap,
  AcceptanceCompileGapCode,
  AcceptanceCompileItem,
  AcceptanceCompileProposal,
  AcceptanceCompileResult,
  AcceptanceCompileValidation,
  AcceptanceCoverageMapEntry,
} from "./core/acceptance-compiler.js";
export {
  MAX_RUN_FLIGHT_EVENTS,
  MAX_RUN_FLIGHT_LEDGER_BYTES,
  reconstructRunFlightLedger,
  RUN_FLIGHT_LEDGER_SCHEMA_VERSION,
  RunFlightLedger,
  RunFlightLedgerError,
} from "./core/run-flight-ledger.js";
export {
  GOAL_BOUND_METADATA_KEY,
  GOAL_BOUND_SCHEMA_VERSION,
  GoalBoundError,
  goalFingerprint,
  reduceGoalFlight,
  selectGoalDelivery,
  validGoalEvidence,
} from "./core/goal-bound.js";
export type {
  GoalBudget,
  GoalDeliveryMode,
  GoalEvidence,
  GoalFlightEvent,
  GoalFlightEventRecord,
  GoalFlightState,
  GoalPhase,
  GoalStopReason,
  GoalTerminalReceipt,
  GoalTicketState,
} from "./core/goal-bound.js";
export { CancellableChildLifecycle, DEFAULT_CHILD_DEADLINE_MS } from "./core/child-lifecycle-runtime.js";
export { FailureSwarmRuntime } from "./core/failure-swarm-runtime.js";
export type { FailureSwarmRequest, ReadOnlyDiagnosisDescriptor, DiagnosisFinding } from "./core/failure-swarm-runtime.js";
export type { ChildLifecycleDescriptor, ChildLifecycleRuntime, ChildLifecycleResult } from "./core/child-lifecycle-runtime.js";
export { reconcileChildTerminal } from "./core/child-terminal-reconciliation.js";
export type { ChildTerminalIdentity, ChildTerminalObservation, ChildTerminalEvidence,
  ChildTerminalDisposition } from "./core/child-terminal-reconciliation.js";
export type {
  ChildFlightState,
  DiagnosisFlightState,
  DiagnosisSelection,
  FailureCategory,
  FlightBudgetCharge,
  FlightBudgetLimits,
  FlightResourceBudget,
  FlightResourceUsage,
  FlightObservation,
  FlightReferenceSet,
  FlightRole,
  FlightStage,
  RecoveryKind,
  RunFlightEvent,
  RunFlightEventRecord,
  RunFlightEvidenceAccess,
  RunFlightLedgerErrorCode,
  RunFlightState,
  TerminalDisposition,
} from "./core/run-flight-ledger.js";
export { createSortieResult, formatSortieResult, insertSortieResult } from "./plugin/run-metrics.js";
export type {
  SortieProofStatus,
  SortieResult,
  SortieResultMetric,
  SortieResultUnavailableReason,
} from "./plugin/run-metrics.js";
export type {
  EvidenceAcceptanceLink,
  EvidenceCapsule,
  EvidenceCapsuleErrorCode,
  EvidenceCapsuleFreshness,
  EvidenceCapsuleLookupRequest,
  EvidenceCapsuleLookupResult,
  EvidenceCapsuleProvenance,
  EvidenceCapsulePutResult,
  EvidenceRisk,
  EvidenceSourceReference,
  EvidenceValidationReference,
} from "./core/evidence-capsule.js";
export type {
  AdmissionReceipt,
  NextEvidenceDecision,
  RetainedStateCapsule,
  RetainedStateInspection,
  RetainedStateWarning,
  RetainedValidationAttempt,
} from "./core/retained-state.js";
