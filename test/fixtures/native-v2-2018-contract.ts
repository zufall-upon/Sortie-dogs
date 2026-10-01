// Minimal pure host-contract fixture, grounded in OpenCode v2.0.18, commit
// cd9a14a6b688d4021bee381dfd39d2cef9c0f862 (MIT):
// core/src/v1/config/agent.ts normalize, v1/config/migrate.ts permissions/normalizeAction,
// core/src/util/wildcard.ts match, permission.ts evaluate, tool.ts whollyDisabled,
// session/context.ts select, tool/plugin/subagent.ts resolve/assert -> existing-child comparison
// -> prompt, and tool/plugin/shell.ts prepare's parsed-command permission resources.
// This is not a live OpenCode execution or a replacement for native acceptance.
export type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}

export function evaluate(action: string, resource: string, ...rulesets: readonly Rule[][]): Rule {
  return rulesets.flat().findLast(rule => match(action, rule.action) && match(resource, rule.resource))
    ?? { effect: "ask", action, resource: "*" };
}

export function whollyDisabled(action: string, rules: readonly Rule[]) {
  const rule = rules.findLast(rule => match(action, rule.action));
  return rule?.resource === "*" && rule.effect === "deny";
}

/** Read only the simple legacy header syntax actually emitted by sortie-dogs assets. */
export function convertedAssetPermissions(content: string): Rule[] {
  const tools: Record<string, boolean> = {}, declared: Record<string, string | Record<string, string>> = {};
  let section = "", nested: string | undefined;
  const scalar = (value: string) => value.replace(/^(["'])(.*)\1$/u, "$2");
  for (const line of content.split("---")[1]!.split(/\r?\n/u)) {
    if (/^\w/u.test(line)) { section = line.split(":")[0]!; nested = undefined; continue; }
    if (!["tools", "permission"].includes(section)) continue;
    const entry = /^(\s+)([^:]+):\s*(.*)$/u.exec(line);
    if (!entry) continue;
    const key = scalar(entry[2]!.trim()), value = scalar(entry[3]!.trim());
    if (entry[1]!.length > 2) { (declared[nested!] as Record<string, string>)[key] = value; continue; }
    if (section === "tools") tools[key] = value === "true";
    else if (!value) { nested = key; declared[key] = {}; }
    else declared[key] = value;
  }
  // ConfigAgentV1.normalize merges tools first, aliasing edit/write/patch, THEN permission.
  const permission: Record<string, string | Record<string, string>> = {};
  for (const [tool, enabled] of Object.entries(tools)) permission[["write", "edit", "patch"].includes(tool) ? "edit" : tool] = enabled ? "allow" : "deny";
  Object.assign(permission, declared);
  const normalizeAction = (action: string) => ["write", "patch"].includes(action) ? "edit" : action === "task" ? "subagent" : action === "bash" ? "shell" : action;
  return Object.entries(permission).flatMap(([key, value]) => Object.entries(typeof value === "string" ? { "*": value } : value)
    .map(([resource, effect]) => ({ action: normalizeAction(key), resource, effect: effect as Rule["effect"] })));
}
