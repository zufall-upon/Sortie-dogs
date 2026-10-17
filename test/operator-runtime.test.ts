import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

test("saved V2 Worker calls retain exact task authority when their display label is shortened", async () => {
  const area = resolve("_testenv");
  await mkdir(area, { recursive: true });
  const directory = await mkdtemp(join(area, "worker-display-label-"));
  try {
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "request", text: "Implement the requested schema behavior" });
    const mission = await missions.start("root", ["Implement the requested schema behavior"]);
    const coordinatorTask = missions.task(mission);
    await missions.admit("root", "coordinator-call", coordinatorTask);
    await missions.claim("root", "coordinator", coordinatorTask.prompt);
    const run = await operators.prepareMission("root", missionPlan(mission, [{
      title: "Implement JSON Schema dependencies, references, and conditionals",
      objective: "Implement the requested behavior and run its real project checks",
      read: ["check.mjs"], write: ["src"], validation: ["node check.mjs"],
    }]), { sessionID: "coordinator", callID: "coordinator-call" });
    const task = operators.nextWorkerTask(run);
    const saved = { agent: task.subagent_type, description: "Implement schema features and regressions", prompt: task.prompt };
    assert.equal(operators.matchesRecordedWorkerTask(run, "unit-1", saved), true);
    assert.equal(operators.matchesRecordedWorkerTask(run, "unit-1", { ...saved, prompt: `${saved.prompt}\nchanged` }), false);
    assert.equal(operators.matchesRecordedWorkerTask(run, "unit-1", { ...saved, agent: "dog-reviewer-v010" }), false);
    assert.equal(operators.matchesRecordedWorkerTask(run, "unit-1", { ...saved, sessionID: "foreign", task_id: "foreign" }), false);
    const dispatch = { ...task, description: saved.description };
    await assert.rejects(operators.admitWorker("root", "root", "forged-owner", dispatch), /owner-mismatch/);
    const canonical = await operators.admitWorker("root", "coordinator", "worker-call", dispatch);
    assert.deepEqual(canonical, run.units[0]!.task, "only the immutable retained task reaches the child");
    const claimed = await operators.claimAdmittedWorkerPrompt("root", "coordinator", "worker", task.prompt);
    assert.equal(claimed.prompt, canonical.prompt);
    assert.equal((await operators.required("root")).dispatched, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
