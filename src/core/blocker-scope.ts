import { createHash } from "node:crypto";
import type { OperatorMission } from "./operator-mission.js";
import type { OperatorState } from "./operator-runtime.js";
import { purposeRequirementsFingerprint, type PurposeDecisionInput } from "./mission-purpose.js";

/** A model's STOP_METHOD is an observation, not proof that remaining work is independent. */
export function scopedMethodDecision(value: PurposeDecisionInput | undefined): value is PurposeDecisionInput {
  return value?.decision === "STOP_METHOD" && !!value.affected_method?.trim() && value.unmet_work.length > 0;
}

/** One reconsideration per exact decision/boundary; never turn a retry into a permanent gate. */
export function blockerScopeKey(mission: OperatorMission, decision: PurposeDecisionInput, boundary: "submission" | "question"): string {
  return createHash("sha256").update(JSON.stringify({ mission: mission.id, run: mission.runID,
    requirements: purposeRequirementsFingerprint(mission), requests: mission.requests, boundary,
    decision: { decision: decision.decision, requirement_ids: decision.requirement_ids,
      observed_outcome: decision.observed_outcome, unmet_work: decision.unmet_work, reason: decision.reason,
      evidence_refs: decision.evidence_refs, affected_method: decision.affected_method, next_action: decision.next_action } })).digest("hex");
}

export function rememberBlockerScopeCheck(mission: OperatorMission, key: string): boolean {
  const checks = (mission.blockerScopeChecks ?? []).filter(item => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item));
  if (checks.includes(key)) return false;
  mission.blockerScopeChecks = [...checks, key].slice(-8);
  return true;
}

/**
 * A deliberately narrow recognizer for the reported Japanese availability form.
 * It is a reason to reconsider, not a classification of the other requested inputs
 * or proof that any operation is independent. Unknown wording falls through.
 */
export function laterSmokeQuestionKey(mission: OperatorMission, run: OperatorState | undefined, question: string,
  choices: string): string | undefined {
  if (mission.phase !== "running" || !mission.runID || !run || run.runID !== mission.runID || run.phase !== "running" ||
      JSON.stringify(run.sourceRefs) !== JSON.stringify(mission.requests.map(item => `user:${item.id}`)) ||
      JSON.stringify(run.acceptance) !== JSON.stringify(mission.requirements.map(item => item.text))) return;
  const running = run.units.filter(unit => unit.status === "running");
  if (running.length !== 1) return;
  const current = running[0]!;
  // An implementation objective does not establish the operation still in progress
  // once this same admission has reached checks or a declared operation. Retained
  // observations only veto this recognizer; they do not prove validation or freshness.
  if (current.directExecution?.checks.length || current.validationRegistration?.checks.length ||
      current.reviewerCorrection?.checks?.length || current.directHandoffs?.some(segment => segment.checks.length) ||
      current.evidence.length || mission.execution?.observations.length) return;

  // Both sides describe the same operation: a source request and the actual admitted
  // unit objective. An AI-authored title, requirement or phase label alone is insufficient.
  const source = mission.requests.map(item => item.text);
  const linuxWork = /linux(?:側)?(?:の)?リリース自動化(?:の)?(?:を)?実装/iu;
  const laterOnly = /windows(?:側|環境)?(?:は|が)?[^。！？\n]{0,60}リリース後(?:の)?\s*smoke(?:で)?(?:だけ|のみ)/iu;
  if (!source.some(text => linuxWork.test(text)) || !source.some(text => laterOnly.test(text))) return;
  const objective = running[0]!.unit.objective.trim();
  if (!/^(?:implement (?:the )?linux release automation|linux(?:側)?(?:の)?リリース自動化(?:の)?(?:を)?実装(?:する|して)?)\.?$/iu.test(objective)) return;

  // Contrary or ambiguous current requirements, including prior user context, are
  // never resolved by this recognizer. Requirements can veto, not establish, scope.
  const userContext = (mission.context ?? []).filter(item => item.role === "user").map(item => item.text);
  const context = [...source, ...userContext, ...mission.requirements.map(item => item.text)];
  if (context.some(text => text.split(/[。！？\n]/u).some(sentence =>
    /windows[^。！？\n]{0,100}smoke(?:で)?(?:だけ|のみ)[^。！？\n]{0,30}(?:ではな[いく]|じゃな[いく]|でな[いく]|とは限らない|かどうか|未確認|不明|かもしれない)/iu.test(sentence) ||
    /(?:現在|今|実装中|current(?:ly)?)[^。！？\n]{0,90}(?:必要|必須|依存|不明|禁止|保留|許可|承認|使用|required|requires?|held|hold|prohibit)/iu.test(sentence) ||
    /(?:prebuild|manifest|oss|license|ライセンス)[^。！？\n]{0,60}(?:必要|必須|依存|禁止|保留|許可|承認|required|requires?|held|hold|prohibit)/iu.test(sentence) ||
    /windows[^。！？\n]{0,60}(?:必要|必須|不可欠|依存|required|requires?)/iu.test(sentence) && !laterOnly.test(sentence)))) return;

  // The form is a grouped, partial-availability inquiry, not a decision/approval.
  // The other items are intentionally not classified or discarded.
  if (!/3項目/u.test(question) || !/①[^②]+②[^③]+③/su.test(question) ||
      !/①[^②]*windows[^②]*(?:環境|検証機会)/iu.test(question) ||
      !/(?:提供可否|利用できる既存の場所)/u.test(question) || !/(?:分かるものだけ|未所持)/u.test(question) ||
      /(?:判断|承認|許可|同意|どちら|選択|(?:今|現在|実装中)[^。！？\n]{0,40}(?:必要|必須|依存|待))/u.test(`${question}\n${choices}`)) return;

  return createHash("sha256").update(JSON.stringify({ rule: "later-smoke-availability-v1", mission: mission.id,
    run: run.runID, plan: run.planHash, unit: running[0]!.unit, requests: mission.requests,
    requirements: mission.requirements, userContext })).digest("hex");
}

export const LATER_SMOKE_RECONSIDER = "This grouped availability question may make a later-only environment a condition for the admitted current work. Compare the saved user request and the actual current operation before asking. The match does not prove independence, permission, or that any other requested information is unnecessary. Keep the later smoke and every prebuild, OSS, safety and license condition; check whether any item is genuinely required now. Preserve prohibitions, holds, budget, ownership, validation and review. If the relation is unknown or a current dependency or user decision remains, ask or hold as before. This is not completion or permission.";

export const BLOCKER_SCOPE_RECONSIDER = "A stopped method and unmet work were reported together. Compare the original request, applicable instructions and observed facts with the affected operation and current work. A model statement or source reference does not prove independence or authorize any operation. Preserve future conditions and all prohibitions, holds, budget, ownership, safety, license, validation and review. Continue only work whose independence and authorization are actually established; if the current dependency is unknown or genuinely blocks the work, keep it held and submit or ask again. This is not completion or permission.";
