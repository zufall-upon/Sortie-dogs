import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { initializeProject } from "../dist/core/initialize.js";
import { missionLocations } from "../dist/plugin/mission-location.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

async function fixture(run: (area: string, current: string, old: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const area = await mkdtemp(resolve("_testenv/mission-location-"));
  const current = join(area, "current"), old = join(area, "old");
  await mkdir(current); await mkdir(old);
  try { await run(area, current, old); } finally { await rm(area, { recursive: true, force: true }); }
}

async function seed(directory: string) {
  const runtime = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await runtime.capture("root", { id: "original", text: "Complete the existing work and retain cumulative budget" });
  const mission = await runtime.start("root", ["Complete existing work", "Keep cumulative spend"]);
  await runtime.admit("root", "original-call", runtime.task(mission));
  await runtime.claim("root", "coordinator", runtime.task(mission).prompt);
  await runtime.update("root", state => {
    state.dispatchOpen = false; state.phase = "submitted";
    state.submission = { status: "blocked", summary: "Resume after correcting the host" };
  });
  return runtime;
}

test("mission location discovery uses native ownership and leaves both locations untouched", async () => fixture(async (_area, current, old) => {
  const runtime = await seed(old), before = await runtime.required("root");
  const child = { id: "coordinator", parentID: "root", agent: "dogs-coordinator", location: { directory: old } };
  const discover = (value: unknown) => missionLocations("root", current, V010_RUNTIME_PROFILE, async () => value);
  const found = await discover([child]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.mission.id, before.id);
  assert.equal(resolve(found[0]!.directory), resolve(old));
  for (const invalid of [{ ...child, parentID: "foreign" }, { ...child, agent: "dog-worker-v010" },
    { ...child, id: "other-coordinator" }, { ...child, location: { directory: "relative-path" } },
    { ...child, location: { directory: current } }]) assert.deepEqual(await discover([invalid]), []);
  assert.deepEqual(await runtime.required("root"), before);
  assert.equal(await new OperatorMissionRuntime(current, V010_RUNTIME_PROFILE).read("root"), undefined);
  await runtime.update("root", state => { state.phase = "completed"; });
  assert.deepEqual(await discover([child]), []);
}));

test("status/start guide a moved root back to its mission instead of creating a substitute", async () => fixture(async (_area, current, old) => {
  await initializeProject(current, "v010"); await initializeProject(old, "v010");
  const runtime = await seed(old), before = await runtime.required("root");
  const identities: Record<string, unknown> = {
    root: { id: "root", agent: "dog-operator", location: { directory: current } },
    coordinator: { id: "coordinator", parentID: "root", agent: "dogs-coordinator", location: { directory: old } },
  };
  const client = { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    children: async () => ({ data: [identities.coordinator] }), messages: async () => ({ data: [] }),
  } };
  const moved = await SortieDogsV010Plugin({ directory: current, client } as never);
  const status = JSON.parse(await moved.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "mission-location-required");
  assert.equal(status.resume_location.directory, old);
  assert.equal(status.missions[0].mission_id, before.id);
  assert.match(status.next_action, /session_move/);
  const started = JSON.parse(await moved.tool!.sortie_v010_start_mission.execute({ requirements: ["Resume test"] }, { sessionID: "root" }));
  assert.equal(started.status, "mission-location-required");
  assert.equal(await new OperatorMissionRuntime(current, V010_RUNTIME_PROFILE).read("root"), undefined);
  await assert.rejects(moved["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "wrong-location" },
    { args: { subagent_type: "dogs-coordinator", task_id: "coordinator", prompt: "Continue", description: "Resume" } }),
    /mission-coordinator-location-mismatch.*mission-location-required/);
  assert.deepEqual(await runtime.required("root"), before, "a wrong-location attempt must not change admission or submission");

  const resumed = await SortieDogsV010Plugin({ directory: old, client } as never);
  const correct = JSON.parse(await resumed.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(correct.mission_id, before.id);
  assert.equal(correct.project_root, old);
  assert.equal(correct.coordinator_dispatch, "resumable");
  assert.equal(correct.task.task_id, "coordinator", "blocked submitted missions expose their exact continuation task");
  await resumed["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "resumed-call" }, { args: correct.task });
  assert.equal((await runtime.required("root")).dispatchOpen, true);
  assert.deepEqual((await runtime.required("root")).requirements, before.requirements);
  await resumed["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "resumed-call" }, { output: "Observed resumed mission" });
  assert.equal((await runtime.required("root")).dispatchOpen, false);

  await moved["chat.message"]!({ sessionID: "root", messageID: "separate", agent: "dog-operator" }, {
    message: { id: "separate", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-sol" } },
    parts: [{ type: "text", text: "Implement a separate change in this new location" }],
  });
  const separate = JSON.parse(await moved.tool!.sortie_v010_start_mission.execute({ requirements: ["Separate change"], intent: "new" }, { sessionID: "root" }));
  assert.notEqual(separate.mission_id, before.id);
  assert.deepEqual((await runtime.required("root")).requirements, before.requirements);
}));

test("unavailable optional location discovery is visible and does not block a fresh mission", async () => fixture(async (_area, current) => {
  await initializeProject(current, "v010");
  const hooks = await SortieDogsV010Plugin({ directory: current, client: { session: {
    get: async () => ({ data: { id: "root", agent: "dog-operator" } }), messages: async () => ({ data: [] }),
    children: async () => { throw new Error("native-list-unavailable"); },
  } } } as never);
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "absent");
  assert.equal(status.location_discovery.reason, "native-list-unavailable");
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-sol" } },
    parts: [{ type: "text", text: "Implement the requested change" }],
  });
  const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Implement change"] }, { sessionID: "root" }));
  assert.ok(started.task);
  assert.equal(started.location_discovery.status, "unavailable");
}));
