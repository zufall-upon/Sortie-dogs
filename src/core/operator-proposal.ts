import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeProfile } from "./runtime-profile.js";
import { normalizeRelativePath } from "./path.js";
import { OperatorContractError, parseOperatorPlan, type OperatorContractDiagnostic, type OperatorPlan, type OperatorTask } from "./operator-runtime.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\r\n]/u.test(value);
const ORIGINAL_REQUEST_MAX_CHARACTERS = 128 * 1024;
const ORIGINAL_REQUEST_MAX_BYTES = 128 * 1024;
export const DEFAULT_OPERATOR_PROPOSAL_BUDGET = Object.freeze({ max_reads: 45, max_submissions: 9 });
export const OPERATOR_PROPOSAL_BUDGET_CAPS = Object.freeze({ max_reads: 192, max_submissions: 24 });
const OPERATOR_APPROVAL_IDENTITY_FIELDS = ["proposal_id", "revision", "content_hash", "compared_requirement_ids", "decision"] as const;
const OPERATOR_APPROVAL_RATIONALE_FIELDS = ["rationale", "comparison_rationale"] as const;
export const OPERATOR_APPROVAL_CONTRACT = "approval_json must encode one JSON object using exactly one six-field shape. " +
  'Canonical fields and types: proposal_id:string, revision:integer equal to the current positive proposal revision (for example "revision":2, never "revision":"2"), ' +
  'content_hash:string, compared_requirement_ids:string[], decision:literal "approve", rationale:nonblank single-line string. ' +
  "Legacy alternate: replace rationale with comparison_rationale; never send both. No schema_version, metadata, nested wrapper, missing field, extra key, alias, or type coercion. " +
  "Invalid shape returns bounded field diagnostics without approval, preparation, or budget effects; proposal identity mismatches remain denied. " +
  "Before approval, compare the proposal with observed authoritative build instructions and capability claims: every necessary generator, build, formatter, and exact cleanup command must appear in execution order before post-commit or canonical criterion tests in unit.validation; every required input must be in unit.read and every persistent or transient generated output in unit.write. Cleanup may remove only declared unit.write outputs; never approve an arbitrary ignore rule or removal of an undeclared path. " +
  "This is a root semantic checklist, not a host claim that static contract parsing detects every build dependency.";
const originalRequestText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 &&
  value.length <= ORIGINAL_REQUEST_MAX_CHARACTERS && Buffer.byteLength(value, "utf8") <= ORIGINAL_REQUEST_MAX_BYTES;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const exactSet = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const jsonType = (value: unknown): "array" | "boolean" | "integer" | "null" | "number" | "object" | "string" | "undefined" =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number"
    ? Number.isSafeInteger(value) ? "integer" : "number"
    : typeof value as "boolean" | "object" | "string" | "undefined";
const proposalError = (pointer: string, code: string, rule: string,
  extra: Partial<Pick<OperatorContractDiagnostic, "repair_paths" | "expected" | "actual_type">> = {}): never => {
  throw new OperatorContractError([{ document: "proposal", pointer, code, rule, repair_kind: "repair-field", ...extra }]);
};
const pointerToken = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");
type OperatorApproval = { readonly proposal_id: string; readonly revision: number; readonly content_hash: string;
  readonly compared_requirement_ids: readonly string[]; readonly decision: "approve"; readonly rationale: string };
