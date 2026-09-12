import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorRuntime, parseOperatorPlan } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE, STABLE_RUNTIME_PROFILE, profileAgent, profileTool } from "../dist/core/runtime-profile.js";
import { initializeProject } from "../dist/core/initialize.js";
import { runtimeAssets as stableAssets } from "../dist/runtime-assets.js";
import { runtimeAssets as previewAssets } from "../dist/runtime-assets-v010.js";
import { RUNTIME_ASSET_VERSION, V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

async function fixture(run: (root: string) => Promise<void>) {
  const area = resolve("_testenv");
  await mkdir(area, { recursive: true });
  const root = await mkdtemp(join(area, "v010-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function plan() {
  return { schema_version: "0.1", acceptance: ["Preserve all accepted behavior", "Do not modify the oracle"], acceptance_proof: [["first", "second"], ["first", "second"]],
    source_refs: ["fixture:original-request"], goal_declaration: {
      delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false,
      defaults: { target: "accepted behavior", entrypoint: "check.mjs", workload: "fixture", oracle_coverage: ["content"],
        build_boundary: "not-applicable", source: "source", candidate: "candidate", fixture: "fixture",
        source_binding: "current-protected", candidate_binding: "current-protected", proof_scope: "requested-full", expected_outcome: "pass" },
      criteria: ["first", "second"].map(id => ({ criterion_id: id, validation_command: `node check-${id}.mjs` })),
    }, units: ["first", "second"].map(id => ({ id, title: `Implement ${id}`, objective: `Complete ${id} without reducing acceptance`,
      read: [`check-${id}.mjs`], write: [`${id}.txt`], validation: [`node check-${id}.mjs`], acceptance_indices: [0, 1] })) };
}

test("preview assets coexist with stable assets and markers", async () => fixture(async root => {
  await initializeProject(root);
  const before = await Promise.all(stableAssets.map(asset => readFile(join(root, ".opencode", asset.installPath), "utf8")));
  const installed = await initializeProject(root, "v010");
  assert.equal(installed.version, V010_RUNTIME_ASSET_VERSION);
  assert.equal(previewAssets.length, stableAssets.length + 1);
  assert.equal(new Set(previewAssets.map(asset => asset.installPath)).size, previewAssets.length);
  assert.equal(await readFile(join(root, ".opencode/sortie-dogs.version"), "utf8"), `${RUNTIME_ASSET_VERSION}\n`);
  assert.equal(await readFile(join(root, ".opencode/sortie-dogs-v010.version"), "utf8"), `${V010_RUNTIME_ASSET_VERSION}\n`);
  for (const [index, asset] of stableAssets.entries()) assert.equal(await readFile(join(root, ".opencode", asset.installPath), "utf8"), before[index]);
  for (const asset of previewAssets) {
    assert.equal(asset.version, V010_RUNTIME_ASSET_VERSION);
    assert.equal(await readFile(join(root, ".opencode", asset.installPath), "utf8"), asset.content);
    if (asset.installPath.startsWith("agent/") && !asset.name.startsWith("dog-coordinator")) assert.match(asset.content, /^hidden: true$/m);
  }
  assert.equal((await initializeProject(root, "v010")).status, "unchanged");
}));

test("operator plan validates explicit scope and keeps criteria immutable", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const original = plan();
  const state = await runtime.prepare("root", original);
  assert.deepEqual(state.acceptance, original.acceptance);
  for (const unit of state.units) {
    const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
    assert.deepEqual(handoff.ext["sortie-dogs/acceptance-continuity"].criteria, original.acceptance);
    assert.match(unit.task.subagent_type, /-v010$/);
  }
  assert.equal((await runtime.prepare("root", original)).runID, state.runID);
  await assert.rejects(runtime.prepare("root", { ...original, acceptance: ["Weaker objective", original.acceptance[1]] }), /immutable/);
  assert.throws(() => parseOperatorPlan({ ...original, extra: true }), /invalid/);
  assert.throws(() => parseOperatorPlan({ ...original, units: [{ ...original.units[0], write: ["../outside"] }] }));
}));

test("operator grants reject identity drift, duplicate admission, source writes and stale controls", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("root", plan());
  const task = runtime.operatorTask(state);
  await runtime.admitOperator("root", "operator-call", task);
  await runtime.bindOperator("root", "operator-child", task.prompt);
  const ready = await runtime.next("root", "operator-child") as { task: { prompt: string } };
  await assert.rejects(runtime.next("root", "foreign"), /owner/);
  await assert.rejects(runtime.admitWorker("root", "operator-child", "bad", { ...ready.task, prompt: `${ready.task.prompt}\nweaken scope` }), /not-authorized/);
  const outcomes = await Promise.allSettled([
    runtime.admitWorker("root", "operator-child", "one", ready.task),
    runtime.admitWorker("root", "operator-child", "two", ready.task),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal((await runtime.required("root")).dispatched, 1);
  await runtime.interrupted("root", "agent-changed");
  await assert.rejects(runtime.admitWorker("root", "operator-child", "three", ready.task), /revoked/);
  const restored = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  assert.equal((await restored.required("root")).dispatched, 1);
  assert.equal((await restored.required("root")).phase, "cancelled");
  const other = await restored.prepare("fresh-root", plan());
  await writeFile(other.units[0].manifestPath, "{}");
  await assert.rejects(restored.admitOperator("fresh-root", "op", { ...restored.operatorTask(other), prompt: "forged" }), /authorized/);
  await restored.admitOperator("fresh-root", "op", restored.operatorTask(other));
  await restored.bindOperator("fresh-root", "child", restored.operatorTask(other).prompt);
  await assert.rejects(restored.next("fresh-root", "child"), /changed/);
}));

test("single unit keeps the direct fast path and incomplete operator return is not acceptance", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const one = plan(); one.units = one.units.slice(0, 1);
  one.goal_declaration.criteria = one.goal_declaration.criteria.slice(0, 1);
  one.acceptance_proof = [["first"], ["first"]];
  const state = await runtime.prepare("root", one);
  await assert.rejects(runtime.admitOperator("root", "op", runtime.operatorTask(state)), /authorized/);
  const task = await runtime.next("root", "root") as { task: object };
  await runtime.admitWorker("root", "root", "worker", task.task);
  const ended = await runtime.operatorReturned("root");
  assert.equal(ended.phase, "awaiting-decision");
  assert.equal((runtime.packet(ended) as { final_acceptance: string }).final_acceptance, "coordinator-required");
}));

test("preview plugin exports only its own serial capabilities and ignores ordinary build", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root });
  assert.ok(hooks.tool?.sortie_v010_prepare_operator);
  assert.ok(hooks.tool?.sortie_v010_bind_write_gate);
  assert.equal(hooks.tool?.sortie_bind_write_gate, undefined);
  assert.equal(hooks.tool?.sortie_v010_prepare_luna_fabric, undefined);
  const output = { message: { agent: "build", model: { providerID: "openai", modelID: "chosen" } }, parts: [{ type: "text", text: "ordinary work" }] };
  const before = structuredClone(output);
  await hooks["chat.message"]?.({ sessionID: "ordinary", agent: "build", messageID: "user" }, output);
  assert.deepEqual(output, before);
  await assert.rejects(hooks.tool!.sortie_v010_prepare_operator.execute({ plan_json: JSON.stringify(plan()) }, { sessionID: "ordinary" }), /root-required/);
  assert.notEqual(profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator"), profileAgent(STABLE_RUNTIME_PROFILE, "dog-coordinator"));
  assert.equal(profileTool(V010_RUNTIME_PROFILE, "sortie_check_contract"), "sortie_v010_check_contract");
}));
