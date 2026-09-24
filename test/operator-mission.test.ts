import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorMissionRuntime, missionPlan, missionReviewTask, missionReviewTraces } from "../dist/core/operator-mission.js";
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
