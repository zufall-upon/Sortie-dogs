import { goalFingerprint } from "../core/goal-bound.js";
import { MissionFabricValidationRequired, type MissionFabricValidation } from "../core/mission-fabric.js";
import type { RunFlightLedger } from "../core/run-flight-ledger.js";
import type { ContainedValidationResult } from "../core/types.js";
import { validationEvidenceKey, type ValidationBudgetRequest, type ValidationOutcome } from "../core/validation-budget.js";

function request(goalID: string, candidate: MissionFabricValidation, operation: string): ValidationBudgetRequest {
  return { run_id: goalID, operation_id: operation, source_snapshot: candidate.tree, candidate: candidate.tree,
    command: [candidate.command], environment: { platform: process.platform, arch: process.arch, runtime: process.version,
      directory: candidate.directory, toolchain: "native-shell-v1" }, scope: "canonical", owner: "coordinator",
    expected_evidence: ["combined-independent-candidate"], marginal_value: { unmet_criteria: [],
      risk_hypothesis: "Independent unit patches may interact after integration" }, reason: "acceptance" };
}
const operation = (actor: string, callID: string) => `fabric-native:${actor}:${callID}`;

export async function requireFabricValidation(ledger: RunFlightLedger, candidate: MissionFabricValidation): Promise<ContainedValidationResult> {
  const { state: goal, records } = await ledger.readGoal();
  if (!goal.goal_id || goal.phase !== "active" || goal.outstanding_reservations.length) throw Error("mission-fabric-unsettled-goal");
  const key = validationEvidenceKey(request(goal.goal_id, candidate, candidate.runID));
  const saved = [...records].reverse().find(({ event }) => event.kind === "validation.settled" && event.evidence_key === key)?.event;
  if (goal.validation_budget.reservations.some(item => item.evidence_key === key)) {
    throw Error("mission-fabric-native-validation-in-flight: reconcile the existing native shell call before Review");
  }
  if (saved?.kind === "validation.settled") {
    if (saved.outcome === "passed" && saved.exit_code === 0) return { ok: true, command: [candidate.command], exit_code: 0,
      fingerprint: goalFingerprint(saved).slice(7), error: null };
    throw Error(`mission-fabric-native-validation-${saved.outcome}: exit=${saved.exit_code ?? "unknown"}; retain candidate and inspect the native shell result before retry`);
  }
  throw new MissionFabricValidationRequired(candidate);
}

export async function reserveFabricValidation(ledger: RunFlightLedger, candidate: MissionFabricValidation, actor: string, callID: string): Promise<void> {
  const { state: goal } = await ledger.readGoal();
  if (!goal.goal_id || goal.phase !== "active" || goal.outstanding_reservations.length) throw Error("mission-fabric-unsettled-goal");
  const decision = await ledger.reserveValidation(request(goal.goal_id, candidate, operation(actor, callID)),
    Math.max(goal.budget?.max_units ?? 1, goal.validation_budget.consumed + 1));
  if (decision.decision !== "ALLOW") throw Error(`mission-fabric-native-validation:${decision.reason}; reuse or reconcile the existing native result`);
}

export async function settleFabricValidation(ledger: RunFlightLedger, candidate: MissionFabricValidation, actor: string, callID: string,
  outcome: ValidationOutcome, exit: number | null, duration: number): Promise<void> {
  const { state: goal, records } = await ledger.readGoal();
  if (!goal.goal_id) throw Error("mission-fabric-goal-missing");
  const validation = request(goal.goal_id, candidate, operation(actor, callID)), key = validationEvidenceKey(validation);
  const reserved = goal.validation_budget.reservations.find(item => item.operation_id === validation.operation_id && item.evidence_key === key);
  if (!reserved) {
    if (records.some(({ event }) => event.kind === "validation.settled" && event.operation_id === validation.operation_id && event.evidence_key === key)) return;
    throw Error("mission-fabric-native-validation-reservation-missing");
  }
  await ledger.settleValidation(reserved.reservation_id, validation, outcome, exit, Math.max(0, duration));
}
