import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorMissionRuntime, missionAcceptanceSummary, missionPlan, missionReviewAccepted, missionPacket } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { observedMissionValidationSummary } from "../dist/plugin/mission-review.js";

async function fixture(body: (directory: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/acceptance-summary-"));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("ready summary retains exact requests and anchored same-mission formal PASS as historical, not current freshness", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const text = " Fix result.\r\nRun go test ./...; commit; retain API.  ";
  await missions.capture("root", { id: "user-request", text });
  const mission = await missions.start("root", ["Fix result", "Run tests and commit"]);
  const previous = await operators.prepareMission("root", missionPlan(mission, [{ title: "Fix", objective: "Fix result",
    read: ["src"], write: ["src"], validation: ["go test ./..."] }]));
  const oldUnit = previous.units[0]!;
  oldUnit.status = "succeeded";
  oldUnit.childSessionID = "old-worker";
  oldUnit.evidence = [{ evidence_id: "formal-old", identity: { source: "old-source", candidate: "old-candidate", fixture: mission.id },
    execution: { command: ["go test ./..."], exit_code: 0, outcome: "pass", started_at: "start", ended_at: "end", units: ["unit-1"] },
    protected_binding: { manifest_hash: "manifest-hash", manifest_path: oldUnit.manifestPath,
      project_root: directory, source_paths: ["source-path-".repeat(10_000)], candidate_paths: ["candidate-path-".repeat(10_000)],
      freshness: { contract_hash: "contract-hash", environment: { LARGE: "environment-".repeat(10_000) },
        protected_paths: ["protected-path-".repeat(10_000)], scratch_paths: [] } },
    proof_scope: "requested-full" } as never];
  const archive = join(directory, V010_RUNTIME_PROFILE.stateDirectory, "operators",
    `${createHash("sha256").update("root").digest("hex")}.json.${previous.runID}.${previous.sequence}.archive`);
  await writeFile(archive, JSON.stringify(previous));
  // Unrelated corrupt archives must not be parsed or imported.
  await writeFile(`${archive}.unrelated.archive`, "broken JSON");
  const taskID = oldUnit.task.prompt.match(/^task_id: (.+)$/m)![1]!;
  const current = { ...previous, runID: "operator-current", parentRunID: previous.runID,
    priorAcceptedUnits: [{ taskID, handoffPath: oldUnit.handoffPath, handoffHash: oldUnit.hashes[0]! }],
    units: [{ ...oldUnit, evidence: [], childSessionID: "commit-worker", unit: { ...oldUnit.unit, validation: ["git status --porcelain"] } }] };
  mission.runID = current.runID;
  mission.attempts = [{ runID: previous.runID } as never, { runID: current.runID } as never];
  mission.submission = { status: "ready", summary: "Fixed and committed" };
  mission.review = { runID: current.runID, source: "reviewed-source", verdict: "PASS", child: "reviewer", task: null, risk: ["public-logic"] };
  const observe = async (commands: readonly string[], child: string | null) => ({ attempts: [{ command: commands[0], exit_code: 0 }], child });
  const summary = await missionAcceptanceSummary(mission, current, operators, observe);
  assert.deepEqual(summary.original_requests, [{ id: "user-request", text }]);
  const proofs = summary.formal_validation as Record<string, unknown>[];
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.evidence_id, "formal-old");
  assert.equal(proofs[0]!.state_archive_path, archive);
  assert.equal(proofs[0]!.run_id, previous.runID);
  assert.equal(proofs[0]!.task_id, taskID);
  assert.equal(proofs[0]!.protected_binding, undefined);
  assert.deepEqual(proofs[0]!.binding_hashes, { manifest_hash: "manifest-hash", contract_hash: "contract-hash" });
  assert.equal((proofs[0]!.details_ref as Record<string, unknown>).path, archive);
  assert.equal((proofs[0]!.details_ref as Record<string, unknown>).evidence_id, "formal-old");
  assert.ok(Buffer.byteLength(JSON.stringify(proofs)) < Buffer.byteLength(JSON.stringify(oldUnit.evidence)) / 10,
    "projection size does not scale with repeated protected path arrays or environment");
  assert.match(String(proofs[0]!.applicability), /historical-reference.*not established/);
  const native = summary.native_declared_validation as Record<string, unknown>[];
  assert.equal(native.length, 2);
  assert.equal(native[1]!.worker_session_id, "old-worker");
  assert.equal((summary.independent_review as Record<string, unknown>).reviewer_session_id, "reviewer");
  assert.match(String((summary.delivery as Record<string, unknown>).clean), /not independently observed/);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src/changed.go"), "changed exact source after review");
  const changed = await missionAcceptanceSummary(mission, current, operators, observe);
  assert.deepEqual(changed.formal_validation, summary.formal_validation, "source changes cannot upgrade historical proof to current PASS");
  assert.match(String((changed.independent_review as Record<string, unknown>).freshness), /not established/);
  const wrongAnchor = { ...current, priorAcceptedUnits: [{ ...current.priorAcceptedUnits[0]!, handoffHash: "0".repeat(64) }] };
  const unmatched = await missionAcceptanceSummary(mission, wrongAnchor, operators);
  assert.deepEqual(unmatched.formal_validation, []);
  assert.equal((unmatched.history as Record<string, unknown>).status, "unavailable");
  assert.equal((unmatched.history as Record<string, unknown>).reason, "accepted-handoff-anchor-unavailable");
}));

