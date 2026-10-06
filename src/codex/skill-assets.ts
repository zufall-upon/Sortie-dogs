import { readFile } from "node:fs/promises";

import type { RuntimeAsset } from "../runtime-assets.js";

const { CODEX_SKILL_ASSET_VERSION }: typeof import("../asset-version.js") = await import(
  `../asset-version.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);

async function skillSource(relativePath: string): Promise<string> {
  return readFile(new URL(`../../.agents/skills/sortie-dogs/${relativePath}`, import.meta.url), "utf8");
}

export const codexSkillAssets: readonly RuntimeAsset[] = Object.freeze([
  {
    name: "sortie-dogs-skill",
    version: CODEX_SKILL_ASSET_VERSION,
    installPath: "SKILL.md",
    content: await skillSource("SKILL.md"),
  },
  {
    name: "sortie-dogs-skill-metadata",
    version: CODEX_SKILL_ASSET_VERSION,
    installPath: "agents/openai.yaml",
    content: await skillSource("agents/openai.yaml"),
  },
]);
