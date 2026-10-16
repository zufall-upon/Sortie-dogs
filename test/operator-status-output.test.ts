import assert from "node:assert/strict";
import test from "node:test";
import { serializeOperatorStatus } from "../dist/plugin/operator-status-output.js";

// Pinned V2 native ToolOutput defaults: 2000 lines / 51200 UTF-8 bytes.
// A line that exceeds the remaining budget is not partially displayed.
function nativeVisiblePrefix(text: string): string {
  const visible: string[] = [];
  let bytes = 0;
  for (const line of text.split("\n").slice(0, 2000)) {
    const size = Buffer.byteLength(line, "utf8") + (visible.length ? 1 : 0);
    if (bytes + size > 51200) break;
    visible.push(line); bytes += size;
  }
  return visible.join("\n");
}

function packet() {
  return {
    // The retained full-view response began with acceptance, not actionable facts.
    acceptance_summary: { original_requests: [{ id: "original", text: "Preserve every original requirement. ".repeat(2000) }] },
    mission_id: "mission-retained", run_id: "run-retained", phase: "submitted", status: "awaiting-acceptance",
    units: [{ id: "unit-1", status: "succeeded", evidence: [{ evidence_id: "sha256:evidence", execution: { exit_code: 0 },
      protected_binding: { source_paths: Array.from({ length: 3000 }, (_, i) => `src/protected-${i}.py`) } }] }],
    attempts: [{ childSessionID: "native-worker", selectedModel: "openai/gpt-6-luna-fast#max",
      observedModel: "openai/gpt-6-luna-fast", observedVariant: "max", status: "succeeded", nativeOutcome: "completed" }],
    budget: { max_units: 5, consumed_units: 1, reserved_units: 0, remaining_units: 4,
      settled_cost_usd: 0.04769424, cost_status: "settled", cost_source: "native-usage-price-table", cost_scope: "worker-only",
      campaign_remaining_usd: null, cost_note: "Excludes orchestration/read-only review and external campaign spend." },
    accounting_scope: "Implementation units are not benchmark attempts; external campaign costs are excluded.",
    next_action: "Compare the original request with actual evidence before acceptance.",
    runtime: { host_version: "2.0.26", adapter_sha256: "loaded-adapter" },
  };
}

test("full status keeps actual model, scoped cost and next action visible at the native whole-line boundary", () => {
  const original = packet(), before = structuredClone(original);
  const old = JSON.stringify(original);
  assert.ok(Buffer.byteLength(old) > 51200);
  assert.equal(nativeVisiblePrefix(old), "", "the retained one-line failure shows zero lines");
  const output = serializeOperatorStatus(original), visible = nativeVisiblePrefix(output);
  for (const fact of ["openai/gpt-6-luna-fast#max", '"observedModel":"openai/gpt-6-luna-fast"', '"observedVariant":"max"',
    '"settled_cost_usd":0.04769424', '"cost_scope":"worker-only"', '"campaign_remaining_usd":null',
    "Excludes orchestration/read-only review", original.next_action, "loaded-adapter"]) assert.ok(visible.includes(fact), fact);
  assert.ok(Buffer.byteLength(visible) < 4096, "actionable prefix is small even with oversized original text and proof arrays");
  const { model_observations: models, ...full } = JSON.parse(output);
  assert.deepEqual(models, { recent_attempts: original.attempts, omitted_attempts: 0 });
  assert.deepEqual(full, original, "full JSON retains every original requirement and protected proof");
  assert.deepEqual(original, before, "serialization does not mutate canonical acceptance or evidence");
});

