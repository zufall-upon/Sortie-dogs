import { createHash } from "node:crypto";

import { normalizeWorktreeScopePath, worktreeScopesOverlap } from "./worktree-scope.js";

export const LUNA_FABRIC_CONTRACT_VERSION = "0.8.0";

export type LunaFabricExternalEffect =
  | "release"
  | "publish"
  | "tag"
  | "version"
  | "remote-state"
  | "credential"
  | "irreversible";

export interface LunaFabricProvenance {
  readonly source: "dog-coordinator";
  readonly acceptance_fingerprint: string;
  readonly target_branch: string;
  readonly target_sha: string;
}

export interface LunaFabricValidation {
  readonly level: "targeted" | "full";
  readonly command: readonly string[];
}

export interface LunaFabricUnit {
  readonly unit_id: string;
  readonly acceptance_items: readonly string[];
  readonly scope_read: readonly string[];
  readonly scope_write: readonly string[];
  readonly depends_on: readonly string[];
  readonly validation: LunaFabricValidation;
  readonly shared_path_keys: readonly string[];
  readonly exclusive_resources: readonly string[];
  readonly scheduler_order: number;
}

export interface LunaFabricSharedPath {
  readonly key: string;
  readonly path: string;
}

export interface LunaFabricContract {
  readonly version: typeof LUNA_FABRIC_CONTRACT_VERSION;
  readonly provenance: LunaFabricProvenance;
  readonly acceptance_items: readonly string[];
  readonly effects: readonly LunaFabricExternalEffect[];
  readonly shared_paths: readonly LunaFabricSharedPath[];
  readonly units: readonly LunaFabricUnit[];
}

export type LunaFabricSolReason =
  | "malformed-contract"
  | "external-effect"
  | "fewer-than-two-units"
  | "invalid-scope"
  | "dependency-invalid"
  | "acceptance-unowned"
  | "shared-path-unowned"
  | "exclusive-resource-conflict"
  | "no-safe-parallel-width";

export interface LunaFabricDiagnostic {
  readonly code: LunaFabricSolReason;
  readonly pointer: string;
  readonly detail: string;
}

export type LunaFabricAdmission =
  | {
      readonly route: "luna-fabric";
      readonly contract: LunaFabricContract;
      readonly contract_fingerprint: string;
      readonly width: number;
      readonly depth: number;
    }
  | {
      readonly route: "sol-serial";
      readonly reason: LunaFabricSolReason;
      readonly diagnostics: readonly LunaFabricDiagnostic[];
    };

