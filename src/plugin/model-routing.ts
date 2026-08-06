import { CONSULTATION_ROLE_POLICY } from "../core/consultation.js";

export interface ModelTarget {
  readonly model: string;
  readonly variant?: string;
}

export interface RoleModelRoute {
  readonly preferred: ModelTarget;
  readonly fallback?: readonly ModelTarget[];
}

export type ModelRoutingConfig = Readonly<Record<string, RoleModelRoute>>;

/**
 * The published DeepSWE cost curve settles the worker target: the cheap model at top reasoning effort
 * solves more than the expensive model at mid effort while costing a fraction of it, so paying for the
 * expensive model by default bought a lower solve rate. Worker effort therefore sits at the top of the
 * cheap model's range, and review effort stays above it on a stronger model, which is what the
 * mandatory source review is for.
 */
export const DEDICATED_WORKER_MODEL = "openai/gpt-5.6-luna";
export const DEDICATED_WORKER_VARIANT = "max";

/**
 * The stronger, far more expensive worker target a host may still select deliberately. It is no longer
 * a default route: it stays declared so an explicit dedicatedWorkerModel resolves against the catalog
 * without extra host configuration.
 */
export const ESCALATION_WORKER_MODEL = "openai/gpt-5.6-sol";
export const ESCALATION_WORKER_VARIANT = "medium";

export const DEDICATED_WORKER_ROLES = [
  "implementation",
  "remediation",
  "blocker-resolution",
  "sol-worker-mk2a2",
  "dog-worker",
] as const;

/** Ordered last-resort targets used only when the host proves a policy target unavailable. */
export const DEFAULT_FREE_TIER_FALLBACK_MODELS: readonly string[] = Object.freeze([
  "opencode/deepseek-v4-flash-free",
]);

const dedicatedWorkerRoleSet = new Set<string>(DEDICATED_WORKER_ROLES);

/** The dedicated worker target this build ships with when a host declares no target of its own. */
export const DEFAULT_DEDICATED_WORKER_TARGET: ModelTarget = Object.freeze({
  model: DEDICATED_WORKER_MODEL,
  variant: DEDICATED_WORKER_VARIANT,
});

/** The declared escalation target for a host that chooses to pay for the stronger worker model. */
export const ESCALATION_WORKER_TARGET: ModelTarget = Object.freeze({
  model: ESCALATION_WORKER_MODEL,
  variant: ESCALATION_WORKER_VARIANT,
});

/**
 * Fixed worker routes for one dedicated target. Which target is dedicated is a host decision, but
 * every worker role resolves to that single target and never to a fallback.
 */
export function dedicatedWorkerRouting(
  target: ModelTarget = DEFAULT_DEDICATED_WORKER_TARGET,
): ModelRoutingConfig {
  return Object.freeze(Object.fromEntries(
    DEDICATED_WORKER_ROLES.map((role) => [role, Object.freeze({
      preferred: Object.freeze(
        target.variant === undefined
          ? { model: target.model }
          : { model: target.model, variant: target.variant },
      ),
    })]),
  ));
}

export const DEDICATED_WORKER_ROUTING: ModelRoutingConfig = dedicatedWorkerRouting();

export const FIXED_MODEL_ROUTING: ModelRoutingConfig = DEDICATED_WORKER_ROUTING;

const fixedModelRoleSet = new Set<string>(Object.keys(FIXED_MODEL_ROUTING));

export const RECOMMENDED_LUNA_MODEL = "openai/gpt-5.6-luna";

/**
 * The coordinator has no built-in route on purpose. It is the one agent the user drives directly and
 * picks a model for in the session, so a shipped default here does not choose between models for an
 * undecided user: it silently discards a choice the user already made and cannot see being reverted.
 * Delegated roles are the opposite, because nobody selects a model for a session the loop spawns.
 * A host that does want a fixed coordinator model still declares one through modelRouting.
 *
 * Evidence gathering is retrieval rather than reasoning, so the scout sits one effort tier below the
 * worker, where the published cost curve returns the most per unit of cost.
 */
export const RECOMMENDED_SCOUT_VARIANT = "high";
export const RECOMMENDED_LUNA_ROLE_VARIANTS = Object.freeze({
  "dog-scout": RECOMMENDED_SCOUT_VARIANT,
} as const);
export const RECOMMENDED_LUNA_ROLES = Object.freeze(
  Object.keys(RECOMMENDED_LUNA_ROLE_VARIANTS),
) as readonly string[];

/** Configurable MkII defaults. Project-local and global configuration may override these routes. */
export const RECOMMENDED_LUNA_ROUTING: ModelRoutingConfig = Object.freeze(Object.fromEntries(
  Object.entries(RECOMMENDED_LUNA_ROLE_VARIANTS).map(([role, variant]) => [role, Object.freeze({
    preferred: Object.freeze({
      model: RECOMMENDED_LUNA_MODEL,
      variant,
    }),
  })]),
));

/**
 * Consultation must not inherit the caller's model. The preferred consultation model is the
 * strongest reasoning model a host declares; it stays out of the built-in catalog so an undeclared
 * host falls back to the dedicated target instead of an unavailable route.
 */
export const RECOMMENDED_CONSULTATION_MODEL = "anthropic/claude-opus-5";
export const RECOMMENDED_CONSULTATION_ROLES = Object.freeze(
  Object.values(CONSULTATION_ROLE_POLICY) as readonly string[],
);

/** Review and advice carry the reasoning effort the worker target intentionally does not spend. */
export const CONSULTATION_FALLBACK_VARIANT = "xhigh";

/**
 * The shipped consultation fallback. Review has to be able to reject work the worker just produced, so
 * it stays on the stronger model even though the worker no longer defaults to it; a fallback equal to
 * the worker target would review that work with exactly the capability that produced it.
 */