for (const view of ["full", "progress"]) test(`${view} status keeps the action prefix before oversized attempt history`, () => {
  const retained = packet();
  const original = { ...retained, view,
    attempts: Array.from({ length: 256 }, (_, index) => ({
      ...retained.attempts[0], childSessionID: `retained-worker-${index}`, status: "failed",
      failure: { category: "implementation", code: "validation-failed:5" },
    })),
    next_action: "Declared validation failed. Continue the same diagnosed task; retain prior spend and do not replay it.",
    execution_summary: { failed_units: 1, accepted: false },
    completion: { ready: false },
  };
  const before = structuredClone(original);
  assert.ok(Buffer.byteLength(JSON.stringify(original.attempts)) > 51200,
    "the native transport cannot display this whole attempt-history line");
  const output = serializeOperatorStatus(original), visible = nativeVisiblePrefix(output);
  for (const fact of [original.next_action, '"failed_units":1', '"accepted":false',
    '"ready":false', '"settled_cost_usd":0.04769424', '"cost_scope":"worker-only"',
    '"campaign_remaining_usd":null', "loaded-adapter"]) assert.ok(visible.includes(fact), fact);
  assert.ok(output.indexOf('"next_action"') < output.indexOf('"attempts"'));
  const { model_observations: models, ...full } = JSON.parse(output);
  assert.equal(models.recent_attempts.length, 8);
  assert.equal(models.omitted_attempts, 248);
  assert.ok(visible.includes('"observedModel":"openai/gpt-6-luna-fast"'));
  assert.deepEqual(full, before, "complete history and failure/model facts remain in full JSON");
  assert.deepEqual(original, before, "rendering cannot mutate canonical state or promote failed validation");
});

test("large completion proof cannot hide selected versus observed model facts", () => {
  const original = { ...packet(), completion: { ready: false, blockers: [{
    source_paths: Array.from({ length: 5000 }, (_, index) => `src/retained-proof-${index}.ts`),
  }] } };
  const before = structuredClone(original);
  assert.ok(Buffer.byteLength(JSON.stringify(original.completion)) > 51200);
  const output = serializeOperatorStatus(original), visible = nativeVisiblePrefix(output);
  for (const fact of [original.next_action, '"selectedModel":"openai/gpt-6-luna-fast#max"',
    '"observedModel":"openai/gpt-6-luna-fast"', '"observedVariant":"max"']) assert.ok(visible.includes(fact), fact);
  const { model_observations: _summary, ...full } = JSON.parse(output);
  assert.deepEqual(full, before, "all completion paths and original observations remain intact");
  assert.deepEqual(original, before);
});

test("model header stays bounded when completion proof and attempt history are both oversized", () => {
  const retained = packet();
  const original = { ...retained,
    attempts: Array.from({ length: 256 }, (_, index) => ({ ...retained.attempts[0], attemptID: `attempt-${index}`,
      terminal: { descendants: Array.from({ length: 100 }, () => ({ proof: "retained descendant" })) } })),
    completion: { ready: false, blockers: [{ candidate_paths: Array.from({ length: 5000 }, (_, index) => `src/candidate-${index}.ts`) }] },
  };
  const output = serializeOperatorStatus(original), visible = nativeVisiblePrefix(output);
  const { model_observations: models, ...full } = JSON.parse(output);
  assert.equal(models.recent_attempts.length, 8);
  assert.equal(models.omitted_attempts, 248);
  assert.equal(models.recent_attempts[0].attemptID, "attempt-248");
  assert.equal(models.recent_attempts[7].attemptID, "attempt-255");
  assert.equal(models.recent_attempts.some((attempt: object) => Object.hasOwn(attempt, "terminal")), false);
  assert.ok(Buffer.byteLength(JSON.stringify(models)) < 4096);
  for (const fact of [original.next_action, '"observedModel":"openai/gpt-6-luna-fast"', '"omitted_attempts":248'])
    assert.ok(visible.includes(fact), fact);
  assert.deepEqual(full, original, "bounded display never truncates the full original proofs or history");
});

