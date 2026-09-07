import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { summarizeExperienceEvidence, type ExperienceRunObservation } from "./experience-evidence-summary.js";
import {
  selectExperienceRoute,
  type ExperienceEvidenceIdentity,
  type ExperiencePolicyRow,
  type ExperienceRoute,
  type ExperienceRoutePolicyTable,
} from "./experience-route-policy.js";
import { admitLunaFabric, type LunaFabricAdmission, type LunaFabricContract } from "./luna-fabric-contract.js";
import { normalizeRelativePath } from "./path.js";
import {
  aggregateRecoveryOutcomes,
  type RecoveryOutcomeAttempt,
  type RecoveryOutcomeAggregateResult,
} from "./recovery-outcome-aggregate.js";
import {
  MAX_RUN_FLIGHT_EVENTS,
  RUN_FLIGHT_LEDGER_SCHEMA_VERSION,
  reconstructRunFlightLedger,
  type RunFlightEvent,
  type RunFlightEventRecord,
} from "./run-flight-ledger.js";

export const EXPERIENCE_ROUTING_INDEX_PATH = ".sortie-dogs/experience-routing.json";
export const EXPERIENCE_ROUTING_SCHEMA_VERSION = "0.8.5-experience-routing-v1";
export const EXPERIENCE_ROUTE_POLICY_VERSION = "experience-route-policy/v1";
export const EXPERIENCE_TASK_SHAPE_VERSION = "luna-contract-shape/v1";

const MAX_INDEX_BYTES = 512 * 1024;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_OBSERVATIONS = 32;
const MAX_AGGREGATE_ATTEMPTS = 256;
const ROUTES: readonly ExperienceRoute[] = ["sol-serial", "luna-fabric", "luna-fabric-with-escalation"];

export interface ExperienceTaskShape {
  readonly version: typeof EXPERIENCE_TASK_SHAPE_VERSION;
  readonly id: string;
  readonly characteristics: {
    readonly units: number;
    readonly width: number;
    readonly depth: number;
    readonly dependency_edges: number;
    readonly read_scopes: number;
    readonly write_scopes: number;
    readonly shared_paths: number;
    readonly exclusive_resources: number;
    readonly validation_levels: readonly ("full" | "targeted")[];
    readonly validation_commands_fingerprint: string;
  };
}

interface ExperienceIndexObservation {
  readonly run_id: string;
  readonly route: ExperienceRoute;
  readonly evidence_window: string;
  readonly identity: ExperienceEvidenceIdentity;
  readonly ledger_path: string;
  readonly ledger_tail_hash: string;
  readonly contract_path: string;
  readonly contract_fingerprint: string;
}

interface ExperienceRoutingIndex {
  readonly schema_version: typeof EXPERIENCE_ROUTING_SCHEMA_VERSION;
  readonly evidence_window: string;
  readonly rows: readonly ExperiencePolicyRow[];
  readonly observations: readonly ExperienceIndexObservation[];
}

export interface ExperienceAttemptAudit {
  readonly run_id: string;
  readonly unit_id: string;
  readonly attempt_id: string;
  readonly disposition: string;
  readonly failure_category: string | null;
  readonly recovery_kind: string;
  readonly intervention_count: number;
  readonly terminal_rescue_eligibility: "eligible" | "not-eligible";
  readonly terminal_rescue_attempted: boolean;
  readonly selected_target: { readonly model: string; readonly variant: string | null };
  readonly actual_target: { readonly model: string | null; readonly variant: string | null };
}

export interface ExperienceRunAudit {
  readonly run_id: string;
  readonly route: ExperienceRoute;
  readonly ledger_ref: string;
  readonly contract_fingerprint: string;
  readonly ledger_tail_hash: string;
  readonly evidence_sequences: readonly number[];
  readonly accepted_completion: boolean;
  readonly wall_clock_duration_ms: number | null;
  readonly total_cost_per_accepted_completion: number | null;
  readonly cost_denominator: "accepted-completion";
  readonly intervention_count: number;
  readonly live_deadline_takeover_proven: boolean;
  readonly exclusion_reason: string | null;
  readonly attempts: readonly ExperienceAttemptAudit[];
}

