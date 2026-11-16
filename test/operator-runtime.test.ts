import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { directValidationRegistrationPlanHash, OperatorRuntime, recoverLegacyRegistrationScopes } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

test("legacy multiple expanded units recover only their frozen plan identity", () => {
  const first = { id: "unit-1", title: "first", objective: "first", read: [], write: ["first"], validation: ["check1"], acceptance_indices: [0] };
  const second = { id: "unit-2", title: "second", objective: "second", read: [], write: ["second"], validation: ["check2"], acceptance_indices: [0] };
  const original = { goal_declaration: { criteria: [] }, units: [first, second] };
  const planHash = createHash("sha256").update(JSON.stringify(original)).digest("hex");
  const expanded1 = { ...first, write: ["first", "first-extra"] }, expanded2 = { ...second, write: ["second", "second-extra"] };
  const state = { planHash, units: [{ unit: expanded1 }, { unit: expanded2 }] } as any;
  const proposal = { ...original, units: [expanded1, { ...expanded2, validation: ["check2-new"] }] } as any;
  assert.deepEqual([...recoverLegacyRegistrationScopes(state, proposal, "unit-2")!], [["unit-1", ["first"]], ["unit-2", ["second"]]]);
  assert.equal(recoverLegacyRegistrationScopes(state, { ...proposal, units: [expanded1, { ...proposal.units[1], objective: "unauthorized" }] }, "unit-2"), undefined);
  assert.equal(recoverLegacyRegistrationScopes(state, { ...proposal, units: [expanded1, { ...proposal.units[1], write: [...expanded2.write, "unapproved"] }] }, "unit-2"), undefined);
});

test("scope registration restores only the generated entrypoint of an initially read-only unit", () => {
  const mission = { id: "scope-entrypoint", requirements: [{ id: "R1", text: "Validate and retain the result" }], requests: [{ id: "request" }] } as any;
  const declaration = { title: "Check", objective: "Validate and retain the result", read: ["check.mjs"], write: [], validation: ["node check.mjs"] };
  const original = missionPlan(mission, [declaration]);
  const planHash = createHash("sha256").update(JSON.stringify(original)).digest("hex");
  const expanded = { ...declaration, write: ["result.txt"], validation: ["node check.mjs --corrected"] };
  const proposal = missionPlan(mission, [expanded]);
  for (const legacy of [false, true]) {
    const state = { planHash, units: [{ unit: { ...original.units[0], write: expanded.write }, ...(legacy ? {} : { initialWriteScope: [] }) }] } as any;
    const scopes = recoverLegacyRegistrationScopes(state, proposal, "unit-1");
    if (legacy) assert.deepEqual([...scopes!], [["unit-1", []]]);
    assert.equal(directValidationRegistrationPlanHash(state, proposal, "unit-1", scopes), planHash);
    const changed = structuredClone(proposal);
    changed.goal_declaration.criteria[0]!.entrypoint = "unrelated.txt";
    assert.notEqual(directValidationRegistrationPlanHash(state, changed, "unit-1", scopes), planHash,
      "only the scope-derived generated entrypoint is normalized");
    assert.equal(recoverLegacyRegistrationScopes(state, changed, "unit-1"), undefined);
  }
});

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
