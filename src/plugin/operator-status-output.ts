const RECENT_MODEL_ATTEMPTS = 8;
const MODEL_FIELDS = ["attemptID", "runID", "unitID", "kind", "childSessionID", "status", "nativeOutcome",
  "selectedModel", "observedModel", "observedVariant"] as const;

/** Display-only projection: never infer an observed model from a selection. */
function recentModelObservations(attempts: unknown[]) {
  const recent = attempts.slice(-RECENT_MODEL_ATTEMPTS).flatMap(value => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const attempt = value as Record<string, unknown>;
    return [Object.fromEntries(MODEL_FIELDS.filter(key => Object.hasOwn(attempt, key)).map(key => [key, attempt[key]]))];
  });
  return { recent_attempts: recent, omitted_attempts: attempts.length - recent.length };
}

/**
 * Native V2 truncates at whole-line boundaries. Put actionable facts and bounded
 * model observations before bulky history/proof; preserve every original value.
 */
export function serializeOperatorStatus(packet: Record<string, unknown>): string {
  const display: Record<string, unknown> = !Object.hasOwn(packet, "model_observations") && Array.isArray(packet.attempts) && packet.attempts.length > 0
    ? { ...packet, model_observations: recentModelObservations(packet.attempts) } : packet;
  const keys = new Set([
    "profile", "view", "mission_id", "run_id", "phase", "status", "decision", "coordinator_session_id",
    "work_quantity", "budget", "accounting_scope", "next_action", "execution_summary", "runtime", "model_observations", "completion", "attempts",
    ...Object.keys(display),
  ]);
  const lines = [...keys].flatMap(key => {
    if (!Object.hasOwn(display, key)) return [];
    const value = JSON.stringify(display[key]);
    return value === undefined ? [] : [`  ${JSON.stringify(key)}: ${value}`];
  });
  return `{\n${lines.join(",\n")}\n}`;
}
