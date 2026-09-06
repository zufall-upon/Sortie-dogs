import { createHash } from "node:crypto";

import type { FlightReferenceSet } from "./run-flight-ledger.js";

export const ACCEPTANCE_COMPILER_VERSION = "0.1" as const;
export const MAX_ACCEPTANCE_COMPILE_ITEMS = 64;
export const MAX_ACCEPTANCE_COMPILE_GAPS = 128;

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_TEXT = 1000;

export interface AcceptanceCompileItem {
  readonly acceptance_id: string;
  readonly observable_criterion: string;
}

export interface AcceptanceCompileValidation {
  readonly validation_id: string;
  readonly unit_id: string;
  readonly command_fingerprint: string;
  readonly references: FlightReferenceSet;
}

export interface AcceptanceCompileCoverage {
  readonly acceptance_id: string;
  readonly unit_id: string;
  readonly validation_ids: readonly string[];
}

export interface AcceptanceCompileProposal {
  readonly version: typeof ACCEPTANCE_COMPILER_VERSION;
  readonly provenance: {
    readonly producer: "dog-coordinator";
    readonly acceptance_fingerprint: string;
    /** The capsule producer, not this compiler, is responsible for excluding secrets from capsule input. */
    readonly capsule_inputs_exclude_secrets: true;
  };
  /** Identifier boundary for later binding to LunaFabricUnit; scope/dependency data stays in the DAG contract. */
  readonly unit_ids: readonly string[];
  readonly declared_capsule_ids: readonly string[];
  readonly acceptance_items: readonly AcceptanceCompileItem[];
  readonly validations: readonly AcceptanceCompileValidation[];
  readonly coverage: readonly AcceptanceCompileCoverage[];
}

export type AcceptanceCompileGapCode =
  | "malformed_proposal"
  | "duplicate_acceptance_id"
  | "duplicate_unit_id"
  | "duplicate_validation_id"
  | "duplicate_coverage"
  | "unknown_acceptance_id"
  | "unknown_unit_id"
  | "unknown_validation_id"
  | "validation_unit_mismatch"
  | "undeclared_capsule"
  | "validation_evidence_missing"
  | "uncovered_acceptance";

export interface AcceptanceCompileGap {
  readonly code: AcceptanceCompileGapCode;
  readonly pointer: string;
  readonly acceptance_id: string | null;
  readonly unit_id: string | null;
  readonly validation_id: string | null;
}

export interface AcceptanceCoverageMapEntry {
  readonly acceptance_id: string;
  readonly unit_id: string;
  readonly validation_ids: readonly string[];
  readonly references: FlightReferenceSet;
}

interface CompileResultBase {
  readonly proposal_id: string;
  readonly acceptance_fingerprint: string | null;
}

export type AcceptanceCompileResult =
  | (CompileResultBase & {
      readonly status: "accepted";
      readonly plan_id: string;
      readonly coverage_map: readonly AcceptanceCoverageMapEntry[];
      readonly gaps: readonly AcceptanceCompileGap[];
    })
  | (CompileResultBase & {
      readonly status: "rejected";
      readonly plan_id: string;
      readonly coverage_map: readonly AcceptanceCoverageMapEntry[];
      readonly gaps: readonly AcceptanceCompileGap[];
    });

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/u.test(value);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function identity(value: unknown): string {
  let body: string;
  try { body = JSON.stringify(canonicalValue(value)); } catch { body = "unserializable"; }
  return `sha256:${createHash("sha256").update(body ?? "undefined").digest("hex")}`;
}

function freezeReferences(references: FlightReferenceSet): FlightReferenceSet {
  return Object.freeze({ capsule_ids: Object.freeze([...references.capsule_ids]), artifact_ids: Object.freeze([...references.artifact_ids]) });
}

