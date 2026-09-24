import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, readdir, readlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { isWorkAction, newWorkProgress, type WorkActivity, type WorkProgress, type WorkEvidence } from "./work-progress.js";

const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const WORK_REFERENCE = "SORTIE_V011_WORK_REF ";
export const WORK_LIMITS = { attempts: 6, requests: 64, requestBytes: 128 * 1024, checks: 128, outputBytes: 16 * 1024 } as const;
export type WorkPhase = "ready" | "running" | "waiting" | "review" | "yielded" | "blocked" | "interrupted" | "completed" | "cancelled";
export interface WorkRequest {
  id: string; text: string; at?: number;
  files?: Array<{ uri: string; name?: string; description?: string }>;
  skills?: Array<{ id: string }>;
}
export interface SourceSnapshot { fingerprint: string; files: Record<string, string> }
export interface WorkCheck {
  id: string; command: string; exit: number | null; timedOut: boolean; interrupted: boolean;
  before: string; after: string; output: string; at: number;
  pending?: boolean;
}
export interface WorkCheckReplacement { check: string; replacement: string; reason: string }
export interface WorkCommand {
  id: string; callID: string; command: string; timeout: number; at: number;
  status: "launching" | "completed" | "interrupted"; exit: number | null; output: string;
  nativeID?: string; nativeFile?: string; nativeStatus?: string; retryOf?: string;
}
export interface WorkUsageReceipt {
  session: string; model: string; tokens: number | null; usd: number | null; tier?: string; requestedTier?: string; local?: boolean; pending?: boolean;
}
export interface WorkAuxiliaryUsage { id: string; root: string; at: number; kind: string; receipt: WorkUsageReceipt }
export interface WorkState {
  version: 1; id: string; root: string; phase: WorkPhase; requests: WorkRequest[];
  instructions: string; feedback: string[]; attempts: number; generation: number;
  callID: string | null; child: string | null; baseline: SourceSnapshot; checks: WorkCheck[];
  settledCallID?: string;
  startedAt: number; updatedAt: number; report: string; assessment: string | null;
  acceptedChecks: string[]; acceptedSource: string | null;
  deliveredRequests?: number;
  reviewView?: { source: string; intent: string; evidence?: string };
  sourceView?: { fingerprint: string; changed: string[]; at: number };
  checkReplacements?: WorkCheckReplacement[];
  progress?: WorkProgress;
  commands?: WorkCommand[];
  controller?: { path: string; stopCommand?: string; runID: string | null; status: string; input: string | null; snapshot?: Record<string, unknown>; notified?: boolean };
  presentation?: { id: string; report: string };
  directory?: string;
  usage?: { tokens: number | null; usd: number | null; models: Array<{ model: string; tokens: number }>;
    estimatedUsd?: number; unpricedRequests?: number; requests?: number; meteredAt?: number };
  userStopped?: boolean;
  usageReceipts?: Record<string, WorkUsageReceipt>;
  supportSessions?: Array<{ id: string; role: string }>;
  usageUntil?: number;
  attemptLimit?: number;
  attemptExtensions?: Array<{ at: number; attempts: number; limit: number; evidence: string[]; assessment: string }>;
}
export interface WorkStore {
  get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>;
  scan?(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }>;
}
interface RootState { requests: WorkRequest[]; work: WorkState | null; pendingProgress?: WorkProgress; operatorNudges?: number }
export const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Content identity, including new nonignored files. Git commits do not invalidate identical source. */
export async function workSource(directory: string): Promise<SourceSnapshot> {
  let paths: string[] = [];
  try {
    const result = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
    paths = [...new Set(result.stdout.split("\0").filter(Boolean))];
  } catch (error) {
    if (isRecord(error) && error.code !== 128 && error.code !== "ENOENT") throw error;
  }
  if (!paths.length) {
    const visit = async (prefix: string): Promise<void> => {
      for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
        if ([".git", ".opencode", "node_modules"].includes(entry.name) || entry.name.startsWith(".sortie-dogs")) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path); else paths.push(path);
        if (paths.length > 50_000) throw new Error("work-source-file-limit");
      }
    };
    await visit("");
  }
  if (paths.length > 50_000) throw new Error("work-source-file-limit");
  const files: Record<string, string> = Object.create(null);
  for (const path of paths.sort()) {
    const absolute = join(directory, path);
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) { files[path] = "deleted"; continue; }
    if (info.isSymbolicLink()) files[path] = `link:${hash(await readlink(absolute))}`;
    else if (info.isFile()) {
      const digest = createHash("sha256");
      for await (const bytes of createReadStream(absolute)) digest.update(bytes);
      files[path] = `${info.mode & 0o111}:${digest.digest("hex")}`;
    }
  }
  return { fingerprint: hash(JSON.stringify(files)), files };
}

export function workChanged(baseline: SourceSnapshot, current: SourceSnapshot): string[] {
  return [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])]
    .filter(path => baseline.files[path] !== current.files[path]).sort();
}

