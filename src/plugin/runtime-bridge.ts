import type { GoalEvidence, GoalTerminalReceipt } from "../core/goal-bound.js";
import type { RuntimeProfile } from "../core/runtime-profile.js";
import type { ModelRoutingConfig } from "./model-routing.js";

export interface SerialDispatchSettlement {
  readonly rootSessionID: string;
  readonly callID: string;
  readonly unitID: string;
  readonly childSessionID?: string;
  readonly disposition: "succeeded" | "failed" | "cancelled";
  readonly evidence: readonly GoalEvidence[];
  readonly resultClass: string;
}

/** Host-owned extension. It is not parsed from project JSON or a worker's prompt. */
export interface RuntimeBridge {
  readonly profile: RuntimeProfile;
  readonly assetVersion: string;
  readonly defaultModelRouting?: ModelRoutingConfig;
  onSerialSettlement?(settlement: SerialDispatchSettlement): Promise<void>;
  onRootTerminal?(rootSessionID: string, receipt: GoalTerminalReceipt): Promise<void>;
  connected?(control: {
    enableUnits(rootSessionID: string, maximum: number): void;
    isRoot(rootSessionID: string): Promise<boolean>;
    cancelChildren(rootSessionID: string): Promise<void>;
    stopAutomaticRecovery(rootSessionID: string): Promise<void>;
    stopRoot(rootSessionID: string): Promise<void>;
  }): void;
}
