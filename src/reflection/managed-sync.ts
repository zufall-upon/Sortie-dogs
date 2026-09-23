import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planManagedReflectionBlock, type ReflectionManagedProfile } from "./managed-block.js";
import type { ReflectionEntry } from "./store.js";
import { createProjectPaths } from "../plugin/gate.js";

const STABLE_CONTROL = ".sortie-dogs/reflection-maintenance";
const V010_CONTROL = ".sortie-dogs-v010/reflection-maintenance";
const MAX_FILE_BYTES = 256 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/u;
function maintenanceContract(profile: ReflectionManagedProfile) {
  const control = profile === "stable" ? STABLE_CONTROL : profile === "v010" ? V010_CONTROL : ".sortie-dogs-v011/reflection-maintenance";
  return { control, manifest: {
    version: "0.1.0", task_id: "reflection-terminal-maintenance",
    read: ["AGENTS.md", control], write: ["AGENTS.md", control], validation: [],
  } };
}
type Receipt = {
  blockHash: string | null;
  pending?: { before: string; after: string; blockHash: string };
};
export type ReflectionSyncResult =
  | { kind: "unchanged" | "updated"; entries: number }
  | { kind: "deferred"; reason: "active-batch" | "sync-stopped" }
  | { kind: "proposal"; reason: string };

const digest = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const code = (error: unknown): unknown => error !== null && typeof error === "object" && "code" in error ? error.code : undefined;

async function readBounded(file: string): Promise<Buffer | undefined> {
  const info = await lstat(file).catch((error: unknown) => { if (code(error) === "ENOENT") return undefined; throw error; });
  if (info === undefined) return undefined;
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("unsafe-maintenance-file");
  return readFile(file);
}

async function atomicWrite(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const mode = (await lstat(file).catch(() => undefined))?.mode ?? 0o600;
  const handle = await open(temporary, "wx", mode);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** Coordinator-owned maintenance, never worker authorization. Conflicts remain non-blocking proposals. */
export async function syncProjectReflectionBlock(input: {
  projectRoot: string;
  entries: readonly ReflectionEntry[];
  activeBatch: boolean;
  profile?: ReflectionManagedProfile;
  syncEnabled?: boolean;
}): Promise<ReflectionSyncResult> {
  if (input.activeBatch) return { kind: "deferred", reason: "active-batch" };
  if (input.syncEnabled === false) return { kind: "deferred", reason: "sync-stopped" };
  const profile = input.profile ?? "stable";
  const { control, manifest } = maintenanceContract(profile);
  const directory = join(input.projectRoot, control);
  const agents = join(input.projectRoot, "AGENTS.md");
  const receiptPath = join(directory, "state.json");
  const lockPath = join(directory, "sync.lock");
  let controlApproved = false;
  const propose = async (reason: string): Promise<ReflectionSyncResult> => {
    if (controlApproved) await atomicWrite(join(directory, "proposal.json"), Buffer.from(JSON.stringify({ kind: "proposal", reason }))).catch(() => undefined);
    return { kind: "proposal", reason };
  };
  let lock;
  try {
    const project = await createProjectPaths(input.projectRoot);
    await project.toRelativePath(directory);
    await mkdir(directory, { recursive: true });
    controlApproved = true;
    const manifestPath = join(directory, "operation-manifest.json");
    try { await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (code(error) !== "EEXIST") throw error; }
    const approved = JSON.parse((await readBounded(manifestPath))!.toString("utf8"));
    if (JSON.stringify(approved) !== JSON.stringify(manifest)) return await propose("manifest-unapproved");
    const settingsBytes = await readBounded(join(directory, "options.json"));
    const settings = settingsBytes === undefined ? {} : JSON.parse(settingsBytes.toString("utf8"));
    if (settings === null || typeof settings !== "object" || Array.isArray(settings) ||
      Object.keys(settings).some((key) => !["enabled", "excludedScopes"].includes(key)) ||
      (settings.enabled !== undefined && typeof settings.enabled !== "boolean") ||
      (settings.excludedScopes !== undefined && (!Array.isArray(settings.excludedScopes) ||
        !settings.excludedScopes.every((scope: unknown) => typeof scope === "string")))) return await propose("invalid-options");
    if (settings.enabled === false) return { kind: "deferred", reason: "sync-stopped" };
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) { if (code(error) === "EEXIST") return await propose("lock-busy"); throw error; }
    const snapshot = (await readBounded(agents)) ?? Buffer.alloc(0);
    const saved = await readBounded(receiptPath);
    let receipt: Receipt = saved === undefined ? { blockHash: null } : JSON.parse(saved.toString("utf8"));
    if (receipt === null || typeof receipt !== "object" ||
      (receipt.blockHash !== null && !HASH.test(receipt.blockHash))) return await propose("invalid-receipt");
    if (receipt.pending !== undefined) {
      const pending = receipt.pending;
      if (pending === null || !HASH.test(pending.before) || !HASH.test(pending.after) || !HASH.test(pending.blockHash)) {
        return await propose("invalid-receipt");
      }
      const currentHash = digest(snapshot);
      if (currentHash === pending.after) receipt = { blockHash: pending.blockHash };
      else if (currentHash === pending.before) receipt = { blockHash: receipt.blockHash };
      else return await propose("pending-write-conflict");
      await atomicWrite(receiptPath, Buffer.from(JSON.stringify(receipt)));
    }
    const result = planManagedReflectionBlock({ snapshot,
      entries: input.entries.filter((entry) => !(settings.excludedScopes ?? []).includes(entry.scope)),
      profile,
      layer: "project", activeBatch: false, syncEnabled: true, manifestApproved: true,
      previousBlockHash: receipt.blockHash });
    if (result.kind === "proposal") return await propose(result.reason);
    if (result.kind === "no-update") return { kind: "deferred", reason: "sync-stopped" };
    if (result.buffer.equals(snapshot) || (receipt.blockHash === null && result.selectedEntryIds.length === 0)) {
      await unlink(join(directory, "proposal.json")).catch(() => undefined);
      return { kind: "unchanged", entries: result.selectedEntryIds.length };
    }
    // Journal both hashes so response loss cannot cause an overwrite or an unrecorded block on restart.
    const pending = { before: digest(snapshot), after: digest(result.buffer), blockHash: result.blockHash };
    await atomicWrite(receiptPath, Buffer.from(JSON.stringify({ ...receipt, pending })));
    if (!((await readBounded(agents)) ?? Buffer.alloc(0)).equals(snapshot)) return await propose("file-hash-drift");
    await atomicWrite(agents, result.buffer);
    await atomicWrite(receiptPath, Buffer.from(JSON.stringify({ blockHash: result.blockHash })));
    await unlink(join(directory, "proposal.json")).catch(() => undefined);
    return { kind: "updated", entries: result.selectedEntryIds.length };
  } catch {
    return await propose("maintenance-io-conflict");
  } finally {
    if (lock !== undefined) { await lock.close().catch(() => undefined); await unlink(lockPath).catch(() => undefined); }
  }
}
