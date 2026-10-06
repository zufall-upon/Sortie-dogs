import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoalEvidence, GoalFlightState } from "../dist/core/goal-bound.js";
import type { SerialDispatchSettlement } from "../dist/plugin/runtime-bridge.js";
import { CodexMissionSettlementBridge } from "../dist/codex/mission-settlement.js";
import type { CodexTurnResult } from "../dist/codex/app-server.js";
import type { CodexEvidenceCaptureRequest, CodexValidationObservation } from "../dist/codex/mission-settlement.js";

const command = "node verify.js";
const goalState: Pick<GoalFlightState, "goal_id" | "revision" | "scope_epoch" | "acceptance_fingerprint" | "acceptance_contract"> = {
  goal_id: "goal-1", revision: 1, scope_epoch: 1, acceptance_fingerprint: "fingerprint-1",
  acceptance_contract: { criteria: [{ criterion_id: "criterion-1", target: "hello.txt", entrypoint: "node",
    workload: "verify exact content", oracle_coverage: ["content"], build_boundary: "not-applicable",
    source: "source-1", candidate: "candidate-1", validation_command: command, fixture: "fixture-1",
    proof_scope: "requested-full", expected_outcome: "pass" }] },
};
const evidence: GoalEvidence = {
  evidence_id: "evidence-1", goal_id: "goal-1", goal_revision: 1, scope_epoch: 1,
  acceptance_fingerprint: "fingerprint-1", measurement: { criterion_ids: ["criterion-1"], target: "hello.txt",
    entrypoint: "node", workload: "verify exact content", oracle_coverage: ["content"], build_boundary: "not-applicable" },
  identity: { source: "source-1", candidate: "candidate-1", fixture: "fixture-1" },
  execution: { command: [command], exit_code: 0, outcome: "pass", started_at: "2026-10-05T00:00:00.000Z",
    ended_at: "2026-10-05T00:00:01.000Z", units: ["unit-1"] }, proof_scope: "requested-full",
};
const turn = (overrides: Partial<CodexTurnResult> = {}): CodexTurnResult => ({ threadID: "thread-1", turnID: "turn-1",
  status: "completed", items: [{ id: "cmd-1", type: "commandExecution", command, status: "completed", exitCode: 0 }], ...overrides });

function target() {
  const settlements: SerialDispatchSettlement[] = [];
  const observations: CodexValidationObservation[][] = [];
  return { settlements, observations, target: {
    observedValidation: async (value: readonly CodexValidationObservation[]) => { observations.push([...value]); },
    settled: async (value: SerialDispatchSettlement) => { settlements.push(value); },
  } };
}

const request = (result: CodexTurnResult, capture: (request: CodexEvidenceCaptureRequest) => Promise<readonly GoalEvidence[]>) => ({ rootSessionID: "root-1",
  callID: "call-1", unitID: "unit-1", turn: result, declaredValidation: [command], goalState,
  captureEvidence: capture });

test("Codex settlement uses existing goal evidence validator before succeeding", async () => {
  const state = target();
  const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn(), async () => [evidence]));
  assert.equal(result.disposition, "succeeded");
  assert.equal(result.evidence[0], evidence);
  assert.equal(state.settlements.length, 1);
});

test("Codex settlement fails closed when declared validation was not observed", async () => {
  const state = target();
  let captured = false;
  const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ items: [] }), async () => {
    captured = true; return [evidence];
  }));
  assert.equal(result.disposition, "failed");
  assert.equal(result.resultClass, "acceptance");
  assert.equal(captured, false);
});

test("Codex settlement preserves an observed validation failure", async () => {
  const state = target();
  const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ items: [
    { id: "cmd-1", type: "commandExecution", command, status: "failed", exitCode: 2 },
  ] }), async () => [evidence]));
  assert.equal(result.disposition, "failed");
  assert.deepEqual(result.failure, { command: [command], outcome: "fail", exitCode: 2 });
  assert.equal(state.observations.length, 1);
  assert.equal(state.observations[0]![0]!.rawCommand, command);
  assert.equal(state.observations[0]![0]!.status, "failed");
  assert.equal(state.observations[0]![0]!.exitCode, 2);
});

