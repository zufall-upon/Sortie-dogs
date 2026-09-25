import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { MISSION_EVIDENCE_GAP_REVIEW_LIMIT, OperatorMissionRuntime, missionPacket, missionPlan, missionReviewAccepted, missionReviewTask,
  missionReviewTraces, missionReviewVerdict } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

async function fixture(run: (directory: string) => Promise<void>) {
  const area = resolve("_testenv");
  await mkdir(area, { recursive: true });
  const directory = await mkdtemp(join(area, "mission-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const unit = { title: "Fix result", objective: "Implement the requested result without changing the oracle", read: ["check.mjs"],
  write: ["src"], validation: ["node check.mjs"] };

test("mission review accepts grouped requirement traces while preserving coverage", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result, test it, retain scope" });
  const mission = await missions.start("root", ["Fix result", "Test it", "Retain scope"]);
  assert.deepEqual(missionReviewTraces(mission, ["R1/R2: fix and focused test", "R3: scope retained"]),
    ["R1/R2: fix and focused test", "R1/R2: fix and focused test", "R3: scope retained"]);
  assert.deepEqual(missionReviewTraces(mission, ["fix", "test", "scope"]), ["fix", "test", "scope"]);
  assert.throws(() => missionReviewTraces(mission, ["R1/R2: fix and test"]), /missing R3/);
  assert.throws(() => missionReviewTraces(mission, ["R1/R2/R3/R4: claims"]), /unknown R4/);
  mission.review = { runID: "run", risk: ["public-logic"], source: "source", verdict: "pending",
    task: { subagent_type: "dog-reviewer-v010", description: "Review", prompt: "original evidence ".repeat(1000) } };
  const task = missionReviewTask(mission);
  assert.ok(task.prompt.length < 400);
  assert.doesNotMatch(task.prompt, /original evidence/);
  mission.review.task!.prompt += "changed";
  assert.notEqual(missionReviewTask(mission).prompt, task.prompt);
}));

test("evidence-only reviews are bounded while defects and first gaps still block submission", async () => fixture(async directory => {
  assert.equal(missionReviewVerdict("PASS"), "PASS");
  assert.equal(missionReviewVerdict("EVIDENCE_GAPS\nThe multi-value route has no trace."), "evidence-gaps");
  assert.equal(missionReviewVerdict("FINDINGS\nzero dhi remains positive"), "findings");
  assert.equal(missionReviewVerdict("I think EVIDENCE_GAPS"), "findings");
  const review = { runID: "run", risk: ["public-logic"], source: "source", task: null };
  assert.equal(missionReviewAccepted({ ...review, verdict: "evidence-gaps", evidenceGapReviews: 1 }), false);
  assert.equal(missionReviewAccepted({ ...review, verdict: "evidence-gaps", evidenceGapReviews: MISSION_EVIDENCE_GAP_REVIEW_LIMIT }), true);
  assert.equal(missionReviewAccepted({ ...review, verdict: "findings", evidenceGapReviews: 5 }), false);
  assert.equal(missionReviewAccepted({ ...review, verdict: "pending", evidenceGapReviews: 5 }), false);
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const run = await operators.prepareMission("root", missionPlan(mission, [unit]));
  const gap = { ...mission, review: { ...review, verdict: "evidence-gaps" as const, evidenceGapReviews: 1 } };
  const packet = missionPacket(gap, { ...run, phase: "awaiting-acceptance" }) as { next_action: string; review: Record<string, unknown> };
  assert.match(packet.next_action, /do not re-implement/u);
  assert.deepEqual([packet.review.evidence_gap_reviews, packet.review.accepted], [1, false]);
}));

test("mission captures exact original messages, generates IDs, and preserves requirements across restart", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: " Fix this.\r\nDo not change tests.  " });
  const mission = await missions.start("root", ["Fix result", "Do not change tests"]);
  await missions.capture("root", { id: "u2", text: "Also preserve the newline." });
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const restored = await cold.required("root");
  assert.equal(restored.id, mission.id);
  assert.deepEqual(restored.requests, [{ id: "u1", text: " Fix this.\r\nDo not change tests.  " }, { id: "u2", text: "Also preserve the newline." }]);
  assert.deepEqual(restored.requirements.map(item => item.id), ["R1", "R2"]);
  await assert.rejects(cold.start("root", ["Only fix a smaller part"]), /requirements-preserved/);
  const extended = await cold.start("root", ["Fix result", "Do not change tests", "Preserve newline"]);
  assert.equal(extended.id, mission.id);
}));

