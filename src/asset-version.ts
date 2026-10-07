/**
 * Version of the installable runtime assets. Kept in its own module so the plugin can compare an
 * installed project marker without importing every asset body.
 */
export const RUNTIME_ASSET_VERSION = "0.3.89-completion-proof-v1";
export const V010_RUNTIME_ASSET_VERSION = "0.13.9-codex-operation-v1";
export const CODEX_SKILL_ASSET_VERSION = "0.13.9-codex-skill-v2";

export type RuntimeAssetVersion =
  | typeof RUNTIME_ASSET_VERSION
  | typeof V010_RUNTIME_ASSET_VERSION
  | typeof CODEX_SKILL_ASSET_VERSION;
