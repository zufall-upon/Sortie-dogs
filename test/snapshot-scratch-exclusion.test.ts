import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { protectedSnapshot, refreshProtectedSnapshot, snapshotScratchExclusion, snapshotScratchExcluded,
  validationInputSnapshot } from "../dist/plugin/protected-snapshot.js";
import type { GoalEvidence } from "../dist/core/goal-bound.js";
import { validationScratchPaths } from "../dist/plugin/validation-scratch.js";

const run = promisify(exec), runFile = promisify(execFile);

test("prepared scratch comparisons preserve the previous lexical protection rules", () => {
  const root = resolve("_testenv/scratch-containment");
  const scratch = resolve(root, ".gocache"), module = resolve(root, ".gomodcache");
  const fixed = { scratch_paths: [scratch, module], protected_paths: [resolve(scratch, "tracked.go"), resolve(module, "actual-source") ] };
  const current = [resolve(scratch, "result.txt")];
  const binding = { freshness: fixed } as NonNullable<GoalEvidence["protected_binding"]>;
  const outside = (parent: string, path: string) => {
    const local = relative(parent, path).replaceAll("\\", "/");
    return local === ".." || local.startsWith("../") || isAbsolute(local);
  };
  const previous = (path: string) => fixed.scratch_paths.some(parent => !outside(parent, path)) &&
    ![...fixed.protected_paths, ...current].some(parent => !outside(parent, path) || !outside(path, parent));
  const prepared = snapshotScratchExclusion(binding, current);
  const paths = [root, scratch, module, resolve(root, ".gocache-other/file"), resolve(scratch, "tracked.go"),
    resolve(scratch, "tracked.go/child"), resolve(scratch, "result.txt"), resolve(scratch, "result.txt-other"),
    resolve(scratch, "aa/bb/blob"), resolve(module, "actual-source"), resolve(module, "actual-source/code.go"),
    resolve(module, "unrelated/cache"), resolve(root, "../external"), resolve(scratch, "a/../tracked.go"),
    resolve(root, ".gocache\\literal"), resolve(scratch, "..\\literal"), resolve(scratch, "component\\child")];
  if (process.platform === "win32") paths.push(...paths.map(path => path.toUpperCase()));
  for (const path of paths) {
    assert.equal(prepared(path), previous(path), path);
    assert.equal(snapshotScratchExcluded(binding, path, current), previous(path), path);
  }
  assert.equal(snapshotScratchExclusion({} as never)(resolve(scratch, "blob")), false, "legacy bindings gain no exclusion");
  const newer = [...current, resolve(scratch, "new-output")];
  assert.equal(snapshotScratchExclusion(binding, newer)(resolve(scratch, "new-output")), false);
  assert.equal(prepared(resolve(scratch, "new-output")), true, "only the call-local prepared view is retained");
  const literalBinding = { freshness: { scratch_paths: [resolve(root, "literal\\cache")],
    protected_paths: [resolve(root, "literal\\cache/protected\\file")] } } as NonNullable<GoalEvidence["protected_binding"]>;
  const literalExclusion = snapshotScratchExclusion(literalBinding);
  for (const path of [resolve(root, "literal\\cache/blob"), resolve(root, "literal/cache/blob"),
    resolve(root, "literal\\cache/protected\\file"), resolve(root, "literal\\cache/protected/file")]) {
    const old = literalBinding.freshness!.scratch_paths.some(parent => !outside(parent, path)) &&
      !literalBinding.freshness!.protected_paths.some(parent => !outside(parent, path) || !outside(path, parent));
    assert.equal(literalExclusion(path), old, path);
  }
});