function parseApproval(value: unknown): OperatorApproval {
  if (!record(value)) {
    throw new OperatorContractError([{ document: "approval", pointer: "/", code: "operator-proposal-approval-shape-invalid",
      rule: "object", repair_kind: "repair-field", expected: "object", actual_type: jsonType(value) }]);
  }
  const diagnostics: OperatorContractDiagnostic[] = [];
  const allowed = new Set<string>([...OPERATOR_APPROVAL_IDENTITY_FIELDS, ...OPERATOR_APPROVAL_RATIONALE_FIELDS]);
  for (const key of Object.keys(value).filter(key => !allowed.has(key)).sort()) {
    diagnostics.push({ document: "approval", pointer: `/${pointerToken(key)}`, code: "operator-proposal-approval-field-unknown",
      rule: "unknown-field", repair_kind: "repair-field", repair_paths: [`/${pointerToken(key)}`] });
  }
  for (const key of OPERATOR_APPROVAL_IDENTITY_FIELDS) if (!Object.hasOwn(value, key)) {
    diagnostics.push({ document: "approval", pointer: `/${key}`, code: "operator-proposal-approval-field-required",
      rule: "required", repair_kind: "repair-field", repair_paths: [`/${key}`] });
  }
  const rationaleFields = OPERATOR_APPROVAL_RATIONALE_FIELDS.filter(key => Object.hasOwn(value, key));
  if (rationaleFields.length === 0) {
    diagnostics.push({ document: "approval", pointer: "/rationale", code: "operator-proposal-approval-field-required",
      rule: "rationale-or-comparison-rationale-required", repair_kind: "repair-field", repair_paths: ["/rationale"] });
  } else if (rationaleFields.length > 1) {
    diagnostics.push({ document: "approval", pointer: "/comparison_rationale", code: "operator-proposal-approval-rationale-conflict",
      rule: "exactly-one-rationale-field", repair_kind: "repair-field", repair_paths: ["/comparison_rationale"] });
  }
  const typeDiagnostic = (key: string, expected: string): void => {
    diagnostics.push({ document: "approval", pointer: `/${key}`, code: "operator-proposal-approval-field-invalid",
      rule: expected, repair_kind: "repair-field", repair_paths: [`/${key}`], expected, actual_type: jsonType(value[key]) });
  };
  if (Object.hasOwn(value, "proposal_id") && typeof value.proposal_id !== "string") typeDiagnostic("proposal_id", "string");
  if (Object.hasOwn(value, "revision") && !Number.isSafeInteger(value.revision)) typeDiagnostic("revision", "integer");
  if (Object.hasOwn(value, "content_hash") && typeof value.content_hash !== "string") typeDiagnostic("content_hash", "string");
  if (Object.hasOwn(value, "compared_requirement_ids") &&
      (!Array.isArray(value.compared_requirement_ids) || !value.compared_requirement_ids.every(item => typeof item === "string"))) {
    typeDiagnostic("compared_requirement_ids", "string-array");
  }
  if (Object.hasOwn(value, "decision") && value.decision !== "approve") typeDiagnostic("decision", 'literal-"approve"');
  for (const key of rationaleFields) if (!text(value[key])) typeDiagnostic(key, "nonblank-single-line-string");
  if (diagnostics.length > 0) throw new OperatorContractError(diagnostics);
  const rationale = value[rationaleFields[0]!] as string;
  return { proposal_id: value.proposal_id as string, revision: value.revision as number, content_hash: value.content_hash as string,
    compared_requirement_ids: value.compared_requirement_ids as string[], decision: "approve", rationale };
}
const OPERATOR_PROPOSAL_TASK_REFERENCE = "SORTIE_OPERATOR_PROPOSAL_TASK_REF";
const proposalID = (intentID: string, revision: number, proposalHash: string): string =>
  `proposal-${hash(JSON.stringify([intentID, revision, proposalHash])).slice(0, 24)}`;
const normalizedRelativePath = (value: unknown): value is string => {
  if (!text(value)) return false;
  try { return normalizeRelativePath(value) === value; }
  catch { return false; }
};

export interface OperatorIntentRequirement { readonly id: string; readonly text: string; readonly kind: "requirement" | "negative" | "quality" }
export interface OperatorIntent {
  readonly schema_version: "0.1";
  readonly original_request: { readonly text: string; readonly source_ref: string };
  readonly requirements: readonly OperatorIntentRequirement[];
  readonly authoritative_refs: readonly string[];
  readonly allow_read: readonly string[];
  readonly proposal_budget: { readonly max_reads: number; readonly max_submissions: number };
}
export interface OperatorProposalPacket {
  readonly schema_version: "0.1";
  readonly revision: number;
  readonly coverage: readonly { readonly requirement_id: string; readonly approach: string; readonly validation: string }[];
  /** Existing constructs each covered requirement must intercept, each one read during this investigation. */
  readonly existing_surface: readonly { readonly requirement_id: string; readonly path: string; readonly form: string }[];
  readonly uncovered: readonly { readonly requirement_id: string; readonly reason: string }[];
  readonly negative_handling: readonly { readonly requirement_id: string; readonly handling: string }[];
  readonly read_scope: readonly string[];
  readonly write_scope: readonly string[];
  readonly budget_estimate: { readonly proposal_reads: number; readonly execution_units: number };
  readonly plan: OperatorPlan;
}
export interface OperatorProposalGoalBinding {
  readonly goal_id: string;
  readonly revision: number;
  readonly scope_epoch: number;
  readonly acceptance_fingerprint: string;
}
export interface OperatorProposalState {
  readonly schema_version: "0.1";
  readonly profile: string;
  readonly root_session_id: string;
  readonly intent_id: string;
  readonly intent_hash: string;
  readonly intent: OperatorIntent;
  goal_binding: OperatorProposalGoalBinding | null;
  readonly created_at: string;
  phase: "investigating" | "submitted" | "approved";
  proposal_call_id: string | null;
  proposal_session_id: string | null;
  read_count: number;
  /** Project-relative paths this investigation actually opened, used to check surface claims. */
  read_paths: string[];
  submission_count: number;
  proposal_id: string | null;
  proposal_revision: number | null;
  proposal_hash: string | null;
  proposal: OperatorProposalPacket | null;
  approval_rationale: string | null;
}

