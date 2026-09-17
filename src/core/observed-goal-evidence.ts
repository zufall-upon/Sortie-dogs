import { goalFingerprint, type GoalEvidence, type GoalFlightState } from "./goal-bound.js";

export interface ObservedGoalExecution {
  readonly immutableRef: string;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly outcome: string;
  readonly fresh: boolean;
  readonly source: string;
  readonly candidate: string;
  readonly binding: NonNullable<GoalEvidence["protected_binding"]>;
}

/** One host execution can exercise several independently declared criteria.
 * Preserve each measurement identity instead of dropping all heterogeneous ones. */
export function evidenceFromObservedExecution(execution: ObservedGoalExecution, state: GoalFlightState, unitID: string): GoalEvidence[] {
  if (!execution.fresh || execution.exitCode !== 0 || execution.outcome !== "pass" || !state.goal_id || !state.acceptance_fingerprint) return [];
  const matching = state.acceptance_contract?.criteria.filter(criterion =>
    criterion.validation_command === execution.command[0] && criterion.expected_outcome === "pass" && criterion.proof_scope === "requested-full") ?? [];
  const groups = new Map<string, typeof matching>();
  for (const criterion of matching) {
    const { criterion_id: _id, ...measurement } = criterion;
    const key = goalFingerprint(measurement);
    groups.set(key, [...(groups.get(key) ?? []), criterion]);
  }
  return [...groups.values()].map(criteria => {
    const first = criteria[0]!;
    const ids = criteria.map(criterion => criterion.criterion_id);
    return { evidence_id: groups.size === 1 ? execution.immutableRef : goalFingerprint({ execution: execution.immutableRef, criterion_ids: ids }),
      goal_id: state.goal_id!, goal_revision: state.revision, scope_epoch: state.scope_epoch, acceptance_fingerprint: state.acceptance_fingerprint!,
      measurement: { criterion_ids: ids, target: first.target, entrypoint: first.entrypoint, workload: first.workload,
        oracle_coverage: first.oracle_coverage, build_boundary: first.build_boundary },
      identity: { source: first.source_binding === "current-protected" ? execution.source : first.source,
        candidate: first.candidate_binding === "current-protected" ? execution.candidate : first.candidate, fixture: first.fixture },
      protected_binding: execution.binding,
      execution: { command: execution.command, exit_code: 0, outcome: "pass", started_at: execution.startedAt,
        ended_at: execution.endedAt, units: [unitID] }, proof_scope: first.proof_scope };
  });
}