test("configured inherited scratch is captured without guessing names, and command overrides win", () => {
  const root = resolve("_testenv/inherited-scratch"), cache = resolve(root, "compiler-output");
  const inherited = { GOCACHE: cache, TMPDIR: resolve(root, "temp-output"), GOPATH: resolve(root, "tool-path") };
  assert.deepEqual(validationScratchPaths(root, ["go test ./..."], inherited),
    [cache, resolve(root, "temp-output"), resolve(root, "tool-path/pkg/mod"), resolve(root, "tool-path/pkg/sumdb")].sort());
  assert.deepEqual(validationScratchPaths(root, ["go test ./..."]), [], "no ambient process environment is implicitly read by the helper");
  assert.deepEqual(validationScratchPaths(root, ['GOCACHE="new-cache" TMPDIR="" GOPATH="" go test ./...'], inherited),
    [resolve(root, "new-cache")]);
  assert.deepEqual(validationScratchPaths(root, ['GOCACHE="$UNRESOLVED" go test ./...'], { GOCACHE: cache }), []);
  assert.deepEqual(validationScratchPaths(root, ["GOCACHE=off go test ./..."], { GOCACHE: cache }), []);
  assert.deepEqual(validationScratchPaths(root, ["go test ./..."], { GOCACHE: resolve(root, "../external-cache"),
    TMPDIR: root, GOMODCACHE: resolve(root, ".git/cache"), GOPATH: resolve(root, ".opencode/tools") }), []);
});

test("npm scratch requires an unambiguous configured cache, with literal command overrides", () => {
  const root = resolve("_testenv/npm-scratch"), cwd = join(root, "checkout");
  const cache = join(root, ".sortie-env/npm-cache"), inherited = { npm_config_cache: cache };
  assert.deepEqual(validationScratchPaths(root, ["npm test"], inherited), [cache]);
  assert.deepEqual(validationScratchPaths(root, ["npm test"], { NPM_CONFIG_CACHE: cache }), [cache]);
  assert.deepEqual(validationScratchPaths(root, ["npm test"]), [], "the cache name alone is not a declaration");
  assert.deepEqual(validationScratchPaths(root, ['npm_config_cache="./new cache" npm test'], inherited, cwd),
    [join(cwd, "new cache")]);
  assert.deepEqual(validationScratchPaths(root, ['env npm_config_cache="$PWD/npm-cache" npm test'], inherited, cwd),
    [join(cwd, "npm-cache")]);
  for (const command of ['npm_config_cache="" npm test', 'npm_config_cache="$UNKNOWN" npm test',
    "npm_config_cache='$PWD/cache' npm test", "npm test --cache=./different",
    "npm_config_cache='~/cache' npm test", 'npm_config_cache=" ./cache " npm test',
    "env -u npm_config_cache npm test", "env -u 'npm_config_cache' npm test",
    'env -u"npm_config_cache" npm test', "env -unpm_config_cache npm test",
    'env --unset="npm_config_cache" npm test', "env '-u' npm_config_cache npm test",
    "env -u UNUSED -i npm test", "'env' --ignore-environment npm test",
    "env -i npm test", "npm test && npm_config_cache=./later npm test"]) {
    assert.deepEqual(validationScratchPaths(root, [command], inherited, cwd), [], command);
  }
  for (const value of ["~/cache", " cache", "cache "]) {
    assert.deepEqual(validationScratchPaths(root, ["npm test"], { npm_config_cache: value }, cwd), [], value);
  }
  assert.deepEqual(validationScratchPaths(root, ["env -u UNUSED npm test"], inherited), [cache],
    "removing an unrelated variable does not disable the configured cache");
  assert.deepEqual(validationScratchPaths(root, ["npm test"], { npm_config_cache: "$PWD/cache" }), [],
    "a literal inherited value must not be expanded as a shell assignment");
  assert.deepEqual(validationScratchPaths(root, ["cd checkout && npm test"], { npm_config_cache: "./cache" }), [],
    "relative cache paths with an unpinned command cwd stay visible");
  assert.deepEqual(validationScratchPaths(root, ["npm test"], { npm_config_cache: root }), []);
  assert.deepEqual(validationScratchPaths(root, ["npm test"], { npm_config_cache: join(root, ".git/cache") }), []);
  assert.deepEqual(validationScratchPaths(root, ["npm test"], { npm_config_cache: resolve(root, "../outside") }), []);
  if (process.platform !== "win32") {
    assert.deepEqual(validationScratchPaths(root, ["npm test"], { npm_config_cache: cache, NPM_CONFIG_CACHE: join(root, "other") }), [],
      "conflicting case variants cannot identify one safe exclusion");
  }
});

