import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { terminateTree } from "../core/worktree-commit-artifact.js";

type JsonObject = Record<string, unknown>;

const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

export interface CodexAppServerTransport {
  readonly messages: AsyncIterable<unknown>;
  send(message: JsonObject): void;
  close(): Promise<void>;
}

export interface CodexAppServerProcessOptions {
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Start the official Codex app-server over its stable stdio JSONL transport. */
export function createCodexAppServerTransport(options: CodexAppServerProcessOptions = {}): CodexAppServerTransport {
  const child: ChildProcessWithoutNullStreams = spawn(options.executable ?? "codex", ["app-server", "--listen", "stdio://", ...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "";
  let spawnFailure: Error | undefined;
  child.on("error", error => { spawnFailure = error; });
  child.stdin.on("error", error => { spawnFailure ??= error; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-16_384); });
  async function* messages(): AsyncIterable<unknown> {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      try { yield JSON.parse(line); }
      catch (cause) { throw new CodexHostError("protocol-invalid-json", `Codex app-server emitted invalid JSON: ${line.slice(0, 200)}`, cause); }
    }
    if (spawnFailure) throw new CodexHostError("server-exited", `Unable to start Codex app-server: ${spawnFailure.message}`, spawnFailure);
    const exit = child.exitCode;
    if (exit !== 0) throw new CodexHostError("server-exited", `Codex app-server exited with ${exit ?? "unknown"}: ${stderr.trim()}`);
  }
  return {
    messages: messages(),
    send(message) {
      if (!child.stdin.writable) throw new CodexHostError("server-closed", "Codex app-server stdin is closed.");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      lines.close();
      if (child.pid !== undefined && process.platform !== "win32") await terminateTree(child, exited);
      else {
        if (child.exitCode === null && !child.killed) child.kill();
        if (child.exitCode === null && !spawnFailure) await exited;
      }
    },
  };
}

export type CodexHostErrorCode = "protocol-invalid-json" | "protocol-invalid-response" | "request-failed" |
  "server-closed" | "server-exited" | "turn-active" | "turn-not-active";

export class CodexHostError extends Error {
  readonly code: CodexHostErrorCode;
  constructor(code: CodexHostErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodexHostError";
    this.code = code;
  }
}

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export interface CodexApprovalRequest { readonly method: string; readonly params: JsonObject; }
export type CodexApprovalHandler = (request: CodexApprovalRequest) => Promise<CodexApprovalDecision> | CodexApprovalDecision;

export interface CodexTurnEvent {
  readonly method: string;
  readonly params: JsonObject;
}

export interface CodexTurnOptions {
  readonly cwd: string;
  readonly clientUserMessageId?: string;
  readonly sandboxPolicy?: JsonObject;
  readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | "unlessTrusted" | "onRequest";
  readonly model?: string;
  readonly effort?: string;
  readonly outputSchema?: JsonObject;
  readonly onEvent?: (event: CodexTurnEvent) => void | Promise<void>;
}

export interface CodexTurnResult {
  readonly threadID: string;
  readonly turnID: string;
  readonly status: string;
  readonly finalResponse?: string;
  readonly items: readonly JsonObject[];
  readonly usage?: JsonObject;
}

export interface CodexAuthenticationState {
  readonly type: string | null;
  readonly planType?: string;
  readonly requiresOpenaiAuth: boolean;
}

export interface CodexDynamicTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface CodexDynamicToolCall {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
}

export interface CodexAppServerHostOptions {
  readonly dynamicTool?: (call: CodexDynamicToolCall) => Promise<string>;
  readonly approval?: CodexApprovalHandler;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest { resolve(value: unknown): void; reject(reason: unknown): void; timer: NodeJS.Timeout; }
interface ActiveTurn {
  threadID: string;
  turnID: string;
  items: JsonObject[];
  finalResponse?: string;
  usage?: JsonObject;
  observerError?: unknown;
  observer: Promise<void>;
  completing?: boolean;
  onEvent?: CodexTurnOptions["onEvent"];
  resolve(result: CodexTurnResult): void;
  reject(reason: unknown): void;
}

/**
 * Codex host boundary for Sortie orchestration. It transports threads, turns,
 * authoritative completed items, interruption and approvals. Sortie's core
 * contracts remain host-neutral and are not duplicated here.
 */
export class CodexAppServerHost {
  private nextID = 1;
  private initialized = false;
  private readonly models = new Map<string, string>();
  private closed = false;
  private closing?: Promise<void>;
  private fault?: unknown;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationBacklog: { method: string; params: JsonObject }[] = [];
  private active?: ActiveTurn;
  private readonly pump: Promise<void>;
  private readonly transport: CodexAppServerTransport;
  private readonly options: CodexAppServerHostOptions;

  constructor(transport: CodexAppServerTransport, options: CodexAppServerHostOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.pump = this.readMessages();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", { clientInfo: { name: "sortie_dogs", title: "Sortie-dogs", version: this.options.clientVersion ?? "0.13.8" },
      ...(this.options.dynamicTool ? { capabilities: { experimentalApi: true } } : {}) });
    this.transport.send({ method: "initialized", params: {} });
    this.initialized = true;
  }

