import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { protectedSnapshot, refreshProtectedSnapshot } from "../dist/plugin/protected-snapshot.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(run: (root: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/source-policy-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function pin(root: string, read: string[], write = ["result.txt"]) {
  const manifestPath = join(root, "manifest.json"), manifest = JSON.stringify({ read, write });
  await writeFile(manifestPath, manifest);
  const pinned = await protectedSnapshot({ projectRoot: root, manifestPath, manifestHash: hash(manifest) });
  assert.ok(pinned);
  return pinned;
}

test("live control changes do not invalidate source read directly or through a parent scope", async () => fixture(async root => {
  await writeFile(join(root, "result.txt"), "ready");
  let generation = 0;
  for (const read of [[".sortie-dogs-v010/missions"], [".sortie-dogs-v010", ".sortie-dogs", ".git"]]) {
    const pinned = await pin(root, read);
    for (const dir of [".sortie-dogs-v010/missions", ".sortie-dogs/runs", ".git/sortie-dogs/run-flight-v010"]) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "state.json"), JSON.stringify({ progress: ++generation }));
    }
    assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), { source: pinned.source, candidate: pinned.candidate });
  }
}));

test("real source, declared ignored artifacts, candidate and manifest changes still invalidate proof", async () => fixture(async root => {
  await mkdir(join(root, "_testenv"));
  await writeFile(join(root, "_testenv/observation.json"), "original");
  await writeFile(join(root, "result.txt"), "ready");
  const pinned = await pin(root, ["_testenv/observation.json", "missing.txt"]);
  await writeFile(join(root, "_testenv/observation.json"), "changed");
  let current = await refreshProtectedSnapshot(root, pinned.binding);
  assert.notEqual(current?.source, pinned.source);
  assert.equal(current?.candidate, pinned.candidate);
  await writeFile(join(root, "_testenv/observation.json"), "original");
  await writeFile(join(root, "missing.txt"), "new input");
  assert.notEqual((await refreshProtectedSnapshot(root, pinned.binding))?.source, pinned.source);
  await rm(join(root, "missing.txt"));
  await writeFile(join(root, "result.txt"), "modified output");
  assert.notEqual((await refreshProtectedSnapshot(root, pinned.binding))?.candidate, pinned.candidate);
  await writeFile(join(root, "manifest.json"), "{}");
  assert.equal(await refreshProtectedSnapshot(root, pinned.binding), undefined);
}));

test("an explicitly declared control-like output is still candidate-bound", async () => fixture(async root => {
  await mkdir(join(root, ".sortie-dogs-v010"));
  await writeFile(join(root, ".sortie-dogs-v010/result.json"), "first");
  const pinned = await pin(root, [], [".sortie-dogs-v010/result.json"]);
  await writeFile(join(root, ".sortie-dogs-v010/result.json"), "second");
  assert.notEqual((await refreshProtectedSnapshot(root, pinned.binding))?.candidate, pinned.candidate);
}));

test("similarly named directories and nested fixture controls remain real source", async () => fixture(async root => {
  await mkdir(join(root, "examples/.sortie-dogs-v010"), { recursive: true });
  await mkdir(join(root, ".sortie-dogs-v010-fixture"));
  await writeFile(join(root, "result.txt"), "ready");
  for (const path of ["examples/.sortie-dogs-v010", ".sortie-dogs-v010-fixture"]) {
    await writeFile(join(root, path, "input.json"), "first");
    const pinned = await pin(root, [path]);
    await writeFile(join(root, path, "input.json"), "second");
    assert.notEqual((await refreshProtectedSnapshot(root, pinned.binding))?.source, pinned.source);
  }
}));

test("legacy bindings retain their recipe rather than silently discarding changed control bytes", async () => fixture(async root => {
  await mkdir(join(root, ".sortie-dogs-v010"));
  await writeFile(join(root, ".sortie-dogs-v010/state.json"), "first");
  await writeFile(join(root, "result.txt"), "ready");
  const pinned = await pin(root, [".sortie-dogs-v010/state.json"]);
  const { source_policy: _policy, ...legacy } = pinned.binding;
  const old = await refreshProtectedSnapshot(root, legacy);
  const manifestHash = hash(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(old?.source, goalFingerprint({ manifest_hash: `sha256:${manifestHash}`, entries: [
    [".sortie-dogs-v010/state.json", "file", hash("first")], ["result.txt", "file", hash("ready")],
  ] }));
  await writeFile(join(root, ".sortie-dogs-v010/state.json"), "second");
  assert.notEqual((await refreshProtectedSnapshot(root, legacy))?.source, old?.source);
  assert.equal((await refreshProtectedSnapshot(root, pinned.binding))?.source, pinned.source);
}));