test("Codex settlement retains ordered successful prefix before a later validation failure", async () => {
  const second = "node verify-second.js";
  const state = target();
  const multiGoal = { ...goalState, acceptance_contract: { criteria: [
    ...goalState.acceptance_contract!.criteria,
    { ...goalState.acceptance_contract!.criteria[0]!, criterion_id: "criterion-2", validation_command: second },
  ] } };
  const result = await new CodexMissionSettlementBridge(state.target).settle({
    rootSessionID: "root-1", callID: "call-1", unitID: "unit-1",
    turn: turn({ items: [
      { id: "cmd-1", type: "commandExecution", command, status: "completed", exitCode: 0 },
      { id: "cmd-2", type: "commandExecution", command: second, status: "failed", exitCode: 7 },
    ] }), declaredValidation: [command, second], goalState: multiGoal, captureEvidence: async () => [],
  });
  assert.equal(result.disposition, "failed");
  assert.equal(state.observations.length, 1);
  assert.deepEqual(state.observations[0]!.map(item => item.rawCommand), [command, second]);
  assert.deepEqual(state.observations[0]!.map(item => item.exitCode), [0, 7]);
});

test("Codex settlement rejects model text and invalid evidence as proof", async () => {
  const state = target();
  const invalid = { ...evidence, goal_id: "wrong" };
  const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ finalResponse: "tests pass" }), async () => [invalid]));
  assert.equal(result.disposition, "failed");
  assert.deepEqual(result.evidence, []);
});

test("Codex settlement maps interrupted turns without attempting evidence capture", async () => {
  const state = target();
  let captured = false;
  const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ status: "interrupted" }), async () => {
    captured = true; return [evidence];
  }));
  assert.equal(result.disposition, "cancelled");
  assert.equal(result.resultClass, "interrupted");
  assert.equal(captured, false);
  assert.equal(state.observations.length, 1);
  assert.equal(state.observations[0]![0]!.rawCommand, command);
  assert.equal(state.observations[0]![0]!.status, "completed");
});

test("Codex settlement requires evidence coverage for every positive criterion", async () => {
  const state = target();
  const secondCommand = "node verify-second.js";
  const secondCriterion = { ...goalState.acceptance_contract!.criteria[0]!, criterion_id: "criterion-2",
    validation_command: secondCommand, workload: "verify second condition" };
  const multiGoal = { ...goalState, acceptance_contract: { criteria: [goalState.acceptance_contract!.criteria[0]!, secondCriterion] } };
  const result = await new CodexMissionSettlementBridge(state.target).settle({ ...request(turn({ items: [
    { id: "cmd-1", type: "commandExecution", command, status: "completed", exitCode: 0 },
    { id: "cmd-2", type: "commandExecution", command: secondCommand, status: "completed", exitCode: 0 },
  ] }), async () => [evidence]), declaredValidation: [command, secondCommand], goalState: multiGoal });
  assert.equal(result.disposition, "failed");
});

test("Codex settlement never collapses argv into a shell command identity", async () => {
  const state = target();
  let captured = false;
  const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ items: [
    { id: "cmd-argv", type: "commandExecution", command: ["node", "verify.js"], status: "completed", exitCode: 0 },
  ] }), async () => { captured = true; return [evidence]; }));
  assert.equal(result.disposition, "failed");
  assert.equal(captured, false);
});

