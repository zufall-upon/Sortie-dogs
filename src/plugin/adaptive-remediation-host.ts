import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { acceptanceContinuityFingerprint } from "../core/acceptance-continuity.js";
import { AdaptiveRemediationRuntime, type AdaptiveCandidate, type AdaptivePatchEvidence,
  type AdaptiveRemediationRequest, type AdaptiveRemediationRuntimeHost } from "../core/adaptive-remediation-runtime.js";
import { WorktreeLifecycle } from "../core/worktree-lifecycle.js";
import { normalizeWorktreeScope } from "../core/worktree-scope.js";
import { produceWorktreeCommitArtifact, runContainedValidation } from "../core/worktree-commit-artifact.js";
import type { AdaptiveRemediationCommand, AdaptiveRemediationProbeCommand, AdaptiveRemediationValidationEvidence,
  ParallelDispatchDescriptor } from "../core/types.js";
import { openCodeModel, type OpenCodeModelAvailabilityClient } from "./model-routing-hook.js";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const HASH = /^[a-f0-9]{64}$/u;

export interface AdaptivePatchProducer {
  apply(input: { readonly iteration: 1 | 2 | 3; readonly worktree_path: string; readonly parent_head: string;
    readonly acceptance: readonly string[]; readonly allowed_paths: AdaptiveRemediationRequest["allowed_paths"] }): Promise<{ readonly hypothesis: string }>;
}

export interface AdaptiveReviewProvider {
  review(input: { readonly worktree_path: string; readonly candidate_head: string;
    readonly parent_head: string; readonly risk_class: AdaptiveRemediationRequest["risk_class"] }): Promise<{ readonly status: "pass" | "remediation-required" | "fail"; readonly fingerprint: string }>;
}

export const DEFAULT_ADAPTIVE_REMEDIATION_MODEL = "openai/gpt-6-sol";

export interface AdaptiveRemediationSessionClient extends OpenCodeModelAvailabilityClient {
  session: {
    create(input: { body: { parentID: string; title: string }; query: { directory: string } }): Promise<unknown>;
    prompt(input: { path: { id: string }; body: { agent: string; model: { providerID: string; modelID: string };
      parts: { type: "text"; text: string }[] }; query: { directory: string } }): Promise<unknown>;
    abort(input: { path: { id: string }; query: { directory: string } }): Promise<unknown>;
  };
}

export interface OpenCodeAdaptiveRemediationProviderOptions {
  readonly projectRoot: string;
  readonly ownerSessionID: string;
  readonly runID: string;
  readonly taskID: string;
  readonly scopeRead: readonly string[];
  readonly scopeWrite: readonly string[];
  readonly acceptance: readonly string[];
  readonly improvementSignal: AdaptiveRemediationRequest["improvement_signal"];
  readonly client: AdaptiveRemediationSessionClient;
  readonly model?: string;
  readonly createdChild: (childID: string, callID: string) => void;
  readonly finishedChild: (callID: string) => void;
  readonly releaseWriter: (childID: string) => Promise<void>;
  readonly writerReleased: (childID: string) => Promise<boolean>;
}

const responseData = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.data === undefined ? record : responseData(record.data);
};

