import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ScopeLeaseError, ScopeLeaseRegistry } from "../dist/core/scope-lease-registry.js";

const scope = (read: string[] = [], write: string[] = []) => ({ read, write });
const childFixture = fileURLToPath(new URL("./fixtures/scope-lease-child.mjs", import.meta.url));

type ChildResult = { status: "held" | "denied" | "released"; code?: string };

function startChild(root: string, owner: string, path: string, ttl = 300): {
  child: ChildProcess;
  first: Promise<ChildResult>;
} {
  const child = fork(childFixture, [root, owner, path, String(ttl)], { silent: true });
  const first = new Promise<ChildResult>((resolve, reject) => {
    const onExit = (code: number | null) => reject(new Error(`lease child exited before result: ${code}`));
    child.once("exit", onExit);
    child.once("message", (message) => {
      child.off("exit", onExit);
      resolve(message as ChildResult);
    });
  });
  return { child, first };
}

async function releaseChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.connected) return;
  const released = new Promise<void>((resolve) => {
    child.on("message", (message) => {
      if ((message as ChildResult).status === "released") resolve();
    });
  });
  child.send("release");
  await released;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

test("Windows child processes serialize conflicts and concurrently hold disjoint scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-child-"));
  const children: ChildProcess[] = [];
  try {
    const left = startChild(root, "raw-owner-alpha", "src/shared.ts");
    const right = startChild(root, "raw-owner-beta", "SRC/SHARED.TS");
    children.push(left.child, right.child);
    const conflict = await Promise.all([left.first, right.first]);
    assert.deepEqual(conflict.map((result) => result.status).sort(), ["denied", "held"]);
    assert.equal(conflict.find((result) => result.status === "denied")?.code, "scope-conflict");
    await Promise.all([
      ...(conflict[0]!.status === "held" ? [releaseChild(left.child)] : []),
      ...(conflict[1]!.status === "held" ? [releaseChild(right.child)] : []),
    ]);

    const a = startChild(root, "raw-owner-a", "src/a.ts");
    const b = startChild(root, "raw-owner-b", "src/b.ts");
    children.push(a.child, b.child);
    assert.deepEqual((await Promise.all([a.first, b.first])).map((result) => result.status), ["held", "held"]);
    const persisted = await readFile(join(root, "scope-leases.json"), "utf8");
    for (const raw of ["raw-owner-alpha", "raw-owner-beta", "raw-owner-a", "raw-owner-b"]) {
      assert.equal(persisted.includes(raw), false);
    }
    assert.equal((JSON.parse(persisted) as { leases: unknown[] }).leases.length, 2);
    assert.deepEqual((await readdir(root)).filter((name) => /\.log$|secret/iu.test(name)), []);
    await Promise.all([releaseChild(a.child), releaseChild(b.child)]);
  } finally {
    await Promise.all(children.map(stopChild));
    await rm(root, { recursive: true, force: true });
  }
});

