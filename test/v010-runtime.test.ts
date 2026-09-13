import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorRuntime, parseOperatorPlan } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE, STABLE_RUNTIME_PROFILE, canonicalAgent, profileAgent, profileTool } from "../dist/core/runtime-profile.js";
import { initializeProject } from "../dist/core/initialize.js";
import { runtimeAssets as stableAssets } from "../dist/runtime-assets.js";
import { runtimeAssets as previewAssets } from "../dist/runtime-assets-v010.js";
import { RUNTIME_ASSET_VERSION, V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { fixtureOpenCodeConfig } from "../scripts/release-cli.mjs";
import { boundedToolErrors } from "../scripts/operator-smoke.mjs";

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
    assert.match(asset.content, new RegExp(V010_RUNTIME_ASSET_VERSION.replaceAll(".", "\\.")));
    if (asset.installPath.startsWith("agent/") && asset.name !== profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator")) assert.match(asset.content, /^hidden: true$/m);
  }
  assert.deepEqual(previewAssets.map(asset => asset.name), [
    "dog-operator", "dog-worker-v010", "dog-luna-worker-v010", "dog-scout-v010",
    "dog-reviewer-v010", "dog-advisor-v010", "sortie-v010", "dogs-coordinator",
  ]);
  const primary = previewAssets.find(asset => asset.name === "dog-operator")!.content;
  assert.match(primary, /^model: openai\/gpt-5\.6-sol$/m);
  assert.match(primary, /^variant: low$/m);
  assert.match(previewAssets.find(asset => asset.name === "sortie-v010")!.content, /^agent: dog-operator$/m);
  assert.equal((await initializeProject(root, "v010")).status, "unchanged");
}));

test("preview role names are a bijection over separate logical authority identities", () => {
  assert.equal(profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator"), "dog-operator");
  assert.equal(profileAgent(V010_RUNTIME_PROFILE, "dog-operator"), "dogs-coordinator");
  assert.equal(canonicalAgent(V010_RUNTIME_PROFILE, "dog-operator"), "dog-coordinator");
  assert.equal(canonicalAgent(V010_RUNTIME_PROFILE, "dogs-coordinator"), "dog-operator");
  assert.equal(new Set(Object.values(V010_RUNTIME_PROFILE.agentNames)).size, Object.values(V010_RUNTIME_PROFILE.agentNames).length);
});

test("preview default Sol low resolves without an injected catalog", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { config: { providers: async () => ({ data: {
    providers: [{ id: "openai", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol" } } }],
  } }) } } } as never);
  const output = { message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: undefined as string | undefined } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "default", agent: "dog-operator", messageID: "user" }, output);
  assert.equal(output.message.model.modelID, "gpt-5.6-sol");
  assert.equal(output.message.model.variant, "low");
}));

test("preview preserves the user's Astra Low selection across subsequent turns", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root });
  const selected = { providerID: "openai", modelID: "gpt-6-astra", variant: "low" };
  const first = { message: { agent: "dog-operator", model: { ...selected } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "chosen", agent: "dog-operator", messageID: "u1", model: selected }, first);
  assert.deepEqual(first.message.model, selected);
  const next = { message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "chosen", agent: "dog-operator", messageID: "u2" }, next);
  assert.deepEqual(next.message.model, selected);
}));

test("preview external routing is converted before merging and rejects aliases", async () => fixture(async root => {
  const client = { config: { providers: async () => ({ data: { providers: [{ id: "openai", models: {
    "gpt-6-astra": { id: "gpt-6-astra" }, "gpt-5.6-sol": { id: "gpt-5.6-sol" },
  } }] } }) } };
  const hooks = await SortieDogsV010Plugin({ directory: root, client } as never, {
    modelRouting: { "dog-operator": { preferred: { model: "openai/gpt-6-astra", variant: "high" } },
      "dogs-coordinator": { preferred: { model: "openai/gpt-5.6-sol", variant: "medium" } } },
    modelCatalog: { global: [{ model: "openai/gpt-6-astra", variants: ["high"] }, { model: "openai/gpt-5.6-sol", variants: ["low", "medium"] }] },
  });
  const output = { message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "configured", agent: "dog-operator", messageID: "user" }, output);
  assert.equal(output.message.model.modelID, "gpt-6-astra");
  await assert.rejects(SortieDogsV010Plugin({ directory: root }, { modelRouting: {
    "dog-operator": { preferred: { model: "openai/gpt-5.6-sol", variant: "low" } },
    "dog-coordinator": { preferred: { model: "openai/gpt-6-astra", variant: "high" } },
  } }), /route-collision/);
}));

