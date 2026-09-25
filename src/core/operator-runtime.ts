import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { acceptanceContinuityFingerprint, inspectAcceptanceContinuity, normalizeAcceptanceCriteria,
  ACCEPTANCE_CONTINUITY_EXTENSION, MAX_ACCEPTANCE_CONTINUITY_BYTES, MAX_ACCEPTANCE_CRITERIA } from "./acceptance-continuity.js";
import { expandGoalDeclaration, goalDeclarationDefaults, goalDeclarationFieldDiagnostics, hasGoalCommandAliasConflict } from "./goal-declaration-format.js";
import { normalizeManifestPath, normalizeRelativePath } from "./path.js";
import { CONTRACT_TEXT_LIMITS, validateHandoffSchema, validateOperationManifestSchema } from "./validate-schema.js";
import { validateManifest } from "./validate-manifest.js";
import { profileAgent, RUNTIME_PROFILES, type RuntimeProfile } from "./runtime-profile.js";
import type { GoalEvidence, GoalTerminalReceipt } from "./goal-bound.js";
import type { SerialDispatchSettlement } from "../plugin/runtime-bridge.js";
import { normalizeCommand } from "../plugin/gate.js";
import { ensureGitManagedStateExcluded } from "./git-managed-state.js";
import { operatorContractRepairFingerprint, type OperatorContractRepairFileIdentity } from "./operator-contract-repair.js";
import { classifyUnitResult } from "./unit-result-classification.js";
import { SOURCE_REVIEW_PHASES, SOURCE_REVIEW_RISK_TAGS } from "./consultation.js";

export const OPERATOR_LIMITS = Object.freeze({ units: 32, planBytes: 256 * 1024, packetBytes: 24 * 1024,
  remediationReserve: 32 });
export interface OperatorContractDiagnostic {
  readonly document: "approval" | "proposal" | "plan" | "handoff" | "manifest" | "controls";
  readonly pointer: string;
  readonly code: string;
  readonly rule: string;
  readonly repair_kind: "repair-field" | "repair-proof-mapping" | "retry-storage-after-cleanup";
  readonly length?: number;
  readonly limit?: number;
  readonly unit_index?: number;
  readonly repair_paths?: readonly string[];
  readonly expected?: string;
  readonly actual_type?: "array" | "boolean" | "integer" | "null" | "number" | "object" | "string" | "undefined";
}
export class OperatorContractError extends Error {
  readonly diagnostics: readonly OperatorContractDiagnostic[];
  readonly diagnostics_truncated: boolean;
  constructor(diagnostics: readonly OperatorContractDiagnostic[]) {
    super(diagnostics[0]?.code ?? "operator-contract-invalid");
    this.name = "OperatorContractError";
    this.diagnostics = diagnostics.slice(0, 16);
    this.diagnostics_truncated = diagnostics.length > this.diagnostics.length;
  }
}
export interface OperatorUnit {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly validation: readonly string[];
  readonly acceptance_indices: readonly number[];
}
export interface OperatorGitLifecycle {
  readonly branch_create: { readonly branch: string; readonly start_ref: string };
  readonly commit: { readonly message: string };
  readonly post_commit_validation: readonly string[];
  /**
   * Paths no unit may write during implementation, pre-approved for remediation only. A write union
   * has to be authored before any implementation or review exists, so a review finding whose fix sits
   * one file outside it otherwise strands a complete candidate on a user decision. The reserve makes
   * that margin explicit at approval time instead of leaving it to be predicted exactly.
   */
  readonly remediation_reserve?: readonly string[];
  /**
   * Exactly the paths the host itself named in a prior remediation write-scope rejection. It is not a
   * free-form expansion: the host rejects any entry it did not record, so the root can only consent to
   * the host's own list after returning the blocked decision to the user.
   */
  readonly remediation_scope_expansion?: readonly string[];
}
export interface OperatorPlan {
  readonly schema_version: "0.1";
  readonly acceptance: readonly string[];
  readonly acceptance_proof: readonly (readonly string[])[];
  readonly source_refs: readonly string[];
  readonly goal_declaration: Record<string, unknown>;
  readonly units: readonly OperatorUnit[];
  readonly git_lifecycle?: OperatorGitLifecycle;
}
export interface OperatorTask {
  readonly description: string;
  readonly subagent_type: string;
  readonly prompt: string;
  readonly task_id?: string;
}
export interface OperatorRepairValidationRetryBinding {
  readonly authority: "operator-repair-validation-retry";
  readonly operator_run_id: string;
  readonly unit_id: string;
  readonly operator_generation: number;
  readonly plan_hash: string;
  readonly control_hash: string;
  readonly operator_acceptance_fingerprint: string;
  readonly validation_commands: readonly string[];
  readonly repair_fingerprint: string;
}
export interface OperatorRepairValidationRetrySource {
  readonly taskID: string;
  readonly operatorRunID: string;
  readonly operatorUnitID: string;
  readonly childSessionID: string;
  readonly operatorAcceptanceFingerprint: string;
  readonly validationCommands: readonly string[];
  readonly repairFingerprint: string;
  readonly binding: OperatorRepairValidationRetryBinding;
}
const OPERATOR_TASK_REFERENCE = "SORTIE_OPERATOR_TASK_REF";
const OPERATOR_DELEGATE_TASK_REFERENCE = "SORTIE_OPERATOR_DELEGATE_REF";
const REPAIR_VALIDATION_STALE_PROOF_DECISION = "operator-contract-repair-validation-incomplete:operator-recovery-proof-unavailable-or-stale";
const PROCESS_REPLACEMENT_DECISION = "operator-process-remediation-replacement-required";
const ACCEPTANCE_REMEDIATION_DECISION = "operator-acceptance-remediation-required";
const REVIEW_REMEDIATION_DECISION = "operator-review-remediation-required";
export type OperatorProposal = { status: "prepared"; state: OperatorState } | {
  status: "invalid-plan"; draft_id: string; diagnostics: readonly OperatorContractDiagnostic[]; diagnostics_truncated: boolean;
};
type OperatorPhase = "prepared" | "running" | "awaiting-decision" | "awaiting-acceptance" | "completed" | "cancelled";
interface UnitState {
  readonly unit: OperatorUnit;
  readonly task: OperatorTask;
  readonly handoffPath: string;
  readonly manifestPath: string;
  hashes: readonly string[];
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  callID: string | null;
  childSessionID: string | null;
  evidence: readonly GoalEvidence[];
  resultClass: string | null;
  repairValidationAttempts: number;
  repairValidation: {
    readonly repair_fingerprint: string;
    readonly child_session_id: string;
    readonly commands: readonly string[];
    readonly removed_paths: readonly string[];
    candidate_fingerprint: string | null;
    next_index: number;
  } | null;
}
interface OperatorGitLifecycleState {
  readonly branch: string;
  readonly startRef: string;
  readonly startOID: string;
  readonly originalHead: string;
  readonly originalRef: string | null;
  readonly commitMessage: string;
  readonly writeUnion: readonly string[];
  /**
   * Approved for remediation replacements only. Never widens this run's own unit write enforcement.
   * Optional because states persisted before the reserve existed load without it.
   */
  readonly remediationReserve?: readonly string[];
  readonly postCommitValidation: readonly string[];
  committedHead: string | null;
  commitProvenance?: "host-created" | "existing-history" | "inherited-parent" | "uncommitted-baseline" | null;
  /** Uncommitted paths a prior unit left at this lifecycle's baseline, carried forward inside the declared write scope. */
  carriedPaths?: readonly string[];
}
interface OperatorContractRepairState {
  readonly code: "operator-git-change-outside-write-union";
  readonly unit_id: string;
  readonly diagnostics: readonly OperatorContractDiagnostic[];
  readonly diagnostics_truncated: boolean;
  readonly repair_generation: 0;
  readonly mode: "discard-transient" | "unavailable";
  readonly repair_fingerprint: string | null;
  readonly files: readonly OperatorContractRepairFileIdentity[];
  readonly remaining_validation: readonly string[];
}
export interface OperatorAcceptanceAnchor {
  readonly taskID: string;
  readonly handoffPath: string;
  readonly handoffHash: string;
}
export interface OperatorState {
  readonly schema_version: "0.1";
  readonly profile: string;
  readonly rootSessionID: string;
  readonly runID: string;
  readonly planHash: string;
  readonly acceptance: readonly string[];
  readonly acceptanceProof: readonly (readonly string[])[];
  readonly acceptanceFingerprint: string;
  readonly sourceRefs: readonly string[];
  readonly createdAt: string;
  readonly parentRunID: string | null;
  /** Archived cancelled run replaced by a later user-authorized mission. */
  readonly supersededRunID?: string;
  readonly priorAcceptedUnits: readonly OperatorAcceptanceAnchor[];
  readonly remediationParent: {
    readonly taskID: string;
    readonly committedHead: string;
    readonly runID?: string;
    readonly acceptanceFingerprint?: string;
    readonly approvedWriteUnion?: readonly string[];
    readonly approvedRemediationReserve?: readonly string[];
    readonly commitMessage?: string;
    readonly commitProvenance?: "host-created" | "existing-history" | "inherited-parent" | "uncommitted-baseline";
  } | null;
  readonly gitLifecycle: OperatorGitLifecycleState | null;
  contractRepair: OperatorContractRepairState | null;
  /** Transient paths a cancelled active repair left behind; clearing them reopens replacement. */
  repairResidualPaths: readonly string[];
  /**
   * Paths this host refused on the most recent remediation write-scope rejection. It is the only list
   * a later remediation_scope_expansion may name, so consent cannot widen beyond what was reported.
   */
  pendingScopeExpansion: readonly string[];
  /** Real user turn carrying host approval when pendingScopeExpansion was recorded. */
  pendingScopeExpansionApprovalTurnID?: string | null;
  repairGeneration: number;
  generation: number;
  sequence: number;
  phase: OperatorPhase;
  operatorCallID: string | null;
  operatorSessionID: string | null;
  dispatched: number;
  units: UnitState[];
  decision: string | null;
  receipt: GoalTerminalReceipt | null;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\r\n]/u.test(value);
export function operatorGitPathAuthorized(path: string, scopes: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const key = (value: string): string => platform === "win32" ? value.toLowerCase() : value;
  const candidate = key(path);
  return scopes.some(scope => candidate === key(scope) || candidate.startsWith(`${key(scope)}/`));
}
const contractError = (diagnostic: OperatorContractDiagnostic): never => { throw new OperatorContractError([diagnostic]); };
const planError = (pointer: string, code: string, rule: string, repair_kind: OperatorContractDiagnostic["repair_kind"] = "repair-field"): never =>
  contractError({ document: "plan", pointer, code, rule, repair_kind });