export interface ExperienceRoutingTrace {
  readonly policy_version: typeof EXPERIENCE_ROUTE_POLICY_VERSION;
  readonly shape: ExperienceTaskShape | null;
  readonly evidence_window: string | null;
  readonly chosen_route: ExperienceRoute;
  readonly fallback_reason: string | null;
  readonly escalation_availability: "available" | "unproven-live-deadline-takeover" | "not-requested";
  readonly evidence_refs: readonly {
    readonly run_id: string;
    readonly ledger_ref: string;
    readonly ledger_tail_hash: string;
    readonly evidence_sequences: readonly number[];
    readonly exclusion_reason: string | null;
  }[];
  readonly aggregates: readonly {
    readonly route: ExperienceRoute;
    readonly recovery: RecoveryOutcomeAggregateResult;
    readonly runs: readonly ExperienceRunAudit[];
  }[];
  readonly decision_fingerprint: string;
}

export interface ExperienceRoutingDecision {
  readonly route: ExperienceRoute;
  /** Null preserves the pre-v0.8.5 Luna preparation/takeover behavior. */
  readonly escalation_enabled: boolean | null;
  readonly trace: ExperienceRoutingTrace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function route(value: unknown): value is ExperienceRoute {
  return typeof value === "string" && ROUTES.includes(value as ExperienceRoute);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function validIdentity(value: unknown): value is ExperienceEvidenceIdentity {
  return isRecord(value) && exact(value, ["package", "fixture", "validation", "cache", "price_basis", "denominator"]) &&
    text(value.package) && text(value.fixture) && text(value.validation) && text(value.cache) &&
    text(value.price_basis) && value.denominator === "accepted-completion";
}

function validRelativeControlPath(value: unknown, contract: boolean): value is string {
  if (!text(value)) return false;
  try {
    const normalized = normalizeRelativePath(value);
    return normalized === value && (contract
      ? normalized.startsWith(".sortie-dogs/experience-routing/contracts/")
      : normalized.startsWith(".sortie-dogs/")) && normalized.endsWith(".json");
  } catch {
    return false;
  }
}

function inspectIndex(value: unknown): ExperienceRoutingIndex | null {
  if (!isRecord(value) || !exact(value, ["schema_version", "evidence_window", "rows", "observations"]) ||
    value.schema_version !== EXPERIENCE_ROUTING_SCHEMA_VERSION || !text(value.evidence_window) ||
    !Array.isArray(value.rows) || !Array.isArray(value.observations) || value.observations.length > MAX_OBSERVATIONS) return null;
  for (const row of value.rows) {
    if (!isRecord(row) || !exact(row, ["shape", "baseline_route", "policy_route"]) || !text(row.shape) ||
      !route(row.baseline_route) || !route(row.policy_route)) return null;
  }
  for (const observation of value.observations) {
    if (!isRecord(observation) || !exact(observation, [
      "run_id", "route", "evidence_window", "identity", "ledger_path", "ledger_tail_hash",
      "contract_path", "contract_fingerprint",
    ]) || !text(observation.run_id) || !route(observation.route) || observation.evidence_window !== value.evidence_window ||
      !validIdentity(observation.identity) || !validRelativeControlPath(observation.ledger_path, false) ||
      !validRelativeControlPath(observation.contract_path, true) ||
      typeof observation.ledger_tail_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(observation.ledger_tail_hash) ||
      typeof observation.contract_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(observation.contract_fingerprint)) return null;
  }
  return value as unknown as ExperienceRoutingIndex;
}

async function boundedJson(path: string, maximum: number): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximum) throw new Error("experience-record-invalid");
  const source = await readFile(path, "utf8");
  return JSON.parse(source) as unknown;
}

