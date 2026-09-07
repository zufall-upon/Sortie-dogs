import { randomUUID } from "node:crypto";
import { compareAdaptiveSignal } from "./adaptive-signal-comparison.js";
import { selectAdaptiveRemediation, type AdaptiveEligibilityInput } from "./adaptive-eligibility.js";
import { RunFlightLedger } from "./run-flight-ledger.js";
import type {
  AdaptiveRemediationCommand,
  AdaptiveRemediationContract,
  AdaptiveRemediationFailureCode,
  AdaptiveRemediationIteration,
  AdaptiveRemediationProbeCommand,
  AdaptiveRemediationSignal,
  AdaptiveRemediationValidationEvidence,
} from "./types.js";

export interface AdaptiveRemediationRequest {
  readonly task_id: string;
  readonly eligibility: AdaptiveEligibilityInput;
  readonly target_ref: string;
  readonly allowed_paths: { readonly read: readonly string[]; readonly write: readonly string[] };
  readonly iteration_budget: 1 | 2 | 3;
  readonly max_changed_paths: number;
  readonly cleanup_timeout_ms: number;
  readonly probe_validation: AdaptiveRemediationProbeCommand;
  readonly canonical_validation: AdaptiveRemediationCommand;
  readonly improvement_signal: AdaptiveRemediationSignal;
  readonly risk_class: "low" | "medium" | "high";
  readonly post_merge_validation: AdaptiveRemediationCommand;
  readonly acceptance: readonly string[];
}

export interface AdaptiveProbeEvidence {
  readonly command: readonly string[];
  readonly exit_code: number | null;
  readonly fingerprint: string;
  readonly signal_id: string;
  readonly value: number | null;
}

export interface AdaptiveCandidate {
  readonly worktree_id: string;
  readonly path: string;
  readonly parent_head: string;
}

export interface AdaptivePatchEvidence {
  readonly candidate: AdaptiveCandidate;
  readonly candidate_head: string;
  readonly hypothesis: string;
  readonly patch_fingerprint: string;
  readonly changed_paths: readonly string[];
  readonly probe: AdaptiveProbeEvidence;
}

export interface AdaptiveRemediationRuntimeHost {
  snapshotTarget(targetRef: string): Promise<{ readonly head: string; readonly tree: string }>;
  openCandidate(parentHead: string, iteration: 1 | 2 | 3): Promise<AdaptiveCandidate>;
  runBaselineProbe(candidate: AdaptiveCandidate, command: AdaptiveRemediationProbeCommand): Promise<AdaptiveProbeEvidence>;
  producePatch(input: {
    readonly candidate: AdaptiveCandidate;
    readonly iteration: 1 | 2 | 3;
    readonly acceptance: readonly string[];
    readonly allowed_paths: AdaptiveRemediationRequest["allowed_paths"];
    readonly probe_validation: AdaptiveRemediationProbeCommand;
  }): Promise<AdaptivePatchEvidence>;
  reserveProbe?(input: { readonly task_id: string; readonly iteration: 1 | 2 | 3; readonly parent_candidate: string }): Promise<string>;
  finishProbe?(input: { readonly reservation_id: string; readonly patch: AdaptivePatchEvidence; readonly duration_ms: number }): Promise<void>;
  failProbe?(input: { readonly reservation_id: string; readonly duration_ms: number; readonly code: string }): Promise<void>;
  inspectCleanup(candidate: AdaptiveCandidate, timeoutMs: number): Promise<{ readonly ok: boolean; readonly remaining_paths: readonly string[] }>;
  discardCandidate(candidate: AdaptiveCandidate): Promise<void>;
  runCanonical(candidate: AdaptiveCandidate, command: AdaptiveRemediationCommand): Promise<AdaptiveRemediationValidationEvidence>;
  review(input: { readonly candidate: AdaptiveCandidate; readonly candidate_head: string; readonly risk_class: AdaptiveRemediationRequest["risk_class"] }): Promise<{ readonly status: "pass" | "remediation-required" | "fail"; readonly fingerprint: string }>;
  promote(input: { readonly target_ref: string; readonly expected_head: string; readonly candidate_head: string }): Promise<{ readonly status: "promoted" | "cas-drift"; readonly observed_head: string }>;
  runPostMerge(command: AdaptiveRemediationCommand): Promise<AdaptiveRemediationValidationEvidence>;
  release(candidates: readonly AdaptiveCandidate[]): Promise<{ readonly ok: boolean; readonly remaining_paths: readonly string[] }>;
}

export interface AdaptiveLineageOptions {
  readonly ledger: RunFlightLedger;
  readonly unit_id: string;
  readonly route_id: string;
  readonly candidate_id: string;
  readonly selected_model: string;
  readonly selected_variant: string | null;
  readonly predecessor_attempt_id: string | null;
  /** Set only when a model is actually dispatched for each patch. */
  readonly model_attempt_per_patch: boolean;
}

