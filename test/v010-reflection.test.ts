import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { goalFingerprint, type GoalAcceptanceCriterion, type GoalEvidence } from "../dist/core/goal-bound.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import { projectKey, ReflectionStore } from "../dist/reflection/index.js";
import { V010_REFLECTION_MANAGED_BLOCK_START } from "../dist/reflection/managed-block.js";
import { SortieDogsPlugin as CorePlugin } from "../dist/plugin/index.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import type { RuntimeBridge } from "../dist/plugin/runtime-bridge.js";

const area = resolve("_testenv");

async function fixture(run: (projectRoot: string, configRoot: string) => Promise<void>): Promise<void> {
  await mkdir(area, { recursive: true });
  const root = await mkdtemp(join(area, "v010-reflection-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const previous = {
    xdg: process.env.XDG_CONFIG_HOME,
    stable: process.env.SORTIE_DOGS_CONFIG,
    preview: process.env.SORTIE_DOGS_V010_CONFIG,
    reflection: process.env.SORTIE_REFLECTION,
    sync: process.env.SORTIE_REFLECTION_SYNC,
  };
  process.env.XDG_CONFIG_HOME = configRoot;
  delete process.env.SORTIE_DOGS_CONFIG;
  delete process.env.SORTIE_DOGS_V010_CONFIG;
  delete process.env.SORTIE_REFLECTION;
  delete process.env.SORTIE_REFLECTION_SYNC;
  await mkdir(join(projectRoot, ".opencode"), { recursive: true });
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  await writeFile(join(projectRoot, ".opencode/sortie-dogs-v010.json"), JSON.stringify({}));
  try {
    await run(projectRoot, join(configRoot, "opencode"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = key === "xdg" ? "XDG_CONFIG_HOME"
        : key === "stable" ? "SORTIE_DOGS_CONFIG"
          : key === "preview" ? "SORTIE_DOGS_V010_CONFIG"
            : key === "reflection" ? "SORTIE_REFLECTION" : "SORTIE_REFLECTION_SYNC";
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function client() {
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" },
    restarted: { agent: "dog-operator" },
    worker: { agent: "dog-worker-v010", parentID: "root" },
  };
  return { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] ?? { agent: "dogs-coordinator", parentID: "root" } }),
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [] }),
  } } as never;
}

function coreClient(logs?: unknown[]) {
  return { app: { log: (value: unknown) => { logs?.push(value); } }, session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, agent: "dog-coordinator" } }),
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [] }),
  } } as never;
}

async function activate(hooks: Awaited<ReturnType<typeof SortieDogsV010Plugin>>, sessionID: "root" | "restarted"): Promise<void> {
  await hooks["chat.message"]!({ sessionID, messageID: `${sessionID}-user`, agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "fixture", modelID: "model" } },
    parts: [{ type: "text", text: "Use the isolated reflection profile." }],
  });
}

async function activateCore(hooks: Awaited<ReturnType<typeof CorePlugin>>): Promise<void> {
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-coordinator" }, {
    message: { agent: "dog-coordinator", model: { providerID: "fixture", modelID: "model" } },
    parts: [{ type: "text", text: "Use the isolated reflection profile." }],
  });
}

