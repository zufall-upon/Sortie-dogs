import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, readdir, readlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const WORK_REFERENCE = "SORTIE_V011_WORK_REF ";
export const WORK_LIMITS = { attempts: 6, requests: 64, requestBytes: 128 * 1024, checks: 128, outputBytes: 16 * 1024 } as const;
export type WorkPhase = "ready" | "running" | "review" | "blocked" | "interrupted" | "completed" | "cancelled";
export interface WorkRequest {
  id: string; text: string; at?: number;
  files?: Array<{ uri: string; name?: string; description?: string }>;
  skills?: Array<{ id: string }>;
}
export interface SourceSnapshot { fingerprint: string; files: Record<string, string> }
export interface WorkCheck {
  id: string; command: string; exit: number | null; timedOut: boolean; interrupted: boolean;
  before: string; after: string; output: string; at: number;
}
export interface WorkCheckReplacement { check: string; replacement: string; reason: string }
export interface WorkState {
  version: 1; id: string; root: string; phase: WorkPhase; requests: WorkRequest[];
  instructions: string; feedback: string[]; attempts: number; generation: number;
  callID: string | null; child: string | null; baseline: SourceSnapshot; checks: WorkCheck[];
  startedAt: number; updatedAt: number; report: string; assessment: string | null;
  acceptedChecks: string[]; acceptedSource: string | null;
  deliveredRequests?: number;
  reviewView?: { source: string; intent: string; evidence?: string };
  checkReplacements?: WorkCheckReplacement[];
}
export interface WorkStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
interface RootState { requests: WorkRequest[]; work: WorkState | null }
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
  async inspect(root: string, actor: string): Promise<{ work: WorkState | null; source: SourceSnapshot }> {
    return this.update(root, async state => {
      const source = await workSource(this.directory);
      if (actor === root && state.work?.phase === "review") {
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
      }
    });
  }
  async start(root: string, instructions: string): Promise<WorkState> {
    if (instructions.length > 8000) throw new Error("work-instructions-too-large");
    return this.update(root, async state => {
      if (state.work && !["completed", "cancelled"].includes(state.work.phase)) {
        if (["interrupted", "blocked"].includes(state.work.phase)) {
          if (state.work.attempts >= this.maxAttempts) throw new Error("work-attempt-budget-exhausted");
          state.work.phase = "ready"; state.work.generation++; state.work.callID = null;
          if (instructions.trim()) state.work.feedback.push(instructions);
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
      return state.work;
    });
  }
  task(work: WorkState) {
    return { agent: "dogs-coordinator", description: "Execute the user's task", prompt: `${WORK_REFERENCE}${work.id}/${work.generation}`,
      ...(work.child ? { sessionID: work.child } : {}) };
  }
  async admit(root: string, callID: string, input: Record<string, unknown>): Promise<void> {
    await this.update(root, async state => {
      const work = state.work;
      if (!work || input.agent !== "dogs-coordinator" || input.prompt !== this.task(work).prompt ||
          (input.sessionID ?? null) !== work.child || input.background === true || input.model !== undefined) throw new Error("work-dispatch-mismatch");
      if (work.phase === "running" && work.callID === callID) return;
      if (work.phase !== "ready") throw new Error("work-dispatch-not-ready");
      if (work.attempts >= this.maxAttempts) throw new Error("work-attempt-budget-exhausted");
      work.phase = "running"; work.callID = callID; work.attempts++; work.updatedAt = Date.now();
    });
  }
  async claim(root: string, child: string, prompt: string): Promise<string> {
    return this.update(root, async state => {
      const work = state.work;
      if (!work || work.phase !== "running" || prompt !== this.task(work).prompt || (work.child && work.child !== child)) throw new Error("work-child-not-admitted");
      work.child = child;
      work.deliveredRequests = work.requests.length;
      return ["Execute this complete user request. The operator owns final acceptance; you own investigation, implementation, testing and routine corrections.",
        `Work ID: ${work.id}. Attempt ${work.attempts}/${this.maxAttempts}. Workspace: ${this.directory}`,
        "## Original user instructions (all remain authoritative)", ...work.requests.map(item => item.text),
        "## Operator notes", work.instructions, ...work.feedback,
        "Use native read/glob/grep/patch/shell tools freely within the user's instructions and project AGENTS.md. Discover dependencies and affected files as you work.",
        "Run final meaningful checks with sortie_v011_check. Each remains an obligation until it passes on final source; use shell for exploration. Fix ordinary setup and test failures in this invocation. Verify the actual affected behavior and adjacent valid/invalid cases, not just syntax or one literal reproducer.",
        "Return a concise account of changes, check IDs, requirements covered and anything genuinely unresolved. Never accept your own work or ask the user to fix a protocol field."].join("\n\n");
    });
  }
  async assertWorker(root: string, child: string): Promise<WorkState> {
    const work = await this.current(root);
    if (!work || work.phase !== "running" || work.child !== child) throw new Error("work-worker-inactive");
    return work;
  }
  async check(root: string, actor: string, command: string, timeout: number, signal?: AbortSignal,
    execute: typeof runWorkCheck = runWorkCheck): Promise<WorkCheck> {
    if (this.activeChecks.has(root)) throw new Error("work-validation-already-running");
    this.activeChecks.add(root);
    try {
    const work = await this.current(root);
    if (!work || !["running", "review", ...(actor === root ? ["ready"] : [])].includes(work.phase) || (actor !== root && actor !== work.child)) throw new Error("work-check-not-owned");
    if (work.checks.length >= WORK_LIMITS.checks) throw new Error("work-check-limit");
    const before = await workSource(this.directory);
    // Permission denials, missing executors and launch errors are failed verification evidence too.
    // Keep a null exit: no process ran successfully, and no invented exit code can support acceptance.
    const result = await execute(this.directory, command, timeout, signal).catch((error: unknown) => ({
      exit: null, timedOut: false, interrupted: signal?.aborted === true,
      output: `Verification could not execute: ${error instanceof Error ? error.message : String(error)}`.slice(-WORK_LIMITS.outputBytes),
    }));
    const after = await workSource(this.directory);
    const check = { id: randomUUID(), command, ...result, before: before.fingerprint, after: after.fingerprint, at: Date.now() };
    await this.update(root, async state => {
      if (state.work?.id !== work.id || state.work.generation !== work.generation || !["ready", "running", "review"].includes(state.work.phase)) throw new Error("work-check-interrupted");
      state.work.checks.push(check); state.work.updatedAt = Date.now();
    });
    return check;
    } finally { this.activeChecks.delete(root); }
  }
  async settled(root: string, callID: string, succeeded: boolean, report: string): Promise<void> {
    await this.update(root, async state => {
      const work = state.work;
      if (!work || work.callID !== callID || work.phase !== "running") return;
      work.phase = succeeded && work.child ? "review" : "interrupted";
      delete work.reviewView;
      work.report = report.slice(-WORK_LIMITS.outputBytes); work.updatedAt = Date.now();
    });
  }
  async interrupt(root: string, cancelled = false): Promise<void> {
    await this.update(root, async state => {
      if (state.work && !["completed", "cancelled"].includes(state.work.phase)) {
        state.work.phase = cancelled ? "cancelled" : "interrupted"; state.work.updatedAt = Date.now();
      }
    });
  }
  async review(root: string, decision: "accept" | "revise" | "blocked", assessment: string, checks: string[],
    replacements: WorkCheckReplacement[] = []): Promise<WorkState> {
    if (!assessment.trim() || assessment.length > 8000) throw new Error("work-review-assessment-required");
    return this.update(root, async state => {
      const work = state.work;
      if (!work || work.phase !== "review") throw new Error("work-not-ready-for-review");
      if (this.activeChecks.has(root)) throw new Error("work-validation-still-running");
      if (decision === "revise") {
        if (work.attempts >= this.maxAttempts) throw new Error("work-attempt-budget-exhausted");
        work.feedback.push(assessment); work.phase = "ready"; work.generation++; work.callID = null;
      } else if (decision === "blocked") {
        work.phase = "blocked"; work.assessment = assessment;
        work.feedback.push(`Unresolved blocker: ${assessment}`);
      } else {
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
        work.phase = "completed"; work.assessment = assessment; work.acceptedChecks = checks; work.acceptedSource = source.fingerprint;
      }
      work.updatedAt = Date.now();
      return work;
    });
  }
}
