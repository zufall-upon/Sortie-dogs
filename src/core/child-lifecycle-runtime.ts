import { RunFlightLedger, type ChildFlightState } from "./run-flight-ledger.js";
import { planChildCancellation } from "./child-cancellation-plan.js";
import { isChildTerminalIdentity, reconcileChildTerminal, sameChildTerminalIdentity,
  type ChildTerminalIdentity, type ChildTerminalObservation, type ChildTerminalEvidence } from "./child-terminal-reconciliation.js";

export const DEFAULT_CHILD_DEADLINE_MS = 10 * 60_000;
export interface ChildLifecycleDescriptor {
  readonly identity: ChildTerminalIdentity;
  readonly deadline_ms: number;
}
export interface ChildLifecycleRuntime {
  observe(): Promise<{ observation: ChildTerminalObservation; evidence: ChildTerminalEvidence }>;
  /** Resolves only after the host's normal process-tree stop request has completed. */
  stop(): Promise<void>;
  release(): Promise<void>;
  terminal(state: ChildFlightState): Promise<void>;
}
export type ChildLifecycleResult =
  | { status: "terminal"; state: ChildFlightState }
  | { status: "waiting"; reason: string };

/** One lifecycle for implementation, diagnosis, and escalation; the host retains process ownership. */
export class CancellableChildLifecycle {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #operation: Promise<ChildLifecycleResult> | undefined;
  #stopping = false;
  #disposed = false;
  #explicit = false;

  private constructor(readonly descriptor: ChildLifecycleDescriptor, readonly ledger: RunFlightLedger,
    readonly runtime: ChildLifecycleRuntime) {}

  static async open(descriptor: ChildLifecycleDescriptor, ledger: RunFlightLedger,
    runtime: ChildLifecycleRuntime): Promise<CancellableChildLifecycle> {
    if (!isChildTerminalIdentity(descriptor.identity) || !Number.isSafeInteger(descriptor.deadline_ms) || descriptor.deadline_ms < 0) {
      throw new Error("invalid-child-descriptor");
    }
    const prior = (await ledger.read()).state.children.find((entry) => entry.identity.attempt_id === descriptor.identity.attempt_id);
    if (prior !== undefined && (!sameChildTerminalIdentity(prior.identity, descriptor.identity) || prior.deadline_ms !== descriptor.deadline_ms)) {
      throw new Error("child-descriptor-drift");
    }
    await ledger.append({ kind: "child.registered", at: new Date().toISOString(), ...descriptor });
    const lifecycle = new CancellableChildLifecycle(Object.freeze({ ...descriptor,
      identity: Object.freeze({ ...descriptor.identity }) }), ledger, runtime);
    lifecycle.#stopping = prior?.stop_trigger != null;
    return lifecycle;
  }

  get stopping(): boolean { return this.#stopping; }

  arm(): void {
    if (this.#disposed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const delay = Math.min(2 ** 31 - 1, Math.max(0, this.descriptor.deadline_ms - Date.now()));
    this.#timer = setTimeout(() => {
      void this.check().then((result) => {
        if (result.status !== "terminal" && !this.#disposed) {
          this.#timer = setTimeout(() => this.arm(), 1000);
          this.#timer.unref();
        }
      });
    }, delay);
    this.#timer.unref();
  }

  dispose(): void { this.#disposed = true; if (this.#timer !== undefined) clearTimeout(this.#timer); }

  check(explicitCancellation = false): Promise<ChildLifecycleResult> {
    this.#explicit ||= explicitCancellation;
    if (this.#operation === undefined) {
      const operation = this.#check().catch((): ChildLifecycleResult => ({ status: "waiting", reason: "runtime-unconfirmed" }));
      this.#operation = operation;
      void operation.finally(() => { this.#operation = undefined; });
    }
    const operation = this.#operation;
    // A slow host must not block the coordinator or cause overlapping stop/release operations.
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: "waiting", reason: "runtime-pending" }), 5000);
      void operation.then((result) => { clearTimeout(timer); resolve(result); });
    });
  }

  async #check(): Promise<ChildLifecycleResult> {
    const identity = this.descriptor.identity;
    const state = (await this.ledger.read()).state.children.find((entry) => entry.identity.attempt_id === identity.attempt_id)!;
    if (state.terminal !== null) {
      await this.runtime.terminal(state);
      this.dispose();
      return { status: "terminal", state };
    }
    let observed = await this.runtime.observe();
    let reconciliation = reconcileChildTerminal({ current: identity, ...observed });
    if (reconciliation.status === "rejected") return { status: "waiting", reason: reconciliation.reason };
    if (observed.evidence.terminal !== "satisfied") {
      const plan = planChildCancellation({ current: identity, ...observed, deadline_ms: state.deadline_ms,
        now_ms: Date.now(), cancellation_requested: this.#explicit,
        prior_stop_requests: state.stop_trigger === null ? [] : [identity] });
      if (plan.status !== "proposed" && !(plan.status === "not_proposed" && plan.reason === "stop_already_requested")) {
        return { status: "waiting", reason: plan.status === "rejected" ? "invalid-cancellation" : plan.reason };
      }
      this.#stopping = true;
      if (state.stop_trigger === null && plan.status === "proposed") {
        await this.ledger.append({ kind: "child.stop-requested", at: new Date().toISOString(), identity, trigger: plan.proposal.trigger });
      }
      // Recheck after durable intent: artifact production may have entered its protected window.
      observed = await this.runtime.observe();
      if (reconcileChildTerminal({ current: identity, ...observed }).status === "rejected") {
        return { status: "waiting", reason: "identity-drift" };
      }
      if (observed.evidence.artifact_window_closed !== "satisfied") return { status: "waiting", reason: "artifact-window" };
      await this.runtime.stop();
      observed = await this.runtime.observe();
    }
    if (reconcileChildTerminal({ current: identity, ...observed }).status === "rejected") {
      return { status: "waiting", reason: "identity-drift" };
    }
    if (observed.evidence.terminal !== "satisfied" || observed.evidence.tools_quiescent !== "satisfied" ||
      observed.evidence.artifact_window_closed !== "satisfied") return { status: "waiting", reason: "stop-unconfirmed" };
    this.#stopping ||= this.#explicit || Date.now() >= state.deadline_ms ||
      observed.observation.disposition === "failed" || observed.observation.disposition === "cancelled";
    if (this.#stopping) {
      await this.runtime.release();
      observed = await this.runtime.observe();
    }
    reconciliation = reconcileChildTerminal({ current: identity, ...observed });
    if (reconciliation.status !== "ready") return { status: "waiting", reason: reconciliation.reason };
    await this.ledger.append({ kind: "child.terminal", at: new Date().toISOString(), identity,
      disposition: observed.observation.disposition, evidence: observed.evidence });
    const terminal = (await this.ledger.read()).state.children.find((entry) => entry.identity.attempt_id === identity.attempt_id)!;
    await this.runtime.terminal(terminal);
    this.dispose();
    return { status: "terminal", state: terminal };
  }
}