  async startThread(params: { cwd: string; model?: string; ephemeral?: boolean; developerInstructions?: string; dynamicTools?: readonly CodexDynamicTool[]; config?: JsonObject } ): Promise<string> {
    await this.initialize();
    const result = await this.request("thread/start", { cwd: params.cwd, ...(params.model ? { model: params.model, allowProviderModelFallback: false } : {}),
      ...(params.ephemeral === undefined ? {} : { ephemeral: params.ephemeral }),
      ...(params.developerInstructions ? { developerInstructions: params.developerInstructions } : {}),
      ...(params.dynamicTools ? { dynamicTools: params.dynamicTools } : {}),
      ...(params.config ? { config: params.config } : {}) });
    const id = object(result) && object(result.thread) ? text(result.thread.id) : undefined;
    if (!id) throw new CodexHostError("protocol-invalid-response", "thread/start returned no thread id.");
    if (object(result) && typeof result.model === "string") this.models.set(id, result.model);
    return id;
  }

  threadModel(threadID: string): string | undefined { return this.models.get(threadID); }

  /** Read only the authentication mode and plan class; never expose tokens or account identifiers. */
  async authenticationState(): Promise<CodexAuthenticationState> {
    await this.initialize();
    const result = await this.request("account/read", { refreshToken: false });
    if (!object(result)) throw new CodexHostError("protocol-invalid-response", "account/read returned an invalid response.");
    const account = object(result.account) ? result.account : undefined;
    const planType = account ? text(account.planType) : undefined;
    return { type: account ? text(account.type) ?? "unknown" : null, ...(planType ? { planType } : {}),
      requiresOpenaiAuth: result.requiresOpenaiAuth === true };
  }

  async readThread(threadID: string): Promise<JsonObject> {
    await this.initialize();
    const result = await this.request("thread/read", { threadId: threadID, includeTurns: true });
    if (!object(result) || !object(result.thread) || result.thread.id !== threadID)
      throw new CodexHostError("protocol-invalid-response", "thread/read returned an invalid thread.");
    return result.thread;
  }

  async resumeThread(threadID: string): Promise<void> {
    await this.initialize();
    const result = await this.request("thread/resume", { threadId: threadID });
    const id = object(result) && object(result.thread) ? text(result.thread.id) : undefined;
    if (id !== threadID) throw new CodexHostError("protocol-invalid-response", "thread/resume returned a different thread id.");
  }

