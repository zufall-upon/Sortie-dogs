import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeExecutionScope } from "./path.js";
import { parseOperatorPlan, type OperatorPlan, type OperatorState, type OperatorTask, type OperatorRuntime } from "./operator-runtime.js";
import { profileAgent, type RuntimeProfile } from "./runtime-profile.js";
import { normalizeCommand } from "../plugin/gate.js";

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
export interface MissionContext extends MissionRequest { role: "user" | "assistant" }
export interface MissionEvidenceExcerpt { path: string; offset: number; limit: number }
export interface MissionReviewScope { read: string[]; write: string[];
  validationBindings?: NonNullable<import("./goal-bound.js").GoalEvidence["protected_binding"]>[] }
export interface MissionConsultation {
  id: string;
  role: "advisor" | "scout";
  disposition: "skipped" | "dispatched";
  reason: string;
  at: string;
  trigger?: string;
  question?: string;
  callID?: string;
  childSessionID?: string;
  observedModel?: string;
  observedVariant?: string;
  outcome?: "completed" | "failed" | "unknown";
  result?: string;
}
export interface CodexWorkerDispatch {
  missionID: string; runID: string; unitID: string; threadID: string; turnID: string; callID: string;
  inputHash: string; childThreadID: string; clientUserMessageID: string; ownerGeneration: string;
}
export interface CodexCompletedTaskProof {
  dispatch: CodexWorkerDispatch; childTurnID: string;
}
export interface MissionAttempt {
  attemptID: string;
  runID: string;
  unitID: string;
  taskID: string;
  predecessorAttemptID?: string | null;
  /** Fingerprint of the settled scoped candidate against which a later Rescue is proposed. */
  candidateID?: string;
  kind: "implementation" | "normal_remediation" | "astra_rescue" | "reviewer_correction" | "direct_execution";
  status: "pending" | "dispatched" | "succeeded" | "failed" | "cancelled" | "unconfirmed";
  callID?: string;
  childSessionID?: string;
  dispatchFingerprint?: string;
  /** Exact native request binding written before this Worker turn is sent. */
  codexDispatch?: CodexWorkerDispatch;
  nativeOutcome?: "completed" | "failed" | "unknown";
  terminal?: import("../plugin/runtime-bridge.js").MissionWorkerTerminalRecord;
  observedModel?: string;
  observedVariant?: string;
  failure?: { category: "infrastructure" | "authorization" | "contract" | "cancellation" | "implementation" | "unknown"; code: string };
  resultClass?: string;
  selectedModel?: string;
}
export interface MissionTerminalRescue {
  attemptID: string;
  runID: string;
  unitID: string;
  selectedModel?: string;
  selectedVariant?: string | null;
  status: "prepared" | "dispatched" | "succeeded" | "failed" | "cancelled" | "unconfirmed" | "non_rescue";
  reason?: string;
  observedModel?: string;
  observedVariant?: string;
  outcome?: "succeeded" | "failed" | "cancelled" | "unknown";
}
export interface MissionExecution {
  commands: string[];
  directory: string;
  observations: { command: string; directory: string; callID: string; sessionID: string; startedAt: string;
    completedAt?: string; exit?: number; status?: "running" | "completed" | "error"; shellID?: string;
    outcome?: "not-started" | "execution-failed" | "executed"; result?: Record<string, unknown> }[];
}
export interface MissionLaunchConditions {
  entrypoint?: string;
  inputs?: string[];
  timeout_seconds?: number;
  cost_limit_usd?: number;
  benchmark_attempts?: number;
  grading?: "none" | "official";
  source: string;
  applies_to: string;
  recordedAt?: string;
}
/** Native terminal self-recheck by the correction author, explicitly not independent approval. */
export interface MissionSelfRecheck {
  runID: string;
  source: string;
  /** Candidate source/check identity, excluding optional excerpt presentation. */
  candidateSource?: string;
  author: string;
  callID: string;
  promptID: string;
  messageID: string;
  nativeOutcome: "completed";
  result: string;
  unresolvedFindings: string[];
  residualMajor?: { reachable_path: string; consequence: string };
}
export interface CodexUsageTotal {
  totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number;
}
export interface CodexUsageObservation {
  threadID: string; turnID: string; startedAt: number; updatedAt: number;
  agent: string; model: { providerID: string; modelID: string };
  total?: CodexUsageTotal; baseline?: CodexUsageTotal;
  /** Set only after a native terminal result; active snapshots cannot seed another turn. */
  terminal?: boolean;
}
export interface CodexMissionOwner {
  pid: number; bootID?: string; startTicks?: string; generation: string; closed?: boolean;
  platform?: NodeJS.Platform;
}

