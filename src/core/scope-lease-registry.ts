import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { normalizeWorktreeScope, worktreeScopesConflict, type WorktreeScope } from "./worktree-scope.js";

const VERSION = 1;
const MAX_LEASES = 1024;
const MAX_OWNER = 256;
const MAX_TTL = 24 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_TEMP_CLEANUP = 128;
const MAX_QUARANTINE_CLEANUP = 128;
const DEFAULT_MUTEX_STALE_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const OWNER_FILE = /^owner\.([0-9a-f-]{36})$/u;
const TEMP_FILE = /^\.scope-leases\.([0-9a-f-]{36})\.tmp$/u;
const QUARANTINE_PREFIX = ".scope-leases.stale.";
const QUARANTINE = /^\.scope-leases\.stale\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/u;

export type ScopeLeaseErrorCode = "scope-conflict" | "not-held" | "corrupt-state" | "invalid-request" | "lock-timeout" | "lock-lost";
export class ScopeLeaseError extends Error {
  readonly code: ScopeLeaseErrorCode;
  constructor(code: ScopeLeaseErrorCode, message: string) {
    super(message);
    this.name = "ScopeLeaseError";
    this.code = code;
  }
}

export type ScopeLeaseAcquireRequest = { readonly scope: WorktreeScope; readonly ownerId?: string; readonly ttlMs?: number };
export type ScopeLeaseRegistryOptions = {
  readonly ttlMs?: number;
  readonly mutexRetries?: number;
  readonly mutexRetryMs?: number;
  readonly mutexStaleMs?: number;
};

