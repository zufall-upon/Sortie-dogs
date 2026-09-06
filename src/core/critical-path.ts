export type CriticalPathUnitState = "pending" | "active" | "completed" | "cancelled";
export type CriticalPathExecutor = "luna" | "other";
export type CriticalPathDeadlineObservation = "within_deadline" | "deadline_exceeded" | "unknown";
export type CriticalPathFailureObservation = "not_repeated" | "repeated" | "unknown";

export interface CriticalPathUnitObservation {
  readonly unit_id: string;
  readonly depends_on: readonly string[];
  readonly state: CriticalPathUnitState;
  readonly executor: CriticalPathExecutor;
  /** Caller-owned observation. This module never reads a clock or derives a duration. */
  readonly deadline: CriticalPathDeadlineObservation;
  /** Caller-owned observation. This module never reads or mutates an attempt ledger. */
  readonly failures: CriticalPathFailureObservation;
}

export interface CriticalPathInput {
  readonly units: readonly CriticalPathUnitObservation[];
  readonly active_takeover_count: number;
}

export type CriticalPathRejectionCode =
  | "invalid-input"
  | "invalid-state"
  | "duplicate-unit"
  | "unknown-dependency"
  | "cycle";

export type CriticalPathRuntimeObligation =
  | "accepted-base"
  | "same-contract"
  | "source-stopped"
  | "exclusive-writer"
  | "final-validation"
  | "final-review"
  | "candidate-cas";

export type CriticalPathResult =
  | { readonly status: "rejected"; readonly code: CriticalPathRejectionCode; readonly unit_id: string | null }
  | { readonly status: "none"; readonly reason: "active-takeover" | "no-conservative-blocker" }
  | {
    readonly status: "proposed";
    readonly unit_id: string;
    readonly reason: "deadline_exceeded" | "repeated_failure";
    readonly structural_basis: "sole-unfinished-direct-dependency-with-completion-reachability";
    readonly runtime_obligations: readonly CriticalPathRuntimeObligation[];
  };

