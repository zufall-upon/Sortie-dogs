import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { durableScopeRoot } from "./durable-scope-root.ts";
import { configRoot } from "../reflection/config.ts";

export interface MemorySource {
  id: string; session: string; message: string; actor: string; text: string;
  attachments: Array<{ url: string; mime?: string; filename?: string }>;
  observedAt: string; availability: "retained-reference";
}
export interface MemoryChange {
  key: string; scope: "project" | "workspace" | "mission"; context: string;
  kind: "vision" | "constraint" | "decision" | "unresolved" | "result";
  status: "proposed" | "adopted" | "withdrawn" | "unverified";
  text: string; reason: string; supersedes?: string;
  consultation?: { id: string; callID: string; disposition: "adopted" | "rejected" | "partial"; effect: "improved" | "unchanged" | "worsened" | "unverified" };
}
export interface MemoryEvent extends MemoryChange { id: string; source: string; operation: string; actor: string; at: string }
interface MemoryState {
  v: 1; enabled: boolean; sources: MemorySource[]; events: MemoryEvent[];
  processed: Record<string, { operation: string; fingerprint: string; at: string }>;
}
const empty = (): MemoryState => ({ v: 1, enabled: false, sources: [], events: [], processed: {} });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown, max = 8000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Stable repository identity uses local Git common-dir, never remote URL or a worktree path. */
export async function projectMemoryFile(root: string): Promise<string> {
  const identity = await durableScopeRoot(root) ?? await realpath(root);
  return join(configRoot(), "sortie-dogs", "project-memory", `${hash(identity)}.json`);
}

