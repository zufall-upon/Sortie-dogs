/** Optional, bounded telemetry retained with the existing terminal goal ledger, never an authority input. */
export interface GoalReport {
  readonly definition: "pre-terminal-host-tokens/v1";
  readonly terminal_key: string;
  readonly tokens: number | null;
  readonly models: readonly { readonly model: string; readonly tokens: number }[] | null;
  readonly first_pass_eligible: boolean;
  readonly traits: readonly ("pack-tactics" | "recovery" | "clean-sweep")[];
  readonly overlap?: { readonly definition: "worker-span-union/v1"; readonly worker_ms: number; readonly wall_ms: number };
}

export function validGoalReport(value: unknown): value is GoalReport {
  if (value === null || typeof value !== "object") return false;
  const item = value as GoalReport;
  const amount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const duration = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const overlap = item.overlap;
  return Object.keys(item).every((key) => ["definition", "terminal_key", "tokens", "models", "first_pass_eligible", "traits", "overlap"].includes(key)) &&
    item.definition === "pre-terminal-host-tokens/v1" && /^sha256:[a-f0-9]{64}$/u.test(item.terminal_key) &&
    (item.tokens === null || amount(item.tokens)) && typeof item.first_pass_eligible === "boolean" &&
    Array.isArray(item.traits) && item.traits.length <= 3 && new Set(item.traits).size === item.traits.length &&
    item.traits.every((trait) => ["pack-tactics", "recovery", "clean-sweep"].includes(trait)) &&
    (overlap === undefined || overlap !== null && typeof overlap === "object" &&
      Object.keys(overlap).every((key) => ["definition", "worker_ms", "wall_ms"].includes(key)) && overlap.definition === "worker-span-union/v1" &&
      duration(overlap.worker_ms) && duration(overlap.wall_ms) && overlap.worker_ms >= overlap.wall_ms) &&
    (item.models === null || Array.isArray(item.models) && item.models.length <= 128 &&
      new Set(item.models.map((entry) => entry?.model)).size === item.models.length &&
      item.models.every((entry) => entry !== null && typeof entry === "object" && Object.keys(entry).every((key) => key === "model" || key === "tokens") &&
        typeof entry.model === "string" && entry.model.length > 0 && entry.model.length <= 512 && amount(entry.tokens)) &&
      item.tokens !== null && item.models.reduce((sum, entry) => sum + entry.tokens, 0) === item.tokens);
}