export function deriveExperienceTaskShape(admission: LunaFabricAdmission): ExperienceTaskShape | null {
  if (admission.route !== "luna-fabric") return null;
  const contract = admission.contract;
  const characteristics: ExperienceTaskShape["characteristics"] = Object.freeze({
    units: contract.units.length,
    width: admission.width,
    depth: admission.depth,
    dependency_edges: contract.units.reduce((sum, unit) => sum + unit.depends_on.length, 0),
    read_scopes: contract.units.reduce((sum, unit) => sum + unit.scope_read.length, 0),
    write_scopes: contract.units.reduce((sum, unit) => sum + unit.scope_write.length, 0),
    shared_paths: contract.shared_paths.length,
    exclusive_resources: contract.units.reduce((sum, unit) => sum + unit.exclusive_resources.length, 0),
    validation_levels: Object.freeze([...new Set(contract.units.map((unit) => unit.validation.level))].sort()),
    validation_commands_fingerprint: fingerprint(contract.units.map((unit) => ({
      scheduler_order: unit.scheduler_order,
      command: unit.validation.command,
    }))),
  });
  return Object.freeze({
    version: EXPERIENCE_TASK_SHAPE_VERSION,
    id: `${EXPERIENCE_TASK_SHAPE_VERSION}:sha256:${fingerprint(characteristics)}`,
    characteristics,
  });
}

function ledgerDocument(value: unknown): readonly RunFlightEventRecord[] | null {
  if (!isRecord(value) || !exact(value, ["schema_version", "events"]) ||
    value.schema_version !== RUN_FLIGHT_LEDGER_SCHEMA_VERSION || !Array.isArray(value.events) ||
    value.events.length > MAX_RUN_FLIGHT_EVENTS) return null;
  try {
    reconstructRunFlightLedger(value.events as RunFlightEventRecord[]);
    return value.events as RunFlightEventRecord[];
  } catch {
    return null;
  }
}

function eventEntries<T extends RunFlightEvent["kind"]>(records: readonly RunFlightEventRecord[], kind: T) {
  return records.filter((record): record is RunFlightEventRecord & { event: Extract<RunFlightEvent, { kind: T }> } =>
    record.event.kind === kind);
}

function observedRouteMatches(records: readonly RunFlightEventRecord[], expected: ExperienceRoute): boolean {
  const selected = eventEntries(records, "route.selected").map(({ event }) => event.route_id);
  if (selected.length === 0) return false;
  if (expected === "sol-serial") return selected.every((value) => value === "sol-serial");
  if (expected === "luna-fabric") return selected.every((value) => value === "luna-fabric");
  return selected.includes("luna-fabric") && selected.includes("sol-serial");
}

/** Terminal model rescue is intentionally irrelevant to this proof. */
export function hasObservedLiveDeadlineTakeover(records: readonly RunFlightEventRecord[]): boolean {
  const deadline = records.find((record) => record.event.kind === "child.stop-requested" &&
    record.event.trigger === "deadline_expired");
  if (deadline === undefined) return false;
  const luna = records.find((record) => record.sequence < deadline.sequence && record.event.kind === "route.selected" &&
    record.event.route_id === "luna-fabric");
  const sol = records.find((record) => record.sequence > deadline.sequence && record.event.kind === "route.selected" &&
    record.event.route_id === "sol-serial");
  return luna !== undefined && sol !== undefined && !eventEntries(records, "attempt.started")
    .some(({ event }) => event.terminal_rescue_contract !== undefined && event.budget_charge.kind === "model_rescue");
}

