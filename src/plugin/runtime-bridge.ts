import type { GoalEvidence, GoalTerminalReceipt } from "../core/goal-bound.js";
import type { OperatorProposalGoalBinding } from "../core/operator-proposal.js";
import type { RuntimeProfile } from "../core/runtime-profile.js";
import type { OperatorRepairValidationRetryBinding, OperatorRepairValidationRetrySource } from "../core/operator-runtime.js";
import type { ModelRoutingConfig } from "./model-routing.js";

export interface SerialDispatchSettlement {
  readonly rootSessionID: string;
  readonly callID: string;
  readonly unitID: string;
  readonly childSessionID?: string;
  readonly disposition: "succeeded" | "failed" | "cancelled";
  readonly evidence: readonly GoalEvidence[];
  readonly resultClass: string;
  readonly failure?: { readonly command: readonly string[]; readonly outcome: "fail"; readonly exitCode: number | null };
  readonly nativeOutcome?: "completed" | "failed";
}

/** Persisted on the existing Mission attempt, not a separate recovery ledger. */
export interface MissionWorkerTerminalRecord {
  readonly runID: string;
  readonly unitID: string;
  readonly taskID: string;
  readonly callID: string;
  readonly childSessionID: string;
  readonly ownerSessionID: string;
  readonly outcome: "completed" | "failed";
  readonly descendants: readonly string[];
}

/** Actual required-check execution and its original protected-snapshot recipe, not acceptance criteria. */
export interface ReviewerCorrectionCheck {
  readonly dispatchCallID: string;
  readonly childSessionID: string;
  readonly callID: string;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly binding: NonNullable<GoalEvidence["protected_binding"]>;
  readonly source: string;
  readonly candidate: string;
  readonly fresh: boolean;
  /** A command that actually generated/formatted declared outputs retains its stable input digest. */
  readonly generatedInputs?: string;
}

