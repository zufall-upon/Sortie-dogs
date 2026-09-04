import assert from "node:assert/strict";
import test from "node:test";

import { retrySchedule } from "../output/unit-2.mjs";

test("builds a capped exponential retry schedule", () => {
  assert.deepEqual(retrySchedule({ attempts: 1, baseDelayMs: 100 }), []);
  assert.deepEqual(retrySchedule({ attempts: 5, baseDelayMs: 100, factor: 2, maxDelayMs: 500 }),
    [100, 200, 400, 500]);
  assert.deepEqual(retrySchedule({ attempts: 4, baseDelayMs: 2.4, factor: 1.5, maxDelayMs: 10 }), [2, 4, 5]);
});

test("rejects malformed retry options without mutating input", () => {
  for (const options of [{ attempts: 0, baseDelayMs: 1 }, { attempts: 11, baseDelayMs: 1 },
    { attempts: 2, baseDelayMs: 0 }, { attempts: 2, baseDelayMs: 1, factor: Infinity },
    { attempts: 2, baseDelayMs: 2, maxDelayMs: -1 }]) {
    assert.throws(() => retrySchedule(options));
  }
  const options = Object.freeze({ attempts: 2, baseDelayMs: 5 });
  assert.deepEqual(retrySchedule(options), [5]);
});