async function fixture(runFixture: (root: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/npm-scratch-"));
  const saved = Object.entries(process.env).filter(([key]) => /^npm_config_cache$/iu.test(key));
  for (const [key] of saved) delete process.env[key];
  try { await runFixture(root); } finally {
    for (const key of Object.keys(process.env).filter(key => /^npm_config_cache$/iu.test(key))) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
}

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

test("npm cache creation preserves real freshness without repairing legacy evidence", async () => fixture(async root => {
  const parent = join(root, ".sortie-env"), cache = join(parent, "npm-cache");
  await mkdir(parent);
  process.env.npm_config_cache = cache;
  const command = "npm cache verify", manifestPath = join(root, "manifest.json");
  const bytes = JSON.stringify({ version: "0.1.0", task_id: "unit", read: [root + "/**"],
    write: [root + "/**"], validation: [command] });
  await writeFile(manifestPath, bytes);
  const pinned = await protectedSnapshot({ projectRoot: root, manifestPath, manifestHash: hash(bytes) }, { directory: root, command });
  assert.ok(pinned?.binding.freshness);
  assert.deepEqual(pinned.binding.freshness.scratch_paths, [cache]);
  const saved = JSON.stringify(pinned.binding), inputs = await validationInputSnapshot(root, pinned.binding);
  const unchanged = { source: pinned.source, candidate: pinned.candidate };
  const older = structuredClone(pinned.binding);
  older.freshness!.scratch_paths = [];
  delete older.freshness!.environment["@npm_config_cache"];
  const oldInputs = await validationInputSnapshot(root, older), oldSnapshot = await refreshProtectedSnapshot(root, older);
  assert.ok(inputs && oldInputs && oldSnapshot);
  await run(command, { cwd: root });
  assert.ok((await readdir(cache)).length, "npm actually populated the configured cache");
  assert.equal(await validationInputSnapshot(root, pinned.binding), inputs);
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  const oldInputsAfter = await validationInputSnapshot(root, older), oldSnapshotAfter = await refreshProtectedSnapshot(root, older);
  assert.ok(oldInputsAfter && oldSnapshotAfter);
  assert.notEqual(oldInputsAfter, oldInputs);
  assert.notDeepEqual(oldSnapshotAfter, oldSnapshot, "old evidence gains no exclusion");
  await mkdir(join(parent, "npm-cache-neighbor"));
  await writeFile(join(parent, "npm-cache-neighbor/input"), "real input");
  const neighborInputs = await validationInputSnapshot(root, pinned.binding);
  assert.ok(neighborInputs);
  assert.notEqual(neighborInputs, inputs, "a similarly named directory stays visible");
  await rm(join(parent, "npm-cache-neighbor"), { recursive: true });
  process.env.npm_config_cache = join(parent, "other");
  let reason: string | undefined;
  assert.equal(await refreshProtectedSnapshot(root, pinned.binding, value => { reason = value; }), undefined);
  assert.equal(reason, "validation-environment-changed");
  assert.ok(await refreshProtectedSnapshot(root, older), "old evidence compares its saved environment recipe");
  process.env.npm_config_cache = cache;
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  assert.equal(JSON.stringify(pinned.binding), saved);
}));

test("npm cache exclusions are per call and preserve tracked, read and exact-output descendants", async () => fixture(async root => {
  const cache = join(root, "checkout/cache");
  await mkdir(join(cache, "fixtures"), { recursive: true });
  await runFile("git", ["init", "--quiet"], { cwd: root });
  for (const name of ["tracked", "fixtures/input", "deliverable"]) await writeFile(join(cache, name), "original");
  await runFile("git", ["add", "--", "checkout/cache/tracked"], { cwd: root });
  const commands = ["npm_config_cache=./cache npm test", "node check.mjs"], manifestPath = join(root, "manifest.json");
  const bytes = JSON.stringify({ version: "0.1.0", task_id: "unit",
    read: [root + "/**", "checkout/cache/fixtures/**"], write: [root + "/**", "checkout/cache/deliverable"], validation: commands });
  await writeFile(manifestPath, bytes);
  const authorization = { projectRoot: root, manifestPath, manifestHash: hash(bytes) }, directory = join(root, "checkout");
  const inheritedCache = join(directory, "inherited-cache");
  process.env.npm_config_cache = inheritedCache;
  const pinned = await protectedSnapshot(authorization, { directory, command: commands[0] });
  const other = await protectedSnapshot(authorization, { directory, command: commands[1] });
  const allCommands = await protectedSnapshot(authorization, { directory });
  assert.ok(pinned?.binding.freshness && other?.binding.freshness && allCommands?.binding.freshness);
  assert.deepEqual(pinned.binding.freshness.scratch_paths, [cache]);
  assert.deepEqual(other.binding.freshness.scratch_paths, [inheritedCache]);
  assert.deepEqual(allCommands.binding.freshness.scratch_paths, [cache, inheritedCache].sort());
  const saved = JSON.stringify(pinned.binding), inputs = await validationInputSnapshot(root, pinned.binding);
  assert.ok(inputs);
  const unchanged = { source: pinned.source, candidate: pinned.candidate };
  await writeFile(join(cache, "incidental"), "generated");
  assert.equal(await validationInputSnapshot(root, pinned.binding), inputs);
  assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), unchanged);
  const otherAfter = await refreshProtectedSnapshot(root, other.binding);
  assert.ok(otherAfter);
  assert.notEqual(otherAfter.source, other.source,
    "the other command does not acquire a cache exemption");
  await mkdir(inheritedCache);
  await writeFile(join(inheritedCache, "incidental"), "inherited output");
  assert.deepEqual(await refreshProtectedSnapshot(root, other.binding), otherAfter);
  const overrideChanged = await refreshProtectedSnapshot(root, pinned.binding);
  assert.ok(overrideChanged);
  assert.notEqual(overrideChanged.source, pinned.source, "the overridden inherited cache is not hidden from the first call");
  await rm(inheritedCache, { recursive: true });
  for (const name of ["tracked", "fixtures/input", "deliverable"]) {
    await writeFile(join(cache, name), "changed");
    const changedInputs = await validationInputSnapshot(root, pinned.binding);
    const changed = await refreshProtectedSnapshot(root, pinned.binding);
    assert.ok(changedInputs && changed, name);
    assert.notEqual(changedInputs, inputs, name);
    assert.notEqual(changed.source, pinned.source, name);
    assert.notEqual(changed.candidate, pinned.candidate, name);
    await writeFile(join(cache, name), "original");
  }
  await writeFile(join(cache, "fixtures/new-input"), "untracked declared input");
  const childInputs = await validationInputSnapshot(root, pinned.binding), childSnapshot = await refreshProtectedSnapshot(root, pinned.binding);
  assert.ok(childInputs && childSnapshot);
  assert.notEqual(childInputs, inputs, "declared input parents protect their children");
  assert.notDeepEqual(childSnapshot, unchanged);
  assert.equal(JSON.stringify(pinned.binding), saved);
}));