test("Codex settlement unwraps the exact observed PowerShell executable envelope and retains raw identity", async () => {
  const state = target();
  const wrapped = String.raw`\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'node verify.js'`;
  let capture: CodexEvidenceCaptureRequest | undefined;
  const result = await new CodexMissionSettlementBridge(state.target).settle({ ...request(turn({ items: [
    { id: "cmd-wrapped", type: "commandExecution", command: wrapped, status: "completed", exitCode: 0 },
  ] }), async value => { capture = value; return [evidence]; }),
    trustedPowerShellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" });
  assert.equal(result.disposition, "succeeded");
  assert.equal(capture!.validationExecutions[0]!.commands[0], command);
  assert.equal(capture!.validationExecutions[0]!.item.command, wrapped);
  assert.equal(state.observations[0]![0]!.rawCommand, wrapped);
  assert.deepEqual(state.observations[0]![0]!.canonicalCommands, [command]);
});

test("Codex settlement rejects the right wrapper shape from an untrusted pwsh path", async () => {
  const state = target();
  const wrapped = String.raw`\"C:\\workspace\\pwsh.exe\" -Command 'node verify.js'`;
  const result = await new CodexMissionSettlementBridge(state.target).settle({ ...request(turn({ items: [
    { id: "cmd-fake-shell", type: "commandExecution", command: wrapped, status: "completed", exitCode: 0 },
  ] }), async () => [evidence]), trustedPowerShellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" });
  assert.equal(result.disposition, "failed");
});

test("Codex settlement fails closed for expected-negative criteria until native negative evidence is supported", async () => {
  const state = target();
  const negative = { ...goalState.acceptance_contract!.criteria[0]!, criterion_id: "criterion-negative",
    proof_scope: "expected-negative" as const, expected_outcome: "fail" as const };
  const result = await new CodexMissionSettlementBridge(state.target).settle({ ...request(turn(), async () => [evidence]),
    goalState: { ...goalState, acceptance_contract: { criteria: [goalState.acceptance_contract!.criteria[0]!, negative] } } });
  assert.equal(result.disposition, "failed");
});

test("Codex settlement rejects arbitrary or nested PowerShell wrappers", async () => {
  for (const wrapped of [
    String.raw`\"C:\\Windows\\System32\\cmd.exe\" -Command 'node verify.js'`,
    String.raw`\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoProfile -Command 'node verify.js'`,
    String.raw`\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'node verify.js; echo extra'`,
  ]) {
    const state = target();
    let captured = false;
    const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ items: [
      { id: "cmd-invalid-wrapper", type: "commandExecution", command: wrapped, status: "completed", exitCode: 0 },
    ] }), async () => { captured = true; return [evidence]; }));
    assert.equal(result.disposition, "failed");
    assert.equal(captured, false);
  }
});


test("Codex settlement unwraps Linux system bash and retains native failure and interruption", async () => {
  const wrapped = "/bin/bash -lc 'node verify.js'";
  for (const [status, exitCode, disposition] of [
    ["completed", 0, "succeeded"], ["completed", 7, "failed"], ["interrupted", null, "cancelled"],
  ] as const) {
    const state = target();
    const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ status, items: [
      { id: "cmd-bash", type: "commandExecution", command: wrapped, status: exitCode === null ? "interrupted" : "completed", exitCode },
    ] }), async () => [evidence]));
    assert.equal(result.disposition, disposition);
    assert.equal(state.observations[0]![0]!.rawCommand, wrapped);
    assert.deepEqual(state.observations[0]![0]!.canonicalCommands, [command]);
    assert.equal(state.observations[0]![0]!.exitCode, exitCode);
  }
});

test("Codex settlement rejects untrusted or altered bash envelopes", async () => {
  for (const wrapped of [
    "/tmp/bash -lc 'node verify.js'", "bash -lc 'node verify.js'",
    "/bin/bash -c 'node verify.js'", '/bin/bash -lc "node verify.js"',
    "/bin/bash -lc 'node verify.js' extra", "/bin/bash -lc 'node verify.js; echo extra'",
    "/bin/bash -lc 'node verify.js && echo extra'", "/bin/bash -lc 'bash -c node verify.js'",
  ]) {
    const state = target();
    let captured = false;
    const result = await new CodexMissionSettlementBridge(state.target).settle(request(turn({ items: [
      { type: "commandExecution", command: wrapped, status: "completed", exitCode: 0 },
    ] }), async () => { captured = true; return [evidence]; }));
    assert.equal(result.disposition, "failed", wrapped);
    assert.equal(captured, false, wrapped);
    assert.equal(state.observations.length, 0, wrapped);
  }
});
