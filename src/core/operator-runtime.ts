import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { acceptanceContinuityFingerprint, normalizeAcceptanceCriteria, ACCEPTANCE_CONTINUITY_EXTENSION } from "./acceptance-continuity.js";
import { expandGoalDeclaration } from "./goal-declaration-format.js";
import { normalizeRelativePath } from "./path.js";
import { validateHandoffSchema, validateOperationManifestSchema } from "./validate-schema.js";
import { validateManifest } from "./validate-manifest.js";
import { profileAgent, RUNTIME_PROFILES, type RuntimeProfile } from "./runtime-profile.js";
import type { GoalEvidence, GoalTerminalReceipt } from "./goal-bound.js";
import type { SerialDispatchSettlement } from "../plugin/runtime-bridge.js";

export const OPERATOR_LIMITS = Object.freeze({ units: 32, planBytes: 256 * 1024, packetBytes: 24 * 1024 });
export interface OperatorUnit {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly validation: readonly string[];
  readonly acceptance_indices: readonly number[];
}
export interface OperatorPlan {
  readonly schema_version: "0.1";
  readonly acceptance: readonly string[];
  readonly acceptance_proof: readonly (readonly string[])[];
  readonly source_refs: readonly string[];
  readonly goal_declaration: Record<string, unknown>;
  readonly units: readonly OperatorUnit[];
}
export interface OperatorTask {
  readonly description: string;
  readonly subagent_type: string;
  readonly prompt: string;
}
type OperatorPhase = "prepared" | "running" | "awaiting-decision" | "awaiting-acceptance" | "completed" | "cancelled";
interface UnitState {
  readonly unit: OperatorUnit;
  readonly task: OperatorTask;
  readonly handoffPath: string;
  readonly manifestPath: string;
  readonly hashes: readonly string[];
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  callID: string | null;
  childSessionID: string | null;
  evidence: readonly GoalEvidence[];
  resultClass: string | null;
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
function strings(value: unknown, nonempty = false): value is string[] {
  return Array.isArray(value) && (!nonempty || value.length > 0) && value.every(text);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

export function parseOperatorPlan(value: unknown): OperatorPlan {
  if (!record(value) || !exactKeys(value, ["schema_version", "acceptance", "acceptance_proof", "source_refs", "goal_declaration", "units"]) ||
      value.schema_version !== "0.1" || !strings(value.acceptance, true) || !strings(value.source_refs, true) ||
      !record(value.goal_declaration) || !Array.isArray(value.units) || value.units.length < 1 || value.units.length > OPERATOR_LIMITS.units ||
      Buffer.byteLength(JSON.stringify(value)) > OPERATOR_LIMITS.planBytes) throw new Error("operator-plan-invalid");
  const declaration = value.goal_declaration;
  if (!Array.isArray(declaration.criteria) || !record(declaration.defaults ?? {})) throw new Error("operator-goal-criteria-invalid");
  const defaults = (declaration.defaults ?? {}) as Record<string, unknown>;
  const proofCommands = new Map<string, string>();
  for (const raw of declaration.criteria) {
    if (!record(raw)) throw new Error("operator-goal-criteria-invalid");
    const id = raw.goal_criterion_id ?? raw.criterion_id;
    const command = raw.goal_validation_command ?? raw.validation_command ?? defaults.goal_validation_command ?? defaults.validation_command;
    if (!text(id) || !text(command) || proofCommands.has(id)) throw new Error("operator-goal-proof-id-required");
    proofCommands.set(id, command);
  }
  if (!Array.isArray(value.acceptance_proof) || value.acceptance_proof.length !== value.acceptance.length ||
      value.acceptance_proof.some(ids => !strings(ids, true) || ids.some(id => !proofCommands.has(id)))) throw new Error("operator-acceptance-proof-incomplete");
  const ids = new Set<string>();
  const coverage = new Set<number>();
  const plannedProof = new Set<string>();
  const acceptanceCount = value.acceptance.length;
  for (const unit of value.units) {
    if (!record(unit) || !exactKeys(unit, ["id", "title", "objective", "read", "write", "validation", "acceptance_indices"]) ||
        !identifier(unit.id) || ids.has(unit.id) || !text(unit.title) || !text(unit.objective) ||
        !strings(unit.read) || !strings(unit.write, true) || !strings(unit.validation, true)) throw new Error("operator-unit-invalid");
    if (!Array.isArray(unit.acceptance_indices) || unit.acceptance_indices.length === 0 ||
        unit.acceptance_indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= acceptanceCount ||
          !(value.acceptance_proof as string[][])[index]!.some(id => (unit.validation as string[]).includes(proofCommands.get(id)!)))) {
      throw new Error("operator-unit-coverage-invalid");
    }
    unit.acceptance_indices.forEach(index => coverage.add(index as number));
    const unitProof = [...proofCommands].filter(([, command]) => (unit.validation as string[]).includes(command)).map(([id]) => id);
    if (unitProof.every(id => plannedProof.has(id))) throw new Error("operator-unit-needs-new-goal-milestone");
    unitProof.forEach(id => plannedProof.add(id));
    ids.add(unit.id);
    for (const name of [...unit.read, ...unit.write]) {
      if (normalizeRelativePath(name) !== name) throw new Error("operator-scope-invalid");
    }
    for (const name of unit.write) {
      if ([".git", ...Object.values(RUNTIME_PROFILES).map(profile => profile.stateDirectory)]
        .some(directory => name === directory || name.startsWith(`${directory}/`))) throw new Error("operator-control-write-forbidden");
    }
  }
  if (coverage.size !== value.acceptance.length) throw new Error("operator-plan-drops-accepted-criterion");
  const requiredProof = (value.acceptance_proof as string[][]).flat();
  if (requiredProof.some(id => !plannedProof.has(id)) || [...proofCommands.keys()].some(id => !requiredProof.includes(id))) {
    throw new Error("operator-plan-proof-coverage-incomplete");
  }
  expandGoalDeclaration(value.goal_declaration);
  return { ...value, acceptance: normalizeAcceptanceCriteria(value.acceptance) } as unknown as OperatorPlan;
}

/** Root-owned durable queue. It never executes code, changes acceptance, or accepts a candidate. */
export class OperatorRuntime {
  private readonly states = new Map<string, OperatorState>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly transactions = new Map<string, Promise<unknown>>();
  readonly projectRoot: string;
  constructor(projectRoot: string, readonly profile: RuntimeProfile) {
    this.projectRoot = resolve(projectRoot);
  }
  private file(root: string): string {
    return join(this.projectRoot, this.profile.stateDirectory, "operators", `${hash(root)}.json`);
  }
  async read(root: string): Promise<OperatorState | undefined> {
    await this.writes.get(root);
    const cached = this.states.get(root);
    if (cached) return cached;
    let source: string;
    try { source = await readFile(this.file(root), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (Buffer.byteLength(source) > OPERATOR_LIMITS.planBytes * 4) throw new Error("operator-state-too-large");
    const state = JSON.parse(source) as OperatorState;
    if (state.schema_version !== "0.1" || state.profile !== this.profile.id || state.rootSessionID !== root ||
        !identifier(state.runID) || !Array.isArray(state.units) || state.units.length > OPERATOR_LIMITS.units ||
        !strings(state.acceptance, true) || !Array.isArray(state.acceptanceProof) || state.acceptanceProof.length !== state.acceptance.length ||
        state.acceptanceProof.some(ids => !strings(ids, true)) || state.acceptanceFingerprint !== acceptanceContinuityFingerprint(state.acceptance)) {
      throw new Error("operator-state-invalid");
    }
    this.states.set(root, state);
    return state;
  }
  private async save(state: OperatorState): Promise<void> {
    state.sequence++;
    this.states.set(state.rootSessionID, state);
    const serialized = JSON.stringify(state);
    const previous = this.writes.get(state.rootSessionID) ?? Promise.resolve();
    const next = previous.then(async () => {
      const directory = join(this.projectRoot, this.profile.stateDirectory, "operators");
      await mkdir(directory, { recursive: true });
      const file = this.file(state.rootSessionID);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    });
    this.writes.set(state.rootSessionID, next);
    await next;
  }
  private serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.transactions.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.transactions.set(root, next);
    return next;
  }
  prepare(root: string, raw: unknown): Promise<OperatorState> {
    return this.serial(root, () => this.prepareOnce(root, raw));
  }
  private async prepareOnce(root: string, raw: unknown): Promise<OperatorState> {
    const plan = parseOperatorPlan(raw);
    const planHash = hash(JSON.stringify(plan));
    const previous = await this.read(root);
    if (previous && !["completed", "cancelled"].includes(previous.phase)) {
      if (previous.planHash === planHash) return previous;
      throw new Error("operator-active-contract-immutable");
    }
    const runID = `operator-${randomUUID()}`;
    const directory = join(this.projectRoot, this.profile.stateDirectory, "contracts");
    await mkdir(directory, { recursive: true });
    const declarationPath = join(directory, `${runID}.goal.json`);
    const declaration = JSON.stringify(plan.goal_declaration);
    await writeFile(declarationPath, declaration, { flag: "wx", mode: 0o600 });
    const acceptanceFingerprint = acceptanceContinuityFingerprint(plan.acceptance);
    const units: UnitState[] = [];
    for (const [index, unit] of plan.units.entries()) {
      const taskID = `${runID}-${index + 1}`;
      const manifestPath = join(directory, `${taskID}.operation-manifest.json`);
      const manifestRelative = `${this.profile.stateDirectory}/contracts/${taskID}.operation-manifest.json`;
      const handoffPath = join(directory, `handoff.${taskID}.json`);
      const manifest = { version: "0.1.0", task_id: taskID, read: unit.read, write: unit.write, validation: unit.validation };
      const handoff = {
        version: "0.1.0", profile: "minimal", id: taskID, created_at: new Date().toISOString(),
        task: { title: unit.title, objective: unit.objective }, state: { done: [], next: [unit.objective], blocked: [] }, risks: [],
        verification: unit.validation.map(check => ({ check, status: "not_run", exit_code: null, summary: "Execute in the admitted worker." })),
        ext: {
          "sortie-dogs/write-gate": { operation_manifest: manifestRelative, project_root: this.projectRoot },
          [ACCEPTANCE_CONTINUITY_EXTENSION]: { schema_version: "0.1", authority: "dispatch", task_id: taskID,
            criteria: plan.acceptance, fingerprint: acceptanceFingerprint, parent_fingerprint: index === 0 ? "none" : acceptanceFingerprint },
          "sortie-dogs/unit-coverage": { schema_version: "0.1", task_id: taskID,
            acceptance_fingerprint: acceptanceFingerprint, indices: unit.acceptance_indices },
        },
      };
      const h = validateHandoffSchema(handoff), m = validateOperationManifestSchema(manifest);
      if (!h.ok || !m.ok || validateManifest(h.value, m.value, undefined, false, { requirePassedValidation: false })
        .some(item => item.severity === "error")) throw new Error("operator-generated-contract-invalid");
      const contents = [JSON.stringify(handoff), JSON.stringify(manifest)];
      await writeFile(handoffPath, contents[0]!, { flag: "wx", mode: 0o600 });
      await writeFile(manifestPath, contents[1]!, { flag: "wx", mode: 0o600 });
      const prompt = ["role: implementation", `task_id: ${taskID}`, `project_root: ${this.projectRoot}`,
        `source_manifest: ${unit.write.join(", ")}`, `operation_manifest: ${manifestRelative}`, `handoff_path: ${handoffPath}`,
        `goal_declaration_path: ${declarationPath}`, "acceptance:", ...plan.acceptance.map(value => `  - ${value}`),
        "validation:", ...unit.validation.map(value => `  - ${value}`),
        `unit_acceptance_indices: ${JSON.stringify(unit.acceptance_indices)}`, "", unit.objective].join("\n");
      units.push({ unit, task: { subagent_type: profileAgent(this.profile, "dog-worker"), description: unit.title, prompt },
        handoffPath, manifestPath, hashes: [...contents.map(hash), hash(declaration)], status: "pending", callID: null,
        childSessionID: null, evidence: [], resultClass: null });
    }
    const state: OperatorState = { schema_version: "0.1", profile: this.profile.id, rootSessionID: root, runID, planHash,
      acceptance: plan.acceptance, acceptanceProof: plan.acceptance_proof, acceptanceFingerprint, sourceRefs: plan.source_refs, createdAt: new Date().toISOString(),
      generation: (previous?.generation ?? 0) + 1, sequence: previous?.sequence ?? 0, phase: "prepared",
      operatorCallID: null, operatorSessionID: null, dispatched: 0, units, decision: null, receipt: null };
    await this.save(state);
    return state;
  }
  operatorTask(state: OperatorState): OperatorTask {
    return { subagent_type: profileAgent(this.profile, "dog-operator"), description: `${state.units[0]!.unit.title} (+${state.units.length - 1})`,
      prompt: [`operator_run_id: ${state.runID}`, `operator_root: ${state.rootSessionID}`, `operator_generation: ${state.generation}`,
        `operator_contract: ${state.planHash}`, "Execute the approved serial queue using the operator next tool. Do not reinterpret acceptance or edit source."].join("\n") };
  }
  admitOperator(root: string, callID: string, args: unknown): Promise<void> {
    return this.serial(root, () => this.admitOperatorOnce(root, callID, args));
  }
  private async admitOperatorOnce(root: string, callID: string, args: unknown): Promise<void> {
    const state = await this.required(root);
    if (state.units.length === 1 || state.phase !== "prepared" || state.operatorCallID !== null ||
        !this.sameTask(args, this.operatorTask(state))) throw new Error("operator-dispatch-not-authorized");
    state.operatorCallID = callID;
    state.phase = "running";
    await this.save(state);
  }
  async bindOperator(root: string, sessionID: string, prompt: string): Promise<void> {
    const state = await this.required(root);
    if (state.phase !== "running" || state.operatorCallID === null ||
        (state.operatorSessionID !== null && state.operatorSessionID !== sessionID) ||
        !prompt.includes(this.operatorTask(state).prompt)) throw new Error("operator-grant-invalid");
    state.operatorSessionID = sessionID;
    await this.save(state);
  }
  async next(root: string, actor: string): Promise<unknown> {
    const state = await this.required(root);
    if (actor !== state.operatorSessionID && !(actor === root && state.units.length === 1)) throw new Error("operator-owner-mismatch");
    if (!["prepared", "running"].includes(state.phase)) return this.packet(state);
    const current = state.units.find(unit => unit.status !== "succeeded");
    if (!current) {
      state.phase = "awaiting-acceptance";
      await this.save(state);
      return this.packet(state);
    }
    if (current.status !== "pending") return this.packet(state);
    await this.verifyControls(current);
    return { run_id: state.runID, generation: state.generation, sequence: state.sequence, task: current.task,
      acceptance_fingerprint: state.acceptanceFingerprint };
  }
  private sameTask(args: unknown, task: OperatorTask): boolean {
    return record(args) && args.subagent_type === task.subagent_type && args.prompt === task.prompt && (args.task_id === undefined || args.task_id === "");
  }
  admitWorker(root: string, actor: string, callID: string, args: unknown): Promise<void> {
    return this.serial(root, () => this.admitWorkerOnce(root, actor, callID, args));
  }
  private async admitWorkerOnce(root: string, actor: string, callID: string, args: unknown): Promise<void> {
    const state = await this.required(root);
    if (actor !== state.operatorSessionID && !(actor === root && state.units.length === 1)) throw new Error("operator-owner-mismatch");
    if (!["prepared", "running"].includes(state.phase)) throw new Error("operator-grant-revoked");
    const unit = state.units.find(item => item.status !== "succeeded");
    if (!unit || unit.status !== "pending" || !this.sameTask(args, unit.task) || state.dispatched >= state.units.length) {
      throw new Error("operator-unit-not-authorized");
    }
    await this.verifyControls(unit);
    unit.status = "running";
    unit.callID = callID;
    state.dispatched++;
    state.phase = "running";
    await this.save(state);
  }
  async rejectedAdmission(root: string, callID: string): Promise<void> {
    await this.rejectDispatch(root, callID, "dispatch-admission-rejected");
  }
  async rejectDispatch(root: string, callID: string, decision = "native-task-rejected"): Promise<void> {
    const state = await this.required(root);
    const unit = state.units.find(item => item.callID === callID && item.status === "running");
    if (!unit) return;
    unit.status = "failed";
    unit.resultClass = "process-defect";
    state.phase = "awaiting-decision";
    state.decision = decision;
    await this.save(state);
  }
  async operatorRejected(root: string): Promise<OperatorState> {
    const state = await this.required(root);
    if (state.phase === "running" && state.operatorCallID !== null && state.operatorSessionID === null) {
      state.phase = "awaiting-decision";
      state.decision = "native-operator-task-rejected";
      await this.save(state);
    }
    return state;
  }
  async settled(result: SerialDispatchSettlement): Promise<void> {
    const state = await this.read(result.rootSessionID);
    const unit = state?.units.find(item => item.callID === result.callID);
    if (!state || !unit) return;
    if (state.phase === "cancelled") return;
    unit.childSessionID = result.childSessionID ?? unit.childSessionID;
    unit.evidence = result.evidence;
    unit.resultClass = result.resultClass;
    unit.status = result.disposition;
    if (result.disposition !== "succeeded") { state.phase = "awaiting-decision"; state.decision = result.resultClass; }
    else if (state.units.every(item => item.status === "succeeded")) state.phase = "awaiting-acceptance";
    await this.save(state);
  }
  async observeChild(root: string, callID: string, childID: string): Promise<void> {
    const state = await this.required(root);
    const unit = state.units.find(item => item.callID === callID);
    if (unit) { unit.childSessionID = childID; await this.save(state); }
  }
  async operatorReturned(root: string): Promise<OperatorState> {
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
    state.generation++;
    state.phase = "cancelled";
    state.decision = reason;
    for (const unit of state.units) if (unit.status === "running") unit.status = "cancelled";
    await this.save(state);
    return [state.operatorSessionID, ...state.units.map(unit => unit.childSessionID)].filter((id): id is string => id !== null);
  }
  async terminal(root: string, receipt: GoalTerminalReceipt): Promise<void> {
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
  packet(state: OperatorState): unknown {
    const proved = new Set(state.units.flatMap(unit => unit.evidence.flatMap(item => item.measurement.criterion_ids)));
    const packet = { profile: state.profile, run_id: state.runID, root_session_id: state.rootSessionID, generation: state.generation,
      sequence: state.sequence, status: state.phase, acceptance: state.acceptance, acceptance_fingerprint: state.acceptanceFingerprint,
      requirements: state.acceptance.map((criterion, index) => ({ criterion,
        proof_ids: state.acceptanceProof[index], status: state.acceptanceProof[index]!.every(id => proved.has(id)) ? "observed-pass" : "unproven" })),
      source_refs: state.sourceRefs, decision: state.decision, units: state.units.map(unit => ({
        id: unit.unit.id, status: unit.status, child_session_id: unit.childSessionID, result_class: unit.resultClass,
        handoff_path: unit.handoffPath, operation_manifest_path: unit.manifestPath,
        scope_read: unit.unit.read, scope_write: unit.unit.write, validation: unit.unit.validation,
        acceptance_indices: unit.unit.acceptance_indices,
        evidence: unit.evidence.map(item => ({ id: item.evidence_id, criteria: item.measurement.criterion_ids,
          candidate: item.identity.candidate, command: item.execution.command, outcome: item.execution.outcome, exit_code: item.execution.exit_code })),
        unproven: unit.status !== "succeeded",
      })), final_acceptance: state.receipt?.status ?? "coordinator-required" };
    if (Buffer.byteLength(JSON.stringify(packet)) > OPERATOR_LIMITS.packetBytes) throw new Error("operator-packet-too-large-no-evidence-truncated");
    return packet;
  }
  private async verifyControls(unit: UnitState): Promise<void> {
    if (!isAbsolute(unit.handoffPath) || !isAbsolute(unit.manifestPath)) throw new Error("operator-control-path-invalid");
    const declaration = /^goal_declaration_path: (.+)$/m.exec(unit.task.prompt)?.[1];
    if (!declaration || !isAbsolute(declaration)) throw new Error("operator-declaration-path-invalid");
    const contents = await Promise.all([unit.handoffPath, unit.manifestPath, declaration].map(file => readFile(file, "utf8")));
    if (contents.some((value, index) => hash(value) !== unit.hashes[index])) throw new Error("operator-contract-changed");
  }
}
