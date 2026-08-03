import {
  BUILT_IN_MODEL_CATALOG,
  DEDICATED_SOL_ROUTING,
  RECOMMENDED_LUNA_ROUTING,
  isDedicatedSolRole,
  parseModelRoutingConfig,
  type CatalogModel,
  type ModelCatalog,
  type ModelRoutingConfig,
} from "./model-routing.js";

export interface SortieDogsPluginOptions {
  operationManifestPath?: string;
  handoffPaths?: readonly string[];
  modelRouting?: ModelRoutingConfig;
  modelCatalog?: ModelCatalog;
}

export interface ConfiguredPlugin {
  kind: "configured";
  operationManifestPath: string;
  handoffPaths: readonly string[];
  modelRouting: ModelRoutingConfig;
  modelCatalog: ModelCatalog;
}

export type PluginConfiguration = ConfiguredPlugin | { kind: "invalid" };

export interface ConfiguredPluginSources extends ConfiguredPlugin {
  localModelRouting: ModelRoutingConfig;
  globalModelRouting: ModelRoutingConfig;
}

export type PluginConfigurationSources = ConfiguredPluginSources | { kind: "invalid" };

export const DEFAULT_PLUGIN_OPTIONS: Readonly<Required<SortieDogsPluginOptions>> = {
  operationManifestPath: "operation-manifest.json",
  handoffPaths: ["handoff.json"],
  modelRouting: RECOMMENDED_LUNA_ROUTING,
  modelCatalog: BUILT_IN_MODEL_CATALOG,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseCatalogModels(value: unknown): readonly CatalogModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: CatalogModel[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => key !== "model" && key !== "variants")) {
      return undefined;
    }
    if (!nonEmptyString(candidate.model)) return undefined;
    if (
      candidate.variants !== undefined &&
      (!Array.isArray(candidate.variants) || candidate.variants.some((variant) => !nonEmptyString(variant)))
    ) return undefined;
    models.push(candidate.variants === undefined
      ? { model: candidate.model }
      : { model: candidate.model, variants: candidate.variants as readonly string[] });
  }
  return models;
}

function parseModelCatalog(value: unknown): ModelCatalog | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "project" && key !== "global")) {
    return undefined;
  }
  const project = value.project === undefined ? undefined : parseCatalogModels(value.project);
  const global = value.global === undefined ? undefined : parseCatalogModels(value.global);
  if (value.project !== undefined && project === undefined) return undefined;
  if (value.global !== undefined && global === undefined) return undefined;
  return {
    ...(project === undefined ? {} : { project }),
    ...(global === undefined ? {} : { global }),
  };
}

function mergeCatalogModels(
  builtIn: readonly CatalogModel[],
  configured: readonly CatalogModel[],
): readonly CatalogModel[] {
  const models = new Map<string, Set<string> | undefined>();
  for (const candidate of [...builtIn, ...configured]) {
    if (!models.has(candidate.model)) {
      models.set(candidate.model, candidate.variants === undefined
        ? undefined
        : new Set(candidate.variants));
      continue;
    }
    if (candidate.variants === undefined) continue;
    const variants = models.get(candidate.model);
    if (variants === undefined) {
      models.set(candidate.model, new Set(candidate.variants));
    } else {
      for (const variant of candidate.variants) variants.add(variant);
    }
  }
  return [...models].map(([model, variants]) => variants === undefined
    ? { model }
    : { model, variants: [...variants] });
}

function parseLayer(value: unknown): SortieDogsPluginOptions | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some(
    (key) => key !== "operationManifestPath" && key !== "handoffPaths" && key !== "modelRouting" && key !== "modelCatalog",
  )) {
    return undefined;
  }

  const manifestPath = value.operationManifestPath;
  const handoffPaths = value.handoffPaths;
  const modelRouting = value.modelRouting === undefined
    ? undefined
    : parseModelRoutingConfig(value.modelRouting);
  const modelCatalog = value.modelCatalog === undefined
    ? undefined
    : parseModelCatalog(value.modelCatalog);
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
  if (value.modelCatalog !== undefined && modelCatalog === undefined) return undefined;
  return {
    operationManifestPath: manifestPath as string | undefined,
    handoffPaths: handoffPaths as readonly string[] | undefined,
    modelRouting,
    modelCatalog,
  };
}

/** Merge defaults, optional project/env configuration, then the host override. */
export function resolvePluginConfiguration(...values: readonly unknown[]): PluginConfiguration {
  let operationManifestPath = DEFAULT_PLUGIN_OPTIONS.operationManifestPath;
  let handoffPaths = DEFAULT_PLUGIN_OPTIONS.handoffPaths;
  let modelRouting = DEFAULT_PLUGIN_OPTIONS.modelRouting;
  let modelCatalog = DEFAULT_PLUGIN_OPTIONS.modelCatalog;
  for (const value of values) {
    const layer = parseLayer(value);
    if (layer === undefined) return { kind: "invalid" };
    if (layer.operationManifestPath !== undefined) operationManifestPath = layer.operationManifestPath;
    if (layer.handoffPaths !== undefined) handoffPaths = layer.handoffPaths;
    if (layer.modelRouting !== undefined) {
      modelRouting = { ...modelRouting, ...layer.modelRouting };
    }
    if (layer.modelCatalog !== undefined) {
      modelCatalog = {
        ...modelCatalog,
        ...layer.modelCatalog,
        ...(layer.modelCatalog.global === undefined ? {} : {
          global: mergeCatalogModels(
            BUILT_IN_MODEL_CATALOG.global ?? [],
            layer.modelCatalog.global,
          ),
        }),
      };
    }
  }
  const hasRouting = Object.keys(modelRouting).length > 0;
  const hasCatalogEntries = (modelCatalog.project?.length ?? 0) + (modelCatalog.global?.length ?? 0) > 0;
  if (hasRouting && !hasCatalogEntries) return { kind: "invalid" };
  return {
    kind: "configured",
    operationManifestPath,
    handoffPaths,
    modelRouting,
    modelCatalog,
  };
}

/** Resolve the plugin's fixed source boundaries: project-local first, environment and host global. */
export function resolvePluginConfigurationSources(
  projectValue: unknown,
  environmentValue: unknown,
  hostValue: unknown,
): PluginConfigurationSources {
  const configured = resolvePluginConfiguration(projectValue, environmentValue, hostValue);
  if (configured.kind === "invalid") return configured;

  const projectLayer = parseLayer(projectValue);
  const environmentLayer = parseLayer(environmentValue);
  const hostLayer = parseLayer(hostValue);
  if (projectLayer === undefined || environmentLayer === undefined || hostLayer === undefined) {
    return { kind: "invalid" };
  }
  const globalModelRouting = Object.fromEntries(Object.entries({
    ...RECOMMENDED_LUNA_ROUTING,
    ...(environmentLayer.modelRouting ?? {}),
    ...(hostLayer.modelRouting ?? {}),
  }).filter(([role]) => !isDedicatedSolRole(role)));
  const modelRouting = {
    ...Object.fromEntries(Object.entries(configured.modelRouting)
      .filter(([role]) => !isDedicatedSolRole(role))),
    ...DEDICATED_SOL_ROUTING,
  };
  return {
    ...configured,
    modelRouting,
    // Mk2A2 worker policy is authoritative over every configurable layer.
    localModelRouting: { ...(projectLayer.modelRouting ?? {}), ...DEDICATED_SOL_ROUTING },
    globalModelRouting,
  };
}
