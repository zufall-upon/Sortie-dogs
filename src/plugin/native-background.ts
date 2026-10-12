import type { OpenCodeV2Context } from "./v2.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const values = (value: unknown): ObjectValue[] => (Array.isArray(value) ? value : object(value) && Array.isArray(value.data) ? value.data : []).filter(object);
const key = (parent: string) => `v2-background-dispatches:${parent}`;
export interface NativeBackgroundDispatch {
  parent: string;
  callID: string;
  agent: string;
  input: ObjectValue;
  owner?: ObjectValue;
  child?: string;
  /** Native prompt identity distinguishes subsequent executions in the same child. */
  promptID?: string;
  baseline: string[];
  admittedAt: number;
  launched: boolean;
  terminal?: "succeeded" | "failed" | "interrupted";
  settled?: boolean;
  /** Host-reconciled output for this exact native invocation, not another completion prompt. */
  result?: string;
}

/** Lifecycle transport for native Jobs, not a scheduler. The host owns execution and wakeup. */
export class NativeBackgroundLifecycle {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly restored = new Set<string>();
  constructor(private readonly context: OpenCodeV2Context,
    private readonly settle: (dispatch: NativeBackgroundDispatch, text: string) => Promise<string | void>,
    private readonly owner?: (callID: string, restore?: ObjectValue) => ObjectValue | undefined,
    private readonly recoverResult?: (parent: string, callID: string, child: string, promptID?: string) => Promise<string | undefined>) {}
  private async serial<T>(parent: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(parent) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.operations.set(parent, next);
    try { return await next; } finally { if (this.operations.get(parent) === next) this.operations.delete(parent); }
  }
  private async read(parent: string): Promise<NativeBackgroundDispatch[]> {
    return (await this.context.storage?.get(key(parent)) as NativeBackgroundDispatch[] | undefined) ?? [];
  }
  private async write(parent: string, dispatches: NativeBackgroundDispatch[]): Promise<void> {
    if (!this.context.storage) throw new Error("native-background-storage-unavailable");
    await this.context.storage.set(key(parent), dispatches);
  }
  async admit(parent: string, callID: string, input: ObjectValue, owner?: ObjectValue): Promise<void> {
    await this.serial(parent, async () => {
      const dispatches = await this.read(parent);
      if (dispatches.some(item => item.callID === callID)) return;
      const child = typeof input.sessionID === "string" ? input.sessionID : undefined;
      const history = child ? values(await this.context.session.context({ sessionID: child })) : [];
      dispatches.push({ parent, callID, agent: String(input.agent), input: { ...input }, owner,
        ...(child ? { child } : {}), baseline: history.map(item => String(item.id)), admittedAt: Date.now(), launched: false });
      await this.write(parent, dispatches);
      this.restored.add(`${parent}\0${callID}`);
    });
  }
  async bind(parent: string, child: string, agent: string, prompt: string, promptID?: string): Promise<void> {
    await this.serial(parent, async () => {
      const dispatches = await this.read(parent);
      const dispatch = [...dispatches].reverse().find(item => !item.settled && item.agent === agent &&
        (!item.child || item.child === child) && item.input.prompt === prompt);
      if (!dispatch) return;
      dispatch.child = child;
      if (promptID) dispatch.promptID = promptID;
      await this.write(parent, dispatches);
    });
  }
  async launched(parent: string, callID: string, child: string | undefined, running: boolean): Promise<boolean> {
    return this.serial(parent, async () => {
      const dispatches = await this.read(parent), dispatch = dispatches.find(item => item.callID === callID);
      if (!dispatch) return false;
      if (!running) { dispatch.settled = true; await this.write(parent, dispatches); return false; }
      dispatch.launched = true;
      if (child) dispatch.child = child;
      await this.write(parent, dispatches);
      await this.reconcileInside(parent, dispatches);
      return true;
    });
  }
  async awaiting(sessionID: string): Promise<boolean> {
    if ((await this.read(sessionID)).some(item => !item.settled)) return true;
    const info = await this.context.session.get({ sessionID });
    return object(info) && typeof info.parentID === "string" &&
      (await this.read(info.parentID)).some(item => !item.settled && item.child === sessionID);
  }
  async reconcile(parent: string): Promise<void> {
    await this.serial(parent, async () => this.reconcileInside(parent, await this.read(parent)));
  }
  /** Add provenance beside its existing native notification, without editing history or waking the parent again. */
  async project(parent: string, messages: readonly unknown[]): Promise<unknown[]> {
    return this.serial(parent, async () => {
      const dispatches = await this.read(parent);
      if (!dispatches.some(item => item.settled && item.child && item.terminal)) return [...messages];
      const history = values(await this.context.session.context({ sessionID: parent }));
      const notifications = history.filter(item => item.type === "synthetic" && object(item.metadata) &&
        item.metadata.source === "subagent" && typeof item.text === "string" && object(item.time));
      const additions = new Map<string, { callID: string; text: string }>();
      let changed = false;
      for (const notification of notifications) {
        const metadata = notification.metadata as ObjectValue, time = notification.time as ObjectValue;
        const dispatch = [...dispatches].reverse().find(item => item.child === metadata.childID &&
          typeof time.created === "number" && time.created >= item.admittedAt);
        if (!dispatch?.settled || !dispatch.terminal || !dispatch.child) continue;
        const outcome = metadata.state === "completed" ? "succeeded" : metadata.state;
        if (outcome !== dispatch.terminal) continue;
        const text = String(notification.text);
        if (!messages.some(message => object(message) && message.role === "user" &&
          values(message.content).some(part => part.type === "text" && part.text === text))) continue;
        if (dispatch.result === undefined && this.recoverResult) {
          const recovered = await this.recoverResult(parent, dispatch.callID, dispatch.child, dispatch.promptID);
          if (recovered !== undefined) { dispatch.result = recovered; changed = true; }
        }
        if (dispatch.result !== undefined) additions.set(text, { callID: dispatch.callID, text: dispatch.result });
      }
      if (changed) await this.write(parent, dispatches);
      const projected = new Set(messages.filter(object).flatMap(message => object(message.metadata) &&
        typeof message.metadata["sortie-dogs/native-completion"] === "string"
        ? [message.metadata["sortie-dogs/native-completion"] as string] : []));
      return messages.flatMap(message => {
        if (!object(message) || message.role !== "user") return [message];
        const completion = values(message.content).map(part => typeof part.text === "string" ? additions.get(part.text) : undefined).find(Boolean);
        if (!completion || projected.has(completion.callID)) return [message];
        projected.add(completion.callID);
        return [message, { role: "system", content: [{ type: "text", text: `SORTIE_NATIVE_COMPLETION_RESULT\nRecorded host outcome for the identified invocation, not a new request or acceptance. Follow the latest user scope.\n${completion.text}` }],
          metadata: { "sortie-dogs/native-completion": completion.callID } }];
      });
    }).catch(error => {
      console.warn("[sortie-dogs-v010] Background result projection unavailable; native notification retained", error instanceof Error ? error.message : "unknown");
      return [...messages];
    });
  }
  /** Restore accounting before a resumed child produces further tool observations. */
  async resume(sessionID: string): Promise<void> {
    const info = await this.context.session.get({ sessionID });
    const parent = object(info) && typeof info.parentID === "string" ? info.parentID : sessionID;
    await this.serial(parent, async () => {
      for (const dispatch of (await this.read(parent)).filter(item => !item.settled && item.owner)) {
        const identity = `${parent}\0${dispatch.callID}`;
        if (this.restored.has(identity)) continue;
        this.owner?.(dispatch.callID, dispatch.owner);
        this.restored.add(identity);
      }
    });
  }
  async checkpoint(sessionID: string): Promise<void> {
    const info = await this.context.session.get({ sessionID });
    const parent = object(info) && typeof info.parentID === "string" ? info.parentID : sessionID;
    await this.serial(parent, async () => {
      const dispatches = await this.read(parent);
      for (const dispatch of dispatches.filter(item => !item.settled)) {
        const current = this.owner?.(dispatch.callID);
        if (current) dispatch.owner = current;
      }
      if (dispatches.length) await this.write(parent, dispatches);
    });
  }
  private async reconcileInside(parent: string, dispatches: NativeBackgroundDispatch[]): Promise<void> {
    const unlaunched = dispatches.filter(item => !item.settled && !item.launched);
    if (unlaunched.length) {
      const parentHistory = values(await this.context.session.context({ sessionID: parent }));
      for (const dispatch of unlaunched) {
        const tool = parentHistory.flatMap(message => values(message.content)).find(part =>
          part.type === "tool" && (part.id === dispatch.callID || part.callID === dispatch.callID) && object(part.state) &&
          ["completed", "error"].includes(String(part.state.status)));
        if (!tool || !object(tool.state)) continue;
        const metadata = object(tool.state.metadata) ? tool.state.metadata : {};
        if (typeof metadata.sessionID === "string") dispatch.child = metadata.sessionID;
        dispatch.launched = true;
        if (tool.state.status === "error") dispatch.terminal = "failed";
      }
      await this.write(parent, dispatches);
    }
    for (const dispatch of dispatches.filter(item => !item.settled && item.launched && (item.child || item.terminal))) {
      const history = dispatch.child ? values(await this.context.session.context({ sessionID: dispatch.child })) : [];
      const promptIndex = dispatch.promptID ? history.findIndex(item => item.id === dispatch.promptID) : -1;
      const fresh = promptIndex >= 0 ? history.slice(promptIndex + 1) : dispatch.promptID ? [] : history.filter(item => !dispatch.baseline.includes(String(item.id)) &&
        (!object(item.time) || typeof item.time.created !== "number" || item.time.created >= dispatch.admittedAt));
      const last = [...fresh].reverse().find(item => item.type === "assistant" &&
        (item.finish === "stop" || item.error !== undefined));
      // When logs exist, the delivered native prompt/execution event is authoritative. Old idle
      // text from a reused Reviewer cannot stand in for a correction or self-recheck terminal.
      if (!dispatch.terminal && last && !this.context.session.log) dispatch.terminal = last.error === undefined ? "succeeded" : "failed";
      if (!dispatch.terminal && dispatch.child && this.context.session.log) {
        let delivered = false;
        for await (const event of this.context.session.log({ sessionID: dispatch.child, follow: false })) {
          const data = object(event.data) ? event.data : {};
          if (event.type === "session.inbox.delivered" && data.inboxID === dispatch.promptID) delivered = true;
          if ((dispatch.promptID ? delivered : typeof event.created === "number" && event.created >= dispatch.admittedAt) &&
              ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(String(event.type))) {
            dispatch.terminal = String(event.type).slice("session.execution.".length) as NativeBackgroundDispatch["terminal"];
            break;
          }
        }
      }
      if (!dispatch.terminal && !this.context.session.log) {
        // Native completion inboxes survive reload even when the child context was compacted.
        const inboxes = this.context.session.inbox ? values(await this.context.session.inbox.list({ sessionID: parent })) : [];
        const parentHistory = [...values(await this.context.session.context({ sessionID: parent })), ...inboxes.map(item =>
          object(item.payload) ? { ...item, ...item.payload } : item)];
        const inbox = [...parentHistory].reverse().find(item => item.type === "synthetic" && object(item.metadata) &&
          item.metadata.source === "subagent" && item.metadata.childID === dispatch.child &&
          object(item.time) && typeof item.time.created === "number" && item.time.created >= dispatch.admittedAt);
        const state = inbox && object(inbox.metadata) ? inbox.metadata.state : undefined;
        if (state === "succeeded" || state === "failed" || state === "interrupted") dispatch.terminal = state;
      }
      if (!dispatch.terminal) continue;
      // Retain the terminal observation if accounting throws; a later context/status boundary retries it.
      await this.write(parent, dispatches);
      const text = last ? values(last.content).filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n") : "";
      const result = await this.settle(dispatch, text);
      if (typeof result === "string") dispatch.result = result;
      dispatch.settled = true;
      await this.write(parent, dispatches);
    }
  }
  async event(event: ObjectValue): Promise<void> {
    const data = object(event.data) ? event.data : {};
    if (typeof data.sessionID !== "string") return;
    const info = await this.context.session.get({ sessionID: data.sessionID });
    const parent = object(info) && typeof info.parentID === "string" ? info.parentID : data.sessionID;
    await this.serial(parent, async () => {
      const dispatches = await this.read(parent);
      if (event.type === "session.inbox.enqueued" && object(data.item)) {
        const item = object(data.item.payload) ? data.item.payload : data.item;
        const metadata = object(item.metadata) ? item.metadata : {};
        const dispatch = [...dispatches].reverse().find(value => !value.settled && value.child === metadata.childID);
        if (dispatch && !this.context.session.log && metadata.source === "subagent" && typeof event.created === "number" && event.created >= dispatch.admittedAt &&
            ["succeeded", "failed", "interrupted"].includes(String(metadata.state))) {
          dispatch.terminal = metadata.state as NativeBackgroundDispatch["terminal"];
          await this.write(parent, dispatches);
        }
      }
      const outcome = String(event.type).replace("session.execution.", "");
      if (["succeeded", "failed", "interrupted"].includes(outcome)) {
        const dispatch = [...dispatches].reverse().find(item => !item.settled && item.child === data.sessionID);
        // V2 execution events carry no execution ID. Their native timestamp, combined with the
        // admitted prompt generation, excludes late events from an earlier same-child execution.
        if (dispatch && !this.context.session.log && typeof event.created === "number" && event.created >= dispatch.admittedAt) {
          dispatch.terminal = outcome as NativeBackgroundDispatch["terminal"];
          await this.write(parent, dispatches);
        }
      }
      await this.reconcileInside(parent, dispatches);
    });
  }
}
