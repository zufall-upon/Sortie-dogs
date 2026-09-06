import { createHash } from "node:crypto";

import type { AcceptanceCompileResult, AcceptanceCoverageMapEntry } from "./acceptance-compiler.js";
import { admitLunaFabric, type LunaFabricContract } from "./luna-fabric-contract.js";

export const EXECUTION_PLAN_VERSION = "0.1" as const;

const HASH = /^sha256:[a-f0-9]{64}$/u;

export interface ExecutionPlan {
  readonly version: typeof EXECUTION_PLAN_VERSION;
  /** Acceptance Compiler identity; this is also the identity recorded by the run ledger. */
  readonly plan_id: string;
  readonly proposal_id: string;
  readonly acceptance_fingerprint: string;
  readonly fabric_fingerprint: string;
  readonly operation_manifest_fingerprint: string;
  readonly capsule_ids: readonly string[];
  readonly coverage_map: readonly AcceptanceCoverageMapEntry[];
  /** Canonical identity of the complete compiler, DAG, manifest, capsule, and coverage binding. */
  readonly binding_id: string;
}

export type ExecutionPlanErrorCode =
  | "invalid"
  | "compile-rejected"
  | "dag-rejected"
  | "identity-mismatch"
  | "coverage-mismatch";

export class ExecutionPlanError extends Error {
  readonly code: ExecutionPlanErrorCode;
  constructor(code: ExecutionPlanErrorCode, message: string) {
    super(message);
    this.name = "ExecutionPlanError";
    this.code = code;
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function cloneCoverage(entries: readonly AcceptanceCoverageMapEntry[]): readonly AcceptanceCoverageMapEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    acceptance_id: entry.acceptance_id,
    unit_id: entry.unit_id,
    validation_ids: Object.freeze([...entry.validation_ids]),
    references: Object.freeze({
      capsule_ids: Object.freeze([...entry.references.capsule_ids]),
      artifact_ids: Object.freeze([...entry.references.artifact_ids]),
    }),
  })));
}

function capsuleSet(coverage: readonly AcceptanceCoverageMapEntry[]): readonly string[] {
  return Object.freeze([...new Set(coverage.flatMap((entry) => entry.references.capsule_ids))].sort());
}

function bindingBody(plan: Omit<ExecutionPlan, "binding_id">): unknown {
  return plan;
}

function validateCoverage(coverage: readonly AcceptanceCoverageMapEntry[], contract: LunaFabricContract): void {
  const units = new Set(contract.units.map((unit) => unit.unit_id));
  const acceptance = new Set(contract.acceptance_items);
  const coveredUnits = new Set<string>();
  const coveredAcceptance = new Set<string>();
  for (const entry of coverage) {
    if (!units.has(entry.unit_id) || !acceptance.has(entry.acceptance_id) || coveredAcceptance.has(entry.acceptance_id)) {
      throw new ExecutionPlanError("coverage-mismatch", "Compiler coverage does not match Luna unit ownership.");
    }
    const owner = contract.units.find((unit) => unit.unit_id === entry.unit_id)!;
    if (!owner.acceptance_items.includes(entry.acceptance_id)) {
      throw new ExecutionPlanError("coverage-mismatch", "Acceptance coverage is assigned to a different Luna unit.");
    }
    coveredUnits.add(entry.unit_id);
    coveredAcceptance.add(entry.acceptance_id);
  }
  if (coveredUnits.size !== units.size || coveredAcceptance.size !== acceptance.size) {
    throw new ExecutionPlanError("coverage-mismatch", "Execution plan does not cover the complete Luna DAG.");
  }
}

/** Hash a coordinator-owned operation manifest without retaining its paths or command text in the plan. */
export function executionPlanManifestFingerprint(manifest: unknown): string {
  return identity(manifest);
}