test("force-killed child remains fenced until TTL and is then reclaimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-kill-"));
  const ttl = 240;
  try {
    const owner = startChild(root, "killed-owner", "src/killed.ts", ttl);
    assert.equal((await owner.first).status, "held");
    owner.child.kill("SIGKILL");
    await new Promise((resolve) => owner.child.once("exit", resolve));
    const registry = new ScopeLeaseRegistry(root, { ttlMs: ttl });
    await assert.rejects(
      () => registry.acquire({ scope: scope([], ["src/killed.ts"]) }),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "scope-conflict",
    );
    await new Promise((resolve) => setTimeout(resolve, ttl + 80));
    const recovered = await registry.acquire({ scope: scope([], ["src/killed.ts"]) });
    await recovered.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic heartbeat, explicit heartbeat, fencing, and release are transaction safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-heartbeat-"));
  try {
    const registry = new ScopeLeaseRegistry(root, { ttlMs: 3_000 });
    const lease = await registry.acquire({ ownerId: "opaque-owner", scope: scope([], ["src/a.ts"]) });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await lease.assertHeld();
    await lease.heartbeat();
    await assert.rejects(
      () => registry.acquire({ scope: scope([], ["SRC/A.TS"]) }),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "scope-conflict",
    );
    await lease.abandon();
    const replacement = await registry.acquire({ scope: scope([], ["src/a.ts"]) });
    await assert.rejects(
      () => lease.release(),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "not-held",
    );
    await replacement.assertHeld();
    await replacement.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local close is idempotent, stops heartbeat, and leaves TTL reclamation durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-close-"));
  try {
    const registry = new ScopeLeaseRegistry(root, { ttlMs: 60 });
    const lease = await registry.acquire({ scope: scope([], ["src/closed.ts"]) });
    const statePath = join(root, "scope-leases.json");
    const before = JSON.parse(await readFile(statePath, "utf8")) as {
      leases: Array<{ heartbeatAt: number; expiresAt: number }>;
    };
    lease.close();
    lease.close();
    await new Promise((resolve) => setTimeout(resolve, 90));
    const after = JSON.parse(await readFile(statePath, "utf8")) as typeof before;
    assert.deepEqual(after.leases, before.leases);
    await assert.rejects(
      () => lease.heartbeat(),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "not-held",
    );
    const replacement = await registry.acquire({ scope: scope([], ["src/closed.ts"]) });
    await replacement.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired handle cannot heartbeat or release a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-expired-"));
  try {
    const registry = new ScopeLeaseRegistry(root, { ttlMs: 900 });
    const expired = await registry.acquire({ ownerId: "expired-owner", scope: scope([], ["src/fenced.ts"]) });
    const statePath = join(root, "scope-leases.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      revision: number;
      leases: Array<{ heartbeatAt: number; expiresAt: number }>;
    };
    state.revision += 1;
    state.leases[0]!.heartbeatAt = Date.now() - 2;
    state.leases[0]!.expiresAt = Date.now() - 1;
    await writeFile(statePath, JSON.stringify(state));
    const replacement = await registry.acquire({ ownerId: "replacement-owner", scope: scope([], ["src/fenced.ts"]) });
    await assert.rejects(
      () => expired.heartbeat(),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "not-held",
    );
    await assert.rejects(
      () => expired.release(),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "not-held",
    );
    await replacement.assertHeld();
    await replacement.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner validation and strict bounded state schema fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-schema-"));
  try {
    const registry = new ScopeLeaseRegistry(root);
    for (const ownerId of ["", "x\nsecret", "x".repeat(257)]) {
      await assert.rejects(
        () => registry.acquire({ ownerId, scope: scope([], ["src/a.ts"]) }),
        (error: unknown) => error instanceof ScopeLeaseError && error.code === "invalid-request",
      );
    }
    const corrupt = async (value: unknown): Promise<void> => {
      await writeFile(join(root, "scope-leases.json"), typeof value === "string" ? value : JSON.stringify(value));
      await assert.rejects(
        () => registry.acquire({ scope: scope([], ["src/c.ts"]) }),
        (error: unknown) => error instanceof ScopeLeaseError && error.code === "corrupt-state",
      );
    };
    await corrupt({ version: 2, revision: 0, leases: [] });
    await corrupt({ version: 1, revision: 0, leases: [], extra: true });
    await corrupt({ version: 1, revision: 0, leases: [{ id: "not-a-uuid" }] });
    await corrupt("x".repeat(1024 * 1024 + 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old mutex owner cannot remove its replacement lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-mutex-"));
  try {
    const registry = new ScopeLeaseRegistry(root, { mutexStaleMs: 20 });
    const privateRegistry = registry as unknown as { withLock<T>(fn: () => Promise<T>): Promise<T> };
    let unblockOld!: () => void;
    let oldEntered!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { unblockOld = resolve; });
    const entered = new Promise<void>((resolve) => { oldEntered = resolve; });
    const old = privateRegistry.withLock(async () => { oldEntered(); await oldBlocked; });
    await entered;
    const lock = join(root, ".scope-leases.lock");
    const oldOwner = (await readdir(lock))[0]!;
    const quarantined = join(root, `quarantined-${oldOwner}`);
    await rename(join(lock, oldOwner), quarantined);
    await rmdir(lock);

    let unblockNew!: () => void;
    let newEntered!: () => void;
    const newBlocked = new Promise<void>((resolve) => { unblockNew = resolve; });
    const replacementEntered = new Promise<void>((resolve) => { newEntered = resolve; });
    const replacement = privateRegistry.withLock(async () => { newEntered(); await newBlocked; });
    await replacementEntered;
    unblockOld();
    await old;
    assert.equal((await stat(lock)).isDirectory(), true);
    assert.equal((await readdir(lock)).length, 1);
    unblockNew();
    await replacement;
    await unlink(quarantined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale mutex recovery rechecks owner identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-stale-"));
  try {
    const lock = join(root, ".scope-leases.lock");
    const owner = "00000000-0000-4000-8000-000000000001";
    await mkdir(lock);
    const marker = join(lock, `owner.${owner}`);
    await writeFile(marker, owner);
    const old = new Date(Date.now() - 1000);
    await utimes(marker, old, old);
    const registry = new ScopeLeaseRegistry(root, { mutexStaleMs: 20, mutexRetries: 20, mutexRetryMs: 5 });
    const lease = await registry.acquire({ scope: scope([], ["src/stale.ts"]) });
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty mutex left before owner creation is reclaimed after its stale threshold", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-empty-mutex-"));
  try {
    const lock = join(root, ".scope-leases.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 1000);
    await utimes(lock, old, old);
    const registry = new ScopeLeaseRegistry(root, { mutexStaleMs: 20, mutexRetries: 20, mutexRetryMs: 5 });
    const lease = await registry.acquire({ scope: scope([], ["src/recovered.ts"]) });
    await lease.release();
    assert.equal(await stat(lock).catch(() => undefined), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a raced stale quarantine becomes reclaimable while malformed quarantine stays fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-quarantine-"));
  try {
    const lock = join(root, ".scope-leases.lock");
    const owner = "00000000-0000-4000-8000-000000000001";
    await mkdir(lock);
    const marker = join(lock, `owner.${owner}`);
    await writeFile(marker, owner);
    const old = new Date(Date.now() - 1000);
    await utimes(lock, old, old);
    await utimes(marker, old, old);

    const racingRegistry = new ScopeLeaseRegistry(root, {
      mutexStaleMs: 20,
      mutexRetries: 0,
      mutexRetryMs: 1,
    });
    const privateRegistry = racingRegistry as unknown as {
      mutexSnapshot(path: string): Promise<unknown>;
    };
    const originalSnapshot = privateRegistry.mutexSnapshot.bind(racingRegistry);
    let raced = false;
    privateRegistry.mutexSnapshot = async (path) => {
      if (!raced && path.includes(".scope-leases.stale.")) {
        raced = true;
        await utimes(path, new Date(), new Date());
      }
      return originalSnapshot(path);
    };
    await assert.rejects(
      () => racingRegistry.acquire({ scope: scope([], ["src/raced.ts"]) }),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "lock-timeout",
    );
    assert.equal(raced, true);
    assert.equal((await readdir(root)).filter((name) => name.startsWith(".scope-leases.stale.")).length, 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const recoveredRegistry = new ScopeLeaseRegistry(root, {
      mutexStaleMs: 20,
      mutexRetries: 5,
      mutexRetryMs: 1,
    });
    const recovered = await recoveredRegistry.acquire({ scope: scope([], ["src/raced.ts"]) });
    await recovered.release();
    assert.equal((await readdir(root)).some((name) => name.startsWith(".scope-leases.stale.")), false);

    const quarantineOwner = "00000000-0000-4000-8000-000000000002";
    const wrongOwner = "00000000-0000-4000-8000-000000000003";
    const malformed = join(
      root,
      `.scope-leases.stale.${quarantineOwner}.00000000-0000-4000-8000-000000000004`,
    );
    await mkdir(malformed);
    await writeFile(join(malformed, `owner.${wrongOwner}`), wrongOwner);
    await utimes(malformed, old, old);
    await assert.rejects(
      () => racingRegistry.acquire({ scope: scope([], ["src/malformed.ts"]) }),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "lock-timeout",
    );
    assert.equal((await stat(malformed)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a paused stale owner cannot overwrite a replacement lease after whole-lock takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-lease-stale-save-"));
  try {
    const staleRegistry = new ScopeLeaseRegistry(root, { mutexStaleMs: 20 });
    const privateRegistry = staleRegistry as unknown as {
      save(state: unknown, mutex: unknown): Promise<void>;
    };
    const originalSave = privateRegistry.save.bind(staleRegistry);
    let saveEntered!: () => void;
    let resumeSave!: () => void;
    const entered = new Promise<void>((resolve) => { saveEntered = resolve; });
    const paused = new Promise<void>((resolve) => { resumeSave = resolve; });
    privateRegistry.save = async (state, mutex) => {
      saveEntered();
      await paused;
      await originalSave(state, mutex);
    };

    const staleAcquire = staleRegistry.acquire({
      ownerId: "paused-owner",
      scope: scope([], ["src/shared.ts"]),
    });
    await entered;
    const lock = join(root, ".scope-leases.lock");
    const quarantine = join(root, ".scope-leases.stale.00000000-0000-4000-8000-000000000001.00000000-0000-4000-8000-000000000002");
    await rename(lock, quarantine);
    await rm(quarantine, { recursive: true });

    const replacementRegistry = new ScopeLeaseRegistry(root, { mutexStaleMs: 20 });
    const replacement = await replacementRegistry.acquire({
      ownerId: "replacement-owner",
      scope: scope([], ["src/shared.ts"]),
    });
    resumeSave();
    await assert.rejects(
      () => staleAcquire,
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "lock-lost",
    );
    await replacement.assertHeld();
    const state = JSON.parse(await readFile(join(root, "scope-leases.json"), "utf8")) as {
      revision: number;
      leases: Array<{ id: string }>;
    };
    assert.equal(state.revision, 1);
    assert.deepEqual(state.leases.map((lease) => lease.id), [replacement.id]);
    await assert.rejects(
      () => replacementRegistry.acquire({ scope: scope([], ["SRC/SHARED.TS"]) }),
      (error: unknown) => error instanceof ScopeLeaseError && error.code === "scope-conflict",
    );
    await replacement.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