/** Shared RunFlightLedger adapter: probe iterations charge the existing cumulative recovery authority. */
export class AdaptiveRunFlightLineage {
  private predecessor: string | null;
  private readonly reservations = new Set<string>();
  constructor(readonly options: AdaptiveLineageOptions) { this.predecessor = options.predecessor_attempt_id; }
  async reserveProbe(): Promise<string> {
    const attemptID = randomUUID();
    await this.options.ledger.append({ kind: "attempt.started", at: new Date().toISOString(), attempt_id: attemptID,
      predecessor_attempt_id: this.predecessor, unit_id: this.options.unit_id, candidate_id: this.options.candidate_id,
      route_id: this.options.route_id, role: "implementation", selected_model: this.options.selected_model,
      selected_variant: this.options.selected_variant, child_id: null, call_id: randomUUID(),
      budget_charge: { kind: "adaptive_probe", recovery_actions: 1, probe_iterations: 1,
        model_attempts: this.options.model_attempt_per_patch ? 1 : 0 } });
    this.reservations.add(attemptID); this.predecessor = attemptID; return attemptID;
  }
  async finishProbe(input: { readonly reservation_id: string; readonly patch: AdaptivePatchEvidence; readonly duration_ms: number }): Promise<void> {
    if (!this.reservations.delete(input.reservation_id)) throw new Error("adaptive-lineage-reservation-invalid");
    await this.options.ledger.append({ kind: "attempt.finished", at: new Date().toISOString(), attempt_id: input.reservation_id,
      observed_model: this.options.model_attempt_per_patch ? this.options.selected_model : null,
      observed_variant: this.options.model_attempt_per_patch ? this.options.selected_variant : null,
      failure: null, disposition: "succeeded", observation: { stage: "recovery", duration_ms: input.duration_ms,
        usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
        estimated_cost: { usd: null, provenance: "unknown" } },
      references: { capsule_ids: [], artifact_ids: [`sha256:${input.patch.patch_fingerprint}`] } });
  }
  async failProbe(input: { readonly reservation_id: string; readonly duration_ms: number; readonly code: string }): Promise<void> {
    if (!this.reservations.delete(input.reservation_id)) throw new Error("adaptive-lineage-reservation-invalid");
    await this.options.ledger.append({ kind: "attempt.finished", at: new Date().toISOString(), attempt_id: input.reservation_id,
      observed_model: this.options.model_attempt_per_patch ? this.options.selected_model : null,
      observed_variant: this.options.model_attempt_per_patch ? this.options.selected_variant : null,
      failure: { category: "implementation", code: input.code }, disposition: "failed",
      observation: { stage: "recovery", duration_ms: input.duration_ms,
        usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
        estimated_cost: { usd: null, provenance: "unknown" } }, references: { capsule_ids: [], artifact_ids: [] } });
  }
}

const pending = (command: AdaptiveRemediationCommand): AdaptiveRemediationValidationEvidence => ({
  command: [command.executable, ...(command.args ?? [])], status: "pending", exit_code: null, fingerprint: null,
});

const goalMet = (signal: AdaptiveRemediationSignal, value: number | null): boolean => value !== null &&
  (signal.goal.operator === "at-least" ? value >= signal.goal.value : value <= signal.goal.value);

const failure = (code: AdaptiveRemediationFailureCode, detail: string) => ({ code, fallback: "stop" as const, detail });

/** Executes the bounded state machine. Hosts own process/worktree mechanics; evidence cannot skip a stage. */
export class AdaptiveRemediationRuntime {
  constructor(readonly host: AdaptiveRemediationRuntimeHost) {}