  async runTurn(threadID: string, prompt: string, options: CodexTurnOptions): Promise<CodexTurnResult> {
    await this.initialize();
    if (this.active) throw new CodexHostError("turn-active", "This host already has an active turn.");
    const started = await this.request("turn/start", { threadId: threadID, input: [{ type: "text", text: prompt }], cwd: options.cwd,
      ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
      ...(options.sandboxPolicy ? { sandboxPolicy: options.sandboxPolicy } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}) });
    if (this.closed) throw new CodexHostError("server-closed", "Codex host was closed.");
    const turnID = object(started) && object(started.turn) ? text(started.turn.id) : undefined;
    if (!turnID) throw new CodexHostError("protocol-invalid-response", "turn/start returned no turn id.");
    return new Promise<CodexTurnResult>((resolve, reject) => {
      this.active = { threadID, turnID, items: [], observer: Promise.resolve(), onEvent: options.onEvent, resolve, reject };
      const backlog = this.notificationBacklog.splice(0);
      void backlog.reduce((prior, event) => prior.then(() => this.notification(event.method, event.params)), Promise.resolve())
        .catch(error => { this.active?.reject(error); this.active = undefined; });
    });
  }

  /** Execute through Codex's configured native sandbox, without overriding permissions. */
  async executeCommand(command: readonly string[], cwd: string, timeoutMs = 120_000, sandboxPolicy?: JsonObject): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.initialize();
    const result = await this.request("command/exec", { command, cwd, timeoutMs, ...(sandboxPolicy ? { sandboxPolicy } : {}) }, timeoutMs + 30_000);
    if (!object(result) || typeof result.exitCode !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string")
      throw new CodexHostError("protocol-invalid-response", "command/exec returned an invalid result.");
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async interrupt(): Promise<void> {
    if (!this.active) throw new CodexHostError("turn-not-active", "There is no active turn to interrupt.");
    await this.request("turn/interrupt", { threadId: this.active.threadID, turnId: this.active.turnID });
  }

  close(): Promise<void> {
    return this.closing ??= this.closeHost();
  }

  private async closeHost(): Promise<void> {
    this.closed = true;
    const error = new CodexHostError("server-closed", "Codex host was closed.");
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.active?.reject(error);
    this.active = undefined;
    await this.transport.close();
    await this.pump.catch(() => undefined);
  }

  private request(method: string, params: JsonObject, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexHostError("server-closed", "Codex host is closed."));
    if (this.fault) return Promise.reject(this.fault);
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexHostError("request-failed", `${method} response timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ method, id, params });
    });
  }

  private async readMessages(): Promise<void> {
    try {
      for await (const raw of this.transport.messages) {
        if (!object(raw)) throw new CodexHostError("protocol-invalid-response", "Codex app-server message is not an object.");
        if (typeof raw.id === "number" && (Object.hasOwn(raw, "result") || Object.hasOwn(raw, "error")) && !raw.method) {
          const pending = this.pending.get(raw.id);
          if (!pending) continue;
          this.pending.delete(raw.id);
          clearTimeout(pending.timer);
          if (raw.error !== undefined) pending.reject(new CodexHostError("request-failed", JSON.stringify(raw.error)));
          else pending.resolve(raw.result);
          continue;
        }
        if ((typeof raw.id === "number" || typeof raw.id === "string") && typeof raw.method === "string") {
          // A dynamic tool may call command/exec on this connection. Keep reading its response.
          void this.answerServerRequest(raw).catch(error => {
            if (!this.closed) { this.active?.reject(error); this.active = undefined; }
          });
          continue;
        }
        if (typeof raw.method === "string") await this.notification(raw.method, object(raw.params) ? raw.params : {});
      }
      if (!this.closed) throw new CodexHostError("server-closed", "Codex app-server message stream ended.");
    } catch (error) {
      this.fault = error;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      this.active?.reject(error);
      this.active = undefined;
    }
  }

  private async answerServerRequest(message: JsonObject): Promise<void> {
    if (this.closed) return;
    const method = String(message.method);
    const params = object(message.params) ? message.params : {};
    if (method === "item/tool/call") {
      const active = this.active;
      let result: { contentItems: { type: "inputText"; text: string }[]; success: boolean };
      try {
        if (!active || active.completing || params.threadId !== active.threadID || params.turnId !== active.turnID ||
            (params.namespace != null) || typeof params.callId !== "string" || typeof params.tool !== "string" || !this.options.dynamicTool)
          throw new Error("Dynamic tool call does not belong to an active Sortie turn.");
        const output = await this.options.dynamicTool({ threadId: active.threadID, turnId: active.turnID,
          callId: params.callId, tool: params.tool, arguments: params.arguments });
        result = { contentItems: [{ type: "inputText", text: output }], success: true };
      } catch (error) {
        result = { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : "Dynamic tool failed." }], success: false };
      }
      if (!this.closed) this.transport.send({ id: message.id, result });
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      let decision: CodexApprovalDecision = "decline";
      const active = this.active;
      const inScope = active !== undefined && params.threadId === active.threadID && params.turnId === active.turnID;
      try { if (inScope) decision = await this.options.approval?.({ method, params }) ?? "decline"; }
      catch { /* Handler failure must decline this request without stopping the protocol pump. */ }
      if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes(decision)) decision = "decline";
      if (!this.closed) this.transport.send({ id: message.id, result: { decision } });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.transport.send({ id: message.id, result: { permissions: [], scope: "turn" } });
      return;
    }
    this.transport.send({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
  }

  private async notification(method: string, params: JsonObject): Promise<void> {
    const active = this.active;
    if (!active) {
      if (["item/started", "item/completed", "turn/completed", "thread/tokenUsage/updated"].includes(method)) {
        if (this.notificationBacklog.length >= 256) this.notificationBacklog.shift();
        this.notificationBacklog.push({ method, params });
      }
      return;
    }
    const threadID = text(params.threadId);
    const turn = object(params.turn) ? params.turn : undefined;
    const turnID = text(params.turnId) ?? (turn ? text(turn.id) : undefined);
    if (threadID && threadID !== active.threadID || turnID && turnID !== active.turnID) return;
    if (active.completing) return;
    if (active.onEvent) {
      active.observer = active.observer.then(() => active.onEvent!({ method, params }))
        .catch(error => { active.observerError ??= error; });
    }
    if (method === "thread/tokenUsage/updated") active.usage = object(params.tokenUsage) ? params.tokenUsage : params;
    if (method === "item/completed" && object(params.item)) {
      active.items.push(params.item);
      if (params.item.type === "agentMessage" && typeof params.item.text === "string" &&
          (params.item.phase == null || params.item.phase === "final_answer")) active.finalResponse = params.item.text;
    }
    if (method !== "turn/completed") return;
    active.completing = true;
    const status = turn ? text(turn.status) : text(params.status);
    const result: CodexTurnResult = { threadID: active.threadID, turnID: active.turnID, status: status ?? "unknown",
      ...(active.finalResponse ? { finalResponse: active.finalResponse } : {}), items: active.items,
      ...(active.usage ? { usage: active.usage } : {}) };
    // Do not block the protocol pump on observer work. Observers may issue host
    // requests such as interrupt(), whose response must be read by this pump.
    // Keep the completing turn active until observers settle so close() can
    // reject it and a later turn cannot receive an interrupt meant for it.
    void active.observer.then(() => {
      if (this.active !== active) return;
      this.active = undefined;
      if (active.observerError) active.reject(new CodexHostError("request-failed", "Codex turn event observer failed.", active.observerError));
      else active.resolve(result);
    });
  }
}
