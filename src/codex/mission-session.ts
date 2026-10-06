import { codexUsageTotal, codexUsageInfo, codexNativeTime, emptyCodexUsage, type CodexUsageTotal, type CodexUsageObservation } from "./mission-telemetry.js";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CodexAppServerHost, createCodexAppServerTransport, type CodexDynamicTool, type CodexDynamicToolCall,
  type CodexTurnEvent, type CodexTurnResult, type CodexAppServerTransport, type CodexAppServerHostOptions } from "./app-server.js";
import { SortieDogsV010Plugin } from "../plugin/profiled.js";
import type { OpenCodeHooks } from "../plugin/index.js";
import { legacyToolArgs, toolSchema } from "../plugin/tool-schema.js";
import { V010_RUNTIME_PROFILE as profile } from "../core/runtime-profile.js";
import { runtimeAssets } from "../runtime-assets-v010.js";
import { OperatorRuntime } from "../core/operator-runtime.js";
import { OperatorMissionRuntime, type CodexMissionOwner, type CodexNotStartedProof, type CodexWorkerDispatch, codexProcessOwner, codexOwnerGone } from "../core/operator-mission.js";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
interface NativeSession {
  id: string;
  agent: string;
  model: { providerID: string; modelID: string; variant?: string };
  parentID?: string;
  outcome: string;
  host: CodexAppServerHost;
  history: JsonObject[];
  usage?: JsonObject;
  usageBaseline?: CodexUsageTotal;
  createdAt?: number;
}
export interface CodexMissionCommandRequest {
  readonly tool: "bash" | "read" | "write";
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}
/** The host owns authorization and execution. Never return completed for approval alone. */
export type CodexMissionCommandResult =
  | { readonly status: "completed"; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly status: "denied" | "not-started" | "interrupted" | "unknown"; readonly reason: string };
export type CodexMissionCommandExecutor = (request: CodexMissionCommandRequest) => Promise<CodexMissionCommandResult>;

export interface CodexMissionSessionOptions {
  readonly projectRoot: string;
  readonly resumeThreadID?: string;
  /** Explicit override for every role. Otherwise retain the packaged role model. */
  readonly model?: string;
  readonly roleModels?: Readonly<Record<string, { model: string; effort?: string }>>;
  readonly effort?: string;
  readonly executable?: string;
  readonly transportFactory?: () => CodexAppServerTransport;
  /** Delegate exact post-hook commands to the parent host; omission retains native command/exec. */
  readonly executeCommand?: CodexMissionCommandExecutor;
  readonly approval?: CodexAppServerHostOptions["approval"];
  readonly permissionsApproval?: CodexAppServerHostOptions["permissionsApproval"];
  readonly onEvent?: (event: CodexTurnEvent & { threadId: string }) => void | Promise<void>;
}

/** Native Codex transport for the existing Mission tools, roles and acceptance state. */
export class CodexMissionSession {
  private hooks!: OpenCodeHooks;
  private readonly sessions = new Map<string, NativeSession>();
  private closed = false;
  private readonly executionAbort = new AbortController();
  private readonly hosts = new Set<CodexAppServerHost>();
  private root?: string;
  private owner!: CodexMissionOwner;
  private observations: CodexUsageObservation[] = [];
  private readonly ownedRoots = new Set<string>();
  private readonly toolQueues = new Map<string, Promise<unknown>>();
  readonly directory: string;
  private constructor(private readonly options: CodexMissionSessionOptions) { this.directory = resolve(options.projectRoot); }

  static async create(options: CodexMissionSessionOptions): Promise<CodexMissionSession> {
    const adapter = new CodexMissionSession(options);
    adapter.owner = await codexProcessOwner();
    const id = (request: { path: { id: string } }) => request.path.id;
    const info = (session: NativeSession) => ({ id: session.id, agent: session.agent, parentID: session.parentID,
      outcome: session.outcome, model: session.model, time: { created: session.createdAt } });
    adapter.hooks = await SortieDogsV010Plugin({ directory: adapter.directory, executionHost: "codex", returnReportTransport: "tool-result", reviewerCorrectionPermissions: true, client: { session: {
      get: async (request: { path: { id: string } }) => ({ data: info(adapter.required(id(request))) }),
      messages: async (request: { path: { id: string } }) => ({ data: adapter.required(id(request)).history }),
      children: async (request: { path: { id: string } }) => ({ data: [...adapter.sessions.values()]
        .filter(session => session.parentID === id(request)).map(info) }),
      abort: async (request: { path: { id: string } }) => { await adapter.required(id(request)).host.interrupt(); return { data: true }; },
    } } } as never);
    return adapter;
  }

