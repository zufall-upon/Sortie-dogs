import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EvidenceCapsuleError,
  EvidenceCapsuleStore,
  evaluateEvidenceCapsuleFreshness,
  evidenceCapsuleHash,
  type EvidenceCapsule,
  MAX_EVIDENCE_CAPSULE_BYTES,
} from "../src/core/evidence-capsule.ts";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const root = fileURLToPath(new URL(`../_testenv/evidence-capsule-${process.pid}/`, import.meta.url));

const capsule = (): EvidenceCapsule => ({
  schema_version: "0.1",
  extractor_version: "extractor-1",
  sources: [{ path: "src/a.ts", blob_hash: hash("a"), symbol: "run", region: { start_line: 4, end_line: 9 } }],
  acceptance_links: [{ acceptance_id: "acceptance-1" }],
  risks: [{ kind: "concurrency", severity: "medium", summary: "Concurrent readers must share one bounded payload." }],
  validations: [{ command: "npm test", fingerprint: hash("b") }],
  provenance: { producer: "scout", revision: "r1", scope_fingerprint: hash("c") },
});

test.before(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("canonical hash ignores object key order and stored state is immutable from returned objects", async () => {
  const body = capsule();
  const reordered = {
    provenance: body.provenance, validations: body.validations, risks: body.risks,
    acceptance_links: body.acceptance_links, sources: body.sources,
    extractor_version: body.extractor_version, schema_version: body.schema_version,
  };
  assert.equal(evidenceCapsuleHash(body), evidenceCapsuleHash(reordered));

  const store = new EvidenceCapsuleStore(path.join(root, "immutable"));
  const saved = await store.put(body, ["src/a.ts"]);
  (saved.capsule.sources as Array<{ path: string }>)[0].path = "src/mutated.ts";
  const loaded = await store.lookup({ capsule_id: saved.capsule_id, declared_capsule_ids: [saved.capsule_id], authorized_source_paths: ["src/a.ts"] });
  assert.equal(loaded.capsule.sources[0].path, "src/a.ts");
  assert.deepEqual(loaded.reuse, { payload: true, source_content: false });
});

test("five concurrent callers resolve one canonical capsule without claiming source-content reuse", async () => {
  const store = new EvidenceCapsuleStore(path.join(root, "five-lanes"));
  const results = await Promise.all(Array.from({ length: 5 }, () => store.put(capsule(), ["src/a.ts"])));
  assert.equal(new Set(results.map((result) => result.capsule_id)).size, 1);
  assert.equal(results.filter((result) => result.status === "created").length, 1);
  assert.equal(results.filter((result) => result.reuse.payload).length, 4);
  assert.ok(results.every((result) => result.reuse.source_content === false));
});

test("parallel store instances publish one complete Windows-safe file", async () => {
  const directory = path.join(root, "parallel-writers");
  const [left, right] = await Promise.all([
    new EvidenceCapsuleStore(directory).put(capsule(), ["src/a.ts"]),
    new EvidenceCapsuleStore(directory).put(capsule(), ["src/a.ts"]),
  ]);
  assert.equal(left.capsule_id, right.capsule_id);
  const loaded = await new EvidenceCapsuleStore(directory).lookup({
    capsule_id: left.capsule_id, declared_capsule_ids: [left.capsule_id], authorized_source_paths: ["src/a.ts"],
  });
  assert.deepEqual(loaded.capsule, capsule());
});

test("lookup rejects undeclared identities and source references outside caller scope", async () => {
  const store = new EvidenceCapsuleStore(path.join(root, "scope"));
  const saved = await store.put(capsule(), ["src/a.ts"]);
  await assert.rejects(
    store.lookup({ capsule_id: saved.capsule_id, declared_capsule_ids: [], authorized_source_paths: ["src/a.ts"] }),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "undeclared",
  );
  await assert.rejects(
    store.lookup({ capsule_id: saved.capsule_id, declared_capsule_ids: [saved.capsule_id], authorized_source_paths: ["src/other.ts"] }),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "source_scope",
  );
  await assert.rejects(
    store.put(capsule(), ["src/other.ts"]),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "source_scope",
  );
});

test("freshness tracks relevant blobs only and a relevant blob change creates a new identity", async () => {
  const original = capsule();
  assert.deepEqual(evaluateEvidenceCapsuleFreshness(original, [
    { path: "src/a.ts", blob_hash: hash("a") }, { path: "src/unrelated.ts", blob_hash: hash("d") },
  ], ["src/a.ts"]), { status: "fresh", changed_relevant_paths: [] });
  assert.deepEqual(evaluateEvidenceCapsuleFreshness(original, [
    { path: "src/a.ts", blob_hash: hash("e") }, { path: "src/unrelated.ts", blob_hash: hash("a") },
  ], ["src/a.ts"]), { status: "stale", changed_relevant_paths: ["src/a.ts"] });

  const changed: EvidenceCapsule = {
    ...capsule(),
    sources: capsule().sources.map((source) => ({ ...source, blob_hash: hash("e") })),
  };
  const store = new EvidenceCapsuleStore(path.join(root, "freshness-identity"));
  const [originalResult, changedResult] = await Promise.all([
    store.put(original, ["src/a.ts"]),
    store.put(changed, ["src/a.ts"]),
  ]);
  assert.notEqual(changedResult.capsule_id, originalResult.capsule_id);
});

test("disk load detects corruption and capacity is bounded without eviction", async () => {
  const corruptDirectory = path.join(root, "corrupt");
  const corruptStore = new EvidenceCapsuleStore(corruptDirectory);
  const saved = await corruptStore.put(capsule(), ["src/a.ts"]);
  const storedPath = path.join(corruptDirectory, `${saved.capsule_id.replace(":", "-")}.json`);
  const stored = JSON.parse(await readFile(storedPath, "utf8")) as Record<string, unknown>;
  stored.extractor_version = "tampered";
  await writeFile(storedPath, JSON.stringify(stored), "utf8");
  await assert.rejects(
    corruptStore.lookup({ capsule_id: saved.capsule_id, declared_capsule_ids: [saved.capsule_id], authorized_source_paths: ["src/a.ts"] }),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "corrupt",
  );

  const capacityStore = new EvidenceCapsuleStore(path.join(root, "capacity"), { maxCapsules: 1 });
  await capacityStore.put(capsule(), ["src/a.ts"]);
  const second = capsule();
  (second as { extractor_version: string }).extractor_version = "extractor-2";
  await assert.rejects(
    capacityStore.put(second, ["src/a.ts"]),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "capacity",
  );
});

test("closed schema rejects unknown fields instead of retaining arbitrary metadata", async () => {
  const body = { ...capsule(), metadata: { raw: "not accepted" } };
  const directory = path.join(root, "closed");
  const store = new EvidenceCapsuleStore(directory);
  await assert.rejects(
    store.put(body as EvidenceCapsule, ["src/a.ts"]),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "invalid",
  );
  assert.deepEqual(await readdir(directory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }), []);
});