async function completeAcceptedGoal(
  projectRoot: string,
  control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0],
): Promise<RunFlightLedger> {
  const key = createHash("sha256").update("v010\0root").digest("hex");
  const ledger = await RunFlightLedger.openGoal(join(projectRoot, ".git/sortie-dogs/run-flight-v010", `${key}.json`));
  const initial = (await ledger.readGoal()).state;
  assert.ok(initial.goal_id);
  const fingerprint = goalFingerprint("v010 reflection terminal acceptance");
  const criterion: GoalAcceptanceCriterion = {
    criterion_id: "reflection-terminal-sync", target: "preview reflection terminal synchronization", entrypoint: "experimental.text.complete",
    workload: "one accepted preview root", oracle_coverage: ["succeeded receipt and preview managed marker"], build_boundary: "not-applicable",
    source: "declared-source", candidate: "declared-candidate", source_binding: "declared", candidate_binding: "declared",
    validation_command: "node preview-reflection-fixture", fixture: "v010-reflection", proof_scope: "requested-full", expected_outcome: "pass",
  };
  const at = new Date().toISOString();
  await ledger.appendGoal({ kind: "goal.revised", at, goal_id: initial.goal_id!, revision: 2, scope_epoch: 2,
    acceptance_fingerprint: fingerprint, origin_user_message_id: "root-user", session_id: "root", selected_agent: "dog-coordinator",
    delivery: "mvp-first", budget: { max_units: 2, time_ms: null, cost_usd: null, source: "accepted-plan" },
    acceptance_contract: { criteria: [criterion] } });
  await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: initial.goal_id!, reservation_id: "reflection-dispatch",
    unit_id: "reflection-unit", session_id: "root", ticket_id: null });
  const evidence: GoalEvidence = {
    evidence_id: "reflection-evidence", goal_id: initial.goal_id!, goal_revision: 2, scope_epoch: 2,
    acceptance_fingerprint: fingerprint,
    measurement: { criterion_ids: [criterion.criterion_id], target: criterion.target, entrypoint: criterion.entrypoint,
      workload: criterion.workload, oracle_coverage: criterion.oracle_coverage, build_boundary: criterion.build_boundary },
    identity: { source: criterion.source, candidate: criterion.candidate, fixture: criterion.fixture },
    execution: { command: [criterion.validation_command!], exit_code: 0, outcome: "pass", started_at: at,
      ended_at: new Date(Date.parse(at) + 1).toISOString(), units: ["reflection-unit"] },
    proof_scope: "requested-full",
  };
  await ledger.appendGoal({ kind: "unit.settled", at: evidence.execution.ended_at, goal_id: initial.goal_id!,
    reservation_id: "reflection-dispatch", receipt_id: "reflection-receipt", unit_id: "reflection-unit", disposition: "succeeded",
    result_class: "acceptance", progress_fingerprint: goalFingerprint([evidence]), evidence: [evidence], elapsed_ms: 1, cost_usd: null });
  assert.equal((await control.completeRoot("root", fingerprint)).status, "succeeded");
  return ledger;
}

test("v0.10 exposes root-only reflection from an isolated restart-safe store", async () => fixture(async (projectRoot, globalRoot) => {
  const stableRoot = join(globalRoot, "sortie-dogs", "reflection");
  const stableStore = new ReflectionStore(stableRoot, projectRoot);
  await stableStore.record("project", "stable-session", { scope: "stable-only", trigger: "stable", cause: "stable",
    prevention: "Never inject this stable entry into preview.", evidence: "user-correction", evidenceRef: "stable-fixture" }, "0.10.7");
  const stableBucketPath = join(stableRoot, "projects", `${projectKey(projectRoot)}.json`);
  const stableBefore = await readFile(stableBucketPath);

  const hooks = await SortieDogsV010Plugin({ directory: projectRoot, client: client() });
  await activate(hooks, "root");
  const reflect = hooks.tool!.sortie_v010_reflection.execute;
  const first = JSON.parse(await reflect({ action: "record", layer: "project", scope: "same-scope", trigger: "first", cause: "cause",
    prevention: "Use the preview store only.", evidence: "user-correction", evidenceRef: "preview-fixture" },
  { sessionID: "root", agent: "dog-operator" }));
  const duplicate = JSON.parse(await reflect({ action: "record", layer: "project", scope: "same-scope", trigger: "second", cause: "cause",
    prevention: "Use the preview store only.", evidence: "user-correction", evidenceRef: "preview-fixture" },
  { sessionID: "root", agent: "dog-operator" }));
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.hits, 2);
  for (let index = 0; index < 4; index++) {
    await reflect({ action: "record", layer: "project", scope: `preview-${index}`, trigger: "trigger", cause: "cause",
      prevention: `Preview prevention ${index}.`, evidence: "user-correction", evidenceRef: `preview-${index}` },
    { sessionID: "root", agent: "dog-operator" });
  }
  for (const action of ["record", "list", "replace", "forget", "promote", "clear"]) {
    assert.equal(await reflect({ action, layer: "project" }, { sessionID: "worker", agent: "dog-worker-v010" }), "reflection_not_permitted");
    assert.equal(await reflect({ action, layer: "project" }, { sessionID: "root", agent: "dogs-coordinator" }), "reflection_not_permitted");
  }

  const previewSystem = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!({ sessionID: "root" }, previewSystem);
  const reflectionElement = previewSystem.system.find(item => item.includes("SORTIE_PROCESS_REFLECTIONS"))!;
  assert.ok(reflectionElement);
  assert.equal(reflectionElement.includes("stable-only"), false);
  assert.ok(reflectionElement.split("\n").filter(line => line.startsWith("- [")).length <= 3);
  assert.ok(Buffer.byteLength(reflectionElement.slice(reflectionElement.lastIndexOf("SORTIE_PROCESS_REFLECTIONS")), "utf8") <= 500);
  assert.ok(await lstat(join(globalRoot, "sortie-dogs-v010/reflection/projects", `${projectKey(projectRoot)}.json`)));
  assert.deepEqual(await readFile(stableBucketPath), stableBefore);
  process.env.SORTIE_REFLECTION = "0";
  const killedSystem = { system: [reflectionElement] };
  await hooks["experimental.chat.system.transform"]!({ sessionID: "root" }, killedSystem);
  assert.equal(killedSystem.system.some(item => item.includes("SORTIE_PROCESS_REFLECTIONS")), false);
  assert.equal(await reflect({ action: "list", layer: "project" }, { sessionID: "root", agent: "dog-operator" }), "reflection_not_permitted");
  delete process.env.SORTIE_REFLECTION;

  const restarted = await SortieDogsV010Plugin({ directory: projectRoot, client: client() });
  await activate(restarted, "restarted");
  const restartedSystem = { system: [] as string[] };
  await restarted["experimental.chat.system.transform"]!({ sessionID: "restarted" }, restartedSystem);
  assert.ok(restartedSystem.system.some(item => item.includes("same-scope") && item.includes("hits=2")));
}));