  async run(prompt: string): Promise<{ rootSessionID: string; turn: CodexTurnResult; accepted: boolean; sessions: readonly JsonObject[] }> {
    if (this.closed) throw new Error("Codex Mission adapter is closed.");
    if (!this.root) {
      const missions = await new OperatorMissionRuntime(this.directory, profile).current();
      const active = missions.filter(item => item.executionHost === "codex" && !["completed", "cancelled"].includes(item.phase));
      const resume = this.options.resumeThreadID ?? (active.length === 1 ? active[0].root : undefined);
      if (active.length && !resume) throw new Error(`Select the existing Codex Mission with --resume: ${active.map(item => item.root).join(", ")}`);
      if (resume) {
        if (!missions.some(item => item.executionHost === "codex" && item.root === resume)) throw new Error("Codex Mission resume does not belong to this repository.");
        this.observations = missions.find(item => item.root === resume)?.codexUsage ?? [];
        await this.restoreSession(resume, "dog-operator");
        this.root = resume;
        await this.claimOwner(resume);
        await this.hooks.tool?.sortie_v010_operator_status?.execute({ view: "full" }, { sessionID: resume, agent: "dog-operator" });
      }
    }
    const session = this.root ? this.required(this.root) : await this.createSession("dog-operator");
    this.root = session.id;
    await this.claimOwner(session.id);
    const previous = await new OperatorMissionRuntime(this.directory, profile).read(session.id);
    const turn = await this.prompt(session, prompt);
    const mission = await new OperatorMissionRuntime(this.directory, profile).read(session.id);
    return { rootSessionID: session.id, turn, accepted: turn.status === "completed" && mission?.phase === "completed" &&
      (previous?.phase !== "completed" || previous.id !== mission.id), sessions: [...this.sessions.values()].map(item =>
      ({ thread_id: item.id, agent: item.agent, model: item.model, usage: item.usage ?? null, usage_scope: "native-thread-cumulative", cost: null })) };
  }

  private async stopHosts(): Promise<void> {
    this.closed = true;
    this.executionAbort.abort();
    await Promise.all([...this.hosts].map(host => host.close()));
  }

  async close(): Promise<void> {
    await this.stopHosts();
    await Promise.allSettled([...this.toolQueues.values()]);
    const missions = new OperatorMissionRuntime(this.directory, profile);
    for (const root of this.ownedRoots) await missions.codexRecovery(root, async state => {
      if (state.codexOwner?.generation === this.owner.generation) await missions.update(root, current => {
        if (current.codexOwner?.generation === this.owner.generation) current.codexOwner.closed = true;
      });
    });
  }

  private async claimOwner(root: string): Promise<void> {
    const missions = new OperatorMissionRuntime(this.directory, profile);
    const existing = await missions.read(root);
    if (!existing) return;
    if (existing.codexOwner?.generation === this.owner.generation) { this.ownedRoots.add(root); return; }
    await missions.codexRecovery(root, async state => {
      if (state.codexOwner && state.codexOwner.generation !== this.owner.generation && !await codexOwnerGone(state.codexOwner))
        throw new Error("codex-mission-owner-active:no-resend");
      await missions.update(root, current => { current.codexOwner = { ...this.owner }; });
    });
    this.ownedRoots.add(root);
  }

  private rootOf(session: NativeSession): string {
    let current = session;
    while (current.parentID) current = this.required(current.parentID);
    return current.id;
  }

  private async recoverNotStarted(threadID: string, turn: JsonObject, item: JsonObject): Promise<boolean> {
    if (item.tool !== "task" || !object(item.arguments) || item.arguments.task_id || typeof item.id !== "string" || typeof turn.id !== "string" ||
        !["completed", "interrupted", "failed"].includes(String(turn.status))) return false;
    const args = item.arguments;
    const inputHash = createHash("sha256").update(JSON.stringify(item.arguments)).digest("hex");
    const missions = new OperatorMissionRuntime(this.directory, profile);
    const records = (await missions.current()).filter(state => state.executionHost === "codex");
    for (const record of records) {
      const matches = (proof: CodexNotStartedProof) => proof.threadID === threadID &&
        proof.turnID === turn.id && proof.callID === item.id && proof.inputHash === inputHash;
      if (record.codexNotStarted?.some(matches)) return true;
      if (!await codexOwnerGone(record.codexOwner)) continue;
      const recovered = await missions.codexRecovery(record.root, async state => {
        if (state.id !== record.id || !await codexOwnerGone(state.codexOwner)) return false;
        if (state.codexNotStarted?.some(matches)) return true;
        const coordinator = state.root === threadID && state.callID === item.id && state.dispatchOpen && state.coordinator === null &&
          args.subagent_type === missions.task(state).subagent_type && args.prompt === missions.task(state).prompt;
        const run = state.runID ? await new OperatorRuntime(this.directory, profile).read(state.root) : undefined;
        const unit = run?.units.find(unit => unit.callID === item.id && unit.status === "running" && unit.childSessionID === null);
        const worker = run?.runID === state.runID && (run?.operatorSessionID ?? state.root) === threadID && unit &&
          new OperatorRuntime(this.directory, profile).matchesRecordedWorkerTask(run!, unit.unit.id, item.arguments);
        if (!coordinator && !worker) return false;
        const proof: CodexNotStartedProof = { missionID: state.id, threadID, turnID: String(turn.id), callID: String(item.id), inputHash,
          ownerGeneration: state.codexOwner!.generation };
        await missions.update(state.root, current => { (current.codexNotStarted ??= []).push(proof); });
        return true;
      });
      if (recovered) return true;
    }
    return false;
  }

