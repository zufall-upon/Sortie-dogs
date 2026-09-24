/**
 * Version of the installable runtime assets. Kept in its own module so the plugin can compare an
 * installed project marker without importing every asset body.
 */
export const RUNTIME_ASSET_VERSION = "0.3.89-completion-proof-v1";
export const V010_RUNTIME_ASSET_VERSION = "0.10.0-v0912-language4-cost-rpt10-compaction-ref2-proposal1-review-remediation1-surface4-proposal-recovery2-quality1-terminal2-route1-path1-permission2-prerequisite1-v2-bridge1-intent1-reflection1-cancel1-proposal-budget1-goal-recovery1-delegate-execute1-v2-depth1-process-replacement1-unstarted-v2-1-cold-turn1-return-report-v2-2-root-revision1";

export const V011_RUNTIME_ASSET_VERSION = "0.11.2-user-proxy-execution-first-v1";

export type RuntimeAssetVersion = typeof RUNTIME_ASSET_VERSION | typeof V010_RUNTIME_ASSET_VERSION | typeof V011_RUNTIME_ASSET_VERSION;
