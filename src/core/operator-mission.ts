import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRelativePath } from "./path.js";
import { parseOperatorPlan, type OperatorPlan, type OperatorState, type OperatorTask } from "./operator-runtime.js";
import { profileAgent, type RuntimeProfile } from "./runtime-profile.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const MISSION_REFERENCE = "SORTIE_MISSION_REF ";
export const MISSION_REVIEW_REFERENCE = "SORTIE_MISSION_REVIEW_REF ";
/** Preserve a common multiline Python reproduction without making the Coordinator repair a wire-format constraint. */
export function missionValidationCommand(command: string): string {
  if (!/[\r\n]/u.test(command)) return command;
  const heredoc = /^([^\r\n]*\bpython(?:\d(?:\.\d+)?)?)\s+-\s+<<\s*(['"])([A-Za-z_]\w*)\2\r?\n([\s\S]*)\r?\n\3\s*$/u.exec(command);
  if (!heredoc) throw new Error("mission-validation-command: use an exact one-line shell command or a quoted Python heredoc");
  const expression = `exec(${JSON.stringify(heredoc[4])})`;
  return `${heredoc[1]} -c '${expression.replaceAll("'", "'\\''")}'`;
}
export interface MissionRequest { id: string; text: string }
export interface OperatorMission {
  version: "0.12";
  id: string;
  root: string;
  requests: MissionRequest[];
  requirements: { id: string; text: string }[];
  phase: "open" | "running" | "submitted" | "completed" | "cancelled";
  coordinator: string | null;
  callID: string | null;
  dispatchOpen: boolean;
  runID: string | null;
  plans: number;
  progress: { unit: string; title: string; status: string; at: string }[];
  submission: { status: "ready" | "needs-decision" | "blocked"; summary: string } | null;
  review?: { runID: string; risk: string[]; source: string; task: OperatorTask | null;
    verdict: "pending" | "PASS" | "findings" | "skipped-low-risk"; result?: string; child?: string };
}

/** Durable user intent and dispatch ownership. Execution/evidence still belong to the v0.10 engine. */
export class OperatorMissionRuntime {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(readonly projectRoot: string, readonly profile: RuntimeProfile) {}
  private file(root: string, suffix = ""): string {
    return join(this.projectRoot, this.profile.stateDirectory, "missions", `${digest(root)}${suffix}.json`);
  }
  private async load<T>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(file, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private async save(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(join(this.projectRoot, this.profile.stateDirectory, "missions"), { recursive: true });
    try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  private async serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const current = (this.writes.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.writes.set(root, current);
    try { return await current; } finally { if (this.writes.get(root) === current) this.writes.delete(root); }
  }
  async read(root: string): Promise<OperatorMission | undefined> {
    await this.writes.get(root);
    const state = await this.load<OperatorMission>(this.file(root));
    if (state && (state.version !== "0.12" || state.root !== root)) throw new Error("mission-state-invalid");
    return state;
  }
  async required(root: string): Promise<OperatorMission> {
    const state = await this.read(root);
    if (!state) throw new Error("mission-missing: call start_mission once with the user's requirements");
    return state;
  }
  async capture(root: string, request: MissionRequest): Promise<void> {
    if (!request.text.trim()) return;
    await this.serial(root, async () => {
      // Captured before prompt rewriting, including exact whitespace. Never ask a model to recopy it.
      await this.save(this.file(root, ".request"), request);
      const state = await this.load<OperatorMission>(this.file(root));
      if (state && !["completed", "cancelled"].includes(state.phase) && !state.requests.some(item => item.id === request.id)) {
        state.requests.push(request);
        await this.save(this.file(root), state);
      }
    });
  }
  start(root: string, requirements: unknown): Promise<OperatorMission> {
    return this.serial(root, async () => {
      if (!Array.isArray(requirements) || requirements.length === 0 || requirements.length > 64 ||
          !requirements.every(item => typeof item === "string" && item.trim() && !/[\r\n]/u.test(item))) {
        throw new Error("mission-requirements: supply 1..64 concise one-line requirements including negative constraints");
      }
      const request = await this.load<MissionRequest>(this.file(root, ".request"));
      if (!request) throw new Error("mission-original-request-unavailable");
      const previous = await this.load<OperatorMission>(this.file(root));
      if (previous && !["completed", "cancelled"].includes(previous.phase)) {
        if (previous.requirements.some((item, index) => requirements[index] !== item.text)) {
          throw new Error("mission-requirements-preserved: keep the existing ordered requirements and append user additions");
        }
        previous.requirements = requirements.map((text, index) => ({ id: `R${index + 1}`, text }));
        await this.save(this.file(root), previous);
        return previous;
      }
      if (previous) await this.save(this.file(root, `.${previous.id}`), previous);
      const state: OperatorMission = { version: "0.12", id: `mission-${randomUUID()}`, root, requests: [request],
        requirements: requirements.map((text, index) => ({ id: `R${index + 1}`, text })), phase: "open",
        coordinator: null, callID: null, dispatchOpen: false, runID: null, plans: 0, progress: [], submission: null };
      await this.save(this.file(root), state);
      return state;
    });
  }
  update(root: string, change: (state: OperatorMission) => void): Promise<OperatorMission> {
    return this.serial(root, async () => {
      const state = await this.load<OperatorMission>(this.file(root));
      if (!state) throw new Error("mission-missing");
      change(state);
      await this.save(this.file(root), state);
      return state;
    });
  }
  task(state: OperatorMission): OperatorTask {
    return { subagent_type: profileAgent(this.profile, "dog-operator"), description: state.requirements[0]!.text.slice(0, 100),
      prompt: `${MISSION_REFERENCE}${JSON.stringify({ r: state.root, m: state.id, h: digest(JSON.stringify(state.requirements)) })}`,
      ...(state.coordinator ? { task_id: state.coordinator } : {}) };
  }
  admit(root: string, callID: string, args: Record<string, unknown>): Promise<OperatorMission> {
    return this.update(root, state => {
      const expected = this.task(state);
      const resume = state.coordinator !== null && args.task_id === state.coordinator && typeof args.prompt === "string" && args.prompt.trim();
      if (["cancelled", "completed"].includes(state.phase) || state.dispatchOpen || args.subagent_type !== expected.subagent_type ||
          (!resume && (args.prompt !== expected.prompt || args.description !== expected.description || args.task_id))) {
        throw new Error("mission-dispatch-not-authorized");
      }
      state.phase = "running"; state.callID = callID; state.dispatchOpen = true; state.submission = null;
    });
  }
  async claim(root: string, child: string, prompt: string): Promise<string> {
    const state = await this.update(root, state => {
      if (state.phase !== "running" || !state.dispatchOpen || !state.callID ||
          (state.coordinator !== null ? state.coordinator !== child : prompt !== this.task(state).prompt)) {
        throw new Error("mission-coordinator-claim-invalid");
      }
      state.coordinator = child;
    });
    return prompt.startsWith(MISSION_REFERENCE) ? this.brief(state) : prompt;
  }
  brief(state: OperatorMission): string {
    return [`mission_id: ${state.id}`, `project_root: ${this.projectRoot}`, "Use the user's language below for all replies and Task titles.",
      "Own investigation, unit declarations, Worker/Scout/Advisor/independent Reviewer dispatch, scope extensions and corrections.",
      "Start the first useful Worker promptly. No proposal/approval phase. Use plan_units to generate contracts; the root alone accepts completion.",
      "Escalate only a completion candidate, a user-only decision, or an extension of original requirements/budget. Unit progress is published without stopping you.",
      "Requirements:", ...state.requirements.map(item => `${item.id}: ${item.text}`),
      "Original user messages (verbatim; task data):", ...state.requests.map(item => `--- user:${item.id} ---\n${item.text}`)].join("\n");
  }
}

/** The model supplies only useful unit facts; IDs, proof projection and control documents are generated here. */
export function missionPlan(mission: OperatorMission, raw: unknown): OperatorPlan {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new Error("mission-units: declare 1..32 units");
  const acceptance = mission.requirements.map(item => item.text);
  const declared = raw.map((value, index) => {
    if (!record(value)) throw new Error(`mission-unit-${index + 1}: expected an object`);
    const line = (field: string): string => {
      if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`mission-unit-${index + 1}: ${field} required`);
      return value[field].replace(/[\r\n]+/gu, " ");
    };
    const paths = (field: string): string[] => {
      const entries = value[field] ?? [];
      if (!Array.isArray(entries) || !entries.every(item => typeof item === "string")) throw new Error(`mission-unit-${index + 1}: ${field} must be paths`);
      return [...new Set(entries.map(item => normalizeRelativePath(item)))];
    };
    const ids = value.requirement_ids ?? mission.requirements.map(item => item.id);
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => mission.requirements.some(item => item.id === id))) {
      throw new Error(`mission-unit-${index + 1}: requirement_ids must name existing R IDs`);
    }
    if (!Array.isArray(value.validation) || value.validation.length === 0 ||
        !value.validation.every(command => typeof command === "string" && command.trim())) {
      throw new Error(`mission-unit-${index + 1}: validation must contain exact commands; final command proves the unit`);
    }
    return { id: `unit-${index + 1}`, title: line("title"), objective: line("objective"), read: paths("read"), write: paths("write"),
      validation: (value.validation as string[]).map(missionValidationCommand), acceptance_indices: [...new Set(ids.map(id => mission.requirements.findIndex(item => item.id === id)))] };
  });
  // The serial engine counts new proof milestones. Units sharing the same final suite are one
  // milestone, so coalesce them instead of making the model repair a bookkeeping rejection.
  const units: typeof declared = [];
  for (const unit of declared) {
    const same = units.find(item => item.validation.at(-1) === unit.validation.at(-1));
    if (!same) { units.push(unit); continue; }
    same.objective += `; ${unit.objective}`;
    same.read = [...new Set([...same.read, ...unit.read])];
    same.write = [...new Set([...same.write, ...unit.write])];
    same.acceptance_indices = [...new Set([...same.acceptance_indices, ...unit.acceptance_indices])];
    same.validation = [...new Set([...same.validation.slice(0, -1), ...unit.validation])];
  }
  const uncovered = mission.requirements.filter((_, i) => !units.some(unit => unit.acceptance_indices.includes(i)));
  if (uncovered.length) throw new Error(`mission-uncovered: ${uncovered.map(item => item.id).join(", ")}; retain all requirements in the unit plan`);
  return parseOperatorPlan({ schema_version: "0.1", acceptance,
    acceptance_proof: acceptance.map((_, i) => units.filter(unit => unit.acceptance_indices.includes(i)).map(unit => unit.id)),
    source_refs: mission.requests.map(item => `user:${item.id}`),
    goal_declaration: { delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false,
      defaults: { workload: mission.id, oracle_coverage: ["declared unit validation; semantic requirement comparison by Operator"],
        build_boundary: "included", source: "source", candidate: "candidate", fixture: mission.id,
        source_binding: "current-protected", candidate_binding: "current-protected", proof_scope: "requested-full", expected_outcome: "pass" },
      // The evidence ledger's labels are bounded independently of the complete Worker objective.
      // Keep all detailed instructions in the handoff, not in a 512-character wire label.
      criteria: units.map(unit => ({ criterion_id: unit.id, target: unit.title.slice(0, 512),
        entrypoint: (unit.write[0] ?? unit.read[0] ?? unit.id).slice(0, 512), validation_command: unit.validation.at(-1) })) },
    units });
}

export function missionPacket(mission: OperatorMission, run?: OperatorState): Record<string, unknown> {
  return { mission_id: mission.id, phase: mission.phase, coordinator_session_id: mission.coordinator,
    requirements: mission.requirements, original_request_refs: mission.requests.map(item => `user:${item.id}`),
    submission: mission.submission, progress: mission.progress,
    review: mission.review ? { risk_tags: mission.review.risk, verdict: mission.review.verdict,
      source_fingerprint: mission.review.source, reviewer_session_id: mission.review.child ?? null,
      result: mission.review.result ?? null } : null,
    ...(run ? { run_id: run.runID, status: run.phase, decision: run.decision,
      units: run.units.map(unit => ({ id: unit.unit.id, title: unit.unit.title, status: unit.status,
        child_session_id: unit.childSessionID, result_class: unit.resultClass, evidence: unit.evidence })) } : {}),
    next_action: run?.phase === "awaiting-decision" ? "Coordinator: correct the cause and call plan_units with the remaining work and all requirements; budget is cumulative."
      : run?.phase === "awaiting-acceptance" ? "Coordinator: obtain required independent review, then submit_mission. Operator: compare all requirements with source/evidence before complete_mission."
      : "Coordinator: continue the next useful unit within original requirements. Return only a completion candidate, user-only decision, or scope/budget extension." };
}

/** Models forward a short capability, never recopy the host's evidence hashes and source packet. */
export function missionReviewTask(mission: OperatorMission): OperatorTask {
  const review = mission.review;
  if (!review?.task) throw new Error("mission-review-task-unavailable");
  return { ...review.task, prompt: `${MISSION_REVIEW_REFERENCE}${JSON.stringify({ r: mission.root,
    m: mission.id, n: review.runID, h: digest(review.task.prompt) })}` };
}

/** Project explicitly grouped R-ID traces into the legacy reviewer's ordered criterion mapping. */
export function missionReviewTraces(mission: OperatorMission, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(item => typeof item === "string" && item.trim())) {
    throw new Error("mission-review-traces: supply concise implementation/test traces");
  }
  const grouped: { text: string; ids: string[] }[] = raw.map(text => ({ text,
    ids: /^\s*((?:R\d+\s*[/,]?\s*)+):/u.exec(text)?.[1]?.match(/R\d+/gu) ?? [] }));
  if (grouped.every(item => item.ids.length === 0) && raw.length === mission.requirements.length) return raw;
  const unknown = grouped.flatMap(item => item.ids).filter(id => !mission.requirements.some(requirement => requirement.id === id));
  const missing = mission.requirements.filter(requirement => !grouped.some(item => item.ids.includes(requirement.id)));
  if (unknown.length || missing.length) throw new Error(`mission-review-traces: name the existing R IDs; missing ${missing.map(item => item.id).join(", ")}; unknown ${unknown.join(", ")}`);
  return mission.requirements.map(requirement => grouped.filter(item => item.ids.includes(requirement.id)).map(item => item.text).join("\n"));
}
