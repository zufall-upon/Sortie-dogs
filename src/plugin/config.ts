import {
  parseModelRoutingConfig,
  type ModelRoutingConfig,
} from "./model-routing.js";

export interface SortieDogsPluginOptions {
  operationManifestPath?: string;
  handoffPaths?: readonly string[];
  modelRouting?: ModelRoutingConfig;
}

export interface ConfiguredPlugin {
  kind: "configured";
  operationManifestPath: string;
  handoffPaths: readonly string[];
  modelRouting: ModelRoutingConfig;
}

export type PluginConfiguration = ConfiguredPlugin | { kind: "invalid" };

export const DEFAULT_PLUGIN_OPTIONS: Readonly<Required<SortieDogsPluginOptions>> = {
  operationManifestPath: "operation-manifest.json",
  handoffPaths: ["handoff.json"],
  modelRouting: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLayer(value: unknown): SortieDogsPluginOptions | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some(
    (key) => key !== "operationManifestPath" && key !== "handoffPaths" && key !== "modelRouting",
  )) {
    return undefined;
  }

  const manifestPath = value.operationManifestPath;
  const handoffPaths = value.handoffPaths;
  const modelRouting = value.modelRouting === undefined
    ? undefined
    : parseModelRoutingConfig(value.modelRouting);
  if (manifestPath !== undefined && (typeof manifestPath !== "string" || manifestPath.length === 0)) {
    return undefined;
  }
  if (
    handoffPaths !== undefined &&
    (!Array.isArray(handoffPaths) || handoffPaths.some((path) => typeof path !== "string" || path.length === 0))
  ) {
    return undefined;
  }
  if (value.modelRouting !== undefined && modelRouting === undefined) return undefined;
  return {
    operationManifestPath: manifestPath as string | undefined,
    handoffPaths: handoffPaths as readonly string[] | undefined,
    modelRouting,
  };
}

/** Merge defaults, optional project/env configuration, then the host override. */
export function resolvePluginConfiguration(...values: readonly unknown[]): PluginConfiguration {
  let operationManifestPath = DEFAULT_PLUGIN_OPTIONS.operationManifestPath;
  let handoffPaths = DEFAULT_PLUGIN_OPTIONS.handoffPaths;
  let modelRouting = DEFAULT_PLUGIN_OPTIONS.modelRouting;
  for (const value of values) {
    const layer = parseLayer(value);
    if (layer === undefined) return { kind: "invalid" };
    if (layer.operationManifestPath !== undefined) operationManifestPath = layer.operationManifestPath;
    if (layer.handoffPaths !== undefined) handoffPaths = layer.handoffPaths;
    if (layer.modelRouting !== undefined) modelRouting = { ...modelRouting, ...layer.modelRouting };
  }
  return { kind: "configured", operationManifestPath, handoffPaths, modelRouting };
}