function runAudit(
  entry: ExperienceIndexObservation,
  records: readonly RunFlightEventRecord[],
  shape: ExperienceTaskShape,
): { audit: ExperienceRunAudit; attempts: readonly RecoveryOutcomeAttempt[]; observation: ExperienceRunObservation | null } {
  const planned = eventEntries(records, "run.planned")[0];
  const completed = eventEntries(records, "run.completed").at(-1);
  const candidateCompleted = eventEntries(records, "candidate.completed").at(-1);
  const starts = eventEntries(records, "attempt.started");
  const finishes = new Map(eventEntries(records, "attempt.finished").map((record) => [record.event.attempt_id, record]));
  const recoveries = eventEntries(records, "recovery.recorded");
  const unitCompletion = new Map(eventEntries(records, "unit.completed").map(({ event }) => [event.unit_id, event.disposition]));
  const childTerminal = new Map(eventEntries(records, "child.terminal").map(({ event }) => [event.identity.attempt_id, event.disposition]));
  const validations = eventEntries(records, "validation.recorded");
  const liveTakeover = hasObservedLiveDeadlineTakeover(records);
  const accepted = completed?.event.disposition === "succeeded" && candidateCompleted !== undefined;
  const startTime = planned === undefined ? Number.NaN : Date.parse(planned.event.at);
  const endTime = completed === undefined ? Number.NaN : Date.parse(completed.event.at);
  const duration = Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime ? endTime - startTime : null;
  const costs = records.flatMap(({ event }) =>
    event.kind === "attempt.finished" || event.kind === "diagnosis.finished" || event.kind === "cleanup.completed"
      ? [event.observation.estimated_cost.usd] : []);
  const totalCost = costs.length > 0 && costs.every((cost) => cost !== null)
    ? costs.reduce((sum, cost) => sum + (cost as number), 0) : null;
  const failureCategories = eventEntries(records, "attempt.finished").map(({ event }) => event.failure?.category).filter(Boolean);
  const infrastructureFailure = failureCategories.find((category) =>
    category !== "implementation" && !(liveTakeover && category === "cancellation"));
  let exclusion: string | null = null;
  if (!accepted) exclusion = "completion-not-accepted";
  else if (duration === null) exclusion = "unknown-wall-clock";
  else if (totalCost === null) exclusion = "unknown-cost";
  else if (!observedRouteMatches(records, entry.route)) exclusion = "route-not-authoritative";
  else if (entry.route === "luna-fabric-with-escalation" && !liveTakeover) exclusion = "live-deadline-takeover-unproven";
  else if (infrastructureFailure !== undefined) exclusion = `infrastructure-exclusion:${infrastructureFailure}`;

  const aggregateAttempts: RecoveryOutcomeAttempt[] = [];
  const attemptAudit: ExperienceAttemptAudit[] = [];
  for (const start of starts) {
    const finish = finishes.get(start.event.attempt_id);
    if (finish === undefined) continue;
    const interventions = recoveries.filter(({ event }) => event.failed_attempt_id === start.event.attempt_id).length;
    const rescueSuccessor = starts.find(({ event }) => event.predecessor_attempt_id === start.event.attempt_id &&
      event.terminal_rescue_contract !== undefined);
    const validationFailed = validations.some((record) => record.sequence > finish.sequence &&
      record.event.unit_id === start.event.unit_id && record.event.result === "failed");
    const rescueEligible = start.event.budget_charge.kind === "normal_remediation" &&
      finish.event.failure?.category === "implementation" && finish.event.disposition === "failed" &&
      validationFailed && childTerminal.get(start.event.attempt_id) === "failed";
    aggregateAttempts.push({
      identity: { run_id: entry.run_id, unit_id: start.event.unit_id, attempt_id: start.event.attempt_id },
      task_shape: shape.id,
      recovery_kind: start.event.budget_charge.kind,
      disposition: finish.event.disposition,
      failure: finish.event.failure,
      accepted_completion: finish.event.disposition === "succeeded" && unitCompletion.get(start.event.unit_id) === "succeeded",
      intervention_count: interventions,
      observation: finish.event.observation,
      cost_price_basis: finish.event.observation.estimated_cost.usd === null ? null : entry.identity.price_basis,
      provenance: { ledger_ref: entry.ledger_path, event_sequence: finish.sequence },
    });
    attemptAudit.push(Object.freeze({
      run_id: entry.run_id,
      unit_id: start.event.unit_id,
      attempt_id: start.event.attempt_id,
      disposition: finish.event.disposition,
      failure_category: finish.event.failure?.category ?? null,
      recovery_kind: start.event.budget_charge.kind,
      intervention_count: interventions,
      terminal_rescue_eligibility: rescueEligible ? "eligible" : "not-eligible",
      terminal_rescue_attempted: rescueSuccessor !== undefined,
      selected_target: Object.freeze({ model: start.event.selected_model, variant: start.event.selected_variant }),
      actual_target: Object.freeze({ model: finish.event.observed_model, variant: finish.event.observed_variant }),
    }));
  }
  const evidenceSequences = Object.freeze([
    ...(planned === undefined ? [] : [planned.sequence]),
    ...starts.map(({ sequence }) => sequence),
    ...[...finishes.values()].map(({ sequence }) => sequence),
    ...(completed === undefined ? [] : [completed.sequence]),
  ].sort((left, right) => left - right));
  const audit = Object.freeze({
    run_id: entry.run_id,
    route: entry.route,
    ledger_ref: entry.ledger_path,
    contract_fingerprint: entry.contract_fingerprint,
    ledger_tail_hash: entry.ledger_tail_hash,
    evidence_sequences: evidenceSequences,
    accepted_completion: accepted,
    wall_clock_duration_ms: duration,
    total_cost_per_accepted_completion: accepted ? totalCost : null,
    cost_denominator: "accepted-completion" as const,
    intervention_count: attemptAudit.reduce((sum, attempt) => sum + attempt.intervention_count, 0),
    live_deadline_takeover_proven: liveTakeover,
    exclusion_reason: exclusion,
    attempts: Object.freeze(attemptAudit),
  });
  return {
    audit,
    attempts: Object.freeze(aggregateAttempts),
    observation: exclusion === null ? {
      run_id: entry.run_id,
      completed: true,
      shape: shape.id,
      route: entry.route,
      evidence_window: entry.evidence_window,
      identity: entry.identity,
      duration_ms: duration as number,
      estimated_cost_amount: totalCost as number,
    } : null,
  };
}

