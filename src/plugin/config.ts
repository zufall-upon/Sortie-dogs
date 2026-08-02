export interface SortieDogsPluginOptions {
  operationManifestPath?: string;
  handoffPaths?: readonly string[];
}

export interface ConfiguredPlugin {
  kind: "configured";
  operationManifestPath: string;
  handoffPaths: readonly string[];
}

export type PluginConfiguration = ConfiguredPlugin | { kind: "invalid" };

export const DEFAULT_PLUGIN_OPTIONS: Readonly<Required<SortieDogsPluginOptions>> = {
  operationManifestPath: "operation-manifest.json",
  handoffPaths: ["handoff.json"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLayer(value: unknown): SortieDogsPluginOptions | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => key !== "operationManifestPath" && key !== "handoffPaths")) {
    return undefined;
  }

  const manifestPath = value.operationManifestPath;
  const handoffPaths = value.handoffPaths;
  if (manifestPath !== undefined && (typeof manifestPath !== "string" || manifestPath.length === 0)) {
    return undefined;
  }
  if (
    handoffPaths !== undefined &&
    (!Array.isArray(handoffPaths) || handoffPaths.some((path) => typeof path !== "string" || path.length === 0))
  ) {
    return undefined;
  }
  return {
    operationManifestPath: manifestPath as string | undefined,
    handoffPaths: handoffPaths as readonly string[] | undefined,
  };
}

/** Merge defaults, optional project/env configuration, then the host override. */
export function resolvePluginConfiguration(...values: readonly unknown[]): PluginConfiguration {
  let operationManifestPath = DEFAULT_PLUGIN_OPTIONS.operationManifestPath;
  let handoffPaths = DEFAULT_PLUGIN_OPTIONS.handoffPaths;
  for (const value of values) {
    const layer = parseLayer(value);
    if (layer === undefined) return { kind: "invalid" };
    if (layer.operationManifestPath !== undefined) operationManifestPath = layer.operationManifestPath;
    if (layer.handoffPaths !== undefined) handoffPaths = layer.handoffPaths;
  }
  return { kind: "configured", operationManifestPath, handoffPaths };
}
