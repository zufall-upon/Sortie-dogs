import type { AdaptiveRemediationContract, AdaptiveRemediationFailureCode,
  AdaptiveRemediationIteration } from "./types.js";

export type AdaptiveProgressionRejectionCode =
  | "iteration-sequence-mismatch" | "iteration-count-mismatch" | "validation-count-mismatch"
  | "selection-metrics-mismatch" | "iteration-state-mismatch" | "cleanup-state-mismatch"
  | "convergence-state-mismatch" | "review-state-mismatch" | "promotion-state-mismatch"
  | "verification-state-mismatch";
export type AdaptiveProgressionHoldReason = "standard-mode" | "initial-iteration-pending" | "review-remediation-required";
export type AdaptiveProgressionRequest =
  | { readonly phase: "probe"; readonly iteration: AdaptiveRemediationIteration["iteration"] }
  | { readonly phase: "full-validation" } | { readonly phase: "review" }
  | { readonly phase: "promotion"; readonly expected_target_head: string; readonly candidate_head: string }
  | { readonly phase: "post-merge-validation" };
export type AdaptiveProgressionDecision =
  | { readonly kind: "rejected"; readonly code: AdaptiveProgressionRejectionCode; readonly detail: string }
  | { readonly kind: "hold"; readonly reason: AdaptiveProgressionHoldReason }
  | { readonly kind: "request"; readonly request: AdaptiveProgressionRequest }
  | { readonly kind: "stop"; readonly reason: AdaptiveRemediationFailureCode }
  | { readonly kind: "complete" };

const reject = (code: AdaptiveProgressionRejectionCode, detail: string): AdaptiveProgressionDecision => ({ kind: "rejected", code, detail });

/** Pure consistency guard mirroring the executing runtime's non-skippable stage order. */
export function decideAdaptiveProgression(contract: AdaptiveRemediationContract): AdaptiveProgressionDecision {
  for (let index = 0; index < contract.iterations.length; index += 1) {
    if (contract.iterations[index]?.iteration !== index + 1) return reject("iteration-sequence-mismatch", "Iterations must be consecutive from one.");
  }
  if (contract.iterations.length !== contract.metrics.iteration_count) return reject("iteration-count-mismatch", "Iteration metric differs from evidence.");
  const expectedProbes = (contract.baseline_probe === null ? 0 : 1) + contract.iterations.length;
  const expectedFull = contract.full_validation.status === "pending" ? 0 : 1;
  const expectedPost = contract.post_merge.status === "pending" ? 0 : 1;
  if (contract.metrics.probe_count !== expectedProbes || contract.metrics.full_validation_count !== expectedFull ||
    contract.metrics.post_merge_validation_count !== expectedPost) return reject("validation-count-mismatch", "Validation counts differ from measured evidence.");
  if (contract.metrics.mode !== contract.selection.mode || contract.metrics.reason !== contract.selection.reason ||
    contract.metrics.activation_reason !== contract.selection.activation_reason) return reject("selection-metrics-mismatch", "Selection audit fields differ.");
  if (contract.iterations.some((entry) => entry.cleanup.status === "pass" && entry.cleanup.remaining_paths.length > 0)) {
    return reject("cleanup-state-mismatch", "Passing cleanup retains residue.");
  }
  for (const entry of contract.iterations.slice(0, -1)) {
    if (entry.measured_probe.outcome !== "improved" || entry.cleanup.status !== "pass") return reject("iteration-state-mismatch", "Only improved clean candidates may be refined.");
  }
  const latest = contract.iterations.at(-1);
  if (contract.converged && (latest?.measured_probe.outcome !== "improved" || latest.cleanup.status !== "pass")) {
    return reject("convergence-state-mismatch", "Convergence requires measured improvement and cleanup.");
  }
  if (!contract.converged && contract.full_validation.status !== "pending") return reject("convergence-state-mismatch", "Canonical validation preceded convergence.");
  if (contract.review.status !== "pending" && contract.full_validation.status !== "pass") return reject("review-state-mismatch", "Review preceded canonical success.");
  if (contract.promotion.status !== "pending" && contract.review.status !== "pass") return reject("promotion-state-mismatch", "Promotion preceded review approval.");
  if (contract.post_merge.status !== "pending" && contract.promotion.status !== "promoted") return reject("verification-state-mismatch", "Post-merge validation preceded promotion.");
  if (contract.state === "VERIFIED") {
    if (contract.post_merge.status !== "pass" || contract.failure !== null) return reject("verification-state-mismatch", "VERIFIED requires passing post-merge evidence and no failure.");
    return { kind: "complete" };
  }
  if (contract.failure !== null) return { kind: "stop", reason: contract.failure.code };
  if (contract.selection.mode === "standard") return { kind: "hold", reason: "standard-mode" };
  if (latest === undefined) return { kind: "hold", reason: "initial-iteration-pending" };
  if (!contract.converged) return { kind: "request", request: { phase: "probe", iteration: (contract.iterations.length + 1) as AdaptiveRemediationIteration["iteration"] } };
  if (contract.full_validation.status === "pending") return { kind: "request", request: { phase: "full-validation" } };
  if (contract.review.status === "pending") return { kind: "request", request: { phase: "review" } };
  if (contract.review.status === "remediation-required") return { kind: "hold", reason: "review-remediation-required" };
  if (contract.promotion.status === "pending") return { kind: "request", request: { phase: "promotion", expected_target_head: contract.promotion.expected_target_head, candidate_head: latest.candidate_head } };
  return { kind: "request", request: { phase: "post-merge-validation" } };
}
