import {
  BUILT_IN_MODEL_CATALOG,
  DEFAULT_DEDICATED_WORKER_TARGET,
  DEFAULT_FREE_TIER_FALLBACK_MODELS,
  RECOMMENDED_ROLE_ROUTING,
  dedicatedWorkerRouting,
  isFixedModelRole,
  recommendedRoleRouting,
  parseModelRoutingConfig,
  parseModelTarget,
  type CatalogModel,
  type ModelCatalog,
  type ModelRoutingConfig,
  type ModelTarget,
} from "./model-routing.js";
import { CONSULTATION_ROLE_POLICY } from "../core/consultation.js";
import {
  CONTINUATION_CAPABILITY,
  DEFAULT_MAX_AUTO_CONTINUES,
} from "./continuation.js";

export interface ReflectionConfiguration {
  readonly enabled: boolean;
  readonly layers: { readonly run: boolean; readonly project: boolean; readonly global: boolean };
  readonly maxInjectedEntries: number;
  readonly maxInjectedTokens: number;
}
export type ReflectionPolicyInput = Partial<Omit<ReflectionConfiguration, "layers">> & { layers?: Partial<ReflectionConfiguration["layers"]> };

export interface SortieDogsPluginOptions {
  operationManifestPath?: string;
  handoffPaths?: readonly string[];
  /**
   * Host-specific tool names that never change project files, such as MCP tools. Names accumulate
   * across layers because each layer describes a different part of the same environment.
   */
  readOnlyTools?: readonly string[];
  /**
   * The single model every dedicated worker role resolves to. Worker routing stays fixed to one
   * target; a host that cannot serve the shipped target declares its own here.
   */
  dedicatedWorkerModel?: ModelTarget;
  modelRouting?: ModelRoutingConfig;
  modelCatalog?: ModelCatalog;
  /** Ordered, global last-resort models. An empty list disables free-tier fallback. */
  freeTierFallbackModels?: readonly string[];
  consultation?: ConsultationPolicyInput;
  /**
   * Bounded batch continuation. The shipped defaults already resolve to a working route, so a host
   * only states this to raise the ceiling, choose a compaction model, or switch continuation off.
   */
  continuation?: ContinuationPolicyInput;
  reflection?: ReflectionPolicyInput;
}

export type ContinuationPolicyInput = Partial<ContinuationConfiguration>;

export interface ContinuationConfiguration {
  readonly enabled: boolean;
  /** Only the packaged coordinator may be resumed on the user's behalf. */
  readonly agent: string;
  readonly capability: string;
  readonly maxAutoContinues: number;
  /** Absent means the host picks the compaction model; this package never pins one. */
  readonly summarizeModel?: ModelTarget;
}

/** A continuation ceiling beyond this stops being a bounded batch. */
const MAX_AUTO_CONTINUE_LIMIT = 10;
const CONTINUATION_AGENT = "dog-coordinator";

export interface ConsultationPolicyInput {
  readonly strategy?: Partial<StrategyConsultationPolicy>;
  readonly sourceReview?: Partial<SourceReviewConsultationPolicy>;
}

export interface StrategyConsultationPolicy {
  readonly agent: string;
  readonly required: boolean;
  readonly maxCallsPerCandidate: number;
}

export interface SourceReviewConsultationPolicy {
  readonly agent: string;
  readonly requiredPolicy: "risk-based";
  readonly unavailable: "block-required-only";
  /** Maximum calls in each explicit initial or verification phase. */
  readonly maxCallsPerCandidate: number;
  readonly maxArtifactBytes: number;
}

export interface ConsultationPolicy {
  readonly strategy: StrategyConsultationPolicy;
  readonly sourceReview: SourceReviewConsultationPolicy;
}

export interface ConfiguredPlugin {
  kind: "configured";
  operationManifestPath: string;
  handoffPaths: readonly string[];
  readOnlyTools: readonly string[];
  dedicatedWorkerModel: ModelTarget;
  modelRouting: ModelRoutingConfig;
  modelCatalog: ModelCatalog;
  freeTierFallbackModels: readonly string[];
  consultation: ConsultationPolicy;
  continuation: ContinuationConfiguration;
  reflection: ReflectionConfiguration;
}

export type PluginConfiguration = ConfiguredPlugin | { kind: "invalid" };

