import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { resolveOutputPath } from "../output/unit-5.mjs";

test("resolves normalized module paths beneath an absolute root", () => {
  const root = isAbsolute(process.cwd()) ? process.cwd() : join(process.cwd(), "fixture");
  assert.equal(resolveOutputPath(root, "output/unit-5.mjs"), join(root, "output", "unit-5.mjs"));
  assert.equal(resolveOutputPath(root, "output/a.b_c-1.mjs"), join(root, "output", "a.b_c-1.mjs"));
});

test("rejects traversal, non-module, hidden, and platform-specific spellings", () => {
  const root = process.cwd();
  for (const candidate of ["../output/a.mjs", "output/../a.mjs", "output\\a.mjs", "/output/a.mjs",
    "output/.hidden.mjs", "output/a.js", "output//a.mjs", "a.mjs"]) {
    assert.throws(() => resolveOutputPath(root, candidate));
  }
  assert.throws(() => resolveOutputPath("relative", "output/a.mjs"));
});