test("mission Coordinator owns a single Worker unit without a proposal or root approval", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const task = missions.task(mission);
  await missions.admit("root", "coordinator-call", task);
  const brief = await missions.claim("root", "coordinator", task.prompt);
  assert.match(brief, /Fix result/);
  const state = await operators.prepareMission("root", missionPlan(mission, [unit]), { sessionID: "coordinator", callID: "coordinator-call" });
  const next = await operators.next("root", "coordinator") as { task: typeof task };
  await assert.rejects(operators.admitWorker("root", "root", "forged", next.task), /owner-mismatch/);
  await operators.admitWorker("root", "coordinator", "worker-call", next.task);
  await assert.rejects(operators.claimAdmittedWorkerPrompt("root", "root", "worker", next.task.prompt), /parent-mismatch/);
  const admitted = await operators.claimAdmittedWorkerPrompt("root", "coordinator", "worker", next.task.prompt);
  assert.match(admitted.prompt, /Read-only investigation commands are unrestricted/);
  assert.equal((await operators.required("root")).runID, state.runID);
  await assert.rejects(operators.retireMissionRun("root"), /still-active/);
}));

test("mission rejects foreign Coordinator claims and duplicate dispatches", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const task = missions.task(mission);
  await assert.rejects(missions.claim("root", "child", task.prompt), /claim-invalid/);
  await missions.admit("root", "call", task);
  await assert.rejects(missions.admit("root", "another-call", task), /not-authorized/);
  await missions.claim("root", "child", task.prompt);
  await assert.rejects(missions.claim("root", "foreign-child", task.prompt), /claim-invalid/);
}));

test("cold mission reopens only the terminal native dispatch and retains its Coordinator", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const started = await missions.start("root", ["Fix result"]);
  await missions.admit("root", "first-call", missions.task(started));
  await missions.claim("root", "coordinator", missions.task(started).prompt);
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await assert.rejects(cold.admit("root", "second-call", cold.task(await cold.required("root"))), /not-authorized/u);
  await assert.rejects(cold.reconcileFinishedDispatch("root", started.id, "wrong-call"), /reconciliation-stale/u);
  const resumed = await cold.reconcileFinishedDispatch("root", started.id, "first-call");
  assert.equal(resumed.coordinator, "coordinator");
  assert.equal(resumed.dispatchOpen, false);
  await assert.rejects(cold.reconcileFinishedDispatch("root", started.id, "first-call"), /reconciliation-stale/u);
  const task = cold.task(resumed);
  assert.equal(task.task_id, "coordinator");
  await cold.admit("root", "second-call", task);
  assert.equal((await cold.required("root")).dispatchOpen, true);
}));

test("generated proof retains negative constraints and rejects dropped requirements or control writes", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result; do not change tests" });
  const mission = await missions.start("root", ["Fix result", "Do not change tests"]);
  const plan = missionPlan(mission, [unit]);
  assert.deepEqual(plan.acceptance, ["Fix result", "Do not change tests"]);
  assert.deepEqual(plan.units[0]!.acceptance_indices, [0, 1]);
  assert.throws(() => missionPlan(mission, [{ ...unit, requirement_ids: ["R1"] }]), /mission-uncovered: R2/);
  assert.throws(() => missionPlan(mission, [{ ...unit, write: [".git"] }]), /control-write-forbidden/);
  assert.throws(() => missionPlan(mission, [{ ...unit, write: ["../escape"] }]));
}));

test("mission replan archives failed execution, keeps original acceptance and binds a fresh bounded scope", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const state = await operators.prepareMission("root", missionPlan(mission, [unit]));
  const task = operators.nextWorkerTask(state);
  await operators.admitWorker("root", "root", "call", task);
  await operators.claimAdmittedWorkerPrompt("root", "root", "worker", task.prompt);
  await operators.settled({ rootSessionID: "root", callID: "call", childSessionID: "worker", unitID: "unit-1",
    disposition: "failed", resultClass: "process-defect", evidence: [], failure: { command: ["node", "check.mjs"], outcome: "fail", exitCode: 1 } });
  await operators.retireMissionRun("root");
  const replacement = await operators.prepareMission("root", missionPlan(mission, [{ ...unit, write: ["src", "test"] }]));
  assert.equal(replacement.parentRunID, state.runID);
  assert.deepEqual(replacement.acceptance, state.acceptance);
  assert.notEqual(replacement.runID, state.runID);
  const manifest = JSON.parse(await readFile(replacement.units[0]!.manifestPath, "utf8"));
  assert.deepEqual(manifest.write, ["src", "test"]);
}));