function parseIntent(value: unknown): OperatorIntent {
  const proposalBudget = record(value) && Object.hasOwn(value, "proposal_budget")
    ? value.proposal_budget
    : DEFAULT_OPERATOR_PROPOSAL_BUDGET;
  if (!record(value) || !exact(value, ["schema_version", "original_request", "requirements", "authoritative_refs", "allow_read", "proposal_budget"]) || value.schema_version !== "0.1" ||
      !record(value.original_request) || !exact(value.original_request, ["text", "source_ref"]) || !originalRequestText(value.original_request.text) || !text(value.original_request.source_ref) ||
      !Array.isArray(value.requirements) || value.requirements.length === 0 || value.requirements.length > 64 ||
      !Array.isArray(value.authoritative_refs) || !value.authoritative_refs.every(text) || !Array.isArray(value.allow_read) || value.allow_read.length === 0 ||
      !value.allow_read.every(normalizedRelativePath) || !record(proposalBudget) ||
      !exact(proposalBudget, ["max_reads", "max_submissions"]) || !Number.isSafeInteger(proposalBudget.max_reads) ||
      (proposalBudget.max_reads as number) < 1 || (proposalBudget.max_reads as number) > OPERATOR_PROPOSAL_BUDGET_CAPS.max_reads ||
      !Number.isSafeInteger(proposalBudget.max_submissions) || (proposalBudget.max_submissions as number) < 1 ||
      (proposalBudget.max_submissions as number) > OPERATOR_PROPOSAL_BUDGET_CAPS.max_submissions) {
    throw new Error("operator-intent-invalid");
  }
  const ids = new Set<string>();
  for (const requirement of value.requirements) {
    if (!record(requirement) || !exact(requirement, ["id", "text", "kind"]) || !identifier(requirement.id) || ids.has(requirement.id) ||
        !text(requirement.text) || !["requirement", "negative", "quality"].includes(String(requirement.kind))) throw new Error("operator-intent-requirement-invalid");
    ids.add(requirement.id);
  }
  return { ...structuredClone(value), proposal_budget: { ...proposalBudget } } as unknown as OperatorIntent;
}