test("v0.10 reflection follows isolated global, project, environment, and host precedence", async () => fixture(async (projectRoot, globalRoot) => {
  await rm(join(projectRoot, ".opencode/sortie-dogs-v010.json"));
  await mkdir(globalRoot, { recursive: true });
  await writeFile(join(globalRoot, "sortie-dogs.json"), JSON.stringify({ reflection: { enabled: false } }));
  await writeFile(join(globalRoot, "sortie-dogs-v010.json"), JSON.stringify({ reflection: { enabled: true } }));
  assert.ok((await SortieDogsV010Plugin({ directory: projectRoot, client: client() })).tool?.sortie_v010_reflection);

  await writeFile(join(projectRoot, ".opencode/sortie-dogs-v010.json"), JSON.stringify({ reflection: { enabled: false } }));
  assert.equal((await SortieDogsV010Plugin({ directory: projectRoot, client: client() })).tool?.sortie_v010_reflection, undefined);

  process.env.SORTIE_DOGS_V010_CONFIG = JSON.stringify({ reflection: { enabled: true } });
  assert.ok((await SortieDogsV010Plugin({ directory: projectRoot, client: client() })).tool?.sortie_v010_reflection);
  assert.equal((await SortieDogsV010Plugin({ directory: projectRoot, client: client() },
    { reflection: { enabled: false } })).tool?.sortie_v010_reflection, undefined);
}));