test("native summary distinguishes absent/error/non-array responses from successful empty history and groups repeated declared checks", async () => {
  await assert.rejects(observedMissionValidationSummary(["go test ./..."], "worker"), /api-unavailable/);
  for (const response of [{ data: undefined, error: { message: "offline" } }, { data: [], error: "failed" }]) {
    await assert.rejects(observedMissionValidationSummary(["go test ./..."], "worker", async () => response), /api-error/);
  }
  for (const response of [undefined, { data: undefined }, { data: {} }]) {
    await assert.rejects(observedMissionValidationSummary(["go test ./..."], "worker", async () => response), /response-not-array/);
  }
  const empty = await observedMissionValidationSummary(["go test ./..."], "worker", async () => ({ data: [] }));
  assert.deepEqual(empty.commands, []);
  assert.deepEqual(empty.not_observed, ["go test ./..."]);
  const message = { info: { role: "assistant", sessionID: "worker" }, parts: [
    ...[0, 0, 1].map((exit, i) => ({ type: "tool", tool: "shell", callID: `call-${i}`, time: { ran: i, completed: i + 1 },
      state: { status: "completed", input: { command: "go test ./..." }, metadata: { exit }, output: "large-output-".repeat(10_000) } })),
    { type: "tool", tool: "shell", state: { status: "completed", input: { command: "unrelated ad-hoc command" }, metadata: { exit: 0 } } },
  ] };
  const summary = await observedMissionValidationSummary(["go test ./..."], "worker", async () => ({ data: [message] }));
  assert.deepEqual(summary.commands, [
    { command: "go test ./...", exit_code: 0, observed_attempts: 2, latest_started_ms: 1, latest_completed_ms: 2 },
    { command: "go test ./...", exit_code: 1, observed_attempts: 1, latest_started_ms: 2, latest_completed_ms: 3 },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /large-output|unrelated ad-hoc/);
  assert.deepEqual((summary.details_ref as Record<string, unknown>).session_id, "worker");
});

test("lineage lookup failures are unavailable, never successful empty history", async () => fixture(async directory => {
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u", text: "Fix" });
  const mission = await missions.start("root", ["Fix"]);
  const run = await operators.prepareMission("root", missionPlan(mission, [{ title: "Fix", objective: "Fix",
    read: [], write: ["src"], validation: ["go test ./..."] }]));
  const current = { ...run, parentRunID: "operator-missing" };
  mission.runID = current.runID;
  mission.attempts = [{ runID: "operator-missing" } as never];
  const summary = await missionAcceptanceSummary(mission, current, operators, async () => { throw new Error("history-fetch-failed"); });
  assert.deepEqual(summary.history, { status: "unavailable", reason: "lineage-archive-missing",
    selection: "same-mission Worker run IDs, parent lineage and exact accepted handoff anchors" });
  current.units[0]!.childSessionID = "worker";
  const failed = await missionAcceptanceSummary(mission, current, operators, async () => { throw new Error("history-fetch-failed"); });
  const native = failed.native_declared_validation as Record<string, unknown>[];
  assert.equal(native[0]!.status, "unavailable");
  assert.equal(native[0]!.reason, "history-fetch-failed");
  assert.equal((await operators.acceptanceHistory(current, [])).reason, "same-mission-lineage-unavailable");
}));

test("author self-recheck summary and packet never claim independent PASS; exact report identity is required", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE), operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u", text: "Original requirements verbatim" });
  const mission = await missions.start("root", ["Preserve requirements"]);
  const run = await operators.prepareMission("root", missionPlan(mission, [{ title: "Fix", objective: "Fix", write: ["src"], validation: ["go test ./..."] }]));
  mission.runID = run.runID;
  const checked = { runID: run.runID, source: "candidate", author: "author", callID: "call", promptID: "prompt", messageID: "terminal",
    nativeOutcome: "completed" as const, result: "SELF_RECHECKED", unresolvedFindings: [] };
  mission.corrections = [{ author: "author", reviewIdentity: "initial", priorRunID: "prior", runID: run.runID, priorSource: "prior-source",
    findings: "Medium corrected", initialPrompt: "initial", status: "ready", selfRecheck: checked }];
  mission.review = { runID: run.runID, source: "candidate", risk: ["public-api"], task: null, child: "author", callID: "call", promptID: "prompt",
    mode: "self-recheck", verdict: "self-rechecked", selfRecheck: checked };
  assert.equal(missionReviewAccepted(mission.review), true);
  const summary = await missionAcceptanceSummary(mission, run, operators);
  assert.equal((summary.independent_review as Record<string, unknown>).independent, false);
  assert.equal((summary.independent_review as Record<string, unknown>).verdict, "self-rechecked");
  const packet = missionPacket(mission, run).review as Record<string, unknown>;
  assert.equal(packet.independent, false); assert.equal(packet.accepted, true); assert.equal(packet.passed, false);
  for (const changed of [{ callID: "old" }, { promptID: "old" }, { child: "different" }, { source: "stale" }, { verdict: "PASS" as const }]) {
    assert.equal(missionReviewAccepted({ ...mission.review, ...changed }), false);
  }
}));
