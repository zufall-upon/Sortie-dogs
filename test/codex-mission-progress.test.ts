import assert from "node:assert/strict";
import test from "node:test";
import { codexMissionProgress } from "../dist/cli/codex-mission.js";

test("native model route progress exposes role, model, effort and separate Fast tier", () => {
  assert.deepEqual(codexMissionProgress({ method: "sortie/modelRoute", threadId: "worker", params: {
    agent: "dog-luna-worker-v010", model: "gpt-6-luna", effort: "max", serviceTier: "priority",
  } }), { thread_id: "worker", phase: "model-route", agent: "dog-luna-worker-v010", model: "gpt-6-luna", effort: "max", service_tier: "priority" });
});

test("Codex Mission progress exposes correction reasons and validation exit without full packets", () => {
  const progress = codexMissionProgress({ method: "item/completed", threadId: "root", params: { turnId: "turn", item: {
    type: "dynamicToolCall", tool: "sortie_v010_plan_units", status: "completed", success: true,
    arguments: { reason: "Public non-string input is coerced instead of rejected." },
    contentItems: [{ type: "inputText", text: JSON.stringify({ status: "direct-unit-running", next_action: "Correct the current implementation.", huge_internal_packet: "omit" }) }],
  } } });
  assert.equal(progress?.reason, "Public non-string input is coerced instead of rejected.");
  assert.equal(progress?.next_action, "Correct the current implementation.");
  assert.equal(progress?.outcome, "direct-unit-running");
  assert.equal(progress?.huge_internal_packet, undefined);
  const failed = codexMissionProgress({ method: "item/completed", threadId: "worker", params: { item: {
    type: "dynamicToolCall", tool: "bash", arguments: { command: "node check.mjs" },
    contentItems: [{ type: "inputText", text: JSON.stringify({ output: "assertion failed", metadata: { exit: 7 } }) }],
  } } });
  assert.equal(failed?.command, "node check.mjs"); assert.equal(failed?.exit, 7);
});

test("Codex Mission progress preserves nested Task feedback, starts, and bounded native errors", () => {
  const task = codexMissionProgress({ method: "item/completed", threadId: "root", params: { item: {
    type: "dynamicToolCall", tool: "task", contentItems: [{ type: "inputText", text: JSON.stringify({
      output: JSON.stringify({ next_action: "Compare the candidate with the original request." }), metadata: { sessionId: "child" },
    }) }],
  } } });
  assert.equal(task?.next_action, "Compare the candidate with the original request.");
  assert.equal(codexMissionProgress({ method: "item/started", threadId: "root", params: { item: { type: "dynamicToolCall", tool: "bash" } } })?.phase, "started");
  assert.equal(codexMissionProgress({ method: "item/completed", threadId: "root", params: { item: {
    type: "dynamicToolCall", tool: "task", success: false, contentItems: [{ type: "inputText", text: "x".repeat(2000) }],
  } } })?.detail, "x".repeat(1600));
  assert.equal(codexMissionProgress({ method: "item/completed", threadId: "root", params: { item: {
    type: "agentMessage", phase: "commentary", text: "I reject the candidate because it coerces non-string inputs.",
  } } })?.text, "I reject the candidate because it coerces non-string inputs.");
  assert.equal(codexMissionProgress({ method: "item/completed", threadId: "root", params: { item: { type: "reasoning", text: "private" } } }), undefined);
});


test("native approval requests remain visible when the CLI has no approval bridge", () => {
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
    const progress = codexMissionProgress({ method, threadId: "root", params: { turnId: "turn", itemId: "item", reason: "Write approved output", hostApprovalAvailable: false } });
    assert.equal(progress?.phase, "approval-required");
    assert.equal(progress?.host_approval_available, false);
    assert.match(String(progress?.next_action), /No host approval callback/);
    assert.equal(progress?.reason, "Write approved output");
  }
});


test("host execution progress distinguishes selected executor and unknown failure", () => {
  const progress = codexMissionProgress({ method: "sortie/commandExecution", threadId: "root", params: {
    turnId: "turn", callId: "call", tool: "bash", executor: "host", cwd: "/repo/package with spaces", status: "unknown", reason: "Host connection lost",
  } });
  assert.equal(progress?.executor, "host");
  assert.equal(progress?.cwd, "/repo/package with spaces");
  assert.equal(progress?.phase, "unknown");
  assert.equal(progress?.detail, "Host connection lost");
});


test("effective native permissions are visible without implying host-executor authority", () => {
  const progress = codexMissionProgress({ method: "sortie/permissions", threadId: "root", params: {
    requestedProfile: null, profile: ":read-only", sandbox: "readOnly", networkAccess: false,
    approvalPolicy: "on-request", approvalsReviewer: "user", commandExecutor: "host",
  } });
  assert.equal(progress?.effective_profile, ":read-only");
  assert.equal(progress?.requested_profile, null);
  assert.equal(progress?.command_executor, "host");
});