/** Bind one accepted compiler result directly to the admitted v0.8 DAG without another worker contract. */
export function createExecutionPlan(
  result: AcceptanceCompileResult,
  fabricValue: unknown,
  operationManifestFingerprint: string,
): ExecutionPlan {
  if (result.status !== "accepted") throw new ExecutionPlanError("compile-rejected", "Rejected compiler output cannot be dispatched.");
  if (!HASH.test(operationManifestFingerprint)) throw new ExecutionPlanError("invalid", "Operation manifest fingerprint is invalid.");
  const admission = admitLunaFabric(fabricValue);
  if (admission.route !== "luna-fabric") throw new ExecutionPlanError("dag-rejected", "Only an admitted v0.8 Luna DAG can be bound.");
  if (result.acceptance_fingerprint === null || result.acceptance_fingerprint.slice(7) !== admission.contract.provenance.acceptance_fingerprint) {
    throw new ExecutionPlanError("identity-mismatch", "Compiler and Luna acceptance identities differ.");
  }
  validateCoverage(result.coverage_map, admission.contract);
  const coverageMap = cloneCoverage(result.coverage_map);
  const body: Omit<ExecutionPlan, "binding_id"> = Object.freeze({
    version: EXECUTION_PLAN_VERSION,
    plan_id: result.plan_id,
    proposal_id: result.proposal_id,
    acceptance_fingerprint: result.acceptance_fingerprint,
    fabric_fingerprint: `sha256:${admission.contract_fingerprint}`,
    operation_manifest_fingerprint: operationManifestFingerprint,
    capsule_ids: capsuleSet(coverageMap),
    coverage_map: coverageMap,
  });
  return Object.freeze({ ...body, binding_id: identity(bindingBody(body)) });
}

/** Parse and verify a persisted binding against the exact DAG supplied to prepareFabric. */
export function inspectExecutionPlan(value: unknown, fabricValue: unknown): ExecutionPlan {
  if (!object(value) || !only(value, ["version", "plan_id", "proposal_id", "acceptance_fingerprint", "fabric_fingerprint", "operation_manifest_fingerprint", "capsule_ids", "coverage_map", "binding_id"]) ||
    value.version !== EXECUTION_PLAN_VERSION || !HASH.test(String(value.plan_id)) || !HASH.test(String(value.proposal_id)) ||
    !HASH.test(String(value.acceptance_fingerprint)) || !HASH.test(String(value.fabric_fingerprint)) ||
    !HASH.test(String(value.operation_manifest_fingerprint)) || !HASH.test(String(value.binding_id)) ||
    !Array.isArray(value.capsule_ids) || !value.capsule_ids.every((entry) => typeof entry === "string" && HASH.test(entry)) ||
    new Set(value.capsule_ids).size !== value.capsule_ids.length || !Array.isArray(value.coverage_map)) {
    throw new ExecutionPlanError("invalid", "Execution plan does not match the closed binding schema.");
  }
  const coverage = value.coverage_map;
  if (!coverage.every((entry) => object(entry) && only(entry, ["acceptance_id", "unit_id", "validation_ids", "references"]) &&
    typeof entry.acceptance_id === "string" && typeof entry.unit_id === "string" && Array.isArray(entry.validation_ids) &&
    entry.validation_ids.every((id) => typeof id === "string") && object(entry.references) && only(entry.references, ["capsule_ids", "artifact_ids"]) &&
    Array.isArray(entry.references.capsule_ids) && entry.references.capsule_ids.every((id) => typeof id === "string" && HASH.test(id)) &&
    Array.isArray(entry.references.artifact_ids) && entry.references.artifact_ids.every((id) => typeof id === "string" && HASH.test(id)))) {
    throw new ExecutionPlanError("invalid", "Execution plan coverage is malformed.");
  }
  const admission = admitLunaFabric(fabricValue);
  if (admission.route !== "luna-fabric") throw new ExecutionPlanError("dag-rejected", "Bound Luna DAG is no longer admissible.");
  if (value.fabric_fingerprint !== `sha256:${admission.contract_fingerprint}` ||
    String(value.acceptance_fingerprint).slice(7) !== admission.contract.provenance.acceptance_fingerprint) {
    throw new ExecutionPlanError("identity-mismatch", "Persisted plan identity does not match the Luna DAG.");
  }
  const clonedCoverage = cloneCoverage(coverage as unknown as AcceptanceCoverageMapEntry[]);
  validateCoverage(clonedCoverage, admission.contract);
  const plan = {
    version: EXECUTION_PLAN_VERSION,
    plan_id: value.plan_id as string,
    proposal_id: value.proposal_id as string,
    acceptance_fingerprint: value.acceptance_fingerprint as string,
    fabric_fingerprint: value.fabric_fingerprint as string,
    operation_manifest_fingerprint: value.operation_manifest_fingerprint as string,
    capsule_ids: Object.freeze([...(value.capsule_ids as string[])]),
    coverage_map: clonedCoverage,
  } satisfies Omit<ExecutionPlan, "binding_id">;
  if (identity(bindingBody(plan)) !== value.binding_id ||
    JSON.stringify(plan.capsule_ids) !== JSON.stringify(capsuleSet(clonedCoverage))) {
    throw new ExecutionPlanError("identity-mismatch", "Execution plan binding or capsule set was modified.");
  }
  return Object.freeze({ ...plan, binding_id: value.binding_id as string });
}
