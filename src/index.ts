export { lintHandoff } from "./core/validate-semantics.js";
export { validateWorktreeParallelContract } from "./core/validate-worktree-parallel.js";
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
  ParallelDispatchCoordinatorOptions,
  ParallelDispatchErrorCode,
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
/*
 * The OpenCode entry at "sortie-dogs/plugin" must export the plugin factory alone, so every other
 * plugin runtime symbol is public here instead.
 */
export {
  HandoffDeniedError,
  InvalidModelTargetError,
  ModelRoutingDeniedError,
  isExplicitTaskHandoff,
} from "./plugin/index.js";
export type {
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
