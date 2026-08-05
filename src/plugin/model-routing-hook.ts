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

/** Deterministic structural OpenCode hook; all availability comes from the supplied catalog. */
export function createModelRoutingHook(config: ModelRoutingHookConfiguration): OpenCodeChatMessageHook {
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
    output.message.model = resolution.variant === undefined
      ? model
      : { ...model, variant: resolution.variant };
  };
}
