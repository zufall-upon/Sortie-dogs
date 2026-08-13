export { lintHandoff } from "./core/validate-semantics.js";
export { validateWorktreeParallelContract } from "./core/validate-worktree-parallel.js";
export { validateWorktreeParallelSchema } from "./core/validate-schema.js";
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