const IDS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const EFFECTS = new Set<LunaFabricExternalEffect>([
  "release", "publish", "tag", "version", "remote-state", "credential", "irreversible",
]);
const MAX_UNITS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function stringList(value: unknown, maximum = 256): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((entry) => text(entry));
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function exactPath(value: unknown): value is string {
  if (!text(value)) return false;
  try {
    return normalizeWorktreeScopePath(value) === value;
  } catch {
    return false;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function contractFingerprint(contract: LunaFabricContract): string {
  return createHash("sha256").update(JSON.stringify(canonical(contract))).digest("hex");
}

function malformed(pointer: string, detail: string): LunaFabricAdmission {
  return {
    route: "sol-serial",
    reason: "malformed-contract",
    diagnostics: [{ code: "malformed-contract", pointer, detail }],
  };
}

function parseContract(value: unknown): LunaFabricContract | LunaFabricAdmission {
  if (!isRecord(value) || !exactKeys(value, [
    "acceptance_items", "effects", "provenance", "shared_paths", "units", "version",
  ])) return malformed("/", "contract shape must contain only the closed v0.8 fields");
  if (value.version !== LUNA_FABRIC_CONTRACT_VERSION) return malformed("/version", "unsupported version");
  if (!isRecord(value.provenance) || !exactKeys(value.provenance, [
    "acceptance_fingerprint", "source", "target_branch", "target_sha",
  ]) || value.provenance.source !== "dog-coordinator" ||
    typeof value.provenance.acceptance_fingerprint !== "string" ||
    !FINGERPRINT.test(value.provenance.acceptance_fingerprint) || !text(value.provenance.target_branch, 256) ||
    typeof value.provenance.target_sha !== "string" || !SHA.test(value.provenance.target_sha)) {
    return malformed("/provenance", "provenance must identify dog-coordinator, acceptance, and exact target");
  }
  if (!stringList(value.acceptance_items) || value.acceptance_items.length === 0 ||
    !unique(value.acceptance_items)) return malformed("/acceptance_items", "acceptance items must be unique");
  if (!Array.isArray(value.effects) || !unique(value.effects as string[]) ||
    value.effects.some((effect) => typeof effect !== "string" || !EFFECTS.has(effect as LunaFabricExternalEffect))) {
    return malformed("/effects", "effects must use known classifications");
  }
  if (!Array.isArray(value.shared_paths) || value.shared_paths.length > 256) {
    return malformed("/shared_paths", "shared path ownership must be bounded");
  }
  const sharedPaths: LunaFabricSharedPath[] = [];
  const sharedKeys = new Set<string>();
  const sharedPathIdentities = new Set<string>();
  for (let index = 0; index < value.shared_paths.length; index += 1) {
    const entry = value.shared_paths[index];
    if (isRecord(entry) && typeof entry.path === "string" && !exactPath(entry.path)) {
      return reject("invalid-scope", `/shared_paths/${index}/path`, "shared path must be normalized repository-relative");
    }
    if (!isRecord(entry) || !exactKeys(entry, ["key", "path"]) || !text(entry.key, 128) ||
      !IDS.test(entry.key) || !exactPath(entry.path) || sharedKeys.has(entry.key) ||
      sharedPathIdentities.has(entry.path.toLowerCase())) {
      return malformed(`/shared_paths/${index}`, "shared path key and exact path must be unique");
    }
    sharedKeys.add(entry.key);
    sharedPathIdentities.add(entry.path.toLowerCase());
    sharedPaths.push({ key: entry.key, path: entry.path });
  }
  if (!Array.isArray(value.units) || value.units.length === 0 || value.units.length > MAX_UNITS) {
    return malformed("/units", "unit count must be bounded");
  }
  const units: LunaFabricUnit[] = [];
  const unitIDs = new Set<string>();
  const schedulerOrders = new Set<number>();
  for (let index = 0; index < value.units.length; index += 1) {
    const unit = value.units[index];
    if (isRecord(unit)) {
      for (const field of ["scope_read", "scope_write"] as const) {
        if (Array.isArray(unit[field]) && unit[field].some((path) => typeof path === "string" && !exactPath(path))) {
          return reject("invalid-scope", `/units/${index}/${field}`, "scope must use normalized repository-relative paths");
        }
      }
    }
    if (!isRecord(unit) || !exactKeys(unit, [
      "acceptance_items", "depends_on", "exclusive_resources", "scheduler_order", "scope_read",
      "scope_write", "shared_path_keys", "unit_id", "validation",
    ]) || !text(unit.unit_id, 128) || !IDS.test(unit.unit_id) || unitIDs.has(unit.unit_id) ||
      !stringList(unit.acceptance_items) || unit.acceptance_items.length === 0 || !unique(unit.acceptance_items) ||
      !stringList(unit.depends_on, MAX_UNITS) || !unique(unit.depends_on) ||
      !stringList(unit.scope_read) || !unique(unit.scope_read) || !unit.scope_read.every(exactPath) ||
      !stringList(unit.scope_write) || unit.scope_write.length === 0 || !unique(unit.scope_write) ||
      !unit.scope_write.every(exactPath) || !stringList(unit.shared_path_keys) || !unique(unit.shared_path_keys) ||
      !unit.shared_path_keys.every((key) => sharedKeys.has(key)) || !stringList(unit.exclusive_resources, 64) ||
      !unique(unit.exclusive_resources) || !unit.exclusive_resources.every((resource) => IDS.test(resource)) ||
      !Number.isInteger(unit.scheduler_order) || (unit.scheduler_order as number) < 0 ||
      schedulerOrders.has(unit.scheduler_order as number) || !isRecord(unit.validation) ||
      !exactKeys(unit.validation, ["command", "level"]) ||
      (unit.validation.level !== "targeted" && unit.validation.level !== "full") ||
      !Array.isArray(unit.validation.command) || unit.validation.command.length === 0 ||
      unit.validation.command.length > 129 || !unit.validation.command.every((part) => text(part, 1000))) {
      return malformed(`/units/${index}`, "unit identity, scope, ownership, resources, and validation must be exact");
    }
    unitIDs.add(unit.unit_id);
    schedulerOrders.add(unit.scheduler_order as number);
    units.push({
      unit_id: unit.unit_id,
      acceptance_items: Object.freeze([...(unit.acceptance_items as string[])]),
      scope_read: Object.freeze([...(unit.scope_read as string[])]),
      scope_write: Object.freeze([...(unit.scope_write as string[])]),
      depends_on: Object.freeze([...(unit.depends_on as string[])]),
      validation: Object.freeze({
        level: unit.validation.level,
        command: Object.freeze([...(unit.validation.command as string[])]),
      }),
      shared_path_keys: Object.freeze([...(unit.shared_path_keys as string[])]),
      exclusive_resources: Object.freeze([...(unit.exclusive_resources as string[])]),
      scheduler_order: unit.scheduler_order as number,
    });
  }
  return Object.freeze({
    version: LUNA_FABRIC_CONTRACT_VERSION,
    provenance: Object.freeze(value.provenance as unknown as LunaFabricProvenance),
    acceptance_items: Object.freeze([...(value.acceptance_items as string[])]),
    effects: Object.freeze([...(value.effects as LunaFabricExternalEffect[])]),
    shared_paths: Object.freeze(sharedPaths.map((entry) => Object.freeze(entry))),
    units: Object.freeze(units.map((unit) => Object.freeze(unit))),
  });
}

function dependencyClosure(units: readonly LunaFabricUnit[]): Map<string, Set<string>> | undefined {
  const byID = new Map(units.map((unit) => [unit.unit_id, unit]));
  if (units.some((unit) => unit.depends_on.some((dependency) => dependency === unit.unit_id || !byID.has(dependency)))) {
    return undefined;
  }
  const closure = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (unitID: string): Set<string> | undefined => {
    if (visiting.has(unitID)) return undefined;
    const cached = closure.get(unitID);
    if (cached !== undefined) return cached;
    visiting.add(unitID);
    const result = new Set<string>();
    for (const dependency of byID.get(unitID)!.depends_on) {
      const nested = visit(dependency);
      if (nested === undefined) return undefined;
      result.add(dependency);
      for (const ancestor of nested) result.add(ancestor);
    }
    visiting.delete(unitID);
    closure.set(unitID, result);
    return result;
  };
  for (const unit of units) if (visit(unit.unit_id) === undefined) return undefined;
  return closure;
}

function writeRelatedOverlap(left: LunaFabricUnit, right: LunaFabricUnit): boolean {
  return left.scope_write.some((path) => [...right.scope_write, ...right.scope_read]
    .some((other) => worktreeScopesOverlap(path, other))) ||
    right.scope_write.some((path) => left.scope_read.some((other) => worktreeScopesOverlap(path, other)));
}

function sharedOwnerCovers(
  left: LunaFabricUnit,
  right: LunaFabricUnit,
  sharedPaths: readonly LunaFabricSharedPath[],
): boolean {
  const common = new Set(left.shared_path_keys.filter((key) => right.shared_path_keys.includes(key)));
  return sharedPaths.some((entry) => common.has(entry.key) &&
    [...left.scope_write, ...left.scope_read].some((path) => worktreeScopesOverlap(entry.path, path)) &&
    [...right.scope_write, ...right.scope_read].some((path) => worktreeScopesOverlap(entry.path, path)));
}

function incomparable(left: LunaFabricUnit, right: LunaFabricUnit, closure: Map<string, Set<string>>): boolean {
  return !closure.get(left.unit_id)!.has(right.unit_id) && !closure.get(right.unit_id)!.has(left.unit_id);
}

function maximumSafeWidth(
  units: readonly LunaFabricUnit[],
  closure: Map<string, Set<string>>,
): number {
  let maximum = 1;
  for (let leftIndex = 0; leftIndex < units.length; leftIndex += 1) {
    const selected = [units[leftIndex]!];
    for (let rightIndex = leftIndex + 1; rightIndex < units.length; rightIndex += 1) {
      const candidate = units[rightIndex]!;
      if (selected.every((existing) => incomparable(existing, candidate, closure) &&
        !writeRelatedOverlap(existing, candidate) &&
        !existing.exclusive_resources.some((resource) => candidate.exclusive_resources.includes(resource)))) {
        selected.push(candidate);
      }
    }
    maximum = Math.max(maximum, selected.length);
  }
  return maximum;
}

function dagDepth(units: readonly LunaFabricUnit[]): number {
  const byID = new Map(units.map((unit) => [unit.unit_id, unit]));
  const depths = new Map<string, number>();
  const depth = (unitID: string): number => {
    const cached = depths.get(unitID);
    if (cached !== undefined) return cached;
    const dependencies = byID.get(unitID)!.depends_on;
    const value = dependencies.length === 0 ? 1 : 1 + Math.max(...dependencies.map(depth));
    depths.set(unitID, value);
    return value;
  };
  return Math.max(...units.map((unit) => depth(unit.unit_id)));
}

function reject(reason: LunaFabricSolReason, pointer: string, detail: string): LunaFabricAdmission {
  return { route: "sol-serial", reason, diagnostics: [{ code: reason, pointer, detail }] };
}

/** Pure automatic route decision. Unknown or unsafe input always resolves to the stable Sol route. */
export function admitLunaFabric(value: unknown): LunaFabricAdmission {
  const parsed = parseContract(value);
  if ("route" in parsed) return parsed;
  if (parsed.effects.length > 0) return reject("external-effect", "/effects", parsed.effects.join(","));
  if (parsed.units.length < 2) return reject("fewer-than-two-units", "/units", "fabric needs useful width");
  const closure = dependencyClosure(parsed.units);
  if (closure === undefined) return reject("dependency-invalid", "/units", "dependency is unknown or cyclic");
  const accepted = new Map(parsed.acceptance_items.map((item) => [item, 0]));
  for (const unit of parsed.units) {
    for (const item of unit.acceptance_items) {
      if (!accepted.has(item)) return reject("acceptance-unowned", "/units", `unknown acceptance item: ${item}`);
      accepted.set(item, accepted.get(item)! + 1);
    }
  }
  const invalidAcceptance = [...accepted].find(([, count]) => count !== 1);
  if (invalidAcceptance !== undefined) {
    return reject("acceptance-unowned", "/acceptance_items", `${invalidAcceptance[0]} ownership=${invalidAcceptance[1]}`);
  }
  for (let leftIndex = 0; leftIndex < parsed.units.length; leftIndex += 1) {
    const left = parsed.units[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < parsed.units.length; rightIndex += 1) {
      const right = parsed.units[rightIndex]!;
      if (!incomparable(left, right, closure)) continue;
      if (writeRelatedOverlap(left, right) && !sharedOwnerCovers(left, right, parsed.shared_paths)) {
        return reject("shared-path-unowned", `/units/${rightIndex}/scope_write`, `${left.unit_id}:${right.unit_id}`);
      }
      const resource = left.exclusive_resources.find((entry) => right.exclusive_resources.includes(entry));
      if (resource !== undefined) {
        return reject("exclusive-resource-conflict", `/units/${rightIndex}/exclusive_resources`, resource);
      }
    }
  }
  const width = maximumSafeWidth(parsed.units, closure);
  if (width < 2) return reject("no-safe-parallel-width", "/units", "no independent disjoint pair");
  return Object.freeze({
    route: "luna-fabric",
    contract: parsed,
    contract_fingerprint: contractFingerprint(parsed),
    width,
    depth: dagDepth(parsed.units),
  });
}