const responseText = (value: unknown): string => {
  const parts = responseData(value).parts;
  if (!Array.isArray(parts)) return "";
  return parts.flatMap((part) => part !== null && typeof part === "object" &&
    (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string"
    ? [(part as Record<string, unknown>).text as string] : []).join("\n");
};

/** OpenCode-backed patch and independent review provider used by the plugin entrypoint. */
export class OpenCodeAdaptiveRemediationProvider implements AdaptivePatchProducer, AdaptiveReviewProvider {
  constructor(readonly options: OpenCodeAdaptiveRemediationProviderOptions) {}
  private get model() { return this.options.model ?? DEFAULT_ADAPTIVE_REMEDIATION_MODEL; }

  async apply(input: Parameters<AdaptivePatchProducer["apply"]>[0]): Promise<{ readonly hypothesis: string }> {
    const id = `adaptive-${input.iteration}-${randomUUID()}`;
    const callID = randomUUID();
    const controls = join(input.worktree_path, ".sortie-dogs", "contracts");
    const handoffPath = join(controls, `handoff.${id}.json`);
    const manifestPath = join(controls, `operation-manifest.${id}.json`);
    const sources = [...new Set([...this.options.scopeRead, ...this.options.scopeWrite])];
    if (sources.length === 0) throw new Error("adaptive-source-manifest-empty");
    const criteria = [...this.options.acceptance];
    await mkdir(controls, { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ version: "0.1.0", task_id: id,
      read: [...this.options.scopeRead], write: [...this.options.scopeWrite], validation: ["git diff --check"] }));
    await writeFile(handoffPath, JSON.stringify({ version: "0.1.0", profile: "full", id, created_at: new Date().toISOString(),
      task: { title: "Adaptive remediation probe patch", objective: criteria.join("; ") }, scope: { paths: [...this.options.scopeWrite] },
      sources: sources.map((path) => ({ path, rev: input.parent_head })),
      state: { done: [], next: ["Create one minimal patch for the declared hypothesis."], blocked: [] }, risks: [],
      verification: [{ check: "git diff --check", status: "not_run", exit_code: null, summary: "Patch-only check; host owns the sole targeted probe." }],
      ext: { "sortie-dogs/write-gate": { project_root: input.worktree_path,
        operation_manifest: `.sortie-dogs/contracts/operation-manifest.${id}.json` },
        "sortie-dogs/acceptance-continuity": { schema_version: "0.1", authority: "dispatch", task_id: id,
          criteria, fingerprint: acceptanceContinuityFingerprint(criteria), parent_fingerprint: "none" } } }));
    const created = responseData(await this.options.client.session.create({ body: { parentID: this.options.ownerSessionID, title: id },
      query: { directory: this.options.projectRoot } }));
    if (typeof created.id !== "string") throw new Error("adaptive-child-create-unconfirmed");
    const childID = created.id;
    this.options.createdChild(childID, callID);
    try {
      const response = responseData(await this.options.client.session.prompt({ path: { id: childID }, query: { directory: this.options.projectRoot }, body: {
        agent: "dog-worker", model: openCodeModel(this.model)!, parts: [{ type: "text", text: ["/sortie", `task_id: ${id}`,
          "role: remediation", `project_root: ${input.worktree_path}`, `handoff_path: ${handoffPath}`, `operation_manifest: ${manifestPath}`,
          `source_manifest: ${JSON.stringify(sources)}`, `adaptive_run: ${this.options.runID}`, `adaptive_iteration: ${input.iteration}`,
          `declared_signal_and_goal: ${JSON.stringify(this.options.improvementSignal)}`,
          "acceptance:", ...criteria.map((item) => `  - ${item}`),
          "Create exactly one minimal reversible patch for the same declared convergence hypothesis. Run only git diff --check; the host owns and will run the sole targeted signal probe. Release the write gate, then return. Do not commit, run canonical validation, delegate, change controls, broaden scope, or promote."].join("\n") }] } }));
      const info = responseData(response.info);
      if (info.error !== undefined || info.role !== "assistant" || `${info.providerID}/${info.modelID}` !== this.model) {
        throw new Error("adaptive-worker-prompt-unconfirmed");
      }
      await this.options.releaseWriter(childID);
      if (!await this.options.writerReleased(childID)) throw new Error("adaptive-worker-still-active");
      return { hypothesis: `move ${this.options.improvementSignal.signal_id} ${this.options.improvementSignal.improvement_direction} toward ${this.options.improvementSignal.goal.operator} ${this.options.improvementSignal.goal.value}` };
    } catch (error) {
      await this.options.client.session.abort({ path: { id: childID }, query: { directory: this.options.projectRoot } }).catch(() => undefined);
      throw error;
    } finally {
      await rm(handoffPath, { force: true });
      await rm(manifestPath, { force: true });
      this.options.finishedChild(callID);
    }
  }

  async review(input: Parameters<AdaptiveReviewProvider["review"]>[0]) {
    const id = `adaptive-review-${randomUUID()}`;
    const callID = randomUUID();
    const diff = await exec("git", ["diff", "--no-ext-diff", input.parent_head, input.candidate_head, "--", ...this.options.scopeWrite], input.worktree_path);
    const created = responseData(await this.options.client.session.create({ body: { parentID: this.options.ownerSessionID, title: id },
      query: { directory: this.options.projectRoot } }));
    if (typeof created.id !== "string") throw new Error("adaptive-review-create-unconfirmed");
    this.options.createdChild(created.id, callID);
    try {
      const response = await this.options.client.session.prompt({ path: { id: created.id }, query: { directory: this.options.projectRoot }, body: {
        agent: "dog-reviewer", model: openCodeModel(this.model)!, parts: [{ type: "text", text: [
          `High-risk bounded SourceReview promotion gate for adaptive candidate ${input.candidate_head}.`,
          `Runtime risk class: ${input.risk_class}; promotion review is elevated to high-risk SourceReview.`,
          `Exact manifest: ${JSON.stringify({ read: this.options.scopeRead, write: this.options.scopeWrite })}.`,
          "changedLogicSummary:", ...this.options.scopeWrite.map((path, index) => `  [${index}] ${path}: bounded candidate logic represented by the immutable diff below.`),
          "Indexed acceptance mapping:", ...this.options.acceptance.map((item, index) => `  acceptance[${index}] ${JSON.stringify(item)} -> changedLogicSummary[${Math.min(index, this.options.scopeWrite.length - 1)}]`),
          "Canonical candidate validation passed. Review this immutable diff without tools:", diff,
          "Perform an independent read-only source/diff review. End with exactly one line: ADAPTIVE_REVIEW: PASS, ADAPTIVE_REVIEW: REMEDIATION_REQUIRED, or ADAPTIVE_REVIEW: FAIL."].join("\n") }] } });
      const text = responseText(response);
      const marker = /^\s*(?:[-*]\s*)?(?:\*\*)?ADAPTIVE_REVIEW:\s*(PASS|REMEDIATION_REQUIRED|FAIL)(?:\*\*)?\s*$/mu.exec(text)?.[1];
      const status = marker === "PASS" ? "pass" as const : marker === "REMEDIATION_REQUIRED" ? "remediation-required" as const : "fail" as const;
      return { status, fingerprint: createHash("sha256").update(JSON.stringify([input.candidate_head, input.risk_class, text])).digest("hex") };
    } finally { this.options.finishedChild(callID); }
  }
}

