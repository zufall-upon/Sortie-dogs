import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectRetainedStateCapsule,
  MAX_RETAINED_STATE_BYTES,
  RETAINED_STATE_EXTENSION,
} from "../src/core/retained-state.ts";

const core = {
  schema_version: "0.1",
  authority: "shadow",
  task_id: "task-1",
  acceptance_fingerprint: "accept-1",
  source_manifest: ["src/a.ts"],
  operation_manifest: "none",
  validation_history: [{ command: "npm test", exit: 0, fingerprint: "pass-1" }],
  blockers: [],
  next_action: "continue",
};

test("inspects a valid retained-state core and optional children without mutation", () => {
  const handoff = { ext: { [RETAINED_STATE_EXTENSION]: {
    ...core,
    ignored_unknown: "never retained",
    next_evidence_decision: {
      schema_version: "0.1", authority: "shadow", gap_id: "gap-1", blocked_acceptance: "item",
      question: "which?", expected_discrimination: "pass or fail", action: "check", stop_condition: "known",
    },
    admissions: [{
      evidence_id: "e-1", source_agent: "worker", source_revision: "r1", evidence_fingerprint: "e-fp",
      supports: ["item"], contradicts: [], freshness_basis: "same run", status: "recorded", warnings: [],
    }],
  } } };
  const before = structuredClone(handoff);
  const result = inspectRetainedStateCapsule(handoff);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.capsule, {
    ...core,
    next_evidence_decision: handoff.ext[RETAINED_STATE_EXTENSION].next_evidence_decision,
    admissions: handoff.ext[RETAINED_STATE_EXTENSION].admissions,
  });
  assert.deepEqual(handoff, before);
});

test("is absent, tolerant for optional defects, and bounded for malformed core", () => {
  assert.deepEqual(inspectRetainedStateCapsule({}), { capsule: undefined, warnings: [] });
  const optional = inspectRetainedStateCapsule({ ext: { [RETAINED_STATE_EXTENSION]: {
    ...core, next_evidence_decision: { question: "untrusted" }, admissions: "bad",
  } } });
  assert.ok(optional.capsule);
  assert.equal(optional.capsule.next_evidence_decision, undefined);
  assert.equal(optional.capsule.admissions, undefined);
  assert.equal(optional.warnings.length, 2);
  const malformed = inspectRetainedStateCapsule({ ext: { [RETAINED_STATE_EXTENSION]: {
    ...core, task_id: "x".repeat(257), blockers: ["x".repeat(1001)],
  } } });
  assert.equal(malformed.capsule, undefined);
  assert.equal(malformed.warnings.length, 1);
  const huge = inspectRetainedStateCapsule({ ext: { [RETAINED_STATE_EXTENSION]: "x".repeat(MAX_RETAINED_STATE_BYTES) } });
  assert.equal(huge.capsule, undefined);
  assert.equal(huge.warnings[0].code, "oversize");
});
