import assert from "node:assert/strict";
import test from "node:test";

import { weightedBatches } from "../output/unit-3.mjs";

test("greedily batches original items while preserving order", () => {
  const items = [{ id: "a", weight: 2 }, { id: "b", weight: 3 }, { id: "c", weight: 4 },
    { id: "d", weight: 1 }];
  const batches = weightedBatches(items, 5);
  assert.deepEqual(batches, [[items[0], items[1]], [items[2], items[3]]]);
  assert.equal(batches[0][0], items[0]);
  assert.deepEqual(weightedBatches([], 5), []);
});

test("rejects invalid limits, items, duplicate IDs, and overweight items", () => {
  for (const [items, limit] of [[[], 0], [[{ id: "", weight: 1 }], 2], [[{ id: "a", weight: 0 }], 2],
    [[{ id: "a", weight: 3 }], 2], [[{ id: "a", weight: 1 }, { id: "a", weight: 1 }], 2]]) {
    assert.throws(() => weightedBatches(items, limit));
  }
});