export interface GitAdaptiveRemediationHostOptions {
  readonly repositoryRoot: string;
  readonly runID: string;
  readonly taskID: string;
  readonly targetRef: string;
  readonly allowedPaths: AdaptiveRemediationRequest["allowed_paths"];
  readonly patchProducer: AdaptivePatchProducer;
  readonly reviewProvider: AdaptiveReviewProvider;
  readonly gitPath?: string;
  readonly reserveProbe?: AdaptiveRemediationRuntimeHost["reserveProbe"];
  readonly finishProbe?: AdaptiveRemediationRuntimeHost["finishProbe"];
  readonly failProbe?: AdaptiveRemediationRuntimeHost["failProbe"];
}

const exec = (executable: string, args: readonly string[], cwd: string): Promise<string> => new Promise((resolvePromise, reject) => {
  execFile(executable, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => error === null ? resolvePromise(stdout) : reject(error));
});

/** Concrete Git/process adapter used by the plugin and cross-platform RPT fixture. */
export class GitAdaptiveRemediationHost implements AdaptiveRemediationRuntimeHost {
  private readonly dispatchRunID = randomUUID();
  private lifecycle: WorktreeLifecycle | undefined;
  private authority: Awaited<ReturnType<WorktreeLifecycle["pinCleanBase"]>> | undefined;
  private readonly candidates = new Map<string, AdaptiveCandidate>();
  private promotedCandidate: AdaptiveCandidate | undefined;
  constructor(readonly options: GitAdaptiveRemediationHostOptions) {}
  private get git() { return this.options.gitPath ?? "git"; }

  async snapshotTarget(targetRef: string) {
    if (targetRef !== this.options.targetRef) throw new Error("adaptive-target-drift");
    const head = (await exec(this.git, ["rev-parse", "--verify", `${targetRef}^{commit}`], this.options.repositoryRoot)).trim();
    const tree = (await exec(this.git, ["rev-parse", "--verify", `${head}^{tree}`], this.options.repositoryRoot)).trim();
    if (!SHA.test(head) || !SHA.test(tree)) throw new Error("adaptive-target-invalid");
    return { head, tree };
  }