const UNIT_STATES: readonly CriticalPathUnitState[] = ["pending", "active", "completed", "cancelled"];
const EXECUTORS: readonly CriticalPathExecutor[] = ["luna", "other"];
const DEADLINES: readonly CriticalPathDeadlineObservation[] = ["within_deadline", "deadline_exceeded", "unknown"];
const FAILURES: readonly CriticalPathFailureObservation[] = ["not_repeated", "repeated", "unknown"];
const RUNTIME_OBLIGATIONS: readonly CriticalPathRuntimeObligation[] = Object.freeze([
  "accepted-base",
  "same-contract",
  "source-stopped",
  "exclusive-writer",
  "final-validation",
  "final-review",
  "candidate-cas",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

function validUnitShape(value: unknown): value is CriticalPathUnitObservation {
  if (!record(value) || !ownKeys(value, ["unit_id", "depends_on", "state", "executor", "deadline", "failures"])) return false;
  return typeof value.unit_id === "string" && value.unit_id.length > 0 &&
    Array.isArray(value.depends_on) && value.depends_on.every((dependency) => typeof dependency === "string" && dependency.length > 0) &&
    UNIT_STATES.includes(value.state as CriticalPathUnitState) &&
    EXECUTORS.includes(value.executor as CriticalPathExecutor) &&
    DEADLINES.includes(value.deadline as CriticalPathDeadlineObservation) &&
    FAILURES.includes(value.failures as CriticalPathFailureObservation);
}

function reject(code: CriticalPathRejectionCode, unitId: string | null = null): CriticalPathResult {
  return { status: "rejected", code, unit_id: unitId };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Pure, conservative structural decision support. It does not estimate duration: a unit blocks only
 * when it is the sole unfinished direct dependency of a downstream node that can reach the virtual
 * completion sink. The sink depends on every DAG leaf, making the last unfinished leaf observable.
 * Runtime remains responsible for every obligation returned with a proposal.
 */
export function proposeCriticalPathTakeover(input: unknown): CriticalPathResult {
  if (!record(input) || !ownKeys(input, ["units", "active_takeover_count"]) || !Array.isArray(input.units)) {
    return reject("invalid-input");
  }
  if (!Number.isSafeInteger(input.active_takeover_count) || Number(input.active_takeover_count) < 0) {
    return reject("invalid-state");
  }
  if (Number(input.active_takeover_count) > 1) return reject("invalid-state");

  const units: CriticalPathUnitObservation[] = [];
  for (const value of input.units) {
    if (!validUnitShape(value)) return reject("invalid-state", record(value) && typeof value.unit_id === "string" ? value.unit_id : null);
    if (new Set(value.depends_on).size !== value.depends_on.length) return reject("invalid-state", value.unit_id);
    units.push(value);
  }

  const byId = new Map<string, CriticalPathUnitObservation>();
  for (const unit of units) {
    if (byId.has(unit.unit_id)) return reject("duplicate-unit", unit.unit_id);
    byId.set(unit.unit_id, unit);
  }
  for (const unit of units) {
    if (unit.depends_on.some((dependency) => !byId.has(dependency))) return reject("unknown-dependency", unit.unit_id);
  }
  const dependents = new Map<string, string[]>(units.map((unit) => [unit.unit_id, []]));
  const remainingDependencies = new Map(units.map((unit) => [unit.unit_id, unit.depends_on.length]));
  for (const unit of units) {
    for (const dependency of unit.depends_on) dependents.get(dependency)!.push(unit.unit_id);
  }
  const ready = units.filter((unit) => unit.depends_on.length === 0).map((unit) => unit.unit_id).sort(codeUnitCompare);
  let visited = 0;
  while (ready.length > 0) {
    const unitId = ready.shift()!;
    visited += 1;
    for (const dependent of dependents.get(unitId)!) {
      const next = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
    ready.sort(codeUnitCompare);
  }
  if (visited !== units.length) return reject("cycle");
  for (const unit of units) {
    if (unit.state === "active" && unit.depends_on.some((dependency) => byId.get(dependency)!.state !== "completed")) {
      return reject("invalid-state", unit.unit_id);
    }
  }

  // Graph validity takes precedence over suppression by an already active takeover.
  if (input.active_takeover_count === 1) return { status: "none", reason: "active-takeover" };

  const leaves = units.filter((unit) => dependents.get(unit.unit_id)!.length === 0).map((unit) => unit.unit_id);
  const virtualSink: unique symbol = Symbol("completion-sink");
  type CompletionNode = string | typeof virtualSink;
  const live = (unitId: string): boolean => {
    const state = byId.get(unitId)!.state;
    return state === "pending" || state === "active";
  };
  const completionDependents = new Map<string, readonly CompletionNode[]>(units.map((unit) => [
    unit.unit_id,
    [
      ...dependents.get(unit.unit_id)!.filter(live),
      ...(dependents.get(unit.unit_id)!.length === 0 && live(unit.unit_id) ? [virtualSink as CompletionNode] : []),
    ],
  ]));

  const reachesCompletion = (start: string): boolean => {
    const pending: CompletionNode[] = [start];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === virtualSink) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(completionDependents.get(current) ?? []));
    }
    return false;
  };

  const candidates = units.filter((unit) => {
    if (unit.state !== "active" || unit.executor !== "luna" ||
      (unit.deadline !== "deadline_exceeded" && unit.failures !== "repeated")) return false;
    return (completionDependents.get(unit.unit_id) ?? []).some((downstream) => {
      const dependencies = downstream === virtualSink ? leaves : byId.get(downstream)!.depends_on;
      if (dependencies.some((dependency) => byId.get(dependency)!.state === "cancelled")) return false;
      const liveDependencies = dependencies.filter(live);
      return liveDependencies.length === 1 && liveDependencies[0] === unit.unit_id &&
        (downstream === virtualSink || reachesCompletion(downstream));
    });
  }).sort((left, right) => codeUnitCompare(left.unit_id, right.unit_id));

  const selected = candidates[0];
  if (selected === undefined) return { status: "none", reason: "no-conservative-blocker" };
  return {
    status: "proposed",
    unit_id: selected.unit_id,
    reason: selected.deadline === "deadline_exceeded" ? "deadline_exceeded" : "repeated_failure",
    structural_basis: "sole-unfinished-direct-dependency-with-completion-reachability",
    runtime_obligations: RUNTIME_OBLIGATIONS,
  };
}
