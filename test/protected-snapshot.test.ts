import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { operationInputSnapshot, protectedSnapshot, refreshProtectedSnapshot, validatedSourceSnapshot, validationInputSnapshot } from "../dist/plugin/protected-snapshot.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const exec = promisify(execFile);
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

async function validationPin(root: string, read: string[], write: string[], validation: string[]) {
  const manifestPath = join(root, "manifest.json"), manifest = JSON.stringify({ version: "0.1.0", task_id: "unit", read, write, validation });
  await writeFile(manifestPath, manifest);
  const pinned = await protectedSnapshot({ projectRoot: root, manifestPath, manifestHash: hash(manifest) });
  assert.ok(pinned?.binding.freshness);
  return pinned;
}

test("concrete validation protects newly tracked source inside old scratch without rewriting its recipe", async () => fixture(async root => {
  await exec("git", ["init", "--quiet"], { cwd: root });
  await mkdir(join(root, ".tmp"));
  await writeFile(join(root, "input.txt"), "checked input");
  const pinned = await validationPin(root, ["input.txt"], [".tmp/**"], ["TMPDIR=.tmp node check.mjs"]);
  const binding = { ...pinned.binding, validation_policy: "inputs-and-concrete-outputs-v1" as const };
  const saved = JSON.stringify(binding), before = await validatedSourceSnapshot(root, binding);
  assert.ok(before);
  await writeFile(join(root, ".tmp", "report.md"), "incidental report");
  assert.deepEqual(await refreshProtectedSnapshot(root, binding), { source: before, candidate: before });
  await writeFile(join(root, ".tmp", "source.js"), "new real source");
  await exec("git", ["add", "--", ".tmp/source.js"], { cwd: root });
  const after = await refreshProtectedSnapshot(root, binding);
  assert.notEqual(after?.source, before);
  assert.equal(JSON.stringify(binding), saved, "current protections tighten the comparison, never mutate historical evidence");
}));

test("concrete validation sees materialized exact outputs after an authorized scope addition", async () => fixture(async root => {
  await writeFile(join(root, "input.txt"), "checked input");
  const pinned = await validationPin(root, ["input.txt"], ["outputs/**"], ["node check.mjs"]);
  const binding = { ...pinned.binding, validation_policy: "inputs-and-concrete-outputs-v1" as const };
  const before = await validatedSourceSnapshot(root, binding);
  assert.ok(before);
  const manifestPath = join(root, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.write.push("extra-source.js");
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.deepEqual(await refreshProtectedSnapshot(root, binding), { source: before, candidate: before }, "an absent grant is not new source");
  await writeFile(join(root, "extra-source.js"), "new delivered source");
  assert.notEqual((await refreshProtectedSnapshot(root, binding))?.source, before);
}));

test("external source/candidate inventory reuse never survives a refresh", async () => fixture(async root => fixture(async external => {
  const file = join(external, "installed.js");
  await writeFile(file, "before");
  const pinned = await pin(root, [external], [external]);
  const before = await refreshProtectedSnapshot(root, pinned.binding);
  assert.deepEqual(before, { source: pinned.source, candidate: pinned.candidate });
  await writeFile(file, "after");
  const after = await refreshProtectedSnapshot(root, pinned.binding);
  assert.ok(after);
  assert.notEqual(after.source, before!.source);
  assert.notEqual(after.candidate, before!.candidate);
  await rm(file);
  assert.notDeepEqual(await refreshProtectedSnapshot(root, pinned.binding), after);
})));

test("new whole-project candidate proof ignores host bookkeeping but pins real and explicitly declared outputs", async () => fixture(async root => {
  await exec("git", ["init", "--quiet"], { cwd: root });
  await mkdir(join(root, ".sortie-dogs-v010/operators"), { recursive: true });
  await writeFile(join(root, "result.txt"), "verified source");
  await writeFile(join(root, ".sortie-dogs-v010/operators/root.json"), "before");
  const pinned = await validationPin(root, [root + "/**"], [root + "/**"], ["node check.mjs"]);
  const saved = JSON.stringify(pinned.binding), unchanged = { source: pinned.source, candidate: pinned.candidate };
  await writeFile(join(root, ".sortie-dogs-v010/operators/root.json"), "host settled validation and Worker");
  await writeFile(join(root, ".git/host-observation"), "bookkeeping");
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged,
    "the host's post-formal state transition is not a code edit");
  for (const path of ["result.txt", ".sortie-dogs-v010-neighbor/source.txt", "nested/.git/fixture.txt"]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "unverified output");
    assert.notDeepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged, path);
    if (path === "result.txt") await writeFile(join(root, path), "verified source");
    else await rm(join(root, path.split("/")[0]!), { recursive: true });
  }
  assert.equal(JSON.stringify(pinned.binding), saved, "never recapture or rewrite saved proof");
  const explicit = await validationPin(root, [root + "/**"], [root + "/**", ".sortie-dogs-v010/operators/root.json"], ["node check.mjs"]);
  await writeFile(join(root, ".sortie-dogs-v010/operators/root.json"), "changed explicit output");
  assert.notEqual((await refreshProtectedSnapshot(root, explicit.binding))?.candidate, explicit.candidate,
    "explicit control-like outputs remain bound even alongside broad project scope");
}));

