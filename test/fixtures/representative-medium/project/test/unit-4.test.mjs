import assert from "node:assert/strict";
import test from "node:test";

import { reduceEvents } from "../output/unit-4.mjs";

test("reduces ordered lifecycle events and reports sorted active IDs", () => {
  assert.deepEqual(reduceEvents([
    { id: "z", type: "start" }, { id: "a", type: "start" }, { id: "z", type: "succeed" },
    { id: "b", type: "start" }, { id: "b", type: "fail" },
  ]), { started: 3, succeeded: 1, failed: 1, active: ["a"] });
});

test("rejects invalid transitions and malformed events", () => {
  for (const events of [[{ id: "a", type: "succeed" }],
    [{ id: "a", type: "start" }, { id: "a", type: "start" }],
    [{ id: "a", type: "unknown" }], [{ id: "", type: "start" }]]) {
    assert.throws(() => reduceEvents(events));
  }
});