test("live lookup rejects stale, missing, and ambiguous source evidence while historical lookup survives", async () => {
  const store = new EvidenceCapsuleStore(path.join(root, "live-lookup"));
  const saved = await store.put(capsule(), ["src/a.ts"]);
  const request = { capsule_id: saved.capsule_id, declared_capsule_ids: [saved.capsule_id], authorized_source_paths: ["src/a.ts"] };
  const current = { path: "src/a.ts", blob_hash: hash("a") };
  const fresh = await store.lookupFresh(request, [current, { path: "src/other.ts", blob_hash: hash("e") }]);
  assert.equal(fresh.capsule_id, saved.capsule_id);
  for (const sources of [[], [{ ...current, blob_hash: hash("e") }]]) {
    await assert.rejects(store.lookupFresh(request, sources),
      (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "stale");
  }
  await assert.rejects(store.lookupFresh(request, [current, { ...current, path: "src\\a.ts", blob_hash: hash("e") }]),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "invalid");
  assert.deepEqual((await store.lookup(request)).capsule, capsule());
  await assert.rejects(store.lookupFresh({ ...request, declared_capsule_ids: [] }, [current]),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "undeclared");
  await assert.rejects(store.lookupFresh({ ...request, authorized_source_paths: [] }, [current]),
    (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "source_scope");
});

test("independent store instances enforce one shared capacity without evicting accepted evidence", async () => {
  const directory = path.join(root, "shared-capacity");
  const results = await Promise.allSettled(["left", "right"].map((revision) =>
    new EvidenceCapsuleStore(directory, { maxCapsules: 1 }).put({ ...capsule(), extractor_version: revision }, ["src/a.ts"])));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof EvidenceCapsuleError);
  assert.equal(rejected.reason.code, "capacity");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^sha256-[a-f0-9]{64}\.json$/u);
  const accepted = results.find(({ status }) => status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<EvidenceCapsuleStore["put"]>>>;
  assert.equal((await new EvidenceCapsuleStore(directory).lookup({ capsule_id: accepted.value.capsule_id,
    declared_capsule_ids: [accepted.value.capsule_id], authorized_source_paths: ["src/a.ts"] })).capsule_id, accepted.value.capsule_id);
});

test("oversized on-disk evidence is rejected before parsing and publication failures release their lock", async () => {
  const directory = path.join(root, "oversize-disk");
  const store = new EvidenceCapsuleStore(directory);
  const saved = await store.put(capsule(), ["src/a.ts"]);
  await writeFile(path.join(directory, `${saved.capsule_id.replace(":", "-")}.json`), "x".repeat(MAX_EVIDENCE_CAPSULE_BYTES + 1));
  const request = { capsule_id: saved.capsule_id, declared_capsule_ids: [saved.capsule_id], authorized_source_paths: ["src/a.ts"] };
  await assert.rejects(store.lookup(request), (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "oversize");
  await assert.rejects(store.put(capsule(), ["src/a.ts"]), (error: unknown) => error instanceof EvidenceCapsuleError && error.code === "oversize");
  assert.equal((await readdir(directory)).includes(".publish.lock"), false);
  await store.put({ ...capsule(), extractor_version: "another" }, ["src/a.ts"]);
});

test("five-lane payload deduplication is measured separately from source reads and model usage", async (t) => {
  const sourcePath = path.join(root, "measured-source.ts");
  await writeFile(sourcePath, "export function run() { return 1; }\n");
  let reads = 0;
  let extractions = 0;
  const extract = async (): Promise<EvidenceCapsule> => {
    reads += 1;
    const source = await readFile(sourcePath);
    extractions += 1;
    return { ...capsule(), sources: [{ path: "src/a.ts", blob_hash: `sha256:${createHash("sha256").update(source).digest("hex")}`, symbol: "run" }] };
  };
  const baseline = await Promise.all(Array.from({ length: 5 }, extract));
  const unshared = { source_reads: reads, extractions };
  reads = 0;
  extractions = 0;
  const directory = path.join(root, "measured-five-lanes");
  const shared = await Promise.all(Array.from({ length: 5 }, async () =>
    new EvidenceCapsuleStore(directory).put(await extract(), ["src/a.ts"])));
  assert.equal(new Set(shared.map(({ capsule_id }) => capsule_id)).size, 1);
  assert.ok(shared.every(({ capsule_id }) => capsule_id === evidenceCapsuleHash(baseline[0])));
  const withCapsules = { source_reads: reads, extractions,
    payload_creates: shared.filter(({ status }) => status === "created").length,
    payload_reuses: shared.filter(({ status }) => status === "reused").length };
  assert.deepEqual(unshared, { source_reads: 5, extractions: 5 });
  assert.deepEqual(withCapsules, { source_reads: 5, extractions: 5, payload_creates: 1, payload_reuses: 4 });
  assert.equal((await readdir(directory)).length, 1);
  // This fixture does not call a model. Payload reuse must not be presented as billed-token savings.
  t.diagnostic(JSON.stringify({ unshared, with_capsules: withCapsules,
    model_usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null }, token_savings_verified: false }));
});