test("old whole-project candidate recipes never gain bookkeeping exclusions retroactively", async () => fixture(async root => {
  await exec("git", ["init", "--quiet"], { cwd: root });
  await mkdir(join(root, ".sortie-dogs-v010/operators"), { recursive: true });
  await writeFile(join(root, ".sortie-dogs-v010/operators/root.json"), "before");
  const pinned = await validationPin(root, [root + "/**"], [root + "/**"], ["node check.mjs"]);
  const older = structuredClone(pinned.binding);
  delete older.candidate_policy;
  const oldSnapshot = await refreshProtectedSnapshot(root, older), oldRecipe = JSON.stringify(older);
  assert.ok(oldSnapshot);
  await writeFile(join(root, ".sortie-dogs-v010/operators/root.json"), "after");
  assert.notEqual((await refreshProtectedSnapshot(root, older))?.candidate, oldSnapshot.candidate);
  assert.equal(JSON.stringify(older), oldRecipe);
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), { source: pinned.source, candidate: pinned.candidate });
}));

test("fixed validation scratch ignores generation/cleanup but protects read, tracked and exact deliverables", async () => fixture(async root => {
  await exec("git", ["init", "--quiet"], { cwd: root });
  await mkdir(join(root, ".tmp"));
  await mkdir(join(root, "parser"));
  for (const path of [".tmp/input", ".tmp/tracked", ".tmp/deliverable", "parser/y.output", "result.txt"]) await writeFile(join(root, path), "original");
  await exec("git", ["add", "--", ".tmp/tracked"], { cwd: root });
  const pinned = await validationPin(root, [".tmp/input", "parser/y.output"], [".tmp/**", ".tmp/deliverable", "result.txt"], [`TMPDIR=${root}/.tmp node check.mjs`]);
  const original = JSON.stringify(pinned.binding);
  const unchanged = { source: pinned.source, candidate: pinned.candidate };
  await writeFile(join(root, ".tmp/cache"), "cache bytes");
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  await rm(join(root, ".tmp/cache"));
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  for (const path of [".tmp/input", ".tmp/tracked", ".tmp/deliverable", "parser/y.output", "result.txt"]) {
    await writeFile(join(root, path), "changed");
    assert.notDeepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged, `${path} must stay protected`);
    await writeFile(join(root, path), "original");
  }
  assert.equal(JSON.stringify(pinned.binding), original, "freshness never rewrites the old execution binding");
}));

test("a broad project read excludes inherited compiler outputs, but source and configured environment stay bound", async () => fixture(async root => {
  const previous = process.env.GOCACHE;
  process.env.GOCACHE = join(root, "compiler-output");
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/input.go"), "original source");
    await exec("git", ["add", "--", "src/input.go"], { cwd: root });
    const pinned = await validationPin(root, [root + "/**"], ["src/**"], ["go test ./..."]);
    const saved = JSON.stringify(pinned.binding), inputs = await validationInputSnapshot(root, pinned.binding);
    const unchanged = { source: pinned.source, candidate: pinned.candidate };
    await mkdir(process.env.GOCACHE);
    await writeFile(join(process.env.GOCACHE, "generated-cache"), "compiler bytes");
    assert.equal(await validationInputSnapshot(root, pinned.binding), inputs);
    assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
    await writeFile(join(root, "src/input.go"), "modified source");
    assert.notEqual(await validationInputSnapshot(root, pinned.binding), inputs);
    await writeFile(join(root, "src/input.go"), "original source");
    await mkdir(join(root, "compiler-output-neighbor"));
    await writeFile(join(root, "compiler-output-neighbor/input"), "real untracked input");
    assert.notEqual(await validationInputSnapshot(root, pinned.binding), inputs, "similarly named directories are not ignored");
    await rm(join(root, "compiler-output-neighbor"), { recursive: true });
    process.env.GOCACHE = join(root, "other-cache");
    assert.equal(await refreshProtectedSnapshot(root, pinned.binding), undefined, "changed inherited configuration is not old proof");
    assert.equal(JSON.stringify(pinned.binding), saved, "saved proof is never rewritten");
  } finally { if (previous === undefined) delete process.env.GOCACHE; else process.env.GOCACHE = previous; }
}));