test("rename migration rejects unowned new-name targets before modifying any file", async () => fixture(async root => {
  const agents = join(root, ".opencode", "agent");
  await mkdir(agents, { recursive: true });
  const marker = join(root, ".opencode", "sortie-dogs-v010.version");
  await writeFile(marker, "0.10.0-beta.1\n");
  await writeFile(join(agents, "dog-operator.md"), "my unrelated primary\n");
  await writeFile(join(agents, "dog-coordinator-v010.md"), "my edited old primary\n");
  await assert.rejects(initializeProject(root, "v010"), /unknown ownership/);
  assert.equal(await readFile(marker, "utf8"), "0.10.0-beta.1\n");
  assert.equal(await readFile(join(agents, "dog-operator.md"), "utf8"), "my unrelated primary\n");
  assert.equal(await readFile(join(agents, "dog-coordinator-v010.md"), "utf8"), "my edited old primary\n");
  await assert.rejects(lstat(join(agents, "dogs-coordinator.md")), { code: "ENOENT" });
}));

function oldRoleAsset(name: "dog-operator" | "dogs-coordinator"): string {
  const content = previewAssets.find(asset => asset.name === name)!.content;
  const oldDescription = name === "dog-operator"
    ? "description: Sortie-dogs v0.10 preview — strategic coordinator with an optional bounded operator."
    : "description: Sortie-dogs v0.10 bounded operations delegate; no source or acceptance authority.";
  return content
    .replace(/^description: .*$/m, oldDescription)
    .replace(/^model: openai\/gpt-5\.6-sol$/m, "model: openai/gpt-6-astra")
    .replace(/^variant: low$/m, "variant: high")
    .replaceAll(V010_RUNTIME_ASSET_VERSION, "0.10.0-beta.1")
    .replaceAll("dogs-coordinator", "__OLD_OPERATIONS__")
    .replaceAll("dog-operator", "dog-coordinator-v010")
    .replaceAll("__OLD_OPERATIONS__", "dog-operator-v010");
}

test("preview reinitialization removes only byte-matched generated old role names", async () => fixture(async root => {
  const agents = join(root, ".opencode", "agent");
  await mkdir(agents, { recursive: true });
  await writeFile(join(root, ".opencode", "sortie-dogs-v010.version"), "0.10.0-beta.1\n");
  const oldPrimary = oldRoleAsset("dog-operator");
  const oldDelegate = oldRoleAsset("dogs-coordinator");
  assert.equal(createHash("sha256").update(oldPrimary).digest("hex"), "50eb6392bdd98865b28ba3620781d1d27ab197c7211290745c6db39a0ed8db90");
  assert.equal(createHash("sha256").update(oldDelegate).digest("hex"), "6f2fc1b4ae2bdadcd61b0984636930b60dc84218187107e39c8e1c32c33260cf");
  await writeFile(join(agents, "dog-coordinator-v010.md"), oldPrimary);
  await writeFile(join(agents, "dog-operator-v010.md"), oldDelegate);

  const result = await initializeProject(root, "v010");
  assert.deepEqual(result.preservedLegacyPaths, []);
  await assert.rejects(lstat(join(agents, "dog-coordinator-v010.md")), { code: "ENOENT" });
  await assert.rejects(lstat(join(agents, "dog-operator-v010.md")), { code: "ENOENT" });
  assert.match(await readFile(join(agents, "dog-operator.md"), "utf8"), /^mode: primary$/m);
  assert.match(await readFile(join(agents, "dogs-coordinator.md"), "utf8"), /^mode: subagent$/m);
}));