function rejectValidationAnnotation(command: string, pointer: string): void {
  // A bare multi-character label followed by ':' and whitespace is an instruction annotation,
  // not a supported executable validation. Do not interpret or strip it into a fake passing oracle.
  // This is deliberately not a shell parser or a claim of semantic proof; quoted commands, drive
  // paths, URLs in arguments, and shell syntax remain the executor's responsibility.
  if (/^\s*[A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*)*:(?:\s|$)/u.test(command)) {
    planError(pointer, "operator-validation-annotation-invalid", "executable-command-not-instruction-label");
  }
}
function strings(value: unknown, nonempty = false): value is string[] {
  return Array.isArray(value) && (!nonempty || value.length > 0) && value.every(text);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
/** A declared scope list: normalized repository-relative paths, no duplicates, bounded length. */
function scopePaths(value: unknown, limit: number): value is string[] {
  if (!strings(value, true) || value.length > limit) return false;
  const paths = value as string[];
  // normalizeRelativePath rejects traversal and absolute input by throwing; that is a failed scope
  // declaration here, not a runtime fault to propagate out of plan parsing.
  const normalized = (path: string): boolean => {
    try { return path === normalizeRelativePath(path); } catch { return false; }
  };
  return paths.every(normalized) && new Set(paths).size === paths.length;
}

export function parseOperatorPlan(value: unknown): OperatorPlan {
  if (!record(value) || !exactKeys(value, ["schema_version", "acceptance", "acceptance_proof", "source_refs", "goal_declaration", "units", "git_lifecycle"])) {
    return planError("/", "operator-plan-invalid", "operator-plan-fields");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > OPERATOR_LIMITS.planBytes) {
    return contractError({ document: "plan", pointer: "/", code: "operator-plan-too-large", rule: "maxBytes", repair_kind: "repair-field",
      length: Buffer.byteLength(JSON.stringify(value)), limit: OPERATOR_LIMITS.planBytes });
  }
  if (value.schema_version !== "0.1") return planError("/schema_version", "operator-plan-invalid", "schema-version");
  if (!strings(value.acceptance, true)) return planError("/acceptance", "operator-plan-invalid", "nonempty-string-array");
  if (value.acceptance.length > MAX_ACCEPTANCE_CRITERIA) {
    return contractError({ document: "plan", pointer: "/acceptance", code: "operator-plan-acceptance-too-many",
      rule: "bounded-accepted-criteria", repair_kind: "repair-field",
      length: value.acceptance.length, limit: MAX_ACCEPTANCE_CRITERIA });
  }
  if (!strings(value.source_refs, true)) return planError("/source_refs", "operator-plan-invalid", "nonempty-string-array");
  if (!record(value.goal_declaration)) return planError("/goal_declaration", "operator-plan-invalid", "goal-object");
  if (!Array.isArray(value.units) || !value.units.length || value.units.length > OPERATOR_LIMITS.units) {
    return planError("/units", "operator-plan-invalid", "bounded-nonempty-unit-array");
  }
  if (value.git_lifecycle !== undefined) {
    const lifecycle = value.git_lifecycle;
    if (!record(lifecycle) || !exactKeys(lifecycle, ["branch_create", "commit", "post_commit_validation",
          "remediation_reserve", "remediation_scope_expansion"]) ||
        !record(lifecycle.branch_create) || !exactKeys(lifecycle.branch_create, ["branch", "start_ref"]) ||
        !text(lifecycle.branch_create.branch) || !text(lifecycle.branch_create.start_ref) ||
        !record(lifecycle.commit) || !exactKeys(lifecycle.commit, ["message"]) || !text(lifecycle.commit.message) ||
        !strings(lifecycle.post_commit_validation, true) ||
        new Set((lifecycle.post_commit_validation as string[]).map(normalizeCommand)).size !== lifecycle.post_commit_validation.length ||
        (lifecycle.branch_create.branch as string).length > 200 || (lifecycle.branch_create.start_ref as string).length > 256 ||
        (lifecycle.commit.message as string).length > 512 || (lifecycle.branch_create.branch as string).startsWith("-") ||
        (lifecycle.branch_create.start_ref as string).startsWith("-")) {
      return planError("/git_lifecycle", "operator-git-lifecycle-invalid", "exact-typed-branch-create-and-commit");
    }
    for (const field of ["remediation_reserve", "remediation_scope_expansion"] as const) {
      if (lifecycle[field] !== undefined && !scopePaths(lifecycle[field], OPERATOR_LIMITS.remediationReserve)) {
        return planError(`/git_lifecycle/${field}`, "operator-git-remediation-scope-invalid",
          "bounded-unique-normalized-relative-paths");
      }
    }
    const declaredWrites = new Set((value.units as OperatorUnit[]).flatMap(unit => unit.write ?? []));
    // A reserve entry already inside the implementation write union is contract noise: it grants
    // nothing beyond the union and hides which paths the margin actually covers.
    const redundant = (lifecycle.remediation_reserve as string[] | undefined)
      ?.filter(path => operatorGitPathAuthorized(path, [...declaredWrites])) ?? [];
    if (redundant.length > 0) {
      return planError("/git_lifecycle/remediation_reserve", "operator-git-remediation-reserve-redundant",
        "reserve-paths-must-lie-outside-the-implementation-write-union");
    }
  }
  const declaration = value.goal_declaration;
  if (!Array.isArray(declaration.criteria) || !record(declaration.defaults ?? {})) return planError("/goal_declaration/criteria", "operator-goal-criteria-invalid", "goal-criteria-array");
  if (hasGoalCommandAliasConflict(declaration)) return planError("/goal_declaration", "operator-goal-command-alias-conflict", "unambiguous-validation-command");
  if (record(declaration.defaults) && hasGoalCommandAliasConflict(declaration.defaults)) return planError("/goal_declaration/defaults", "operator-goal-command-alias-conflict", "unambiguous-validation-command");
  const defaults = goalDeclarationDefaults(declaration);
  const proofCommands = new Map<string, string>();
  for (const raw of declaration.criteria) {
    if (!record(raw)) return planError(`/goal_declaration/criteria/${proofCommands.size}`, "operator-goal-criteria-invalid", "goal-criterion-object");
    if (hasGoalCommandAliasConflict(raw)) return contractError({ document: "plan", pointer: `/goal_declaration/criteria/${proofCommands.size}/goal_validation_command`,
      code: "operator-goal-command-alias-conflict", rule: "unambiguous-validation-command", repair_kind: "repair-proof-mapping",
      repair_paths: [`/goal_declaration/criteria/${proofCommands.size}/goal_validation_command`, `/goal_declaration/criteria/${proofCommands.size}/validation_command`] });
    const id = raw.goal_criterion_id ?? raw.criterion_id;
    const command = raw.goal_validation_command ?? raw.validation_command ?? defaults.goal_validation_command ?? defaults.validation_command;
    if (!text(id) || proofCommands.has(id)) return planError(`/goal_declaration/criteria/${proofCommands.size}`, "operator-goal-proof-id-required", "unique-proof-id");
    if (!text(command)) return contractError({ document: "plan", pointer: `/goal_declaration/criteria/${proofCommands.size}/goal_validation_command`,
      code: "operator-goal-command-required", rule: "declared-validation-command-for-criterion", repair_kind: "repair-proof-mapping",
      repair_paths: [`/goal_declaration/criteria/${proofCommands.size}/goal_validation_command`] });
    const commandOwner = raw.goal_validation_command != null || raw.validation_command != null ? raw
      : record(declaration.defaults) && (declaration.defaults.goal_validation_command != null || declaration.defaults.validation_command != null)
        ? declaration.defaults : declaration;
    const commandPrefix = commandOwner === raw ? `/goal_declaration/criteria/${proofCommands.size}`
      : commandOwner === declaration ? "/goal_declaration" : "/goal_declaration/defaults";
    rejectValidationAnnotation(command, `${commandPrefix}/${commandOwner.goal_validation_command != null ? "goal_validation_command" : "validation_command"}`);
    proofCommands.set(id, command);
  }
  if (!Array.isArray(value.acceptance_proof) || value.acceptance_proof.length !== value.acceptance.length ||
      value.acceptance_proof.some(ids => !strings(ids, true) || ids.some(id => !proofCommands.has(id)))) return planError("/acceptance_proof", "operator-acceptance-proof-incomplete", "explicit-proof-ids", "repair-proof-mapping");
  const ids = new Set<string>();
  const coverage = new Set<number>();
  const plannedProof = new Set<string>();
  const acceptanceCount = value.acceptance.length;
  const mappingDiagnostics: OperatorContractDiagnostic[] = [];
  for (const [unitIndex, unit] of value.units.entries()) {
    if (!record(unit) || !exactKeys(unit, ["id", "title", "objective", "read", "write", "validation", "acceptance_indices"]) ||
        !identifier(unit.id) || ids.has(unit.id) || !text(unit.title) || !text(unit.objective) ||
          !strings(unit.read) || !strings(unit.write, true) || !strings(unit.validation, true)) return planError(`/units/${unitIndex}`, "operator-unit-invalid", "operator-unit-shape");
    unit.validation.forEach((command, index) => rejectValidationAnnotation(command, `/units/${unitIndex}/validation/${index}`));
    ids.add(unit.id);
    if (!Array.isArray(unit.acceptance_indices) || unit.acceptance_indices.length === 0 ||
        unit.acceptance_indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= acceptanceCount ||
          !(value.acceptance_proof as string[][])[index]!.some(id => (unit.validation as string[]).includes(proofCommands.get(id)!)))) {
      const positions = Array.isArray(unit.acceptance_indices) && unit.acceptance_indices.length ? unit.acceptance_indices.flatMap((index, position) =>
        !Number.isSafeInteger(index) || index < 0 || index >= acceptanceCount ||
        !(value.acceptance_proof as string[][])[index]!.some(id => (unit.validation as string[]).includes(proofCommands.get(id)!)) ? [position] : []) : [0];
      for (const position of positions) {
        const assigned = Array.isArray(unit.acceptance_indices) ? unit.acceptance_indices[position] : undefined;
        const proofIDs = Number.isSafeInteger(assigned) ? (value.acceptance_proof as string[][])[assigned as number] ?? [] : [];
        const criterionRepairs = declaration.criteria.flatMap((raw, index) => record(raw) && proofIDs.includes(String(raw.goal_criterion_id ?? raw.criterion_id))
          ? [`/goal_declaration/criteria/${index}/${Object.hasOwn(raw, "validation_command") ? "validation_command" : "goal_validation_command"}`] : []);
        mappingDiagnostics.push({ document: "plan", pointer: `/units/${unitIndex}/acceptance_indices/${position}`, code: "operator-unit-coverage-invalid",
          rule: "assigned-criterion-requires-exact-proof-command", repair_kind: "repair-proof-mapping",
          repair_paths: [`/units/${unitIndex}/validation`, `/units/${unitIndex}/acceptance_indices`, ...criterionRepairs].slice(0, 8) });
      }
      continue;
    }
    unit.acceptance_indices.forEach(index => coverage.add(index as number));
    const unitProof = [...proofCommands].filter(([, command]) => (unit.validation as string[]).includes(command)).map(([id]) => id);
    if (unitProof.every(id => plannedProof.has(id))) return planError(`/units/${unitIndex}/validation`, "operator-unit-needs-new-goal-milestone", "unit-adds-new-proof", "repair-proof-mapping");
    unitProof.forEach(id => plannedProof.add(id));
    for (const field of ["read", "write"] as const) {
      for (const [pathIndex, name] of (unit[field] as string[]).entries()) {
        let valid = false;
        try { valid = normalizeRelativePath(name) === name; } catch { /* Return only a typed pointer, never the path value. */ }
        if (!valid) return planError(`/units/${unitIndex}/${field}/${pathIndex}`, "operator-scope-invalid", "repository-relative-scope");
      }
    }
    for (const name of unit.write) {
      if ([".git", ...Object.values(RUNTIME_PROFILES).map(profile => profile.stateDirectory)]
        .some(directory => name === directory || name.startsWith(`${directory}/`))) return planError(`/units/${unitIndex}/write`, "operator-control-write-forbidden", "control-write-forbidden");
    }
  }
  if (mappingDiagnostics.length) throw new OperatorContractError(mappingDiagnostics);
  if (coverage.size !== value.acceptance.length) return planError("/units", "operator-plan-drops-accepted-criterion", "all-acceptance-assigned", "repair-proof-mapping");
  const requiredProof = (value.acceptance_proof as string[][]).flat();
  if (requiredProof.some(id => !plannedProof.has(id)) || [...proofCommands.keys()].some(id => !requiredProof.includes(id))) {
    return planError("/acceptance_proof", "operator-plan-proof-coverage-incomplete", "all-proof-ids-planned", "repair-proof-mapping");
  }
  if (value.git_lifecycle !== undefined) {
    const lifecycle = value.git_lifecycle as unknown as OperatorGitLifecycle;
    const typedUnits = value.units as unknown as OperatorUnit[];
    const postCommit = lifecycle.post_commit_validation;
    const finalUnit = typedUnits.at(-1)!;
    const postIdentities = postCommit.map(normalizeCommand);
    const finalIdentities = finalUnit.validation.map(normalizeCommand);
    const proofIdentities = [...proofCommands.values()].map(normalizeCommand);
    const suffix = finalIdentities.slice(-postIdentities.length);
    if (JSON.stringify(suffix) !== JSON.stringify(postIdentities) ||
        postIdentities.some(command => !proofIdentities.includes(command)) ||
        typedUnits.slice(0, -1).some(unit => unit.validation.some(command => postIdentities.includes(normalizeCommand(command))))) {
      return planError("/git_lifecycle/post_commit_validation", "operator-git-post-commit-validation-invalid",
        "canonical-declared-goal-validations-must-be-exclusive-contiguous-final-unit-suffix", "repair-proof-mapping");
    }
  }
  const declarationDefects = goalDeclarationFieldDiagnostics(value.goal_declaration);
  if (declarationDefects.length) throw new OperatorContractError(declarationDefects.map(defect => ({
    document: "plan", pointer: defect.pointer, code: "operator-goal-field-invalid", rule: "declared-goal-field",
    repair_kind: "repair-field", repair_paths: [defect.pointer], expected: defect.expected,
  })));
  expandGoalDeclaration(value.goal_declaration);
  return { ...value, acceptance: normalizeAcceptanceCriteria(value.acceptance) } as unknown as OperatorPlan;
}