function validReferences(value: unknown): value is FlightReferenceSet {
  return object(value) && only(value, ["capsule_ids", "artifact_ids"]) && Array.isArray(value.capsule_ids) && Array.isArray(value.artifact_ids) &&
    value.capsule_ids.length <= MAX_ACCEPTANCE_COMPILE_ITEMS && value.artifact_ids.length <= MAX_ACCEPTANCE_COMPILE_ITEMS &&
    value.capsule_ids.every(hash) && value.artifact_ids.every(hash) && new Set(value.capsule_ids).size === value.capsule_ids.length &&
    new Set(value.artifact_ids).size === value.artifact_ids.length;
}

function malformed(value: unknown): boolean {
  if (!object(value) || !only(value, ["version", "provenance", "unit_ids", "declared_capsule_ids", "acceptance_items", "validations", "coverage"]) || value.version !== ACCEPTANCE_COMPILER_VERSION ||
    !object(value.provenance) || !only(value.provenance, ["producer", "acceptance_fingerprint", "capsule_inputs_exclude_secrets"]) ||
    value.provenance.producer !== "dog-coordinator" || !hash(value.provenance.acceptance_fingerprint) || value.provenance.capsule_inputs_exclude_secrets !== true) return true;
  const { unit_ids: unitIds, declared_capsule_ids: capsuleIds, acceptance_items: items, validations, coverage } = value;
  if (![unitIds, capsuleIds, items, validations, coverage].every((entry) => Array.isArray(entry) && entry.length <= MAX_ACCEPTANCE_COMPILE_ITEMS) ||
    !Array.isArray(items) || !Array.isArray(unitIds) || !Array.isArray(capsuleIds) || !Array.isArray(validations) || !Array.isArray(coverage) || items.length === 0 || unitIds.length === 0) return true;
  if (!unitIds.every(id) || !capsuleIds.every(hash)) return true;
  if (!items.every((entry: unknown) => object(entry) && only(entry, ["acceptance_id", "observable_criterion"]) && id(entry.acceptance_id) && text(entry.observable_criterion))) return true;
  if (!validations.every((entry: unknown) => object(entry) && only(entry, ["validation_id", "unit_id", "command_fingerprint", "references"]) && id(entry.validation_id) && id(entry.unit_id) && hash(entry.command_fingerprint) && validReferences(entry.references))) return true;
  return !coverage.every((entry: unknown) => object(entry) && only(entry, ["acceptance_id", "unit_id", "validation_ids"]) && id(entry.acceptance_id) && id(entry.unit_id) &&
    Array.isArray(entry.validation_ids) && entry.validation_ids.length > 0 && entry.validation_ids.length <= MAX_ACCEPTANCE_COMPILE_ITEMS && entry.validation_ids.every(id));
}

function gap(code: AcceptanceCompileGapCode, pointer: string, acceptanceId: string | null = null, unitId: string | null = null, validationId: string | null = null): AcceptanceCompileGap {
  return Object.freeze({ code, pointer, acceptance_id: acceptanceId, unit_id: unitId, validation_id: validationId });
}

function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  return new Set(values.filter((value) => seen.has(value) || !seen.add(value)));
}

