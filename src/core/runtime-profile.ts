/** Runtime identity is independent of the model route and the release's npm dist-tag. */
export interface RuntimeProfile {
  readonly id: "stable" | "v010" | "v011";
  readonly agentSuffix: string;
  readonly toolPrefix: string;
  readonly stateDirectory: string;
  readonly flightDirectory: string;
  readonly configFile: string;
  readonly configEnvironment: string;
  readonly markerFile: string;
  readonly commandName: string;
  readonly parallel: boolean;
  /** External OpenCode names keyed by stable logical MkII role identity. */
  readonly agentNames: Readonly<Record<CanonicalAgentRole, string>>;
}

export const CANONICAL_AGENT_ROLES = Object.freeze([
  "dog-coordinator", "dog-worker", "dog-luna-worker", "dog-scout", "dog-reviewer", "dog-advisor", "dog-operator",
] as const);
export type CanonicalAgentRole = (typeof CANONICAL_AGENT_ROLES)[number];

function suffixedAgentNames(suffix: string): Readonly<Record<CanonicalAgentRole, string>> {
  return Object.freeze(Object.fromEntries(CANONICAL_AGENT_ROLES.map(role => [role, `${role}${suffix}`])) as Record<CanonicalAgentRole, string>);
}

export const STABLE_RUNTIME_PROFILE: RuntimeProfile = Object.freeze({
  id: "stable", agentSuffix: "", toolPrefix: "sortie_", stateDirectory: ".sortie-dogs", flightDirectory: "run-flight",
  configFile: "sortie-dogs.json", configEnvironment: "SORTIE_DOGS_CONFIG",
  markerFile: "sortie-dogs.version", commandName: "sortie", parallel: true,
  agentNames: suffixedAgentNames(""),
});

export const V010_RUNTIME_PROFILE: RuntimeProfile = Object.freeze({
  id: "v010", agentSuffix: "-v010", toolPrefix: "sortie_v010_", stateDirectory: ".sortie-dogs-v010", flightDirectory: "run-flight-v010",
  configFile: "sortie-dogs-v010.json", configEnvironment: "SORTIE_DOGS_V010_CONFIG",
  markerFile: "sortie-dogs-v010.version", commandName: "sortie-v010", parallel: false,
  agentNames: Object.freeze({
    ...suffixedAgentNames("-v010"),
    "dog-coordinator": "dog-operator",
    "dog-operator": "dogs-coordinator",
  }),
});

export const V011_RUNTIME_PROFILE: RuntimeProfile = Object.freeze({
  id: "v011", agentSuffix: "-v011", toolPrefix: "sortie_v011_", stateDirectory: ".sortie-dogs-v011", flightDirectory: "run-flight-v011",
  configFile: "sortie-dogs-v011.json", configEnvironment: "SORTIE_DOGS_V011_CONFIG",
  markerFile: "sortie-dogs-v011.version", commandName: "sortie-v011", parallel: false,
  agentNames: Object.freeze({ ...suffixedAgentNames("-v011"), "dog-operator": "dog-operator", "dog-coordinator": "dog-operator", "dog-worker": "dogs-coordinator",
    "dog-reviewer": "dog-reviewer-v010", "dog-advisor": "dog-advisor-v010" }),
});

export const RUNTIME_PROFILES = Object.freeze({ stable: STABLE_RUNTIME_PROFILE, v010: V010_RUNTIME_PROFILE, v011: V011_RUNTIME_PROFILE });
export type RuntimeProfileId = keyof typeof RUNTIME_PROFILES;

export function profileAgent(profile: RuntimeProfile, role: CanonicalAgentRole): string {
  return profile.agentNames[role];
}

export function canonicalAgent(profile: RuntimeProfile, agent: string | undefined): CanonicalAgentRole | undefined {
  return CANONICAL_AGENT_ROLES.find(role => profileAgent(profile, role) === agent);
}

export function profileTool(profile: RuntimeProfile, canonical: string): string {
  if (!canonical.startsWith(STABLE_RUNTIME_PROFILE.toolPrefix)) throw new Error("runtime-tool-prefix-invalid");
  return profile.toolPrefix + canonical.slice(STABLE_RUNTIME_PROFILE.toolPrefix.length);
}

/** Render packaged protocol instructions, never user criteria, source, or evidence. */
export function renderProfileInstructions(profile: RuntimeProfile, text: string): string {
  if (profile.id === "stable") return text;
  const substitutions = new Map<string, string>([
    ...CANONICAL_AGENT_ROLES.map(role => [role, profileAgent(profile, role)] as const),
    [STABLE_RUNTIME_PROFILE.stateDirectory, profile.stateDirectory],
    [STABLE_RUNTIME_PROFILE.configFile, profile.configFile],
    [STABLE_RUNTIME_PROFILE.markerFile, profile.markerFile],
  ]);
  const escaped = [...substitutions.keys()].sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`(?<![\\w-])(?:${escaped.join("|")})(?![\\w-])`, "g"), token => substitutions.get(token)!)
    .replace(/\bsortie_[a-z0-9_]+\b/g, token => token.startsWith(profile.toolPrefix) ? token : profileTool(profile, token))
    .replace(/\/sortie(?=\s|$)/gm, `/${profile.commandName}`);
}