test("broad reads still protect explicit cache inputs, tracked files and exact deliverables", async () => fixture(async root => {
  const previous = process.env.GOCACHE;
  process.env.GOCACHE = join(root, "compiler-output");
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await mkdir(process.env.GOCACHE);
    for (const path of ["input", "tracked.go", "deliverable"]) await writeFile(join(process.env.GOCACHE, path), "original");
    await exec("git", ["add", "--", "compiler-output/tracked.go"], { cwd: root });
    const pinned = await validationPin(root, [root + "/**", "compiler-output/input"],
      ["compiler-output/**", "compiler-output/deliverable"], ["go test ./..."]);
    const inputs = await validationInputSnapshot(root, pinned.binding), unchanged = { source: pinned.source, candidate: pinned.candidate };
    await writeFile(join(process.env.GOCACHE, "cache"), "generated cache");
    assert.equal(await validationInputSnapshot(root, pinned.binding), inputs);
    assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
    for (const path of ["input", "tracked.go", "deliverable"]) {
      await writeFile(join(process.env.GOCACHE, path), "changed");
      assert.notEqual(await validationInputSnapshot(root, pinned.binding), inputs, path);
      assert.notDeepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged, path);
      await writeFile(join(process.env.GOCACHE, path), "original");
    }
  } finally { if (previous === undefined) delete process.env.GOCACHE; else process.env.GOCACHE = previous; }
}));

test("older broad-read proof retains its cache and environment recipe rather than gaining new exclusions", async () => fixture(async root => {
  const previous = process.env.GOCACHE;
  process.env.GOCACHE = join(root, "compiler-output");
  try {
    await mkdir(process.env.GOCACHE);
    await writeFile(join(process.env.GOCACHE, "cache"), "old bytes");
    const pinned = await validationPin(root, [root + "/**"], ["result.txt"], ["go test ./..."]);
    const older = structuredClone(pinned.binding);
    older.freshness!.scratch_paths = [];
    older.freshness!.protected_paths.push(root);
    for (const key of ["TMPDIR", "GOCACHE", "GOMODCACHE", "GOPATH"]) delete older.freshness!.environment[key];
    const inputs = await validationInputSnapshot(root, older);
    assert.ok(inputs, "the old environment recipe remains readable");
    await writeFile(join(process.env.GOCACHE, "cache"), "new compiler bytes");
    assert.notEqual(await validationInputSnapshot(root, older), inputs, "no retroactive freshness repair");
    const current = await validationInputSnapshot(root, pinned.binding);
    await writeFile(join(process.env.GOCACHE, "cache"), "another compiler output");
    assert.equal(await validationInputSnapshot(root, pinned.binding), current);
  } finally { if (previous === undefined) delete process.env.GOCACHE; else process.env.GOCACHE = previous; }
}));

test("scope-only grants preserve proof; new real output, input, check and environment changes invalidate it", async () => fixture(async root => {
  await writeFile(join(root, "input.tmp"), "real input");
  await writeFile(join(root, "result.txt"), "verified");
  const pinned = await validationPin(root, ["input.tmp"], ["result.txt"], ["node check.mjs $SORTIE_TEST_INPUT_ENV"]);
  const unchanged = { source: pinned.source, candidate: pinned.candidate };
  const source = await readFile(join(root, "manifest.json"), "utf8"), manifest = JSON.parse(source);
  manifest.write.push("unused-output/**");
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  await mkdir(join(root, "unused-output"));
  await writeFile(join(root, "unused-output/result"), "new unverified output");
  assert.notDeepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  await rm(join(root, "unused-output"), { recursive: true });
  await writeFile(join(root, "input.tmp"), "changed");
  assert.notEqual((await refreshProtectedSnapshot(root, pinned.binding))?.source, pinned.source);
  await writeFile(join(root, "input.tmp"), "real input");
  for (const [key, value] of [["read", ["input.tmp", "another-input"]], ["validation", ["node other-check.mjs"]]]) {
    await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, [key]: value }));
    assert.equal(await refreshProtectedSnapshot(root, pinned.binding), undefined);
  }
  await writeFile(join(root, "manifest.json"), source);
  for (const key of ["GOFLAGS", "SORTIE_TEST_INPUT_ENV"]) {
    const previous = process.env[key];
    try { process.env[key] = "meaningful-change"; assert.equal(await refreshProtectedSnapshot(root, pinned.binding), undefined); }
    finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
}));