function parsePacket(value: unknown, state: OperatorProposalState): OperatorProposalPacket {
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error("operator-proposal-too-large");
  if (!record(value) || !exact(value, ["schema_version", "revision", "coverage", "existing_surface", "uncovered", "negative_handling", "read_scope", "write_scope", "budget_estimate", "plan"])) {
    return proposalError("/", "operator-proposal-invalid", "proposal-fields");
  }
  if (value.schema_version !== "0.1") return proposalError("/schema_version", "operator-proposal-invalid", "schema-version", { repair_paths: ["/schema_version"] });
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    return proposalError("/revision", "operator-proposal-revision-invalid", "positive-integer",
      { repair_paths: ["/revision"], expected: "positive-integer", actual_type: jsonType(value.revision) });
  }
  if (!Array.isArray(value.coverage) || !Array.isArray(value.uncovered) || !Array.isArray(value.negative_handling) ||
      !Array.isArray(value.read_scope) || !value.read_scope.every(normalizedRelativePath) ||
      !Array.isArray(value.write_scope) || !value.write_scope.every(normalizedRelativePath) || !record(value.budget_estimate) ||
      !exact(value.budget_estimate, ["proposal_reads", "execution_units"]) || !Number.isSafeInteger(value.budget_estimate.proposal_reads) || !Number.isSafeInteger(value.budget_estimate.execution_units)) {
    return proposalError("/", "operator-proposal-invalid", "proposal-fields");
  }
  const requirementIDs = new Set(state.intent.requirements.map(item => item.id));
  const coverageIDs = new Set<string>(), uncoveredIDs = new Set<string>();
  for (const item of value.coverage) {
    if (!record(item) || !exact(item, ["requirement_id", "approach", "validation"]) || !identifier(item.requirement_id) ||
        !requirementIDs.has(item.requirement_id) || coverageIDs.has(item.requirement_id) || !text(item.approach) || !text(item.validation)) throw new Error("operator-proposal-coverage-invalid");
    coverageIDs.add(item.requirement_id);
  }
  // A constraint on an existing construct only holds if every existing form reaching it was identified in
  // the real source before the contract froze. Each claim must name a path this investigation actually read,
  // so a covered requirement can never rest on the request's wording alone.
  if (!Array.isArray(value.existing_surface)) return proposalError("/existing_surface", "operator-proposal-invalid", "proposal-fields");
  const surfaced = new Set<string>();
  for (const item of value.existing_surface) {
    if (!record(item) || !exact(item, ["requirement_id", "path", "form"]) || !identifier(item.requirement_id) ||
        !coverageIDs.has(item.requirement_id) || !normalizedRelativePath(item.path) || !text(item.form)) {
      throw new Error("operator-proposal-existing-surface-invalid");
    }
    if (!state.read_paths.includes(item.path)) throw new Error("operator-proposal-existing-surface-unread");
    surfaced.add(item.requirement_id);
  }
  if ([...coverageIDs].some(id => !surfaced.has(id))) throw new Error("operator-proposal-existing-surface-incomplete");
  for (const item of value.uncovered) {
    if (!record(item) || !exact(item, ["requirement_id", "reason"]) || !identifier(item.requirement_id) || !requirementIDs.has(item.requirement_id) ||
        coverageIDs.has(item.requirement_id) || uncoveredIDs.has(item.requirement_id) || !text(item.reason)) throw new Error("operator-proposal-uncovered-invalid");
    uncoveredIDs.add(item.requirement_id);
  }
  if ([...requirementIDs].some(id => !coverageIDs.has(id) && !uncoveredIDs.has(id))) throw new Error("operator-proposal-requirement-coverage-incomplete");
  const negativeIDs = new Set(state.intent.requirements.filter(item => item.kind === "negative").map(item => item.id));
  const handled = new Set<string>();
  for (const item of value.negative_handling) {
    if (!record(item) || !exact(item, ["requirement_id", "handling"]) || !identifier(item.requirement_id) || !negativeIDs.has(item.requirement_id) || handled.has(item.requirement_id) || !text(item.handling)) throw new Error("operator-proposal-negative-handling-invalid");
    handled.add(item.requirement_id);
  }
  if ([...negativeIDs].some(id => !handled.has(id))) throw new Error("operator-proposal-negative-handling-incomplete");
  const allowed = state.intent.allow_read;
  if ((value.read_scope as string[]).some(scope => !allowed.some(prefix => scope === prefix || scope.startsWith(`${prefix}/`)))) throw new Error("operator-proposal-read-scope-expanded");
  const acceptance = state.intent.requirements.map(item => item.text);
  let rawPlan = value.plan;
  if (record(rawPlan)) {
    if (Object.hasOwn(rawPlan, "acceptance")) {
      if (!Array.isArray(rawPlan.acceptance) || rawPlan.acceptance.length !== acceptance.length ||
          rawPlan.acceptance.some((item, index) => item !== acceptance[index])) {
        throw new OperatorContractError([{ document: "plan", pointer: "/acceptance", code: "operator-proposal-acceptance-rewritten",
          rule: "omit-for-host-derived-exact-ordered-intent-requirements", repair_kind: "repair-field", repair_paths: ["/acceptance"] }]);
      }
    } else {
      rawPlan = { ...rawPlan, acceptance };
    }
  }
  const materialized = rawPlan === value.plan ? value : { ...value, plan: rawPlan };
  if (Buffer.byteLength(JSON.stringify(materialized)) > 128 * 1024) throw new Error("operator-proposal-too-large");
  const plan = parseOperatorPlan(rawPlan);
  const goalBudget = plan.goal_declaration.goal_budget_units;
  if (!Number.isSafeInteger(goalBudget) || (goalBudget as number) < plan.units.length + 1) {
    throw new Error("operator-proposal-goal-budget-insufficient");
  }
  if (plan.acceptance.length !== acceptance.length || plan.acceptance.some((item, index) => item !== acceptance[index])) throw new Error("operator-proposal-acceptance-rewritten");
  const writes = [...new Set(plan.units.flatMap(unit => unit.write))].sort();
  if (JSON.stringify([...new Set(value.write_scope as string[])].sort()) !== JSON.stringify(writes)) throw new Error("operator-proposal-write-scope-mismatch");
  if (value.budget_estimate.proposal_reads !== state.read_count || value.budget_estimate.execution_units !== plan.units.length) throw new Error("operator-proposal-budget-estimate-mismatch");
  return { ...structuredClone(materialized), plan } as unknown as OperatorProposalPacket;
}