  async openCandidate(parentHead: string, iteration: 1 | 2 | 3): Promise<AdaptiveCandidate> {
    this.lifecycle ??= await WorktreeLifecycle.open({ repositoryRoot: this.options.repositoryRoot, ...(this.options.gitPath === undefined ? {} : { gitPath: this.options.gitPath }) });
    this.authority ??= await this.lifecycle.pinCleanBase();
    const scope = normalizeWorktreeScope(this.options.allowedPaths);
    const worktreeID = `adaptive-${this.options.runID}-${iteration}-${randomUUID().slice(0, 8)}`;
    const [worktree] = await this.lifecycle.createManyAtBase({ authority: this.authority, baseSha: parentHead, tasks: [{
      task_id: `${this.options.taskID}-${iteration}`, worktree: worktreeID, branch: `sortie-adaptive/${this.options.runID}-${iteration}-${randomUUID().slice(0, 8)}`,
      base_sha: parentHead, depends_on: [], scope: { read: [...scope.read], write: [...scope.write] },
    }] });
    if (worktree === undefined) throw new Error("adaptive-worktree-unavailable");
    const candidate = { worktree_id: worktreeID, path: worktree.path, parent_head: parentHead };
    this.candidates.set(worktreeID, candidate);
    return candidate;
  }

  private async observationPath(candidate: AdaptiveCandidate, command: AdaptiveRemediationProbeCommand): Promise<string> {
    if (isAbsolute(command.observation_path) || command.observation_path.includes("..")) throw new Error("adaptive-observation-path-invalid");
    const root = join(this.options.repositoryRoot, ".git", "sortie-dogs", "adaptive-observations");
    await mkdir(root, { recursive: true });
    return join(root, `${createHash("sha256").update(`${candidate.worktree_id}\0${command.observation_path}`).digest("hex")}.json`);
  }

  private command(command: AdaptiveRemediationCommand, observationPath?: string) {
    const args = (command.args ?? []).map((arg) => observationPath === undefined ? arg : arg.replaceAll("{observation_path}", observationPath));
    return { executable: command.executable, args, timeout_ms: command.timeout_ms };
  }

  async runBaselineProbe(candidate: AdaptiveCandidate, command: AdaptiveRemediationProbeCommand) {
    const path = await this.observationPath(candidate, command);
    const result = await runContainedValidation({ ...this.command(command, path), cwd: candidate.path });
    const raw = await this.readProbeValue(path, result.ok);
    return { command: result.command, exit_code: result.exit_code,
      fingerprint: createHash("sha256").update(JSON.stringify([result.fingerprint, raw.signal_id, raw.value])).digest("hex"), ...raw };
  }

