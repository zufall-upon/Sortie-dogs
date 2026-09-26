import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { MISSION_EVIDENCE_GAP_REVIEW_LIMIT, OperatorMissionRuntime, missionPacket, missionPlan, missionReviewAccepted, missionReviewTask,
  missionReviewTraces, missionReviewVerdict } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { terminalCancelledMissionChildren } from "../dist/plugin/profiled.js";

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
  const bounded = { ...gap, review: { ...gap.review, evidenceGapReviews: MISSION_EVIDENCE_GAP_REVIEW_LIMIT } };
  const accepted = missionPacket(bounded, { ...run, phase: "awaiting-acceptance" }) as typeof packet;
  assert.equal(accepted.review.passed, false);
  assert.equal(accepted.review.permits_submission, true);
  assert.match(accepted.next_action, /do not repeat passed validation or review/);
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

test("cancelled no-run successor preserves the old run's supersession across another user turn and cold reload", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "old-request", text: "Assess the old package" });
  const old = await missions.start("root", ["Old package", "Old verification"]);
  const oldTask = missions.task(old);
  await missions.admit("root", "old-call", oldTask);
  await missions.claim("root", "old-coordinator", oldTask.prompt);
  const run = await operators.prepareMission("root", missionPlan(old, [unit]),
    { sessionID: "old-coordinator", callID: "old-call" });
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = run.runID; });

  await missions.capture("root", { id: "new-request", text: "Study the new package" });
  const intermediate = await missions.start("root", ["New package"]);
  assert.equal(intermediate.supersededRunID, run.runID);
  await missions.capture("root", { id: "latest-request", text: "Continue with five failed instances" });
  await missions.update("root", state => { state.phase = "cancelled"; });
  const current = await missions.start("root", ["Inspect the five failed instances"]);
  assert.equal(current.supersededRunID, run.runID);

  // Already-stuck missions from the old plugin have no persisted predecessor link.
  const file = join(directory, ".sortie-dogs-v010", "missions", `${createHash("sha256").update("root").digest("hex")}.json`);
  await writeFile(file, JSON.stringify({ ...current, supersededRunID: undefined }));
  const recovered = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
  assert.equal(recovered.supersededRunID, run.runID);
  // Another user turn may cancel the blocked mission before the corrected plugin is installed.
  await writeFile(file, JSON.stringify({ ...current, phase: "cancelled", supersededRunID: undefined }));
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  assert.equal((await cold.required("root")).supersededRunID, run.runID);
  const resumed = await cold.start("root", ["Inspect the five failed instances"]);
  assert.equal(resumed.supersededRunID, run.runID);
  const replacement = await operators.prepareMission("root", missionPlan(resumed, [unit]), undefined, resumed.supersededRunID);
  assert.deepEqual(replacement.acceptance, ["Inspect the five failed instances"]);
  assert.equal(replacement.parentRunID, null);
  assert.equal(replacement.supersededRunID, run.runID);
}));

test("same-turn mission retains a cancelled run's exact acceptance before its Coordinator declares units", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Continue MK2-04 under the old acceptance" });
  const first = await missions.start("root", ["Keep the old validation boundary", "Do not use the user's Go toolchain"]);
  const old = await operators.prepareMission("root", missionPlan(first, [unit]),
    { sessionID: "old-coordinator", callID: "old-call" });
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = old.runID; });
  const next = await missions.start("root", ["Continue MK2-04"]);
  assert.equal(next.supersededRunID, undefined);
  await assert.rejects(operators.prepareMission("root", missionPlan(next, [unit])), /operator-acceptance-carry-forward-required/);
  const retained = await missions.carryForward("root", next.id, old.acceptance);
  assert.deepEqual(retained.requirements.map(item => item.text),
    ["Keep the old validation boundary", "Do not use the user's Go toolchain", "Continue MK2-04"]);
  const task = missions.task(retained);
  await missions.admit("root", "new-call", task);
  await missions.claim("root", "new-coordinator", task.prompt);
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const recovered = await cold.carryForward("root", next.id, old.acceptance);
  assert.deepEqual(recovered.requirements, retained.requirements);
  const prepared = await operators.prepareMission("root", missionPlan(recovered, [unit]),
    { sessionID: "new-coordinator", callID: "new-call" });
  assert.equal(prepared.operatorSessionID, "new-coordinator");
  assert.equal(prepared.parentRunID, old.runID);
  assert.deepEqual(prepared.acceptance, retained.requirements.map(item => item.text));
  assert.ok(operators.nextWorkerTask(prepared));
}));

test("a same-turn replacement cannot bypass terminal proof of a cancelled Worker", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Continue the old request" });
  const oldMission = await missions.start("root", ["Keep old acceptance"]);
  const old = await operators.prepareMission("root", missionPlan(oldMission, [unit]),
    { sessionID: "old-coordinator", callID: "old-call" });
  const task = operators.nextWorkerTask(old);
  await operators.admitWorker("root", "old-coordinator", "worker-call", task);
  await operators.claimAdmittedWorkerPrompt("root", "old-coordinator", "old-worker", task.prompt);
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = old.runID; });
  const next = await missions.start("root", ["Keep old acceptance", "Continue the old request"]);
  const plan = missionPlan(next, [unit]);
  await assert.rejects(operators.prepareMission("root", plan, { sessionID: "new-coordinator", callID: "new-call" }),
    /mission-cancelled-run-worker-not-terminal/);
  assert.equal((await operators.required("root")).runID, old.runID);
  const resumed = await operators.prepareMission("root", plan, { sessionID: "new-coordinator", callID: "new-call" },
    undefined, ["old-worker"]);
  assert.equal(resumed.parentRunID, old.runID);
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

