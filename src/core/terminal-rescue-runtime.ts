import { randomUUID } from "node:crypto";
import { CancellableChildLifecycle, type ChildLifecycleRuntime } from "./child-lifecycle-runtime.js";
import { CHILD_TERMINAL_EVIDENCE_FIELDS } from "./child-terminal-reconciliation.js";
import { diagnosisContractHash, RunFlightLedger, type FlightObservation, type RunFlightEvent } from "./run-flight-ledger.js";
import { proposeTerminalRescue, type TerminalRescueAcceptedBase, type TerminalRescueBudget,
  type TerminalRescueTarget } from "./terminal-rescue-policy.js";

export interface TerminalRescueRequest {
  readonly unit_id: string;
  readonly failed_attempt_id: string;
  readonly accepted_base: TerminalRescueAcceptedBase;
  readonly budget_request: TerminalRescueBudget;
  readonly explicit_override: boolean;
}

export interface TerminalRescueExecution {
  readonly child_id: string;
  readonly runtime: ChildLifecycleRuntime;
  /** Start inference only after the runtime has durably registered this host-created child. */
  begin(): Promise<void>;
  readonly completion: Promise<{
    readonly observed_model: string | null;
    readonly observed_variant: string | null;
    readonly observation: FlightObservation;
    readonly failure: Extract<RunFlightEvent, { kind: "attempt.finished" }>["failure"];
    readonly disposition: "succeeded" | "failed" | "cancelled";
    readonly references: Extract<RunFlightEvent, { kind: "attempt.finished" }>["references"];
  }>;
}

export type TerminalRescueAttempt = Extract<RunFlightEvent, { kind: "attempt.started" }> & {
  readonly terminal_rescue_contract: TerminalRescueAcceptedBase;
};

export type TerminalRescueRunResult =
  | { readonly status: "non_rescue"; readonly reason: string }
  | { readonly status: "existing"; readonly attempt: TerminalRescueAttempt }
  | { readonly status: "waiting"; readonly attempt: TerminalRescueAttempt; readonly reason: string }
  | { readonly status: "finished"; readonly attempt: TerminalRescueAttempt;
      readonly outcome: Awaited<TerminalRescueExecution["completion"]>; readonly candidate_gates: "validation_review_cas_required" };

/** The host must reuse its normal writer admission and execute only the pinned attempt model. */
export interface TerminalRescueHost {
  availableTarget(): Promise<TerminalRescueTarget | null>;
  start(attempt: TerminalRescueAttempt, signal: AbortSignal): Promise<TerminalRescueExecution>;
}

/** Reserves once before host dispatch; final validation, review and CAS remain with the candidate owner. */
export class TerminalRescueRuntime {
  constructor(readonly ledger: RunFlightLedger, readonly host: TerminalRescueHost) {}

