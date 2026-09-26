import { validGoalEvidence, type GoalEvidence, type GoalFlightState } from "../core/goal-bound.js";
import { isRuntimeControlPath, refreshProtectedSnapshot } from "./protected-snapshot.js";

export interface CompletionBlocker {
  readonly reason: "active-reservations" | "missing-contract" | "missing-evidence" | "missing-binding" | "snapshot-unavailable" | "source-changed" | "candidate-changed";
  readonly criterion_id?: string;
  readonly source_paths?: readonly string[];
  readonly candidate_paths?: readonly string[];
  readonly expected?: string;
  readonly actual?: string;
  readonly legacy_control_snapshot?: boolean;
  readonly next_action: string;
}
export interface CompletionReadiness { readonly ready: boolean; readonly blockers: readonly CompletionBlocker[] }

/** The same read-only decision drives completion and public status, without settling or rerunning work. */
export async function goalCompletionReadiness(state: GoalFlightState, evidence: readonly GoalEvidence[]): Promise<CompletionReadiness> {
  const blockers: CompletionBlocker[] = [];
  if (state.outstanding_reservations.length) blockers.push({ reason: "active-reservations",
    next_action: "Reconcile the outstanding native tasks before acceptance; do not repeat completion while work is reserved." });
  if (!state.goal_id || !state.acceptance_fingerprint || !state.acceptance_contract?.criteria.length) {
    blockers.push({ reason: "missing-contract", next_action: "Restore the current run's registered goal and unchanged requirements before completion." });
  }
  const snapshots = new Map<string, ReturnType<typeof refreshProtectedSnapshot>>();
  for (const criterion of state.acceptance_contract?.criteria ?? []) {
    const proof = [...evidence].reverse().find(entry => entry.measurement.criterion_ids.includes(criterion.criterion_id) && validGoalEvidence(entry, state));
    if (!state.satisfied_criteria.includes(criterion.criterion_id) || !proof) {
      blockers.push({ reason: "missing-evidence", criterion_id: criterion.criterion_id,
        next_action: "Coordinator: obtain the missing criterion evidence within the existing requirements and cumulative budget; retain already valid checks." });
      continue;
    }
    if (criterion.source_binding !== "current-protected" && criterion.candidate_binding !== "current-protected") continue;
    const binding = proof.protected_binding;
    if (!binding) {
      blockers.push({ reason: "missing-binding", criterion_id: criterion.criterion_id,
        next_action: "Coordinator: obtain host-observed validation bound to this criterion; prose cannot replace a missing snapshot." });
      continue;
    }
    const key = JSON.stringify(binding);
    let pending = snapshots.get(key);
    if (!pending) {
      pending = refreshProtectedSnapshot(binding.project_root, binding).catch(() => undefined);
      snapshots.set(key, pending);
    }
    const current = await pending;
    const scope = { criterion_id: criterion.criterion_id, source_paths: binding.source_paths, candidate_paths: binding.candidate_paths };
    if (!current) {
      blockers.push({ ...scope, reason: "snapshot-unavailable",
        next_action: "Inspect the pinned manifest and declared paths for missing, changed or unreadable files. Correct the identified cause before validation or completion; do not retry unchanged." });
      continue;
    }
    if (criterion.source_binding === "current-protected" && current.source !== proof.identity.source) {
      const legacy = !binding.source_policy && binding.source_paths.some(path => path === "" || path === "." || isRuntimeControlPath(path));
      blockers.push({ ...scope, reason: "source-changed", expected: proof.identity.source, actual: current.source,
        ...(legacy ? { legacy_control_snapshot: true } : {}),
        next_action: legacy
          ? "Legacy evidence includes mutable runtime/Git records. Coordinator: obtain fresh evidence with the current snapshot policy in the same mission and cumulative budget. Do not edit the ledger, reset requirements, or repeat completion unchanged."
          : "Coordinator: inspect the changed source scopes and validate only the affected criterion after the candidate is settled; do not repeat unrelated passed checks or completion unchanged." });
    }
    if (criterion.candidate_binding === "current-protected" && current.candidate !== proof.identity.candidate) {
      blockers.push({ ...scope, reason: "candidate-changed", expected: proof.identity.candidate, actual: current.candidate,
        next_action: "Coordinator: the declared output changed after validation. Validate the intended current candidate and update its review before final acceptance; do not repeat completion unchanged." });
    }
  }
  return { ready: blockers.length === 0, blockers };
}