  async execute(request: AdaptiveRemediationRequest): Promise<AdaptiveRemediationContract> {
    const started = Date.now();
    const selected = selectAdaptiveRemediation(request.eligibility);
    if (selected.status !== "selected") throw new Error(`adaptive-admission-${selected.reason}`);
    const target = await this.host.snapshotTarget(request.target_ref);
    const contract = {
      version: "0.1.0", task_id: request.task_id, selection: selected.selection, state: "ADMITTED",
      target: { ref: request.target_ref, base_head: target.head, base_tree: target.tree },
      allowed_paths: { read: [...request.allowed_paths.read], write: [...request.allowed_paths.write] },
      limits: { iteration_budget: request.iteration_budget, max_changed_paths: request.max_changed_paths, cleanup_timeout_ms: request.cleanup_timeout_ms },
      probe_validation: request.probe_validation, canonical_validation: request.canonical_validation,
      improvement_signals: [request.improvement_signal], risk_class: request.risk_class,
      post_merge_validation: request.post_merge_validation, baseline_probe: null, iterations: [], converged: false,
      full_validation: pending(request.canonical_validation), review: { status: "pending", fingerprint: null, remediation_attempts: 0 },
      promotion: { status: "pending", expected_target_head: target.head, observed_target_head: null, candidate_head: null },
      post_merge: pending(request.post_merge_validation), failure: null,
      metrics: { mode: selected.selection.mode, reason: selected.selection.reason, activation_reason: selected.selection.activation_reason,
        iteration_count: 0, probe_count: 0, full_validation_count: 0, post_merge_validation_count: 0,
        discarded_patch_count: 0, time_to_first_signal_ms: null, duration_ms: 0, total_tokens: null,
        estimated_cost_usd: null, sol_demotions: 0, cas_conflicts: 0, post_merge_failures: 0 },
    } as any;
    if (selected.selection.mode === "standard") return { ...contract, metrics: { ...contract.metrics, duration_ms: Date.now() - started } };

    const candidates: AdaptiveCandidate[] = [];
    let currentHead = target.head;
    let baseline: AdaptiveProbeEvidence | undefined;
    try {
      for (let number = 1; number <= request.iteration_budget; number += 1) {
        const iteration = number as 1 | 2 | 3;
        const candidate = await this.host.openCandidate(currentHead, iteration);
        candidates.push(candidate);
        if (baseline === undefined) {
          contract.state = "PROBING";
          baseline = await this.host.runBaselineProbe(candidate, request.probe_validation);
          contract.metrics.probe_count += 1;
          if (baseline.exit_code !== 0 || baseline.signal_id !== request.improvement_signal.signal_id) {
            contract.state = "ABANDONED"; contract.failure = failure("PROBE_FAILED", "Baseline probe did not return the declared typed signal.");
            break;
          }
          contract.baseline_probe = { signal_id: baseline.signal_id, value: baseline.value, artifact_fingerprint: baseline.fingerprint };
          contract.metrics.time_to_first_signal_ms = Date.now() - started;
        }
        const before = await this.host.snapshotTarget(request.target_ref);
        if (before.head !== target.head || before.tree !== target.tree) {
          contract.state = "REINTEGRATE_REQUIRED"; contract.failure = failure("CAS_DRIFT", "Target changed before candidate promotion.");
          contract.metrics.cas_conflicts += 1; break;
        }
        let reservation = "";
        const iterationStarted = Date.now();
        try { reservation = await this.host.reserveProbe?.({ task_id: request.task_id, iteration, parent_candidate: currentHead }) ?? ""; }
        catch (error) {
          if (error !== null && typeof error === "object" && "code" in error && error.code === "budget") {
            contract.state = "SOL_DEMOTED"; contract.failure = failure("ITERATION_BUDGET_EXHAUSTED", "Shared recovery budget denied the probe iteration.");
            contract.metrics.sol_demotions += 1; break;
          }
          throw error;
        }
        let patch: AdaptivePatchEvidence;
        try {
          patch = await this.host.producePatch({ candidate, iteration, acceptance: request.acceptance,
            allowed_paths: request.allowed_paths, probe_validation: request.probe_validation });
        } catch (error) {
          if (reservation !== "") await this.host.failProbe?.({ reservation_id: reservation,
            duration_ms: Date.now() - iterationStarted, code: "PROBE_FAILED" });
          contract.state = "ABANDONED"; contract.failure = failure("PROBE_FAILED", error instanceof Error ? error.message : "Probe failed.");
          break;
        }
        contract.metrics.probe_count += 1;
        if (reservation !== "") await this.host.finishProbe?.({ reservation_id: reservation, patch, duration_ms: Date.now() - iterationStarted });
        const outside = patch.changed_paths.filter((path) => !request.allowed_paths.write.includes(path));
        if (patch.candidate.parent_head !== currentHead || patch.changed_paths.length === 0 ||
          patch.changed_paths.length > request.max_changed_paths || outside.length > 0) {
          contract.state = "REJECTED"; contract.failure = failure("SCOPE_EXPANSION_REQUIRED", "Patch changed paths outside its bounded unit.");
          break;
        }
        const compared = compareAdaptiveSignal({ signal: { signal_id: request.improvement_signal.signal_id,
          improvement_direction: request.improvement_signal.improvement_direction,
          absolute_improvement_threshold: request.improvement_signal.absolute_improvement_threshold },
          baseline: { signal_id: baseline.signal_id, value: baseline.value },
          current: { signal_id: patch.probe.signal_id, value: patch.probe.value } });
        const outcome = compared.status === "compared" ? compared.outcome : "inconclusive";
        const cleanup = await this.host.inspectCleanup(candidate, request.cleanup_timeout_ms);
        const evidence: AdaptiveRemediationIteration = { iteration, parent_candidate: currentHead,
          candidate_head: patch.candidate_head, hypothesis: patch.hypothesis, patch_fingerprint: patch.patch_fingerprint,
          changed_paths: [...patch.changed_paths], measured_probe: { signal_id: patch.probe.signal_id,
            baseline_value: baseline.value, current_value: patch.probe.value, outcome,
            artifact_fingerprint: patch.probe.fingerprint }, cleanup: { status: cleanup.ok ? "pass" : "fail", remaining_paths: [...cleanup.remaining_paths] } };
        contract.iterations = [...contract.iterations, evidence]; contract.metrics.iteration_count += 1;
        if (!cleanup.ok) { contract.state = "ABANDONED"; contract.failure = failure("CLEANUP_FAILED", "Iteration cleanup did not close all residue or processes."); break; }
        if (patch.probe.exit_code !== 0) { contract.state = "ABANDONED"; contract.failure = failure("PROBE_FAILED", "Patch probe exited unsuccessfully."); break; }
        if (outcome !== "improved") {
          contract.metrics.discarded_patch_count += 1; contract.state = "ABANDONED";
          contract.failure = failure("NO_IMPROVEMENT", `Measured signal outcome was ${outcome}.`); break;
        }
        contract.state = "PROMISING"; currentHead = patch.candidate_head; baseline = patch.probe;
        if (goalMet(request.improvement_signal, patch.probe.value)) { contract.converged = true; contract.state = "CONVERGED"; break; }
        if (number === request.iteration_budget) {
          contract.state = "SOL_DEMOTED"; contract.failure = failure("ITERATION_BUDGET_EXHAUSTED", "Declared convergence goal was not reached within the shared iteration budget.");
          contract.metrics.sol_demotions += 1; break;
        }
        contract.state = "REFINING";
      }
      if (!contract.converged || contract.failure !== null) return contract;
      const finalCandidate = candidates.at(-1)!;
      contract.full_validation = await this.host.runCanonical(finalCandidate, request.canonical_validation);
      contract.metrics.full_validation_count = 1;
      if (contract.full_validation.status !== "pass") { contract.state = "ABANDONED"; contract.failure = failure("FULL_VALIDATION_FAILED", "Canonical candidate validation failed."); return contract; }
      contract.state = "FULL_VALIDATED";
      const review = await this.host.review({ candidate: finalCandidate, candidate_head: currentHead, risk_class: request.risk_class });
      contract.review = { status: review.status, fingerprint: review.fingerprint, remediation_attempts: review.status === "remediation-required" ? 1 : 0 };
      if (review.status !== "pass") { contract.state = "REJECTED"; contract.failure = failure("REVIEW_REMEDIATION_REQUIRED", "Risk-based review did not approve this candidate."); return contract; }
      contract.state = "REVIEWED";
      const beforeCas = await this.host.snapshotTarget(request.target_ref);
      if (beforeCas.head !== target.head || beforeCas.tree !== target.tree) {
        contract.state = "REINTEGRATE_REQUIRED"; contract.failure = failure("CAS_DRIFT", "Expected target base changed before CAS."); contract.metrics.cas_conflicts += 1; return contract;
      }
      const promotion = await this.host.promote({ target_ref: request.target_ref, expected_head: target.head, candidate_head: currentHead });
      contract.promotion = { status: promotion.status, expected_target_head: target.head,
        observed_target_head: promotion.observed_head, candidate_head: currentHead };
      if (promotion.status !== "promoted") { contract.state = "REINTEGRATE_REQUIRED"; contract.failure = failure("CAS_DRIFT", "Target CAS lost; target was not changed by this attempt."); contract.metrics.cas_conflicts += 1; return contract; }
      contract.state = "MERGED";
      contract.post_merge = await this.host.runPostMerge(request.post_merge_validation);
      contract.metrics.post_merge_validation_count = 1;
      if (contract.post_merge.status !== "pass") { contract.failure = failure("POST_MERGE_VERIFICATION_FAILED", "Post-merge verification failed; a new repair candidate is required."); contract.metrics.post_merge_failures += 1; return contract; }
      contract.state = "VERIFIED";
      return contract;
    } finally {
      const released = await this.host.release(candidates).catch(() => ({ ok: false, remaining_paths: candidates.map(({ path }) => path) }));
      if (!released.ok && contract.failure === null) { contract.state = "ABANDONED"; contract.failure = failure("CLEANUP_FAILED", "Final candidate cleanup failed."); }
      contract.metrics.duration_ms = Date.now() - started;
    }
  }
}