test("model header keeps model-bearing attempts behind a model-less direct tail", () => {
  for (const modelCount of [1, 8]) {
    const retained = packet();
    const original = { ...retained, attempts: [
      ...Array.from({ length: modelCount }, (_, index) => ({ ...retained.attempts[0],
        attemptID: `worker-${index}`, kind: "implementation" })),
      ...Array.from({ length: 8 }, (_, index) => ({ attemptID: `direct-${index}`,
        kind: "direct_execution", status: "succeeded", nativeOutcome: "completed" })),
    ], completion: { ready: false, blockers: [{ source_paths: Array.from({ length: 5000 }, (_, index) => `src/tail-proof-${index}.ts`) }] } };
    const before = structuredClone(original);
    const output = serializeOperatorStatus(original), visible = nativeVisiblePrefix(output);
    assert.ok(visible.includes('"observedModel":"openai/gpt-6-luna-fast"'), "direct executions cannot displace known Worker observations");
    const { model_observations: models, ...full } = JSON.parse(output);
    assert.equal(models.recent_attempts.length, modelCount + 8);
    assert.ok(models.recent_attempts.length <= 16);
    assert.equal(models.omitted_attempts, 0);
    assert.deepEqual(models.recent_attempts.map((attempt: { attemptID: string }) => attempt.attemptID),
      original.attempts.map(attempt => attempt.attemptID));
    for (const attempt of models.recent_attempts.filter((attempt: { kind: string }) => attempt.kind === "direct_execution")) {
      assert.equal(Object.hasOwn(attempt, "observedModel"), false);
      assert.equal(Object.hasOwn(attempt, "selectedModel"), false);
    }
    assert.deepEqual(full, before);
    assert.deepEqual(original, before);
  }
});

test("model header preserves failure details before oversized completion proof", () => {
  const retained = packet();
  const original = { ...retained, attempts: [{ ...retained.attempts[0], status: "failed", resultClass: "acceptance",
    failure: { category: "implementation", code: "validation-failed:5", detail: "retained full diagnostic ".repeat(5000) } }],
    completion: { ready: false, blockers: [{ candidate_paths: Array.from({ length: 5000 }, (_, index) => `src/failure-proof-${index}.ts`) }] } };
  const before = structuredClone(original);
  const output = serializeOperatorStatus(original), visible = nativeVisiblePrefix(output);
  for (const fact of ['"category":"implementation"', '"code":"validation-failed:5"', '"resultClass":"acceptance"'])
    assert.ok(visible.includes(fact), fact);
  const { model_observations: models, ...full } = JSON.parse(output);
  assert.deepEqual(models.recent_attempts[0].failure, { category: "implementation", code: "validation-failed:5" });
  assert.equal(models.recent_attempts[0].status, "failed");
  assert.deepEqual(full, before, "detailed failure remains intact outside the bounded prefix");
  assert.deepEqual(original, before);
});

test("status serialization preserves missing or unknown model/cost without promoting selected model or zero price", () => {
  const original = { attempts: [{ selectedModel: "openai/gpt-6-luna-fast#max", observedModel: null, observedVariant: null }],
    budget: { settled_cost_usd: 0, cost_status: "unknown", cost_scope: "worker-only", campaign_remaining_usd: null },
    next_action: "Native usage unavailable; retain unknown.", absent_optional: undefined };
  const output = JSON.parse(serializeOperatorStatus(original));
  const { model_observations: models, ...full } = output;
  assert.deepEqual(models, { recent_attempts: original.attempts, omitted_attempts: 0 });
  assert.equal(models.recent_attempts[0].observedModel, null);
  assert.equal(models.recent_attempts[0].observedVariant, null);
  assert.deepEqual(full, JSON.parse(JSON.stringify(original)));
  assert.deepEqual(JSON.parse(serializeOperatorStatus(output)), output, "native decoration preserves an existing projection");
  const missing = JSON.parse(serializeOperatorStatus({ attempts: [{ selectedModel: "selected-only" }] }));
  assert.equal(Object.hasOwn(missing.model_observations.recent_attempts[0], "observedModel"), false);
  assert.deepEqual(JSON.parse(serializeOperatorStatus({})), {});
});