export interface ConfiguredPluginSources extends ConfiguredPlugin {
  localModelRouting: ModelRoutingConfig;
  globalModelRouting: ModelRoutingConfig;
}

export type PluginConfigurationSources = ConfiguredPluginSources | { kind: "invalid" };

export const DEFAULT_PLUGIN_OPTIONS: Readonly<
  Omit<Required<SortieDogsPluginOptions>, "consultation" | "continuation"> & {
    consultation: ConsultationPolicy;
    continuation: ContinuationConfiguration;
  }
> = {
  operationManifestPath: "operation-manifest.json",
  handoffPaths: ["handoff.json"],
  readOnlyTools: [],
  dedicatedWorkerModel: DEFAULT_DEDICATED_WORKER_TARGET,
  modelRouting: RECOMMENDED_ROLE_ROUTING,
  modelCatalog: BUILT_IN_MODEL_CATALOG,
  freeTierFallbackModels: DEFAULT_FREE_TIER_FALLBACK_MODELS,
  consultation: Object.freeze({
    strategy: Object.freeze({
      agent: CONSULTATION_ROLE_POLICY.strategy,
      required: false,
      maxCallsPerCandidate: 1,
    }),
    sourceReview: Object.freeze({
      agent: CONSULTATION_ROLE_POLICY.sourceReview,
      requiredPolicy: "risk-based",
      unavailable: "block-required-only",
      maxCallsPerCandidate: 1,
      maxArtifactBytes: 30_720,
    }),
  }),
  continuation: Object.freeze({
    enabled: true,
    agent: CONTINUATION_AGENT,
    capability: CONTINUATION_CAPABILITY,
    maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES,
  }),
  reflection: Object.freeze({ enabled: false, layers: Object.freeze({ run: true, project: true, global: false }), maxInjectedEntries: 3, maxInjectedTokens: 500 }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseConsultationPolicy(value: unknown): ConsultationPolicyInput | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "strategy" && key !== "sourceReview")) {
    return undefined;
  }
  let strategy: Partial<StrategyConsultationPolicy> | undefined;
  if (value.strategy !== undefined) {
    if (!isRecord(value.strategy) || Object.keys(value.strategy).some(
      (key) => key !== "agent" && key !== "required" && key !== "maxCallsPerCandidate",
    )) return undefined;
    if (
      value.strategy.agent !== undefined &&
      value.strategy.agent !== CONSULTATION_ROLE_POLICY.strategy
    ) return undefined;
    if (value.strategy.required !== undefined && typeof value.strategy.required !== "boolean") return undefined;
    if (value.strategy.maxCallsPerCandidate !== undefined && !positiveInteger(value.strategy.maxCallsPerCandidate)) {
      return undefined;
    }
    strategy = Object.freeze({
      ...(value.strategy.agent === undefined ? {} : { agent: value.strategy.agent }),
      ...(value.strategy.required === undefined ? {} : { required: value.strategy.required }),
      ...(value.strategy.maxCallsPerCandidate === undefined
        ? {}
        : { maxCallsPerCandidate: value.strategy.maxCallsPerCandidate }),
    });
  }
  let sourceReview: Partial<SourceReviewConsultationPolicy> | undefined;
  if (value.sourceReview !== undefined) {
    if (!isRecord(value.sourceReview) || Object.keys(value.sourceReview).some(
      (key) => !["agent", "requiredPolicy", "unavailable", "maxCallsPerCandidate", "maxArtifactBytes"].includes(key),
    )) return undefined;
    if (
      value.sourceReview.agent !== undefined &&
      value.sourceReview.agent !== CONSULTATION_ROLE_POLICY.sourceReview
    ) return undefined;
    if (value.sourceReview.requiredPolicy !== undefined && value.sourceReview.requiredPolicy !== "risk-based") {
      return undefined;
    }
    if (value.sourceReview.unavailable !== undefined && value.sourceReview.unavailable !== "block-required-only") {
      return undefined;
    }
    if (
      value.sourceReview.maxCallsPerCandidate !== undefined &&
      !positiveInteger(value.sourceReview.maxCallsPerCandidate)
    ) return undefined;
    if (
      value.sourceReview.maxArtifactBytes !== undefined &&
      (!positiveInteger(value.sourceReview.maxArtifactBytes) || value.sourceReview.maxArtifactBytes > 30_720)
    ) return undefined;
    sourceReview = Object.freeze({
      ...(value.sourceReview.agent === undefined ? {} : { agent: value.sourceReview.agent }),
      ...(value.sourceReview.requiredPolicy === undefined
        ? {}
        : { requiredPolicy: value.sourceReview.requiredPolicy }),
      ...(value.sourceReview.unavailable === undefined
        ? {}
        : { unavailable: value.sourceReview.unavailable }),
      ...(value.sourceReview.maxCallsPerCandidate === undefined
        ? {}
        : { maxCallsPerCandidate: value.sourceReview.maxCallsPerCandidate }),
      ...(value.sourceReview.maxArtifactBytes === undefined
        ? {}
        : { maxArtifactBytes: value.sourceReview.maxArtifactBytes }),
    });
  }
  return Object.freeze({
    ...(strategy === undefined ? {} : { strategy }),
    ...(sourceReview === undefined ? {} : { sourceReview }),
  });
}