  private async readProbeValue(path: string, executed: boolean) {
    if (!executed) { await rm(path, { force: true }).catch(() => undefined); return { signal_id: "", value: null }; }
    try {
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw) > 4096) throw new Error();
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "signal_id,value" || typeof value.signal_id !== "string" || value.signal_id.length === 0 ||
        (value.value !== null && (typeof value.value !== "number" || !Number.isFinite(value.value)))) throw new Error();
      return { signal_id: value.signal_id, value: value.value as number | null };
    } catch { return { signal_id: "", value: null }; }
    finally { await rm(path, { force: true }).catch(() => undefined); }
  }

  async producePatch(input: Parameters<AdaptiveRemediationRuntimeHost["producePatch"]>[0]): Promise<AdaptivePatchEvidence> {
    const result = await this.options.patchProducer.apply({ iteration: input.iteration, worktree_path: input.candidate.path,
      parent_head: input.candidate.parent_head, acceptance: input.acceptance, allowed_paths: input.allowed_paths });
    if (typeof result.hypothesis !== "string" || result.hypothesis.trim() === "") throw new Error("adaptive-hypothesis-invalid");
    const observationPath = await this.observationPath(input.candidate, input.probe_validation);
    const dispatchTaskID = `${this.options.taskID}-${input.iteration}`;
    const descriptor: ParallelDispatchDescriptor = { run_id: this.dispatchRunID, dispatch_id: randomUUID(),
      task_id: dispatchTaskID, managed_path: input.candidate.path,
      branch: (await exec(this.git, ["symbolic-ref", "--quiet", "--short", "HEAD"], input.candidate.path)).trim(),
      base_sha: input.candidate.parent_head, depends_on: [], ...(() => { const scope = normalizeWorktreeScope(input.allowed_paths);
         return { scope_read: scope.read, scope_write: scope.write }; })(), parallel_group: this.dispatchRunID,
      parallel_unit: dispatchTaskID, parallel_units: 1, attempt: 1,
      contract_fingerprint: createHash("sha256").update(JSON.stringify(input.acceptance)).digest("hex") };
    const artifact = await produceWorktreeCommitArtifact({ descriptor, managed_path: input.candidate.path,
      validation: this.command(input.probe_validation, observationPath) });
    const probeValue = await this.readProbeValue(observationPath, true);
    await this.lifecycle!.acceptCommit(input.candidate.worktree_id, input.candidate.path, input.candidate.parent_head, artifact.commit_sha, artifact.branch);
    return { candidate: input.candidate, candidate_head: artifact.commit_sha, hypothesis: result.hypothesis,
      patch_fingerprint: artifact.change_fingerprint, changed_paths: artifact.changed_paths,
      probe: { command: artifact.validation.command, exit_code: 0,
        fingerprint: createHash("sha256").update(JSON.stringify([artifact.validation.validation_fingerprint, probeValue])).digest("hex"), ...probeValue } };
  }

  async reserveProbe(input: Parameters<NonNullable<AdaptiveRemediationRuntimeHost["reserveProbe"]>>[0]) {
    return this.options.reserveProbe === undefined ? "" : this.options.reserveProbe(input);
  }
  async finishProbe(input: Parameters<NonNullable<AdaptiveRemediationRuntimeHost["finishProbe"]>>[0]) {
    await this.options.finishProbe?.(input);
  }
  async failProbe(input: Parameters<NonNullable<AdaptiveRemediationRuntimeHost["failProbe"]>>[0]) {
    await this.options.failProbe?.(input);
  }

  async inspectCleanup(candidate: AdaptiveCandidate) {
    const status = await exec(this.git, ["status", "--porcelain=v1", "--untracked-files=all"], candidate.path);
    const remaining = status.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3));
    return { ok: remaining.length === 0, remaining_paths: remaining };
  }

  async discardCandidate(candidate: AdaptiveCandidate) { await this.lifecycle?.cleanup(candidate.worktree_id); this.candidates.delete(candidate.worktree_id); }

  async runCanonical(candidate: AdaptiveCandidate, command: AdaptiveRemediationCommand): Promise<AdaptiveRemediationValidationEvidence> {
    const result = await runContainedValidation({ ...this.command(command), cwd: candidate.path });
    return { command: result.command, status: result.ok ? "pass" : "fail", exit_code: result.exit_code, fingerprint: result.fingerprint };
  }

  review(input: Parameters<AdaptiveRemediationRuntimeHost["review"]>[0]) { return this.options.reviewProvider.review({
    worktree_path: input.candidate.path, candidate_head: input.candidate_head, parent_head: input.candidate.parent_head, risk_class: input.risk_class,
  }); }

  async promote(input: Parameters<AdaptiveRemediationRuntimeHost["promote"]>[0]) {
    try { await exec(this.git, ["update-ref", input.target_ref, input.candidate_head, input.expected_head], this.options.repositoryRoot); }
    catch { return { status: "cas-drift" as const, observed_head: (await this.snapshotTarget(input.target_ref)).head }; }
    this.promotedCandidate = undefined;
    for (const candidate of this.candidates.values()) {
      const head = (await exec(this.git, ["rev-parse", "--verify", "HEAD^{commit}"], candidate.path)).trim();
      if (head === input.candidate_head) { this.promotedCandidate = candidate; break; }
    }
    return { status: "promoted" as const, observed_head: input.candidate_head };
  }

  async runPostMerge(command: AdaptiveRemediationCommand): Promise<AdaptiveRemediationValidationEvidence> {
    const result = await runContainedValidation({ ...this.command(command), cwd: this.promotedCandidate?.path ?? this.options.repositoryRoot });
    return { command: result.command, status: result.ok ? "pass" : "fail", exit_code: result.exit_code, fingerprint: result.fingerprint };
  }

  async release(candidates: readonly AdaptiveCandidate[]) {
    const remaining: string[] = [];
    for (const candidate of [...candidates].reverse()) {
      if (!this.candidates.has(candidate.worktree_id)) continue;
      try { await this.lifecycle?.cleanup(candidate.worktree_id); this.candidates.delete(candidate.worktree_id); }
      catch { remaining.push(candidate.path); }
    }
    return { ok: remaining.length === 0, remaining_paths: remaining };
  }
}

export async function executeGitAdaptiveRemediation(request: AdaptiveRemediationRequest, options: GitAdaptiveRemediationHostOptions) {
  return new AdaptiveRemediationRuntime(new GitAdaptiveRemediationHost(options)).execute(request);
}
