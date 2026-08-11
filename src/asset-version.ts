/**
 * Version of the installable runtime assets. Kept in its own module so the plugin can compare an
 * installed project marker without importing every asset body.
 */
export const RUNTIME_ASSET_VERSION = "0.3.6-card43";

export type RuntimeAssetVersion = typeof RUNTIME_ASSET_VERSION;
