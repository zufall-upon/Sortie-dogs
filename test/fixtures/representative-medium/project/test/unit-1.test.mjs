import assert from "node:assert/strict";
import test from "node:test";

import { parsePositiveInteger } from "../output/unit-1.mjs";

test("normalizes positive integer numbers and digit strings", () => {
  assert.equal(parsePositiveInteger(7), 7);
  assert.equal(parsePositiveInteger("42", "count"), 42);
  assert.equal(parsePositiveInteger("0003"), 3);
});

test("separates malformed values from out-of-range numbers", () => {
  for (const value of ["", " 1", "+1", "1.0", {}, null]) {
    assert.throws(() => parsePositiveInteger(value, "workers"), TypeError);
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", "9007199254740992"]) {
    assert.throws(() => parsePositiveInteger(value, "workers"), (error) =>
      error instanceof RangeError && error.message.includes("workers"));
  }
});
