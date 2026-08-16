import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
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
