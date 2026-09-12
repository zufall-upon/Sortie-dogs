/** Runtime identity is independent of the model route and the release's npm dist-tag. */
export interface RuntimeProfile {
  readonly id: "stable" | "v010";
  readonly agentSuffix: string;
  readonly toolPrefix: string;
  readonly stateDirectory: string;
  readonly flightDirectory: string;
  readonly configFile: string;
  readonly configEnvironment: string;
  readonly markerFile: string;
  readonly commandName: string;
  readonly parallel: boolean;
}

export const STABLE_RUNTIME_PROFILE: RuntimeProfile = Object.freeze({
  id: "stable", agentSuffix: "", toolPrefix: "sortie_", stateDirectory: ".sortie-dogs", flightDirectory: "run-flight",
  configFile: "sortie-dogs.json", configEnvironment: "SORTIE_DOGS_CONFIG",
  markerFile: "sortie-dogs.version", commandName: "sortie", parallel: true,
});

export const V010_RUNTIME_PROFILE: RuntimeProfile = Object.freeze({
  id: "v010", agentSuffix: "-v010", toolPrefix: "sortie_v010_", stateDirectory: ".sortie-dogs-v010", flightDirectory: "run-flight-v010",
  configFile: "sortie-dogs-v010.json", configEnvironment: "SORTIE_DOGS_V010_CONFIG",
  markerFile: "sortie-dogs-v010.version", commandName: "sortie-v010", parallel: false,
});

export const RUNTIME_PROFILES = Object.freeze({ stable: STABLE_RUNTIME_PROFILE, v010: V010_RUNTIME_PROFILE });
export type RuntimeProfileId = keyof typeof RUNTIME_PROFILES;

export const CANONICAL_AGENT_ROLES = Object.freeze([
  "dog-coordinator", "dog-worker", "dog-luna-worker", "dog-scout", "dog-reviewer", "dog-advisor", "dog-operator",
] as const);
export type CanonicalAgentRole = (typeof CANONICAL_AGENT_ROLES)[number];

export function profileAgent(profile: RuntimeProfile, role: CanonicalAgentRole): string {
  return `${role}${profile.agentSuffix}`;
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
