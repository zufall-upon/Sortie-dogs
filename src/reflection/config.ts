import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { ReflectionConfiguration } from "../plugin/config.js";

export type ReflectionLayer = "run" | "project" | "global";
export const DEFAULT_REFLECTION: ReflectionConfiguration = Object.freeze({ enabled: false, layers: Object.freeze({ run: true, project: true, global: false }), maxInjectedEntries: 3, maxInjectedTokens: 500 });

export function reflectionEnabled(config: ReflectionConfiguration, env = process.env.SORTIE_REFLECTION): boolean {
  return env === "0" ? false : config.enabled;
}

export function projectKey(root: string): string {
  const normalized = resolve(root).replaceAll("\\", "/").replace(/\/+$/u, "");
  return createHash("sha256").update(process.platform === "win32" ? normalized.toLowerCase() : normalized).digest("hex").slice(0, 16);
}

export function configRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

export async function nearestPackageVersion(): Promise<string> {
  try {
    const file = join(resolve(fileURLToPath(import.meta.url), "..", "..", ".."), "package.json");
    const parsed = JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(parsed.version)) throw new Error("invalid");
    return parsed.version;
  } catch { throw new Error("reflection_version_unavailable"); }
}
