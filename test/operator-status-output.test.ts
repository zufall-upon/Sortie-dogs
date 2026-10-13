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
  assert.deepEqual(JSON.parse(output), original, "full JSON retains every original requirement and protected proof");
  assert.deepEqual(original, before, "serialization does not mutate canonical acceptance or evidence");
});

test("status serialization preserves missing or unknown model/cost without promoting selected model or zero price", () => {
  const original = { attempts: [{ selectedModel: "openai/gpt-6-luna-fast#max", observedModel: null, observedVariant: null }],
    budget: { settled_cost_usd: 0, cost_status: "unknown", cost_scope: "worker-only", campaign_remaining_usd: null },
    next_action: "Native usage unavailable; retain unknown.", absent_optional: undefined };
  assert.deepEqual(JSON.parse(serializeOperatorStatus(original)), JSON.parse(JSON.stringify(original)));
  assert.deepEqual(JSON.parse(serializeOperatorStatus({})), {});
});