test("legacy PASS never gains scratch exclusions or scope-only compatibility retroactively", async () => fixture(async root => {
  await mkdir(join(root, ".tmp"));
  await writeFile(join(root, ".tmp/cache"), "old bytes");
  const manifestPath = join(root, "manifest.json"), manifest = JSON.stringify({ version: "0.1.0", task_id: "unit", read: [], write: [".tmp/**"],
    validation: [`TMPDIR=${root}/.tmp node check.mjs`] });
  await writeFile(manifestPath, manifest);
  const pinned = await protectedSnapshot({ projectRoot: root, manifestPath, manifestHash: hash(manifest) }, { captureFreshness: false });
  assert.ok(pinned);
  assert.equal(pinned.binding.freshness, undefined);
  await rm(join(root, ".tmp/cache"));
  assert.notEqual((await refreshProtectedSnapshot(root, pinned.binding))?.candidate, pinned.candidate);
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifest), write: [".tmp/**", "new/**"] }));
  assert.equal(await refreshProtectedSnapshot(root, pinned.binding), undefined);
}));

for (const promotion of ["exact-output", "tracked-source"]) test(`a new ${promotion} inside old scratch invalidates immutable PASS`, async () => fixture(async root => {
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "result.txt"), "verified");
  const pinned = await validationPin(root, [], ["result.txt", ".tmp/**"], [`TMPDIR=${root}/.tmp node check.mjs`]);
  const saved = JSON.stringify(pinned.binding), unchanged = { source: pinned.source, candidate: pinned.candidate };
  await mkdir(join(root, ".tmp"));
  await writeFile(join(root, ".tmp/cache"), "cache only");
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  if (promotion === "exact-output") {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.write.push(".tmp/new-deliverable.txt");
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged, "an absent scope-only grant creates no output");
  }
  await writeFile(join(root, ".tmp/new-deliverable.txt"), "unverified output");
  if (promotion === "tracked-source") await exec("git", ["add", "--", ".tmp/new-deliverable.txt"], { cwd: root });
  const current = await refreshProtectedSnapshot(root, pinned.binding);
  assert.notEqual(current?.source, pinned.source);
  assert.notEqual(current?.candidate, pinned.candidate);
  assert.equal(JSON.stringify(pinned.binding), saved, "old proof is never recaptured or relabelled");
}));

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

test("operation output creation preserves input identity but input changes do not", async () => fixture(async root => {
  await mkdir(join(root, "work"));
  await writeFile(join(root, "work/run.mjs"), "original");
  const pinned = await pin(root, ["work"], ["work/result.json"]);
  const inputs = await operationInputSnapshot(root, pinned.binding);
  assert.ok(inputs);
  await writeFile(join(root, "work/result.json"), "result");
  assert.equal(await operationInputSnapshot(root, pinned.binding), inputs);
  assert.notEqual((await refreshProtectedSnapshot(root, pinned.binding))?.source, pinned.source);
  await writeFile(join(root, "work/run.mjs"), "modified");
  assert.notEqual(await operationInputSnapshot(root, pinned.binding), inputs);
  await writeFile(join(root, "manifest.json"), "{}");
  assert.equal(await operationInputSnapshot(root, pinned.binding), undefined);
}));

test("project-local tool dependency directory symlinks remain verifiable, but external links do not", async () => fixture(async root => {
  await mkdir(join(root, ".sortie-env/node_modules/pkg"), { recursive: true });
  await writeFile(join(root, ".sortie-env/node_modules/pkg/index.js"), "first");
  await symlink(".sortie-env/node_modules", join(root, "node_modules"), "dir");
  const pinned = await pin(root, ["input.txt"], ["result.txt", "node_modules/**"]);
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), { source: pinned.source, candidate: pinned.candidate });
  await writeFile(join(root, ".sortie-env/node_modules/pkg/index.js"), "second");
  const changed = await refreshProtectedSnapshot(root, pinned.binding);
  assert.ok(changed);
  assert.notEqual(changed.candidate, pinned.candidate);
  await rm(join(root, "node_modules"));
  await symlink(resolve("_testenv"), join(root, "node_modules"), "dir");
  assert.equal(await protectedSnapshot({ projectRoot: root, manifestPath: join(root, "manifest.json"),
    manifestHash: hash((await readFile(join(root, "manifest.json"))).toString("utf8")) }), undefined);
  await rm(join(root, "node_modules"));
  await symlink(".sortie-env/node_modules", join(root, "node_modules"), "dir");
  await symlink("../..", join(root, ".sortie-env/node_modules/loop"), "dir");
  assert.equal(await refreshProtectedSnapshot(root, pinned.binding), undefined, "internal directory cycles cannot become evidence");
}));