test("a later mission replaces a cancelled worker and pending unit only after host terminal proof", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "old-user", text: "Run the old candidate" });
  const oldMission = await missions.start("root", ["Run the old candidate"]);
  const oldRun = await operators.prepareMission("root", missionPlan(oldMission, [unit,
    { ...unit, title: "Later", validation: ["node later.mjs"] }]), { sessionID: "coordinator", callID: "mission-call" });
  const task = operators.nextWorkerTask(oldRun);
  await operators.admitWorker("root", "coordinator", "old-call", task);
  await operators.claimAdmittedWorkerPrompt("root", "coordinator", "old-worker", task.prompt);
  await operators.interrupted("root", "explicit-cancellation");
  const cancelled = await operators.required("root");
  const sessions = new Map([
    ["coordinator", { id: "coordinator", agent: "dogs-coordinator", parentID: "root", outcome: "interrupted" }],
    ["old-worker", { id: "old-worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "interrupted" }],
  ]);
  const host = { get: async (id: string) => sessions.get(id),
    children: async (id: string) => id === "coordinator" ? [{ id: "old-worker" }] : [] };
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", cancelled,
    { reserved_units: 1 }, host), /reservations-pending/);
  sessions.set("old-worker", { id: "old-worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "running" });
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", cancelled,
    { reserved_units: 0 }, host), /worker-not-terminal/);
  sessions.set("old-worker", { id: "old-worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "interrupted" });
  const proof = await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", cancelled, { reserved_units: 0 }, host);
  assert.deepEqual(proof, ["old-worker"]);
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });
  await missions.capture("root", { id: "new-user", text: "Run the new candidate" });
  const nextMission = await missions.start("root", ["Run the new candidate"]);
  const plan = missionPlan(nextMission, [unit]);
  await assert.rejects(operators.prepareMission("root", plan, undefined, oldRun.runID), /mission-superseded-run-has-work/);
  await assert.rejects(operators.prepareMission("root", plan, undefined, oldRun.runID, ["other-worker"]), /mission-superseded-run-has-work/);
  const next = await operators.prepareMission("root", plan, undefined, oldRun.runID, proof);
  assert.deepEqual(next.acceptance, ["Run the new candidate"]);
  assert.deepEqual(next.priorAcceptedUnits, []);
  assert.equal(next.parentRunID, null);
  assert.equal(next.supersededRunID, oldRun.runID);
  const archived = JSON.parse(await readFile(join(directory, ".sortie-dogs-v010", "operators",
    `${createHash("sha256").update("root").digest("hex")}.json.${oldRun.runID}.archive`), "utf8"));
  assert.equal(archived.units[0].childSessionID, "old-worker");
  assert.equal(archived.units[1].status, "pending");
}));

function terminalHistory() {
  const previous = { operatorSessionID: "coordinator", units: [{ childSessionID: "worker" }] } as never;
  const sessions: Record<string, { id: string; agent: string; parentID: string; outcome?: string }> = {
    coordinator: { id: "coordinator", agent: "dogs-coordinator", parentID: "root", outcome: "succeeded" },
    worker: { id: "worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "succeeded" },
    prior: { id: "prior", agent: "dog-worker-v010", parentID: "coordinator", outcome: "failed" },
    reviewer: { id: "reviewer", agent: "dog-reviewer-v010", parentID: "coordinator", outcome: "succeeded" },
    scout: { id: "scout", agent: "dog-scout-v010", parentID: "coordinator", outcome: "interrupted" },
  };
  const children: Record<string, { id: string }[]> = { coordinator: ["worker", "prior", "reviewer", "scout"].map(id => ({ id })) };
  return { previous, sessions, children, host: { get: async (id: string) => sessions[id], children: async (id: string) => children[id] ?? [] } };
}

test("terminal mission proof accepts completed workers and settled prior consultations", async () => {
  const f = terminalHistory();
  assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), ["worker"]);
});

test("terminal proof for a root-dispatched Worker does not claim unrelated root sessions", async () => {
  const f = terminalHistory();
  f.sessions.worker!.parentID = "root";
  delete f.sessions.coordinator!.outcome;
  const previous = { operatorSessionID: null, units: [{ childSessionID: "worker" }] } as never;
  assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", previous, { reserved_units: 0 }, f.host), ["worker"]);
});

test("terminal mission proof rejects active, missing and foreign native lineage", async () => {
  const changes: [string, (f: ReturnType<typeof terminalHistory>) => void][] = [
    ["active Coordinator", f => { delete f.sessions.coordinator!.outcome; }],
    ["active Worker", f => { delete f.sessions.worker!.outcome; }],
    ["active old Worker", f => { delete f.sessions.prior!.outcome; }],
    ["active Reviewer", f => { delete f.sessions.reviewer!.outcome; }],
    ["unknown outcome", f => { f.sessions.worker!.outcome = "idle"; }],
    ["foreign Coordinator", f => { f.sessions.coordinator!.parentID = "foreign"; }],
    ["foreign child", f => { f.sessions.reviewer!.parentID = "foreign"; }],
    ["foreign role", f => { f.sessions.reviewer!.agent = "build"; }],
    ["wrong child identity", f => { f.sessions.worker!.id = "other"; }],
    ["missing child", f => { delete f.sessions.worker; }],
    ["missing listing", f => { f.children.coordinator = [{ id: "reviewer" }]; }],
    ["duplicate listing", f => { f.children.coordinator!.push({ id: "worker" }); }],
    ["unproven descendant", f => { f.children.reviewer = [{ id: "nested" }]; }],
  ];
  for (const [name, change] of changes) {
    const f = terminalHistory(); change(f);
    await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), /mission-superseded-/, name);
  }
  const f = terminalHistory();
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 1 }, f.host), /reservations-pending/);
});