/** Root-owned durable queue. It never executes code, changes acceptance, or accepts a candidate. */
export class OperatorRuntime {
  private readonly states = new Map<string, OperatorState>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly transactions = new Map<string, Promise<unknown>>();
  readonly projectRoot: string;
  constructor(projectRoot: string, readonly profile: RuntimeProfile, private readonly gitPath = "git") {
    this.projectRoot = resolve(projectRoot);
  }
  private file(root: string): string {
    return join(this.projectRoot, this.profile.stateDirectory, "operators", `${hash(root)}.json`);
  }
  async read(root: string): Promise<OperatorState | undefined> {
    await this.writes.get(root);
    const cached = this.states.get(root);
    if (cached) return structuredClone(cached);
    let source: string;
    try { source = await readFile(this.file(root), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (Buffer.byteLength(source) > OPERATOR_LIMITS.planBytes * 4) throw new Error("operator-state-too-large");
    const parsed = JSON.parse(source) as OperatorState & { parentRunID?: unknown; priorAcceptedUnits?: unknown; remediationParent?: unknown; gitLifecycle?: unknown;
      contractRepair?: unknown; repairGeneration?: unknown; repairResidualPaths?: unknown };
    const repairGeneration = parsed.repairGeneration === undefined ? 0 : parsed.repairGeneration;
    const state = { ...parsed,
      repairResidualPaths: parsed.repairResidualPaths === undefined ? [] : parsed.repairResidualPaths,
      pendingScopeExpansion: parsed.pendingScopeExpansion === undefined ? [] : parsed.pendingScopeExpansion,
      parentRunID: parsed.parentRunID === undefined ? null : parsed.parentRunID,
      priorAcceptedUnits: parsed.priorAcceptedUnits === undefined ? [] : parsed.priorAcceptedUnits,
      remediationParent: parsed.remediationParent === undefined ? null : parsed.remediationParent,
      gitLifecycle: parsed.gitLifecycle === undefined ? null : parsed.gitLifecycle,
      contractRepair: parsed.contractRepair === undefined ? null : parsed.contractRepair,
      repairGeneration,
      units: Array.isArray(parsed.units) ? parsed.units.map(unit => {
        const repairValidation = unit.repairValidation === undefined || unit.repairValidation === null ? null : {
          ...unit.repairValidation,
          removed_paths: unit.repairValidation.removed_paths ?? [],
          candidate_fingerprint: unit.repairValidation.candidate_fingerprint ?? null,
        };
        return { ...unit, repairValidation };
      }) : parsed.units } as OperatorState;
    if (state.schema_version !== "0.1" || state.profile !== this.profile.id || state.rootSessionID !== root ||
        !identifier(state.runID) || !Array.isArray(state.units) || state.units.length > OPERATOR_LIMITS.units ||
        !strings(state.acceptance, true) || !Array.isArray(state.acceptanceProof) || state.acceptanceProof.length !== state.acceptance.length ||
        state.acceptanceProof.some(ids => !strings(ids, true)) || state.acceptanceFingerprint !== acceptanceContinuityFingerprint(state.acceptance) ||
         (state.parentRunID !== null && !identifier(state.parentRunID)) ||
         (state.supersededRunID !== undefined && !identifier(state.supersededRunID)) || !Array.isArray(state.priorAcceptedUnits) ||
        state.priorAcceptedUnits.some(anchor => !record(anchor) || !identifier(anchor.taskID) || typeof anchor.handoffPath !== "string" || !isAbsolute(anchor.handoffPath) ||
          typeof anchor.handoffHash !== "string" || !/^[a-f0-9]{64}$/u.test(anchor.handoffHash)) ||
        (state.remediationParent !== null && (!record(state.remediationParent) || !identifier(state.remediationParent.taskID) ||
          !/^[a-f0-9]{40,64}$/u.test(String(state.remediationParent.committedHead)) ||
          (state.remediationParent.runID !== undefined && !identifier(state.remediationParent.runID)) ||
          (state.remediationParent.acceptanceFingerprint !== undefined &&
            !/^sha256:[a-f0-9]{64}$/u.test(String(state.remediationParent.acceptanceFingerprint))) ||
          (state.remediationParent.approvedWriteUnion !== undefined && !strings(state.remediationParent.approvedWriteUnion, true)) ||
          (state.remediationParent.approvedRemediationReserve !== undefined &&
            !strings(state.remediationParent.approvedRemediationReserve)) ||
          (state.remediationParent.commitMessage !== undefined && !text(state.remediationParent.commitMessage)) ||
          (state.remediationParent.commitProvenance !== undefined &&
            !["host-created", "existing-history", "inherited-parent", "uncommitted-baseline"].includes(state.remediationParent.commitProvenance)))) ||
        !this.validGitLifecycleState(state.gitLifecycle) ||
        !Number.isSafeInteger(state.repairGeneration) || state.repairGeneration < 0 || state.repairGeneration > 1 ||
         !strings(state.repairResidualPaths) || state.repairResidualPaths.length > OPERATOR_LIMITS.units ||
         !strings(state.pendingScopeExpansion) || state.pendingScopeExpansion.length > OPERATOR_LIMITS.remediationReserve ||
         (state.pendingScopeExpansionApprovalTurnID !== undefined && state.pendingScopeExpansionApprovalTurnID !== null &&
           (typeof state.pendingScopeExpansionApprovalTurnID !== "string" || state.pendingScopeExpansionApprovalTurnID.length === 0 ||
             /[\r\n]/u.test(state.pendingScopeExpansionApprovalTurnID))) ||
         !this.validContractRepairState(state.contractRepair, state.units) || !state.units.every(unit =>
          Number.isSafeInteger(unit.repairValidationAttempts) && unit.repairValidationAttempts >= 0 && unit.repairValidationAttempts <= 2 &&
          this.validRepairValidationState(unit.repairValidation))) {
      throw new Error("operator-state-invalid");
    }
    this.states.set(root, state);
    return structuredClone(state);
  }
  private async save(state: OperatorState): Promise<void> {
    state.sequence++;
    const serialized = JSON.stringify(state);
    const previous = this.writes.get(state.rootSessionID) ?? Promise.resolve();
    const next = previous.then(async () => {
      const directory = join(this.projectRoot, this.profile.stateDirectory, "operators");
      await mkdir(directory, { recursive: true });
      const file = this.file(state.rootSessionID);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.writes.set(state.rootSessionID, next);
    try {
      await next;
      this.states.set(state.rootSessionID, structuredClone(state));
    } catch (error) {
      state.sequence--;
      throw error;
    } finally {
      if (this.writes.get(state.rootSessionID) === next) this.writes.delete(state.rootSessionID);
    }
  }
  private serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.transactions.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.transactions.set(root, next);
    return next;
  }
  private validGitLifecycleState(value: unknown): value is OperatorGitLifecycleState | null {
    return value === null || (record(value) && exactKeys(value, ["branch", "startRef", "startOID", "originalHead", "originalRef", "commitMessage", "writeUnion", "remediationReserve", "postCommitValidation", "committedHead", "commitProvenance", "carriedPaths"]) &&
      (value.carriedPaths === undefined || strings(value.carriedPaths)) &&
      (value.remediationReserve === undefined || strings(value.remediationReserve)) &&
      text(value.branch) && text(value.startRef) && /^[a-f0-9]{40,64}$/u.test(String(value.startOID)) &&
      /^[a-f0-9]{40,64}$/u.test(String(value.originalHead)) && (value.originalRef === null || text(value.originalRef)) &&
      text(value.commitMessage) && strings(value.writeUnion, true) && strings(value.postCommitValidation, true) &&
      (value.committedHead === null || /^[a-f0-9]{40,64}$/u.test(String(value.committedHead))) &&
      (value.commitProvenance === undefined || value.commitProvenance === null ||
        ["host-created", "existing-history", "inherited-parent", "uncommitted-baseline"].includes(String(value.commitProvenance))));
  }
  private validContractRepairState(value: unknown, units: readonly UnitState[]): value is OperatorContractRepairState | null {
    if (value === null) return true;
    if (!record(value) || !exactKeys(value, ["code", "unit_id", "diagnostics", "diagnostics_truncated", "repair_generation", "mode",
      "repair_fingerprint", "files", "remaining_validation"]) ||
        value.code !== "operator-git-change-outside-write-union" || !identifier(value.unit_id) ||
        !units.some(unit => unit.unit.id === value.unit_id) || typeof value.diagnostics_truncated !== "boolean" ||
        value.repair_generation !== 0 || !["discard-transient", "unavailable"].includes(String(value.mode)) ||
        !Array.isArray(value.files) || !strings(value.remaining_validation, true) ||
        (value.mode === "discard-transient") !== (typeof value.repair_fingerprint === "string") ||
        (value.mode === "discard-transient") !== (value.files.length > 0) ||
        !value.files.every(file => this.validRepairFileIdentity(file)) ||
        !Array.isArray(value.diagnostics) || value.diagnostics.length === 0 || value.diagnostics.length > 16) return false;
    return value.diagnostics.every(item => {
      if (!record(item) || !exactKeys(item, ["document", "pointer", "unit_index", "code", "rule", "repair_kind", "repair_paths", "expected"]) ||
          item.document !== "plan" || !/^\/units\/\d+\/write$/u.test(String(item.pointer)) ||
          !Number.isSafeInteger(item.unit_index) || item.code !== "operator-git-change-outside-write-union" ||
          item.rule !== "all-persistent-and-transient-outputs-declared-or-explicitly-cleaned-before-validation" ||
          item.repair_kind !== "repair-field" || !Array.isArray(item.repair_paths) || item.repair_paths.length !== 1 ||
          !/^(?:staged|unstaged|untracked)(?:\+(?:unstaged|untracked))*$/u.test(String(item.expected))) return false;
      try { return typeof item.repair_paths[0] === "string" && normalizeRelativePath(item.repair_paths[0]) === item.repair_paths[0]; }
      catch { return false; }
    });
  }
  private validRepairFileIdentity(value: unknown): value is OperatorContractRepairFileIdentity {
    return record(value) && exactKeys(value, ["path", "size", "sha256", "realpath", "baseline_absent", "head_absent", "index_absent",
      "patch_absent", "untracked", "regular_nonlink"]) && typeof value.path === "string" && typeof value.realpath === "string" &&
      typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 && /^[a-f0-9]{64}$/u.test(String(value.sha256)) &&
      value.baseline_absent === true && value.head_absent === true && value.index_absent === true && value.patch_absent === true &&
      value.untracked === true && value.regular_nonlink === true;
  }
  private validRepairValidationState(value: unknown): value is UnitState["repairValidation"] {
    return value === null || (record(value) && exactKeys(value, ["repair_fingerprint", "child_session_id", "commands", "removed_paths", "candidate_fingerprint", "next_index"]) &&
      /^sha256:[a-f0-9]{64}$/u.test(String(value.repair_fingerprint)) && identifier(value.child_session_id) && strings(value.commands, true) &&
      strings(value.removed_paths) && (value.candidate_fingerprint === null || /^sha256:[a-f0-9]{64}$/u.test(String(value.candidate_fingerprint))) &&
      typeof value.next_index === "number" && Number.isSafeInteger(value.next_index) && value.next_index >= 0 && value.next_index <= value.commands.length);
  }
  private async git(args: readonly string[], accepted: readonly number[] = [0], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; exit: number }> {
    try {
      const result = await promisify(execFile)(this.gitPath, [...args], { cwd: this.projectRoot, timeout: 30_000,
        windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8", ...(env === undefined ? {} : { env }) });
      return { stdout: result.stdout, exit: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string | Buffer };
      const exit = typeof failure.code === "number" ? failure.code : -1;
      if (accepted.includes(exit)) return { stdout: Buffer.isBuffer(failure.stdout) ? failure.stdout.toString("utf8") : failure.stdout ?? "", exit };
      throw new Error(`operator-git-command-failed:${args[0] ?? "unknown"}:${exit}`);
    }
  }
  /** Transients an abandoned repair left behind that still exist on disk. */
  private async remainingResidualRepairPaths(state: OperatorState): Promise<readonly string[]> {
    const present = await Promise.all(state.repairResidualPaths.map(async path => {
      const metadata = await lstat(resolve(this.projectRoot, path)).catch(() => null);
      return metadata === null ? null : path;
    }));
    return present.filter((path): path is string => path !== null);
  }
  private async cleanStatus(): Promise<boolean> {
    return (await this.git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout.length === 0;
  }
  /** Staged, unstaged, and untracked paths of the current worktree. */
  private async uncommittedPaths(): Promise<readonly string[]> {
    const staged = this.gitPaths((await this.git(["diff", "--cached", "--name-only", "--no-renames", "-z"])).stdout);
    const unstaged = this.gitPaths((await this.git(["diff", "--name-only", "--no-renames", "-z"])).stdout);
    const untracked = this.gitPaths((await this.git(["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
    return [...new Set([...staged, ...unstaged, ...untracked])].sort();
  }
  private async createGitLifecycle(plan: OperatorPlan, requiredStartOID?: string): Promise<OperatorGitLifecycleState | null> {
    if (!plan.git_lifecycle) return null;
    const request = plan.git_lifecycle, branch = request.branch_create.branch, startRef = request.branch_create.start_ref;
    const top = (await this.git(["rev-parse", "--show-toplevel"])).stdout.trim();
    if (resolve(top).toLowerCase() !== this.projectRoot.toLowerCase()) return contractError({ document: "controls", pointer: "/git_lifecycle",
      code: "operator-git-project-root-mismatch", rule: "exact-repository-root", repair_kind: "repair-field" });
    const branchCheck = await this.git(["check-ref-format", `refs/heads/${branch}`], [0, 1, 128]);
    if (branchCheck.exit !== 0) return contractError({ document: "plan", pointer: "/git_lifecycle/branch_create/branch",
      code: "operator-git-branch-invalid", rule: "valid-non-option-branch-ref", repair_kind: "repair-field",
      repair_paths: ["/git_lifecycle/branch_create/branch"] });
    const destination = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1]);
    if (destination.exit === 0) return contractError({ document: "controls", pointer: "/git_lifecycle/branch_create/branch",
      code: "operator-git-destination-exists", rule: "destination-must-not-exist", repair_kind: "repair-field",
      repair_paths: ["/git_lifecycle/branch_create/branch"] });
    const writeUnion = [...new Set(plan.units.flatMap(unit => unit.write))].sort();
    // A replacement may start where an interrupted unit stopped. Its unvalidated partial work is carried
    // forward only from the exact remediation baseline and only inside the replacement's declared writes.
    const carried = await this.uncommittedPaths();
    if (carried.length > 0) {
      const head = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      if (requiredStartOID === undefined || head !== requiredStartOID) {
        return contractError({ document: "controls", pointer: "/git_lifecycle", code: "operator-git-dirty-worktree",
          rule: "clean-before-branch-create", repair_kind: "repair-field", repair_paths: carried.slice(0, 32) });
      }
      const undeclared = carried.filter(path => !this.pathAuthorized(path, writeUnion));
      if (undeclared.length > 0) {
        return contractError({ document: "plan", pointer: "/units", code: "operator-git-carried-change-undeclared",
          rule: "replacement-must-declare-carried-uncommitted-paths", repair_kind: "repair-field",
          repair_paths: undeclared.slice(0, 32) });
      }
    }
    const start = await this.git(["rev-parse", "--verify", "--end-of-options", `${startRef}^{commit}`], [0, 1, 128]);
    const startOID = start.stdout.trim();
    if (start.exit !== 0 || !/^[a-f0-9]{40,64}$/u.test(startOID)) return contractError({ document: "controls",
      pointer: "/git_lifecycle/branch_create/start_ref", code: "operator-git-start-ref-missing",
      rule: "existing-commit-required", repair_kind: "repair-field", repair_paths: ["/git_lifecycle/branch_create/start_ref"] });
    if (requiredStartOID !== undefined && startOID !== requiredStartOID) return contractError({ document: "controls",
      pointer: "/git_lifecycle/branch_create/start_ref", code: "operator-acceptance-remediation-baseline-mismatch",
      rule: "replacement-must-start-from-failed-committed-candidate", repair_kind: "repair-field",
      repair_paths: ["/git_lifecycle/branch_create/start_ref"], expected: requiredStartOID });
    const originalHead = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const original = await this.git(["symbolic-ref", "--quiet", "HEAD"], [0, 1]);
    const state: OperatorGitLifecycleState = { branch, startRef, startOID, originalHead,
      originalRef: original.exit === 0 ? original.stdout.trim() : null, commitMessage: request.commit.message,
      writeUnion, remediationReserve: request.remediation_reserve ?? [],
      postCommitValidation: request.post_commit_validation.map(normalizeCommand),
      committedHead: null, commitProvenance: null, ...(carried.length === 0 ? {} : { carriedPaths: carried }) };
    try {
      await this.git(["switch", "--create", branch, startOID]);
      const actualRef = (await this.git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
      const actualHead = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      if (actualRef !== `refs/heads/${branch}` || actualHead !== startOID ||
          JSON.stringify(await this.uncommittedPaths()) !== JSON.stringify(carried)) {
        throw new Error("operator-git-branch-postcondition-failed");
      }
      return state;
    } catch (error) {
      await this.cleanupCreatedBranch(state).catch(() => { throw new Error("operator-git-branch-cleanup-refused"); });
      throw error;
    }
  }
  private async cleanupCreatedBranch(state: OperatorGitLifecycleState): Promise<void> {
    const currentRef = await this.git(["symbolic-ref", "--quiet", "HEAD"], [0, 1]);
    const currentHead = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (currentRef.exit !== 0 || currentRef.stdout.trim() !== `refs/heads/${state.branch}` || currentHead !== state.startOID ||
        JSON.stringify(await this.uncommittedPaths()) !== JSON.stringify(state.carriedPaths ?? [])) {
      throw new Error("operator-git-branch-cleanup-refused");
    }
    const noHooks = ["-c", "core.hooksPath=.git/sortie-dogs-empty-hooks"];
    if (state.originalRef !== null) await this.git([...noHooks, "switch", state.originalRef.slice("refs/heads/".length)]);
    else await this.git([...noHooks, "switch", "--detach", state.originalHead]);
    await this.git(["update-ref", "-d", `refs/heads/${state.branch}`, state.startOID]);
  }
  prepare(root: string, raw: unknown, scopeApprovalTurnID?: string): Promise<OperatorState> {
    return this.serial(root, () => this.prepareOnce(root, raw, scopeApprovalTurnID));
  }
  private draftFile(root: string): string { return `${this.file(root)}.draft.json`; }
  propose(root: string, raw: unknown, scopeApprovalTurnID?: string): Promise<OperatorProposal> {
    return this.serial(root, () => this.proposeOnce(root, raw, scopeApprovalTurnID));
  }
  private async proposeOnce(root: string, raw: unknown, scopeApprovalTurnID?: string): Promise<OperatorProposal> {
    try {
      const state = await this.prepareOnce(root, raw, scopeApprovalTurnID);
      await rm(this.draftFile(root), { force: true });
      return { status: "prepared", state };
    } catch (error) {
      if (!(error instanceof OperatorContractError)) throw error;
      const serialized = JSON.stringify(raw);
      if (Buffer.byteLength(serialized) > OPERATOR_LIMITS.planBytes) throw error;
      const id = hash(JSON.stringify([this.profile.id, root, raw]));
      const file = this.draftFile(root), temporary = `${file}.${randomUUID()}.tmp`;
      await mkdir(join(this.projectRoot, this.profile.stateDirectory, "operators"), { recursive: true });
      try {
        await writeFile(temporary, JSON.stringify({ profile: this.profile.id, root, id, plan: raw,
          diagnostics: error.diagnostics, diagnostics_truncated: error.diagnostics_truncated }), { flag: "wx", mode: 0o600 });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      return { status: "invalid-plan", draft_id: id, diagnostics: error.diagnostics, diagnostics_truncated: error.diagnostics_truncated };
    }
  }
  repair(root: string, draftID: string, patches: unknown): Promise<OperatorProposal> {
    return this.serial(root, async () => {
      const source = await readFile(this.draftFile(root), "utf8");
      if (Buffer.byteLength(source) > OPERATOR_LIMITS.planBytes * 2) throw new Error("operator-draft-too-large");
      const draft = JSON.parse(source);
      if (draft.profile !== this.profile.id || draft.root !== root || draft.id !== draftID ||
          draft.id !== hash(JSON.stringify([this.profile.id, root, draft.plan]))) throw new Error("operator-draft-stale");
      if (!Array.isArray(patches) || patches.length > 16 || !Array.isArray(draft.plan?.units)) throw new Error("operator-repair-invalid");
      const original = structuredClone(draft.plan);
      for (const patch of patches) {
        if (!record(patch) || !exactKeys(patch, ["op", "path", "value"]) || !["replace", "add"].includes(String(patch.op)) || typeof patch.path !== "string" || !Object.hasOwn(patch, "value")) {
          throw new Error("operator-repair-invalid");
        }
        const goalFieldPath = /^\/goal_declaration\/(delivery_intent|delivery_mode|usable_path_established|controlled_change|goal_acceptance_fingerprint)$/.test(patch.path) ||
          /^\/goal_declaration\/(?:defaults\/|criteria\/(?:0|[1-9]\d*)\/)?(?:goal_)?(?:target|entrypoint|workload|source|candidate|fixture|oracle_coverage|build_boundary|proof_scope|expected_outcome|source_binding|candidate_binding)$/.test(patch.path);
        if (goalFieldPath && Array.isArray(draft.diagnostics) && draft.diagnostics.some(
          (item: OperatorContractDiagnostic) => item.document === "plan" && item.pointer === patch.path && item.code === "operator-goal-field-invalid")) {
          // Only the exact invalid or missing field is editable; acceptance, valid declaration fields,
          // budgets and scope never become mutable just because another field was diagnosed.
          const keys = patch.path.slice(1).split("/");
          let owner = draft.plan;
          for (const key of keys.slice(0, -1)) owner = owner?.[key];
          const key = keys.at(-1)!;
          if (!record(owner) || (patch.op === "replace" && !Object.hasOwn(owner, key))) throw new Error("operator-repair-path-forbidden");
          owner[key] = patch.value;
          continue;
        }
        const readMatch = /^\/units\/(0|[1-9]\d*)\/read\/(0|[1-9]\d*)$/.exec(patch.path);
        if (readMatch) {
          const unitIndex = Number(readMatch[1]), pathIndex = Number(readMatch[2]);
          const diagnosed = Array.isArray(draft.diagnostics) && draft.diagnostics.some((item: OperatorContractDiagnostic) =>
            item.document === "plan" && item.pointer === patch.path && item.code === "operator-scope-invalid");
          if (patch.op !== "replace" || !diagnosed ||
              !await this.sameReadTarget(original.units[unitIndex]?.read?.[pathIndex], patch.value)) {
            throw new Error("operator-repair-path-forbidden");
          }
          draft.plan.units[unitIndex].read[pathIndex] = patch.value;
          continue;
        }
        if (patch.path === "/git_lifecycle/post_commit_validation") {
          const finalValidation = original.units.at(-1)?.validation;
          if (patch.op !== "replace" || !strings(patch.value, true) || !Array.isArray(finalValidation) ||
              patch.value.some(command => !finalValidation.map(normalizeCommand).includes(normalizeCommand(command)))) throw new Error("operator-repair-path-forbidden");
          draft.plan.git_lifecycle.post_commit_validation = patch.value;
          continue;
        }
        const lifecycleMatch = /^\/git_lifecycle\/(branch_create\/(branch|start_ref)|commit\/message)$/.exec(patch.path);
        if (lifecycleMatch) {
          if (patch.op !== "replace" || !text(patch.value) || !record(draft.plan.git_lifecycle)) throw new Error("operator-repair-path-forbidden");
          const branchCreate = draft.plan.git_lifecycle.branch_create;
          const commit = draft.plan.git_lifecycle.commit;
          if (lifecycleMatch[1] === "commit/message") {
            if (!record(commit) || !Object.hasOwn(commit, "message")) throw new Error("operator-repair-path-forbidden");
            commit.message = patch.value;
          } else {
            if (!record(branchCreate) || !lifecycleMatch[2] || !Object.hasOwn(branchCreate, lifecycleMatch[2])) throw new Error("operator-repair-path-forbidden");
            branchCreate[lifecycleMatch[2]] = patch.value;
          }
          continue;
        }
        const goalMatch = /^\/goal_declaration\/criteria\/(0|[1-9]\d*)\/(goal_validation_command|validation_command)$/.exec(patch.path);
        if (goalMatch) {
          const criterion = draft.plan.goal_declaration?.criteria?.[Number(goalMatch[1])];
          if (!record(criterion) || !text(patch.value)) throw new Error("operator-repair-path-forbidden");
          const other = goalMatch[2] === "goal_validation_command" ? "validation_command" : "goal_validation_command";
          if (Object.hasOwn(criterion, other) && criterion[other] !== patch.value) throw new Error("operator-repair-command-alias-conflict");
          const criterionID = criterion.goal_criterion_id ?? criterion.criterion_id;
          const authorized = original.units.some((unit: OperatorUnit) =>
            Array.isArray(unit.acceptance_indices) && Array.isArray(unit.validation) && unit.validation.includes(patch.value as string) &&
            unit.acceptance_indices.some(index => Array.isArray(original.acceptance_proof?.[index]) && original.acceptance_proof[index].includes(criterionID)));
          if (!authorized) throw new Error("operator-repair-command-not-declared-for-criterion");
          criterion[goalMatch[2]!] = patch.value;
          continue;
        }
        const match = /^\/units\/(0|[1-9]\d*)\/(validation|acceptance_indices|title|objective)$/.exec(patch.path);
        const unit = match && draft.plan.units[Number(match[1])];
        if (patch.op !== "replace" || !match || !record(unit) || !Object.hasOwn(unit, match[2]!)) throw new Error("operator-repair-path-forbidden");
        unit[match[2]!] = patch.value;
      }
      return this.proposeOnce(root, draft.plan);
    });
  }
  /** A diagnosed spelling repair may not add, widen, or redirect a read grant. */
  private async sameReadTarget(before: unknown, after: unknown): Promise<boolean> {
    if (!text(before) || !text(after)) return false;
    try {
      if (normalizeRelativePath(after) !== after) return false;
      const original = normalizeManifestPath(before);
      if (original.kind === "relative") return original.path === after;
      if (!isAbsolute(original.path)) return false;
      const [left, right] = await Promise.all([realpath(original.path), realpath(resolve(this.projectRoot, after))]);
      return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    } catch { return false; }
  }
  /** Mission authority is supplied only by the owning profile, never by a model-authored plan. */
  prepareMission(root: string, raw: unknown, dispatcher?: { sessionID: string; callID: string }, supersededRunID?: string,
    terminalChildren: readonly string[] = []): Promise<OperatorState> {
    return this.serial(root, () => this.prepareOnce(root, raw, undefined, { dispatcher, supersededRunID, terminalChildren }));
  }
  retireMissionRun(root: string): Promise<void> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      if (state.units.some(unit => unit.status === "running") || state.gitLifecycle !== null) throw new Error("mission-replan-worker-still-active");
      if (["cancelled", "completed"].includes(state.phase)) return;
      // Keep the old run and proof for inspection. Replanning does not erase failed checks or spend.
      await writeFile(`${this.file(root)}.${state.runID}.archive`, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      state.phase = "cancelled";
      state.decision = "mission-replan";
      await this.save(state);
    });
  }
  private async prepareOnce(root: string, raw: unknown, scopeApprovalTurnID?: string,
    mission?: { dispatcher?: { sessionID: string; callID: string }; supersededRunID?: string;
      terminalChildren?: readonly string[] }): Promise<OperatorState> {
    const previous = await this.read(root);
    let immutableReplacement = previous?.phase === "cancelled" &&
      [ACCEPTANCE_REMEDIATION_DECISION, REVIEW_REMEDIATION_DECISION].includes(previous.decision ?? "") && record(raw)
      ? { ...raw, acceptance: [...previous.acceptance], source_refs: [...previous.sourceRefs] }
      : raw;
    if (immutableReplacement !== raw && previous && record(immutableReplacement) && record(immutableReplacement.goal_declaration)) {
      // Remaining host capacity is not a fresh estimate. Replacements inherit the original
      // declaration so headroom is not compounded when a model copies public budget counters.
      await this.verifyContinuityControls(previous);
      const reference = /^goal_declaration_path: (.+)$/m.exec(previous.units[0]!.task.prompt)?.[1];
      if (!reference) throw new Error("operator-declaration-path-invalid");
      const priorDeclaration = JSON.parse(await readFile(reference, "utf8"));
      const declaration = { ...immutableReplacement.goal_declaration };
      for (const key of ["goal_budget_units", "goal_budget_time_ms", "goal_budget_cost_usd"]) {
        if (Object.hasOwn(priorDeclaration, key)) declaration[key] = priorDeclaration[key];
        else delete declaration[key];
      }
      immutableReplacement = { ...immutableReplacement, goal_declaration: declaration };
    }
    const plan = parseOperatorPlan(immutableReplacement);
    const validatedPlanHash = hash(JSON.stringify(plan));
    if (mission?.supersededRunID !== undefined && previous?.supersededRunID === mission.supersededRunID &&
        previous.planHash === validatedPlanHash && previous.phase !== "cancelled") return previous;
    const superseding = mission?.supersededRunID !== undefined && previous?.runID === mission.supersededRunID &&
      previous.phase === "cancelled";
    if (mission?.supersededRunID !== undefined && !superseding) throw new Error("mission-superseded-run-mismatch");
    const terminalChildren = mission?.terminalChildren ?? [];
    const cancelledChildren = previous?.units.flatMap(unit => unit.status === "cancelled" && unit.childSessionID !== null
      ? [unit.childSessionID] : []) ?? [];
    if (superseding && previous && (previous.decision !== "explicit-cancellation" || previous.gitLifecycle !== null ||
        previous.repairResidualPaths.length > 0 || previous.priorAcceptedUnits.length > 0 ||
        terminalChildren.length !== cancelledChildren.length || new Set(terminalChildren).size !== terminalChildren.length ||
        cancelledChildren.some(id => !terminalChildren.includes(id)) || previous.units.some(unit =>
          !["pending", "cancelled"].includes(unit.status) || unit.evidence.length > 0 || unit.resultClass !== null ||
          unit.repairValidation !== null || (unit.status === "pending" && (unit.callID !== null || unit.childSessionID !== null)) ||
          (unit.status === "cancelled" && (unit.childSessionID === null || unit.callID === null))))) {
      throw new Error("mission-superseded-run-has-work: reconcile prior workers and evidence before changing acceptance");
    }
    if (plan.git_lifecycle !== undefined) {
      await ensureGitManagedStateExcluded(this.projectRoot, this.profile, this.gitPath);
    }
    if (previous && !["completed", "cancelled"].includes(previous.phase)) {
      if (previous.planHash === validatedPlanHash) return previous;
      throw new Error("operator-active-contract-immutable");
    }
    // Cancellation stops execution, not the accepted user order. A replacement
    // plan must carry the original ordered criteria; only a completed root clears them.
    const parent = !superseding && previous?.phase === "cancelled" ? previous : undefined;
    if (parent?.decision === "operator-contract-repair-unavailable-after-cancel") {
      // The diagnosed transients, not the cancellation itself, block a replacement. Once they are
      // gone the same accepted order may proceed; while they remain the refusal names them exactly.
      const residual = await this.remainingResidualRepairPaths(parent);
      if (residual.length > 0) {
        return contractError({ document: "controls", pointer: "/contract_repair", code: "operator-contract-repair-required",
          rule: "cancelled-active-repair-is-terminal-and-preserves-the-candidate", repair_kind: "retry-storage-after-cleanup",
          repair_paths: residual });
      }
    }
    const acceptanceRemediation = parent?.decision === ACCEPTANCE_REMEDIATION_DECISION;
    const reviewRemediation = parent?.decision === REVIEW_REMEDIATION_DECISION;
    const remediationUnit = acceptanceRemediation
      ? parent.units.find(unit => unit.status === "failed" && ["acceptance", "process-defect"].includes(unit.resultClass ?? ""))
      : reviewRemediation ? [...parent.units].reverse().find(unit => unit.status === "succeeded") : undefined;
    const remediationTaskID = remediationUnit === undefined ? undefined : /^task_id: (.+)$/m.exec(remediationUnit.task.prompt)?.[1];
    const remediationHead = acceptanceRemediation || reviewRemediation
      ? parent.gitLifecycle?.committedHead ?? undefined : undefined;
    if (acceptanceRemediation || reviewRemediation) {
      if (!remediationUnit || !remediationTaskID || !remediationHead || plan.git_lifecycle === undefined) {
        return contractError({ document: "controls", pointer: "/git_lifecycle", code: "operator-acceptance-remediation-baseline-missing",
          rule: "failed-committed-candidate-required", repair_kind: "repair-field" });
      }
      if (plan.acceptance.length !== parent.acceptance.length ||
          parent.acceptance.some((criterion, index) => plan.acceptance[index] !== criterion)) {
        throw new Error("operator-acceptance-remediation-exact-acceptance-required");
      }
      if (plan.source_refs.length !== parent.sourceRefs.length ||
          parent.sourceRefs.some((source, index) => plan.source_refs[index] !== source)) {
        throw new Error("operator-acceptance-remediation-same-goal-required");
      }
      // The reserve was approved with the original contract; the expansion is a later consent limited
      // to paths this host already refused by name. Neither lets the replacement invent new scope.
      const reserve = parent.gitLifecycle!.remediationReserve ?? [];
      const expansion = this.authorizedScopeExpansion(parent, plan.git_lifecycle.remediation_scope_expansion, scopeApprovalTurnID);
      const approvedWrites = [...parent.gitLifecycle!.writeUnion, ...reserve, ...expansion];
      const replacementWrites = [...new Set(plan.units.flatMap(unit => unit.write))];
      const outside = replacementWrites.filter(path => !this.pathAuthorized(path, approvedWrites));
      if (outside.length > 0) {
        // Record exactly what was refused so the root can return a concrete decision to the user and,
        // once the user consents, replay the same paths as remediation_scope_expansion.
        await this.recordPendingScopeExpansion(parent, outside, scopeApprovalTurnID);
        return contractError({ document: "plan", pointer: "/units", code: "operator-acceptance-remediation-write-scope-invalid",
          rule: "replacement-writes-must-stay-within-approved-union", repair_kind: "repair-field",
          repair_paths: outside.slice(0, OPERATOR_LIMITS.remediationReserve) });
      }
    }
    if (parent && (plan.acceptance.length < parent.acceptance.length ||
      parent.acceptance.some((criterion, index) => plan.acceptance[index] !== criterion))) {
      throw new Error("operator-acceptance-carry-forward-required: preserve the previous ordered acceptance and append new requirements; cancellation does not reset acceptance");
    }
    const runID = `operator-${randomUUID()}`;
    const directory = join(this.projectRoot, this.profile.stateDirectory, "contracts");
    const declarationPath = join(directory, `${runID}.goal.json`);
    const declaration = JSON.stringify(plan.goal_declaration);
    const acceptanceFingerprint = acceptanceContinuityFingerprint(plan.acceptance);
    const accepted = parent === undefined ? [] : [...parent.priorAcceptedUnits,
      ...parent.units.filter(unit => unit.status === "succeeded").map(unit => ({
        taskID: unit.task.prompt.match(/^task_id: (.+)$/m)?.[1] ?? "",
        handoffPath: unit.handoffPath, handoffHash: unit.hashes[0]!,
      }))].filter(anchor => identifier(anchor.taskID));
    const priorAcceptedUnits = [...new Map(accepted.map(anchor => [anchor.taskID, anchor])).values()];
    const units: UnitState[] = [];
    const controls: Array<{ path: string; content: string }> = [{ path: declarationPath, content: declaration }];
    for (const [index, unit] of plan.units.entries()) {
      const taskID = `${runID}-${index + 1}`;
      const manifestPath = join(directory, `${taskID}.operation-manifest.json`);
      const manifestRelative = `${this.profile.stateDirectory}/contracts/${taskID}.operation-manifest.json`;
      const handoffPath = join(directory, `handoff.${taskID}.json`);
      const manifest = { version: "0.1.0", task_id: taskID, read: unit.read, write: unit.write, validation: unit.validation };
      const handoff = {
        version: "0.1.0", profile: "minimal", id: taskID, created_at: new Date().toISOString(),
        task: { title: unit.title, objective: unit.objective }, state: { done: [], next: [unit.title], blocked: [] }, risks: [],
        verification: unit.validation.map(check => ({ check, status: "not_run", exit_code: null, summary: "Execute in the admitted worker." })),
        ext: {
          "sortie-dogs/write-gate": { operation_manifest: manifestRelative, project_root: this.projectRoot },
          [ACCEPTANCE_CONTINUITY_EXTENSION]: { schema_version: "0.1", authority: "dispatch", task_id: taskID,
            criteria: plan.acceptance, fingerprint: acceptanceFingerprint,
            parent_fingerprint: index === 0
              ? priorAcceptedUnits.length === 0 ? "none" : parent?.acceptanceFingerprint ?? "none"
              : acceptanceFingerprint },
          "sortie-dogs/unit-coverage": { schema_version: "0.1", task_id: taskID,
            acceptance_fingerprint: acceptanceFingerprint, indices: unit.acceptance_indices },
        },
      };
      const h = validateHandoffSchema(handoff), m = validateOperationManifestSchema(manifest);
      const diagnostics: OperatorContractDiagnostic[] = [];
      function diagnostic(document: "handoff" | "manifest", item: { pointer: string; code: string }): OperatorContractDiagnostic {
        const lengths: Record<string, { value: string; limit: number }> = {
          "/task/title": { value: unit.title, limit: CONTRACT_TEXT_LIMITS.title },
          "/task/objective": { value: unit.objective, limit: CONTRACT_TEXT_LIMITS.objective },
          "/state/next/0": { value: unit.title, limit: CONTRACT_TEXT_LIMITS.statement },
        };
        unit.validation.forEach((value, i) => {
          lengths[`/verification/${i}/check`] = { value, limit: CONTRACT_TEXT_LIMITS.command };
          lengths[`/validation/${i}`] = { value, limit: CONTRACT_TEXT_LIMITS.command };
        });
        for (const field of ["read", "write"] as const) unit[field].forEach((value, i) => {
          lengths[`/${field}/${i}`] = { value, limit: CONTRACT_TEXT_LIMITS.path };
        });
        const size = item.code === "schema_maxLength" ? lengths[item.pointer] : undefined;
        return { document, pointer: item.pointer, unit_index: index, code: item.code,
          rule: item.code.replace(/^schema_/, ""), repair_kind: "repair-field",
          ...(size ? { length: Array.from(size.value).length, limit: size.limit } : {}) };
      }
      if (!h.ok) diagnostics.push(...h.diagnostics.map(item => diagnostic("handoff", item)));
      if (!m.ok) diagnostics.push(...m.diagnostics.map(item => diagnostic("manifest", item)));
      // The worker refuses a malformed or oversize continuity ledger before it reads any source, so the
      // generated ledger is inspected here instead of exposing that internal mismatch after dispatch.
      const continuity = inspectAcceptanceContinuity(handoff);
      if (continuity.error !== undefined) {
        diagnostics.push({ document: "handoff", pointer: "/ext/acceptance-continuity", unit_index: index,
          code: `operator-acceptance-continuity-${continuity.error}`, rule: "worker-readable-acceptance-ledger",
          repair_kind: "repair-field",
          ...(continuity.error === "oversize"
            ? { length: new TextEncoder().encode(JSON.stringify(handoff.ext[ACCEPTANCE_CONTINUITY_EXTENSION])).byteLength,
              limit: MAX_ACCEPTANCE_CONTINUITY_BYTES }
            : {}) });
      }
      if (h.ok && m.ok) diagnostics.push(...validateManifest(h.value, m.value, undefined, false, { requirePassedValidation: false })
        .filter(item => item.severity === "error").map(item => ({ document: "handoff" as const, pointer: item.pointer,
          code: item.code, rule: "handoff-manifest-consistency", repair_kind: "repair-field" as const })));
      if (diagnostics.length > 0) throw new OperatorContractError(diagnostics);
      const contents = [JSON.stringify(handoff), JSON.stringify(manifest)];
      controls.push({ path: handoffPath, content: contents[0]! }, { path: manifestPath, content: contents[1]! });
      const prompt = ["role: implementation", `task_id: ${taskID}`, `project_root: ${this.projectRoot}`,
        `source_manifest: ${unit.write.join(", ")}`, `operation_manifest: ${manifestRelative}`, `handoff_path: ${handoffPath}`,
        `goal_declaration_path: ${declarationPath}`, "acceptance:", ...plan.acceptance.map(value => `  - ${value}`),
        "validation:", ...unit.validation.map(value => `  - ${value}`),
        mission ? "Read-only investigation commands are unrestricted. Use shell to reproduce and diagnose without asking for command registration. Keep all writes, including generated/transient outputs and cleanup, inside unit.write. Run formal validation exactly as listed, in order and in separate calls, so the host records its real result. If a write scope or formal check must change, return the precise change to your Coordinator; it can extend/redeclare immediately within the original requirements. Diagnostic success is not formal acceptance evidence."
          : "Execute validation in its declared order. Earlier entries may be approved generator, build, formatter, or exact cleanup commands required before canonical criterion tests. Every persistent or transient generator output must be declared in unit.write. Cleanup may remove only declared unit.write outputs and must be an explicit ordered command after generation and before post-commit or canonical validation; never add an ignore rule or remove an undeclared path. If any necessary command, input, output, or cleanup is missing, do not run an undeclared command or variant and do not use resume evidence tooling to invent permission; return a contract-repair decision.",
        "Preserve existing public API success and error return semantics unless acceptance explicitly changes them, and cover those compatibility boundaries in the declared validation.",
        "Do not spawn nested subagents for consultation. Required consultations belong to the root before dispatch; use the confirmed decisions and evidence declared in the unit objective and inputs. If required consultation results or user decisions are missing, return the exact contract gap to the parent instead of attempting a deeper Task, inventing consent, or asking the user to repeat an already recorded decision.",
        ...(plan.git_lifecycle !== undefined && index === plan.units.length - 1 ? [
          `git_post_commit_validation: ${JSON.stringify(plan.git_lifecycle.post_commit_validation)}`,
          "Complete every source write before invoking any git_post_commit_validation command. Its first exact invocation is the host commit boundary; after it, source mutation and undeclared shell commands are denied. Run every listed command and return its real evidence.",
        ] : []),
        `unit_acceptance_indices: ${JSON.stringify(unit.acceptance_indices)}`, "", unit.objective].join("\n");
      units.push({ unit, task: { subagent_type: profileAgent(this.profile, "dog-worker"), description: unit.title, prompt },
        handoffPath, manifestPath, hashes: [...contents.map(hash), hash(declaration)], status: "pending", callID: null,
        childSessionID: null, evidence: [], resultClass: null, repairValidationAttempts: 0, repairValidation: null });
    }
    const gitLifecycle = await this.createGitLifecycle(plan, remediationHead);
    const state: OperatorState = { schema_version: "0.1", profile: this.profile.id, rootSessionID: root, runID, planHash: validatedPlanHash,
      acceptance: plan.acceptance, acceptanceProof: plan.acceptance_proof, acceptanceFingerprint, sourceRefs: plan.source_refs, createdAt: new Date().toISOString(),
      parentRunID: parent?.runID ?? null, ...(superseding ? { supersededRunID: previous!.runID } : {}), priorAcceptedUnits,
      remediationParent: remediationTaskID && remediationHead && parent?.gitLifecycle ? {
        taskID: remediationTaskID, committedHead: remediationHead, runID: parent.runID,
        acceptanceFingerprint: parent.acceptanceFingerprint, approvedWriteUnion: parent.gitLifecycle.writeUnion,
        approvedRemediationReserve: [...(parent.gitLifecycle.remediationReserve ?? []),
          ...this.authorizedScopeExpansion(parent, plan.git_lifecycle?.remediation_scope_expansion, scopeApprovalTurnID)],
        commitMessage: parent.gitLifecycle.commitMessage,
        ...(parent.gitLifecycle.commitProvenance === undefined || parent.gitLifecycle.commitProvenance === null
          ? {} : { commitProvenance: parent.gitLifecycle.commitProvenance }),
      } : null,
      gitLifecycle,
      generation: (previous?.generation ?? 0) + 1, sequence: previous?.sequence ?? 0, phase: "prepared", repairGeneration: 0,
      operatorCallID: mission?.dispatcher?.callID ?? null, operatorSessionID: mission?.dispatcher?.sessionID ?? null,
      dispatched: 0, units, decision: null, receipt: null, contractRepair: null,
      repairResidualPaths: [], pendingScopeExpansion: [] };
    const created: string[] = [];
    try {
      await mkdir(directory, { recursive: true });
      for (const control of controls) {
        const handle = await open(control.path, "wx", 0o600);
        created.push(control.path);
        try { await handle.writeFile(control.content); } finally { await handle.close(); }
      }
      if (superseding && previous) {
        const archive = `${this.file(root)}.${previous.runID}.archive`;
        try { await writeFile(archive, JSON.stringify(previous), { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
              await readFile(archive, "utf8") !== JSON.stringify(previous)) throw error;
        }
      }
      await this.save(state);
      return state;
    } catch (error) {
      const cleanup = await Promise.allSettled(created.reverse().map(path => rm(path, { force: true })));
      if (gitLifecycle !== null) await this.cleanupCreatedBranch(gitLifecycle).catch(() => {
        throw new OperatorContractError([{ document: "controls", pointer: "/git_lifecycle", code: "operator-git-branch-cleanup-refused",
          rule: "clean-known-created-branch-only", repair_kind: "retry-storage-after-cleanup" }]);
      });
      if (cleanup.some(result => result.status === "rejected")) throw new OperatorContractError([{ document: "controls", pointer: "/controls",
        code: "operator-control-cleanup-failed", rule: "no-partial-controls", repair_kind: "retry-storage-after-cleanup" }]);
      if (error instanceof OperatorContractError) throw error;
      throw new OperatorContractError([{ document: "controls", pointer: "/controls", code: "operator-control-write-failed",
        rule: "all-controls-persist-or-none", repair_kind: "retry-storage-after-cleanup" }]);
    }
  }
  operatorTask(state: OperatorState): OperatorTask {
    const pending = state.units.filter(unit => unit.status === "pending");
    const next = pending[0] ?? state.units[0]!;
    return { subagent_type: profileAgent(this.profile, "dog-operator"), description: `${next.unit.title} (+${Math.max(0, pending.length - 1)})`,
      prompt: [`operator_run_id: ${state.runID}`, `operator_root: ${state.rootSessionID}`, `operator_generation: ${state.generation}`,
        `operator_contract: ${state.planHash}`,
        `communication_context: ${JSON.stringify({ title: next.unit.title, criterion: state.acceptance[0] })}`,
        "Use the user's prose language in communication_context for your replies and progress, not this control boilerplate.",
        "Execute the approved serial queue using the operator next tool. Do not reinterpret acceptance or edit source.",
        "Before dispatch, review that all observed persistent and transient generator outputs are in unit.write and exact cleanup commands are ordered after generation and before post-commit or canonical validation. Cleanup may target only declared outputs; never authorize arbitrary ignore rules or undeclared removal. Missing capability, output, or cleanup requires contract repair, not resume evidence."].join("\n") };
  }
  /** Root-visible handle for the bounded operations delegate; its contract stays host-internal. */
  dispatchTask(state: OperatorState): OperatorTask {
    const canonical = this.operatorTask(state);
    const reference = { k: "delegate", r: state.rootSessionID, n: state.runID,
      p: state.planHash, h: hash(JSON.stringify(canonical)), g: state.generation };
    return { ...canonical, prompt: `${OPERATOR_DELEGATE_TASK_REFERENCE} ${JSON.stringify(reference)}` };
  }
  private resolveOperatorTask(state: OperatorState, args: unknown): OperatorTask {
    const canonical = this.operatorTask(state), referenced = this.dispatchTask(state);
    if (!record(args) || !exactKeys(args, ["subagent_type", "description", "prompt", "task_id"]) ||
        (args.task_id !== undefined && args.task_id !== "") || args.subagent_type !== canonical.subagent_type ||
        args.description !== canonical.description || typeof args.prompt !== "string") {
      throw new Error("operator-dispatch-not-authorized");
    }
    if (args.prompt === canonical.prompt) return structuredClone(canonical); // Exact pre-reference compatibility.
    if (args.prompt !== referenced.prompt || !args.prompt.startsWith(`${OPERATOR_DELEGATE_TASK_REFERENCE} `)) {
      throw new Error("operator-dispatch-not-authorized");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(args.prompt.slice(OPERATOR_DELEGATE_TASK_REFERENCE.length + 1)); }
    catch { throw new Error("operator-dispatch-not-authorized"); }
    const expected = JSON.parse(referenced.prompt.slice(OPERATOR_DELEGATE_TASK_REFERENCE.length + 1)) as Record<string, unknown>;
    if (!record(parsed) || Object.keys(parsed).length !== 6 || !exactKeys(parsed, ["k", "r", "n", "g", "p", "h"]) ||
        Object.entries(expected).some(([key, value]) => parsed[key] !== value)) {
      throw new Error("operator-dispatch-not-authorized");
    }
    return structuredClone(canonical);
  }
  /** A bounded handle to the immutable task retained in durable operator state. */
  private workerTask(state: OperatorState, unit: UnitState): OperatorTask {
    const taskID = /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
    if (!taskID) throw new Error("operator-task-id-missing");
    const reference = { r: state.rootSessionID, n: state.runID, u: unit.unit.id,
      t: taskID, p: state.planHash, h: hash(JSON.stringify(unit.task)), g: state.generation };
    return { ...unit.task, prompt: `${OPERATOR_TASK_REFERENCE} ${JSON.stringify(reference)}` };
  }
  private repairWorkerTask(state: OperatorState, unit: UnitState): OperatorTask {
    const repair = unit.repairValidation;
    const taskID = /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
    if (!repair || !taskID) throw new Error("operator-contract-repair-validation-task-missing");
    const prompt = [`task_id: ${taskID}`, "context_digest:", "  mode: same-task-resume", "  resume_delta:",
      `    repair_fingerprint: ${repair.repair_fingerprint}`,
      `    operator_generation: ${state.generation}`,
      `    validation_continuation_attempt: ${unit.repairValidationAttempts + (unit.status === "pending" ? 1 : 0)}`,
      "    restriction: validation-only; source edits, generator replay, cleanup commands, and undeclared commands are denied",
      `    remaining_validation_json: ${JSON.stringify(repair.commands.slice(repair.next_index))}`,
      "    next_action: re-read the retained handoff, bind its unchanged operation manifest, then execute only remaining_validation_json in order and stop"].join("\n");
    return { subagent_type: profileAgent(this.profile, "dog-worker"), description: `Validate repaired ${unit.unit.title}`,
      prompt, task_id: repair.child_session_id };
  }
  nextWorkerTask(state: OperatorState): OperatorTask {
    const unit = state.units.find(item => item.status === "pending");
    if (!unit) throw new Error("operator-pending-unit-missing");
    return unit.repairValidation === null ? this.workerTask(state, unit) : this.repairWorkerTask(state, unit);
  }
  /** Atomically claim and resolve one exact admitted prompt for its native child. */
  claimAdmittedWorkerPrompt(root: string, parent: string, child: string, prompt: string): Promise<{ callID: string; prompt: string;
    repairValidationRetry?: { taskID: string; repairFingerprint: string; binding: OperatorRepairValidationRetryBinding } }> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      if (state.phase !== "running") throw new Error("operator-worker-claim-revoked");
      const expectedParent = state.operatorSessionID ?? (state.units.length === 1 ? root : null);
      if (expectedParent === null || parent !== expectedParent) throw new Error("operator-worker-parent-mismatch");
      const unit = state.units.find(item => item.status === "running" && item.callID !== null);
      const expected = unit?.repairValidation === null ? unit?.task : unit === undefined ? undefined : this.repairWorkerTask(state, unit);
      if (!unit || expected === undefined || (prompt !== expected.prompt && (unit.repairValidation !== null || prompt !== this.workerTask(state, unit).prompt))) {
        throw new Error("operator-worker-task-reference-mismatch");
      }
      if (unit.childSessionID !== null && unit.childSessionID !== child) throw new Error("operator-worker-child-mismatch");
      if (unit.childSessionID === null) { unit.childSessionID = child; await this.save(state); }
      if (unit.repairValidation !== null && unit.repairValidationAttempts === 2) {
        await this.verifyControls(unit);
        const candidate = await this.repairValidationCandidateFingerprint(state);
        if (unit.repairValidation.candidate_fingerprint !== candidate) {
          throw new Error("operator-contract-repair-validation-candidate-changed");
        }
        const taskID = /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
        if (!taskID) throw new Error("operator-task-id-missing");
        return { callID: unit.callID!, prompt: expected.prompt,
          repairValidationRetry: { taskID, repairFingerprint: unit.repairValidation.repair_fingerprint,
            binding: this.repairValidationRetryBinding(state, unit, unit.repairValidation.repair_fingerprint, state.generation) } };
      }
      return { callID: unit.callID!, prompt: expected.prompt };
    });
  }
  private matchesWorkerTask(state: OperatorState, unit: UnitState, args: unknown): boolean {
    if (!record(args)) return false;
    if (unit.repairValidation !== null) {
      const expected = this.repairWorkerTask(state, unit);
      return args.task_id === expected.task_id && args.subagent_type === expected.subagent_type &&
        args.description === expected.description && args.prompt === expected.prompt;
    }
    if (args.task_id !== undefined && args.task_id !== "") return false;
    if (args.subagent_type !== unit.task.subagent_type || args.description !== unit.task.description) return false;
    return args.prompt === unit.task.prompt || args.prompt === this.workerTask(state, unit).prompt;
  }
  matchesRecordedWorkerTask(state: OperatorState, unitID: string, args: unknown): boolean {
    const unit = state.units.find(item => item.unit.id === unitID);
    const normalized = record(args) && typeof args.agent === "string" && args.subagent_type === undefined
      ? { ...args, subagent_type: args.agent }
      : args;
    return unit !== undefined && this.matchesWorkerTask(state, unit, normalized);
  }
  admitOperator(root: string, callID: string, args: unknown): Promise<OperatorTask> {
    return this.serial(root, () => this.admitOperatorOnce(root, callID, args));
  }
  private async admitOperatorOnce(root: string, callID: string, args: unknown): Promise<OperatorTask> {
    const state = await this.required(root);
    if (state.units.length === 1 || state.phase !== "prepared" || state.operatorCallID !== null) {
      throw new Error("operator-dispatch-not-authorized");
    }
    const canonical = this.resolveOperatorTask(state, args);
    state.operatorCallID = callID;
    state.phase = "running";
    await this.save(state);
    return canonical;
  }
  bindOperator(root: string, sessionID: string, prompt: string): Promise<void> {
    return this.serial(root, () => this.bindOperatorOnce(root, sessionID, prompt));
  }
  private async bindOperatorOnce(root: string, sessionID: string, prompt: string): Promise<void> {
    const state = await this.required(root);
    if (state.phase !== "running" || state.operatorCallID === null ||
        (state.operatorSessionID !== null && state.operatorSessionID !== sessionID) ||
        (prompt !== this.operatorTask(state).prompt && prompt !== this.dispatchTask(state).prompt)) throw new Error("operator-grant-invalid");
    state.operatorSessionID = sessionID;
    await this.save(state);
  }
  /** Atomically bind one native delegate child and reveal its admitted canonical contract only there. */
  claimAdmittedOperatorPrompt(root: string, parent: string, child: string, prompt: string): Promise<string> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      if (state.phase !== "running" || state.operatorCallID === null) throw new Error("operator-grant-invalid");
      if (parent !== state.rootSessionID || root !== state.rootSessionID) throw new Error("operator-parent-mismatch");
      if (state.operatorSessionID !== null && state.operatorSessionID !== child) throw new Error("operator-child-mismatch");
      if (prompt !== this.operatorTask(state).prompt && prompt !== this.dispatchTask(state).prompt) {
        throw new Error("operator-task-reference-mismatch");
      }
      if (state.operatorSessionID === null) { state.operatorSessionID = child; await this.save(state); }
      return this.operatorTask(state).prompt;
    });
  }
  next(root: string, actor: string): Promise<unknown> {
    return this.serial(root, () => this.nextOnce(root, actor));
  }
  private async nextOnce(root: string, actor: string): Promise<unknown> {
    const state = await this.required(root);
    if (actor === root && state.units.length > 1) {
      return state.phase === "prepared" && state.operatorCallID === null
        ? { run_id: state.runID, acceptance_fingerprint: state.acceptanceFingerprint, task: this.dispatchTask(state) }
        : this.packet(state);
    }
    if (actor !== state.operatorSessionID && !(actor === root && state.units.length === 1 && state.operatorSessionID === null)) throw new Error("operator-owner-mismatch");
    if (!["prepared", "running"].includes(state.phase)) return this.packet(state);
    const current = state.units.find(unit => unit.status !== "succeeded");
    if (!current) {
      const readiness = this.gitAcceptanceReadiness(state);
      state.phase = readiness === null ? "awaiting-acceptance" : "awaiting-decision";
      state.decision = readiness;
      await this.save(state);
      return this.packet(state);
    }
    if (current.status !== "pending") return this.packet(state);
    await this.verifyControls(current);
    return { run_id: state.runID, generation: state.generation, sequence: state.sequence,
      task: current.repairValidation === null ? this.workerTask(state, current) : this.repairWorkerTask(state, current),
      dispatch_instruction: "Pass task unchanged. Its prompt must remain the sole exact SORTIE_OPERATOR_TASK_REF; the host delivers the registered contract inside the admitted worker.",
      acceptance_fingerprint: state.acceptanceFingerprint };
  }
  admitWorker(root: string, actor: string, callID: string, args: unknown): Promise<OperatorTask> {
    return this.serial(root, () => this.admitWorkerOnce(root, actor, callID, args));
  }
  private async admitWorkerOnce(root: string, actor: string, callID: string, args: unknown): Promise<OperatorTask> {
    const state = await this.required(root);
    if (actor !== state.operatorSessionID && !(actor === root && state.units.length === 1 && state.operatorSessionID === null)) throw new Error("operator-owner-mismatch");
    if (!["prepared", "running"].includes(state.phase)) throw new Error("operator-grant-revoked");
    const unit = state.units.find(item => item.status !== "succeeded");
    if (!unit || unit.status !== "pending" || !this.matchesWorkerTask(state, unit, args)) {
      throw new Error("operator-unit-not-authorized");
    }
    await this.verifyControls(unit);
    const admitted = unit.repairValidation === null ? unit.task : this.repairWorkerTask(state, unit);
    if (unit.repairValidation !== null) {
      if (unit.repairValidationAttempts >= 2) throw new Error("operator-contract-repair-validation-retry-exhausted");
      await this.assertRemovedRepairPathsAbsent(unit.repairValidation.removed_paths);
      const candidate = await this.repairValidationCandidateFingerprint(state);
      if (unit.repairValidation.candidate_fingerprint !== null && unit.repairValidation.candidate_fingerprint !== candidate) {
        throw new Error("operator-contract-repair-validation-candidate-changed");
      }
      unit.repairValidation.candidate_fingerprint = candidate;
      unit.repairValidationAttempts++;
    } else state.dispatched++;
    unit.status = "running";
    unit.callID = callID;
    state.phase = "running";
    await this.save(state);
    return admitted;
  }
  async rejectedAdmission(root: string, callID: string): Promise<void> {
    await this.rejectDispatch(root, callID, "dispatch-admission-rejected");
  }
  rejectDispatch(root: string, callID: string, decision = "native-task-rejected"): Promise<void> {
    return this.serial(root, () => this.rejectDispatchOnce(root, callID, decision));
  }
  private async rejectDispatchOnce(root: string, callID: string, decision: string): Promise<void> {
    const state = await this.required(root);
    const unit = state.units.find(item => item.callID === callID && item.status === "running");
    if (!unit) return;
    unit.status = "failed";
    unit.resultClass = "process-defect";
    state.phase = "awaiting-decision";
    state.decision = decision;
    await this.save(state);
  }
  private repairPathProtected(state: OperatorState, path: string): boolean {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    const stateDirectory = process.platform === "win32" ? this.profile.stateDirectory.toLowerCase() : this.profile.stateDirectory;
    if (key === ".git" || key.startsWith(".git/") || key === stateDirectory || key.startsWith(`${stateDirectory}/`)) return true;
    if (state.units.some(unit => unit.unit.read.some(scope => this.pathAuthorized(path, [scope])))) return true;
    return state.sourceRefs.some(source => {
      try { return this.pathAuthorized(path, [normalizeRelativePath(source)]); } catch { return false; }
    });
  }
  private async captureRepairFile(state: OperatorState, path: string): Promise<OperatorContractRepairFileIdentity> {
    const lifecycle = state.gitLifecycle;
    if (lifecycle === null || this.pathAuthorized(path, lifecycle.writeUnion) || this.repairPathProtected(state, path)) {
      throw new Error("operator-contract-repair-path-forbidden");
    }
    const absolute = resolve(this.projectRoot, path);
    const canonical = await realpath(absolute);
    const rest = relative(this.projectRoot, canonical);
    if (rest === "" || rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) throw new Error("operator-contract-repair-path-outside-root");
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("operator-contract-repair-file-not-regular");
    const [baseline, head, index, cached, patch, untracked] = await Promise.all([
      this.git(["ls-tree", "-z", "--name-only", lifecycle.startOID, "--", path]),
      this.git(["ls-tree", "-z", "--name-only", "HEAD", "--", path]),
      this.git(["ls-files", "--stage", "-z", "--", path]),
      this.git(["diff", "--cached", "--name-only", "--no-renames", "-z", "--", path]),
      this.git(["diff", "--name-only", "--no-renames", "-z", "--", path]),
      this.git(["ls-files", "--others", "--exclude-standard", "-z", "--", path]),
    ]);
    const untrackedPaths = this.gitPaths(untracked.stdout);
    if (baseline.stdout.length || head.stdout.length || index.stdout.length || cached.stdout.length || patch.stdout.length ||
        untrackedPaths.length !== 1 || untrackedPaths[0] !== path) throw new Error("operator-contract-repair-file-state-changed");
    const content = await readFile(absolute);
    return { path, size: metadata.size, sha256: createHash("sha256").update(content).digest("hex"), realpath: canonical,
      baseline_absent: true, head_absent: true, index_absent: true, patch_absent: true, untracked: true, regular_nonlink: true };
  }
  private async captureContractRepair(state: OperatorState, unit: UnitState, error: OperatorContractError,
    command: string): Promise<OperatorContractRepairState> {
    const normalized = normalizeCommand(command);
    const commandIndex = unit.unit.validation.map(normalizeCommand).indexOf(normalized);
    if (commandIndex < 0) throw new Error("operator-contract-repair-validation-command-missing");
    const paths = [...new Set(error.diagnostics.flatMap(item => item.repair_paths ?? []))].sort();
    let files: OperatorContractRepairFileIdentity[] = [];
    let mode: OperatorContractRepairState["mode"] = "unavailable";
    if (paths.length > 0 && error.diagnostics.every(item => item.expected === "untracked")) {
      try { files = await Promise.all(paths.map(path => this.captureRepairFile(state, path))); mode = "discard-transient"; }
      catch { files = []; }
    }
    const repairFingerprint = mode === "discard-transient" ? operatorContractRepairFingerprint({ run_id: state.runID,
      unit_id: unit.unit.id, repair_generation: 0, files }) : null;
    return { code: "operator-git-change-outside-write-union", unit_id: unit.unit.id,
      diagnostics: structuredClone(error.diagnostics), diagnostics_truncated: error.diagnostics_truncated,
      repair_generation: 0, mode, repair_fingerprint: repairFingerprint, files,
      remaining_validation: unit.unit.validation.slice(commandIndex).map(normalizeCommand) };
  }
  recordContractRepair(root: string, actor: string, error: OperatorContractError, command: string): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      const unit = state.units.find(item => item.status === "running" && item.childSessionID === actor);
      if (!unit) throw new Error("operator-contract-repair-owner-mismatch");
      if (state.repairGeneration !== 0) throw new Error("operator-contract-repair-exhausted");
      const contractRepair = await this.captureContractRepair(state, unit, error, command);
      if (!this.validContractRepairState(contractRepair, state.units)) throw new Error("operator-contract-repair-diagnostic-invalid");
      unit.status = "failed";
      unit.resultClass = "contract-repair";
      unit.evidence = [];
      state.phase = "awaiting-decision";
      state.decision = "operator-contract-repair-required";
      state.contractRepair = contractRepair;
      await this.save(state);
      return state;
    });
  }
  applyContractRepair(root: string, input: { run_id: string; unit_id: string; repair_fingerprint: string;
    decision: string; paths: readonly string[] }, assertValidationBudget: () => Promise<void>): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root), repair = state.contractRepair;
      const unit = state.units.find(item => item.unit.id === input.unit_id);
      if (input.decision !== "discard-transient" || state.runID !== input.run_id || state.phase !== "awaiting-decision" ||
          state.decision !== "operator-contract-repair-required" || state.repairGeneration !== 0 || repair === null ||
          repair.mode !== "discard-transient" || repair.repair_generation !== 0 || repair.unit_id !== input.unit_id ||
          repair.repair_fingerprint !== input.repair_fingerprint || unit === undefined || unit.childSessionID === null) {
        throw new Error("operator-contract-repair-identity-mismatch");
      }
      const supplied = input.paths.map(path => normalizeRelativePath(path));
      const expected = repair.files.map(file => file.path).sort();
      if (new Set(supplied).size !== supplied.length || JSON.stringify([...supplied].sort()) !== JSON.stringify(expected)) {
        throw new Error("operator-contract-repair-path-set-mismatch");
      }
      await assertValidationBudget();
      const current = await Promise.all(expected.map(path => this.captureRepairFile(state, path)));
      if (operatorContractRepairFingerprint({ run_id: state.runID, unit_id: unit.unit.id, repair_generation: 0, files: current }) !== repair.repair_fingerprint ||
          JSON.stringify(current) !== JSON.stringify(repair.files)) throw new Error("operator-contract-repair-file-identity-mismatch");
      try {
        for (const file of current) await unlink(file.realpath);
      } catch (error) {
        state.repairGeneration = 1; state.contractRepair = null; unit.repairValidation = null;
        unit.status = "failed"; unit.resultClass = "process-defect"; state.phase = "awaiting-decision";
        state.decision = "operator-contract-repair-delete-failed";
        await this.save(state);
        throw new Error(`operator-contract-repair-delete-failed:${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
      }
      unit.status = "pending"; unit.callID = null; unit.resultClass = null; unit.evidence = []; unit.repairValidationAttempts = 0;
      unit.repairValidation = { repair_fingerprint: repair.repair_fingerprint, child_session_id: unit.childSessionID,
        commands: repair.remaining_validation, removed_paths: expected,
        candidate_fingerprint: await this.repairValidationCandidateFingerprint(state), next_index: 0 };
      state.repairGeneration = 1; state.contractRepair = null; state.phase = "prepared"; state.decision = "repair-applied";
      await this.save(state);
      return state;
    });
  }
  async repairValidationAccess(root: string, actor: string): Promise<{ unit_id: string; task_id: string; handoff_path: string;
    manifest_path: string; manifest_hash: string; repair_fingerprint: string; expected_command: string | null; complete: boolean } | null> {
    const state = await this.required(root);
    const unit = state.units.find(item => item.repairValidation?.child_session_id === actor && item.status === "running");
    if (!unit?.repairValidation) return null;
    const taskID = /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
    if (!taskID) throw new Error("operator-task-id-missing");
    return { unit_id: unit.unit.id, task_id: taskID, handoff_path: unit.handoffPath, manifest_path: unit.manifestPath,
      manifest_hash: unit.hashes[1]!, repair_fingerprint: unit.repairValidation.repair_fingerprint,
      expected_command: unit.repairValidation.commands[unit.repairValidation.next_index] ?? null,
      complete: unit.repairValidation.next_index === unit.repairValidation.commands.length };
  }
  recordRepairValidationResult(root: string, actor: string, command: string, exit: number): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      const unit = state.units.find(item => item.repairValidation?.child_session_id === actor && item.status === "running");
      const repair = unit?.repairValidation;
      if (!unit || !repair || repair.commands[repair.next_index] !== normalizeCommand(command)) {
        throw new Error("operator-contract-repair-validation-sequence-invalid");
      }
      if (exit !== 0) {
        const classified = classifyUnitResult({ validated: false, interrupted: false,
          failedValidation: { command: [normalizeCommand(command)], outcome: "fail", exitCode: exit } });
        unit.status = classified.disposition; unit.resultClass = classified.resultClass; unit.repairValidation = null;
        if (classified.failure !== undefined) {
          (unit as UnitState & { failure?: SerialDispatchSettlement["failure"] }).failure = classified.failure;
        }
        state.phase = "awaiting-decision";
        state.decision = classified.resultClass === "acceptance" ? ACCEPTANCE_REMEDIATION_DECISION : classified.resultClass;
      } else repair.next_index++;
      await this.save(state);
      return state;
    });
  }
  completeRepairValidation(root: string, callID: string, evidence: readonly GoalEvidence[]): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      const unit = state.units.find(item => item.callID === callID && item.repairValidation !== null);
      if (!unit?.repairValidation || unit.repairValidation.next_index !== unit.repairValidation.commands.length || evidence.length === 0) {
        throw new Error("operator-contract-repair-validation-incomplete");
      }
      const ids = new Set(evidence.flatMap(item => item.measurement.criterion_ids));
      if (!unit.unit.acceptance_indices.every(index => state.acceptanceProof[index]!.some(id => ids.has(id)))) {
        throw new Error("operator-contract-repair-proof-incomplete");
      }
      unit.status = "succeeded"; unit.resultClass = "acceptance"; unit.evidence = evidence; unit.repairValidation = null;
      state.decision = null;
      if (state.units.every(item => item.status === "succeeded")) {
        const readiness = this.gitAcceptanceReadiness(state);
        state.phase = readiness === null ? "awaiting-acceptance" : "awaiting-decision";
        state.decision = readiness;
      } else state.phase = "running";
      await this.save(state);
      return state;
    });
  }
  failRepairValidation(root: string, callID: string, decision: string): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      const unit = state.units.find(item => item.callID === callID && item.repairValidation !== null);
      if (unit) {
        unit.status = "failed"; unit.resultClass = "process-defect";
        if (!decision.startsWith("operator-contract-repair-validation-incomplete:") || unit.repairValidationAttempts >= 2) {
          unit.repairValidation = null;
        }
        state.phase = "awaiting-decision"; state.decision = decision;
        await this.save(state);
      }
      return state;
    });
  }
  abortAppliedContractRepair(root: string, decision: string): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      const unit = state.units.find(item => item.repairValidation !== null);
      if (unit) {
        unit.status = "failed"; unit.resultClass = "process-defect"; unit.repairValidation = null;
        state.phase = "awaiting-decision"; state.decision = decision;
        await this.save(state);
      }
      return state;
    });
  }
  operatorRejected(root: string): Promise<OperatorState> {
    return this.serial(root, () => this.operatorRejectedOnce(root));
  }
  private async operatorRejectedOnce(root: string): Promise<OperatorState> {
    const state = await this.required(root);
    if (state.phase === "running" && state.operatorCallID !== null && state.operatorSessionID === null) {
      state.phase = "awaiting-decision";
      state.decision = "native-operator-task-rejected";
      await this.save(state);
    }
    return state;
  }
  settled(result: SerialDispatchSettlement): Promise<void> {
    return this.serial(result.rootSessionID, () => this.settledOnce(result));
  }
  private async settledOnce(result: SerialDispatchSettlement): Promise<void> {
    const state = await this.read(result.rootSessionID);
    const unit = state?.units.find(item => item.callID === result.callID);
    if (!state || !unit) return;
    if (state.phase === "cancelled" || state.phase === "completed") return;
    if (unit.resultClass === "contract-repair" && state.contractRepair !== null) return;
    unit.childSessionID = result.childSessionID ?? unit.childSessionID;
    unit.evidence = result.evidence;
    unit.resultClass = result.resultClass;
    if (result.failure !== undefined) (unit as UnitState & { failure?: SerialDispatchSettlement["failure"] }).failure = result.failure;
    unit.status = result.disposition;
    if (result.disposition !== "succeeded") {
      state.phase = "awaiting-decision";
      state.decision = result.resultClass === "acceptance" ? ACCEPTANCE_REMEDIATION_DECISION : result.resultClass;
    }
    else if (state.units.every(item => item.status === "succeeded")) {
      const readiness = this.gitAcceptanceReadiness(state);
      state.phase = readiness === null ? "awaiting-acceptance" : "awaiting-decision";
      state.decision = readiness;
    }
    await this.save(state);
  }
  observeChild(root: string, callID: string, childID: string): Promise<void> {
    return this.serial(root, () => this.observeChildOnce(root, callID, childID));
  }
  private async observeChildOnce(root: string, callID: string, childID: string): Promise<void> {
    const state = await this.required(root);
    const unit = state.units.find(item => item.callID === callID);
    if (!unit) return;
    if (unit.childSessionID !== null && unit.childSessionID !== childID) throw new Error("operator-worker-child-mismatch");
    if (unit.childSessionID === null) { unit.childSessionID = childID; await this.save(state); }
  }
  operatorReturned(root: string): Promise<OperatorState> {
    return this.serial(root, () => this.operatorReturnedOnce(root));
  }
  processReplacementRequired(root: string, runID: string): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      if (state.runID !== runID || state.phase !== "awaiting-decision" || state.decision !== "process-defect") {
        throw new Error("operator-process-remediation-replacement-not-ready");
      }
      state.decision = PROCESS_REPLACEMENT_DECISION;
      await this.save(state);
      return state;
    });
  }
  private async operatorReturnedOnce(root: string): Promise<OperatorState> {
    const state = await this.required(root);
    if (state.phase === "running") {
      state.phase = "awaiting-decision";
      state.decision = "operator-returned-without-complete-evidence";
      await this.save(state);
    }
    return state;
  }
  interrupted(root: string, reason: string): Promise<readonly string[]> {
    return this.serial(root, () => this.interruptedOnce(root, reason));
  }
  private async interruptedOnce(root: string, reason: string): Promise<readonly string[]> {
    const state = await this.read(root);
    if (!state || state.phase === "completed") return [];
    const reviewRemediation = reason === REVIEW_REMEDIATION_DECISION;
    if (reviewRemediation && (state.phase !== "awaiting-acceptance" || state.units.some(unit => unit.status !== "succeeded") ||
        state.gitLifecycle?.committedHead === null || state.gitLifecycle === null)) {
      throw new Error("operator-review-remediation-not-ready");
    }
    state.generation++;
    state.phase = "cancelled";
    if (state.contractRepair !== null) {
      // Record what the abandoned repair leaves on disk so a replacement can name an exact,
      // verifiable cleanup instead of facing an unexplained terminal refusal.
      state.repairResidualPaths = state.contractRepair.files.map(file => file.path).sort();
      state.contractRepair = null;
      state.repairGeneration = 1;
      state.decision = "operator-contract-repair-unavailable-after-cancel";
    } else if (reviewRemediation) state.decision = REVIEW_REMEDIATION_DECISION;
    else if (state.decision !== ACCEPTANCE_REMEDIATION_DECISION) state.decision = reason;
    for (const unit of state.units) if (unit.status === "running") unit.status = "cancelled";
    await this.save(state);
    return [state.operatorSessionID, ...state.units.map(unit => unit.childSessionID)].filter((id): id is string => id !== null);
  }
  terminal(root: string, receipt: GoalTerminalReceipt): Promise<void> {
    return this.serial(root, () => this.terminalOnce(root, receipt));
  }
  private async terminalOnce(root: string, receipt: GoalTerminalReceipt): Promise<void> {
    const state = await this.read(root);
    if (!state) return;
    if (receipt.status === "succeeded" && state.phase === "awaiting-acceptance") {
      state.phase = "completed";
      state.receipt = receipt;
      await this.save(state);
    }
  }
  async required(root: string): Promise<OperatorState> {
    const state = await this.read(root);
    if (!state) throw new Error("operator-run-missing");
    return state;
  }
  private repairValidationRetryFingerprint(state: OperatorState, unit: UnitState): string {
    const commands = unit.repairValidation?.commands ?? state.gitLifecycle?.postCommitValidation ?? [];
    return unit.repairValidation?.repair_fingerprint ?? `sha256:${hash(JSON.stringify([
      "repair-validation-retry", state.runID, unit.unit.id, state.planHash, state.acceptanceFingerprint, unit.hashes, commands,
    ]))}`;
  }
  private repairValidationRetryBinding(state: OperatorState, unit: UnitState, repairFingerprint: string,
    generation: number): OperatorRepairValidationRetryBinding {
    const validationCommands = unit.repairValidation?.commands ?? state.gitLifecycle?.postCommitValidation ?? [];
    return { authority: "operator-repair-validation-retry", operator_run_id: state.runID, unit_id: unit.unit.id,
      operator_generation: generation, plan_hash: state.planHash,
      control_hash: `sha256:${hash(JSON.stringify(unit.hashes))}`, operator_acceptance_fingerprint: state.acceptanceFingerprint,
      validation_commands: [...validationCommands],
      repair_fingerprint: repairFingerprint };
  }
  canRetryRepairValidation(state: OperatorState): boolean {
    const failed = state.units.filter(unit => unit.status === "failed");
    return state.phase === "awaiting-decision" && state.contractRepair === null && state.repairGeneration === 1 &&
      state.decision === REPAIR_VALIDATION_STALE_PROOF_DECISION && state.gitLifecycle !== null && failed.length === 1 &&
      failed[0]!.resultClass === "process-defect" && failed[0]!.evidence.length === 0 && failed[0]!.childSessionID !== null &&
      failed[0]!.repairValidationAttempts === 1 && state.units.every(unit => unit.status !== "running" && unit.status !== "cancelled");
  }
  resumeRepairValidation(root: string, runID: string,
    authorize: (source: OperatorRepairValidationRetrySource) => Promise<void>): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      if (state.runID !== runID || !this.canRetryRepairValidation(state)) {
        throw new Error("operator-contract-repair-validation-retry-not-ready");
      }
      for (const item of state.units) await this.verifyControls(item);
      const unit = state.units.find(item => item.status === "failed")!;
      const taskID = /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
      if (!taskID || unit.childSessionID === null || state.gitLifecycle === null) {
        throw new Error("operator-contract-repair-validation-retry-identity-missing");
      }
      const commands = unit.repairValidation?.commands ?? state.gitLifecycle.postCommitValidation;
      if (commands.length === 0) throw new Error("operator-contract-repair-validation-retry-commands-missing");
      const repairFingerprint = this.repairValidationRetryFingerprint(state, unit);
      const repair = unit.repairValidation ?? { repair_fingerprint: repairFingerprint, child_session_id: unit.childSessionID,
        commands, removed_paths: [], candidate_fingerprint: null, next_index: 0 };
      await this.assertRemovedRepairPathsAbsent(repair.removed_paths);
      const candidate = await this.repairValidationCandidateFingerprint(state);
      if (repair.candidate_fingerprint !== null && repair.candidate_fingerprint !== candidate) {
        throw new Error("operator-contract-repair-validation-candidate-changed");
      }
      repair.candidate_fingerprint = candidate;
      const nextGeneration = state.generation + 1;
      const binding = this.repairValidationRetryBinding(state, unit, repairFingerprint, nextGeneration);
      await authorize({ taskID, operatorRunID: state.runID, operatorUnitID: unit.unit.id,
        childSessionID: unit.childSessionID, operatorAcceptanceFingerprint: state.acceptanceFingerprint,
        validationCommands: [...commands], repairFingerprint, binding });
      unit.repairValidation = repair; unit.status = "pending"; unit.callID = null; unit.resultClass = null; unit.evidence = [];
      state.generation = nextGeneration; state.operatorCallID = null; state.operatorSessionID = null;
      state.phase = "prepared"; state.decision = "operator-contract-repair-validation-retry";
      await this.save(state);
      return state;
    });
  }
  resume(root: string, runID: string, recovered: ReadonlyMap<string, readonly GoalEvidence[]>, unstarted: ReadonlySet<string> = new Set()): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      if (state.contractRepair !== null) throw new Error("operator-resume-contract-repair-required");
      if (state.runID !== runID || state.phase !== "awaiting-decision" || state.units.some(unit => unit.status === "running" || unit.status === "cancelled")) {
        throw new Error("operator-resume-not-ready");
      }
      for (const unit of state.units) {
        if (unit.status !== "failed") continue;
        if (unstarted.has(unit.unit.id)) {
          if (unit.resultClass !== "process-defect" || unit.childSessionID !== null || state.decision !== "dispatch-admission-rejected") throw new Error("operator-resume-unstarted-invalid");
          unit.status = "pending"; unit.callID = null; unit.resultClass = null;
          continue;
        }
        const evidence = recovered.get(unit.unit.id);
        const ids = new Set(evidence?.flatMap(item => item.measurement.criterion_ids) ?? []);
        if (unit.resultClass !== "process-defect" || !evidence?.length || !unit.unit.acceptance_indices.every(index => state.acceptanceProof[index]!.some(id => ids.has(id)))) {
          throw new Error("operator-resume-proof-incomplete");
        }
        unit.status = "succeeded"; unit.resultClass = "acceptance"; unit.evidence = evidence; unit.repairValidation = null;
      }
      state.generation++; state.operatorCallID = null; state.operatorSessionID = null; state.decision = null;
      if (state.units.every(unit => unit.status === "succeeded")) {
        const readiness = this.gitAcceptanceReadiness(state);
        state.phase = readiness === null ? "awaiting-acceptance" : "awaiting-decision";
        state.decision = readiness;
      } else state.phase = "prepared";
      await this.save(state);
      return state;
    });
  }
  requireAcceptanceRemediation(root: string, runID: string): Promise<OperatorState> {
    return this.serial(root, async () => {
      const state = await this.required(root);
      const failed = state.units.filter(unit => unit.status === "failed");
      const lifecycle = state.gitLifecycle;
      if (lifecycle !== null && lifecycle.committedHead === null) {
        // An interrupted unit commonly stops before the commit boundary, with unvalidated partial work in the
        // worktree. That work stays inside its authorized writes, so the run still has a usable baseline: the
        // inherited parent commit, its own authorized history, or its start commit. The remaining paths are
        // carried into the replacement instead of ending the run without any remediation route.
        const head = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
        const carried = await this.uncommittedPaths();
        const inherited = state.remediationParent?.committedHead === lifecycle.startOID && head === lifecycle.startOID;
        const descendant = head !== lifecycle.startOID && await this.authorizedHistory(lifecycle, head);
        if (carried.every(path => this.pathAuthorized(path, lifecycle.writeUnion)) &&
            (head === lifecycle.startOID || descendant)) {
          lifecycle.committedHead = head;
          lifecycle.commitProvenance = inherited ? "inherited-parent" : descendant ? "existing-history" : "uncommitted-baseline";
          if (carried.length > 0) lifecycle.carriedPaths = carried;
        }
      }
      if (state.runID !== runID || state.phase !== "awaiting-decision" || state.contractRepair !== null ||
          !lifecycle?.committedHead || failed.length !== 1 || failed[0]!.resultClass !== "process-defect" ||
          state.units.some(unit => unit.status === "running" || unit.status === "cancelled")) {
        throw new Error("operator-process-remediation-not-ready");
      }
      state.decision = ACCEPTANCE_REMEDIATION_DECISION;
      await this.save(state);
      return state;
    });
  }
  async draftStatus(root: string): Promise<unknown | undefined> {
    let source: string;
    try { source = await readFile(this.draftFile(root), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (Buffer.byteLength(source) > OPERATOR_LIMITS.planBytes * 2) throw new Error("operator-draft-too-large");
    const draft = JSON.parse(source);
    if (draft.profile !== this.profile.id || draft.root !== root || draft.id !== hash(JSON.stringify([this.profile.id, root, draft.plan]))) throw new Error("operator-draft-stale");
    return { status: "invalid-plan", draft_id: draft.id, diagnostics: draft.diagnostics ?? [], diagnostics_truncated: draft.diagnostics_truncated ?? false };
  }
  async completionGoalFingerprint(state: OperatorState): Promise<string> {
    for (const unit of state.units) await this.verifyControls(unit);
    const reference = /^goal_declaration_path: (.+)$/m.exec(state.units[0]!.task.prompt)?.[1];
    if (!reference) throw new Error("operator-declaration-path-invalid");
    const expanded = expandGoalDeclaration(JSON.parse(await readFile(reference, "utf8")));
    const fingerprint = /^goal_acceptance_fingerprint: (sha256:[a-f0-9]{64})$/m.exec(expanded)?.[1];
    if (!fingerprint) throw new Error("operator-goal-fingerprint-invalid");
    return fingerprint;
  }
  async verifyContinuityControls(state: OperatorState): Promise<void> {
    const current = await this.required(state.rootSessionID);
    if (current.runID !== state.runID || current.planHash !== state.planHash || current.acceptanceFingerprint !== state.acceptanceFingerprint) {
      throw new Error("operator-continuity-state-mismatch");
    }
    for (const unit of current.units) await this.verifyControls(unit);
  }
  packet(state: OperatorState): unknown {
    const proved = new Set(state.units.flatMap(unit => unit.evidence.flatMap(item => item.measurement.criterion_ids)));
    const current = state.units.find(unit => unit.status !== "succeeded");
    const repairValidationRetryAvailable = this.canRetryRepairValidation(state);
    const acceptanceRemediation = state.decision === ACCEPTANCE_REMEDIATION_DECISION;
    const reviewRemediation = state.decision === REVIEW_REMEDIATION_DECISION;
    const processReplacement = state.decision === PROCESS_REPLACEMENT_DECISION;
    const hostReconciliationRequired = state.phase === "awaiting-decision" && state.contractRepair === null &&
      !repairValidationRetryAvailable && !acceptanceRemediation && !reviewRemediation && !processReplacement;
    const failedAcceptanceUnit = acceptanceRemediation
      ? state.units.find(unit => unit.status === "failed" && ["acceptance", "process-defect"].includes(unit.resultClass ?? "")) : undefined;
    const failedEvidence = (failedAcceptanceUnit as (UnitState & { failure?: SerialDispatchSettlement["failure"] }) | undefined)?.failure;
    const carriedAction = (state.gitLifecycle?.carriedPaths ?? []).length === 0 ? ""
      : "; the interrupted unit left unvalidated partial work at that baseline, so declare every git_lifecycle.carried_uncommitted_paths entry inside the replacement write scope and validate it as the replacement's own candidate";
    const remediationNextAction = state.phase === "cancelled"
      ? `call ${this.profile.toolPrefix}prepare_operator with an approved replacement plan for the same goal and exact acceptance; start from git_lifecycle.committed_head, keep writes within git_lifecycle.approved_write_union, retain consumed budget, and do not call resume_operator or edit the committed candidate${carriedAction}`
      : `call ${this.profile.toolPrefix}cancel_operator, then call ${this.profile.toolPrefix}prepare_operator with an approved replacement plan for the same goal and exact acceptance; start from git_lifecycle.committed_head, keep writes within git_lifecycle.approved_write_union, retain consumed budget, and do not call resume_operator or edit the committed candidate${carriedAction}`;
    const awaitingAcceptanceNextAction = `assess the independent-review requirement and obtain review when required, copying review_dispatch_contract.required_prompt_lines into the reviewer Task prompt with real values; if review PASSes (or policy records an allowed skip), call ${this.profile.toolPrefix}complete_operator with this run_id and acceptance_fingerprint; if review has blocking findings wholly inside the existing exact acceptance, the union of git_lifecycle.approved_write_union and git_lifecycle.remediation_reserve, and remaining cumulative budget, do not complete or ask for user approval: call ${this.profile.toolPrefix}cancel_operator with reason review-blocking, then call ${this.profile.toolPrefix}prepare_operator for one same-goal replacement from git_lifecycle.committed_head targeting only those findings; copy this packet's acceptance array verbatim into the replacement plan without paraphrase, deletion, addition, or reordering, preserve accepted-criteria lineage, and run final canonical validation/review; if the replacement is refused for write scope, report replacement_constraints.blocked_write_paths to the user as the exact paths needing approval and stop, then after the user approves resend the same replacement with git_lifecycle.remediation_scope_expansion set to exactly those paths; if acceptance or budget must increase, stop for the user decision`;
    const packet = { profile: state.profile, run_id: state.runID, root_session_id: state.rootSessionID, generation: state.generation,
      sequence: state.sequence, status: state.phase, repair_generation: state.repairGeneration,
      acceptance: state.acceptance, acceptance_fingerprint: state.acceptanceFingerprint,
       next_task_ref: current?.status === "pending" ? (state.units.length > 1
         ? state.operatorSessionID === null ? this.dispatchTask(state).prompt : null
         : current.repairValidation === null ? this.workerTask(state, current).prompt : this.repairWorkerTask(state, current).prompt) : null,
       parent_run_id: state.parentRunID, prior_accepted_task_ids: state.priorAcceptedUnits.map(anchor => anchor.taskID),
       remediation_parent: state.remediationParent === null ? null : { task_id: state.remediationParent.taskID,
         committed_head: state.remediationParent.committedHead },
      git_lifecycle: state.gitLifecycle === null ? null : { branch: state.gitLifecycle.branch, start_ref: state.gitLifecycle.startRef,
        start_oid: state.gitLifecycle.startOID, approved_write_union: state.gitLifecycle.writeUnion,
        remediation_reserve: state.gitLifecycle.remediationReserve ?? [],
        post_commit_validation: state.gitLifecycle.postCommitValidation,
        committed_head: state.gitLifecycle.committedHead,
        inherited: state.gitLifecycle.commitProvenance === "inherited-parent",
        carried_uncommitted_paths: (state.gitLifecycle.carriedPaths ?? []).slice(0, 32) },
      // Index-aligned with this packet's own `acceptance`. Restating each criterion here duplicated the
      // whole acceptance text inside a packet the root re-reads on every later turn of its session.
      requirements: state.acceptance.map((_criterion, index) => ({ index,
        proof_ids: state.acceptanceProof[index], status: state.acceptanceProof[index]!.every(id => proved.has(id)) ? "observed-pass" : "unproven" })),
      source_refs: state.sourceRefs, decision: state.decision,
      contract_repair: state.contractRepair === null ? null : { code: state.contractRepair.code, unit_id: state.contractRepair.unit_id,
        diagnostics: state.contractRepair.diagnostics, diagnostics_truncated: state.contractRepair.diagnostics_truncated,
        repair_generation: state.contractRepair.repair_generation, mode: state.contractRepair.mode,
        repair_fingerprint: state.contractRepair.repair_fingerprint,
        files: state.contractRepair.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })) },
      resume_requires_host_reconciliation: hostReconciliationRequired,
      repair_validation_retry_available: repairValidationRetryAvailable,
      // Top-level because the refusal is recorded while preparing a replacement, by which point the
      // run has already left awaiting-acceptance. Surfacing it only there would hide the exact paths
      // in precisely the state the root must report to the user.
      blocked_write_paths: state.pendingScopeExpansion ?? [],
      ...(state.phase === "awaiting-acceptance" ? { review_decision: "root-assess-independent-review",
        replacement_constraints: { copy_acceptance_verbatim: true, acceptance: state.acceptance,
          committed_head: state.gitLifecycle?.committedHead ?? null,
          approved_write_union: state.gitLifecycle?.writeUnion ?? [],
          remediation_reserve: state.gitLifecycle?.remediationReserve ?? [],
          // Populated only after this host refused named paths. It is the exact list the user must
          // approve, and the only list a replacement may replay as remediation_scope_expansion.
          blocked_write_paths: state.pendingScopeExpansion ?? [],
          cumulative_budget: "retain-consumed-spend" },
        // The host refuses a review dispatch that omits this exact evidence header, so it states the
        // accepted line forms here instead of relying on the caller to recall them.
        review_dispatch_contract: { required_prompt_lines: ["canonical_validation_exit: 0",
          `review_phase: <${SOURCE_REVIEW_PHASES.join(" | ")}>`,
          `risk_tags: [<nonempty subset of ${SOURCE_REVIEW_RISK_TAGS.join(", ")}>]`],
          invalid_review_phase_values: ["SourceReview"] },
        next_action: awaitingAcceptanceNextAction } : {}),
      ...(failedAcceptanceUnit === undefined ? {} : { acceptance_remediation: {
        failed_unit_id: failedAcceptanceUnit.unit.id,
        failed_criteria: failedAcceptanceUnit.unit.acceptance_indices.slice(0, 64).map(index => ({ index, criterion: state.acceptance[index] })),
        failed_evidence: failedEvidence === undefined ? null : { command: failedEvidence.command.slice(0, 8),
          outcome: failedEvidence.outcome, exit_code: failedEvidence.exitCode },
      } }),
      ...(state.contractRepair === null ? {} : {
        next_action: "repair the approved contract write scope or cleanup sequence; do not use resume evidence or redispatch this run",
      }),
      ...(repairValidationRetryAvailable ? {
        next_action: `call ${this.profile.toolPrefix}resume_operator once with this run_id and acceptance_fingerprint; native proof is preferred, otherwise the same validation-only worker Task is returned`,
      } : {}),
      ...(hostReconciliationRequired ? {
        next_action: `call ${this.profile.toolPrefix}resume_operator once with this run_id and acceptance_fingerprint; if it returns a Task, dispatch that exact Task in this turn`,
      } : {}),
      ...(processReplacement ? {
        next_action: `this immutable run is not resumable: call ${this.profile.toolPrefix}cancel_operator with reason=plain, then call ${this.profile.toolPrefix}prepare_operator for a replacement run under the same goal; copy this packet's acceptance array verbatim, retain consumed cumulative budget, and repair only the read, write, preparation, and validation contract required by that acceptance; do not call resume_operator again or claim evidence`,
      } : {}),
      ...(acceptanceRemediation || reviewRemediation ? { next_action: remediationNextAction } : {}),
      ...(state.repairResidualPaths.length === 0 ? {} : { repair_residual_paths: state.repairResidualPaths }),
      ...(state.phase === "cancelled" && state.decision === "operator-contract-repair-unavailable-after-cancel" &&
        state.repairResidualPaths.length > 0 ? { next_action: `delete exactly the repair_residual_paths entries listed in this packet, then call ${this.profile.toolPrefix}prepare_operator with an approved replacement plan for the same goal and exact acceptance; copy this packet's acceptance array verbatim, declare those paths inside the replacement write scope or its cleanup sequence, and retain consumed budget` } : {}),
      units: state.units.map(unit => ({
        id: unit.unit.id, status: unit.status, child_session_id: unit.childSessionID, result_class: unit.resultClass,
         task_ref: unit.status === "pending" ? (unit.repairValidation === null ? this.workerTask(state, unit).prompt : this.repairWorkerTask(state, unit).prompt) : null,
        handoff_path: unit.handoffPath, operation_manifest_path: unit.manifestPath,
        scope_read: unit.unit.read, scope_write: unit.unit.write, validation: unit.unit.validation,
        acceptance_indices: unit.unit.acceptance_indices,
        evidence: unit.evidence.map(item => ({ id: item.evidence_id, criteria: item.measurement.criterion_ids,
          candidate: item.identity.candidate, command: item.execution.command, outcome: item.execution.outcome, exit_code: item.execution.exit_code })),
          repair_validation: unit.repairValidation === null ? null : { repair_fingerprint: unit.repairValidation.repair_fingerprint,
            remaining_validation: unit.repairValidation.commands.slice(unit.repairValidation.next_index) },
          repair_validation_attempts: unit.repairValidationAttempts,
         unproven: unit.status !== "succeeded",
      })), final_acceptance: state.receipt?.status ?? "coordinator-required" };
    if (Buffer.byteLength(JSON.stringify(packet)) > OPERATOR_LIMITS.packetBytes) throw new Error("operator-packet-too-large-no-evidence-truncated");
    return packet;
  }
  async continuationCheckpoint(root: string): Promise<string | undefined> {
    const state = await this.read(root);
    const cancelledRemediation = state?.phase === "cancelled" &&
      [ACCEPTANCE_REMEDIATION_DECISION, REVIEW_REMEDIATION_DECISION].includes(state.decision ?? "");
    if (!state || state.phase === "completed" || (state.phase === "cancelled" && !cancelledRemediation)) return undefined;
    const current = state.units.find(unit => unit.status !== "succeeded");
    return JSON.stringify({ authority: "durable-operator-state", root_session_id: state.rootSessionID,
      run_id: state.runID, generation: state.generation, sequence: state.sequence, plan_hash: state.planHash,
      status: state.phase, current_unit_id: current?.unit.id ?? null, current_unit_status: current?.status ?? null,
       next_task_ref: current?.status === "pending" ? (state.units.length > 1
         ? state.operatorSessionID === null ? this.dispatchTask(state).prompt : null
         : current.repairValidation === null ? this.workerTask(state, current).prompt : this.repairWorkerTask(state, current).prompt) : null,
         next_action: state.decision === ACCEPTANCE_REMEDIATION_DECISION || state.decision === REVIEW_REMEDIATION_DECISION
          ? `call ${this.profile.toolPrefix}operator_status and execute its cancel-then-replacement next_action in this turn; do not stop after reporting status or call resume_operator`
         : state.phase === "awaiting-acceptance" ? `call ${this.profile.toolPrefix}operator_status and follow its independent-review next_action; do not complete before review disposition`
         : state.phase === "prepared" ? "call operator_status, then operator_next; dispatch only the exact returned Task"
        : state.phase === "running" ? "call operator_status; do not duplicate the running Task"
          : state.phase === "cancelled"
            ? `call ${this.profile.toolPrefix}operator_status and execute its prepare_operator next_action in this turn; do not stop after reporting status`
            : `call ${this.profile.toolPrefix}operator_status and execute its exact next_action in this turn; do not stop after reporting status` });
  }
  private async verifyControls(unit: UnitState): Promise<void> {
    if (!isAbsolute(unit.handoffPath) || !isAbsolute(unit.manifestPath)) throw new Error("operator-control-path-invalid");
    const declaration = /^goal_declaration_path: (.+)$/m.exec(unit.task.prompt)?.[1];
    if (!declaration || !isAbsolute(declaration)) throw new Error("operator-declaration-path-invalid");
    const contents = await Promise.all([unit.handoffPath, unit.manifestPath, declaration].map(file => readFile(file, "utf8")));
    if (contents.some((value, index) => hash(value) !== unit.hashes[index])) throw new Error("operator-contract-changed");
  }
  /** Follow only the host's authorized parent-link repair; keep the durable control pin in sync. */
  acknowledgeHostHandoffRepair(root: string, taskID: string, path: string, original: string, repaired: string): Promise<void> {
    return this.serial(root, async () => {
      const state = await this.read(root);
      const unit = state?.units.find(candidate => candidate.status === "running" && candidate.handoffPath === path &&
        /^task_id: (.+)$/m.exec(candidate.task.prompt)?.[1] === taskID);
      if (!unit) return; // The same host repair also serves non-Operator handoffs.
      if (hash(original) !== unit.hashes[0] || await readFile(path, "utf8") !== repaired) {
        throw new Error("operator-host-handoff-repair-unpinned");
      }
      const before = JSON.parse(original), after = JSON.parse(repaired);
      const oldLink = inspectAcceptanceContinuity(before).ledger;
      const newLink = inspectAcceptanceContinuity(after).ledger;
      if (!oldLink || !newLink || oldLink.task_id !== taskID || oldLink.parent_fingerprint !== "none" ||
        newLink.task_id !== taskID || newLink.fingerprint !== oldLink.fingerprint ||
        newLink.parent_fingerprint === "none" ||
        JSON.stringify({ ...before, ext: { ...before.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]:
          { ...oldLink, parent_fingerprint: newLink.parent_fingerprint } } }, null, 2) + "\n" !== repaired) {
        throw new Error("operator-host-handoff-repair-invalid");
      }
      unit.hashes = [hash(repaired), ...unit.hashes.slice(1)];
      await this.save(state!);
    });
  }
  private gitPaths(output: string): string[] {
    return output.split("\0").filter(Boolean).map(path => normalizeRelativePath(path.replaceAll("\\", "/")));
  }
  private pathAuthorized(path: string, scopes: readonly string[]): boolean {
    return operatorGitPathAuthorized(path, scopes);
  }
  /**
   * Persist the exact paths a remediation write-scope rejection refused. The root reports them to the
   * user; only these may later reappear as remediation_scope_expansion.
   */
  private async recordPendingScopeExpansion(parent: OperatorState, paths: readonly string[], scopeApprovalTurnID?: string): Promise<void> {
    const recorded = [...new Set(paths)].slice(0, OPERATOR_LIMITS.remediationReserve);
    const approvalTurnID = typeof scopeApprovalTurnID === "string" && scopeApprovalTurnID.length > 0 ? scopeApprovalTurnID : null;
    if (JSON.stringify(parent.pendingScopeExpansion ?? []) === JSON.stringify(recorded) &&
        (parent.pendingScopeExpansionApprovalTurnID ?? null) === approvalTurnID) return;
    parent.pendingScopeExpansion = recorded;
    parent.pendingScopeExpansionApprovalTurnID = approvalTurnID;
    await this.save(parent);
  }
  /**
   * Accept a declared expansion only when the parent durably recorded every path as refused. An
   * undeclared or invented entry is a contract error, not a silently narrowed grant.
   */
  private authorizedScopeExpansion(parent: OperatorState, declared: readonly string[] | undefined,
    scopeApprovalTurnID?: string): readonly string[] {
    if (declared === undefined || declared.length === 0) return [];
    const pending = parent.pendingScopeExpansion ?? [];
    const unrecorded = declared.filter(path => !pending.includes(path));
    if (pending.length === 0 || unrecorded.length > 0) {
      return contractError({ document: "plan", pointer: "/git_lifecycle/remediation_scope_expansion",
        code: "operator-remediation-scope-expansion-unrecorded",
        rule: "expansion-must-name-only-host-reported-refused-paths", repair_kind: "repair-field",
        repair_paths: unrecorded.slice(0, OPERATOR_LIMITS.remediationReserve) });
    }
    const omitted = pending.filter(path => !declared.includes(path));
    if (omitted.length > 0) {
      return contractError({ document: "plan", pointer: "/git_lifecycle/remediation_scope_expansion",
        code: "operator-remediation-scope-expansion-incomplete",
        rule: "expansion-must-name-the-exact-host-reported-refused-path-list", repair_kind: "repair-field",
        repair_paths: omitted.slice(0, OPERATOR_LIMITS.remediationReserve) });
    }
    const recordedAt = parent.pendingScopeExpansionApprovalTurnID;
    if (typeof recordedAt !== "string" || recordedAt.length === 0 ||
        typeof scopeApprovalTurnID !== "string" || scopeApprovalTurnID.length === 0 || scopeApprovalTurnID === recordedAt) {
      return contractError({ document: "plan", pointer: "/git_lifecycle/remediation_scope_expansion",
        code: "operator-remediation-scope-expansion-approval-required",
        rule: "expansion-requires-a-later-real-user-turn-with-host-approval-authority", repair_kind: "repair-field",
        repair_paths: declared.slice(0, OPERATOR_LIMITS.remediationReserve) });
    }
    return declared;
  }
  private gitAcceptanceReadiness(state: OperatorState): string | null {
    const lifecycle = state.gitLifecycle;
    if (lifecycle === null) return null;
    if (lifecycle.committedHead === null) return "operator-git-post-commit-boundary-missing";
    const evidence = state.units.flatMap(unit => unit.evidence);
    return lifecycle.postCommitValidation.every(command => evidence.some(item => item.execution.exit_code === 0 &&
      item.execution.command.length === 1 && normalizeCommand(item.execution.command[0]!) === command)) ? null : "operator-git-post-commit-evidence-missing";
  }
  beforePostCommitValidation(root: string, actor: string, command: string): Promise<boolean> {
    return this.serial(root, async () => {
      const state = await this.required(root), lifecycle = state.gitLifecycle;
      if (lifecycle === null) return false;
      const identity = normalizeCommand(command);
      if (!lifecycle.postCommitValidation.includes(identity)) {
        if (lifecycle.committedHead !== null) throw new Error("operator-git-post-commit-command-denied");
        return false;
      }
      const finalUnit = state.units.at(-1)!;
      if (finalUnit.status !== "running" || finalUnit.childSessionID !== actor ||
          state.units.slice(0, -1).some(unit => unit.status !== "succeeded")) throw new Error("operator-git-post-commit-boundary-not-ready");
      if (lifecycle.committedHead === null) await this.finalizeGitLifecycle(state);
      if (finalUnit.repairValidation !== null) {
        finalUnit.repairValidation.candidate_fingerprint = await this.repairValidationCandidateFingerprint(state);
      }
      await this.save(state);
      return true;
    });
  }
  preflightPostCommitValidation(root: string, actor: string, command: string): Promise<boolean> {
    return this.serial(root, async () => {
      const state = await this.required(root), lifecycle = state.gitLifecycle;
      if (lifecycle === null) return false;
      const identity = normalizeCommand(command);
      if (!lifecycle.postCommitValidation.includes(identity)) {
        if (lifecycle.committedHead !== null) throw new Error("operator-git-post-commit-command-denied");
        return false;
      }
      const finalUnit = state.units.at(-1)!;
      if (finalUnit.status !== "running" || finalUnit.childSessionID !== actor ||
          state.units.slice(0, -1).some(unit => unit.status !== "succeeded")) throw new Error("operator-git-post-commit-boundary-not-ready");
      if (lifecycle.committedHead === null) await this.currentAuthorizedGitChanges(state);
      return true;
    });
  }
  postCommitLocked(root: string): Promise<boolean> {
    return this.read(root).then(state => state !== undefined && state.gitLifecycle !== null && state.gitLifecycle.committedHead !== null);
  }
  private async currentAuthorizedGitChanges(state: OperatorState): Promise<readonly string[]> {
    const scopes = state.gitLifecycle?.writeUnion ?? [];
    const staged = this.gitPaths((await this.git(["diff", "--cached", "--name-only", "--no-renames", "-z"])).stdout);
    const unstaged = this.gitPaths((await this.git(["diff", "--name-only", "--no-renames", "-z"])).stdout);
    const untracked = this.gitPaths((await this.git(["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
    const changed = [...new Set([...staged, ...unstaged, ...untracked])].sort();
    const outside = changed.filter(path => !this.pathAuthorized(path, scopes));
    if (outside.length > 0) {
      const mode = (path: string): string => [staged.includes(path) ? "staged" : "", unstaged.includes(path) ? "unstaged" : "",
        untracked.includes(path) ? "untracked" : ""].filter(Boolean).join("+");
      throw new OperatorContractError(outside.map(path => ({ document: "plan", pointer: `/units/${state.units.length - 1}/write`,
        unit_index: state.units.length - 1, code: "operator-git-change-outside-write-union",
        rule: "all-persistent-and-transient-outputs-declared-or-explicitly-cleaned-before-validation", repair_kind: "repair-field",
        repair_paths: [path], expected: mode(path) })));
    }
    return changed;
  }
  private async assertRemovedRepairPathsAbsent(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      try { await lstat(resolve(this.projectRoot, path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new Error("operator-contract-repair-transient-returned");
    }
  }
  private async repairValidationCandidateFingerprint(state: OperatorState): Promise<string> {
    const lifecycle = state.gitLifecycle;
    if (lifecycle === null) throw new Error("operator-contract-repair-validation-git-lifecycle-missing");
    const currentRef = (await this.git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
    if (currentRef !== `refs/heads/${lifecycle.branch}`) throw new Error("operator-git-branch-changed");
    const currentHead = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (lifecycle.committedHead !== null && currentHead !== lifecycle.committedHead) {
      throw new Error("operator-contract-repair-validation-head-changed");
    }
    const changed = await this.currentAuthorizedGitChanges(state);
    if (lifecycle.committedHead !== null && changed.length > 0) throw new Error("operator-contract-repair-validation-candidate-dirty");
    const files = await Promise.all(changed.map(async path => {
      try {
        const stat = await lstat(resolve(this.projectRoot, path));
        const blob = (await this.git(["hash-object", "--no-filters", "--", path])).stdout.trim();
        return { path, mode: stat.mode, size: stat.size, blob };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, absent: true };
        throw error;
      }
    }));
    return `sha256:${hash(JSON.stringify({ branch: lifecycle.branch, head: currentHead,
      committed_head: lifecycle.committedHead, files }))}`;
  }
  private async finalizeGitLifecycle(state: OperatorState): Promise<void> {
    const lifecycle = state.gitLifecycle;
    if (lifecycle === null || lifecycle.committedHead !== null) return;
    const currentRef = (await this.git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
    if (currentRef !== `refs/heads/${lifecycle.branch}`) throw new Error("operator-git-branch-changed");
    const currentHead = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const scopes = lifecycle.writeUnion;
    const ancestor = await this.git(["merge-base", "--is-ancestor", lifecycle.startOID, currentHead], [0, 1, 128]);
    if (ancestor.exit !== 0) throw new Error("operator-git-history-not-descendant");
    const commits = (await this.git(["rev-list", "--reverse", "--topo-order", `${lifecycle.startOID}..${currentHead}`])).stdout
      .split(/\r?\n/u).filter(Boolean);
    if (commits.length > 256) throw new Error("operator-git-history-too-large");
    for (const commit of commits) await this.assertCommitPathsAuthorized(commit, scopes);
    const changed = await this.currentAuthorizedGitChanges(state);
    if (changed.length === 0) {
      if (currentHead === lifecycle.startOID) {
        if (!await this.inheritParentCommit(state, currentHead)) throw new Error("operator-git-empty-commit-refused");
        return;
      }
      if (state.remediationParent !== null) throw new Error("operator-git-remediation-head-drift");
      lifecycle.committedHead = currentHead;
      lifecycle.commitProvenance = "existing-history";
      return;
    }
    await this.git(["add", "--", ...changed]);
    const cached = this.gitPaths((await this.git(["diff", "--cached", "--name-only", "--no-renames", "-z"])).stdout).sort();
    if (JSON.stringify(cached) !== JSON.stringify(changed)) {
      await this.git(["restore", "--staged", "--", ...changed]).catch(() => undefined);
      throw new Error("operator-git-staged-set-mismatch");
    }
    try { await this.git(["commit", "-m", lifecycle.commitMessage], [0], { ...process.env,
      GIT_AUTHOR_NAME: "Sortie Dogs", GIT_AUTHOR_EMAIL: "sortie-dogs@localhost",
      GIT_COMMITTER_NAME: "Sortie Dogs", GIT_COMMITTER_EMAIL: "sortie-dogs@localhost" }); }
    catch (error) {
      await this.git(["restore", "--staged", "--", ...changed]).catch(() => undefined);
      throw error;
    }
    const committedHead = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (committedHead === currentHead || !await this.cleanStatus()) throw new Error("operator-git-commit-postcondition-failed");
    const committed = this.gitPaths((await this.git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", committedHead])).stdout).sort();
    if (JSON.stringify(committed) !== JSON.stringify(changed)) throw new Error("operator-git-commit-scope-mismatch");
    lifecycle.committedHead = committedHead;
    lifecycle.commitProvenance = "host-created";
  }
  /** Whether every commit between the lifecycle start and head touches only authorized paths. */
  private async authorizedHistory(lifecycle: OperatorGitLifecycleState, head: string): Promise<boolean> {
    if ((await this.git(["merge-base", "--is-ancestor", lifecycle.startOID, head], [0, 1, 128])).exit !== 0) return false;
    const commits = (await this.git(["rev-list", "--reverse", "--topo-order", `${lifecycle.startOID}..${head}`])).stdout
      .split(/\r?\n/u).filter(Boolean);
    if (commits.length === 0 || commits.length > 256) return false;
    for (const commit of commits) {
      try { await this.assertCommitPathsAuthorized(commit, lifecycle.writeUnion); }
      catch { return false; }
    }
    return true;
  }
  private async assertCommitPathsAuthorized(commit: string, scopes: readonly string[]): Promise<void> {
    const lineage = (await this.git(["rev-list", "--parents", "-n", "1", commit])).stdout.trim().split(/\s+/u);
    const parents = lineage.slice(1);
    if (parents.length === 0) throw new Error("operator-git-history-root-commit-refused");
    for (const parent of parents) {
      const paths = this.gitPaths((await this.git(["diff", "--name-only", "--no-renames", "-z", parent, commit])).stdout);
      if (paths.some(path => !this.pathAuthorized(path, scopes))) throw new Error("operator-git-history-outside-write-union");
    }
  }
  private async inheritParentCommit(state: OperatorState, currentHead: string): Promise<boolean> {
    const lifecycle = state.gitLifecycle, parent = state.remediationParent;
    if (lifecycle === null || parent === null || state.parentRunID === null || parent.runID === undefined ||
        parent.acceptanceFingerprint === undefined || parent.approvedWriteUnion === undefined ||
        parent.commitMessage === undefined || parent.commitProvenance === undefined) return false;
    if (parent.runID !== state.parentRunID || !parent.taskID.startsWith(`${parent.runID}-`) ||
        parent.committedHead !== lifecycle.startOID || currentHead !== parent.committedHead ||
        parent.acceptanceFingerprint !== state.acceptanceFingerprint) {
      throw new Error("operator-git-inherited-commit-lineage-invalid");
    }
    // Remediation may write inside the reserve and any consented expansion, so the inherited-commit
    // check uses the same union the replacement plan was admitted against.
    const approvedWriteUnion = [...parent.approvedWriteUnion, ...(parent.approvedRemediationReserve ?? [])];
    if (!approvedWriteUnion.length || lifecycle.writeUnion.some(path => !this.pathAuthorized(path, approvedWriteUnion))) {
      throw new Error("operator-git-inherited-commit-scope-invalid");
    }
    if (!["host-created", "inherited-parent"].includes(parent.commitProvenance) ||
        (await this.git(["show", "-s", "--format=%s", parent.committedHead])).stdout.trim() !== parent.commitMessage) {
      throw new Error("operator-git-inherited-commit-provenance-invalid");
    }
    await this.assertCommitPathsAuthorized(parent.committedHead, approvedWriteUnion);
    lifecycle.committedHead = lifecycle.startOID;
    lifecycle.commitProvenance = "inherited-parent";
    return true;
  }
}
