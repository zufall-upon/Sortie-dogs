import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptanceContinuityFingerprint } from "../core/acceptance-continuity.js";
import { WorktreeLifecycle } from "../core/worktree-lifecycle.js";
import { normalizeWorktreeScope } from "../core/worktree-scope.js";
import { produceWorktreeCommitArtifact } from "../core/worktree-commit-artifact.js";
import type { ParallelDispatchDescriptor, WorktreeCommitArtifact, WorktreeCommitValidationRequest } from "../core/types.js";
import type { TerminalRescueAttempt, TerminalRescueExecution, TerminalRescueHost } from "../core/terminal-rescue-runtime.js";
import { readHostModels, openCodeModel, type OpenCodeModelAvailabilityClient } from "./model-routing-hook.js";

export const DEFAULT_TERMINAL_RESCUE_MODEL = "openai/gpt-6-astra";

export interface TerminalRescueSessionClient extends OpenCodeModelAvailabilityClient {
  session: {
    create(input: { body: { parentID: string; title: string }; query: { directory: string } }): Promise<unknown>;
    prompt(input: { path: { id: string }; body: { agent: string; model: { providerID: string; modelID: string };
      parts: { type: "text"; text: string }[] }; query: { directory: string } }): Promise<unknown>;
    abort(input: { path: { id: string }; query: { directory: string } }): Promise<unknown>;
  };
}
export interface TerminalRescueHostOptions {
  readonly runID: string;
  readonly projectRoot: string;
  readonly ownerSessionID: string;
  readonly ledgerPath: string;
  readonly scopeRead: readonly string[];
  readonly validation: WorktreeCommitValidationRequest;
  readonly client: TerminalRescueSessionClient;
  readonly createdChild: (childID: string, callID: string) => void;
  readonly finishedChild: (callID: string) => void;
  readonly releaseWriter: (childID: string) => Promise<void>;
  readonly writerReleased: (childID: string) => Promise<boolean>;
}
const data = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.data !== undefined ? data(record.data) : record;
};

/** Uses the same session create/prompt/abort calls as native Task, and the existing worktree/artifact owners. */
export class OpenCodeTerminalRescueHost implements TerminalRescueHost {
  artifact: WorktreeCommitArtifact | undefined;
  candidateRef: string | undefined;
  constructor(readonly options: TerminalRescueHostOptions) {}

  async availableTarget() {
    return (await readHostModels(this.options.client))?.has(DEFAULT_TERMINAL_RESCUE_MODEL)
      ? { model: DEFAULT_TERMINAL_RESCUE_MODEL, variant: null } : null;
  }

