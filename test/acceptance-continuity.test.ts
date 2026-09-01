import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_CONTINUITY_EXTENSION,
  acceptanceContinuityFingerprint,
  inspectAcceptanceContinuity,
  MAX_ACCEPTANCE_CONTINUITY_BYTES,
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

test("acceptance continuity rejects drift, unknown fields, duplicates, and oversize input", () => {
  const drifted = handoff();
  drifted.ext[ACCEPTANCE_CONTINUITY_EXTENSION].criteria[1] = "Broad visual quality";
  assert.equal(inspectAcceptanceContinuity(drifted).error, "malformed");

  const unknown = handoff() as Record<string, any>;
  unknown.ext[ACCEPTANCE_CONTINUITY_EXTENSION].unexpected = true;
  assert.equal(inspectAcceptanceContinuity(unknown).error, "malformed");

  assert.equal(inspectAcceptanceContinuity(handoff(["same", "same"])).error, "malformed");
  const huge = { ext: { [ACCEPTANCE_CONTINUITY_EXTENSION]: "x".repeat(MAX_ACCEPTANCE_CONTINUITY_BYTES) } };
  assert.equal(inspectAcceptanceContinuity(huge).error, "oversize");
  assert.equal(inspectAcceptanceContinuity({}).error, "absent");
});
