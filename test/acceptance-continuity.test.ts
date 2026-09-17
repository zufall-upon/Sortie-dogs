import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_CONTINUITY_EXTENSION,
  acceptanceContinuityFingerprint,
  inspectAcceptanceContinuity,
  MAX_ACCEPTANCE_CONTINUITY_BYTES,
  MAX_ACCEPTANCE_CRITERIA,
  normalizeAcceptanceCriteria,
} from "../src/core/acceptance-continuity.ts";

function handoff(criteria = ["Keep Forest unchanged.", "Match the exact visual reference."]) {
  return { ext: { [ACCEPTANCE_CONTINUITY_EXTENSION]: {
    schema_version: "0.1",
    authority: "dispatch",
    task_id: "visual-r1",
    criteria,
    fingerprint: acceptanceContinuityFingerprint(criteria),
    parent_fingerprint: "none",
  } } };
}

test("acceptance continuity canonicalizes NFC and LF without paraphrasing", () => {
  const criteria = ["Cafe\u0301\r\nreference", "No giant cubes"];
  const normalized = normalizeAcceptanceCriteria(criteria);
  assert.deepEqual(normalized, ["Café\nreference", "No giant cubes"]);
  const inspected = inspectAcceptanceContinuity(handoff(criteria));
  assert.equal(inspected.error, undefined);
  assert.deepEqual(inspected.ledger?.criteria, normalized);
  assert.equal(inspected.ledger?.fingerprint, acceptanceContinuityFingerprint(normalized));
});

test("acceptance continuity rejects drift, unknown fields, and oversize input", () => {
  const drifted = handoff();
  drifted.ext[ACCEPTANCE_CONTINUITY_EXTENSION].criteria[1] = "Broad visual quality";
  assert.equal(inspectAcceptanceContinuity(drifted).error, "malformed");

  const unknown = handoff() as Record<string, any>;
  unknown.ext[ACCEPTANCE_CONTINUITY_EXTENSION].unexpected = true;
  assert.equal(inspectAcceptanceContinuity(unknown).error, "malformed");

  const huge = { ext: { [ACCEPTANCE_CONTINUITY_EXTENSION]: "x".repeat(MAX_ACCEPTANCE_CONTINUITY_BYTES) } };
  assert.equal(inspectAcceptanceContinuity(huge).error, "oversize");
  assert.equal(inspectAcceptanceContinuity({}).error, "absent");
});

test("acceptance continuity carries the same criterion count the frozen intent admits", () => {
  assert.equal(MAX_ACCEPTANCE_CRITERIA, 64, "intent requirements, plans, and this ledger share one bound");
  const criterion = (index: number) => `Criterion ${index + 1} holds`;
  for (const count of [1, 24, 25, 27, MAX_ACCEPTANCE_CRITERIA]) {
    const criteria = Array.from({ length: count }, (_value, index) => criterion(index));
    const inspected = inspectAcceptanceContinuity(handoff(criteria));
    assert.equal(inspected.error, undefined, `${count} criteria must stay readable`);
    assert.deepEqual(inspected.ledger?.criteria, criteria, `${count} criteria must keep exact order`);
  }
  const excessive = Array.from({ length: MAX_ACCEPTANCE_CRITERIA + 1 }, (_value, index) => criterion(index));
  assert.equal(inspectAcceptanceContinuity(handoff(excessive)).error, "malformed");
  const wide = Array.from({ length: 30 }, (_value, index) => `${criterion(index)} `.padEnd(1500, "x"));
  assert.equal(inspectAcceptanceContinuity(handoff(wide)).error, "oversize");
});

test("acceptance continuity permits redundant criteria without weakening their ordered fingerprint", () => {
  const inspected = inspectAcceptanceContinuity(handoff(["preserve the boundary", "preserve the boundary"]));
  assert.equal(inspected.error, undefined);
  assert.deepEqual(inspected.ledger?.criteria, ["preserve the boundary", "preserve the boundary"]);
});
