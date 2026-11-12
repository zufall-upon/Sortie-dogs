import { createHash, randomUUID } from "node:crypto";
import type { OperatorMission } from "./operator-mission.js";

export const PURPOSE_DECISIONS = ["CONTINUE", "REUSE", "CHANGE_METHOD", "STOP_METHOD", "NEEDS_DECISION"] as const;
export interface PurposeDecisionInput {
  decision: typeof PURPOSE_DECISIONS[number];
  requirement_ids: string[];
  observed_outcome: string;
  unmet_work: string[];
  reason: string;
  evidence_refs: string[];
  affected_method?: string;
  next_action: string;
}
export interface PurposeDecision extends PurposeDecisionInput {
  id: string;
  mission_id: string;
  run_id: string | null;
  requirements_fingerprint: string;
  recorded_at: string;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const line = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 2000;
const lines = (value: unknown, min = 0): value is string[] => Array.isArray(value) && value.length >= min && value.length <= 64 && value.every(line);
const keys = ["decision", "requirement_ids", "observed_outcome", "unmet_work", "reason", "evidence_refs", "affected_method", "next_action"];
function valid(value: unknown): value is PurposeDecisionInput {
  return object(value) && PURPOSE_DECISIONS.includes(value.decision as PurposeDecisionInput["decision"]) &&
    lines(value.requirement_ids, 1) && line(value.observed_outcome) && lines(value.unmet_work) && line(value.reason) &&
    lines(value.evidence_refs) && (value.affected_method === undefined || line(value.affected_method)) && line(value.next_action) &&
    (!["CHANGE_METHOD", "STOP_METHOD"].includes(String(value.decision)) || line(value.affected_method));
}
export function purposeRequirementsFingerprint(mission: OperatorMission): string {
  return createHash("sha256").update(JSON.stringify(mission.requirements)).digest("hex");
}
/**
 * A bounded strategy observation, never an evidence receipt or execution authority.
 * Recording it does not act on the method. At a later stop/question boundary an
 * explicit STOP_METHOD can trigger one reconsideration, not determine scope.
 */
export function validatePurposeDecision(mission: OperatorMission, raw: unknown): asserts raw is PurposeDecisionInput {
  if (!valid(raw) || Object.keys(raw).some(key => !keys.includes(key)) ||
      raw.requirement_ids.some(id => !mission.requirements.some(requirement => requirement.id === id))) {
    throw new Error("mission-purpose-decision-invalid");
  }
}
export function appendPurposeDecision(mission: OperatorMission, raw: unknown): void {
  validatePurposeDecision(mission, raw);
  const input = structuredClone(raw);
  // Transport retries within the same run need not crowd out useful prior decisions.
  // Explicitly selecting the same observation for a new run retains its new context.
  const last = purposeDecisionView(mission).current.at(-1);
  if (last && last.run_id === mission.runID && keys.every(key => JSON.stringify(last[key as keyof PurposeDecision]) === JSON.stringify(input[key as keyof PurposeDecisionInput]))) return;
  mission.purposeDecisions = [...retained(mission), { ...input, id: randomUUID(), mission_id: mission.id,
    run_id: mission.runID, requirements_fingerprint: purposeRequirementsFingerprint(mission), recorded_at: new Date().toISOString() }].slice(-8);
}
function retained(mission: OperatorMission): PurposeDecision[] {
  const raw: unknown = mission.purposeDecisions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is PurposeDecision => valid(value) && object(value) && line(value.id) &&
    line(value.mission_id) && (value.run_id === null || line(value.run_id)) &&
    typeof value.requirements_fingerprint === "string" && /^[a-f0-9]{64}$/u.test(value.requirements_fingerprint) &&
    line(value.recorded_at) && Number.isFinite(Date.parse(value.recorded_at))).slice(-8);
}
export function purposeDecisionView(mission: OperatorMission) {
  const entries = retained(mission), fingerprint = purposeRequirementsFingerprint(mission);
  const current = entries.filter(item => item.mission_id === mission.id && item.requirements_fingerprint === fingerprint &&
    item.requirement_ids.every(id => mission.requirements.some(requirement => requirement.id === id)));
  return { current, historical: entries.filter(item => !current.includes(item)),
    application_status: "not-established-by-this-record",
    interpretation: "Selected strategy observations, not proof that a plan was admitted or a method executed. observed_outcome and evidence_refs are model reports, not host observations. current means related to current requirements, not current evidence freshness. Original requirements and actual outcomes govern. REUSE does not establish evidence freshness or PASS. STOP_METHOD ends only the named method: it neither stops a live process nor completes/cancels the Mission. Required validation, explicit rollback, permissions, budget, Review and root acceptance remain unchanged. next_action here is advisory, not the host next_action." };
}

export const purposeDecisionSchema = { type: "object", "x-sortie-optional": true, additionalProperties: false,
  description: "Optional important purpose/method decision accompanying useful planning or submission, not every Task. Record actual user outcome and concrete unmet work; references are not proof. An explicit STOP_METHOD can trigger one stop/question scope reconsideration, not permission or a semantic determination. No extra plan/approval solely to record it.",
  required: ["decision", "requirement_ids", "observed_outcome", "unmet_work", "reason", "evidence_refs", "next_action"],
  properties: { decision: { type: "string", enum: [...PURPOSE_DECISIONS] },
    ...Object.fromEntries(["observed_outcome", "reason", "affected_method", "next_action"].map(key => [key, { type: "string", minLength: 1, maxLength: 2000 }])),
    ...Object.fromEntries(["requirement_ids", "unmet_work", "evidence_refs"].map(key => [key, { type: "array", minItems: key === "requirement_ids" ? 1 : 0,
      maxItems: 64, items: { type: "string", minLength: 1, maxLength: 2000 } }])) } };
