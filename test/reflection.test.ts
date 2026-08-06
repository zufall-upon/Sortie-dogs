import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReflectionError, ReflectionStore, configRoot, estimateInjectionTokens, projectKey } from "../dist/reflection/index.js";

const input = { scope: "retry-policy", trigger: "one line", cause: "bounded retry repeated", prevention: "Use the bounded retry policy.", evidence: "repeated-process-failure", evidenceRef: "run-1" };

test("reflection store is bounded and deduplicates promotable entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-"));
  try {
    const store = new ReflectionStore(root, join(root, "project"));
    const first = await store.record("run", "r1", input, "0.2.12");
    const second = await store.record("run", "r1", input, "0.2.12");
    assert.equal(first.id, second.id);
    assert.equal(second.hits, 2);
    assert.equal((await store.read("run", "r1")).updatedAt, second.lastSeen);
    assert.match(await store.inject("run", "r1", 3, 500, "0.2.12"), /retry-policy/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid evidence and unsafe content do not mutate storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-"));
  try {
    const store = new ReflectionStore(root, root);
    await assert.rejects(() => store.record("project", "r1", { ...input, evidence: "unknown" }, "0.2.12"), ReflectionError);
    const redacted = await store.record("project", "r1", { ...input, prevention: "C:\\secret\\file" }, "0.2.12");
    assert.equal(redacted.prevention, "file");
    const prose = await store.record("project", "r2", { ...input, scope: "posix-path", prevention: "See /var/log/private.txt now" }, "0.2.12");
    assert.equal(prose.prevention, "See private.txt now");
    await assert.rejects(() => store.record("project", "r3", { ...input, evidenceRef: "logs/run.log:12" }, "0.2.12"), ReflectionError);
    await assert.rejects(() => store.record("project", "r4", { ...input, evidenceRef: "C:\\logs\\run" }, "0.2.12"), ReflectionError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project key is stable and future buckets are read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-"));
  try {
    const project = join(root, "project");
    const file = join(root, "projects", `${projectKey(project)}.json`);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "projects"), { recursive: true }));
    await writeFile(file, JSON.stringify({ v: 9, updatedAt: "x", entries: [] }));
    const store = new ReflectionStore(root, project);
    assert.deepEqual((await store.read("project")).entries, []);
    assert.equal(await readFile(file, "utf8"), JSON.stringify({ v: 9, updatedAt: "x", entries: [] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config root, ULID, promote, clear, and active injection are deterministic", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-")); const old = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(configRoot(), join(process.env.HOME ?? process.env.USERPROFILE!, ".config", "opencode"));
    process.env.XDG_CONFIG_HOME = join(root, "xdg"); assert.equal(configRoot(), join(root, "xdg", "opencode"));
    const store = new ReflectionStore(root, root);
    const entry = await store.record("run", "r", input, "1.0.0");
    await assert.rejects(() => store.promote("run", "r", entry.id, "fix-1", "1.0.0"), (error: unknown) => error instanceof ReflectionError && error.code === "reflection_not_promotable");
    assert.equal((await store.read("run", "r")).entries[0].status, "active");
    await store.record("run", "r", input, "1.0.0");
    assert.match(entry.id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
    assert.equal(await store.promote("run", "r", entry.id, "fix-1", "1.0.0"), "promoted");
    assert.equal((await store.read("run", "r", "1.0.0")).entries[0].promotedRef, "fix-1");
    assert.match(await store.inject("run", "r", 3, 500, "1.0.0"), /- retry-policy: /);
    await assert.rejects(() => store.clear("project", "r", "wrong", "1.0.0"), /reflection_confirmation_required/);
    assert.equal(await store.clear("run", "r", "", "1.0.0"), "cleared");
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; await rm(root, { recursive: true, force: true }); }
});

test("retention and promoted forgetting use semver comparison", async () => {
  let now = Date.now(); const root = await mkdtemp(join(tmpdir(), "sortie-reflection-"));
  try {
    const store = new ReflectionStore(root, root, { now: () => now });
    const entry = await store.record("project", undefined, { ...input, evidence: "user-correction" }, "1.0.0");
    await store.promote("project", undefined, entry.id, "ref", "1.0.0");
    assert.equal((await store.read("project", undefined, "1.0.1")).entries.length, 0);
    const prerelease = await store.record("project", undefined, { ...input, evidence: "user-correction" }, "2.0.0-beta.1");
    await store.promote("project", undefined, prerelease.id, "ref", "2.0.0-beta.1");
    assert.equal((await store.read("project", undefined, "2.0.0")).entries.length, 0);
    const equal = new ReflectionStore(root, root, { now: () => now });
    const future = await equal.record("project", undefined, { ...input, evidence: "user-correction" }, "3.0.0");
    await equal.promote("project", undefined, future.id, "ref", "3.0.0");
    const kept = await equal.read("project", undefined, "2.9.9"); assert.equal(kept.entries.length, 1);
    now += 31 * 86400000; assert.equal((await equal.read("project", undefined, "3.0.0")).entries.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt, stale-lock, abandoned-temp, v0, and run deletion behavior is safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-")); const warnings: string[] = [];
  try {
    const store = new ReflectionStore(root, root, { warn: (code) => warnings.push(code) });
    const file = join(root, "runs", "r.json"); await mkdir(join(root, "runs"), { recursive: true }); await writeFile(file, "{bad");
    assert.deepEqual((await store.read("run", "r")).entries, []); await store.read("run", "r"); assert.equal(warnings.filter((code) => code === "reflection_corrupt_json").length, 1); assert.equal((await readdir(join(root, "runs"))).some((name) => name.startsWith("r.json.corrupt.")), true);
    await writeFile(`${file}.tmp`, "junk"); await store.read("run", "r"); assert.equal(await stat(`${file}.tmp`).catch(() => undefined), undefined);
    await writeFile(`${file}.lock`, "lock"); await utimes(`${file}.lock`, new Date(Date.now() - 6000), new Date(Date.now() - 6000)); await store.record("run", "r", input, "1.0.0");
    const v0 = join(root, "runs", "v0.json"); const legacy = { v: 0, updatedAt: new Date().toISOString(), entries: [] }; await writeFile(v0, JSON.stringify(legacy)); await store.record("run", "v0", input, "1.0.0"); assert.equal(JSON.parse(await readFile(v0, "utf8")).v, 1); assert.equal(await stat(`${v0}.v0.bak`).then(() => true), true);
    await writeFile(`${file}.v0.bak`, "legacy"); await writeFile(`${file}.corrupt.old`, "bad"); await writeFile(`${file}.left.tmp`, "temp");
    await store.deleteRun("r"); assert.equal(await stat(file).catch(() => undefined), undefined); assert.equal((await readdir(join(root, "runs"))).some((name) => name.startsWith("r.json.")), false);
    const absentRoot = join(root, "absent"); await new ReflectionStore(absentRoot, root).deleteRun("none"); assert.equal(await stat(absentRoot).catch(() => undefined), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live lock is not stolen after its stale threshold, and stale guards recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-")); let now = Date.now();
  try {
    const store = new ReflectionStore(root, root, { now: () => now, sleep: async () => undefined }); const file = join(root, "runs", "race.json"); await mkdir(join(root, "runs"), { recursive: true });
    const old = await (store as any).lock(file); now += 6001;
    await assert.rejects(() => (store as any).lock(file), (error: unknown) => error instanceof ReflectionError && error.code === "reflection_lock_timeout");
    await (store as any).release(old);
    const replacement = await (store as any).lock(file);
    await (store as any).release(replacement);
    assert.equal(await stat(`${file}.lock`).catch(() => undefined), undefined);
    await writeFile(`${file}.lock.guard`, "abandoned"); await utimes(`${file}.lock.guard`, new Date(now - 6001), new Date(now - 6001));
    const guard = await (store as any).pathGuard(file); assert.ok(guard); await (store as any).releaseGuard(guard);
    const failedPath = join(root, "runs", "failed.json.lock"), failing = new ReflectionStore(root, root) as any;
    failing.heartbeat = async () => { throw new Error("injected"); };
    await assert.rejects(() => failing.acquire(failedPath)); assert.equal(await stat(failedPath).catch(() => undefined), undefined);
    const leaseFile = join(root, "runs", "lease.json.lock"); await writeFile(leaseFile, JSON.stringify({ pid: 4242, token: "reused" })); await utimes(leaseFile, new Date(now - 61_000), new Date(now - 61_000));
    const finite = new ReflectionStore(root, root, { now: () => now, sleep: async () => undefined, processAlive: () => true }); const lease = await (finite as any).lock(join(root, "runs", "lease.json")); await (finite as any).release(lease);
    await store.record("run", "race", input, "1.0.0"); await store.record("run", "race", { ...input, scope: "race-two" }, "1.0.0");
    assert.equal((await store.read("run", "race")).entries.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("clear and retained-layer reads remove eligible bucket artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-")); let now = Date.now();
  try {
    const store = new ReflectionStore(root, root, { now: () => now }); await store.record("run", "clear", input, "1.0.0"); const run = join(root, "runs", "clear.json"); await writeFile(`${run}.corrupt.old`, "bad"); await writeFile(`${run}.v0.bak`, "old"); await store.clear("run", "clear", "", "1.0.0"); assert.equal((await readdir(join(root, "runs"))).some((name) => name.startsWith("clear.json.")), false);
    await store.record("project", undefined, input, "1.0.0"); await store.record("global", undefined, input, "1.0.0"); const project = join(root, "projects", `${projectKey(root)}.json.corrupt.old`), global = join(root, "global.json.v0.bak"); await writeFile(project, "bad"); await writeFile(global, "old"); now += 91 * 86400000; await store.read("project"); await store.read("global"); assert.equal(await stat(project).catch(() => undefined), undefined); assert.equal(await stat(global).catch(() => undefined), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prohibited input is rejected without creating or changing storage", async () => {
  const fixtures = ["a\nb", "a\tb", "\u0001", "```code```", "api key: x", "password=x", "secret=x", "token=x", "private key", "https://user:pass@example.test", "https://example.test", "abcdef0123456789abcdef0123456789", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "--- a/file"];
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-"));
  try { const store = new ReflectionStore(root, root); for (const value of fixtures) { await assert.rejects(() => store.record("run", `r-${fixtures.indexOf(value)}`, { ...input, prevention: value }, "1.0.0"), ReflectionError); } assert.equal(await stat(join(root, "runs")).catch(() => undefined), undefined); } finally { await rm(root, { recursive: true, force: true }); }
});

test("caps, total injection budget, and concurrent records preserve successful scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-"));
  try {
    const store = new ReflectionStore(root, root); const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.record("run", "concurrent", { ...input, scope: `scope-${i}`, prevention: `prevention-${i}` }, "1.0.0")));
    const successful = results.filter((result): result is PromiseFulfilledResult<unknown> => result.status === "fulfilled"); for (const result of results) if (result.status === "rejected") assert.equal((result.reason as ReflectionError).code, "reflection_lock_timeout"); const bucket = await store.read("run", "concurrent"); assert.equal(bucket.entries.length, successful.length); for (const result of successful) assert.ok(bucket.entries.some((entry) => entry.id === (result.value as { id: string }).id));
    for (let i = 0; i < 14; i++) await store.record("run", "cap", { ...input, scope: `cap-${i}`, prevention: `p-${i}` }, "1.0.0"); assert.equal((await store.read("run", "cap")).entries.length, 12);
    const output = await store.injectBuckets([{ layer: "run", run: "cap" }], 3, 600, "1.0.0"); assert.ok(estimateInjectionTokens(`${output}漢字`) <= 600); assert.equal(output, await store.injectBuckets([{ layer: "run", run: "cap" }], 3, 600, "1.0.0")); assert.match(output, /^- [a-z0-9-]+: /u);
    const duplicate = await store.injectBuckets([{ layer: "run", run: "cap" }, { layer: "run", run: "concurrent" }], 20, 5000, "1.0.0"); assert.equal(new Set(duplicate.split("\n").map((line) => line.split(":")[0])).size, duplicate.split("\n").length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid loaded v1 entries are quarantined and never injected", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-")); const warnings: string[] = [];
  try {
    const store = new ReflectionStore(root, root, { warn: (code) => warnings.push(code) });
    const entry = await store.record("run", "invalid", input, "1.0.0"); const file = join(root, "runs", "invalid.json"); const bucket = JSON.parse(await readFile(file, "utf8")); bucket.entries[0].evidenceRef = "/var/log/run.log"; await writeFile(file, JSON.stringify(bucket));
    assert.equal((await store.inject("run", "invalid", 3, 500, "1.0.0")), ""); assert.equal(warnings.filter((code) => code === "reflection_corrupt_json").length, 1); assert.ok(entry.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("run identifiers cannot escape the reflection root", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-reflection-"));
  try {
    const store = new ReflectionStore(root, root);
    await assert.rejects(() => store.record("run", "../escape", input, "1.0.0"), (error: unknown) => error instanceof ReflectionError && error.code === "reflection_invalid_run");
    assert.equal(await stat(join(root, "runs")).catch(() => undefined), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