test("v0.10 global and run layers remain isolated from stable storage", async () => fixture(async (projectRoot, globalRoot) => {
  const stableRoot = join(globalRoot, "sortie-dogs/reflection");
  const stableStore = new ReflectionStore(stableRoot, projectRoot);
  await stableStore.record("global", undefined, { scope: "stable-global", trigger: "stable", cause: "stable",
    prevention: "Stable global only.", evidence: "user-correction", evidenceRef: "stable-global" }, "0.10.7");
  await stableStore.record("run", "root", { scope: "stable-run", trigger: "stable", cause: "stable",
    prevention: "Stable run only.", evidence: "user-correction", evidenceRef: "stable-run" }, "0.10.7");
  const stableGlobal = await readFile(join(stableRoot, "global.json"));
  const stableRun = await readFile(join(stableRoot, "runs/root.json"));

  const hooks = await SortieDogsV010Plugin({ directory: projectRoot, client: client() });
  await activate(hooks, "root");
  const reflect = hooks.tool!.sortie_v010_reflection.execute;
  await reflect({ action: "record", layer: "global", scope: "preview-global", trigger: "preview", cause: "preview",
    prevention: "Preview global only.", evidence: "user-correction", evidenceRef: "preview-global" },
  { sessionID: "root", agent: "dog-operator" });
  await reflect({ action: "record", layer: "run", scope: "preview-run", trigger: "preview", cause: "preview",
    prevention: "Preview run only.", evidence: "user-correction", evidenceRef: "preview-run" },
  { sessionID: "root", agent: "dog-operator" });
  const global = JSON.parse(await reflect({ action: "list", layer: "global" }, { sessionID: "root", agent: "dog-operator" }));
  const run = JSON.parse(await reflect({ action: "list", layer: "run" }, { sessionID: "root", agent: "dog-operator" }));
  assert.deepEqual(global.entries.map((item: { scope: string }) => item.scope), ["preview-global"]);
  assert.deepEqual(run.entries.map((item: { scope: string }) => item.scope), ["preview-run"]);
  assert.deepEqual(await readFile(join(stableRoot, "global.json")), stableGlobal);
  assert.deepEqual(await readFile(join(stableRoot, "runs/root.json")), stableRun);
  assert.ok(await lstat(join(globalRoot, "sortie-dogs-v010/reflection/global.json")));
  assert.ok(await lstat(join(globalRoot, "sortie-dogs-v010/reflection/runs/root.json")));
}));

test("v0.10 public injection preserves hits, time, and id ordering", async () => fixture(async (projectRoot, globalRoot) => {
  let now = Date.now();
  const store = new ReflectionStore(join(globalRoot, "sortie-dogs-v010/reflection"), projectRoot, { now: () => now });
  const record = async (scope: string) => store.record("project", "root", { scope, trigger: scope, cause: scope,
    prevention: `Prevent ${scope}.`, evidence: "user-correction", evidenceRef: scope }, "0.10.7");
  await record("most-hits"); now++; await record("most-hits"); now++; await record("most-hits");
  await record("older"); now++; await record("older");
  now++; await record("newer"); now++; await record("newer");
  const expectedByHitsAndTime = [...(await store.list("project", "root", "0.10.7")).entries]
    .sort((a, b) => b.hits - a.hits || a.lastSeen.localeCompare(b.lastSeen) || a.id.localeCompare(b.id));

  const hooks = await SortieDogsV010Plugin({ directory: projectRoot, client: client() }, { reflection: { enabled: true } });
  await activate(hooks, "root");
  const injectedIDs = async () => {
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "root" }, system);
    const element = system.system.find(item => item.includes("SORTIE_PROCESS_REFLECTIONS"))!;
    return element.split("\n").flatMap(line => /^- \[([^\]]+)\]/u.exec(line)?.[1] ?? []);
  };
  assert.deepEqual(await injectedIDs(), expectedByHitsAndTime.map(item => item.id));

  await store.clear("project", "root", "CLEAR_REFLECTIONS", "0.10.7");
  now++; await record("tie-a"); await record("tie-b");
  now++; await record("tie-a"); await record("tie-b"); await record("low");
  const expectedByID = [...(await store.list("project", "root", "0.10.7")).entries]
    .sort((a, b) => b.hits - a.hits || a.lastSeen.localeCompare(b.lastSeen) || a.id.localeCompare(b.id));
  assert.deepEqual(await injectedIDs(), expectedByID.map(item => item.id));
}));

test("v0.10 terminal sync does not run for a stopped receipt", async () => fixture(async (projectRoot) => {
  const hooks = await CorePlugin({ directory: projectRoot, client: coreClient(), runtimeBridge: {
    profile: V010_RUNTIME_PROFILE, assetVersion: V010_RUNTIME_ASSET_VERSION,
  } });
  await activateCore(hooks);
  await hooks.tool!.sortie_reflection.execute({ action: "record", layer: "project", scope: "terminal-sync", trigger: "trigger",
    cause: "cause", prevention: "Keep preview terminal synchronization isolated.", evidence: "user-correction", evidenceRef: "terminal-fixture" },
  { sessionID: "root", agent: "dog-coordinator" });

  await hooks["experimental.text.complete"]!({ sessionID: "root" }, {
    text: "⚠️ **INTERRUPTED** `stopped` — explicit stop\nTRUE_INTERRUPTION: user: fixture stop",
  });
  const key = createHash("sha256").update("v010\0root").digest("hex");
  const ledger = await RunFlightLedger.openGoal(join(projectRoot, ".git/sortie-dogs/run-flight-v010", `${key}.json`));
  assert.equal((await ledger.readGoal()).state.receipt?.status, "stopped");
  await hooks["experimental.text.complete"]!({ sessionID: "root" }, { text: "✅ **DONE** `stopped` — stale success claim" });
  await assert.rejects(readFile(join(projectRoot, "AGENTS.md")), { code: "ENOENT" });
}));