function parseContinuationPolicy(value: unknown): ContinuationPolicyInput | undefined {
  if (!isRecord(value) || Object.keys(value).some(
    (key) => !["enabled", "agent", "capability", "maxAutoContinues", "summarizeModel"].includes(key),
  )) {
    return undefined;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return undefined;
  // The coordinator identity and the tool name are the whole safety boundary, so neither is free text.
  if (value.agent !== undefined && value.agent !== CONTINUATION_AGENT) return undefined;
  if (value.capability !== undefined && value.capability !== CONTINUATION_CAPABILITY) return undefined;
  if (
    value.maxAutoContinues !== undefined &&
    (!positiveInteger(value.maxAutoContinues) || value.maxAutoContinues > MAX_AUTO_CONTINUE_LIMIT)
  ) return undefined;
  const summarizeModel = value.summarizeModel === undefined
    ? undefined
    : parseModelTarget(value.summarizeModel);
  if (value.summarizeModel !== undefined && summarizeModel === undefined) return undefined;
  return Object.freeze({
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.agent === undefined ? {} : { agent: value.agent }),
    ...(value.capability === undefined ? {} : { capability: value.capability }),
    ...(value.maxAutoContinues === undefined ? {} : { maxAutoContinues: value.maxAutoContinues }),
    ...(summarizeModel === undefined ? {} : { summarizeModel }),
  });
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

function validOpenCodeModelID(value: unknown): value is string {
  if (!nonEmptyString(value) || /\s/u.test(value)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
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
    (key) => ![
      "operationManifestPath", "handoffPaths", "readOnlyTools", "dedicatedWorkerModel",
      "modelRouting", "modelCatalog", "freeTierFallbackModels", "consultation", "continuation", "reflection",
    ].includes(key),
  )) {
    return undefined;
  }

  const manifestPath = value.operationManifestPath;
  const handoffPaths = value.handoffPaths;
  const readOnlyTools = value.readOnlyTools;
  const dedicatedWorkerModel = value.dedicatedWorkerModel === undefined
    ? undefined
    : parseModelTarget(value.dedicatedWorkerModel);
  if (value.dedicatedWorkerModel !== undefined && dedicatedWorkerModel === undefined) return undefined;
  const modelRouting = value.modelRouting === undefined
    ? undefined
    : parseModelRoutingConfig(value.modelRouting);
  const modelCatalog = value.modelCatalog === undefined
    ? undefined
    : parseModelCatalog(value.modelCatalog);
  const freeTierFallbackModels = value.freeTierFallbackModels;
  const consultation = value.consultation === undefined
    ? undefined
    : parseConsultationPolicy(value.consultation);
  const continuation = value.continuation === undefined
    ? undefined
    : parseContinuationPolicy(value.continuation);
  const reflectionValue = value.reflection;
  let reflection: ReflectionPolicyInput | undefined;
  if (reflectionValue !== undefined) {
    if (!isRecord(reflectionValue) || Object.keys(reflectionValue).some((key) => !["enabled", "layers", "maxInjectedEntries", "maxInjectedTokens"].includes(key))) return undefined;
    const layers = reflectionValue.layers;
    if (layers !== undefined && (!isRecord(layers) || Object.keys(layers).some((key) => !["run", "project", "global"].includes(key)) || Object.values(layers).some((item) => typeof item !== "boolean"))) return undefined;
    if (reflectionValue.enabled !== undefined && typeof reflectionValue.enabled !== "boolean") return undefined;
    if (reflectionValue.maxInjectedEntries !== undefined && (!positiveInteger(reflectionValue.maxInjectedEntries) || reflectionValue.maxInjectedEntries > 3)) return undefined;
    if (reflectionValue.maxInjectedTokens !== undefined && (!positiveInteger(reflectionValue.maxInjectedTokens) || reflectionValue.maxInjectedTokens > 500)) return undefined;
    reflection = { ...(reflectionValue.enabled === undefined ? {} : { enabled: reflectionValue.enabled }), ...(layers === undefined ? {} : { layers: layers as ReflectionConfiguration["layers"] }), ...(reflectionValue.maxInjectedEntries === undefined ? {} : { maxInjectedEntries: reflectionValue.maxInjectedEntries }), ...(reflectionValue.maxInjectedTokens === undefined ? {} : { maxInjectedTokens: reflectionValue.maxInjectedTokens }) };
  }
  if (manifestPath !== undefined && (typeof manifestPath !== "string" || manifestPath.length === 0)) {
    return undefined;
  }
  if (
    handoffPaths !== undefined &&
    (!Array.isArray(handoffPaths) || handoffPaths.some((path) => typeof path !== "string" || path.length === 0))
  ) {
    return undefined;
  }
  if (
    readOnlyTools !== undefined &&
    (!Array.isArray(readOnlyTools) ||
      readOnlyTools.some((tool) => typeof tool !== "string" || tool.trim().length === 0))
  ) {
    return undefined;
  }
  if (value.modelRouting !== undefined && modelRouting === undefined) return undefined;
  if (value.modelCatalog !== undefined && modelCatalog === undefined) return undefined;
  if (
    freeTierFallbackModels !== undefined &&
    (!Array.isArray(freeTierFallbackModels) || freeTierFallbackModels.some((model) => !validOpenCodeModelID(model)))
  ) return undefined;
  if (value.consultation !== undefined && consultation === undefined) return undefined;
  if (value.continuation !== undefined && continuation === undefined) return undefined;
  return {
    operationManifestPath: manifestPath as string | undefined,
    handoffPaths: handoffPaths as readonly string[] | undefined,
    readOnlyTools: readOnlyTools as readonly string[] | undefined,
    dedicatedWorkerModel,
    modelRouting,
    modelCatalog,
    freeTierFallbackModels: freeTierFallbackModels as readonly string[] | undefined,
    consultation,
    continuation,
    reflection,
  };
}