function makeDecision(
  shape: ExperienceTaskShape | null,
  chosenRoute: ExperienceRoute,
  fallbackReason: string | null,
  evidenceWindow: string | null,
  escalation: ExperienceRoutingTrace["escalation_availability"],
  aggregates: ExperienceRoutingTrace["aggregates"] = [],
): ExperienceRoutingDecision {
  const evidenceRefs = aggregates.flatMap(({ runs }) => runs.map((run) => ({
    run_id: run.run_id,
    ledger_ref: run.ledger_ref,
    ledger_tail_hash: run.ledger_tail_hash,
    evidence_sequences: run.evidence_sequences,
    exclusion_reason: run.exclusion_reason,
  })));
  const traceBase: Omit<ExperienceRoutingTrace, "decision_fingerprint"> = {
    policy_version: EXPERIENCE_ROUTE_POLICY_VERSION,
    shape,
    evidence_window: evidenceWindow,
    chosen_route: chosenRoute,
    fallback_reason: fallbackReason,
    escalation_availability: escalation,
    evidence_refs: Object.freeze(evidenceRefs),
    aggregates: Object.freeze(aggregates),
  };
  const trace = Object.freeze({ ...traceBase, decision_fingerprint: fingerprint(traceBase) });
  return Object.freeze({
    route: chosenRoute,
    escalation_enabled: fallbackReason === null && chosenRoute.startsWith("luna-fabric")
      ? chosenRoute === "luna-fabric-with-escalation" : null,
    trace,
  });
}

/**
 * Structural Luna admission is the first and immutable gate. The optional index binds fixed rows to
 * hash-chained ledgers; it contains no caller-provided duration or cost values and is never updated here.
 */