export const DEFAULT_CONSULTATION_FALLBACK_TARGET: ModelTarget = Object.freeze({
  model: ESCALATION_WORKER_MODEL,
  variant: CONSULTATION_FALLBACK_VARIANT,
});

function frozenTarget(target: ModelTarget): ModelTarget {
  return Object.freeze(
    target.variant === undefined
      ? { model: target.model }
      : { model: target.model, variant: target.variant },
  );
}

function sameTarget(left: ModelTarget, right: ModelTarget): boolean {
  return left.model === right.model && left.variant === right.variant;
}

/**
 * Consultation prefers the strongest declared reasoning model. A host that relocated the dedicated
 * worker target keeps that target as its first fallback, because such a host may not serve the
 * shipped model at all. Every route then ends at the shipped high-effort target, so a host on the
 * shipped defaults reviews above worker effort instead of inheriting the reduced worker effort.
 * Every consultation route stays configurable, so a host without the preferred model may declare any
 * role model it can actually serve.
 */
export function recommendedConsultationRouting(
  fallbackTarget: ModelTarget = DEFAULT_DEDICATED_WORKER_TARGET,
): ModelRoutingConfig {
  const relocated = !sameTarget(fallbackTarget, DEFAULT_DEDICATED_WORKER_TARGET) &&
    !sameTarget(fallbackTarget, DEFAULT_CONSULTATION_FALLBACK_TARGET);
  const fallback = Object.freeze(
    relocated
      ? [frozenTarget(fallbackTarget), frozenTarget(DEFAULT_CONSULTATION_FALLBACK_TARGET)]
      : [frozenTarget(DEFAULT_CONSULTATION_FALLBACK_TARGET)],
  );
  return Object.freeze(Object.fromEntries(
    RECOMMENDED_CONSULTATION_ROLES.map((role) => [role, Object.freeze({
      preferred: Object.freeze({ model: RECOMMENDED_CONSULTATION_MODEL }),
      fallback,
    })]),
  ));
}

export const RECOMMENDED_CONSULTATION_ROUTING: ModelRoutingConfig = recommendedConsultationRouting();

/** Every configurable role route this build recommends before host configuration is applied. */
export function recommendedRoleRouting(
  fallbackTarget: ModelTarget = DEFAULT_DEDICATED_WORKER_TARGET,
): ModelRoutingConfig {
  return Object.freeze({
    ...RECOMMENDED_LUNA_ROUTING,
    ...recommendedConsultationRouting(fallbackTarget),
  });
}

export const RECOMMENDED_ROLE_ROUTING: ModelRoutingConfig = recommendedRoleRouting();

export function isDedicatedWorkerRole(role: string): boolean {
  return dedicatedWorkerRoleSet.has(role);
}

export function isFixedModelRole(role: string): boolean {
  return fixedModelRoleSet.has(role);
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
  global: Object.freeze([
    Object.freeze({
      model: DEDICATED_WORKER_MODEL,
      variants: Object.freeze(
        [DEDICATED_WORKER_VARIANT, RECOMMENDED_SCOUT_VARIANT]
          .filter((variant, index, all) => all.indexOf(variant) === index),
      ),
    }),
    Object.freeze({
      model: ESCALATION_WORKER_MODEL,
      variants: Object.freeze([ESCALATION_WORKER_VARIANT, CONSULTATION_FALLBACK_VARIANT]),
    }),
  ]),
});

export interface ResolveModelRouteInput {
  readonly role: string;
  /** Project-local routing. A resolvable local route takes priority. */
  readonly local?: ModelRoutingConfig;
  /** Global routing is consulted only after the local route candidates fail. */
  readonly global?: ModelRoutingConfig;
  readonly catalog: ModelCatalog;
  /** The single target every dedicated worker role resolves to. Defaults to the shipped target. */
  readonly dedicated?: ModelTarget;
}

export interface ResolvedModelRoute {
  readonly ok: true;
  readonly role: string;
  readonly source: "fixed" | "local" | "global";
  readonly catalog: "project" | "global";
  readonly model: string;
  readonly variant?: string;
}

export interface ModelResolutionAttempt {
  readonly source: "fixed" | "local" | "global";
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

export function parseModelTarget(value: unknown): ModelTarget | undefined {
  return parseTarget(value);
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

function parseRoute(value: unknown): RoleModelRoute | undefined {
  const shorthand = parseTarget(value);
  if (shorthand !== undefined) return { preferred: shorthand };
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "preferred" && key !== "fallback")) {
    return undefined;
  }
  const preferred = parseTarget(value.preferred);
  if (preferred === undefined) return undefined;
  const fallbackValue = value.fallback;
  if (fallbackValue !== undefined && !Array.isArray(fallbackValue)) return undefined;
  const fallback: ModelTarget[] = [];
  for (const candidate of fallbackValue ?? []) {
    const target = parseTarget(candidate);
    if (target === undefined) return undefined;
    fallback.push(target);
  }
  return fallbackValue === undefined ? { preferred } : { preferred, fallback };
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
    const route = parseRoute(routeValue);
    if (route === undefined) return undefined;
    parsed[role] = route;
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
  const routes = isFixedModelRole(input.role)
    ? [["fixed", [input.dedicated ?? DEFAULT_DEDICATED_WORKER_TARGET]] as const]
    : [
      ["local", ownRoute(input.local, input.role)] as const,
      ["global", ownRoute(input.global, input.role)] as const,
    ];
  for (const [source, routeOrTargets] of routes) {
    if (routeOrTargets === undefined) continue;
    const targets = source === "fixed"
      ? routeOrTargets
      : [routeOrTargets.preferred, ...(routeOrTargets.fallback ?? [])];
    for (const target of targets) {
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