  private async bindWorkerDispatch(parent: NativeSession, child: NativeSession, call: CodexDynamicToolCall, messageID: string): Promise<void> {
    if (child.agent !== "dog-worker-v010" || !object(call.arguments) || call.arguments.task_id) return;
    const root = this.rootOf(parent), missions = new OperatorMissionRuntime(this.directory, profile);
    await missions.update(root, state => {
      const attempt = state.attempts?.find(item => item.callID === call.callId && item.childSessionID === child.id &&
        item.runID === state.runID && ["implementation", "normal_remediation"].includes(item.kind));
      if (!attempt) return;
      if (state.codexOwner?.generation !== this.owner.generation || state.codexOwner.closed) throw new Error("codex-mission-dispatch-owner-stale");
      attempt.codexDispatch = { missionID: state.id, runID: attempt.runID, unitID: attempt.unitID,
        threadID: call.threadId, turnID: call.turnId, callID: call.callId,
        inputHash: createHash("sha256").update(JSON.stringify(call.arguments)).digest("hex"),
        childThreadID: child.id, clientUserMessageID: messageID, ownerGeneration: this.owner.generation };
    });
  }

  private async recoverCompletedWorker(host: CodexAppServerHost, threadID: string, parentTurn: JsonObject, item: JsonObject): Promise<JsonObject | undefined> {
    if (item.tool !== "task" || !object(item.arguments) || item.arguments.task_id || item.arguments.subagent_type !== "dog-worker-v010" ||
        typeof item.id !== "string" || typeof parentTurn.id !== "string" || !["completed", "interrupted", "failed"].includes(String(parentTurn.status))) return undefined;
    const inputHash = createHash("sha256").update(JSON.stringify(item.arguments)).digest("hex");
    const matches = (binding: CodexWorkerDispatch) => binding.threadID === threadID && binding.turnID === parentTurn.id &&
      binding.callID === item.id && binding.inputHash === inputHash;
    const missions = new OperatorMissionRuntime(this.directory, profile);
    for (const state of (await missions.current()).filter(state => state.executionHost === "codex")) {
      const saved = state.codexCompletedTasks?.find(proof => matches(proof.dispatch));
      const attempt = state.attempts?.find(attempt => attempt.codexDispatch && matches(attempt.codexDispatch));
      const binding = saved?.dispatch ?? attempt?.codexDispatch;
      if (!binding || binding.childThreadID === threadID) continue;
      if (!saved) {
        if (state.id !== binding.missionID || state.runID !== binding.runID || state.codexOwner?.generation !== binding.ownerGeneration ||
            !await codexOwnerGone(state.codexOwner)) continue;
        const run = await new OperatorRuntime(this.directory, profile).read(state.root);
        const unit = run?.units.find(unit => unit.unit.id === binding.unitID && unit.callID === binding.callID && unit.childSessionID === binding.childThreadID);
        if (run?.runID !== binding.runID || (run.operatorSessionID ?? state.root) !== threadID || !unit ||
            !new OperatorRuntime(this.directory, profile).matchesRecordedWorkerTask(run, unit.unit.id, item.arguments)) continue;
      }
      const child = await host.readThread(binding.childThreadID);
      // Initial recovery supports a newly-created leaf Worker only. No later request or untracked native child can borrow its completion.
      if (child.id !== binding.childThreadID || typeof child.cwd !== "string" || resolve(child.cwd) !== this.directory ||
          !Array.isArray(child.turns) || child.turns.length !== 1 || !object(child.turns[0])) continue;
      const turn = child.turns[0];
      if (turn.status !== "completed" || turn.itemsView !== "full" || typeof turn.id !== "string" || !Array.isArray(turn.items) ||
          saved && saved.childTurnID !== turn.id) continue;
      const items = turn.items.filter(object);
      const users = items.filter(entry => entry.type === "userMessage");
      if (users.length !== 1 || users[0]!.clientId !== binding.clientUserMessageID) continue;
      if (items.length !== turn.items.length || items.some(entry => {
        if (["userMessage", "agentMessage", "reasoning", "plan"].includes(String(entry.type))) return false;
        if (entry.type === "dynamicToolCall") return entry.status !== "completed" || entry.tool === "task";
        if (["commandExecution", "fileChange", "mcpToolCall"].includes(String(entry.type)))
          return !["completed", "failed", "declined"].includes(String(entry.status));
        return true;
      })) continue;
      const final = items.filter(entry => entry.type === "agentMessage" && (entry.phase == null || entry.phase === "final_answer")).at(-1);
      if (!saved) await missions.codexRecovery(state.root, async current => {
        if (current.id !== binding.missionID || current.runID !== binding.runID || current.codexOwner?.generation !== binding.ownerGeneration ||
            !await codexOwnerGone(current.codexOwner) || !current.attempts?.some(attempt =>
              attempt.codexDispatch && JSON.stringify(attempt.codexDispatch) === JSON.stringify(binding)))
          throw new Error("codex-mission-recovery-generation-stale");
        if (!current.codexCompletedTasks?.some(proof => matches(proof.dispatch))) await missions.update(current.root, value => {
          (value.codexCompletedTasks ??= []).push({ dispatch: binding, childTurnID: String(turn.id) });
        });
      });
      return { output: typeof final?.text === "string" ? final.text : "", metadata: {
        sessionId: binding.childThreadID, status: "completed", codex_completed_turn: turn.id } };
    }
    return undefined;
  }

