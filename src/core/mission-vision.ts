import { createHash } from "node:crypto";
import type { OperatorMission } from "./operator-mission.js";

/** Controller-authored display interpretation, never a user quote, grant or acceptance criterion. */
export interface MissionVision {
  summary: string;
  source_refs: string[];
  translated?: boolean;
  mission_id: string;
  input_fingerprint: string;
}

export const missionVisionSchema = { anyOf: [
  { type: "object", additionalProperties: false,
    properties: { summary: { type: "string", minLength: 1, maxLength: 800 },
      source_refs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 1024 } },
      translated: { type: "boolean" } }, required: ["summary", "source_refs"] },
  { type: "null" }, { type: "string", enum: [""], minLength: 0, maxLength: 0 },
], "x-sortie-optional": true,
  description: "During ordinary Mission understanding, supply a short privacy-safe desired outcome in the user's language, not the current method or a copied first line. This is AI synthesis, not a user quote or authority. source_refs: user:<retained request id>, requirement:R1, context:<retained public message id>, or snapshot:<retained context sha256>. References must belong to this Mission. Mark translated:true for translation. Omit when evidence is insufficient or conflicting; use null to withdraw an unsupported summary. Do not invent a vision or add a question/model turn merely to fill this field. Do not include secrets, raw attachments or sensitive paths. Existing sources/bytes remain unchanged." };

const fingerprint = (mission: OperatorMission) => createHash("sha256")
  .update(JSON.stringify([mission.requests, mission.requirements])).digest("hex");

export function retainMissionVision(mission: OperatorMission, raw: unknown): void {
  if (raw === undefined) return;
  if (raw === null) { delete mission.vision; return; }
  const value = raw as Partial<MissionVision> | null;
  const known = new Set([
    ...mission.requests.map(item => `user:${item.id}`),
    ...mission.requirements.map(item => `requirement:${item.id}`),
    ...(mission.context ?? []).map(item => `context:${item.id}`),
    ...(mission.continuity?.sources ?? []).map(item => `snapshot:${item.sha256}`),
  ]);
  if (!value || Array.isArray(value) || typeof value.summary !== "string" || !value.summary.trim() ||
      value.summary.length > 800 || !Array.isArray(value.source_refs) || !value.source_refs.length || value.source_refs.length > 16 ||
      !value.source_refs.every(ref => typeof ref === "string" && known.has(ref)) ||
      value.translated !== undefined && typeof value.translated !== "boolean" ||
      Object.keys(value).some(key => !["summary", "source_refs", "translated"].includes(key))) {
    throw new Error("mission-vision-invalid: supply a privacy-safe AI summary with retained current-Mission source_refs, or omit when unknown");
  }
  mission.vision = { summary: value.summary, source_refs: [...new Set(value.source_refs)],
    ...(value.translated !== undefined ? { translated: value.translated } : {}),
    mission_id: mission.id, input_fingerprint: fingerprint(mission) };
}

/** A changed request/requirement set needs ordinary re-synthesis, not a migration/approval gate. */
export function currentMissionVision(mission: OperatorMission): MissionVision | undefined {
  return mission.vision?.mission_id === mission.id && mission.vision.input_fingerprint === fingerprint(mission)
    ? mission.vision : undefined;
}