  async start(attempt: TerminalRescueAttempt, signal: AbortSignal): Promise<TerminalRescueExecution> {
    const { projectRoot, client } = this.options;
    const contract = attempt.terminal_rescue_contract;
    const command = [this.options.validation.executable, ...(this.options.validation.args ?? [])]
      .map((part) => /\s/u.test(part) ? JSON.stringify(part) : part).join(" ");
    if (contract.validation.length !== 1 || contract.validation[0] !== command) throw new Error("rescue-validation-drift");
    const lifecycleScope = normalizeWorktreeScope({ read: this.options.scopeRead, write: contract.scope });
    const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: projectRoot });
    const pin = await lifecycle.pinCleanBase();
    const worktreeID = `rescue-${attempt.attempt_id}`;
    const [worktree] = await lifecycle.createManyAtBase({ authority: pin, baseSha: contract.candidate_id,
      tasks: [{ task_id: attempt.unit_id, worktree: worktreeID, branch: `sortie-rescue/${attempt.attempt_id}`,
        base_sha: contract.candidate_id, depends_on: [], scope: { read: [...lifecycleScope.read], write: [...lifecycleScope.write] } }] });
    if (worktree === undefined) throw new Error("rescue-worktree-unavailable");
    const controls = join(worktree.path, ".sortie-dogs", "contracts");
    await mkdir(controls, { recursive: true });
    const handoffPath = join(controls, `handoff.${worktreeID}.json`);
    const manifestPath = join(controls, `operation-manifest.${worktreeID}.json`);
    await writeFile(manifestPath, JSON.stringify({ version: "0.1.0", task_id: worktreeID,
      read: [...this.options.scopeRead], write: [...contract.scope], validation: [...contract.validation] }));
    const criteria = [...contract.acceptance];
    await writeFile(handoffPath, JSON.stringify({ version: "0.1.0", profile: "full", id: worktreeID, created_at: attempt.at,
      task: { title: "Terminal worker rescue", objective: criteria.join("; ") }, scope: { paths: [...contract.scope] },
      sources: this.options.scopeRead.map((path) => ({ path, rev: contract.candidate_id })),
      state: { done: [], next: ["Implement the accepted scope; return after releasing the write gate."], blocked: [] }, risks: [],
      verification: contract.validation.map((check) => ({ check, status: "not_run", exit_code: null, summary: "Pinned validation" })),
      ext: { "sortie-dogs/write-gate": { project_root: worktree.path, operation_manifest: `.sortie-dogs/contracts/operation-manifest.${worktreeID}.json` },
        "sortie-dogs/acceptance-continuity": { schema_version: "0.1", authority: "dispatch", task_id: worktreeID,
          criteria, fingerprint: acceptanceContinuityFingerprint(criteria), parent_fingerprint: "none" },
        "sortie-dogs/terminal-rescue": { ledger_path: this.options.ledgerPath, attempt_id: attempt.attempt_id } } }));
    const created = data(await client.session.create({ body: { parentID: this.options.ownerSessionID, title: worktreeID },
      query: { directory: projectRoot } }));
    if (typeof created.id !== "string") throw new Error("rescue-child-create-unconfirmed");
    const childID = created.id;
    this.options.createdChild(childID, attempt.call_id);
    let completed = false, cancelled = false, accepting = false, cleaned = false;
    let outcome!: Awaited<TerminalRescueExecution["completion"]>;
    let resolveCompletion!: (value: typeof outcome) => void;
    const completion = new Promise<typeof outcome>((resolve) => { resolveCompletion = resolve; });
    const stop = async () => {
      const reply = await client.session.abort({ path: { id: childID }, query: { directory: projectRoot } });
      if (reply === false || (reply !== null && typeof reply === "object" && "data" in reply && reply.data === false)) throw new Error("rescue-abort-unconfirmed");
      cancelled = true;
    };
    const release = async () => {
      if (!completed || accepting) throw new Error("rescue-child-active");
      await this.options.releaseWriter(childID);
      if (!await this.options.writerReleased(childID)) throw new Error("rescue-writer-active");
      if (!cleaned) {
        await rm(handoffPath, { force: true });
        await rm(manifestPath, { force: true });
        await lifecycle.cleanup(worktreeID);
        cleaned = true;
      }
    };
    return { child_id: childID, completion, begin: async () => {
      if (signal.aborted) { await stop(); throw new Error("rescue-cancelled-before-prompt"); }
      const started = Date.now();
      void (async () => {
        let info: Record<string, unknown> = {};
        let failure: typeof outcome.failure = null;
        try {
          const response = data(await client.session.prompt({ path: { id: childID }, query: { directory: projectRoot }, body: {
            agent: "dog-worker", model: openCodeModel(attempt.selected_model)!, parts: [{ type: "text", text: [
              "/sortie", `task_id: ${worktreeID}`, "role: implementation", `project_root: ${worktree.path}`,
              `handoff_path: ${handoffPath}`, `operation_manifest: ${manifestPath}`,
              `source_manifest: ${JSON.stringify([...this.options.scopeRead, ...contract.scope])}`,
              `terminal_rescue_attempt: ${attempt.attempt_id}`, "acceptance:", ...criteria.map((item) => `  - ${item}`),
              `validation: ${command}`, "Read the exact handoff first, bind the normal write gate, implement only the accepted scope, run the declared validation, release the write gate and return. Do not delegate, commit, promote, modify controls or change acceptance.",
            ].join("\n") }] } }));
          info = data(response.info);
          if (info.error !== undefined || info.role !== "assistant") throw new Error("rescue-prompt-unconfirmed");
          if (`${info.providerID}/${info.modelID}` !== attempt.selected_model) throw new Error("rescue-observed-model-mismatch");
          if (cancelled) throw new Error("rescue-cancelled");
          accepting = true;
          const descriptor: ParallelDispatchDescriptor = { run_id: attempt.call_id, dispatch_id: attempt.attempt_id,
            task_id: attempt.unit_id, managed_path: worktree.path, branch: worktree.branch, base_sha: contract.candidate_id,
            depends_on: [], scope_read: lifecycleScope.read, scope_write: lifecycleScope.write,
            parallel_group: attempt.call_id, parallel_unit: attempt.unit_id, parallel_units: 1, attempt: 1,
            contract_fingerprint: createHash("sha256").update(JSON.stringify(contract)).digest("hex") };
          this.artifact = await produceWorktreeCommitArtifact({ descriptor, managed_path: worktree.path, validation: this.options.validation });
          await lifecycle.acceptCommit(worktreeID, worktree.path, contract.candidate_id, this.artifact.commit_sha, worktree.branch);
          this.candidateRef = `refs/sortie-dogs/rescue-candidates/${attempt.attempt_id}`;
          await new Promise<void>((resolve, reject) => execFile("git", ["update-ref", this.candidateRef!, this.artifact!.commit_sha, "0".repeat(this.artifact!.commit_sha.length)],
            { cwd: projectRoot, timeout: 30000 }, (error) => error === null ? resolve() : reject(error)));
          const receipts = join(projectRoot, ".sortie-dogs", "rescue-artifacts");
          await mkdir(receipts, { recursive: true });
          await writeFile(join(receipts, `${attempt.attempt_id}.json`), JSON.stringify({ artifact: this.artifact, candidate_ref: this.candidateRef }), { flag: "wx" });
        } catch (error) {
          const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "host_unconfirmed";
          failure = { category: cancelled ? "cancellation" : code === "validation-failed" ? "implementation" : "infrastructure", code };
        } finally {
          accepting = false;
          completed = true;
          outcome = { disposition: cancelled ? "cancelled" : failure === null ? "succeeded" : "failed", failure,
            observed_model: typeof info.modelID === "string" && typeof info.providerID === "string" ? `${info.providerID}/${info.modelID}` : null,
            observed_variant: typeof info.variant === "string" ? info.variant : null,
            observation: { stage: "recovery", duration_ms: Date.now() - started,
              usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
              // A prompt response reports only its final message cost, not the whole rescue attempt.
              estimated_cost: { usd: null, provenance: "unknown" } },
            references: { capsule_ids: [], artifact_ids: this.artifact === undefined ? [] : [`sha256:${this.artifact.change_fingerprint}`] } };
          try { await release(); } finally { this.options.finishedChild(attempt.call_id); resolveCompletion(outcome); }
        }
      })().catch(() => {});
    }, runtime: {
      observe: async () => { const released = await this.options.writerReleased(childID);
        const satisfied = (value: boolean) => value ? "satisfied" as const : "unsatisfied" as const;
        return { observation: { identity: { run_id: this.options.runID, unit_id: attempt.unit_id, attempt_id: attempt.attempt_id,
          predecessor_attempt_id: attempt.predecessor_attempt_id, candidate_id: attempt.candidate_id, route_id: attempt.route_id,
          child_id: childID, call_id: attempt.call_id }, disposition: outcome?.disposition ?? "continue" },
        evidence: { terminal: satisfied(completed), tools_quiescent: satisfied(completed), artifact_window_closed: satisfied(!accepting),
          gate_released: satisfied(released), lease_released: satisfied(released), writer_released: satisfied(released), worktree_released: satisfied(cleaned) } }; },
      stop, release, terminal: async () => {},
    } };
  }
}
