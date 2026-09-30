import assert from "node:assert/strict";
import { isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { snapshotScratchExclusion, snapshotScratchExcluded } from "../dist/plugin/protected-snapshot.js";
import type { GoalEvidence } from "../dist/core/goal-bound.js";

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