/** Durable pre-execution lane. It grants investigation and submission, never source mutation or execution. */
export class OperatorProposalRuntime {
  private readonly states = new Map<string, OperatorProposalState>();
  private readonly pending = new Map<string, Promise<void>>();
  private async serial<T>(root: string, action: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(root) ?? Promise.resolve()).then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.pending.set(root, tail);
    try { return await result; }
    finally { if (this.pending.get(root) === tail) this.pending.delete(root); }
  }
  readonly projectRoot: string;
  constructor(projectRoot: string, readonly profile: RuntimeProfile) { this.projectRoot = resolve(projectRoot); }
  private file(root: string): string { return join(this.projectRoot, this.profile.stateDirectory, "operator-proposals", `${hash(root)}.json`); }
  async read(root: string): Promise<OperatorProposalState | undefined> {
    return this.serial(root, () => this.readUnlocked(root));
  }
  private async readUnlocked(root: string): Promise<OperatorProposalState | undefined> {
    const cached = this.states.get(root); if (cached) return structuredClone(cached);
    let source: string; try { source = await readFile(this.file(root), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const state = JSON.parse(source) as OperatorProposalState;
    if (state.schema_version !== "0.1" || state.profile !== this.profile.id || state.root_session_id !== root || hash(JSON.stringify(state.intent)) !== state.intent_hash) throw new Error("operator-proposal-state-invalid");
    state.goal_binding ??= null;
    state.read_paths = Array.isArray(state.read_paths) ? state.read_paths.filter(normalizedRelativePath) : [];
    if (state.phase === "investigating") {
      if (state.proposal !== null || state.proposal_id !== null || state.proposal_revision !== null || state.proposal_hash !== null) {
        throw new Error("operator-proposal-state-invalid");
      }
    } else if (state.phase === "submitted" || state.phase === "approved") {
      if (!state.proposal || !Number.isSafeInteger(state.proposal_revision)) throw new Error("operator-proposal-state-invalid");
      const proposalHash = hash(JSON.stringify(state.proposal));
      if (state.proposal_revision !== state.proposal.revision || state.proposal_hash !== proposalHash ||
          state.proposal_id !== proposalID(state.intent_id, state.proposal.revision, proposalHash)) {
        throw new Error("operator-proposal-state-invalid");
      }
    } else {
      throw new Error("operator-proposal-state-invalid");
    }
    this.states.set(root, state); return structuredClone(state);
  }
  private async save(state: OperatorProposalState): Promise<void> {
    const directory = join(this.projectRoot, this.profile.stateDirectory, "operator-proposals"); await mkdir(directory, { recursive: true });
    const temporary = `${this.file(state.root_session_id)}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 }); await rename(temporary, this.file(state.root_session_id)); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
    this.states.set(state.root_session_id, structuredClone(state));
  }
  task(state: OperatorProposalState): OperatorTask {
    return { subagent_type: this.profile.agentNames["dog-operator"], description: "承認前の調査と実行契約案作成",
      prompt: [`SORTIE_OPERATOR_PROPOSAL ${JSON.stringify({ root: state.root_session_id, intent_id: state.intent_id, intent_hash: state.intent_hash })}`,
        "同じdogs-coordinatorとして承認前調査だけを行う。許可read scope外、source編集、bash、Task、worker実行は禁止。",
        `original_request: ${state.intent.original_request.text}`, "ordered_requirements:", ...state.intent.requirements.map(item => `- ${item.id} [${item.kind}]: ${item.text}`),
        `authoritative_refs: ${JSON.stringify(state.intent.authoritative_refs)}`, `allow_read: ${JSON.stringify(state.intent.allow_read)}`,
        `proposal_budget: ${JSON.stringify(state.intent.proposal_budget)}`,
        "proposal packet fields: schema_version, revision, coverage[{requirement_id,approach,validation}], existing_surface[{requirement_id,path,form}], uncovered[{requirement_id,reason}], negative_handling[{requirement_id,handling}], read_scope, write_scope, budget_estimate{proposal_reads,execution_units}, plan{schema_version,acceptance_proof,source_refs,goal_declaration,units, optional git_lifecycle}. revisionは正のJSON整数。例: \"revision\":1。文字列\"revision\":\"1\"は禁止し、hostは型変換しない。plan.acceptanceは生成・提出せず省略し、hostがdurable intent.requirementsのtextを同順・完全一致でmaterializeする。legacy互換として明示する場合だけ同じ全文・順序を完全一致で使い、null・部分集合・並べ替え・空白/大小文字変更は禁止。acceptance_ids等の代替field禁止。",
        "schema_versionはpacketとplanの両方で必ず文字列\"0.1\"。coverageはnegative/qualityを含む全ordered requirement IDを各1回含める（未対応だけuncoveredへ移す）。全declared criterion IDをacceptance_proofから参照し、各unitのacceptance_indicesはnonempty、全acceptance indexとexact validation commandを既存parser規則どおり完全coverageする。",
        "plan.acceptance_proofは各acceptanceに対応するcriterion IDの配列を並べた二重配列。複数acceptanceを同じexact commandが証明する場合はcriterion IDを共有可で、acceptanceごとの固有criterion作成は不要。goal_declarationはobject。delivery_intent=\"implementation\", delivery_mode=\"mvp-first\", usable_path_established=false, controlled_change=false, goal_budget_unitsは正整数。criteria各要素はcriterion_idとvalidation_commandを持つ。",
        "goal_declaration.defaultsは必ずobjectで、target,entrypoint,workload,oracle_coverage(string array),build_boundary=\"not-applicable\",source,candidate,fixture,source_binding=\"current-protected\",candidate_binding=\"current-protected\",proof_scope=\"requested-full\",expected_outcome=\"pass\"を持つ。boolean fieldsやdefaultsを自然文/string/arrayへ変更禁止。goal_budget_unitsはproposal予約1 unitと全execution unitを収容するため1+plan.units.length以上。",
        "plan.units各要素のexact fieldsはid,title,objective,read,write,validation,acceptance_indices。read_scope/write_scopeやgoalという別名は禁止。budget_estimate.proposal_readsは推測したfile数でなく、このTaskで完了したRead tool call数。",
        "unit.validationはtestだけでなく実行順の完全なcommand列。観測したMakefile、言語のgenerator directive、repository script等から実装に必要なgenerator/build/format commandとexact cleanup commandを導出し、generator後、post-commitまたはcanonical criterion test前へ文字列完全一致で置く。必要inputはunit.read、永続・一時を問わず全generator outputはunit.writeへ含める。cleanupはunit.write宣言済みoutputだけを対象とし、任意ignore追加やundeclared path削除は禁止。特定generator名・一時file名を推測・hardcodeせず、未観測capabilityを主張しない。準備・cleanup command自体がacceptance criterionでない限りgoal_declaration.criteriaへ追加しない。hostは全build dependencyやgenerator outputを静的推定・自動注入しない。",
        "実行時に必要な準備command、generator output、cleanupの欠落が判明するplanはcontract repair decisionへ戻す。resume evidence toolingで補完せず、workerへundeclared generator、variant、ignore、削除を許可しない。",
        "Git mutationが明示要件の時だけplan.git_lifecycleを追加する。exact shape: {\"branch_create\":{\"branch\":\"validated destination branch\",\"start_ref\":\"existing commit/ref\"},\"commit\":{\"message\":\"single-line commit message\"},\"post_commit_validation\":[\"exact declared validation command\"]}。post_commit_validationは既存canonical command identityでgoal criterion commandと一致し、final unit.validationの同順・連続suffixでなければならない。全non-post validationを先に実行し、全source write完了後にsuffixを実行する。hostはworker spend前にclean root、existing start_ref、nonexisting destinationを検証し、fixed argvでbranch作成する。suffix先頭command直前に全unit.write union内変更を明示stageしてcommitし、以後のsource writeを拒否する。既存validation executorが各post-commit commandのfresh evidenceを記録し、全evidenceなしのroot acceptanceは禁止。任意Git command、git add -A、commit -a、amend、force、push、既存branch上書きは禁止。git_lifecycle省略時のGit mutationはない。",
        "acceptance_indicesは0-based。各unitのacceptance_indicesに置く全indexについて、そのacceptance_proof[index]が参照するcriterionのresolved validation_commandを同じunit.validationへ文字列完全一致で最低1個含める。範囲外index禁止。さらに各unitはそれ以前のunitにないgoal criterion validation_commandを少なくとも1個validationへ含める。同じvalidation commandだけを全unitで再利用禁止。順序付き2 unitなら例としてunit 1に中間状態を許すcommand、unit 2に最終commandを割り当てる。",
        "existing_surfaceは各covered requirementにつき最低1件。対象codebaseで、その要件が制約・変更する既存構文や既存経路を実際にReadして特定し、そのfileのproject相対pathと見つけた形(form)を書く。formは文面の言い換えでなく、observedした構文形・node種別・dispatch分岐を書く。生成・宣言・束縛の経路と変更・代入の経路は別項目として挙げる。単数形しか要件に書かれていなくても、grammarやdispatchに複数値・分配・入れ子・暗黙形があればそれも挙げる。既存形が無いと判断した場合も、探索したfileのpathと「既存形なし」の根拠をformへ書く。pathはこのTaskで実際にReadしたfileでなければhostが拒否する。",
        "許可sourceをReadで1回以上調査後、返答前にproposal packetをsortie_v010_submit_operator_proposalへ提出する。invalid-proposal返却時だけ、そのcodeに該当するfieldを修正する。返却されたactual_readsはhostのcanonical accountingであり、再提出時はcodeに関係なくbudget_estimate.proposal_readsをその値へ一致させる。これはread budgetをresetせず、成功/失敗tool表示からcountを推測しない。失敗したReadが一律に未計上とも仮定しない。有限submission budget内で再提出する。proseだけ返して終了禁止。未対応要件はuncoveredへ明示する。承認・実行を主張しない。"].join("\n") };
  }
  /** Root-visible bounded handle; the canonical prompt remains only in durable host state. */
  referenceTask(state: OperatorProposalState): OperatorTask {
    const canonical = this.task(state);
    const reference = { k: "proposal", r: state.root_session_id, p: state.profile, i: state.intent_id,
      s: state.phase, h: hash(JSON.stringify(canonical)) };
    return { ...canonical, prompt: `${OPERATOR_PROPOSAL_TASK_REFERENCE} ${JSON.stringify(reference)}` };
  }
  isReferenceTask(args: unknown): boolean {
    return record(args) && typeof args.prompt === "string" && args.prompt.startsWith(`${OPERATOR_PROPOSAL_TASK_REFERENCE} `);
  }
  isProposalPrompt(prompt: string): boolean {
    return prompt.startsWith(`${OPERATOR_PROPOSAL_TASK_REFERENCE} `) || prompt.startsWith("SORTIE_OPERATOR_PROPOSAL ");
  }
  private resolveTask(state: OperatorProposalState, args: unknown): OperatorTask {
    const canonical = this.task(state), referenced = this.referenceTask(state);
    if (!record(args) || !exact(args, ["subagent_type", "description", "prompt", "task_id"]) ||
        (args.task_id !== undefined && args.task_id !== "") || args.subagent_type !== canonical.subagent_type ||
        args.description !== canonical.description || typeof args.prompt !== "string") {
      throw new Error("operator-proposal-dispatch-not-authorized");
    }
    if (args.prompt === canonical.prompt) return canonical; // Compatibility with the pre-reference exact Task.
    if (args.prompt !== referenced.prompt || !args.prompt.startsWith(`${OPERATOR_PROPOSAL_TASK_REFERENCE} `)) {
      throw new Error("operator-proposal-dispatch-not-authorized");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(args.prompt.slice(OPERATOR_PROPOSAL_TASK_REFERENCE.length + 1)); }
    catch { throw new Error("operator-proposal-dispatch-not-authorized"); }
    const expected = JSON.parse(referenced.prompt.slice(OPERATOR_PROPOSAL_TASK_REFERENCE.length + 1)) as Record<string, unknown>;
    if (!record(parsed) || !exactSet(parsed, ["k", "r", "p", "i", "s", "h"]) ||
        Object.entries(expected).some(([key, value]) => parsed[key] !== value)) {
      throw new Error("operator-proposal-dispatch-not-authorized");
    }
    return canonical;
  }
  async begin(root: string, raw: unknown): Promise<OperatorProposalState> {
    return this.serial(root, () => this.beginUnlocked(root, raw));
  }
  private async beginUnlocked(root: string, raw: unknown): Promise<OperatorProposalState> {
    const intent = parseIntent(raw), intentHash = hash(JSON.stringify(intent)), previous = await this.readUnlocked(root);
    if (previous) {
      if (previous.intent_hash === intentHash) return previous;
      if (previous.phase !== "approved") throw new Error("operator-proposal-active-intent-immutable");
      throw new Error("operator-proposal-new-intent-requires-explicit-root-revision");
    }
    const state: OperatorProposalState = { schema_version: "0.1", profile: this.profile.id, root_session_id: root,
      intent_id: `intent-${intentHash.slice(0, 24)}`, intent_hash: intentHash, intent, created_at: new Date().toISOString(), phase: "investigating",
      goal_binding: null, proposal_call_id: null, proposal_session_id: null, read_count: 0, read_paths: [], submission_count: 0, proposal_id: null,
      proposal_revision: null, proposal_hash: null, proposal: null, approval_rationale: null };
    await this.save(state); return state;
  }
  async bindGoal(root: string, binding: OperatorProposalGoalBinding): Promise<OperatorProposalState> {
    return this.serial(root, () => this.bindGoalUnlocked(root, binding));
  }
  private async bindGoalUnlocked(root: string, binding: OperatorProposalGoalBinding): Promise<OperatorProposalState> {
    const state = await this.requiredUnlocked(root);
    if (!text(binding.goal_id) || !Number.isSafeInteger(binding.revision) || binding.revision < 1 ||
        !Number.isSafeInteger(binding.scope_epoch) || binding.scope_epoch < 1 || !/^sha256:[a-f0-9]{64}$/u.test(binding.acceptance_fingerprint)) {
      throw new Error("operator-proposal-goal-binding-invalid");
    }
    if (state.goal_binding !== null && JSON.stringify(state.goal_binding) !== JSON.stringify(binding)) {
      throw new Error("operator-proposal-goal-binding-changed");
    }
    if (state.goal_binding === null) { state.goal_binding = structuredClone(binding); await this.save(state); }
    return state;
  }
  async admit(root: string, callID: string, args: unknown, reserveBudget?: () => Promise<void>): Promise<OperatorTask> {
    return this.serial(root, () => this.admitUnlocked(root, callID, args, reserveBudget));
  }
  private async admitUnlocked(root: string, callID: string, args: unknown, reserveBudget?: () => Promise<void>): Promise<OperatorTask> {
    const state = await this.requiredUnlocked(root);
    if (state.phase !== "investigating" || state.proposal_call_id !== null) throw new Error("operator-proposal-dispatch-not-authorized");
    const canonical = this.resolveTask(state, args);
    // Reserve only after the grant check, while competing admissions remain queued.
    await reserveBudget?.();
    state.proposal_call_id = callID; await this.save(state);
    return canonical;
  }
  async bind(root: string, child: string, prompt: string): Promise<void> {
    return this.serial(root, () => this.bindUnlocked(root, child, prompt));
  }
  private async bindUnlocked(root: string, child: string, prompt: string): Promise<void> {
    const state = await this.requiredUnlocked(root);
    const matches = prompt === this.task(state).prompt || prompt === this.referenceTask(state).prompt;
    if (state.phase !== "investigating" || state.proposal_call_id === null ||
        (state.proposal_session_id !== null && state.proposal_session_id !== child) || !matches) {
      throw new Error("operator-proposal-grant-invalid");
    }
    if (state.proposal_session_id === null) { state.proposal_session_id = child; await this.save(state); }
  }
  /** Atomically bind one direct native proposal child and reveal the canonical prompt only there. */
  claimAdmittedPrompt(root: string, parent: string, child: string, prompt: string): Promise<string> {
    return this.serial(root, async () => {
      const state = await this.requiredUnlocked(root);
      if (state.phase !== "investigating" || state.proposal_call_id === null) throw new Error("operator-proposal-grant-invalid");
      if (root !== state.root_session_id || parent !== state.root_session_id) throw new Error("operator-proposal-parent-mismatch");
      if (prompt !== this.task(state).prompt && prompt !== this.referenceTask(state).prompt) {
        throw new Error("operator-proposal-task-reference-mismatch");
      }
      if (state.proposal_session_id !== null && state.proposal_session_id !== child) throw new Error("operator-proposal-child-mismatch");
      if (state.proposal_session_id === null) { state.proposal_session_id = child; await this.save(state); }
      return this.task(state).prompt;
    });
  }
  async accountRead(root: string, actor: string, path?: string): Promise<OperatorProposalState> {
    return this.serial(root, () => this.accountReadUnlocked(root, actor, path));
  }
  private async accountReadUnlocked(root: string, actor: string, path?: string): Promise<OperatorProposalState> {
    const state = await this.requiredUnlocked(root); if (state.proposal_session_id !== actor || state.phase !== "investigating") throw new Error("operator-proposal-read-grant-invalid");
    if (state.read_count >= state.intent.proposal_budget.max_reads) throw new Error("operator-proposal-read-budget-exhausted");
    state.read_count++;
    if (path !== undefined && normalizedRelativePath(path) && !state.read_paths.includes(path) &&
        state.read_paths.length < OPERATOR_PROPOSAL_BUDGET_CAPS.max_reads) state.read_paths.push(path);
    await this.save(state); return state;
  }
  async submit(root: string, actor: string, raw: unknown): Promise<OperatorProposalState> {
    return this.serial(root, () => this.submitUnlocked(root, actor, raw));
  }
  private async submitUnlocked(root: string, actor: string, raw: unknown): Promise<OperatorProposalState> {
    const state = await this.requiredUnlocked(root); if (state.proposal_session_id !== actor || state.phase !== "investigating") throw new Error("operator-proposal-submit-grant-invalid");
    if (state.submission_count >= state.intent.proposal_budget.max_submissions) throw new Error("operator-proposal-submission-budget-exhausted");
    let packet: OperatorProposalPacket;
    try { packet = parsePacket(raw, state); }
    catch (error) { state.submission_count++; await this.save(state); throw error; }
    state.submission_count++;
    state.proposal = packet; state.proposal_revision = packet.revision; state.proposal_hash = hash(JSON.stringify(packet));
    state.proposal_id = proposalID(state.intent_id, packet.revision, state.proposal_hash); state.phase = "submitted";
    await this.save(state); return state;
  }
  async approve(root: string, raw: unknown, commit = true): Promise<OperatorProposalState> {
    return this.serial(root, () => this.approveUnlocked(root, raw, commit));
  }
  private async approveUnlocked(root: string, raw: unknown, commit: boolean): Promise<OperatorProposalState> {
    const state = await this.requiredUnlocked(root);
    const approval = parseApproval(raw);
    if (approval.proposal_id !== state.proposal_id || approval.revision !== state.proposal_revision || approval.content_hash !== state.proposal_hash ||
        JSON.stringify(approval.compared_requirement_ids) !== JSON.stringify(state.intent.requirements.map(item => item.id))) {
      throw new Error("operator-proposal-approval-identity-mismatch");
    }
    if (state.phase !== "submitted" || !state.proposal || state.proposal.uncovered.length > 0) throw new Error("operator-proposal-not-approvable");
    if (commit) { state.phase = "approved"; state.approval_rationale = approval.rationale; await this.save(state); }
    return state;
  }
  async required(root: string): Promise<OperatorProposalState> { const state = await this.read(root); if (!state) throw new Error("operator-proposal-missing"); return state; }
  async assertExecutionApproved(root: string, planHash: string): Promise<void> {
    const state = await this.read(root);
    // The submitted normalized plan is the durable link, available even when
    // preparation succeeded but goal registration or the approval save failed.
    if (state?.proposal && hash(JSON.stringify(state.proposal.plan)) === planHash && state.phase !== "approved") {
      throw new Error("operator-proposal-execution-not-approved");
    }
  }
  private async requiredUnlocked(root: string): Promise<OperatorProposalState> { const state = await this.readUnlocked(root); if (!state) throw new Error("operator-proposal-missing"); return state; }
  packet(state: OperatorProposalState): unknown { return { status: state.phase, intent_id: state.intent_id, intent_hash: state.intent_hash,
    proposal_id: state.proposal_id, revision: state.proposal_revision, content_hash: state.proposal_hash, reads: state.read_count,
    remaining_reads: state.intent.proposal_budget.max_reads - state.read_count, submissions: state.submission_count,
    remaining_submissions: state.intent.proposal_budget.max_submissions - state.submission_count,
    task_admitted: state.proposal_call_id !== null, uncovered: state.proposal?.uncovered ?? [], proposal: state.proposal,
    approval_rationale: state.approval_rationale }; }
}