/** Deterministic schema/semantic compiler. It performs no natural-language inference, dispatch, or user interaction. */
export function compileAcceptanceCoverage(value: unknown): AcceptanceCompileResult {
  const proposalId = identity(value);
  if (malformed(value)) return Object.freeze({ status: "rejected", proposal_id: proposalId, plan_id: identity({ proposal_id: proposalId, status: "rejected", gaps: ["malformed_proposal"] }), acceptance_fingerprint: null, coverage_map: Object.freeze([]), gaps: Object.freeze([gap("malformed_proposal", "/")]) });
  const proposal = value as AcceptanceCompileProposal;
  const gaps: AcceptanceCompileGap[] = [];
  const itemIds = proposal.acceptance_items.map((entry) => entry.acceptance_id);
  const validationIds = proposal.validations.map((entry) => entry.validation_id);
  for (const duplicate of duplicates(itemIds)) gaps.push(gap("duplicate_acceptance_id", "/acceptance_items", duplicate));
  for (const duplicate of duplicates(proposal.unit_ids)) gaps.push(gap("duplicate_unit_id", "/unit_ids", null, duplicate));
  for (const duplicate of duplicates(validationIds)) gaps.push(gap("duplicate_validation_id", "/validations", null, null, duplicate));
  for (const duplicate of duplicates(proposal.coverage.map((entry) => entry.acceptance_id))) gaps.push(gap("duplicate_coverage", "/coverage", duplicate));
  const items = new Set(itemIds);
  const units = new Set(proposal.unit_ids);
  const declaredCapsules = new Set(proposal.declared_capsule_ids);
  const validations = new Map(proposal.validations.map((entry) => [entry.validation_id, entry]));
  proposal.validations.forEach((validation, index) => {
    if (!units.has(validation.unit_id)) gaps.push(gap("unknown_unit_id", `/validations/${index}/unit_id`, null, validation.unit_id, validation.validation_id));
    if (validation.references.capsule_ids.length + validation.references.artifact_ids.length === 0) gaps.push(gap("validation_evidence_missing", `/validations/${index}/references`, null, validation.unit_id, validation.validation_id));
    for (const capsuleId of validation.references.capsule_ids) if (!declaredCapsules.has(capsuleId)) gaps.push(gap("undeclared_capsule", `/validations/${index}/references/capsule_ids`, null, validation.unit_id, validation.validation_id));
  });
  proposal.coverage.forEach((entry, index) => {
    if (!items.has(entry.acceptance_id)) gaps.push(gap("unknown_acceptance_id", `/coverage/${index}/acceptance_id`, entry.acceptance_id, entry.unit_id));
    if (!units.has(entry.unit_id)) gaps.push(gap("unknown_unit_id", `/coverage/${index}/unit_id`, entry.acceptance_id, entry.unit_id));
    for (const validationId of entry.validation_ids) {
      const validation = validations.get(validationId);
      if (validation === undefined) gaps.push(gap("unknown_validation_id", `/coverage/${index}/validation_ids`, entry.acceptance_id, entry.unit_id, validationId));
      else if (validation.unit_id !== entry.unit_id) gaps.push(gap("validation_unit_mismatch", `/coverage/${index}/validation_ids`, entry.acceptance_id, entry.unit_id, validationId));
    }
  });
  const covered = new Set(proposal.coverage.map((entry) => entry.acceptance_id));
  proposal.acceptance_items.forEach((entry, index) => { if (!covered.has(entry.acceptance_id)) gaps.push(gap("uncovered_acceptance", `/acceptance_items/${index}`, entry.acceptance_id)); });
  const bounded = gaps.slice(0, MAX_ACCEPTANCE_COMPILE_GAPS);
  if (bounded.length > 0) {
    const frozenGaps = Object.freeze(bounded);
    return Object.freeze({ status: "rejected", proposal_id: proposalId, plan_id: identity({ proposal_id: proposalId, status: "rejected", gaps: frozenGaps }), acceptance_fingerprint: proposal.provenance.acceptance_fingerprint, coverage_map: Object.freeze([]), gaps: frozenGaps });
  }
  const coverageMap = proposal.acceptance_items.map((item) => {
    const coverage = proposal.coverage.find((entry) => entry.acceptance_id === item.acceptance_id)!;
    const references = coverage.validation_ids.reduce<FlightReferenceSet>((result, validationId) => {
      const source = validations.get(validationId)!.references;
      return { capsule_ids: [...new Set([...result.capsule_ids, ...source.capsule_ids])], artifact_ids: [...new Set([...result.artifact_ids, ...source.artifact_ids])] };
    }, { capsule_ids: [], artifact_ids: [] });
    return Object.freeze({ acceptance_id: item.acceptance_id, unit_id: coverage.unit_id, validation_ids: Object.freeze([...coverage.validation_ids]), references: freezeReferences(references) });
  });
  const planId = identity({ acceptance_fingerprint: proposal.provenance.acceptance_fingerprint, coverage_map: coverageMap });
  return Object.freeze({ status: "accepted", proposal_id: proposalId, plan_id: planId, acceptance_fingerprint: proposal.provenance.acceptance_fingerprint, coverage_map: Object.freeze(coverageMap), gaps: Object.freeze([]) });
}