  async execute(request: TerminalRescueRequest): Promise<TerminalRescueRunResult> {
    const { records, state } = await this.ledger.read();
    const events = records.map(({ event }) => event);
    const starts = events.filter((event) => event.kind === "attempt.started");
    const started = starts.find((event) => event.attempt_id === request.failed_attempt_id && event.unit_id === request.unit_id);
    const finished = events.find((event) => event.kind === "attempt.finished" && event.attempt_id === request.failed_attempt_id);
    const child = state.children.find((entry) => entry.identity.attempt_id === request.failed_attempt_id);
    const existing = starts.find((event) => event.unit_id === request.unit_id && event.terminal_rescue_contract !== undefined);
    if (existing !== undefined) {
      if (existing.predecessor_attempt_id !== request.failed_attempt_id ||
        diagnosisContractHash(existing.terminal_rescue_contract) !== diagnosisContractHash(request.accepted_base)) {
        return { status: "non_rescue", reason: "rescue_contract_changed" };
      }
      return { status: "existing", attempt: existing as TerminalRescueAttempt };
    }
    if (!Number.isSafeInteger(request.budget_request.resources.time_ms) || request.budget_request.resources.time_ms <= 0 ||
      request.budget_request.resources.time_ms > 2 ** 31 - 1) return { status: "non_rescue", reason: "invalid_input" };
    if (started === undefined || finished?.kind !== "attempt.finished" || child?.terminal === null || child === undefined) {
      return { status: "non_rescue" as const, reason: "terminal_not_reconciled" };
    }
    if (state.current_candidate_id !== request.accepted_base.candidate_id || started.candidate_id !== request.accepted_base.candidate_id) {
      return { status: "non_rescue" as const, reason: "accepted_candidate_changed" };
    }
    const consumed = state.resource_budget_consumed, reserved = state.resource_budget_reserved;
    if (state.resource_budget_limits === null || state.budget_limits === null || consumed.time_ms === null ||
      consumed.cost_usd === null || reserved.time_ms === null || reserved.cost_usd === null) {
      return { status: "non_rescue" as const, reason: "budget_unknown" };
    }
    const activeRescues = starts.filter((event) => event.role === "rescue" &&
      !events.some((finished) => finished.kind === "attempt.finished" && finished.attempt_id === event.attempt_id));
    const policy = proposeTerminalRescue({ prior_attempt: { identity: child.identity, role: started.role,
      recovery_kind: started.budget_charge.kind, disposition: finished.disposition, failure: finished.failure },
      terminal_reconciliation: { current: child.identity, observation: { identity: child.identity, disposition: child.terminal.disposition },
        evidence: Object.fromEntries(CHILD_TERMINAL_EVIDENCE_FIELDS.map((field) => [field, "satisfied"])) },
      accepted_base: request.accepted_base, available_target: await this.host.availableTarget(), explicit_override: request.explicit_override,
      unit_rescue_count: starts.filter((event) => event.unit_id === request.unit_id && event.budget_charge.kind === "model_rescue").length,
      active_run_rescue_count: activeRescues.length,
      budget_limits: { counters: state.budget_limits, resources: state.resource_budget_limits },
      budget_consumed: { counters: state.budget_consumed,
        resources: { time_ms: consumed.time_ms + reserved.time_ms, cost_usd: consumed.cost_usd + reserved.cost_usd } },
      budget_request: request.budget_request });
    if (policy.status !== "proposed") return policy;
    const proposal = policy.proposal;
    const attempt: TerminalRescueAttempt = { kind: "attempt.started", at: new Date().toISOString(),
      attempt_id: randomUUID(), predecessor_attempt_id: started.attempt_id, unit_id: request.unit_id,
      candidate_id: proposal.accepted_base_candidate_id, route_id: started.route_id, role: "rescue",
      selected_model: proposal.target.model, selected_variant: proposal.target.variant, child_id: null, call_id: randomUUID(),
      budget_charge: { kind: "model_rescue", ...proposal.budget_request.counters }, resource_budget_request: proposal.budget_request.resources,
      terminal_rescue_contract: { candidate_id: proposal.accepted_base_candidate_id, contract_id: proposal.contract_id,
        scope: [...proposal.scope], acceptance: [...proposal.acceptance], validation: [...proposal.validation] } };
    // The ledger rechecks predecessor, terminal, one-rescue limits and budgets under its durable lock.
    await this.ledger.append(attempt);
    const abort = new AbortController();
    let lifecycle: CancellableChildLifecycle | undefined;
    const deadline = Date.parse(attempt.at) + proposal.budget_request.resources.time_ms;
    const operation = (async (): Promise<TerminalRescueRunResult> => {
      const execution = await this.host.start(structuredClone(attempt), abort.signal);
      lifecycle = await CancellableChildLifecycle.open({ identity: { ...child.identity, attempt_id: attempt.attempt_id,
        predecessor_attempt_id: started.attempt_id, child_id: execution.child_id, call_id: attempt.call_id },
        deadline_ms: deadline }, this.ledger, execution.runtime);
      lifecycle.arm();
      if (abort.signal.aborted) void lifecycle.check(true);
      else await execution.begin();
      const outcome = await execution.completion;
      const terminal = await lifecycle.check();
      if (terminal.status !== "terminal" || terminal.state.terminal?.disposition !== outcome.disposition) {
        return { status: "waiting" as const, attempt, reason: "child_terminal_unconfirmed" };
      }
      await this.ledger.append({ kind: "attempt.finished", at: new Date().toISOString(), attempt_id: attempt.attempt_id, ...outcome });
      lifecycle.dispose();
      return { status: "finished" as const, attempt, outcome, candidate_gates: "validation_review_cas_required" as const };
    })().catch((): TerminalRescueRunResult => {
      abort.abort();
      if (lifecycle !== undefined) void lifecycle.check(true);
      return { status: "waiting", attempt, reason: "host_execution_unconfirmed" };
    });
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<TerminalRescueRunResult>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        if (lifecycle !== undefined) void lifecycle.check(true);
        resolve({ status: "waiting", attempt, reason: "host_deadline_pending" });
      }, Math.max(0, deadline - Date.now()));
    });
    void operation.then(() => clearTimeout(timer));
    return Promise.race([operation, expired]);
  }
}