/** Merge defaults, optional project/env configuration, then the host override. */
export function resolvePluginConfiguration(...values: readonly unknown[]): PluginConfiguration {
  let operationManifestPath = DEFAULT_PLUGIN_OPTIONS.operationManifestPath;
  let handoffPaths = DEFAULT_PLUGIN_OPTIONS.handoffPaths;
  const readOnlyTools = new Set(DEFAULT_PLUGIN_OPTIONS.readOnlyTools);
  let dedicatedWorkerModel = DEFAULT_PLUGIN_OPTIONS.dedicatedWorkerModel;
  let modelRouting = DEFAULT_PLUGIN_OPTIONS.modelRouting;
  let modelCatalog = DEFAULT_PLUGIN_OPTIONS.modelCatalog;
  let freeTierFallbackModels = DEFAULT_PLUGIN_OPTIONS.freeTierFallbackModels;
  let consultation = DEFAULT_PLUGIN_OPTIONS.consultation;
  let continuation = DEFAULT_PLUGIN_OPTIONS.continuation;
  let reflection: ReflectionConfiguration = DEFAULT_PLUGIN_OPTIONS.reflection as ReflectionConfiguration;
  const configuredRoles = new Set<string>();
  for (const value of values) {
    const layer = parseLayer(value);
    if (layer === undefined) return { kind: "invalid" };
    for (const role of Object.keys(layer.modelRouting ?? {})) configuredRoles.add(role);
    if (layer.operationManifestPath !== undefined) operationManifestPath = layer.operationManifestPath;
    if (layer.handoffPaths !== undefined) handoffPaths = layer.handoffPaths;
    for (const tool of layer.readOnlyTools ?? []) readOnlyTools.add(tool.trim().toLowerCase());
    if (layer.dedicatedWorkerModel !== undefined) dedicatedWorkerModel = layer.dedicatedWorkerModel;
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
    if (layer.freeTierFallbackModels !== undefined) {
      freeTierFallbackModels = Object.freeze([...layer.freeTierFallbackModels]);
    }
    if (layer.consultation !== undefined) {
      consultation = Object.freeze({
        strategy: Object.freeze({ ...consultation.strategy, ...(layer.consultation.strategy ?? {}) }),
        sourceReview: Object.freeze({ ...consultation.sourceReview, ...(layer.consultation.sourceReview ?? {}) }),
      });
    }
    if (layer.continuation !== undefined) {
      continuation = Object.freeze({ ...continuation, ...layer.continuation });
    }
    if (layer.reflection !== undefined) reflection = Object.freeze({ ...reflection, ...layer.reflection, layers: Object.freeze({ ...reflection.layers, ...(layer.reflection.layers ?? {}) }) });
  }
  modelRouting = {
    ...Object.fromEntries(Object.entries(modelRouting).filter(([role]) => !isFixedModelRole(role))),
    // A recommended route the host never restated must track the host's dedicated target.
    ...Object.fromEntries(Object.entries(recommendedRoleRouting(dedicatedWorkerModel))
      .filter(([role]) => !configuredRoles.has(role))),
    ...dedicatedWorkerRouting(dedicatedWorkerModel),
  };
  // The dedicated target is authoritative for worker roles, so it is always a known catalog entry.
  modelCatalog = {
    ...modelCatalog,
    global: mergeCatalogModels(modelCatalog.global ?? [], [
      dedicatedWorkerModel.variant === undefined
        ? { model: dedicatedWorkerModel.model }
        : { model: dedicatedWorkerModel.model, variants: [dedicatedWorkerModel.variant] },
    ]),
  };
  const hasRouting = Object.keys(modelRouting).length > 0;
  const hasCatalogEntries = (modelCatalog.project?.length ?? 0) + (modelCatalog.global?.length ?? 0) > 0;
  if (hasRouting && !hasCatalogEntries) return { kind: "invalid" };
  return {
    kind: "configured",
    operationManifestPath,
    handoffPaths,
    readOnlyTools: [...readOnlyTools],
    dedicatedWorkerModel,
    modelRouting,
    modelCatalog,
    freeTierFallbackModels,
    consultation,
    continuation,
    reflection,
  };
}

