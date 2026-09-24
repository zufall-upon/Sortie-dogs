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
}

/** Host-owned extension. It is not parsed from project JSON or a worker's prompt. */
export interface RuntimeBridge {
  readonly profile: RuntimeProfile;
  readonly assetVersion: string;
  readonly defaultModelRouting?: ModelRoutingConfig;
  readonly defaultModelCatalog?: import("./model-routing.js").ModelCatalog;
  transformConfiguration?(value: unknown): unknown;
  continuationCheckpoint?(rootSessionID: string): Promise<string | undefined>;
  requiresExplicitAcceptance?(rootSessionID: string): Promise<boolean>;
  ownsCanonicalValidation?(rootSessionID: string, unitID: string, childSessionID: string,
    command: string): Promise<boolean>;
  allowsInvestigativeShell?(sessionID: string): Promise<boolean>;
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
    currentBudget(rootSessionID: string): Promise<{
      readonly max_units: number;
      readonly consumed_units: number;
      readonly reserved_units: number;
      readonly remaining_units: number;
    } | null>;
    renderReturnReport(rootSessionID: string, text: string, receiptFingerprint: string): Promise<string | undefined>;
    recoverUnitEvidence(rootSessionID: string, request: { unitID: string; childSessionID: string; manifestPath: string;
      manifestHash: string; goalFingerprint: string }): Promise<readonly GoalEvidence[]>;
    completeRoot(rootSessionID: string, acceptanceFingerprint: string): Promise<{
      status: "succeeded" | "awaiting-evidence";
      receipt?: GoalTerminalReceipt;
    }>;
    stopAutomaticRecovery(rootSessionID: string): Promise<void>;
    stopRoot(rootSessionID: string): Promise<void>;
  }): void;
}