export function workCheckCurrent(work: WorkState, check: WorkCheck, source: string): boolean {
  return check.before === source && check.after === source &&
    work.checks.filter(item => item.command === check.command).at(-1)?.id === check.id;
}
const checkPassed = (work: WorkState, check: WorkCheck, source: string) =>
  check.exit === 0 && !check.interrupted && !check.timedOut && workCheckCurrent(work, check, source);

/** Formal checks remain obligations across source edits and restarts, not just selectable success receipts. */
export function workUnresolvedChecks(work: WorkState, source: string, replacements = work.checkReplacements ?? []): WorkCheck[] {
  const latest = new Map(work.checks.map(check => [check.command, check]));
  return [...latest.values()].filter(check => !checkPassed(work, check, source) && !replacements.some(item => {
    const replacement = work.checks.find(candidate => candidate.id === item.replacement);
    return item.check === check.id && replacement && checkPassed(work, replacement, source);
  }));
}

/** A real validation executor. It never derives exit status from model-authored text. */
export async function runWorkCheck(directory: string, command: string, timeout: number, signal?: AbortSignal): Promise<
  Pick<WorkCheck, "exit" | "timedOut" | "interrupted" | "output">> {
  if (!command.trim() || command.length > 8000) throw new Error("work-check-command-invalid");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(windows ? "powershell.exe" : "bash", windows
      ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command],
    { cwd: directory, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false, interrupted = false;
    let stopped: Promise<void> | undefined;
    const capture = (data: Buffer) => { output = (output + data.toString()).slice(-WORK_LIMITS.outputBytes); };
    const stop = () => {
      if (!child.pid || stopped) return;
      if (windows) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        stopped = new Promise<void>(done => {
          killer.on("error", () => { child.kill(); done(); });
          killer.on("close", () => done());
        });
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
        stopped = new Promise<void>(done => setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* stopped */ }
          done();
        }, 1000));
      }
    };
    const abort = () => { interrupted = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", async exit => { cleanup(); await stopped; resolve({ exit, timedOut, interrupted, output }); });
  });
}

