import assert from "node:assert/strict";
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
