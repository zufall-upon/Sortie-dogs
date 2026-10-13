/**
 * Native V2 truncates at whole-line boundaries. A large one-line full packet can
 * therefore hide every field. Put existing actionable facts before bulky proof
 * recipes, with one top-level field per line; keep the complete JSON unchanged.
 */
export function serializeOperatorStatus(packet: Record<string, unknown>): string {
  const keys = new Set([
    "profile", "view", "mission_id", "run_id", "phase", "status", "decision", "coordinator_session_id",
    "work_quantity", "budget", "accounting_scope", "attempts", "next_action", "execution_summary", "runtime", "completion",
    ...Object.keys(packet),
  ]);
  const lines = [...keys].flatMap(key => {
    if (!Object.hasOwn(packet, key)) return [];
    const value = JSON.stringify(packet[key]);
    return value === undefined ? [] : [`  ${JSON.stringify(key)}: ${value}`];
  });
  return `{\n${lines.join(",\n")}\n}`;
}