test("a later user turn can replace a cancelled mission without inheriting its old acceptance", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Run v0.12.3" });
  const oldMission = await missions.start("root", ["Run v0.12.3", "Keep cumulative budget"]);
  const oldRun = await operators.prepareMission("root", missionPlan(oldMission, [{ ...unit, requirement_ids: ["R1", "R2"] }]));
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });

  // A cancellation in the original user turn is not permission to discard that turn's acceptance.
  const sameTurn = await missions.start("root", ["Run v0.12.4", "Keep cumulative budget"]);
  assert.equal(sameTurn.supersededRunID, undefined);
  await assert.rejects(operators.prepareMission("root", missionPlan(sameTurn, [{ ...unit, requirement_ids: ["R1", "R2"] }])),
    /operator-acceptance-carry-forward-required/);
  await missions.capture("root", { id: "u2", text: "Use v0.12.4 and start a new mission" });
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });
  const replacement = await missions.start("root", ["Run v0.12.4", "Keep cumulative budget"]);
  assert.equal(replacement.supersededRunID, oldRun.runID);
  const missionFile = join(directory, ".sortie-dogs-v010", "missions", `${createHash("sha256").update("root").digest("hex")}.json`);
  // The already-blocked desktop mission was persisted by the older release without this link.
  await writeFile(missionFile, JSON.stringify({ ...replacement, supersededRunID: undefined }));
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  assert.equal((await cold.required("root")).supersededRunID, oldRun.runID);
  assert.equal((await cold.start("root", replacement.requirements.map(item => item.text))).supersededRunID, oldRun.runID);
  const plan = missionPlan(replacement, [{ ...unit, requirement_ids: ["R1", "R2"] }]);
  await assert.rejects(operators.prepareMission("root", plan, undefined, "operator-stale"), /mission-superseded-run-mismatch/);
  const next = await operators.prepareMission("root", plan, undefined, replacement.supersededRunID);
  assert.deepEqual(next.acceptance, ["Run v0.12.4", "Keep cumulative budget"]);
  assert.equal(next.parentRunID, null);
  assert.deepEqual(next.priorAcceptedUnits, []);
  assert.equal(next.supersededRunID, oldRun.runID);
  assert.notEqual(next.runID, oldRun.runID);
  assert.equal((await operators.prepareMission("root", plan, undefined, replacement.supersededRunID)).runID, next.runID);
  const archive = JSON.parse(await readFile(join(directory, ".sortie-dogs-v010", "operators",
    `${createHash("sha256").update("root").digest("hex")}.json.${oldRun.runID}.archive`), "utf8"));
  assert.equal(archive.runID, oldRun.runID);
  assert.equal(archive.phase, "cancelled");
  assert.deepEqual(archive.acceptance, ["Run v0.12.3", "Keep cumulative budget"]);
}));

test("a new mission cannot discard an old run that reached a worker", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Old goal" });
  const oldMission = await missions.start("root", ["Old goal"]);
  const oldRun = await operators.prepareMission("root", missionPlan(oldMission, [unit]));
  const task = operators.nextWorkerTask(oldRun);
  await operators.admitWorker("root", "root", "worker-call", task);
  await operators.claimAdmittedWorkerPrompt("root", "root", "worker", task.prompt);
  await missions.capture("root", { id: "u2", text: "Replace old goal" });
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });
  const newMission = await missions.start("root", ["New goal"]);
  assert.equal(newMission.supersededRunID, oldRun.runID);
  await assert.rejects(operators.prepareMission("root", missionPlan(newMission, [unit]), undefined, newMission.supersededRunID),
    /mission-superseded-run-has-work/);
  assert.equal((await operators.required("root")).runID, oldRun.runID);
}));
