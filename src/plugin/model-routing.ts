export interface ModelTarget {
  readonly model: string;
  readonly variant?: string;
}

export interface RoleModelRoute {
  readonly preferred: ModelTarget;
  readonly fallback?: readonly ModelTarget[];
}

export type ModelRoutingConfig = Readonly<Record<string, RoleModelRoute>>;

export const DEDICATED_SOL_MODEL = "openai/gpt-5.6-sol";
export const DEDICATED_SOL_ROLES = [
  "implementation",
  "remediation",
  "blocker-resolution",
  "sol-worker-mk2a2",
  "dog-worker",
] as const;

const dedicatedSolRoleSet = new Set<string>(DEDICATED_SOL_ROLES);

/** Fixed Mk2A2 worker routes. These deliberately contain no fallback targets. */
export const DEDICATED_SOL_ROUTING: ModelRoutingConfig = Object.freeze(Object.fromEntries(
  DEDICATED_SOL_ROLES.map((role) => [role, Object.freeze({
    preferred: Object.freeze({ model: DEDICATED_SOL_MODEL }),
  })]),
));

export const RECOMMENDED_LUNA_MODEL = "openai/gpt-5.6-luna";
export const RECOMMENDED_LUNA_VARIANT = "xhigh";
export const RECOMMENDED_LUNA_ROLES = ["dog-coordinator", "dog-scout"] as const;

/** Configurable Mk2A2 defaults. Project-local and global configuration may override these routes. */
export const RECOMMENDED_LUNA_ROUTING: ModelRoutingConfig = Object.freeze(Object.fromEntries(
  RECOMMENDED_LUNA_ROLES.map((role) => [role, Object.freeze({
    preferred: Object.freeze({
      model: RECOMMENDED_LUNA_MODEL,
      variant: RECOMMENDED_LUNA_VARIANT,
    }),
  })]),
));

export function isDedicatedSolRole(role: string): boolean {
  return dedicatedSolRoleSet.has(role);
}

export interface CatalogModel {
  readonly model: string;
  /** Omit only when the model has no named variants. */
  readonly variants?: readonly string[];
}

export interface ModelCatalog {
  readonly project?: readonly CatalogModel[];
  readonly global?: readonly CatalogModel[];
}

/** Built-in availability metadata for source-level recommendations; no provider probing required. */
export const BUILT_IN_MODEL_CATALOG: ModelCatalog = Object.freeze({
  global: Object.freeze([Object.freeze({
    model: RECOMMENDED_LUNA_MODEL,
    variants: Object.freeze([RECOMMENDED_LUNA_VARIANT]),
  })]),
});

export interface ResolveModelRouteInput {
  readonly role: string;
  /** Project-local routing. A resolvable local route takes priority. */
  readonly local?: ModelRoutingConfig;
  /** Global routing is consulted only after the local route candidates fail. */
  readonly global?: ModelRoutingConfig;
  readonly catalog: ModelCatalog;
}

export interface ResolvedModelRoute {
  readonly ok: true;
  readonly role: string;
  readonly source: "local" | "global";
  readonly catalog: "project" | "global";
  readonly model: string;
  readonly variant?: string;
}

export interface ModelResolutionAttempt {
  readonly source: "local" | "global";
  readonly target: ModelTarget;
  readonly reason: "model-unavailable" | "variant-unavailable";
}

export interface UnresolvedModelRoute {
  readonly ok: false;
  readonly role: string;
  readonly reason: "unresolved-role";
  readonly attempts: readonly ModelResolutionAttempt[];
}

export type ModelRouteResolution = ResolvedModelRoute | UnresolvedModelRoute;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseTarget(value: unknown): ModelTarget | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "model" && key !== "variant")) {
    return undefined;
  }
  if (!nonEmptyString(value.model)) return undefined;
  if (value.variant !== undefined && !nonEmptyString(value.variant)) return undefined;
  return value.variant === undefined
    ? { model: value.model }
    : { model: value.model, variant: value.variant };
}

/** Strict runtime parser for project, environment, and host routing layers. */
export function parseModelRoutingConfig(value: unknown): ModelRoutingConfig | undefined {
  if (!isRecord(value)) return undefined;
  const parsed = Object.create(null) as Record<string, RoleModelRoute>;
  for (const [role, routeValue] of Object.entries(value)) {
    if (
      role.length === 0 ||
      Object.prototype.hasOwnProperty.call(Object.prototype, role) ||
      !isRecord(routeValue)
    ) return undefined;
    if (Object.keys(routeValue).some((key) => key !== "preferred" && key !== "fallback")) {
      return undefined;
    }
    const preferred = parseTarget(routeValue.preferred);
    if (preferred === undefined) return undefined;
    const fallbackValue = routeValue.fallback;
    if (fallbackValue !== undefined && !Array.isArray(fallbackValue)) return undefined;
    const fallback: ModelTarget[] = [];
    for (const candidate of fallbackValue ?? []) {
      const target = parseTarget(candidate);
      if (target === undefined) return undefined;
      fallback.push(target);
    }
    parsed[role] = fallbackValue === undefined ? { preferred } : { preferred, fallback };
  }
  return parsed;
}

function ownRoute(config: ModelRoutingConfig | undefined, role: string): RoleModelRoute | undefined {
  return config !== undefined && Object.prototype.hasOwnProperty.call(config, role)
    ? config[role]
    : undefined;
}

function findAvailable(
  target: ModelTarget,
  catalog: ModelCatalog,
): { catalog: "project" | "global" } | ModelResolutionAttempt["reason"] {
  let modelFound = false;
  for (const [scope, models] of [
    ["project", catalog.project ?? []],
    ["global", catalog.global ?? []],
  ] as const) {
    for (const candidate of models) {
      if (candidate.model !== target.model) continue;
      modelFound = true;
      if (target.variant === undefined || candidate.variants?.includes(target.variant)) {
        return { catalog: scope };
      }
    }
  }
  return modelFound ? "variant-unavailable" : "model-unavailable";
}

/** Resolve a role deterministically without provider calls or implicit model guesses. */
export function resolveModelRoute(input: ResolveModelRouteInput): ModelRouteResolution {
  const attempts: ModelResolutionAttempt[] = [];
  for (const [source, route] of [
    ["local", ownRoute(input.local, input.role)],
    ["global", ownRoute(input.global, input.role)],
  ] as const) {
    if (route === undefined) continue;
    for (const target of [route.preferred, ...(route.fallback ?? [])]) {
      const availability = findAvailable(target, input.catalog);
      if (typeof availability === "object") {
        return {
          ok: true,
          role: input.role,
          source,
          catalog: availability.catalog,
          model: target.model,
          ...(target.variant === undefined ? {} : { variant: target.variant }),
        };
      }
      attempts.push({ source, target, reason: availability });
    }
  }
  return { ok: false, role: input.role, reason: "unresolved-role", attempts };
}