test("preview reinitialization preserves and reports an edited old role asset", async () => fixture(async root => {
  const oldPath = join(root, ".opencode", "agent", "dog-coordinator-v010.md");
  await mkdir(join(root, ".opencode", "agent"), { recursive: true });
  await writeFile(join(root, ".opencode", "sortie-dogs-v010.version"), "0.10.0-beta.1\n");
  await writeFile(oldPath, `${oldRoleAsset("dog-operator")}\nUser edit.\n`);
  const result = await initializeProject(root, "v010");
  assert.deepEqual(result.preservedLegacyPaths, [".opencode/agent/dog-coordinator-v010.md"]);
  assert.match(await readFile(oldPath, "utf8"), /User edit/);
}));

test("only the isolated preview fixture enables two-level native subagents", () => {
  assert.equal(fixtureOpenCodeConfig("/tmp/preview.js", V010_RUNTIME_PROFILE).subagent_depth, 2);
  assert.equal("subagent_depth" in fixtureOpenCodeConfig("/tmp/stable.js", STABLE_RUNTIME_PROFILE), false);
});

test("operator smoke retains only bounded typed tool errors", () => {
  const detail = "Subagent depth limit reached (1).\nraw host log must not persist";
  assert.deepEqual(boundedToolErrors([
    { type: "log", message: "authentication details" },
    { type: "tool_use", part: { tool: "task", state: { status: "error", error: detail } } },
    { type: "tool_use", part: { tool: "read", state: { status: "completed", output: "raw output" } } },
  ]), [{ tool: "task", status: "error", error: "Subagent depth limit reached (1)." }]);
  assert.equal(boundedToolErrors([{ type: "tool_use", part: { tool: "task", state: {
    status: "error", error: "x".repeat(2048),
  } } }])[0].error.length, 1024);
});

test("preview host adapter pins the native worker route and forwards terminal text through goal verification", async () => fixture(async root => {
  const client = { config: { providers: async () => ({ data: { providers: [{ id: "openai", models: {
    "gpt-6-astra": { id: "gpt-6-astra" }, "gpt-5.6-terra": { id: "gpt-5.6-terra" },
    "gpt-5.6-sol": { id: "gpt-5.6-sol" },
  } }] } }) } };
  const hooks = await SortieDogsV010Plugin({ directory: root, client } as never, { modelCatalog: { global: [
    { model: "openai/gpt-6-astra", variants: ["high"] },
    { model: "openai/gpt-5.6-terra", variants: ["high"] },
    { model: "openai/gpt-5.6-sol", variants: ["low", "medium"] },
  ] } });
  const config = { agent: {
    "dog-operator": { mode: "primary", model: "user/selected", variant: "custom" },
    "dog-worker-v010": { mode: "subagent", model: "openai/gpt-5.6-terra", variant: "high" },
  } };
  await (hooks as typeof hooks & { config(value: Record<string, unknown>): Promise<void> }).config(config);
  assert.deepEqual(config.agent["dog-worker-v010"], {
    mode: "subagent", model: "openai/gpt-5.6-sol", variant: "medium",
  });
  assert.deepEqual(config.agent["dog-operator"], { mode: "primary", model: "user/selected", variant: "custom" });

  const explicitAstra = {
    message: { id: "root-user", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "high" } },
    parts: [{ type: "text", text: "Implement the accepted goal." }],
  };
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-6-astra" } }, explicitAstra);
  assert.deepEqual(explicitAstra.message.model, { providerID: "openai", modelID: "gpt-6-astra", variant: "high" });
  const premature = { text: "DONE — accepted without evidence" };
  await hooks["experimental.text.complete"]!({ sessionID: "root", messageID: "root-assistant" }, premature);
  assert.equal(premature.text, "status: IN_PROGRESS");
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
  assert.equal(runtime.operatorTask(state).subagent_type, "dogs-coordinator");
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

test("rejected dispatches fail only a still-running unit and preserve an existing settlement", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("root", plan());
  const operator = runtime.operatorTask(state);
  await runtime.admitOperator("root", "operator-call", operator);
  await runtime.bindOperator("root", "operator-child", operator.prompt);
  const next = await runtime.next("root", "operator-child") as { task: object };
  await runtime.admitWorker("root", "operator-child", "worker-call", next.task);
  await runtime.rejectDispatch("root", "worker-call");
  const rejected = await runtime.required("root");
  assert.equal(rejected.phase, "awaiting-decision");
  assert.equal(rejected.decision, "native-task-rejected");
  assert.deepEqual(rejected.units[0], { ...rejected.units[0], status: "failed", childSessionID: null,
    evidence: [], resultClass: "process-defect" });

  const successful = await runtime.prepare("successful-root", plan());
  const successfulOperator = runtime.operatorTask(successful);
  await runtime.admitOperator("successful-root", "successful-operator-call", successfulOperator);
  await runtime.bindOperator("successful-root", "successful-operator", successfulOperator.prompt);
  const successfulNext = await runtime.next("successful-root", "successful-operator") as { task: object };
  await runtime.admitWorker("successful-root", "successful-operator", "successful-call", successfulNext.task);
  await runtime.settled({ rootSessionID: "successful-root", callID: "successful-call", unitID: successful.units[0]!.unit.id,
    childSessionID: "successful-child", disposition: "succeeded", evidence: [], resultClass: "acceptance" });
  await runtime.rejectDispatch("successful-root", "successful-call");
  const retained = await runtime.required("successful-root");
  assert.equal(retained.units[0]!.status, "succeeded");
  assert.equal(retained.units[0]!.childSessionID, "successful-child");
  assert.equal(retained.units[0]!.resultClass, "acceptance");
}));