  private required(id: string): NativeSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown native Codex session: ${id}`);
    return session;
  }

  private async executeHostCommand(request: CodexMissionCommandRequest): Promise<CodexMissionCommandResult> {
    const signal = request.signal;
    if (signal.aborted) throw new Error("Host execution interrupted; completion is unknown.");
    let abort: () => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Host execution interrupted; completion is unknown."));
      signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([this.options.executeCommand!(request), stopped]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  private createHost(): CodexAppServerHost {
    if (this.closed) throw new Error("Codex Mission adapter is closed.");
    const host = new CodexAppServerHost(this.options.transportFactory?.() ?? createCodexAppServerTransport({ cwd: this.directory, executable: this.options.executable }), {
      approval: async request => {
        await this.options.onEvent?.({ ...request, threadId: String(request.params.threadId),
          params: { ...request.params, hostApprovalAvailable: !!this.options.approval } });
        return await this.options.approval?.(request) ?? "decline";
      },
      permissionsApproval: async request => {
        await this.options.onEvent?.({ ...request, threadId: String(request.params.threadId),
          params: { ...request.params, hostApprovalAvailable: !!this.options.permissionsApproval } });
        return await this.options.permissionsApproval?.(request) ?? { permissions: {}, scope: "turn" };
      },
      dynamicTool: call => {
        const execution = (this.toolQueues.get(call.threadId) ?? Promise.resolve()).catch(() => undefined).then(() => this.execute(call));
        this.toolQueues.set(call.threadId, execution);
        return execution;
      },
    });
    this.hosts.add(host);
    return host;
  }

  private modelRoute(agent: string, stored?: NativeSession["model"], selection?: { model?: string; variant?: string }): NativeSession["model"] {
    const content = runtimeAssets.find(asset => asset.name === agent)?.content;
    const header = content?.split("---")[1] ?? "";
    const selected = this.options.roleModels?.[agent]?.model || this.options.model || selection?.model ||
      (stored ? `${stored.providerID}/${stored.modelID}` : /^model: (.+)$/m.exec(header)?.[1]);
    const [model, embeddedEffort] = (selected ?? "").replace(/^openai\//, "").split("#");
    if (!model || model.includes("/")) throw new Error(`Codex Mission requires an OpenAI model for ${agent}. Set model or roleModels explicitly.`);
    const effort = this.options.roleModels?.[agent]?.effort || this.options.effort || selection?.variant || embeddedEffort ||
      stored?.variant || /^variant: (.+)$/m.exec(header)?.[1];
    return { providerID: "openai", modelID: model, ...(effort ? { variant: effort } : {}) };
  }

  private async createSession(agent: string, parentID?: string, selection?: { model?: string; variant?: string }): Promise<NativeSession> {
    if (this.closed) throw new Error("Codex Mission adapter is closed.");
    const content = runtimeAssets.find(asset => asset.name === agent)?.content;
    if (!content) throw new Error(`Codex Mission role not supported: ${agent}`);
    const route = this.modelRoute(agent, undefined, selection);
    const model = route.modelID, effort = route.variant;
    const host = this.createHost();
    try {
      const auth = await host.authenticationState();
      if (auth.type !== "chatgpt") throw new Error("Codex Mission requires existing ChatGPT authentication.");
      const thread = await host.startThread({ cwd: this.directory, model, ephemeral: false,
        developerInstructions: content.replace(/^---\n[\s\S]*?\n---\n/, "") +
          "\nHost transport: use the supplied bash/read/write/task functions and sortie tools. They invoke the existing Mission hooks. " +
          "Use task to run or resume the returned native Task with its exact prompt and subagent_type. Tool failures are feedback for the same Mission. " +
          "Native shell and file operations outside these functions do not provide Mission validation evidence. " +
          "Declare formal validation as exact executable shell commands from the project root, without prose annotations such as (workdir: ...). " +
          "Use a root-relative command or an explicit shell cd for a subdirectory formal check. bash workdir changes that invocation only; " +
          "a command run in another directory does not validate a root-directory entry.",
        dynamicTools: this.tools(content), config: { "features.shell_tool": false, "features.unified_exec": false } });
      if (this.closed) throw new Error("Codex Mission adapter is closed.");
      const session: NativeSession = { id: thread, agent, parentID, outcome: "idle", host, history: [], usageBaseline: emptyCodexUsage(), createdAt: Date.now(),
        model: { providerID: "openai", modelID: host.threadModel(thread) ?? model, ...(effort ? { variant: effort } : {}) } };
      this.sessions.set(thread, session);
      return session;
    } catch (error) { await host.close(); throw error; }
  }

  private async restoreSession(id: string, agent: string, parentID?: string): Promise<NativeSession> {
    if (this.sessions.has(id)) return this.required(id);
    const host = this.createHost();
    try {
      if ((await host.authenticationState()).type !== "chatgpt") throw new Error("Codex Mission requires existing ChatGPT authentication.");
      const thread = await host.readThread(id);
      if (typeof thread.cwd !== "string" || resolve(thread.cwd) !== this.directory || !Array.isArray(thread.turns))
        throw new Error(`Codex thread ${id} has no matching repository history.`);
      const turns = thread.turns.filter(object);
      for (const turn of turns) {
        if (!Array.isArray(turn.items) || turn.status === "inProgress" || turn.itemsView !== "full")
          throw new Error(`Codex thread ${id} still has unproven execution; no resend. Reconcile its native execution before resuming.`);
        for (const item of turn.items.filter(object)) {
          // A terminal parent turn does not prove that its native executions or children stopped.
          if (item.type === "collabAgentToolCall" ||
              ["commandExecution", "fileChange", "mcpToolCall"].includes(String(item.type)) &&
              !["completed", "failed", ...(item.type === "mcpToolCall" ? [] : ["declined"])].includes(String(item.status)))
            throw new Error(`Codex thread ${id} has an unresolved native execution; no resend. Reconcile its native execution before resuming.`);
          if (item.type !== "dynamicToolCall" || item.status === "completed" && (turn.status === "completed" || item.success === true)) continue;
          const unique = turns.flatMap(entry => Array.isArray(entry.items) ? entry.items.filter(object) : []).filter(entry => entry.id === item.id).length === 1;
          if (!unique) throw new Error(`Codex thread ${id} has an unresolved tool execution; no resend.`);
          if (await this.recoverNotStarted(id, turn, item)) {
            Object.assign(item, { status: "completed", success: false, contentItems: [{ type: "inputText", text: JSON.stringify({
              output: "Host reconciled this exact Task as not started; no native child was dispatched.", metadata: { status: "error", codex_not_started: true } }) }] });
          } else {
            const recovered = await this.recoverCompletedWorker(host, id, turn, item);
            if (!recovered) throw new Error(`Codex thread ${id} has an unresolved tool execution; no resend.`);
            Object.assign(item, { status: "completed", success: true, contentItems: [{ type: "inputText", text: JSON.stringify(recovered) }] });
          }
        }
      }
      await host.resumeThread(id);
      const session: NativeSession = { id, agent, parentID, outcome: turns.at(-1)?.status === "completed" ? "succeeded" : "interrupted", host, history: [], createdAt: codexNativeTime(thread.createdAt),
        model: this.modelRoute(agent, { providerID: String(thread.modelProvider), modelID: typeof thread.model === "string" ? thread.model : "unknown",
          ...(typeof thread.reasoningEffort === "string" ? { variant: thread.reasoningEffort } : {}) }) };
      const lastUsage = this.observations.find(item => item.threadID === id && item.turnID === turns.at(-1)?.id && item.terminal);
      session.usageBaseline = codexUsageTotal(lastUsage?.total);
      if (lastUsage?.total) session.usage = { total: lastUsage.total };
      this.sessions.set(id, session);
      for (const turn of turns) {
        for (const item of (turn.items as unknown[]).filter(object)) {
          if (item.type === "userMessage" && Array.isArray(item.content)) {
            session.history.push({ info: { id: item.clientId ?? item.id, role: "user", sessionID: id, agent, model: session.model },
              parts: item.content.filter(object).filter(part => part.type === "text").map(part => ({ type: "text", text: part.text })) });
          } else if (item.type === "dynamicToolCall" && typeof item.tool === "string" && object(item.arguments) && Array.isArray(item.contentItems)) {
            const source = item.contentItems.filter(object).find(part => part.type === "inputText");
            let result: JsonObject | undefined;
            try { const value: unknown = JSON.parse(String(source?.text)); if (object(value)) result = value; } catch { /* A declined call has no completed native tool receipt. */ }
            const metadata = object(result?.metadata) ? result.metadata : {};
            session.history.push({ info: { id: item.id, role: "assistant", sessionID: id, codexToolReceipt: true,
              codexControlReceipt: item.tool.startsWith("sortie_"),
              ...(object(metadata.sortie_execution) ? { time: { created: metadata.sortie_execution.start, completed: metadata.sortie_execution.end } } : {}) }, parts: [{ type: "tool", tool: item.tool, callID: item.id,
              state: { status: item.success === true ? "completed" : "error", input: item.arguments, output: result?.output, metadata,
                ...(object(metadata.sortie_execution) ? { time: metadata.sortie_execution } : {}) } }] });
            if (item.tool === "task" && typeof metadata.sessionId === "string" && typeof item.arguments.subagent_type === "string")
              await this.restoreSession(metadata.sessionId, item.arguments.subagent_type, id);
          }
        }
        const final = (turn.items as unknown[]).filter(object).filter(item => item.type === "agentMessage" &&
          (item.phase == null || item.phase === "final_answer")).at(-1);
        const observation = this.observations.find(item => item.threadID === id && item.turnID === turn.id && item.terminal);
        session.history.push({ info: { ...(observation ? codexUsageInfo(observation) : { id: turn.id, role: "assistant", sessionID: id, agent,
          providerID: session.model.providerID, modelID: session.model.modelID, billingMode: "chatgpt", usageGranularity: "native-turn" }),
          finish: turn.status === "completed" ? "stop" : "error", ...(turn.error ? { error: turn.error } : {}),
          time: { created: codexNativeTime(turn.startedAt) ?? observation?.startedAt, completed: codexNativeTime(turn.completedAt) ?? observation?.updatedAt } },
          parts: [{ type: "text", text: final?.text ?? "" }] });
      }
      return session;
    } catch (error) { await host.close(); throw error; }
  }

  private tools(content: string): CodexDynamicTool[] {
    const declared = new Set([...content.split("---")[1].matchAll(/^  (sortie_[a-z0-9_]+): true$/gm)].map(match => match[1]));
    const tools = Object.entries(this.hooks.tool ?? {}).filter(([name]) => declared.has(name)).map(([name, tool]) => ({ type: "function" as const, name,
      description: tool.description, inputSchema: toolSchema(tool.args) }));
    const define = (name: string, description: string, properties: JsonObject, required = Object.keys(properties)): CodexDynamicTool =>
      ({ type: "function", name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
    const string = { type: "string" };
    tools.push(define("bash", "Run a foreground command through the native Codex sandbox. Preserve formal validation commands exactly.",
      { command: string, workdir: string, timeout: { type: "integer", minimum: 1, maximum: 1200000 } }, ["command"]));
    tools.push(define("read", "Read a UTF-8 file through the native Codex sandbox.", { filePath: string }));
    tools.push(define("write", "Write a UTF-8 file through the native Codex sandbox.", { filePath: string, content: string }));
    tools.push(define("task", "Run a returned Mission Task, or resume its existing task_id. Preserve the host's prompt and subagent_type.",
      { description: string, prompt: string, subagent_type: string, task_id: string, model: string, variant: string }, ["description", "prompt", "subagent_type"]));
    return tools;
  }

  private async prompt(session: NativeSession, prompt: string, onDispatch?: (messageID: string) => Promise<void>): Promise<CodexTurnResult> {
    const startedAt = Date.now();
    const messageID = randomUUID();
    const message = { id: messageID, agent: session.agent, model: { ...session.model } };
    const parts = [{ type: "text", text: prompt }];
    await this.hooks["chat.message"]?.({ sessionID: session.id, messageID, agent: session.agent }, { message, parts });
    // Shared Task routing may select a model; explicit adapter overrides still govern every native turn.
    if (this.options.model || this.options.effort || this.options.roleModels?.[session.agent])
      message.model = this.modelRoute(session.agent, message.model);
    if (message.model.providerID !== "openai") throw new Error("Codex Mission cannot use a non-OpenAI model route.");
    session.model = message.model;
    session.history.push({ info: { ...message, role: "user", sessionID: session.id }, parts });
    session.outcome = "running";
    const observation: CodexUsageObservation = { threadID: session.id, turnID: messageID, startedAt, updatedAt: startedAt,
      agent: session.agent, model: { ...session.model }, baseline: session.usageBaseline };
    const accounting: JsonObject = { info: { ...codexUsageInfo(observation), time: { created: startedAt } }, parts: [] };
    session.history.push(accounting);
    try {
      await onDispatch?.(messageID);
      const result = await session.host.runTurn(session.id, parts.map(part => part.text).join("\n"), { cwd: this.directory, clientUserMessageId: messageID,
        model: message.model.modelID === "unknown" ? undefined : message.model.modelID, effort: message.model.variant ?? this.options.effort,
        onEvent: event => {
          if (event.method === "thread/tokenUsage/updated" && object(event.params.tokenUsage)) {
            observation.turnID = typeof event.params.turnId === "string" ? event.params.turnId : observation.turnID;
            observation.total = codexUsageTotal(event.params.tokenUsage.total);
            observation.updatedAt = Date.now();
            accounting.info = codexUsageInfo(observation);
          }
          return this.options.onEvent?.({ ...event, threadId: session.id });
        } });
      session.outcome = result.status === "completed" ? "succeeded" : result.status;
      session.usage = result.usage;
      observation.turnID = result.turnID;
      observation.total = codexUsageTotal(result.usage?.total);
      observation.updatedAt = Date.now(); observation.terminal = true;
      session.usageBaseline = observation.total;
      accounting.info = { ...codexUsageInfo(observation), finish: result.status === "completed" ? "stop" : "error",
        ...(result.status === "completed" ? {} : { error: { name: result.status } }) };
      accounting.parts = [{ type: "text", text: result.finalResponse ?? "" }];
      session.history.splice(session.history.indexOf(accounting), 1); session.history.push(accounting);
      this.observations = this.observations.filter(item => item.threadID !== session.id || item.turnID !== result.turnID);
      this.observations.push(observation);
      const root = this.rootOf(session), missions = new OperatorMissionRuntime(this.directory, profile);
      if (await missions.read(root)) await missions.update(root, state => {
        state.codexUsage = this.observations;
      });
      return result;
    } catch (error) { session.outcome = "unknown"; throw error; }
  }

  private async execute(call: CodexDynamicToolCall): Promise<string> {
    if (this.closed) throw new Error("Codex Mission adapter is closed.");
    const session = this.required(call.threadId);
    const definition = this.hooks.tool?.[call.tool];
    if (definition) {
      const result = await definition.execute(legacyToolArgs(call.arguments, definition.args), { sessionID: session.id, agent: session.agent });
      await this.claimOwner(this.rootOf(session));
      return result;
    }
    if (!["bash", "read", "write", "task"].includes(call.tool) || !object(call.arguments)) throw new Error("Unsupported Codex Mission tool.");
    await this.claimOwner(this.rootOf(session));
    const output = { args: { ...call.arguments } };
    await this.hooks["tool.execute.before"]?.({ tool: call.tool, sessionID: session.id, callID: call.callId }, output);
    const args = output.args;
    const start = Date.now();
    const cwd = call.tool === "bash" && typeof args.workdir === "string" ? resolve(this.directory, args.workdir) : this.directory;
    let text: string;
    let dispatched = false;
    let child: NativeSession | undefined;
    let metadata: JsonObject;
    try {
    if (call.tool === "task") {
      child = typeof args.task_id === "string" && args.task_id ? this.required(args.task_id) : undefined;
      if (child && (child.parentID !== session.id || child.agent !== args.subagent_type)) throw new Error("Task resume lineage mismatch.");
      child ??= await this.createSession(String(args.subagent_type), session.id, {
        ...(typeof args.model === "string" ? { model: args.model } : {}), ...(typeof args.variant === "string" ? { variant: args.variant } : {}) });
      await this.hooks["tool.execute.after"]?.({ tool: call.tool, sessionID: session.id, callID: call.callId, args },
        { output: "", metadata: { sessionId: child.id, status: "running" } });
      const result = await this.prompt(child, String(args.prompt), async messageID => {
        await this.bindWorkerDispatch(session, child!, call, messageID);
        dispatched = true;
      });
      text = result.finalResponse ?? "";
      metadata = { sessionId: child.id, status: result.status };
    } else {
      const command = call.tool === "bash" ? ["/bin/bash", "-c", String(args.command)]
        : call.tool === "read" ? [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))", resolve(this.directory, String(args.filePath))]
        : [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", resolve(this.directory, String(args.filePath)), String(args.content)];
      const executor = this.options.executeCommand ? "host" : "native";
      await this.options.onEvent?.({ method: "sortie/commandExecution", threadId: session.id,
        params: { turnId: call.turnId, callId: call.callId, tool: call.tool, executor, cwd, status: "started" } });
      if (this.closed) throw new Error("Codex Mission adapter is closed; command was not started.");
      dispatched = true;
      const timeoutMs = typeof args.timeout === "number" ? args.timeout : 120_000;
      const result: CodexMissionCommandResult = this.options.executeCommand
        ? await this.executeHostCommand({ tool: call.tool as CodexMissionCommandRequest["tool"], command, cwd, timeoutMs,
          threadId: session.id, turnId: call.turnId, callId: call.callId, signal: this.executionAbort.signal })
        : { status: "completed", ...await session.host.executeCommand(command, cwd, timeoutMs) };
      if (this.closed || this.executionAbort.signal.aborted) throw new Error("Host execution interrupted; completion is unknown.");
      if (result.status === "denied" || result.status === "not-started") {
        dispatched = false; // Explicit host proof that no command ran; there is no exit or validation result.
        throw new Error(`Host command ${result.status}: ${result.reason}`);
      }
      if (result.status !== "completed") throw new Error(`Host command ${result.status}: ${result.reason}; completion is unknown.`);
      if (!Number.isSafeInteger(result.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string")
        throw new Error("Host executor returned no authoritative command result; completion is unknown.");
      text = result.stdout + result.stderr;
      metadata = { exit: result.exitCode, status: "completed", executor, cwd };
    }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (call.tool !== "task") {
        try { await this.options.onEvent?.({ method: "sortie/commandExecution", threadId: session.id,
          params: { turnId: call.turnId, callId: call.callId, tool: call.tool,
            executor: this.options.executeCommand ? "host" : "native", cwd, status: dispatched ? "unknown" : "not-started", reason } }); }
        catch { /* Progress failure cannot suppress execution reconciliation. */ }
      }
      session.history.push({ info: { id: call.callId, role: "assistant", sessionID: session.id, codexToolReceipt: true }, parts: [{ type: "tool", tool: call.tool,
        callID: call.callId, state: { status: dispatched ? "running" : "error", input: args, error: reason,
          metadata: { status: dispatched ? "running" : "error", ...(child ? { sessionId: child.id } : {}) },
          time: { start, ...(dispatched ? {} : { end: Date.now() }) } } }] });
      if (!dispatched) {
        if (call.tool === "task" && !args.task_id) {
          const root = this.rootOf(session), missions = new OperatorMissionRuntime(this.directory, profile);
          await missions.update(root, current => {
            const proof: CodexNotStartedProof = { missionID: current.id, threadID: call.threadId, turnID: call.turnId,
              callID: call.callId, inputHash: createHash("sha256").update(JSON.stringify(call.arguments)).digest("hex"),
              ownerGeneration: this.owner.generation };
            if (!current.codexNotStarted?.some(item => item.callID === proof.callID && item.turnID === proof.turnID && item.threadID === proof.threadID))
              (current.codexNotStarted ??= []).push(proof);
          });
        }
        if (child) child.outcome = "failed";
        await this.hooks["tool.execute.after"]?.({ tool: call.tool, sessionID: session.id, callID: call.callId, args },
          { status: "error", output: reason, metadata: { status: "error", ...(child ? { sessionId: child.id } : {}) } });
      }
      // A lost transport after dispatch does not prove an external executor stopped.
      // Stop the whole adapter so the model cannot resend that unknown operation.
      if (dispatched) await this.stopHosts().catch(() => undefined);
      throw error;
    }
    const time = { start, end: Date.now() };
    metadata.sortie_execution = time;
    session.history.push({ info: { id: call.callId, role: "assistant", sessionID: session.id, codexToolReceipt: true,
      time: { created: time.start, completed: time.end } }, parts: [{ type: "tool", tool: call.tool,
      callID: call.callId, state: { status: "completed", input: args, output: text, metadata, time } }] });
    const after = { output: text, metadata };
    await this.hooks["tool.execute.after"]?.({ tool: call.tool, sessionID: session.id, callID: call.callId, args }, after);
    return JSON.stringify({ output: after.output, metadata: { ...(object(after.metadata) ? after.metadata : {}), sortie_execution: time } });
  }
}