/** Host-owned extension. It is not parsed from project JSON or a worker's prompt. */
export interface RuntimeBridge {
  readonly profile: RuntimeProfile;
  readonly assetVersion: string;
  readonly defaultModelRouting?: ModelRoutingConfig;
  readonly defaultModelCatalog?: import("./model-routing.js").ModelCatalog;
  transformConfiguration?(value: unknown): unknown;
  continuationCheckpoint?(rootSessionID: string): Promise<string | undefined>;
  /** Completed native reviews owned by the current mission's nested Coordinator. */
  completedReviewPrompts?(rootSessionID: string, requestedPrompt: string): Promise<readonly string[]>;
  /** Existing native Mission review state for the final user-facing card; no new review is run. */
  missionReviewPresentation?(rootSessionID: string): Promise<{
    verdict?: "PASS" | "evidence-gaps" | "skipped-low-risk" | "self-rechecked"; evidenceGaps?: string;
  } | undefined>;
  requiresExplicitAcceptance?(rootSessionID: string): Promise<boolean>;
  ownsCanonicalValidation?(rootSessionID: string, unitID: string, childSessionID: string,
    command: string): Promise<boolean>;
  /** Finish the existing host Git boundary before capturing this admitted validation's candidate. */
  beforeValidationSnapshot?(rootSessionID: string, childSessionID: string, command: string): Promise<boolean>;
  /** A repeated declared occurrence is required work, not duplicate evidence to skip. */
  requiresValidationExecution?(rootSessionID: string, taskID: string, childSessionID: string, commands: readonly string[]): Promise<boolean>;
  /** A mission's hash-pinned Task has already passed durable run/acceptance admission. */
  ownsMissionDispatch?(rootSessionID: string, callID: string, taskID: string): Promise<boolean>;
  /** Only an exact admitted correction Task is an implementation dispatch continuing the original Reviewer child. */
  ownsReviewerCorrectionDispatch?(rootSessionID: string, callID: string, taskID: string): Promise<boolean>;
  ownsReviewerCorrection?(childSessionID: string): Promise<boolean>;
  reviewerCorrectionValidationMembers?(childSessionID: string, command: string): Promise<string[] | undefined>;
  recordReviewerCorrectionCheck?(rootSessionID: string, taskID: string, check: ReviewerCorrectionCheck): Promise<void>;
  reviewerCorrectionValidation?(rootSessionID: string, callID: string, childSessionID: string, startedAt: number): Promise<{
    ready: boolean; reason?: string; failure?: SerialDispatchSettlement["failure"];
  } | undefined>;
  /** Durable operator dispatch identity survives adapter reload and missed after hooks. */
  recoverMissionDispatch?(rootSessionID: string, taskID: string): Promise<{
    callID: string; childSessionID?: string; cancelled: boolean; nativeOutcome?: "completed" | "failed";
  } | undefined>;
  onHostHandoffRepaired?(rootSessionID: string, taskID: string, handoffPath: string,
    original: string, repaired: string): Promise<void>;
  allowsInvestigativeShell?(sessionID: string): Promise<boolean>;
  assertMissionWrite?(sessionID: string, paths: readonly string[]): Promise<void>;
  expandMissionScope?(rootSessionID: string, childSessionID: string, taskID: string, paths: readonly string[],
    activate: (manifest: import("../core/types.js").OperationManifest) => Promise<() => Promise<void>>): Promise<void>;
  missionDispatchCall?(rootSessionID: string, childSessionID: string, taskID: string): Promise<string | undefined>;
  /** Exact existing running Mission grant, used by the full handoff Read transport. */
  missionReadBinding?(rootSessionID: string, childSessionID: string, handoffPath: string): Promise<{
    projectRoot: string; manifestPath: string; handoffHash: string; manifestHash: string;
  } | undefined>;
  onSerialSettlement?(settlement: SerialDispatchSettlement): Promise<void>;
  onRootTerminal?(rootSessionID: string, receipt: GoalTerminalReceipt): Promise<void>;
  connected?(control: {
    enableUnits(rootSessionID: string, maximum: number): void;
    isRoot(rootSessionID: string): Promise<boolean>;
    cancelChildren(rootSessionID: string): Promise<void>;
    settleRejectedDispatch(rootSessionID: string, callID: string): Promise<boolean>;
    restoreAcceptedUnit(rootSessionID: string, request: { taskID: string; handoffPath: string; handoffHash: string }): Promise<void>;
    restoreAcceptanceLineage(rootSessionID: string, request: { criteria: readonly string[]; fingerprint: string;
      currentTaskIDs: readonly string[] }): Promise<void>;
    restoreAcceptanceRemediationBaseline(rootSessionID: string, request: { failedTaskID: string;
      criteria: readonly string[]; fingerprint: string; currentTaskIDs: readonly string[] }): Promise<void>;
    registerGoalDeclaration(rootSessionID: string, prompt: string, missionRevision?: boolean): Promise<void>;
    relinkRegisteredGoal(rootSessionID: string, request: { prompt: string; expectedFingerprint: string;
      registeredAt: string }): Promise<void>;
    proposalGoalBinding(rootSessionID: string): Promise<OperatorProposalGoalBinding>;
    reserveProposalBudget(rootSessionID: string, intentID: string, callID: string,
      binding: OperatorProposalGoalBinding): Promise<void>;
    settleProposalBudget(rootSessionID: string, intentID: string, callID: string,
      disposition: "succeeded" | "failed" | "cancelled"): Promise<void>;
    assertProposalExecutionBudget(rootSessionID: string, binding: OperatorProposalGoalBinding,
      executionUnits: number): Promise<void>;
    hasNoGoalReservation(rootSessionID: string, unitID: string, callID: string): Promise<boolean>;
    assertActiveGoal(rootSessionID: string, goalFingerprint: string): Promise<void>;
    reconcileAbortedOperatorOrphan(rootSessionID: string): Promise<{ readonly status: "settled" | "no-orphan" | "unproven";
      readonly reservation_id?: string; readonly unit_id?: string; readonly reason?: string }>;
    proveApprovedRunAncestry(rootSessionID: string, oldGoalID: string, parentRunID: string): Promise<boolean>;
    retainOperatorContractRepairWorker(rootSessionID: string, taskID: string, childSessionID: string): Promise<void>;
    assertOperatorContractRepairValidationAvailable(rootSessionID: string, taskID: string, childSessionID: string): Promise<void>;
    remediationScopeExpansionAuthority(rootSessionID: string): Promise<string | undefined>;
    authorizeOperatorContractRepairValidation(rootSessionID: string, taskID: string, childSessionID: string,
      repairFingerprint: string): Promise<void>;
    authorizeOperatorContractRepairValidationRetry(rootSessionID: string,
      source: OperatorRepairValidationRetrySource & { readonly declarationFingerprint: string }): Promise<void>;
    activateOperatorContractRepairValidationRetry(rootSessionID: string, request: { taskID: string; childSessionID: string;
      callID: string; repairFingerprint: string; binding: OperatorRepairValidationRetryBinding }): Promise<void>;
    finishOperatorContractRepairValidation(rootSessionID: string, childSessionID: string): Promise<void>;
    currentReceipt(rootSessionID: string): Promise<GoalTerminalReceipt | undefined>;
    retireHistoricalGoal(rootSessionID: string): Promise<boolean>;
    isUncontractedGoal(rootSessionID: string, latestUserMessageID: string): Promise<boolean>;
    currentBudget(rootSessionID: string, options?: { reconcileUsage?: boolean }): Promise<{
      readonly max_units: number;
      readonly consumed_units: number;
      readonly reserved_units: number;
      readonly remaining_units: number;
    } | null>;
    extendMissionUnitBudget(rootSessionID: string, maxUnits: number): Promise<{
      readonly status: "extended" | "unchanged";
      readonly max_units: number;
      readonly consumed_units: number;
      readonly reserved_units: number;
      readonly remaining_units: number;
    }>;
    renderReturnReport(rootSessionID: string, text: string, receiptFingerprint: string,
      missionReview?: "PASS" | "evidence-gaps" | "skipped-low-risk" | "self-rechecked", reviewEvidenceGaps?: string): Promise<string | undefined>;
    recoverUnitEvidence(rootSessionID: string, request: { unitID: string; childSessionID: string; manifestPath: string;
      manifestHash: string; goalFingerprint: string }): Promise<readonly GoalEvidence[]>;
    completionReadiness(rootSessionID: string): Promise<import("./goal-completion.js").CompletionReadiness>;
    missionWorkerTerminal(rootSessionID: string, terminal: MissionWorkerTerminalRecord,
      writeScopes: readonly string[]): Promise<{ ready: boolean; reason?: string }>;
    restoreReviewerCorrectionChild(rootSessionID: string, childSessionID: string, callID: string, taskID: string): Promise<void>;
    expandMissionWriteGate(childSessionID: string, paths: readonly string[]): Promise<void>;
    completeRoot(rootSessionID: string, acceptanceFingerprint: string): Promise<{
      status: "succeeded" | "awaiting-evidence";
      receipt?: GoalTerminalReceipt;
      completion?: import("./goal-completion.js").CompletionReadiness;
    }>;
    stopAutomaticRecovery(rootSessionID: string): Promise<void>;
    stopRoot(rootSessionID: string): Promise<void>;
  }): void;
}