/** One atomic document commits events and processed markers together. No reflection TTL or schema reuse. */
export class ProjectMemory {
  readonly file: string;
  constructor(file: string) { this.file = file; }
  private async load(): Promise<MemoryState> {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as MemoryState;
      if (state.v !== 1 || typeof state.enabled !== "boolean" || !Array.isArray(state.sources) ||
          !Array.isArray(state.events) || !state.processed || typeof state.processed !== "object" || Array.isArray(state.processed) ||
          !state.sources.every(source => source && text(source.id) && text(source.session) && text(source.message) && text(source.actor) &&
            typeof source.text === "string" && Array.isArray(source.attachments) && source.attachments.every(file => file && text(file.url, Number.MAX_SAFE_INTEGER)) &&
            typeof source.observedAt === "string" && source.availability === "retained-reference") ||
          !state.events.every(event => event && text(event.id) && text(event.key) && text(event.context) && text(event.text) && text(event.reason) &&
            text(event.source) && text(event.actor) && text(event.operation) && typeof event.at === "string" &&
            ["project", "workspace", "mission"].includes(event.scope) && ["vision", "constraint", "decision", "unresolved", "result"].includes(event.kind) &&
            ["proposed", "adopted", "withdrawn", "unverified"].includes(event.status)) ||
          !Object.values(state.processed).every(item => item && text(item.operation) && text(item.fingerprint) && typeof item.at === "string")) throw new Error("project-memory-invalid-state");
      return state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
  }
  private async transaction<T>(fn: (state: MemoryState) => T): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    let handle;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { handle = await open(lock, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!handle) throw new Error(`project-memory-busy: retry; if interrupted owner stopped, remove ${lock}`);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      const state = await this.load(), result = fn(state);
      const output = await open(temp, "wx", 0o600);
      try { await output.writeFile(JSON.stringify(state)); await output.sync(); } finally { await output.close(); }
      await rename(temp, this.file);
      const directory = await open(dirname(this.file), "r").catch(() => undefined);
      try { await directory?.sync(); } finally { await directory?.close(); }
      return result;
    } finally { await unlink(temp).catch(() => undefined); await handle.close(); await unlink(lock); }
  }
  async enabled(): Promise<boolean> { return (await this.load()).enabled; }
  async source(id: string): Promise<MemorySource | undefined> {
    const state = await this.load();
    return state.enabled ? state.sources.find(source => source.id === id) : undefined;
  }
  async configure(enabled: boolean): Promise<void> { await this.transaction(state => { state.enabled = enabled; }); }
  async capture(source: Omit<MemorySource, "observedAt" | "availability">): Promise<void> {
    if (!await this.enabled()) return;
    if (!text(source.id) || !text(source.session) || !text(source.message)) throw new Error("project-memory-invalid-source");
    await this.transaction(state => {
      if (!state.enabled) return;
      const previous = state.sources.find(item => item.id === source.id);
      if (previous) {
        if (JSON.stringify({ ...source }) !== JSON.stringify({ id: previous.id, session: previous.session, message: previous.message,
          actor: previous.actor, text: previous.text, attachments: previous.attachments })) throw new Error("project-memory-source-conflict");
        return;
      }
      state.sources.push({ ...source, observedAt: new Date().toISOString(), availability: "retained-reference" });
    });
  }
  async apply(source: string, operation: string, actor: string, changes: MemoryChange[]): Promise<string> {
    if (!text(operation, 256) || !text(actor, 256) || !Array.isArray(changes) || changes.length > 32) throw new Error("project-memory-invalid-operation");
    return this.transaction(state => {
      if (!state.enabled) throw new Error("project-memory-off");
      if (!state.sources.some(item => item.id === source)) throw new Error("project-memory-source-not-found");
      const fingerprint = hash(JSON.stringify({ operation, actor, changes }));
      const previous = Object.hasOwn(state.processed, source) ? state.processed[source] : undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("project-memory-operation-conflict");
        return "already-processed";
      }
      if (Object.values(state.processed).some(item => item.operation === operation)) throw new Error("project-memory-operation-conflict");
      for (const change of changes) {
        if (!text(change.key, 256) || !text(change.context, 1024) || !text(change.text) || !text(change.reason) ||
            !["project", "workspace", "mission"].includes(change.scope) ||
            !["vision", "constraint", "decision", "unresolved", "result"].includes(change.kind) ||
            !["proposed", "adopted", "withdrawn", "unverified"].includes(change.status)) throw new Error("project-memory-invalid-change");
        const current = state.events.filter(item => item.key === change.key && item.scope === change.scope && item.context === change.context).at(-1);
        if ((current?.id ?? undefined) !== change.supersedes) throw new Error("project-memory-snapshot-conflict");
        if (change.consultation && (!text(change.consultation.id) || !text(change.consultation.callID) ||
          !["adopted", "rejected", "partial"].includes(change.consultation.disposition) ||
          !["improved", "unchanged", "worsened", "unverified"].includes(change.consultation.effect))) throw new Error("project-memory-invalid-consultation");
        state.events.push({ ...change, id: randomUUID(), source, operation, actor, at: new Date().toISOString() });
      }
      Object.defineProperty(state.processed, source, { value: { operation, fingerprint, at: new Date().toISOString() }, enumerable: true, configurable: true, writable: true });
      return changes.length ? "applied" : "no-change";
    });
  }
  async recall(workspace: string, mission?: string, query = "") {
    const state = await this.load();
    if (!state.enabled) return { enabled: false as const };
    const current = new Map<string, MemoryEvent>();
    for (const event of state.events) current.set(JSON.stringify([event.scope, event.context, event.key]), event);
    const snapshot = [...current.values()].filter(event => (event.scope === "project" ||
      event.scope === "workspace" && event.context === workspace || event.scope === "mission" && event.context === mission));
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    snapshot.sort((a, b) => terms.filter(term => b.text.toLocaleLowerCase().includes(term)).length -
      terms.filter(term => a.text.toLocaleLowerCase().includes(term)).length || b.at.localeCompare(a.at));
    const pending = state.sources.filter(source => !Object.hasOwn(state.processed, source.id));
    const excerpt = (source: MemorySource) => ({ ...source, text: source.text.slice(0, 2000), text_truncated: source.text.length > 2000 });
    return { enabled: true as const, snapshot: snapshot.slice(0, 24), pending: pending.slice(0, 8).map(excerpt),
      pending_count: pending.length, oldest_pending: pending[0]?.observedAt ?? null,
      last_success: Object.values(state.processed).map(item => item.at).sort().at(-1) ?? null,
      sources: state.sources.filter(source => snapshot.slice(0, 24).some(event => event.source === source.id)).slice(-24).map(excerpt) };
  }
}
