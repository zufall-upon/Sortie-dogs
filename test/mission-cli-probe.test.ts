import assert from "node:assert/strict";
import test from "node:test";
import { statusProbeStopReason } from "../scripts/mission-cli-probe.mjs";

const expected = "openai/gpt-6-sol#xhigh";
const root = { sessionID: "root", agent: "dog-operator", model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" } };
const status = { agent: "dog-operator", tool: "sortie_v010_operator_status", status: "completed", model: root.model };

test("explicit status probe observes the requested model and returns on its first status result", () => {
  assert.equal(statusProbeStopReason({ root: "root", models: [], tools: [] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [status] }, expected), "status-observed");
});

test("a wrong model ends only the explicit probe, even if it can call status", () => {
  const actual = { ...root, model: { providerID: "opencode", id: "space-bunny-free" } };
  assert.equal(statusProbeStopReason({ root: "root", models: [actual], tools: [status] }, expected), "model-mismatch");
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [{ ...status, model: actual.model }] }, expected), "model-mismatch",
    "the status tool's real model, not only the session's first turn, must match");
  assert.equal(statusProbeStopReason({ root: "root", models: [{ ...root, sessionID: "foreign" }], tools: [status] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [
    { ...status, status: "error" }, { ...status, agent: "dog-worker-v010" },
  ] }, expected), null);
});
