import {
  resolveModelRoute,
  type ModelCatalog,
  type ModelResolutionAttempt,
  type ModelRoutingConfig,
  type ModelTarget,
} from "./model-routing.js";

export interface OpenCodeChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  messageID?: string;
}

export interface OpenCodeChatMessageOutput {
  message: {
    agent?: string;
    model: { providerID: string; modelID: string; variant?: string };
    [key: string]: unknown;
  };
  parts: unknown[];
}

export type OpenCodeChatMessageHook = (
  input: OpenCodeChatMessageInput,
  output: OpenCodeChatMessageOutput,
) => Promise<void>;

export interface ModelRoutingHookConfiguration {
  readonly local?: ModelRoutingConfig;
  readonly global?: ModelRoutingConfig;
  readonly catalog: ModelCatalog;
  readonly dedicated?: ModelTarget;
}

/** The narrow OpenCode SDK surface used to discover models configured on the current host. */
export interface OpenCodeModelAvailabilityClient {
  readonly config?: {
    readonly providers?: () => Promise<unknown>;
  };
}

export class ModelRoutingDeniedError extends Error {
  readonly reason = "unresolved-role";
  readonly role: string;
  readonly attempts: readonly ModelResolutionAttempt[];

  constructor(role: string, attempts: readonly ModelResolutionAttempt[]) {
    super(`Model routing denied for role "${role}": unresolved role.`);
    this.name = "ModelRoutingDeniedError";
    this.role = role;
    this.attempts = attempts;
  }
}

export class InvalidModelTargetError extends Error {
  readonly reason = "invalid-model-target";

  constructor() {
    super("Model routing denied: target must contain provider and model identifiers.");
    this.name = "InvalidModelTargetError";
  }
}

/** Split a `<providerID>/<modelID>` target into the pair every OpenCode host call expects. */
export function openCodeModel(model: string): { providerID: string; modelID: string } | undefined {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredHostModels(response: unknown): ReadonlySet<string> | undefined {
  const envelope = isRecord(response) && Object.prototype.hasOwnProperty.call(response, "data")
    ? response.data
    : response;
  if (!isRecord(envelope) || !Array.isArray(envelope.providers)) return undefined;

  const models = new Set<string>();
  for (const provider of envelope.providers) {
    if (!isRecord(provider) || typeof provider.id !== "string" || !isRecord(provider.models)) continue;
    for (const [modelKey, modelValue] of Object.entries(provider.models)) {
      const modelID = isRecord(modelValue) && typeof modelValue.id === "string" ? modelValue.id : modelKey;
      models.add(`${provider.id}/${modelID}`);
    }
  }
  return models;
}

async function readHostModels(
  client: OpenCodeModelAvailabilityClient | undefined,
): Promise<ReadonlySet<string> | undefined> {
  if (client?.config?.providers === undefined) return undefined;
  try {
    return configuredHostModels(await client.config.providers());
  } catch {
    return undefined;
  }
}

/** Resolve package policy first, then fail open when the host proves that target is unavailable. */
export function createModelRoutingHook(
  config: ModelRoutingHookConfiguration,
  client?: OpenCodeModelAvailabilityClient,
): OpenCodeChatMessageHook {
  let hostModels: Promise<ReadonlySet<string> | undefined> | undefined;
  const warnedUnavailableTargets = new Set<string>();

  return async (input, output): Promise<void> => {
    const role = input.agent && input.agent.length > 0
      ? input.agent
      : output.message.agent && output.message.agent.length > 0
        ? output.message.agent
        : undefined;
    if (role === undefined) return;
    const hasRoute = Object.prototype.hasOwnProperty.call(config.local ?? {}, role) ||
      Object.prototype.hasOwnProperty.call(config.global ?? {}, role);
    if (!hasRoute) return;
    const resolution = resolveModelRoute({
      role,
      local: config.local,
      global: config.global,
      catalog: config.catalog,
      dedicated: config.dedicated,
    });
    if (!resolution.ok) throw new ModelRoutingDeniedError(resolution.role, resolution.attempts);

    const model = openCodeModel(resolution.model);
    if (model === undefined) throw new InvalidModelTargetError();
    hostModels ??= readHostModels(client);
    const availableModels = await hostModels;
    if (availableModels !== undefined && !availableModels.has(resolution.model)) {
      if (!warnedUnavailableTargets.has(resolution.model)) {
        warnedUnavailableTargets.add(resolution.model);
        console.warn(
          `Model routing target unavailable for role "${role}": ${resolution.model}. Configure modelRouting for this host.`,
        );
      }
      return;
    }
    output.message.model = resolution.variant === undefined
      ? model
      : { ...model, variant: resolution.variant };
  };
}
