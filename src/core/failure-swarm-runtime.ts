import { CancellableChildLifecycle, type ChildLifecycleRuntime } from "./child-lifecycle-runtime.js";
import { EvidenceCapsuleStore, type EvidenceSourceReference } from "./evidence-capsule.js";
import { inspectExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { admitLunaFabric, type LunaFabricContract } from "./luna-fabric-contract.js";
import { LUNA_FABRIC_MAX_ACTIVE } from "./luna-fabric-scheduler.js";
import { planFailureSwarm, type FailureSwarmLane } from "./failure-swarm-plan.js";
import { diagnoseFailure } from "./failure-diagnosis.js";
import { diagnosisContractHash, RunFlightLedger, type DiagnosisFlightState, type DiagnosisSelection,
  type FlightBudgetCharge, type FlightResourceBudget, type FlightObservation } from "./run-flight-ledger.js";

export interface FailureSwarmRequest {
  readonly run_id: string;
  readonly unit_id: string;
  readonly attempt_id: string;
  readonly cause: "known" | "unknown";
  readonly source_capsule_id: string;
  readonly causal_classes: readonly string[];
  readonly max_lanes: number;
  readonly per_lane_budget_charge: FlightBudgetCharge;
  readonly per_lane_resource_budget?: FlightResourceBudget;
  readonly timeout_ms: number;
}
export interface ReadOnlyDiagnosisDescriptor {
  readonly swarm_id: string;
  readonly lane_id: string;
  readonly diagnosis_id: string;
  readonly causal_class: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly failed_attempt_id: string;
  readonly candidate_id: string;
  readonly source_capsule_id: string;
  readonly source_manifest: readonly string[];
  readonly deadline_ms: number;
  readonly access: "read_only";
}
export interface DiagnosisFinding {
  readonly causal_class: string;
  readonly verdict: "supported" | "excluded" | "unknown";
  readonly validation_fingerprints: readonly string[];
}

export class FailureSwarmRuntime {
  readonly plan: ExecutionPlan;
  readonly fabric: LunaFabricContract;
  constructor(readonly ledger: RunFlightLedger, readonly store: EvidenceCapsuleStore,
    plan: unknown, fabric: unknown,
    readonly currentSources: (paths: readonly string[]) => Promise<readonly Pick<EvidenceSourceReference, "path" | "blob_hash">[]>,
    readonly ownerRoot: string) {
    this.plan = inspectExecutionPlan(plan, fabric);
    const admitted = admitLunaFabric(fabric);
    if (admitted.route !== "luna-fabric") throw new Error("diagnosis-plan-invalid");
    this.fabric = admitted.contract;
  }

  async get(swarmID: string): Promise<DiagnosisFlightState> {
    inspectExecutionPlan(this.plan, this.fabric);
    const state = (await this.ledger.read()).state;
    const swarm = state.diagnoses.find((entry) => entry.swarm_id === swarmID);
    if (swarm === undefined || swarm.owner_root !== this.ownerRoot || swarm.plan_id !== this.plan.plan_id || swarm.plan_binding_id !== this.plan.binding_id) {
      throw new Error("diagnosis-binding-mismatch");
    }
    return swarm;
  }

  descriptor(swarm: DiagnosisFlightState, laneID: string): ReadOnlyDiagnosisDescriptor {
    const lane = swarm.lanes.find((entry) => entry.lane_id === laneID);
    if (lane === undefined) throw new Error("diagnosis-lane-unknown");
    return Object.freeze({ ...lane, swarm_id: swarm.swarm_id, run_id: swarm.run_id,
      unit_id: swarm.unit_id, failed_attempt_id: swarm.failed_attempt_id, candidate_id: swarm.candidate_id,
      source_capsule_id: swarm.source_capsule_id, source_manifest: Object.freeze([...swarm.source_paths]),
      deadline_ms: swarm.deadline_ms, access: "read_only" });
  }

  async prepare(request: FailureSwarmRequest, lanes: readonly FailureSwarmLane[]) {
    inspectExecutionPlan(this.plan, this.fabric);
    if (!Number.isSafeInteger(request.max_lanes) || request.max_lanes < 1 || request.max_lanes > LUNA_FABRIC_MAX_ACTIVE ||
      !(request.per_lane_budget_charge?.model_attempts >= 1) ||
      !Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 1 || request.timeout_ms > 2 ** 31 - 1 ||
      !request.causal_classes.every((value) => /^[a-z][a-z0-9-]{0,63}$/u.test(value))) throw new Error("diagnosis-request-invalid");
    const { records, state } = await this.ledger.read();
    if (state.run_id !== request.run_id || state.current_candidate_id === null ||
      !state.plan_decisions.some((entry) => entry.plan_id === this.plan.plan_id && entry.decision === "accepted")) throw new Error("diagnosis-run-mismatch");
    const unit = this.fabric.units.find((entry) => entry.unit_id === request.unit_id);
    if (unit === undefined) throw new Error("diagnosis-unit-unknown");
    const fingerprint = diagnosisContractHash({ ...request, causal_classes: [...request.causal_classes].sort(), plan: this.plan.binding_id, owner: this.ownerRoot });
    const previous = state.diagnoses.find((entry) => entry.failed_attempt_id === request.attempt_id);
    if (previous !== undefined) {
      if (previous.owner_root !== this.ownerRoot || previous.request_fingerprint !== fingerprint) throw new Error("diagnosis-request-drift");
      return { status: "prepared" as const, swarm: previous, replay: true };
    }
    const reversed = [...records].reverse().map(({ event }) => event);
    const started = reversed.find((event) => event.kind === "attempt.started" && event.unit_id === request.unit_id);
    const finished = reversed.find((event) => event.kind === "attempt.finished" && event.attempt_id === request.attempt_id);
    const validation = reversed.find((event) => event.kind === "validation.recorded" && event.unit_id === request.unit_id);
    const reserved = state.diagnoses.reduce((count, entry) => count + entry.lanes.filter((lane) => !Object.hasOwn(entry.findings, lane.lane_id)).length, 0);
    const available = new Set(lanes.filter((lane) => lane.available && lane.access === "read_only")
      .map((lane) => lane.lane_id).sort().slice(0, Math.max(0, LUNA_FABRIC_MAX_ACTIVE - reserved)));
    const outcome = planFailureSwarm({ identity: { run_id: request.run_id, unit_id: request.unit_id,
      attempt_id: request.attempt_id, candidate_id: state.current_candidate_id },
      remediation_status: started?.kind === "attempt.started" && started.attempt_id === request.attempt_id &&
        started.budget_charge.kind === "normal_remediation" && finished !== undefined ? "completed" : "pending",
      canonical_result: validation?.kind === "validation.recorded" ? validation.result : "not_run", cause: request.cause,
      origin: started?.kind === "attempt.started" && started.budget_charge.kind === "read_only_diagnosis" ? "read_only_diagnosis" : "implementation",
      prior_diagnosis_attempts: [], causal_classes: request.causal_classes, lanes: lanes.map((lane) => ({ ...lane, available: lane.available && available.has(lane.lane_id) })), max_lanes: request.max_lanes,
      per_lane_budget_charge: request.per_lane_budget_charge, budget_limits: state.budget_limits, budget_consumed: state.budget_consumed });
    if (outcome.status !== "planned") return outcome;
    const source = await this.store.lookup({ capsule_id: request.source_capsule_id,
      declared_capsule_ids: [request.source_capsule_id], authorized_source_paths: [...unit.scope_read, ...unit.scope_write] });
    const paths = source.capsule.sources.map((entry) => entry.path);
    if (validation?.kind !== "validation.recorded" || !source.capsule.validations.some((entry) => entry.fingerprint === validation.command_fingerprint)) {
      throw new Error("diagnosis-canonical-evidence-missing");
    }
    await this.store.lookupFresh({ capsule_id: source.capsule_id, declared_capsule_ids: [source.capsule_id], authorized_source_paths: paths }, await this.currentSources(paths));
    const swarmID = diagnosisContractHash({ identity: outcome.plan.identity, request: fingerprint });
    await this.ledger.append({ kind: "diagnosis.opened", at: new Date().toISOString(), swarm_id: swarmID,
      request_fingerprint: fingerprint, owner_root: this.ownerRoot, unit_id: request.unit_id, failed_attempt_id: request.attempt_id,
      candidate_id: state.current_candidate_id, plan_id: this.plan.plan_id, plan_binding_id: this.plan.binding_id,
      source_capsule_id: source.capsule_id, source_paths: paths, deadline_ms: Date.now() + request.timeout_ms,
      lanes: outcome.plan.assignments.map((entry) => ({ ...entry, diagnosis_id: diagnosisContractHash({ swarmID, lane: entry.lane_id }) })),
      budget_charge: outcome.plan.budget_reservation.charge,
      ...(request.per_lane_resource_budget === undefined ? {} : { per_lane_resource_budget: request.per_lane_resource_budget }) });
    return { status: "prepared" as const, swarm: await this.get(swarmID), replay: false };
  }

  async claim(swarmID: string, laneID: string, callID: string): Promise<ReadOnlyDiagnosisDescriptor> {
    const swarm = await this.get(swarmID);
    if (swarm.selection !== null || Object.hasOwn(swarm.findings, laneID) || Date.now() >= swarm.deadline_ms) throw new Error("diagnosis-lane-inactive");
    await this.store.lookupFresh({ capsule_id: swarm.source_capsule_id, declared_capsule_ids: [swarm.source_capsule_id],
      authorized_source_paths: swarm.source_paths }, await this.currentSources(swarm.source_paths));
    await this.ledger.append({ kind: "diagnosis.dispatched", at: new Date().toISOString(), swarm_id: swarmID, lane_id: laneID, call_id: callID });
    const state = (await this.ledger.read()).state;
    return Object.freeze({ ...this.descriptor(swarm, laneID), run_id: state.run_id! });
  }

  async bindChild(descriptor: ReadOnlyDiagnosisDescriptor, callID: string, childID: string, runtime: ChildLifecycleRuntime) {
    const swarm = await this.get(descriptor.swarm_id);
    const expected = { ...this.descriptor(swarm, descriptor.lane_id), run_id: (await this.ledger.read()).state.run_id };
    if (diagnosisContractHash(expected) !== diagnosisContractHash(descriptor) || swarm.dispatched[descriptor.lane_id] !== callID) throw new Error("diagnosis-child-mismatch");
    return CancellableChildLifecycle.open({ identity: { run_id: descriptor.run_id, unit_id: descriptor.unit_id,
      attempt_id: descriptor.diagnosis_id, predecessor_attempt_id: descriptor.failed_attempt_id,
      candidate_id: descriptor.candidate_id, route_id: "read_only_diagnosis", child_id: childID, call_id: callID },
      deadline_ms: descriptor.deadline_ms }, this.ledger, runtime);
  }

  async finish(swarmID: string, laneID: string, value: unknown, observation: FlightObservation) {
    const swarm = await this.get(swarmID);
    const lane = swarm.lanes.find((entry) => entry.lane_id === laneID);
    if (lane === undefined) throw new Error("diagnosis-lane-unknown");
    let capsuleID: string | null = null;
    let verdict: "supported" | "excluded" | "unknown" = "unknown";
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const finding = value as Record<string, unknown>;
      if (Object.keys(finding).some((key) => !["causal_class", "verdict", "validation_fingerprints"].includes(key)) ||
        finding.causal_class !== lane.causal_class || !["supported", "excluded", "unknown"].includes(String(finding.verdict)) ||
        !Array.isArray(finding.validation_fingerprints) || finding.validation_fingerprints.length === 0) throw new Error("diagnosis-finding-invalid");
      const request = { capsule_id: swarm.source_capsule_id, declared_capsule_ids: [swarm.source_capsule_id], authorized_source_paths: swarm.source_paths };
      const source = Object.hasOwn(swarm.findings, laneID) ? await this.store.lookup(request)
        : await this.store.lookupFresh(request, await this.currentSources(swarm.source_paths));
      const references = finding.validation_fingerprints;
      if (new Set(references).size !== references.length || references.some((fingerprint) => !source.capsule.validations.some((entry) => entry.fingerprint === fingerprint))) {
        throw new Error("diagnosis-finding-evidence-invalid");
      }
      verdict = finding.verdict as typeof verdict;
      const saved = await this.store.put({ ...source.capsule, extractor_version: "failure-swarm-v1",
        risks: [{ kind: "correctness", severity: "medium", summary: `${lane.causal_class}: ${verdict}` }],
        validations: source.capsule.validations.filter((entry) => references.includes(entry.fingerprint)),
        provenance: { ...source.capsule.provenance, producer: "dog-luna-worker", revision: lane.diagnosis_id } }, swarm.source_paths);
      capsuleID = saved.capsule_id;
    } else if (value !== null) throw new Error("diagnosis-finding-invalid");
    if (Object.hasOwn(swarm.findings, laneID)) {
      const previous = swarm.findings[laneID]!;
      if (previous.capsule_id !== capsuleID || previous.verdict !== verdict) throw new Error("diagnosis-finding-conflict");
      return swarm;
    }
    await this.ledger.append({ kind: "diagnosis.finished", at: new Date().toISOString(), swarm_id: swarmID,
      lane_id: laneID, capsule_id: capsuleID, verdict, observation });
    return this.get(swarmID);
  }

  async select(swarmID: string, input: Omit<DiagnosisSelection, "contract_id">) {
    if (input === null || typeof input !== "object" || Object.keys(input).some((key) =>
      !["diagnosis_id", "capsule_id", "recovery_kind", "proposal", "budget_request"].includes(key))) throw new Error("diagnosis-selection-invalid");
    const swarm = await this.get(swarmID);
    const unit = this.fabric.units.find((entry) => entry.unit_id === swarm.unit_id)!;
    const budget = Object.freeze({ ...input.budget_request });
    const contract = Object.freeze({ plan_id: this.plan.plan_id, plan_binding_id: this.plan.binding_id, candidate_id: swarm.candidate_id,
      failed_attempt_id: swarm.failed_attempt_id, unit_id: swarm.unit_id, scope_read: Object.freeze([...unit.scope_read]), scope_write: Object.freeze([...unit.scope_write]),
      acceptance: Object.freeze([...unit.acceptance_items]), validation: Object.freeze({ ...unit.validation, command: Object.freeze([...unit.validation.command]) }),
      ...input, budget_request: budget });
    const selection: DiagnosisSelection = Object.freeze({ ...input, budget_request: budget, contract_id: diagnosisContractHash(contract) });
    if (swarm.selection !== null) {
      if (diagnosisContractHash(swarm.selection) !== diagnosisContractHash(selection)) throw new Error("diagnosis-selection-conflict");
      return { contract, selection, replay: true, executed_attempt_id: swarm.executed_attempt_id };
    }
    if (input.recovery_kind === ("read_only_diagnosis" as string)) throw new Error("recursive-diagnosis");
    const state = (await this.ledger.read()).state;
    const supported = swarm.lanes.filter((lane) => swarm.findings[lane.lane_id]?.verdict === "supported");
    const candidates = supported.map((lane) => ({ diagnosis_id: lane.diagnosis_id, capsule_id: swarm.findings[lane.lane_id]!.capsule_id!,
      recovery_kind: input.recovery_kind, proposal: input.proposal, budget_request: input.budget_request }));
    const selected = diagnoseFailure({ candidates, coordinator_selection: { diagnosis_id: input.diagnosis_id, capsule_id: input.capsule_id },
      budget_limits: state.budget_limits, budget_consumed: state.budget_consumed });
    if (selected.status !== "proposed") throw new Error(`diagnosis-selection-${selected.status}`);
    await this.store.lookupFresh({ capsule_id: input.capsule_id, declared_capsule_ids: [input.capsule_id],
      authorized_source_paths: swarm.source_paths }, await this.currentSources(swarm.source_paths));
    await this.ledger.append({ kind: "diagnosis.selected", at: new Date().toISOString(), swarm_id: swarmID, selection });
    return { contract, selection, replay: false, executed_attempt_id: null };
  }
}