test("unresolved npm cache recipes and disabled calls keep their apparent cache inputs visible", async t => {
  for (const [label, value, command, apparentCache] of [
    ["npm home expansion", "~/cache", "npm cache verify", "~/cache"],
    ["npm whitespace trimming", " cache", "npm cache verify", " cache"],
    ["quoted env unset", "cache", "env -u 'npm_config_cache' node check.mjs", "cache"],
    ["attached env unset", "cache", "env -unpm_config_cache node check.mjs", "cache"],
    ["late env clear", "cache", "env -u UNUSED -i node check.mjs", "cache"],
    ["quoted env clear", "cache", "'env' --ignore-environment node check.mjs", "cache"],
  ] as const) await t.test(label, async () => fixture(async root => {
    process.env.npm_config_cache = value;
    const input = join(root, apparentCache, "input");
    await mkdir(join(root, apparentCache), { recursive: true });
    await writeFile(input, "original");
    const manifestPath = join(root, "manifest.json");
    const bytes = JSON.stringify({ version: "0.1.0", task_id: "unit", read: [root + "/**"],
      write: [root + "/**"], validation: [command] });
    await writeFile(manifestPath, bytes);
    const pinned = await protectedSnapshot({ projectRoot: root, manifestPath, manifestHash: hash(bytes) },
      { directory: root, command });
    assert.ok(pinned?.binding.freshness);
    const inputs = await validationInputSnapshot(root, pinned.binding);
    assert.ok(inputs);
    await writeFile(input, "changed");
    const changedInputs = await validationInputSnapshot(root, pinned.binding);
    const changed = await refreshProtectedSnapshot(root, pinned.binding);
    assert.ok(changedInputs && changed);
    assert.notEqual(changedInputs, inputs, "an unresolved or disabled cache setting cannot hide an input change");
    assert.notEqual(changed.source, pinned.source);
    assert.notEqual(changed.candidate, pinned.candidate);
    assert.deepEqual(pinned.binding.freshness.scratch_paths, []);
  }));
});