/** One durable job, one native child, and the user's original words. No speculative execution plan. */
export class WorkLoop {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activeChecks = new Set<string>();
  constructor(readonly directory: string, private readonly store: WorkStore, readonly maxAttempts: number = WORK_LIMITS.attempts) {}
  private key(root: string) { return `work-loop/root/${hash(root)}`; }
  private async read(root: string): Promise<RootState> {
    const value = await this.store.get(this.key(root));
    if (value === undefined || value === null) return { requests: [], work: null };
    if (!isRecord(value) || !Array.isArray(value.requests) || (value.work !== null && (!isRecord(value.work) || value.work.version !== 1 || value.work.root !== root))) {
      throw new Error("work-state-invalid");
    }
    return structuredClone(value) as RootState;
  }
  private async update<T>(root: string, action: (state: RootState) => Promise<T>): Promise<T> {
    const previous = this.queues.get(root) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const state = await this.read(root);
      const result = await action(state);
      await this.store.set(this.key(root), state);
      return result;
    });
    this.queues.set(root, operation);
    try { return await operation; } finally { if (this.queues.get(root) === operation) this.queues.delete(root); }
  }
  async current(root: string): Promise<WorkState | null> { await this.queues.get(root)?.catch(() => undefined); return (await this.read(root)).work; }
  async progress(root: string): Promise<WorkProgress | null> {
    await this.queues.get(root)?.catch(() => undefined);
    const state = await this.read(root);
    return state.work && !["completed", "cancelled"].includes(state.work.phase) ? state.work.progress ?? null : state.pendingProgress ?? null;
  }
  async operatorNudge(root: string): Promise<number> {
    return this.update(root, async state => {
      const progress = state.work && !["completed", "cancelled"].includes(state.work.phase) ? state.work.progress : state.pendingProgress;
      if (progress) progress.operatorNudgedAt = Date.now();
      return state.operatorNudges = (state.operatorNudges ?? 0) + 1;
    });
  }
  async usage(root: string, workID: string, usage: NonNullable<WorkState["usage"]>): Promise<void> {
    await this.updateUsageWork(root, workID, work => { work.usage = usage; });
  }
  async support(root: string, id: string, role: string): Promise<void> {
    await this.update(root, async state => {
      if (!state.work || ["completed", "cancelled"].includes(state.work.phase)) return;
      const sessions = state.work.supportSessions ??= [];
      if (!sessions.some(session => session.id === id)) sessions.push({ id, role });
    });
  }
  async meter(root: string, workID: string, receipts: Record<string, WorkUsageReceipt>): Promise<void> {
    await this.updateUsageWork(root, workID, work => {
      const ledger = work.usageReceipts ??= {};
      for (const [id, receipt] of Object.entries(receipts)) if (!ledger[id] || ledger[id].pending && !receipt.pending) ledger[id] = receipt;
    });
  }
  private async updateUsageWork(root: string, id: string, action: (work: WorkState) => void) {
    await this.update(root, async state => {
      const archive = state.work?.id !== id;
      const work = archive ? await this.store.get(`work-loop/archive/${id}`) : state.work;
      if (!isRecord(work) || work.id !== id || work.root !== root) throw new Error("work-usage-owner-changed");
      action(work as WorkState);
      if (archive) await this.store.set(`work-loop/archive/${id}`, work);
    });
  }
  async auxiliaryUsage(value: WorkAuxiliaryUsage): Promise<void> {
    const key = `work-loop/usage/${hash(value.root)}/${value.id}`;
    await this.update(value.root, async () => {
      const prior = await this.store.get(key);
      if (isRecord(prior) && prior.receipt?.pending !== true) return;
      await this.store.set(key, value);
    });
  }
  async auxiliaryReceipts(root: string, since: number, until = Infinity): Promise<WorkAuxiliaryUsage[]> {
    if (!this.store.scan) return [];
    const result: WorkAuxiliaryUsage[] = []; let after: string | undefined;
    do {
      const page = await this.store.scan({ prefix: `work-loop/usage/${hash(root)}/`, limit: 100, ...(after ? { after } : {}) });
      for (const { value } of page.entries) if (isRecord(value) && value.root === root && value.at >= since && value.at < until) result.push(value as WorkAuxiliaryUsage);
      after = page.next;
    } while (after);
    return result;
  }
  async presentation(root: string, id: string, report: string): Promise<{ id: string; report: string }> {
    return this.update(root, async state => {
      if (!state.work) throw new Error("work-missing");
      if (state.work.presentation?.id === id) return state.work.presentation;
      return state.work.presentation = { id, report };
    });
  }
  async controller(root: string, path: string, snapshot?: Record<string, unknown>): Promise<void> {
    await this.update(root, async state => {
      const work = state.work;
      if (!work || ["completed", "cancelled"].includes(work.phase)) return;
      if (work.controller && work.controller.path !== path) throw new Error("work-controller-already-bound");
      const controller = work.controller ??= { path, runID: null, status: "starting", input: null };
      if (!snapshot) {
        const launch = work.commands?.at(-1);
        if (launch?.nativeStatus === "rejected" || launch?.status === "completed" && launch.exit !== null && launch.exit !== 0) {
          controller.status = "launch-failed";
          if (work.phase === "waiting") work.phase = "ready";
        } else if (!["completed", "failed"].includes(controller.status)) work.phase = "waiting";
        return;
      }
      if (typeof snapshot.run_id !== "string" || !["running", "completed", "failed"].includes(String(snapshot.status)) || !Array.isArray(snapshot.instances)) throw new Error("work-controller-invalid");
      if (controller.runID !== null && (controller.runID !== snapshot.run_id || controller.input !== snapshot.input_sha256)) throw new Error("work-controller-identity-changed");
      controller.runID = snapshot.run_id; controller.input = typeof snapshot.input_sha256 === "string" ? snapshot.input_sha256 : null;
      controller.status = String(snapshot.status); controller.snapshot = snapshot;
      if (["completed", "failed"].includes(controller.status)) {
        this.evidence(work, { id: `controller:${controller.runID}:${controller.status}`, kind: "command", at: Date.now(), detail: `Controller ${controller.runID}: ${controller.status}` });
        if (work.phase === "waiting") { work.phase = "review"; delete work.reviewView; work.updatedAt = Date.now(); }
      }
    });
  }
  async controllerNotified(root: string): Promise<void> {
    await this.update(root, async state => { if (state.work?.controller) state.work.controller.notified = true; });
  }
  async bindController(root: string, path: string, stopCommand: string): Promise<void> {
    await this.update(root, async state => {
      const work = state.work;
      if (!work || !["ready", "waiting", "review"].includes(work.phase)) throw new Error("work-controller-not-ready");
      if (work.controller && (work.controller.path !== path || work.controller.stopCommand !== stopCommand)) throw new Error("work-controller-already-bound");
      work.controller ??= { path, stopCommand, runID: null, status: "starting", input: null };
    });
  }
  async retained(): Promise<WorkState[]> {
    if (!this.store.scan) return [];
    const works = new Map<string, WorkState>(); let after: string | undefined;
    do {
      const page = await this.store.scan({ prefix: "work-loop/", limit: 100, ...(after ? { after } : {}) });
      for (const { value } of page.entries) {
        const work = isRecord(value) ? (isRecord(value.work) ? value.work : value) : undefined;
        if (work?.version === 1 && work.directory === this.directory && typeof work.id === "string" && Array.isArray(work.requests)) works.set(work.id, work as WorkState);
      }
      after = page.next;
    } while (after && works.size < 1000);
    return [...works.values()].filter(work => work.directory === this.directory);
  }
  private evidence(work: WorkState, value: Omit<WorkEvidence, "tools">) {
    const progress = work.progress ??= newWorkProgress(work.startedAt);
    const evidence = progress.evidence ??= [];
    if (evidence.some(item => item.id === value.id)) return;
    evidence.push({ ...value, tools: progress.tools });
    if (evidence.length > 256) evidence.shift();
  }
  async inspect(root: string, actor: string): Promise<{ work: WorkState | null; source: SourceSnapshot }> {
    return this.update(root, async state => {
      const source = await workSource(this.directory);
      // The returned artifacts describe the accepted source, not later workspace edits.
      // The caller still receives the live source to report accepted_source_current.
      if (state.work && state.work.phase !== "completed") state.work.sourceView = { fingerprint: source.fingerprint, changed: workChanged(state.work.baseline, source), at: Date.now() };
      if (state.work && state.work.phase !== "completed" && workChanged(state.work.baseline, source).length) this.evidence(state.work,
        { id: `diff:${source.fingerprint}`, kind: "diff", at: Date.now(), detail: workChanged(state.work.baseline, source).join(", ") });
      if (actor === root && state.work && (["review", "ready"].includes(state.work.phase) || state.work.phase === "yielded" && state.work.settledCallID === state.work.callID)) {
        state.work.reviewView = { source: source.fingerprint, intent: hash(JSON.stringify(state.work.requests)),
          evidence: hash(JSON.stringify(state.work.checks)) };
      }
      return { work: state.work, source };
    });
  }
  async observe(root: string, request: WorkRequest): Promise<void> {
    if (!request.id || (!request.text.trim() && !request.files?.length && !request.skills?.length) ||
        Buffer.byteLength(request.text) > WORK_LIMITS.requestBytes || Buffer.byteLength(JSON.stringify(request)) > 16 * 1024 * 1024) throw new Error("work-request-invalid");
    await this.update(root, async state => {
      const work = state.work;
      if (work && !["completed", "cancelled"].includes(work.phase)) {
        if (work.requests.some(item => item.id === request.id)) return;
        if (work.requests.length >= WORK_LIMITS.requests) throw new Error("work-request-limit");
        work.requests.push(request); work.updatedAt = Date.now();
      } else if (!state.requests.some(item => item.id === request.id) && !work?.requests.some(item => item.id === request.id)) {
        if (state.requests.length >= WORK_LIMITS.requests) throw new Error("work-request-limit");
        state.requests.push(request);
        if (work && work.usageUntil === undefined) work.usageUntil = request.at ?? Date.now();
        state.pendingProgress ??= newWorkProgress(request.at ?? Date.now());
        state.operatorNudges = 0;
      }
    });
  }
  async start(root: string, instructions: string, evidence: string[] = [], graceMs = 60000): Promise<WorkState> {
    if (instructions.length > 8000) throw new Error("work-instructions-too-large");
    return this.update(root, async state => {
      if (state.work && !["completed", "cancelled"].includes(state.work.phase)) {
        if (evidence.length) {
          const progress = state.work.progress ??= newWorkProgress(state.work.startedAt);
          const selected = evidence.map(id => progress.evidence?.find(item => item.id === id));
          if (!instructions.trim() || selected.some(item => !item || item.at <= (progress.reviewedAt ?? progress.startedAt))) throw new Error("work-progress-evidence-missing-or-old");
          const fresh = selected as WorkEvidence[];
          progress.reviewedAt = Math.max(...fresh.map(item => item.at));
          progress.reviewedTools = Math.max(...fresh.map(item => item.tools));
          for (const intervention of progress.interventions ?? []) if (!intervention.resolvedAt) {
            intervention.resolvedAt = Date.now(); intervention.evidence = evidence;
          }
          delete progress.stopped;
        }
        if (["yielded", "interrupted", "blocked"].includes(state.work.phase)) {
          if (state.work.progress?.stopped && !instructions.trim()) throw new Error("work-progress-blocked: provide a concrete next executable step before resuming; do not repeat the same exploratory dispatch");
          this.continuationBudget(state.work, evidence, instructions);
          state.work.phase = "ready"; state.work.generation++; state.work.callID = null;
          delete state.work.userStopped;
          if (instructions.trim()) state.work.feedback.push(instructions);
          const progress = state.work.progress;
          if (progress) {
            progress.nextInterventionAt = Date.now() + graceMs;
            const pending = progress.interventions?.find(item => !item.resolvedAt);
            if (pending) pending.resumedAt = Date.now();
          }
        }
        return state.work;
      }
      if (!state.requests.length) throw new Error("work-user-request-missing");
      if (state.work) await this.store.set(`work-loop/archive/${state.work.id}`, state.work);
      const now = Date.now();
      state.work = { version: 1, id: randomUUID(), root, phase: "ready", requests: state.requests.splice(0), instructions,
        feedback: [], attempts: 0, generation: 1, callID: null, child: null, baseline: await workSource(this.directory),
        checks: [], startedAt: now, updatedAt: now, report: "", assessment: null, acceptedChecks: [], acceptedSource: null };
      state.work.startedAt = state.work.requests[0]?.at ?? now;
      state.work.directory = this.directory;
      state.work.progress = state.pendingProgress ?? newWorkProgress(state.work.startedAt);
      delete state.pendingProgress;
      return state.work;
    });
  }
  task(work: WorkState) {
    return { agent: "dogs-coordinator", description: "Execute the user's task", prompt: `${WORK_REFERENCE}${work.id}/${work.generation}`,
      ...(work.child ? { sessionID: work.child } : {}) };
  }
  attemptLimit(work: WorkState): number { return work.attemptLimit ?? this.maxAttempts; }
  private continuationBudget(work: WorkState, evidence: string[], assessment: string) {
    if (work.attempts < this.attemptLimit(work)) return;
    const last = work.attemptExtensions?.at(-1)?.at ?? work.startedAt;
    const fresh = evidence.filter(id => work.progress?.evidence?.some(item => item.id === id && item.at > last));
    if (!fresh.length || !assessment.trim()) throw new Error("work-attempt-budget-exhausted: inspect fresh relevant results and resume this same child with progress_evidence; routine continuation is internal, not a user decision");
    // Bound consecutive unproductive dispatches, not the total size of the user's task.
    // Every extension is grounded in an operator-inspected result; lifetime attempts never reset.
    const limit = work.attempts + this.maxAttempts;
    (work.attemptExtensions ??= []).push({ at: Date.now(), attempts: work.attempts, limit, evidence: fresh, assessment });
    work.attemptLimit = limit;
  }
  async admit(root: string, callID: string, input: Record<string, unknown>): Promise<void> {
    await this.update(root, async state => {
      const work = state.work;
      if (!work || input.agent !== "dogs-coordinator" || input.prompt !== this.task(work).prompt ||
          (input.sessionID ?? null) !== work.child || input.background === true || input.model !== undefined) throw new Error("work-dispatch-mismatch");
      if (work.phase === "running" && work.callID === callID) return;
      if (work.phase !== "ready") throw new Error("work-dispatch-not-ready");
      if (work.attempts >= this.attemptLimit(work)) throw new Error("work-attempt-budget-exhausted");
      work.phase = "running"; work.callID = callID; work.attempts++; work.updatedAt = Date.now();
      delete work.settledCallID;
      work.progress ??= newWorkProgress(work.startedAt);
      // Only the old execution's active observations expire; cumulative clocks/evidence never do.
      work.progress.active = [];
    });
  }
  async claim(root: string, child: string, prompt: string): Promise<string> {
    return this.update(root, async state => {
      const work = state.work;
      if (!work || work.phase !== "running" || prompt !== this.task(work).prompt || (work.child && work.child !== child)) throw new Error("work-child-not-admitted");
      work.child = child;
      work.deliveredRequests = work.requests.length;
      return ["Execute this complete user request. The operator owns final acceptance; you own investigation, implementation, testing and routine corrections.",
        `Work ID: ${work.id}. Lifetime dispatch ${work.attempts}, current allowance ${this.attemptLimit(work)}. Workspace: ${this.directory}`,
        "## Original user instructions (all remain authoritative)", ...work.requests.map(item => item.text),
        "## Operator notes", work.instructions, ...work.feedback,
        "Use native read/glob/grep/patch/shell tools freely within the user's instructions and project AGENTS.md. Discover dependencies and affected files as you work.",
        "Act early: reuse supplied paths and existing documented commands. Investigate only the next unknown that prevents a target reproduction, then act on the result. Do not recreate a controller or repeat known preflight. Keep going until the whole task is finished in this invocation; the host never cuts you off for pacing, it only adds a short note if you stop editing or executing. Running commands retain native deadlines; activity does not prove completion.",
        ...(work.commands?.length ? ["## Already executed by the host — reuse these results, never blindly relaunch", JSON.stringify(work.commands)] : []),
        "Run final meaningful checks with sortie_v011_check. Each remains an obligation until it passes on final source; use shell for exploration. Fix ordinary setup and test failures in this invocation. Verify the actual affected behavior and adjacent valid/invalid cases, not just syntax or one literal reproducer.",
        "Return a concise account of changes, check IDs, requirements covered and anything genuinely unresolved. Never accept your own work or ask the user to fix a protocol field."].join("\n\n");
    });
  }
  async assertWorker(root: string, child: string): Promise<WorkState> {
    const work = await this.current(root);
    if (!work || work.phase !== "running" || work.child !== child) throw new Error("work-worker-inactive");
    return work;
  }
  async activity(root: string, child: string, activity: WorkActivity, result?: { status: string; exit: number | null }): Promise<void> {
    await this.update(root, async state => {
      const work = state.work;
      if (!work || ["completed", "cancelled"].includes(work.phase)) {
        if (child === root && state.pendingProgress && !result) state.pendingProgress.tools++;
        return;
      }
      if (!["ready", "running", "review"].includes(work.phase) || (child !== root && work.child !== child)) return;
      const progress = work.progress ??= newWorkProgress();
      if (result) {
        const active = progress.active.find(item => item.id === activity.id);
        if (!active) return;
        progress.active = progress.active.filter(item => item.id !== activity.id);
        progress.last = { ...active, ...result };
        // Activity is visible liveness, not reviewed progress or accepted work.
        // Keep the original request and review clocks unchanged.
        progress.lastActionAt = Date.now();
        // A finished edit or executed command restarts the nudge window. This is
        // pacing only; it still certifies neither progress nor completion.
        if (isWorkAction(active.tool)) { progress.reviewedAt = progress.lastWorkActionAt = Date.now(); progress.reviewedTools = progress.tools; }
        if (result.status === "completed" && activity.tool === "patch") progress.edits++;
        if (result.status === "completed" && result.exit !== null && activity.tool === "shell") this.evidence(work,
          { id: active.id, kind: "command", at: Date.now(), detail: `${active.detail} (exit ${result.exit})` });
      } else if (!progress.active.some(item => item.id === activity.id)) {
        if (progress.active.length >= 128) throw new Error("work-active-tool-limit");
        progress.active.push({ ...activity, actor: child }); progress.tools++;
        if (isWorkAction(activity.tool)) {
          progress.firstActionAt ??= Date.now();
          if (activity.tool !== "patch") progress.commands++;
        } else progress.inspections++;
      }
    });
  }
  /** Record a non-interrupting pacing nudge for the running child. The phase, child and conversation are unchanged. */
  async nudge(root: string, callID: string, reason: string, limit: number): Promise<boolean> {
    return this.update(root, async state => {
      const work = state.work;
      if (!work || work.phase !== "running" || work.callID !== callID) return false;
      const progress = work.progress ??= newWorkProgress(work.startedAt);
      const nudges = progress.nudges ??= [];
      if (nudges.filter(item => item.at > (progress.lastWorkActionAt ?? 0)).length >= limit) return false;
      nudges.push({ at: Date.now(), reason });
      if (nudges.length > 64) nudges.shift();
      progress.reviewedAt = Date.now(); progress.reviewedTools = progress.tools;
      return true;
    });
  }
  /** Legacy v0.11.0-v0.11.3 hard yield. Retained for persisted states; the v0.11.4 plugin no longer calls it. */
  async stall(root: string, callID: string, reason: string): Promise<boolean> {
    return this.update(root, async state => {
      const work = state.work;
      if (!work || work.phase !== "running" || work.callID !== callID) return false;
      const progress = work.progress ??= newWorkProgress();
      progress.stopped = { at: Date.now(), reason };
      const interventions = progress.interventions ??= [];
      if (!interventions.some(item => !item.resolvedAt)) interventions.push({ id: randomUUID(), at: Date.now(), reason });
      work.phase = "yielded"; work.assessment = reason; work.updatedAt = Date.now();
      work.feedback.push(`Host requests an internal course correction: ${reason}. Give the same child a concrete next action and reuse existing processes/results. Resolve this intervention only by inspecting fresh relevant evidence; never ask the user to hurry routine work.`);
      return true;
    });
  }
  async beginCommand(root: string, callID: string, command: string, timeout: number, retryOf?: string): Promise<{ command: WorkCommand; launch: boolean }> {
    if (!command.trim() || command.length > 8000 || !Number.isInteger(timeout) || timeout < 100 || timeout > 1200000) throw new Error("work-command-invalid");
    return this.update(root, async state => {
      const work = state.work;
      if (!work) throw new Error("work-command-not-ready");
      const commands = work.commands ??= [];
      const replay = commands.find(item => item.command === command && item.retryOf === retryOf && item.callID === callID);
      if (replay) return { command: replay, launch: false };
      const existing = commands.filter(item => item.command === command).at(-1);
      if (retryOf) {
        const retry = commands.find(item => item.retryOf === retryOf);
        if (retry) {
          if (retry.command !== command) throw new Error("work-command-retry-mismatch");
          return { command: retry, launch: false };
        }
        const previous = commands.find(item => item.id === retryOf);
        if (!previous || !(previous.status === "completed" && previous.exit !== null || ["killed", "timeout", "rejected"].includes(previous.nativeStatus ?? ""))) throw new Error("work-command-retry-unverified: reconcile the previous native process before retrying");
        if (work.controller && work.controller.runID && !["completed", "failed"].includes(work.controller.status)) throw new Error("work-controller-still-running");
      } else if (existing) return { command: existing, launch: false };
      if (!["ready", "review"].includes(work.phase)) throw new Error("work-command-not-ready");
      if (commands.length >= 128) throw new Error("work-command-limit");
      const entry: WorkCommand = { id: randomUUID(), callID, command, timeout, at: Date.now(), status: "launching", exit: null, output: "", ...(retryOf ? { retryOf } : {}) };
      commands.push(entry); delete work.reviewView;
      return { command: entry, launch: true };
    });
  }
  async nativeCommand(root: string, id: string, nativeID: string, result?: { status: string; exit: number | null; output: string; file?: string }): Promise<void> {
    await this.update(root, async state => {
      const entry = state.work?.commands?.find(item => item.id === id);
      if (!entry || !nativeID.startsWith("sh_") || entry.nativeID && entry.nativeID !== nativeID) throw new Error("work-command-native-identity-mismatch");
      entry.nativeID = nativeID;
      if (result) {
        if (result.file) entry.nativeFile = result.file;
        entry.nativeStatus = result.status;
        if (["exited", "killed", "timeout"].includes(result.status)) {
          entry.status = result.status === "exited" ? "completed" : "interrupted";
          entry.exit = result.exit; entry.output = result.output.slice(-WORK_LIMITS.outputBytes);
        }
      }
    });
  }
  async endCommand(root: string, id: string, result: { exit: number | null; interrupted: boolean; output: string; rejected?: boolean }): Promise<void> {
    await this.update(root, async state => {
      const work = state.work, command = work?.commands?.find(item => item.id === id);
      if (!work || !command || command.status !== "launching") return;
      Object.assign(command, result, { status: result.interrupted ? "interrupted" : "completed", output: result.output.slice(-WORK_LIMITS.outputBytes) });
      if (result.rejected && !command.nativeID) command.nativeStatus = "rejected";
      if (result.exit !== null) this.evidence(work, { id, kind: "command", at: Date.now(), detail: `${command.command} (exit ${result.exit})` });
      work.updatedAt = Date.now();
    });
  }
  async check(root: string, actor: string, command: string, timeout: number, signal?: AbortSignal,
    execute: typeof runWorkCheck = runWorkCheck): Promise<WorkCheck> {
    if (this.activeChecks.has(root)) throw new Error("work-validation-already-running");
    this.activeChecks.add(root);
    try {
    const work = await this.current(root);
    // A settled pacing return hands control back to the operator. Required
    // verification must remain a durable check, not force a ceremonial redispatch
    // or an untracked shell fallback. An outstanding child or user stop still wins.
    const yieldedToOperator = work?.phase === "yielded" && actor === root && !work.userStopped &&
      !!work.settledCallID && (!work.callID || work.callID === work.settledCallID);
    if (!work || !yieldedToOperator && !["running", "review", ...(actor === root ? ["ready"] : [])].includes(work.phase) ||
        (actor !== root && actor !== work.child)) throw new Error("work-check-not-owned");
    if (work.checks.length >= WORK_LIMITS.checks) throw new Error("work-check-limit");
    const before = await workSource(this.directory);
    // Admission is durable before native execution. A killed/restarted host cannot erase this obligation.
    const check: WorkCheck = { id: randomUUID(), command, exit: null, timedOut: false, interrupted: false,
      before: before.fingerprint, after: before.fingerprint, output: "Validation started; no terminal native result recorded.", at: Date.now(), pending: true };
    await this.update(root, async state => {
      if (state.work?.id !== work.id || state.work.generation !== work.generation) throw new Error("work-check-interrupted");
      state.work.checks.push(check); delete state.work.reviewView;
      state.work.sourceView = { fingerprint: before.fingerprint, changed: workChanged(state.work.baseline, before), at: Date.now() };
    });
    // Permission denials, missing executors and launch errors are failed verification evidence too.
    // Keep a null exit: no process ran successfully, and no invented exit code can support acceptance.
    const result = await execute(this.directory, command, timeout, signal).catch((error: unknown) => ({
      exit: null, timedOut: false, interrupted: signal?.aborted === true,
      output: `Verification could not execute: ${error instanceof Error ? error.message : String(error)}`.slice(-WORK_LIMITS.outputBytes),
    }));
    const after = await workSource(this.directory).catch(() => null);
    await this.update(root, async state => {
      if (state.work?.id !== work.id) throw new Error("work-check-interrupted");
      const stored = state.work.checks.find(item => item.id === check.id)!;
      Object.assign(stored, result, { pending: false, after: after?.fingerprint ?? "unavailable", at: Date.now(),
        interrupted: result.interrupted || stored.interrupted || !after || state.work.generation !== work.generation });
      Object.assign(check, stored); state.work.updatedAt = Date.now();
      if (after) state.work.sourceView = { fingerprint: after.fingerprint, changed: workChanged(state.work.baseline, after), at: Date.now() };
      if (check.exit !== null && !check.interrupted) this.evidence(state.work, { id: check.id, kind: "check", at: check.at, detail: `${command} (exit ${check.exit})` });
    });
    return check;
    } finally { this.activeChecks.delete(root); }
  }
  async settled(root: string, callID: string, succeeded: boolean, report: string): Promise<void> {
    await this.update(root, async state => {
      const work = state.work;
      if (!work || work.callID !== callID || !["running", "yielded"].includes(work.phase)) return;
      work.settledCallID = callID;
      if (!succeeded) for (const check of work.checks) if (check.pending) { check.interrupted = true; check.pending = false; }
      if (work.phase === "yielded") {
        if (work.progress) work.progress.active = [];
        work.report = report.slice(-WORK_LIMITS.outputBytes);
        return;
      }
      work.phase = succeeded && work.child ? "review" : "interrupted";
      delete work.reviewView;
      if (work.progress) work.progress.active = [];
      work.report = report.slice(-WORK_LIMITS.outputBytes); work.updatedAt = Date.now();
    });
  }
  async interrupt(root: string, cancelled = false): Promise<void> {
    await this.update(root, async state => {
      if (state.work && !["completed", "cancelled"].includes(state.work.phase)) {
        state.work.phase = cancelled ? "cancelled" : "interrupted"; state.work.updatedAt = Date.now();
        state.work.userStopped = true;
        if (state.work.progress) state.work.progress.active = [];
        for (const check of state.work.checks) if (check.pending) { check.interrupted = true; check.pending = false; }
      }
    });
  }
  async review(root: string, decision: "accept" | "revise" | "blocked", assessment: string, checks: string[],
    replacements: WorkCheckReplacement[] = [], graceMs = 60000): Promise<WorkState> {
    if (!assessment.trim() || assessment.length > 8000) throw new Error("work-review-assessment-required");
    return this.update(root, async state => {
      const work = state.work;
      if (!work || !(work.phase === "review" || (work.phase === "ready" && !work.child && work.commands?.length) ||
          (["ready", "yielded"].includes(work.phase) && work.settledCallID && (!work.callID || work.callID === work.settledCallID)))) throw new Error("work-not-ready-for-review");
      if (this.activeChecks.has(root)) throw new Error("work-validation-still-running");
      if (decision === "revise") {
        const current = await workSource(this.directory);
        const inspected = work.reviewView?.source === current.fingerprint && work.reviewView.intent === hash(JSON.stringify(work.requests));
        const evidence = inspected ? (work.progress?.evidence ?? []).filter(item =>
          item.id === `diff:${current.fingerprint}` || work.checks.some(check => check.id === item.id && check.after === current.fingerprint)) : [];
        this.continuationBudget(work, evidence.map(item => item.id), assessment);
        const progress = work.progress;
        if (progress) {
          const fresh = evidence.filter(item => item.at > (progress.reviewedAt ?? work.startedAt));
          if (fresh.length) {
            progress.reviewedAt = Math.max(...fresh.map(item => item.at)); progress.reviewedTools = Math.max(...fresh.map(item => item.tools));
            for (const intervention of progress.interventions ?? []) if (!intervention.resolvedAt) {
              intervention.resolvedAt = Date.now(); intervention.evidence = fresh.map(item => item.id);
            }
            delete progress.stopped;
          }
          progress.nextInterventionAt = Date.now() + graceMs;
        }
        work.feedback.push(assessment); work.phase = "ready"; work.generation++; work.callID = null;
      } else if (decision === "blocked") {
        work.phase = "blocked"; work.assessment = assessment;
        work.feedback.push(`Unresolved blocker: ${assessment}`);
      } else {
        if (work.controller && !["completed", "failed"].includes(work.controller.status)) throw new Error("work-controller-still-running");
        const commands = work.commands?.filter(item => !work.commands!.some(retry => retry.retryOf === item.id) && (item.status !== "completed" || item.exit === null));
        if (commands?.length) throw new Error(`work-command-unverified: ${commands.map(item => `${item.id} (${item.nativeStatus ?? item.status})`).join(", ")}. Inspect execution_results. For a confirmed-terminal rejection/interruption, execute the permitted corrected command with start_work(command=..., retry_command=<execution ID>) and verify its result. For an ambiguous/live launch, reconcile that same native process first. Check replacements alone do not resolve native command obligations.`);
        const source = await workSource(this.directory);
        if (work.reviewView?.source !== source.fingerprint || work.reviewView.intent !== hash(JSON.stringify(work.requests)) ||
            work.reviewView.evidence !== hash(JSON.stringify(work.checks))) {
          throw new Error("work-review-view-stale: read work_status and inspect the current changes and check results before accepting");
        }
        if (workChanged(work.baseline, source).length && !checks.length) throw new Error("work-current-validation-required");
        for (const id of checks) {
          const check = work.checks.find(item => item.id === id);
          if (!check || !checkPassed(work, check, source.fingerprint)) throw new Error("work-validation-missing-failed-or-stale");
        }
        const pending = workUnresolvedChecks(work, source.fingerprint, []);
        const replaced = new Set<string>();
        for (const item of replacements) {
          if (!pending.some(check => check.id === item.check) || replaced.has(item.check) ||
              !checks.includes(item.replacement) || work.checks.findIndex(check => check.id === item.replacement) <= work.checks.findIndex(check => check.id === item.check) ||
              !item.reason?.trim() || item.reason.length > 2000) throw new Error("work-check-replacement-invalid");
          replaced.add(item.check);
        }
        const unresolved = workUnresolvedChecks(work, source.fingerprint, replacements);
        if (unresolved.length) throw new Error(`work-validation-unresolved-checks: ${unresolved.map(check => check.id).join(", ")}. Rerun these checks successfully, justify an equivalent passing replacement, or report blocked; unrelated successes do not resolve them.`);
        work.checkReplacements = structuredClone(replacements);
        work.sourceView = { fingerprint: source.fingerprint, changed: workChanged(work.baseline, source), at: Date.now() };
        work.phase = "completed"; work.assessment = assessment; work.acceptedChecks = checks; work.acceptedSource = source.fingerprint;
        if (work.progress) {
          for (const intervention of work.progress.interventions ?? []) if (!intervention.resolvedAt) {
            intervention.resolvedAt = Date.now(); intervention.evidence = [...checks, `diff:${source.fingerprint}`];
          }
          delete work.progress.stopped;
        }
      }
      work.updatedAt = Date.now();
      return work;
    });
  }
}
