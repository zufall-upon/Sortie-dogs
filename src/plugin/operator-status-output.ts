const RECENT_ATTEMPTS = 8;
const RECENT_MODEL_ATTEMPTS = 8;
const ATTEMPT_FIELDS = ["attemptID", "runID", "unitID", "kind", "childSessionID", "status", "nativeOutcome",
  "selectedModel", "observedModel", "observedVariant", "resultClass"] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Display-only projection: never infer an observed model from a selection. */
function recentModelObservations(attempts: unknown[]) {
  const selected = new Set<number>();
  for (let index = Math.max(0, attempts.length - RECENT_ATTEMPTS); index < attempts.length; index++) selected.add(index);
  // Model-less direct work must not displace the most recent model observations.
  let models = 0;
  for (let index = attempts.length - 1; index >= 0 && models < RECENT_MODEL_ATTEMPTS; index--) {
    const attempt = attempts[index];
    if (record(attempt) && [attempt.selectedModel, attempt.observedModel].some(value => typeof value === "string" && value.length > 0)) {
      selected.add(index); models++;
    }
  }
  const recent = [...selected].sort((left, right) => left - right).flatMap(index => {
    const attempt = attempts[index];
    if (!record(attempt)) return [];
    const summary: Record<string, unknown> = Object.fromEntries(ATTEMPT_FIELDS.filter(key => Object.hasOwn(attempt, key)).map(key => [key, attempt[key]]));
    if (record(attempt.failure)) {
      const failure = attempt.failure;
      summary.failure = Object.fromEntries(["category", "code"].filter(key => Object.hasOwn(failure, key)).map(key => [key, failure[key]]));
    } else if (attempt.failure === null) summary.failure = null;
    return [summary];
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