async function codexProcessStart(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const ticks = value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
  if (!ticks || !/^\d+$/.test(ticks)) throw new Error("codex-process-identity-unavailable");
  return ticks;
}
export async function codexProcessOwner(): Promise<CodexMissionOwner> {
  const owner: CodexMissionOwner = { pid: process.pid, generation: randomUUID(), platform: process.platform };
  if (process.platform === "linux") {
    owner.bootID = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    owner.startTicks = await codexProcessStart(process.pid);
  }
  return owner;
}
export async function codexOwnerGone(owner: CodexMissionOwner | undefined): Promise<boolean> {
  if (!owner) return false;
  if (owner.closed) return true;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.platform && owner.platform !== process.platform) return false;
  if (process.platform === "win32" && owner.platform === "win32") {
    // Windows has no /proc identity. Only an absent PID proves this owner gone;
    // PID reuse, access denial and legacy/unidentified owners stay unresolved.
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  if (process.platform !== "linux" || !owner.bootID || !owner.startTicks) return false;
  try {
    if ((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== owner.bootID) return true;
    return await codexProcessStart(owner.pid) !== owner.startTicks;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

export interface CodexNotStartedProof {
  missionID: string; threadID: string; turnID: string; callID: string; inputHash: string;
  ownerGeneration: string;
}
export interface OperatorMission {
  /** Native transport identity; execution and recovery remain in this Mission. */
  executionHost?: "codex";
  /** Adapter liveness only; unit execution/settlement remain in the existing run ledger. */
  codexOwner?: CodexMissionOwner;
  /** Final native accounting observations; execution authority remains in attempts and the goal ledger. */
  codexUsage?: CodexUsageObservation[];
  codexNotStarted?: CodexNotStartedProof[];
  /** Missing parent receipts reconciled from exact completed native Worker turns. */
  codexCompletedTasks?: CodexCompletedTaskProof[];
  version: "0.12";
  id: string;
  root: string;
  requests: MissionRequest[];
  /** Prior public conversation context, not additional immutable requirements. */
  context?: MissionContext[];
  /** Explicit continue deliveries, keyed by the original real turn. */
  steering?: { requestID: string; child: string; status: "pending" | "queued" }[];
  kind?: "implementation" | "operation";
  /** Native shell observations of the requested operation, separate from auxiliary checks. */
  execution?: MissionExecution;
  /** Fixed benchmark conditions and their provenance, separate from internal Worker counters. */
  launchConditions?: MissionLaunchConditions[];
  requirements: { id: string; text: string }[];
  /** Explicit user path prohibitions, unlike the Coordinator's estimated write list. */
  prohibitedWrite?: string[];
  /** The current user intentionally replaced the predecessor's requirements. */
  requirementsReplaced?: boolean;
  phase: "open" | "running" | "submitted" | "completed" | "cancelled";
  coordinator: string | null;
  callID: string | null;
  dispatchOpen: boolean;
  runID: string | null;
  /** Git HEAD before this mission's first implementation unit, retained across replans and commits. */
  reviewBaseline?: string;
  /** A dated host Git observation, never an inference from a Worker report or lifecycle plan. */
  deliveryObservation?: {
    run_id: string; observed_at: string; head: string | null; branch: string | null; clean: boolean; source: string;
  };
  /** Cumulative declared review inputs/outputs, including units that failed after writing source. */
  reviewScope?: MissionReviewScope;
  /** Optional Advisor/Scout decisions and native consultation outcomes; never an admission gate. */
  consultations?: MissionConsultation[];
  /** Host-observed current-Mission Worker attempts; only an implementation failure followed by a failed remediation can qualify for Rescue. */
  attempts?: MissionAttempt[];
  /** One bounded Astra Rescue per eligible unit; validation, independent review and root acceptance remain separate. */
  rescue?: MissionTerminalRescue;
  /** A cancelled run replaced by a later real user turn; never reuse its acceptance or evidence. */
  supersededRunID?: string;
  plans: number;
  progress: { unit: string; title: string; status: string; at: string }[];
  submission: { status: "ready" | "needs-decision" | "blocked"; summary: string } | null;
  review?: { runID: string; risk: string[]; source: string; candidateSource?: string; task: OperatorTask | null;
    callID?: string;
    evidence?: MissionEvidenceExcerpt[];
    requestFingerprint?: string;
    verdict: "pending" | "PASS" | "findings" | "evidence-gaps" | "skipped-low-risk" | "self-rechecked"; result?: string; child?: string;
    mode?: "independent" | "self-recheck";
    admittedAt?: number;
    promptID?: string;
    selfRecheck?: MissionSelfRecheck;
    /** Completed, independent initial review for this mission, not merely an inherited child ID. */
    initialPrompt?: string;
    /** Observed evidence-only reviews; reporting only, never an acceptance threshold. */
    evidenceGapReviews?: number };
  /** Retained independently of later review generations; authors never become independent reviewers. */
  corrections?: { author: string; reviewIdentity: string; priorRunID: string; runID: string;
    priorSource: string; findings: string; initialPrompt: string; baseline?: string;
    /** Actual still-running initial Review; direct correction is not another child terminal. */
    inlineReview?: { callID: string; promptID: string; admittedAt: number; reviewIdentity: string };
    status: "prepared" | "running" | "ready" | "failed" | "cancelled";
    selfRecheck?: MissionSelfRecheck }[];
}

export const MISSION_CONSULTATION_LIMIT = 32;

/** Review coverage survives a narrower replan; it is not a Worker write grant. */
export function missionReviewScope(previous: MissionReviewScope | undefined, ...runs: OperatorState[]): MissionReviewScope {
  const bindings = [...(previous?.validationBindings ?? []), ...runs.flatMap(run => run.units.flatMap(unit =>
    (unit.evidence ?? []).flatMap(proof => proof.protected_binding?.freshness ? [proof.protected_binding] : [])))];
  return {
    read: [...new Set([...(previous?.read ?? []), ...runs.flatMap(run => run.units.flatMap(({ unit }) => unit.read ?? []))])].sort(),
    write: [...new Set([...(previous?.write ?? []), ...runs.flatMap(run => run.units.flatMap(({ unit }) => unit.write))])].sort(),
    ...(bindings.length ? { validationBindings: [...new Map(bindings.map(binding => [JSON.stringify(binding), binding])).values()] } : {}),
  };
}

/** Classify an independent Reviewer's first line. Anything else is a finding. */
export function missionReviewVerdict(text: string): "PASS" | "evidence-gaps" | "findings" {
  return /^\s*PASS(?:\s|$)/u.test(text) ? "PASS" : /^\s*EVIDENCE_GAPS(?:\s|$)/u.test(text) ? "evidence-gaps" : "findings";
}

/** Whether the recorded review permits submission and acceptance of the current candidate. */
export function missionReviewAccepted(review: NonNullable<OperatorMission["review"]>): boolean {
  if (review.verdict === "self-rechecked") {
    const checked = review.selfRecheck;
    return review.mode === "self-recheck" && !!checked && checked.runID === review.runID &&
      checked.source === review.source && checked.author === review.child && checked.callID === review.callID &&
      checked.promptID === review.promptID && !!checked.messageID && checked.nativeOutcome === "completed" &&
      checked.unresolvedFindings.length === 0 && !checked.residualMajor;
  }
  if (review.mode === "self-recheck") return false;
  return review.verdict === "PASS" || review.verdict === "skipped-low-risk" ||
    review.verdict === "evidence-gaps";
}

/** A short native report, not a tag/hash-based second-review policy or an approval checklist. */
export function missionSelfRecheckReport(text: string, source: string, hostBound = false): Pick<MissionSelfRecheck, "unresolvedFindings" | "residualMajor"> | undefined {
  if (!/^\s*SELF_RECHECKED(?:\s|$)/u.test(text)) return undefined;
  const line = /^self_recheck: (.+)$/mu.exec(text)?.[1];
  try {
    const report: unknown = JSON.parse(line ?? "");
    if (!record(report) || (report.candidate !== source && !(hostBound && report.candidate === "current-validated")) || !Array.isArray(report.unresolved_findings) ||
        !report.unresolved_findings.every(item => typeof item === "string" && item.trim()) ||
        !(report.residual_major === null || record(report.residual_major) &&
          typeof report.residual_major.reachable_path === "string" && report.residual_major.reachable_path.trim() &&
          typeof report.residual_major.consequence === "string" && report.residual_major.consequence.trim())) return undefined;
    return { unresolvedFindings: report.unresolved_findings,
      ...(record(report.residual_major) ? { residualMajor: { reachable_path: report.residual_major.reachable_path as string,
        consequence: report.residual_major.consequence as string } } : {}) };
  } catch { return undefined; }
}

export function missionExecutionStatus(mission: OperatorMission): "not-required" | "not-started" | "running" | "execution-failed" | "executed" {
  if (mission.kind !== "operation") return "not-required";
  const execution = mission.execution;
  if (!execution || execution.observations.length === 0) return "not-started";
  const latest = execution.commands.map(command => [...execution.observations].reverse().find(item => item.command === command && item.directory === execution.directory));
  if (latest.some(item => item && !item.completedAt)) return "running";
  if (latest.some(item => item?.outcome === "execution-failed" || (item && (item.status === "error" || item.exit !== 0)))) return "execution-failed";
  return latest.every(item => item?.outcome === "executed") ? "executed" : "not-started";
}

/** Observe the command's own terminal summary, never Worker/Reviewer prose. Scores are result data,
 * not process success. Unstructured commands retain their native exit semantics. */
export function missionCommandOutcome(output: unknown, exit: unknown, status: unknown): {
  outcome: "not-started" | "execution-failed" | "executed"; result?: Record<string, unknown>;
} {
  const text = typeof output === "string" ? output.trim() : "";
  let result: Record<string, unknown> | undefined;
  for (const value of [text, ...text.split(/\r?\n/u).reverse().slice(0, 8)]) {
    try { const parsed: unknown = JSON.parse(value); if (record(parsed)) { result = parsed; break; } } catch { /* not a JSON summary */ }
  }
  const state = String(result?.status ?? "").toLowerCase().replaceAll("_", "-");
  const summary = result ? Object.fromEntries(["status", "attempts", "launches", "inference_count", "reward", "score", "session_id", "exit"]
    .filter(key => Object.hasOwn(result!, key)).map(key => [key, result![key]])) : undefined;
  const outcome = ["no-start", "not-started", "prepared", "preflight"].includes(state) || text === "NO_START" ||
    [result?.attempts, result?.launches, result?.inference_count].some(value => value === 0) ? "not-started"
    : status === "error" || exit !== 0 || ["execution-failed", "setup-failed", "route-failed"].includes(state)
      ? "execution-failed" : "executed";
  return { outcome, ...(summary ? { result: summary } : {}) };
}

/** Bounded public text only: tool logs and private reasoning are not delegation context. */
export function missionConversationContext(messages: readonly Record<string, unknown>[]): MissionContext[] {
  const entries = messages.flatMap(message => {
    const info = record(message.info) ? message.info : message;
    if ((info.role !== "user" && info.role !== "assistant") || typeof info.id !== "string" || !Array.isArray(message.parts)) return [];
    const text = message.parts.filter(record).filter(part => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
      .map(part => part.text as string).join("\n");
    return text.trim() ? [{ id: info.id, role: info.role as "user" | "assistant", text: text.slice(0, 4_000) }] : [];
  });
  // Keep the last two user exchanges, including the current request, rather than the last N tools.
  const users = entries.flatMap((entry, i) => entry.role === "user" ? [i] : []);
  return entries.slice(users.at(-2) ?? 0).slice(-8);
}

/** Durable user intent and dispatch ownership. Execution/evidence still belong to the v0.10 engine. */
export class OperatorMissionRuntime {
  private static readonly writes = new Map<string, Promise<unknown>>();
  constructor(readonly projectRoot: string, readonly profile: RuntimeProfile) {}
  private file(root: string, suffix = ""): string {
    return join(this.projectRoot, this.profile.stateDirectory, "missions", `${digest(root)}${suffix}.json`);
  }
  correctionReference(root: string, reviewIdentity: string): string {
    return JSON.stringify({ path: this.file(root), field: "corrections[]", review_identity: reviewIdentity });
  }
  private async load<T>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(file, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  /** Recover non-replacement continuations only; an explicit replacement must link the current cancelled run. */
  private async loadMission(root: string): Promise<OperatorMission | undefined> {
    const state = await this.load<OperatorMission>(this.file(root));
    if (!state || state.supersededRunID !== undefined || state.runID !== null || state.requirementsReplaced ||
        !["open", "running", "submitted", "cancelled"].includes(state.phase) || state.requests.length === 0) return state;
    const directory = join(this.projectRoot, this.profile.stateDirectory, "missions");
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return state; throw error; }
    const prefix = `${digest(root)}.mission-`;
    const candidates = entries.filter(name => name.startsWith(prefix) && /^mission-[a-f0-9-]+\.json$/u.test(name.slice(digest(root).length + 1)));
    const matches: OperatorMission[] = [];
    for (const name of candidates) {
      const previous = await this.load<OperatorMission>(join(directory, name));
      if (previous?.root === root && previous.phase === "cancelled" &&
          (previous.runID !== null || previous.supersededRunID !== undefined) &&
          (previous.runID === null || previous.requests[0]?.id !== state.requests[0]!.id) &&
          previous.requests.some(request => request.id === state.requests[0]!.id)) matches.push(previous);
    }
    if (matches.length === 1) {
      const predecessor = matches[0]!.runID ?? matches[0]!.supersededRunID;
      if (predecessor && (matches[0]!.runID !== null || await this.archivedRun(root, predecessor))) {
        state.supersededRunID = predecessor;
      }
    }
    return state;
  }
  /** Find exactly one archived cancelled mission that owned this run; ambiguity never grants recovery. */
  async archivedRun(root: string, runID: string): Promise<OperatorMission | undefined> {
    const directory = join(this.projectRoot, this.profile.stateDirectory, "missions");
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const prefix = `${digest(root)}.mission-`;
    const matches: OperatorMission[] = [];
    for (const name of entries.filter(name => name.startsWith(prefix) &&
      /^mission-[a-f0-9-]+\.json$/u.test(name.slice(digest(root).length + 1)))) {
      const state = await this.load<OperatorMission>(join(directory, name));
      if (state?.root === root && state.phase === "cancelled" && state.runID === runID &&
          state.coordinator !== null && state.callID !== null) matches.push(state);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  private async save(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(join(this.projectRoot, this.profile.stateDirectory, "missions"), { recursive: true });
    try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  private async serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const key = this.file(root);
    const current = (OperatorMissionRuntime.writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    OperatorMissionRuntime.writes.set(key, current);
    try { return await current; } finally { if (OperatorMissionRuntime.writes.get(key) === current) OperatorMissionRuntime.writes.delete(key); }
  }
  async read(root: string): Promise<OperatorMission | undefined> {
    await OperatorMissionRuntime.writes.get(this.file(root));
    const state = await this.loadMission(root);
    if (state && (state.version !== "0.12" || state.root !== root)) throw new Error("mission-state-invalid");
    return state;
  }
  /** Serialize host recovery claims across processes; a stale lock never authorizes takeover. */
  async codexRecovery<T>(root: string, action: (state: OperatorMission) => Promise<T>): Promise<T> {
    const lock = `${this.file(root)}.codex-recovery.lock`;
    const owner = await codexProcessOwner();
    const marker = `owner.${owner.pid}.${owner.platform === "win32" ? "win32." : ""}${owner.bootID ?? "unknown"}.${owner.startTicks ?? "unknown"}.${owner.generation}`;
    for (let attempt = 0; attempt < 200; attempt++) {
      let acquired = false;
      const staging = `${lock}.${owner.generation}.tmp`;
      try {
        await mkdir(staging);
        await open(join(staging, marker), "wx", 0o600).then(handle => handle.close());
        // Publish owner and lock together. rename cannot replace another nonempty owner directory.
        await rename(staging, lock);
        acquired = true;
      } catch { /* Another live claimant owns this short metadata transaction. */ }
      finally { await rm(staging, { recursive: true, force: true }); }
      if (acquired) {
        try { return await action(await this.required(root)); }
        finally { await unlink(join(lock, marker)); await rmdir(lock).catch(() => undefined); }
      }
      await unlink(join(lock, marker)).catch(() => undefined);
      const names = await readdir(lock).catch(() => []);
      if (names.length === 1) {
        // Retain legacy Linux markers; old Windows "unknown" owners are not proof.
        const match = /^owner\.(\d+)\.(?:(linux|win32)\.)?([a-f0-9-]+|unknown)\.(\d+|unknown)\.([a-f0-9-]+)$/.exec(names[0]!);
        if (match && await codexOwnerGone({ pid: Number(match[1]), platform: match[2] as NodeJS.Platform | undefined,
          bootID: match[3] === "unknown" ? undefined : match[3], startTicks: match[4] === "unknown" ? undefined : match[4], generation: match[5]! })) {
          // Remove only the dead owner's unique marker; never unlink a replacement owner's file.
          await unlink(join(lock, names[0]!)).catch(() => undefined);
        }
      }
      // Live locks are published nonempty; a replacement marker prevents this removal.
      await rmdir(lock).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("codex-mission-recovery-busy");
  }
  /** Current Mission records only; request captures and archived generations are excluded. */
  async current(): Promise<OperatorMission[]> {
    const directory = join(this.projectRoot, this.profile.stateDirectory, "missions");
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: OperatorMission[] = [];
    for (const entry of entries.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
      const state = await this.load<OperatorMission>(join(directory, entry));
      if (!state || typeof state.root !== "string" || this.file(state.root) !== join(directory, entry)) throw new Error("mission-state-invalid");
      result.push(await this.required(state.root));
    }
    return result;
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
    });
  }
  recordLaunchConditions(root: string, raw: unknown): Promise<OperatorMission> {
    if (!record(raw) || typeof raw.source !== "string" || !raw.source.trim() || typeof raw.applies_to !== "string" || !raw.applies_to.trim() ||
        (raw.entrypoint !== undefined && (typeof raw.entrypoint !== "string" || !raw.entrypoint.trim())) ||
        (raw.inputs !== undefined && (!Array.isArray(raw.inputs) || !raw.inputs.every(path => typeof path === "string" && path.trim()))) ||
        ["timeout_seconds", "cost_limit_usd", "benchmark_attempts"].some(key => raw[key] !== undefined &&
          (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || (raw[key] as number) <= 0)) ||
        (raw.benchmark_attempts !== undefined && !Number.isSafeInteger(raw.benchmark_attempts)) ||
        (raw.grading !== undefined && !["none", "official"].includes(String(raw.grading))) ||
        Object.keys(raw).some(key => !["entrypoint", "inputs", "timeout_seconds", "cost_limit_usd", "benchmark_attempts", "grading", "source", "applies_to"].includes(key))) {
      throw new Error("mission-launch-conditions-invalid");
    }
    return this.update(root, state => {
      state.launchConditions ??= [];
      if (state.launchConditions.some(item => { const { recordedAt: _at, ...value } = item; return JSON.stringify(value) === JSON.stringify(raw); })) return;
      state.launchConditions.push({ ...raw, recordedAt: new Date().toISOString() } as unknown as MissionLaunchConditions);
    });
  }
  start(root: string, requirements: unknown, replaceRequirements = false,
    options: { kind?: OperatorMission["kind"]; context?: MissionContext[]; cancelledRunID?: string; executionHost?: "codex" } = {}): Promise<OperatorMission> {
    return this.serial(root, async () => {
      if (!Array.isArray(requirements) || requirements.length === 0 || requirements.length > 64 ||
          !requirements.every(item => typeof item === "string" && item.trim() && !/[\r\n]/u.test(item))) {
        throw new Error("mission-requirements: supply 1..64 concise one-line requirements including negative constraints");
      }
      const request = await this.load<MissionRequest>(this.file(root, ".request"));
      if (!request) throw new Error("mission-original-request-unavailable");
      const previous = await this.loadMission(root);
      if (previous && !["completed", "cancelled"].includes(previous.phase)) {
        if (previous.requirements.some((item, index) => requirements[index] !== item.text)) {
          throw new Error("mission-requirements-preserved: keep the existing ordered requirements and append user additions");
        }
        previous.requirements = requirements.map((text, index) => ({ id: `R${index + 1}`, text }));
        // Only an explicit Mission action adopts the latest real turn; chat capture alone never does.
        if (!previous.requests.some(item => item.id === request.id)) previous.requests.push(request);
        if (options.kind === "operation") previous.kind = "operation";
        await this.save(this.file(root), previous);
        return previous;
      }
      if (previous) await this.save(this.file(root, `.${previous.id}`), previous);
      // The Operator runtime's current cancelled run is authoritative for an explicit
      // replacement. A no-run mission can still carry an older ancestor's run ID.
      // Ordinary continuation retains that predecessor when no current run is supplied.
      const predecessor = (replaceRequirements ? options.cancelledRunID : undefined) ??
        previous?.runID ?? previous?.supersededRunID;
      const state: OperatorMission = { version: "0.12", id: `mission-${randomUUID()}`, root, requests: [request],
        kind: options.kind ?? "implementation", ...(options.executionHost ? { executionHost: options.executionHost } : {}),
        ...(previous?.codexNotStarted ? { codexNotStarted: previous.codexNotStarted } : {}),
        ...(previous?.codexCompletedTasks ? { codexCompletedTasks: previous.codexCompletedTasks } : {}),
        ...(previous?.codexUsage ? { codexUsage: previous.codexUsage } : {}),
        context: (options.context ?? []).filter(item => item.id !== request.id),
        requirements: requirements.map((text, index) => ({ id: `R${index + 1}`, text })), phase: "open",
        ...(replaceRequirements ? { requirementsReplaced: true } : {}),
        coordinator: null, callID: null, dispatchOpen: false, runID: null, plans: 0, progress: [], submission: null,
        ...((previous === undefined || previous.phase === "cancelled") &&
          (replaceRequirements || previous?.runID === null || previous === undefined || request.id !== previous.requests[0]?.id) && predecessor
          ? { supersededRunID: predecessor } : {}) };
      await this.save(this.file(root), state);
      return state;
    });
  }
  update(root: string, change: (state: OperatorMission) => void): Promise<OperatorMission> {
    return this.serial(root, async () => {
      const state = await this.loadMission(root);
      if (!state) throw new Error("mission-missing");
      change(state);
      await this.save(this.file(root), state);
      return state;
    });
  }
  recordConsultationSkip(root: string, role: MissionConsultation["role"], reason: string): Promise<OperatorMission> {
    if ((role !== "advisor" && role !== "scout") || typeof reason !== "string" || !reason.trim() ||
        reason.length > 1000 || /[\r\n]/u.test(reason)) throw new Error("mission-consultation-input-invalid");
    return this.update(root, state => {
      state.consultations = [...(state.consultations ?? []), { id: randomUUID(), role, disposition: "skipped" as const,
        reason: reason.trim(), at: new Date().toISOString() }].slice(-MISSION_CONSULTATION_LIMIT);
    });
  }
  recordConsultationDispatch(root: string, input: { role: MissionConsultation["role"]; callID: string; reason: string;
    trigger?: string; question?: string }): Promise<OperatorMission> {
    if ((input.role !== "advisor" && input.role !== "scout") || !input.callID || !input.reason.trim() ||
        input.reason.length > 1000 || /[\r\n]/u.test(input.reason) ||
        (input.trigger !== undefined && (input.trigger.length > 128 || /[\r\n]/u.test(input.trigger))) ||
        (input.question !== undefined && (input.question.length > 1000 || /[\r\n]/u.test(input.question)))) {
      throw new Error("mission-consultation-input-invalid");
    }
    return this.update(root, state => {
      state.consultations = [...(state.consultations ?? []), { id: randomUUID(), role: input.role,
        disposition: "dispatched" as const, reason: input.reason.trim(), at: new Date().toISOString(), callID: input.callID,
        ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
        ...(input.question === undefined ? {} : { question: input.question }) }].slice(-MISSION_CONSULTATION_LIMIT);
    });
  }
  settleConsultation(root: string, callID: string, outcome: MissionConsultation["outcome"], details: {
    childSessionID?: string; observedModel?: string; observedVariant?: string; result?: string;
  } = {}): Promise<OperatorMission> {
    if (!callID || !["completed", "failed", "unknown"].includes(String(outcome))) throw new Error("mission-consultation-input-invalid");
    return this.update(root, state => {
      const item = [...(state.consultations ?? [])].reverse().find(entry => entry.callID === callID);
      if (!item) return;
      if (details.result !== undefined && details.result.length > 4000) details.result = details.result.slice(0, 4000);
      Object.assign(item, { outcome, ...details });
    });
  }
  /** Keep host-accepted criteria ahead of new text, including an exactly linked settled predecessor. */
  carryForward(root: string, missionID: string, acceptance: readonly string[], supersededRunID?: string): Promise<OperatorMission> {
    return this.update(root, state => {
      if (state.id !== missionID || state.supersededRunID !== supersededRunID || state.runID !== null ||
          !["open", "running"].includes(state.phase) || (state.dispatchOpen && state.coordinator === null) ||
          acceptance.length === 0 || acceptance.some(text => typeof text !== "string" || !text.trim())) {
        throw new Error("mission-acceptance-carry-forward-unavailable");
      }
      const existing = state.requirements.map(item => item.text);
      if (acceptance.every((text, index) => existing[index] === text)) return;
      const additions = existing.filter(text => !acceptance.includes(text));
      if (acceptance.length + additions.length > 64) throw new Error("mission-requirements-limit: carried acceptance and additions exceed 64");
      state.requirements = [...acceptance, ...additions].map((text, index) => ({ id: `R${index + 1}`, text }));
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
      // The description is a presentation label. The opaque prompt binds the original request and
      // requirements; changing only the label must not force a second Coordinator dispatch.
      if (["cancelled", "completed"].includes(state.phase) || state.dispatchOpen || args.subagent_type !== expected.subagent_type ||
          (!resume && (args.prompt !== expected.prompt || args.task_id))) {
        const reason = ["cancelled", "completed"].includes(state.phase) ? `mission is ${state.phase}`
          : state.dispatchOpen ? "Coordinator Task is still admitted; read operator_status to reconcile its native completion"
            : args.task_id && args.task_id !== state.coordinator ? `this location owns Coordinator ${state.coordinator ?? "not yet claimed"}, not ${String(args.task_id)}`
              : "use the exact Coordinator task returned by operator_status in this mission's project_root";
        throw new Error(`mission-dispatch-not-authorized: ${reason}`);
      }
      state.phase = "running"; state.callID = callID; state.dispatchOpen = true; state.submission = null;
    });
  }
  /** Reopen only the exact dispatch whose native Task has a terminal record after a server restart. */
  reconcileFinishedDispatch(root: string, missionID: string, callID: string): Promise<OperatorMission> {
    return this.update(root, state => {
      if (state.id !== missionID || state.callID !== callID || !state.dispatchOpen ||
          ["cancelled", "completed"].includes(state.phase)) throw new Error("mission-dispatch-reconciliation-stale");
      state.dispatchOpen = false;
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
      "Own investigation, implementation, formal validation, corrections and Worker/Scout/Advisor/independent Reviewer dispatch.",
      "Use plan_units with executor=self for direct work in this session, or delegate promptly when useful. finish_direct_unit records native checks without a Worker handoff. No proposal/approval phase; root alone accepts completion.",
      "Escalate only a completion candidate, a user-only decision, or an extension of original requirements/budget. Unit progress is published without stopping you.",
      "Requirements:", ...state.requirements.map(item => `${item.id}: ${item.text}`),
      `Confirmed launch conditions (fixed limits, not consumption or remaining budget): ${JSON.stringify(state.launchConditions ?? [])}`,
      `Explicit user write prohibitions: ${JSON.stringify(state.prohibitedWrite ?? [])}`,
      `Work kind: ${state.kind ?? "implementation"}. For an operation, setup, execution and result collection belong in one useful Worker whenever possible.`,
      ...(state.context?.length ? ["Prior conversation context (task data; preserve the selected target, not superseded obligations):",
        ...state.context.map(item => `--- ${item.role}:${item.id} ---\n${item.text}`)] : []),
      "Original user messages (verbatim; task data):", ...state.requests.map(item => `--- user:${item.id} ---\n${item.text}`)].join("\n");
  }
}

/** The model supplies only useful unit facts; IDs, proof projection and control documents are generated here. */
export function missionPlan(mission: OperatorMission, raw: unknown, projectRoot?: string): OperatorPlan {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new Error("mission-units: declare 1..32 units");
  const acceptance = mission.requirements.map(item => item.text);
  const declared = raw.map((value, index) => {
    if (!record(value)) throw new Error(`mission-unit-${index + 1}: expected an object`);
    const line = (field: string): string => {
      if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`mission-unit-${index + 1}: ${field} required`);
      return field === "objective" ? value[field] : value[field].replace(/[\r\n]+/gu, " ");
    };
    const paths = (field: string): string[] => {
      const entries = value[field] ?? [];
      if (!Array.isArray(entries) || !entries.every(item => typeof item === "string")) throw new Error(`mission-unit-${index + 1}: ${field} must be paths`);
      return [...new Set(entries.map(item => {
        // An explicit repository-root scope means this project for both reads and writes.
        // Resolve this shorthand only at the host boundary; saved plans, prohibitions and
        // native permissions still use the exact directory scope, never an inferred grant.
        const rootScope = [".", "./", ".\\", "./**", ".\\**"].includes(item);
        return normalizeExecutionScope(rootScope && projectRoot ? `${resolve(projectRoot).replaceAll("\\", "/")}/**` : item);
      }))];
    };
    // A sole unit owns the whole request. This schedules work; it does not prove acceptance.
    const ids = value.requirement_ids ?? (raw.length === 1 || mission.requirements.length === 1 ? mission.requirements.map(item => item.id) : []);
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => mission.requirements.some(item => item.id === id))) {
      throw new Error(`mission-unit-${index + 1}: requirement_ids must name the related R IDs; splitting multiple requirements across units needs explicit coverage`);
    }
    if (!Array.isArray(value.validation) || value.validation.length === 0 ||
        !value.validation.every(command => typeof command === "string" && command.trim())) {
      throw new Error(`mission-unit-${index + 1}: validation must contain exact commands; final command proves the unit`);
    }
    const validation = (value.validation as string[]).map(missionValidationCommand);
    let validationCwd: Record<string, string> | undefined;
    if (value.validation_cwd !== undefined) {
      if (!projectRoot || !record(value.validation_cwd)) throw new Error(`mission-unit-${index + 1}: validation_cwd must map commands to directories`);
      validationCwd = {};
      for (const [command, directory] of Object.entries(value.validation_cwd)) {
        const identity = normalizeCommand(missionValidationCommand(command));
        if (!validation.map(normalizeCommand).includes(identity) || typeof directory !== "string" || !directory.trim() ||
            Object.hasOwn(validationCwd, identity)) throw new Error(`mission-unit-${index + 1}: invalid validation_cwd entry`);
        validationCwd[identity] = resolve(projectRoot, directory);
      }
    }
    return { id: `unit-${index + 1}`, title: line("title"), objective: line("objective"), read: paths("read"), write: paths("write"),
      validation,
      ...(validationCwd ? { validation_cwd: validationCwd } : {}),
      acceptance_indices: [...new Set(ids.map(id => mission.requirements.findIndex(item => item.id === id)))] };
  });
  // The serial engine counts new proof milestones. Units sharing the same final suite are one
  // milestone, so coalesce them instead of making the model repair a bookkeeping rejection.
  const units: typeof declared = [];
  for (const unit of declared) {
    const same = units.find(item => item.validation.at(-1) === unit.validation.at(-1) &&
      JSON.stringify(item.validation_cwd ?? {}) === JSON.stringify(unit.validation_cwd ?? {}));
    if (!same) { units.push(unit); continue; }
    same.objective += `; ${unit.objective}`;
    same.read = [...new Set([...same.read, ...unit.read])];
    same.write = [...new Set([...same.write, ...unit.write])];
    same.acceptance_indices = [...new Set([...same.acceptance_indices, ...unit.acceptance_indices])];
    same.validation = [...same.validation, ...unit.validation];
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
    units }, "execution");
}

/** Compact provenance, not a new acceptance verdict or a substitute for original-request comparison. */
export async function missionAcceptanceSummary(mission: OperatorMission, run: OperatorState | undefined,
  operators: OperatorRuntime, observe?: (validation: readonly string[], child: string | null, notBefore?: number) => Promise<unknown>): Promise<Record<string, unknown>> {
  const current = run?.runID === mission.runID ? run : undefined;
  const history = current ? await operators.acceptanceHistory(current, [...new Set((mission.attempts ?? []).map(item => item.runID))])
    : { status: "unavailable", runs: [], reason: "current-mission-run-unavailable" };
  const acceptedAnchor = (unit: OperatorState["units"][number]) => current?.priorAcceptedUnits.find(item => item.handoffPath === unit.handoffPath &&
      item.handoffHash === unit.hashes[0] && item.taskID === unit.task.prompt.match(/^task_id: (.+)$/mu)?.[1]);
  const missingAnchors = current?.priorAcceptedUnits.filter(anchor => !history.runs.some(item => item.state.units.some(unit =>
    unit.status === "succeeded" && acceptedAnchor(unit)?.taskID === anchor.taskID))) ?? [];
  const validation = (state: OperatorState, path: string | null, historical: boolean) => state.units.flatMap(unit => {
    const anchor = historical ? acceptedAnchor(unit) : undefined;
    if (historical && (!anchor || unit.status !== "succeeded")) return [];
    return (unit.evidence ?? []).map(proof => ({ run_id: state.runID, unit_id: unit.unit.id,
      task_id: unit.task.prompt.match(/^task_id: (.+)$/mu)?.[1] ?? null,
      worker_session_id: unit.directExecution ? null : unit.childSessionID,
      ...(unit.directExecution ? { execution_mode: "direct", executor_session_id: unit.directExecution.actor } : {}),
      state_archive_path: path, handoff_path: unit.handoffPath,
      ...(anchor ? { accepted_anchor: anchor } : {}), evidence_id: proof.evidence_id,
      command: proof.execution.command, exit: proof.execution.exit_code, outcome: proof.execution.outcome,
      started_at: proof.execution.started_at, ended_at: proof.execution.ended_at,
      identity: proof.identity,
      ...(proof.protected_binding ? { binding_hashes: { manifest_hash: proof.protected_binding.manifest_hash,
        ...(proof.protected_binding.freshness ? { contract_hash: proof.protected_binding.freshness.contract_hash } : {}) },
        operation_manifest_path: proof.protected_binding.manifest_path } : {}),
      details_ref: { path: path ?? operators.statePath(state.rootSessionID),
        unit_id: unit.unit.id, evidence_id: proof.evidence_id,
        omitted: "protected_binding path arrays, project root and environment remain in this exact persisted evidence record" },
      proof_scope: proof.proof_scope,
      applicability: historical ? "historical-reference; current applicability not established by this projection"
        : "current-run record; consult completion readiness for current protected identity" }));
  });
  const nativeValidation = await Promise.all([
    ...(current ? [{ path: null, state: current, historical: false }] : []),
    ...history.runs.map(item => ({ ...item, historical: true })),
  ].flatMap(item => item.state.units.filter(unit => !item.historical ||
    (unit.status === "succeeded" && acceptedAnchor(unit))).map(async unit => {
      const provenance = { run_id: item.state.runID, unit_id: unit.unit.id, worker_session_id: unit.childSessionID,
        state_archive_path: item.path, handoff_path: unit.handoffPath, historical: item.historical,
        authority: "native declared-command observations; not additional formal evidence or current freshness" };
      // Settled proof already records these commands. Do not fetch the same native
      // history again merely to render acceptance; freshness is checked separately.
      const proofs = unit.evidence ?? [];
      if (unit.status === "succeeded" && unit.unit.validation.every(command => proofs.some(proof =>
        proof.execution.exit_code === 0 && proof.execution.outcome === "pass" &&
        proof.execution.command.includes(command)))) {
        return { ...provenance, status: "recorded-formal-evidence",
          evidence_ids: proofs.map(proof => proof.evidence_id),
          details_ref: { field: "formal_validation", run_id: item.state.runID, unit_id: unit.unit.id } };
      }
      try {
        if (!observe || !unit.childSessionID) throw new Error("native-worker-history-unavailable");
        return { ...provenance, status: "available", observations: await observe(unit.unit.validation, unit.childSessionID,
          unit.directExecution ? Date.parse(unit.directExecution.startedAt) :
            unit.reviewerCorrection ? Date.parse(unit.reviewerCorrection.admittedAt ?? item.state.createdAt) : undefined) };
      } catch (error) {
        return { ...provenance, status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    })));
  return { original_requests: mission.requests, requirements: mission.requirements,
    history: { status: missingAnchors.length ? "unavailable" : history.status,
      ...(history.reason ? { reason: history.reason } : missingAnchors.length ? { reason: "accepted-handoff-anchor-unavailable" } : {}),
      ...(missingAnchors.length ? { unavailable_anchors: missingAnchors } : {}),
      selection: "same-mission Worker run IDs, parent lineage and exact accepted handoff anchors" },
    formal_validation: [...(current ? validation(current, null, false) : []),
      ...history.runs.flatMap(item => validation(item.state, item.path, true))],
    native_declared_validation: nativeValidation,
    independent_review: mission.review ? { run_id: mission.review.runID, current_run: mission.review.runID === current?.runID,
      independent: missionReviewIndependent(mission, mission.review.child), mode: mission.review.mode ?? "independent",
      reviewer_session_id: mission.review.child ?? null, source_fingerprint: mission.review.source,
      verdict: mission.review.verdict, result: mission.review.result ?? null, self_recheck: mission.review.selfRecheck ?? null,
      freshness: "not established by run ID; existing source comparison remains required" } : null,
    delivery: { submission: mission.submission, git_lifecycle: current?.gitLifecycle ?? null,
      observation: mission.deliveryObservation && mission.deliveryObservation.run_id === current?.runID ? mission.deliveryObservation : null,
      observation_source: "persisted operator Git lifecycle and formal validation records; no new Git inspection",
      clean: mission.deliveryObservation && mission.deliveryObservation.run_id === current?.runID ? mission.deliveryObservation.clean : "not independently observed by this projection" },
    interpretation: "Compare original requests with the submitted candidate and actual evidence. Historical PASS is not current PASS. Inspect concrete gaps, not routine archive searches or full source rereads. Existing completion and Review guards still apply." };
}

export function missionReviewIndependent(mission: OperatorMission, child: string | undefined): boolean {
  return child !== undefined && !(mission.corrections ?? []).some(correction => correction.author === child);
}

export function missionPacket(mission: OperatorMission, run?: OperatorState): Record<string, unknown> {
  const predecessor = run && mission.runID !== run.runID && (mission.supersededRunID === run.runID || run.phase === "cancelled") ? run : undefined;
  if (predecessor) run = undefined;
  const currentReview = mission.review !== undefined && mission.review.runID === (run?.runID ?? mission.runID);
  const reviewAccepted = currentReview && missionReviewAccepted(mission.review!);
  const operationStatus = missionExecutionStatus(mission);
  const operationComplete = operationStatus === "not-required" || operationStatus === "executed";
  return { mission_id: mission.id, phase: mission.phase, coordinator_session_id: mission.coordinator,
    ...(predecessor ? { predecessor: { run_id: predecessor.runID, status: predecessor.phase,
      completed_units: predecessor.units.filter(unit => unit.status === "succeeded").length,
      note: "Historical results and spend are retained; they do not complete the current requirements." } } : {}),
     requirements: mission.requirements, original_request_refs: mission.requests.map(item => `user:${item.id}`),
    launch_conditions: mission.launchConditions ?? [], prohibited_write: mission.prohibitedWrite ?? [],
     accounting_scope: "Implementation units (Worker, direct controller execution or scoped Reviewer correction) are not benchmark attempts. Host budget uses the existing unit ledger; orchestration, read-only Review and external campaign costs are excluded. Launch caps are fixed conditions, not a known campaign remainder.",
     delivery_observation: mission.deliveryObservation?.run_id === (run?.runID ?? mission.runID) ? mission.deliveryObservation : null,
    submission: mission.submission, progress: mission.progress, consultations: mission.consultations ?? [],
    attempts: mission.attempts ?? [], corrections: (mission.corrections ?? []).map(({ findings: _findings, initialPrompt: _prompt, ...item }) => item), ...(mission.rescue ? { rescue: mission.rescue } : {}),
    operation: { kind: mission.kind ?? "implementation", status: missionExecutionStatus(mission),
      ...(mission.execution ? { ...mission.execution } : {}) },
    execution_summary: { completed_units: run?.units.filter(unit => unit.status === "succeeded").length ?? 0,
      running_units: run?.units.filter(unit => unit.status === "running").map(unit => ({ id: unit.unit.id, title: unit.unit.title, child_session_id: unit.childSessionID })) ?? [],
      pending_units: run?.units.filter(unit => unit.status === "pending").length ?? 0,
      failed_units: run?.units.filter(unit => unit.status === "failed").length ?? 0,
      historical_failed_attempts: mission.progress.filter(unit => unit.status === "failed").length,
      accepted: mission.phase === "completed" },
    review: mission.review ? { risk_tags: mission.review.risk, verdict: mission.review.verdict,
      independent: missionReviewIndependent(mission, mission.review.child), mode: mission.review.mode ?? "independent",
      self_recheck: mission.review.selfRecheck ?? null,
      run_id: mission.review.runID, current_run: currentReview,
      source_fingerprint: mission.review.source, reviewer_session_id: mission.review.child ?? null,
      result: mission.review.result ?? null, evidence_gap_reviews: mission.review.evidenceGapReviews ?? 0,
      evidence_gaps_advisory: true, accepted: reviewAccepted,
      passed: currentReview && mission.review.verdict === "PASS", permits_submission: reviewAccepted && operationComplete } : null,
    ...(run ? { run_id: run.runID, status: run.phase, decision: run.decision,
      units: run.units.map(unit => ({ id: unit.unit.id, title: unit.unit.title, status: unit.status,
        child_session_id: unit.childSessionID, result_class: unit.resultClass, evidence: unit.evidence,
        handoff_path: unit.handoffPath, operation_manifest_path: unit.manifestPath,
         scope_read: unit.unit.read, scope_write: unit.unit.write, validation: unit.unit.validation,
         normal_remediation_used: unit.normalRemediationUsed ?? false,
         ...(unit.failure ? { failure: { outcome: unit.failure.outcome, exit_code: unit.failure.exitCode } } : {}),
         ...(unit.dispatchDenial ? { dispatch_denial: unit.dispatchDenial } : {}) })) } : {}),
    next_action: mission.phase === "completed" ? "Mission completed. Report the accepted result and retained review gaps; no further dispatch or completion call is needed."
      : mission.phase === "submitted" && mission.submission?.status === "ready"
       ? "Operator: use acceptance_summary to compare the submitted candidate with the verbatim original requests and actual evidence, inspect concrete gaps only, then complete_mission if satisfied. Do not routinely search archives or reread all source. Historical PASS is not current PASS. Report remaining evidence gaps; they are not a review PASS."
      : run?.phase === "awaiting-acceptance" && mission.corrections?.some(item => item.runID === run.runID && item.status === "ready") && !reviewAccepted
        ? mission.corrections.find(item => item.runID === run.runID)?.selfRecheck?.unresolvedFindings.length
          ? "Known Major/Medium findings remain after self-recheck. Call repair_review for the SAME original correction owner; do not dispatch another Reviewer or accept unresolved Medium. Retain original requirements and cumulative spend."
          : mission.corrections.find(item => item.runID === run.runID)?.selfRecheck?.residualMajor
            ? "A concrete reachable Major risk remains after native author self-recheck. Call review_mission for a DIFFERENT Reviewer of the correction, retained findings and relevant impact; dispatch the exact returned Task if not already active. No fresh Worker or unchanged validation is required."
            : "Correction ready; call review_mission for the SAME native author to explicitly self-recheck the retained findings, relevant impact and original requirements. Only a concrete reachable Major risk remaining after self-recheck requires a DIFFERENT Reviewer. Known Major/Medium defects still require correction. Do not restart unchanged checks or investigation; CORRECTION_READY alone is not acceptance."
      : mission.kind === "operation" && operationStatus === "running"
        ? "The declared operation is already running. Inspect its native shell/progress; do not start another Worker or run. Wait for a terminal result, or report the existing run as blocked if its completion cannot be observed."
      : run?.phase === "awaiting-decision" && mission.corrections?.some(item => item.runID === run.runID && item.status === "failed")
        ? "Correction validation or native execution failed. Call repair_review for a new admission in the SAME original Reviewer's native session; fix its own regression, rerun inherited checks and retain the commit/clean boundary and cumulative spend. Do not use ordinary retry, Rescue or a fresh Worker replan. Failure is never acceptance."
      : run?.phase === "awaiting-decision" ? (run.units.some(unit => unit.dispatchDenial)
        ? "Coordinator: inspect units[].dispatch_denial before changing the plan. Correct only its diagnosed cause; do not repeat an unchanged refused Task or replan for a host-state mismatch. Report an unresolved runtime mismatch with the loaded runtime identity; preserve requirements and cumulative spend."
        : run.units.some(unit => unit.status === "failed" && unit.resultClass === "acceptance" && unit.failure?.outcome === "fail" && !unit.normalRemediationUsed)
          ? "Coordinator: one exact declared validation failed. Reconcile the returned Worker and cumulative budget, then call retry_mission_unit once for that unit before replanning. This preserves the same scope and acceptance."
          : run.units.some(unit => unit.status === "failed" && unit.resultClass === "acceptance" && unit.failure?.outcome === "fail" && unit.normalRemediationUsed && !unit.terminalRescue)
            ? "Coordinator: the one ordinary remediation failed the declared validation again. If its native terminal, writer release, exact candidate and cumulative budget permit, call rescue_mission_unit once; inspect and report a non_rescue reason, then continue ordinary correction within budget. Rescue does not bypass validation, review or root acceptance."
            : "Coordinator: correct the cause and call plan_units with the remaining work and all requirements; budget is cumulative.")
      : run?.phase === "awaiting-acceptance" && !operationComplete
        ? `Requested operation is ${operationStatus}. Continue the actual operation or report its blocker; auxiliary checks and review disposition cannot complete it.`
      : run?.phase === "awaiting-acceptance" ? (reviewAccepted
          ? "Coordinator: review permits submission. Retain advisory review notes; do not repeat passed validation or review for evidence formatting. Operator performs final acceptance against the original requirements."
          : "Coordinator: correct known Major/Medium findings, then obtain explicit native author self-recheck (different Reviewer only for residual concrete Major risk), or initial independent review, then submit_mission. Operator compares all requirements with source/evidence before complete_mission.")
      : "Coordinator: continue the next useful unit within original requirements. Return only a completion candidate, user-only decision, or scope/budget extension." };
}

/** Models forward a short capability, never recopy the host's evidence hashes and source packet. */
export function missionReviewTask(mission: OperatorMission): OperatorTask {
  const review = mission.review;
  if (!review?.task) throw new Error("mission-review-task-unavailable");
  return { ...review.task, prompt: `${MISSION_REVIEW_REFERENCE}${JSON.stringify({ r: mission.root,
    m: mission.id, n: review.runID, h: digest(review.task.prompt) })}` };
}

/** Optional implementation notes supplement host-observed source/checks; prose is not a coverage gate. */
export function missionReviewTraces(_mission: OperatorMission, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every(item => typeof item === "string")) {
    throw new Error("mission-review-traces: optional notes must be strings");
  }
  return raw.map(text => text.trim()).filter(Boolean);
}