/** Resolve the plugin's fixed source boundaries: project-local first, environment and host global. */
export function resolvePluginConfigurationSources(
  projectValue: unknown,
  environmentValue: unknown,
  hostValue: unknown,
): PluginConfigurationSources {
  return resolvePluginConfigurationSourcesWithGlobal(undefined, projectValue, environmentValue, hostValue);
}

export function resolvePluginConfigurationSourcesWithGlobal(
  globalValue: unknown,
  projectValue: unknown,
  environmentValue: unknown,
  hostValue: unknown,
): PluginConfigurationSources {
  const configured = resolvePluginConfiguration(globalValue, projectValue, environmentValue, hostValue);
  if (configured.kind === "invalid") return configured;

  const globalLayer = parseLayer(globalValue);
  const projectLayer = parseLayer(projectValue);
  const environmentLayer = parseLayer(environmentValue);
  const hostLayer = parseLayer(hostValue);
  if (
    globalLayer === undefined || projectLayer === undefined ||
    environmentLayer === undefined || hostLayer === undefined
  ) {
    return { kind: "invalid" };
  }
  const globalModelRouting = Object.fromEntries(Object.entries({
    ...recommendedRoleRouting(configured.dedicatedWorkerModel),
    ...(globalLayer.modelRouting ?? {}),
    ...(environmentLayer.modelRouting ?? {}),
    ...(hostLayer.modelRouting ?? {}),
  }).filter(([role]) => !isFixedModelRole(role)));
  const fixedRouting = dedicatedWorkerRouting(configured.dedicatedWorkerModel);
  const modelRouting = {
    ...Object.fromEntries(Object.entries(configured.modelRouting)
      .filter(([role]) => !isFixedModelRole(role))),
    ...fixedRouting,
  };
  return {
    ...configured,
    modelRouting,
    // Dedicated worker policy is authoritative over every configurable layer.
    localModelRouting: { ...(projectLayer.modelRouting ?? {}), ...fixedRouting },
    globalModelRouting,
  };
}
