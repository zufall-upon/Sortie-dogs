/**
 * Version of the installable runtime assets. Kept in its own module so the plugin can compare an
 * installed project marker without importing every asset body.
 */
export const RUNTIME_ASSET_VERSION = "0.3.89-completion-proof-v1";
export const V010_RUNTIME_ASSET_VERSION = "0.10.0-beta.1-v0912-language4-cost-rpt10-compaction-ref1-proposal1-review-remediation1-surface3";

export type RuntimeAssetVersion = typeof RUNTIME_ASSET_VERSION | typeof V010_RUNTIME_ASSET_VERSION;