export async function resolveExperienceRouting(
  projectRoot: string,
  structuralAdmission: LunaFabricAdmission,
): Promise<ExperienceRoutingDecision> {
  if (structuralAdmission.route !== "luna-fabric") {
    return makeDecision(null, "sol-serial", `structural:${structuralAdmission.reason}`, null, "not-requested");
  }
  const shape = deriveExperienceTaskShape(structuralAdmission)!;
  let rawIndex: unknown;
  try {
    rawIndex = await boundedJson(join(projectRoot, EXPERIENCE_ROUTING_INDEX_PATH), MAX_INDEX_BYTES);
  } catch (error) {
    const reason = isRecord(error) && error.code === "ENOENT" ? "experience-index-absent" : "experience-index-unavailable";
    return makeDecision(shape, "luna-fabric", reason, null, "not-requested");
  }
  const index = inspectIndex(rawIndex);
  if (index === null) return makeDecision(shape, "luna-fabric", "experience-index-invalid", null, "not-requested");

  const runAudits: ExperienceRunAudit[] = [];
  const aggregateAttempts = new Map<ExperienceRoute, RecoveryOutcomeAttempt[]>();
  const observations: ExperienceRunObservation[] = [];
  for (const entry of index.observations) {
    let audit: ExperienceRunAudit | null = null;
    try {
      const historicalAdmission = admitLunaFabric(await boundedJson(join(projectRoot, entry.contract_path), MAX_INDEX_BYTES));
      const historicalShape = deriveExperienceTaskShape(historicalAdmission);
      if (historicalAdmission.route !== "luna-fabric" || historicalAdmission.contract_fingerprint !== entry.contract_fingerprint ||
        historicalShape?.id !== shape.id) throw new Error("contract-binding-mismatch");
      const records = ledgerDocument(await boundedJson(join(projectRoot, entry.ledger_path), MAX_LEDGER_BYTES));
      if (records === null || records.at(-1)?.event_hash !== entry.ledger_tail_hash) {
        throw new Error("ledger-binding-mismatch");
      }
      const planned = eventEntries(records, "run.planned")[0];
      if (planned?.event.run_id !== entry.run_id) throw new Error("run-binding-mismatch");
      const collected = runAudit(entry, records, shape);
      audit = collected.audit;
      runAudits.push(audit);
      aggregateAttempts.set(entry.route, [...(aggregateAttempts.get(entry.route) ?? []), ...collected.attempts]);
      if (collected.observation !== null) observations.push(collected.observation);
    } catch {
      audit = Object.freeze({
        run_id: entry.run_id, route: entry.route, ledger_ref: entry.ledger_path,
        contract_fingerprint: entry.contract_fingerprint, ledger_tail_hash: entry.ledger_tail_hash,
        evidence_sequences: Object.freeze([]), accepted_completion: false, wall_clock_duration_ms: null,
        total_cost_per_accepted_completion: null, cost_denominator: "accepted-completion",
        intervention_count: 0, live_deadline_takeover_proven: false,
        exclusion_reason: "authoritative-record-invalid", attempts: Object.freeze([]),
      });
      runAudits.push(audit);
    }
  }
  const aggregates = ROUTES.flatMap((candidateRoute) => {
    const runs = runAudits.filter((run) => run.route === candidateRoute);
    if (runs.length === 0) return [];
    const attempts = aggregateAttempts.get(candidateRoute) ?? [];
    const recovery = aggregateRecoveryOutcomes({ attempts, max_attempts: MAX_AGGREGATE_ATTEMPTS });
    return [Object.freeze({ route: candidateRoute, recovery, runs: Object.freeze(runs) })];
  });
  const summary = summarizeExperienceEvidence({ observations });
  const policy: ExperienceRoutePolicyTable = Object.freeze({
    version: EXPERIENCE_ROUTE_POLICY_VERSION,
    evidence_window: index.evidence_window,
    minimum_samples: 3,
    duration_threshold: 1,
    cost_threshold: 1,
    rows: index.rows,
  });
  const selection = selectExperienceRoute({
    shape: shape.id,
    caller_heuristic_route: "luna-fabric",
    policy,
    evidence: summary.status === "summarized" ? summary.evidence : [],
  });
  let selectedRoute = selection.route ?? "luna-fabric";
  let fallbackReason: string | null = selection.status === "proposed" ? null : selection.reason;
  let escalation: ExperienceRoutingTrace["escalation_availability"] = "not-requested";
  if (index.rows.find((row) => row.shape === shape.id)?.policy_route === "luna-fabric-with-escalation") {
    const proofRuns = runAudits.filter((run) => run.route === "luna-fabric-with-escalation" && run.exclusion_reason === null);
    if (proofRuns.length < policy.minimum_samples || proofRuns.some((run) => !run.live_deadline_takeover_proven)) {
      escalation = "unproven-live-deadline-takeover";
      if (selectedRoute === "luna-fabric-with-escalation") {
        selectedRoute = "luna-fabric";
        fallbackReason = "live-deadline-takeover-unproven";
      }
    } else escalation = "available";
  }
  return makeDecision(shape, selectedRoute, fallbackReason, index.evidence_window, escalation, aggregates);
}

export function experienceContractFingerprint(contract: LunaFabricContract): string {
  const admission = admitLunaFabric(contract);
  if (admission.route !== "luna-fabric") throw new Error("contract-not-admitted");
  return admission.contract_fingerprint;
}