test("v0.10 succeeded terminal receipt uses preview-owned maintenance", async () => fixture(async (projectRoot) => {
  let control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0] | undefined;
  const hooks = await CorePlugin({ directory: projectRoot, client: coreClient(), runtimeBridge: {
    profile: V010_RUNTIME_PROFILE, assetVersion: V010_RUNTIME_ASSET_VERSION, connected: value => { control = value; },
  } });
  await activateCore(hooks);
  await hooks.tool!.sortie_reflection.execute({ action: "record", layer: "project", scope: "terminal-sync", trigger: "trigger",
    cause: "cause", prevention: "Keep preview terminal synchronization isolated.", evidence: "user-correction", evidenceRef: "terminal-fixture" },
  { sessionID: "root", agent: "dog-coordinator" });

  const ledger = await completeAcceptedGoal(projectRoot, control!);
  await hooks["experimental.text.complete"]!({ sessionID: "root" }, { text: "✅ **DONE** `proved` — accepted" });
  assert.equal((await ledger.readGoal()).state.receipt?.status, "succeeded");
  assert.equal(JSON.parse(await hooks.tool!.sortie_reflection.execute({ action: "list", layer: "project" },
    { sessionID: "root", agent: "dog-coordinator" })).entries.length, 1);
  const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(V010_REFLECTION_MANAGED_BLOCK_START));
  assert.equal(agents.includes("<!-- sortie-dogs:reflection-managed:start -->"), false);
  const manifest = JSON.parse(await readFile(join(projectRoot, ".sortie-dogs-v010/reflection-maintenance/operation-manifest.json"), "utf8"));
  assert.deepEqual(manifest.write, ["AGENTS.md", ".sortie-dogs-v010/reflection-maintenance"]);
}));

test("v0.10 terminal sync keeps I/O conflicts non-blocking", async () => fixture(async (projectRoot) => {
  let control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0] | undefined;
  const logs: unknown[] = [];
  const hooks = await CorePlugin({ directory: projectRoot, client: coreClient(logs), runtimeBridge: {
    profile: V010_RUNTIME_PROFILE, assetVersion: V010_RUNTIME_ASSET_VERSION, connected: value => { control = value; },
  } });
  await activateCore(hooks);
  await hooks.tool!.sortie_reflection.execute({ action: "record", layer: "project", scope: "terminal-io", trigger: "trigger",
    cause: "cause", prevention: "Keep terminal I/O conflicts non-blocking.", evidence: "user-correction", evidenceRef: "terminal-io" },
  { sessionID: "root", agent: "dog-coordinator" });
  const ledger = await completeAcceptedGoal(projectRoot, control!);
  const outside = join(projectRoot, "..", "outside-control");
  await mkdir(outside);
  await symlink(outside, join(projectRoot, ".sortie-dogs-v010"), process.platform === "win32" ? "junction" : "dir");

  await hooks["experimental.text.complete"]!({ sessionID: "root" }, { text: "✅ **DONE** `io-conflict` — accepted" });
  assert.equal((await ledger.readGoal()).state.receipt?.status, "succeeded");
  await assert.rejects(readFile(join(projectRoot, "AGENTS.md")), { code: "ENOENT" });
  assert.deepEqual(await readdir(outside), []);
  assert.ok(logs.some((value) => {
    const item = value as { message?: unknown; body?: { message?: unknown } };
    return item.message === "reflection_sync_maintenance-io-conflict" || item.body?.message === "reflection_sync_maintenance-io-conflict";
  }));
}));