type StoredLease = {
  id: string;
  ownerHash: string;
  tokenHash: string;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
  read: string[];
  write: string[];
};
type State = { version: 1; revision: number; leases: StoredLease[] };
type HeldMutex = {
  readonly owner: string;
  readonly ownerPath: string;
  lost: boolean;
  pendingCheck: Promise<void>;
};
type MutexSnapshot = {
  readonly content: string;
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
};
type QuarantineSnapshot = {
  readonly directory: Omit<MutexSnapshot, "content">;
  readonly marker: MutexSnapshot;
  readonly names: readonly string[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCanonicalPaths(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_LEASES || !value.every((path) => typeof path === "string")) return false;
  try {
    const canonical = normalizeWorktreeScope({ read: value, write: [] }).read;
    return canonical.length === value.length && canonical.every((path, index) => path === value[index]);
  } catch {
    return false;
  }
}

export interface ScopeLease {
  readonly id: string;
  readonly ownerId: string;
  readonly scope: WorktreeScope;
  heartbeat(): Promise<void>;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
  abandon(): Promise<void>;
  close(): void;
}

export class ScopeLeaseRegistry {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly options: Required<ScopeLeaseRegistryOptions>;

  constructor(private readonly stateRoot: string, options: ScopeLeaseRegistryOptions = {}) {
    if (!stateRoot || typeof stateRoot !== "string" || /[\u0000-\u001f\u007f]/u.test(stateRoot)) {
      throw new ScopeLeaseError("invalid-request", "State root is invalid.");
    }
    this.statePath = join(stateRoot, "scope-leases.json");
    this.lockPath = join(stateRoot, ".scope-leases.lock");
    this.options = {
      ttlMs: options.ttlMs ?? 30_000,
      mutexRetries: options.mutexRetries ?? 80,
      mutexRetryMs: options.mutexRetryMs ?? 10,
      mutexStaleMs: options.mutexStaleMs ?? DEFAULT_MUTEX_STALE_MS,
    };
    if (!Number.isInteger(this.options.ttlMs) || this.options.ttlMs < 1 || this.options.ttlMs > MAX_TTL ||
      !Number.isInteger(this.options.mutexRetries) || this.options.mutexRetries < 0 || this.options.mutexRetries > 10_000 ||
      !Number.isInteger(this.options.mutexRetryMs) || this.options.mutexRetryMs < 1 || this.options.mutexRetryMs > 60_000 ||
      !Number.isInteger(this.options.mutexStaleMs) || this.options.mutexStaleMs < 10 || this.options.mutexStaleMs > MAX_TTL) {
      throw new ScopeLeaseError("invalid-request", "Registry options are invalid.");
    }
  }

  static open(stateRoot: string, options?: ScopeLeaseRegistryOptions): ScopeLeaseRegistry {
    return new ScopeLeaseRegistry(stateRoot, options);
  }

  async acquire(request: ScopeLeaseAcquireRequest): Promise<ScopeLease> {
    if (!isRecord(request)) throw new ScopeLeaseError("invalid-request", "Lease request is invalid.");
    const scope = this.validateRequest(request.scope);
    const ownerId = request.ownerId ?? randomUUID();
    if (typeof ownerId !== "string" || ownerId.length < 1 || ownerId.length > MAX_OWNER || /[\u0000-\u001f\u007f]/u.test(ownerId)) {
      throw new ScopeLeaseError("invalid-request", "Lease owner is invalid.");
    }
    const ttl = request.ttlMs ?? this.options.ttlMs;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL) throw new ScopeLeaseError("invalid-request", "TTL is invalid.");
    const token = randomUUID();
    const id = randomUUID();
    await this.withLock(async (mutex) => {
      const now = Date.now();
      await this.assertMutexHeld(mutex);
      const state = await this.load();
      state.leases = state.leases.filter((lease) => lease.expiresAt > now);
      if (state.leases.some((lease) => worktreeScopesConflict(scope, lease))) {
        throw new ScopeLeaseError("scope-conflict", "Requested scope is already leased.");
      }
      if (state.leases.length >= MAX_LEASES) throw new ScopeLeaseError("invalid-request", "Lease capacity is exhausted.");
      state.leases.push({
        id,
        ownerHash: sha256(ownerId),
        tokenHash: sha256(token),
        createdAt: now,
        heartbeatAt: now,
        expiresAt: now + ttl,
        read: [...scope.read],
        write: [...scope.write],
      });
      await this.save({ ...state, revision: state.revision + 1 }, mutex);
    });
    return this.makeLease(id, ownerId, token, scope, ttl);
  }

  private validateRequest(request: WorktreeScope): WorktreeScope {
    try {
      if (!isRecord(request) || !Array.isArray(request.read) || !Array.isArray(request.write)) throw new Error();
      return normalizeWorktreeScope(request);
    } catch {
      throw new ScopeLeaseError("invalid-request", "Lease request is invalid.");
    }
  }

  private makeLease(id: string, ownerId: string, token: string, scope: WorktreeScope, ttl: number): ScopeLease {
    const ownerHash = sha256(ownerId);
    const credentialHash = sha256(token);
    let active = true;
    let closing = false;
    let pending = Promise.resolve();
    const stop = (): void => {
      active = false;
      clearInterval(timer);
    };
    const transaction = async (kind: "heartbeat" | "assert" | "release" | "abandon"): Promise<void> => {
      if (!active) throw new ScopeLeaseError("not-held", "Lease is not held.");
      await this.withLock(async (mutex) => {
        await this.assertMutexHeld(mutex);
        const state = await this.load();
        const index = state.leases.findIndex((lease) =>
          lease.id === id && lease.ownerHash === ownerHash && lease.tokenHash === credentialHash
        );
        const now = Date.now();
        if (index < 0 || state.leases[index]!.expiresAt <= now) throw new ScopeLeaseError("not-held", "Lease is not held.");
        if (kind === "assert") {
          await this.assertMutexHeld(mutex);
          return;
        }
        if (kind === "heartbeat") {
          state.leases[index]!.heartbeatAt = now;
          state.leases[index]!.expiresAt = now + ttl;
        } else {
          state.leases.splice(index, 1);
        }
        await this.save({ ...state, revision: state.revision + 1 }, mutex);
      });
    };
    const serialized = (kind: "heartbeat" | "assert" | "release" | "abandon"): Promise<void> => {
      if (!active || (closing && kind !== "release" && kind !== "abandon")) {
        return Promise.reject(new ScopeLeaseError("not-held", "Lease is not held."));
      }
      if (kind === "release" || kind === "abandon") {
        if (closing) return Promise.reject(new ScopeLeaseError("not-held", "Lease is not held."));
        closing = true;
      }
      const result = pending.then(() => transaction(kind));
      pending = result.catch(() => undefined);
      return result.catch((error: unknown) => {
        if (error instanceof ScopeLeaseError && error.code === "not-held") {
          stop();
        } else if (kind === "release") {
          closing = false;
        } else if (kind === "abandon") {
          stop();
        }
        throw error;
      }).then(() => {
        if (kind === "release" || kind === "abandon") stop();
      });
    };
    const heartbeatEvery = Math.max(1, Math.floor(ttl / 3));
    const timer = setInterval(() => {
      if (!active || closing) return;
      void serialized("heartbeat").catch(() => undefined);
    }, heartbeatEvery);
    timer.unref();
    return Object.freeze({
      id,
      ownerId,
      scope: Object.freeze({ read: [...scope.read], write: [...scope.write] }),
      heartbeat: () => serialized("heartbeat"),
      assertHeld: () => serialized("assert"),
      release: () => serialized("release"),
      abandon: () => serialized("abandon"),
      close: stop,
    });
  }

  private async load(): Promise<State> {
    try {
      const source = await readFile(this.statePath);
      if (source.byteLength > MAX_STATE_BYTES) throw new Error("oversized");
      const raw = JSON.parse(source.toString("utf8")) as unknown;
      if (!isRecord(raw) || !hasExactKeys(raw, ["leases", "revision", "version"]) || raw.version !== VERSION ||
        !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 ||
        !Array.isArray(raw.leases) || raw.leases.length > MAX_LEASES) throw new Error("state");
      const leases: StoredLease[] = [];
      const ids = new Set<string>();
      for (const value of raw.leases) {
        if (!isRecord(value) || !hasExactKeys(value, [
          "createdAt", "expiresAt", "heartbeatAt", "id", "ownerHash", "read", "tokenHash", "write",
        ]) || typeof value.id !== "string" || !UUID.test(value.id) || ids.has(value.id) ||
          typeof value.ownerHash !== "string" || !HASH.test(value.ownerHash) ||
          typeof value.tokenHash !== "string" || !HASH.test(value.tokenHash) ||
          !validTimestamp(value.createdAt) || !validTimestamp(value.heartbeatAt) || !validTimestamp(value.expiresAt) ||
          value.createdAt > value.heartbeatAt || value.heartbeatAt >= value.expiresAt ||
          value.expiresAt - value.heartbeatAt > MAX_TTL ||
          !validCanonicalPaths(value.read) || !validCanonicalPaths(value.write)) throw new Error("lease");
        ids.add(value.id);
        leases.push(value as StoredLease);
      }
      return { version: 1, revision: raw.revision as number, leases };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, leases: [] };
      throw new ScopeLeaseError("corrupt-state", "Lease state is corrupt or unsupported.");
    }
  }

  private async cleanupTemps(): Promise<void> {
    const names = await readdir(this.stateRoot).catch(() => []);
    let checked = 0;
    for (const name of names.sort()) {
      if (checked >= MAX_TEMP_CLEANUP || !TEMP_FILE.test(name)) continue;
      checked += 1;
      const path = join(this.stateRoot, name);
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && Date.now() - info.mtimeMs > this.options.mutexStaleMs) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  }

  private async save(state: State, mutex: HeldMutex): Promise<void> {
    const source = JSON.stringify(state);
    if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) throw new ScopeLeaseError("invalid-request", "Lease capacity is exhausted.");
    await this.assertMutexHeld(mutex);
    await this.cleanupTemps();
    // A recovered lock moves this source path away, fencing a paused former owner at commit time.
    const temp = join(this.lockPath, `.scope-leases.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(source);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temp, 0o600).catch(() => undefined);
      await this.assertMutexHeld(mutex, true);
      try {
        await rename(temp, this.statePath);
      } catch (error) {
        if (await stat(mutex.ownerPath).catch(() => undefined) === undefined) {
          mutex.lost = true;
          throw new ScopeLeaseError("lock-lost", "Lease mutex ownership was lost.");
        }
        throw error;
      }
      renamed = true;
      await chmod(this.statePath, 0o600).catch(() => undefined);
      const directory = await open(this.stateRoot, "r").catch(() => undefined);
      try {
        await directory?.sync().catch(() => undefined);
      } finally {
        await directory?.close().catch(() => undefined);
      }
    } finally {
      if (!renamed) await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private sameMutexSnapshot(left: MutexSnapshot, right: MutexSnapshot): boolean {
    return left.content === right.content && left.ctimeMs === right.ctimeMs && left.dev === right.dev &&
      left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size;
  }

  private sameDirectorySnapshot(
    left: QuarantineSnapshot["directory"],
    right: QuarantineSnapshot["directory"],
  ): boolean {
    return left.ctimeMs === right.ctimeMs && left.dev === right.dev && left.ino === right.ino &&
      left.mtimeMs === right.mtimeMs && left.size === right.size;
  }

  private async mutexSnapshot(path: string): Promise<MutexSnapshot | undefined> {
    const before = await stat(path).catch(() => undefined);
    if (before === undefined || !before.isFile()) return undefined;
    const content = await readFile(path, "utf8").catch(() => undefined);
    if (content === undefined) return undefined;
    const after = await stat(path).catch(() => undefined);
    if (after === undefined || !after.isFile()) return undefined;
    const first = {
      content,
      ctimeMs: before.ctimeMs,
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      size: before.size,
    };
    const second = {
      content,
      ctimeMs: after.ctimeMs,
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      size: after.size,
    };
    return this.sameMutexSnapshot(first, second) ? second : undefined;
  }

  private async assertMutexHeld(mutex: HeldMutex, refresh = false): Promise<void> {
    const check = mutex.pendingCheck.then(async () => {
      if (mutex.lost) throw new ScopeLeaseError("lock-lost", "Lease mutex ownership was lost.");
      const snapshot = await this.mutexSnapshot(mutex.ownerPath);
      if (snapshot === undefined || snapshot.content !== mutex.owner) {
        mutex.lost = true;
        throw new ScopeLeaseError("lock-lost", "Lease mutex ownership was lost.");
      }
      if (!refresh) return;
      try {
        await utimes(mutex.ownerPath, new Date(), new Date());
      } catch {
        mutex.lost = true;
        throw new ScopeLeaseError("lock-lost", "Lease mutex ownership was lost.");
      }
    });
    mutex.pendingCheck = check.catch(() => undefined);
    await check;
  }

  private async quarantineSnapshot(name: string): Promise<QuarantineSnapshot | undefined> {
    const match = QUARANTINE.exec(name);
    if (match === null || !UUID.test(match[1]!) || !UUID.test(match[2]!)) return undefined;
    const owner = match[1]!;
    const path = join(this.stateRoot, name);
    const directoryBefore = await lstat(path).catch(() => undefined);
    if (directoryBefore === undefined || !directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) return undefined;
    const names = await readdir(path).catch(() => undefined);
    if (names === undefined || names.length < 1 || names.length > MAX_TEMP_CLEANUP + 1) return undefined;
    const ownerName = `owner.${owner}`;
    if (names.filter((entry) => entry === ownerName).length !== 1) return undefined;
    for (const entry of names) {
      if (entry !== ownerName) {
        const temp = TEMP_FILE.exec(entry);
        if (temp === null || !UUID.test(temp[1]!)) return undefined;
      }
      const info = await lstat(join(path, entry)).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.isSymbolicLink()) return undefined;
    }
    const marker = await this.mutexSnapshot(join(path, ownerName));
    const directoryAfter = await lstat(path).catch(() => undefined);
    if (marker === undefined || marker.content !== owner || directoryAfter === undefined ||
      !directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()) return undefined;
    const before = {
      ctimeMs: directoryBefore.ctimeMs,
      dev: directoryBefore.dev,
      ino: directoryBefore.ino,
      mtimeMs: directoryBefore.mtimeMs,
      size: directoryBefore.size,
    };
    const after = {
      ctimeMs: directoryAfter.ctimeMs,
      dev: directoryAfter.dev,
      ino: directoryAfter.ino,
      mtimeMs: directoryAfter.mtimeMs,
      size: directoryAfter.size,
    };
    if (!this.sameDirectorySnapshot(before, after)) return undefined;
    return { directory: after, marker, names: names.sort() };
  }

  private sameQuarantineSnapshot(left: QuarantineSnapshot, right: QuarantineSnapshot): boolean {
    return this.sameDirectorySnapshot(left.directory, right.directory) &&
      this.sameMutexSnapshot(left.marker, right.marker) &&
      left.names.length === right.names.length && left.names.every((name, index) => name === right.names[index]);
  }

  private sameMovedQuarantineSnapshot(left: QuarantineSnapshot, right: QuarantineSnapshot): boolean {
    return left.directory.dev === right.directory.dev && left.directory.ino === right.directory.ino &&
      left.directory.mtimeMs === right.directory.mtimeMs && left.directory.size === right.directory.size &&
      this.sameMutexSnapshot(left.marker, right.marker) &&
      left.names.length === right.names.length && left.names.every((name, index) => name === right.names[index]);
  }

  private async cleanupQuarantine(name: string): Promise<boolean> {
    const before = await this.quarantineSnapshot(name);
    const now = Date.now();
    if (before === undefined || now - before.marker.mtimeMs <= this.options.mutexStaleMs ||
      now - Math.max(before.directory.ctimeMs, before.directory.mtimeMs) <= this.options.mutexStaleMs) return false;
    const after = await this.quarantineSnapshot(name);
    if (after === undefined || !this.sameQuarantineSnapshot(before, after)) return false;
    const owner = QUARANTINE.exec(name)![1]!;
    const cleanupName = `.scope-leases.stale.${owner}.${randomUUID()}`;
    try {
      await rename(join(this.stateRoot, name), join(this.stateRoot, cleanupName));
    } catch {
      return false;
    }
    const moved = await this.quarantineSnapshot(cleanupName);
    if (moved === undefined || !this.sameMovedQuarantineSnapshot(after, moved)) return false;
    await rm(join(this.stateRoot, cleanupName), { recursive: true, force: true });
    return true;
  }

  private async hasQuarantine(): Promise<boolean> {
    const candidates = (await readdir(this.stateRoot).catch(() => []))
      .filter((name) => name.startsWith(QUARANTINE_PREFIX))
      .sort();
    for (const name of candidates.slice(0, MAX_QUARANTINE_CLEANUP)) {
      await this.cleanupQuarantine(name).catch(() => false);
    }
    return (await readdir(this.stateRoot).catch(() => []))
      .some((name) => name.startsWith(QUARANTINE_PREFIX));
  }

  private async recoverStaleLock(): Promise<void> {
    const directory = await stat(this.lockPath).catch(() => undefined);
    if (directory === undefined || !directory.isDirectory()) return;
    const names = await readdir(this.lockPath).catch(() => []);
    if (names.length === 0) {
      if (Date.now() - Math.max(directory.ctimeMs, directory.mtimeMs) <= this.options.mutexStaleMs) return;
      const after = await stat(this.lockPath).catch(() => undefined);
      if (after === undefined || !after.isDirectory() || after.dev !== directory.dev ||
        after.ino !== directory.ino || after.ctimeMs !== directory.ctimeMs ||
        after.mtimeMs !== directory.mtimeMs || after.size !== directory.size) return;
      // If the creator races us by adding its marker, rmdir fails because the directory is non-empty.
      // If rmdir wins, that creator's subsequent exclusive marker open fails against the removed path.
      await rmdir(this.lockPath).catch(() => undefined);
      return;
    }
    if (names.length !== 1) return;
    const match = OWNER_FILE.exec(names[0]!);
    if (match === null || !UUID.test(match[1]!)) return;
    const owner = match[1]!;
    const ownerPath = join(this.lockPath, names[0]!);
    const before = await this.mutexSnapshot(ownerPath);
    if (before === undefined || Date.now() - before.mtimeMs <= this.options.mutexStaleMs || before.content !== owner) return;
    const quarantineName = `.scope-leases.stale.${owner}.${randomUUID()}`;
    const quarantine = join(this.stateRoot, quarantineName);
    try {
      await rename(this.lockPath, quarantine);
    } catch {
      return;
    }
    const movedOwnerPath = join(quarantine, names[0]!);
    const after = await this.mutexSnapshot(movedOwnerPath);
    if (after === undefined || !this.sameMutexSnapshot(before, after)) {
      // The whole-directory rename already fenced this owner. Keep its quarantine until a later
      // stale recheck; restoring here could overwrite a replacement lock created during the race.
      return;
    }
    await this.cleanupQuarantine(quarantineName);
  }

  private async removeOwnedMutex(mutex: HeldMutex): Promise<void> {
    if (await readFile(mutex.ownerPath, "utf8").catch(() => undefined) !== mutex.owner) return;
    const removed = await unlink(mutex.ownerPath).then(() => true, () => false);
    if (removed) await rmdir(this.lockPath).catch(() => undefined);
  }

  private async withLock<T>(fn: (mutex: HeldMutex) => Promise<T>): Promise<T> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await chmod(this.stateRoot, 0o700).catch(() => undefined);
    const owner = randomUUID();
    const mutex: HeldMutex = {
      owner,
      ownerPath: join(this.lockPath, `owner.${owner}`),
      lost: false,
      pendingCheck: Promise.resolve(),
    };
    let held = false;
    for (let attempt = 0; attempt <= this.options.mutexRetries; attempt += 1) {
      let directoryCreated = false;
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        directoryCreated = true;
        await open(mutex.ownerPath, "wx", 0o600).then(async (handle) => {
          try {
            await handle.writeFile(owner);
            await handle.sync();
          } finally {
            await handle.close();
          }
        });
        held = true;
        if (await this.hasQuarantine()) {
          await this.removeOwnedMutex(mutex);
          held = false;
          throw new Error("stale-recovery-in-progress");
        }
        break;
      } catch {
        if (directoryCreated && !held) await rmdir(this.lockPath).catch(() => undefined);
        await this.recoverStaleLock().catch(() => undefined);
        if (attempt === this.options.mutexRetries) {
          throw new ScopeLeaseError("lock-timeout", "Lease mutex acquisition timed out.");
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.mutexRetryMs));
      }
    }
    const heartbeatEvery = Math.max(5, Math.floor(this.options.mutexStaleMs / 3));
    const timer = setInterval(() => {
      void this.assertMutexHeld(mutex, true).catch(() => {
        mutex.lost = true;
      });
    }, heartbeatEvery);
    timer.unref();
    try {
      await this.assertMutexHeld(mutex, true);
      return await fn(mutex);
    } finally {
      clearInterval(timer);
      if (held) await this.removeOwnedMutex(mutex);
    }
  }
}
