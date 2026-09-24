/**
 * Version of the installable runtime assets. Kept in its own module so the plugin can compare an
 * installed project marker without importing every asset body.
 */
export const RUNTIME_ASSET_VERSION = "0.3.89-completion-proof-v1";
export const V010_RUNTIME_ASSET_VERSION = "0.12.3-v2-zod-schema-compaction-v1";

export type RuntimeAssetVersion = typeof RUNTIME_ASSET_VERSION | typeof V010_RUNTIME_ASSET_VERSION;