test("preview reconciles native post-admission Task errors without treating pre-admission denial as spend", async () => fixture(async root => {
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" },
    operator: { agent: "dogs-coordinator", parentID: "root" },
  };
  const client = { config: { providers: async () => ({ data: { providers: [{ id: "openai", models: {
    "gpt-6-astra": { id: "gpt-6-astra" }, "gpt-5.6-terra": { id: "gpt-5.6-terra" },
    "gpt-5.6-sol": { id: "gpt-5.6-sol" },
  } }] } }) }, session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async () => ({ data: [] }),
  } };
  const hooks = await SortieDogsV010Plugin({ directory: root, client } as never, { modelCatalog: { global: [
    { model: "openai/gpt-6-astra", variants: ["high"] },
    { model: "openai/gpt-5.6-terra", variants: ["high"] },
    { model: "openai/gpt-5.6-sol", variants: ["low", "medium"] },
  ] } });
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-6-astra" } }, {
    message: { id: "root-user", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-astra" } },
    parts: [{ type: "text", text: "Implement the exact approved operator plan." }],
  });
  const prepared = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(plan()) }, { sessionID: "root" })) as { task: { prompt: string; subagent_type: string; description: string } };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "operator-call" }, { args: prepared.task });
  await hooks["chat.message"]!({ sessionID: "operator", messageID: "operator-user", agent: "dogs-coordinator" }, {
    message: { id: "operator-user", agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: prepared.task.prompt }],
  });
  const next = JSON.parse(await hooks.tool!.sortie_v010_operator_next.execute({}, { sessionID: "operator" })) as {
    task: { prompt: string; subagent_type: string; description: string };
  };
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "operator", callID: "denied-call" },
    { args: { ...next.task, prompt: `${next.task.prompt}\nchanged` } }), /not-authorized/);

  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "operator", callID: "worker-call" }, { args: next.task });
  const key = createHash("sha256").update("v010\u0000root").digest("hex");
  const ledgerPath = join(root, ".sortie-dogs-v010", "run-flight", `${key}.json`);
  const before = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(before.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "dispatch.reserved").length, 1);
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task",
    sessionID: "operator", callID: "worker-call", state: { status: "error",
      error: "Subagent depth limit reached (1). Increase subagent_depth to allow nested subagents." } } } } });

  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "awaiting-decision");
  assert.equal(status.units[0].status, "failed");
  assert.equal(status.units[0].child_session_id, null);
  assert.equal(status.units[0].result_class, "process-defect");
  assert.deepEqual(status.units[0].evidence, []);
  assert.equal(status.requirements.every(({ status }: { status: string }) => status === "unproven"), true);
  assert.equal(status.final_acceptance, "coordinator-required");
  const after = JSON.parse(await readFile(ledgerPath, "utf8"));
  const reservations = after.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "dispatch.reserved");
  const settlements = after.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "unit.settled");
  assert.equal(reservations.length, 1, "pre-admission denial must not reserve or spend");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].event.disposition, "failed");
  assert.equal(settlements[0].event.result_class, "process-defect");
  assert.deepEqual(settlements[0].event.evidence, []);
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
