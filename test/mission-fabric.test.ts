import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { MissionFabricValidationRequired, missionFabricScopeConflict, missionFabricTree } from "../dist/core/mission-fabric.js";
import { WorktreeLifecycle } from "../dist/core/worktree-lifecycle.js";
import { ensureGitManagedStateExcluded } from "../dist/core/git-managed-state.js";

const exec = promisify(execFile);
async function fixture(action: (root: string, runtime: OperatorRuntime) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-fabric-"));
  const git = (args: string[]) => exec("git", args, { cwd: root });
  try {
    await git(["init", "-q"]);
    await ensureGitManagedStateExcluded(root, V010_RUNTIME_PROFILE);
    await mkdir(join(root, "src")); await mkdir(join(root, "test"));
    for (const name of ["a", "b"]) {
      await writeFile(join(root, `src/${name}.mjs`), "export default 0;\n");
      await writeFile(join(root, `test/${name}.mjs`), `import value from '../src/${name}.mjs'; if(value !== 1)process.exit(1);\n`);
    }
    await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
    const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "request", text: "Independently fix a and b; verify both" });
    const mission = await missions.start("root", ["a and b return 1"]);
    const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
    await runtime.prepareMission("root", missionPlan(mission, ["a", "b"].map(name => ({ title: name, objective: `Fix ${name}`,
      read: [`src/${name}.mjs`, `test/${name}.mjs`], write: [`src/${name}.mjs`], validation: [`node test/${name}.mjs`] }))),
      { sessionID: "coordinator", callID: "coordinator-call" });
    await action(root, runtime);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const noPrefix of [false, true]) test(`Fabric cold claims, integration and cleanup with diff.noprefix=${noPrefix}`, async () => fixture(async (root, runtime) => {
  await exec("git", ["config", "diff.noprefix", String(noPrefix)], { cwd: root });
  const before = await missionFabricTree(root);
  let state = await runtime.prepareFabric("root");
  assert.ok(state.fabric, state.fabricFallback); assert.equal(state.fabricFallback, undefined);
  const { tasks } = await runtime.next("root", "coordinator") as any;
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task: any) => task.model === "openai/gpt-6-luna-fast#max"));
  await Promise.all(tasks.map((task: any, i: number) => runtime.admitWorker("root", "coordinator", `call-${i}`, task)));
  runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  // Reverse claim order reproduces the former first-running-unit assumption.
  for (const i of [1, 0]) await runtime.claimAdmittedWorkerPrompt("root", "coordinator", `worker-${i}`, tasks[i].prompt);
  await assert.rejects(runtime.claimAdmittedWorkerPrompt("root", "coordinator", "duplicate", tasks[0].prompt), /child-mismatch/);
  state = await runtime.required("root");
  for (const [i, name] of ["a", "b"].entries()) {
    await writeFile(join(state.units[i]!.fabricRoot!, `src/${name}.mjs`), "export default 1;\n");
    await runtime.settled({ rootSessionID: "root", callID: `call-${i}`, childSessionID: `worker-${i}`,
      disposition: "succeeded", resultClass: "success", evidence: [{ measurement: { criterion_ids: [] } }] } as any);
  }
  assert.equal(await missionFabricTree(root), before, "workers never modify the parent");
  let checks = 0;
  const validate = async ({ directory, command }: any) => {
    checks++;
    await exec(process.execPath, [command.split(" ")[1]], { cwd: directory });
    return { ok: true as const, command: [command], exit_code: 0 as const, fingerprint: "f".repeat(64), error: null };
  };
  await runtime.integrateFabric("root", validate);
  runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  await runtime.integrateFabric("root", validate);
  assert.equal(checks, 2, "restart reuses unchanged combined checks");
  assert.equal((await readFile(join(root, "src/a.mjs"), "utf8")).trim(), "export default 1;");
  await runtime.assertFabricDelivered(await runtime.required("root"));
  await runtime.terminal("root", { status: "succeeded" } as any);
  const completed = await runtime.required("root");
  assert.equal(completed.fabric!.cleanup!.completed.length, 3, JSON.stringify(completed.fabric!.cleanup));
  assert.deepEqual(completed.fabric!.cleanup!.retained, []);
  assert.ok(await readFile(completed.fabric!.patchPath!, "utf8"), "combined patch retained after generated tree cleanup");
  await writeFile(join(root, "src/a.mjs"), "export default 2;\n");
  await assert.rejects(runtime.assertFabricDelivered(await runtime.required("root")), /delivery-changed/);
}));

test("both failed Workers can be explicitly retried in order across restart", async () => fixture(async (root, runtime) => {
  const initial = await runtime.prepareFabric("root"), before = await missionFabricTree(root);
  const { tasks } = await runtime.next("root", "coordinator") as any;
  for (const i of [0, 1]) {
    await runtime.admitWorker("root", "coordinator", `call-${i}`, tasks[i]);
    await runtime.claimAdmittedWorkerPrompt("root", "coordinator", `worker-${i}`, tasks[i].prompt);
  }
  for (const i of [0, 1]) await runtime.settled({ rootSessionID: "root", callID: `call-${i}`, childSessionID: `worker-${i}`,
    disposition: "failed", resultClass: "acceptance", evidence: [],
    failure: { outcome: "fail", command: initial.units[i]!.unit.validation[0], exitCode: 1 } } as any);
  for (const [i, name] of ["a", "b"].entries()) {
    await runtime.prepareMissionNormalRemediation("root", initial.runID, initial.units[i]!.unit.id);
    runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
    const { tasks: retries } = await runtime.next("root", "coordinator") as any;
    assert.equal(retries.length, 1);
    await runtime.admitWorker("root", "coordinator", `retry-${i}`, retries[0]);
    await runtime.claimAdmittedWorkerPrompt("root", "coordinator", `retry-worker-${i}`, retries[0].prompt);
    await writeFile(join(initial.units[i]!.fabricRoot!, `src/${name}.mjs`), "export default 1;\n");
    await runtime.settled({ rootSessionID: "root", callID: `retry-${i}`, childSessionID: `retry-worker-${i}`,
      disposition: "succeeded", resultClass: "acceptance", evidence: [{ measurement: { criterion_ids: [] } }] } as any);
    if (i === 0) assert.equal((await runtime.required("root")).phase, "awaiting-decision");
  }
  assert.equal((await runtime.required("root")).dispatched, 4, "prior dispatches remain counted");
  assert.equal(await missionFabricTree(root), before);
  await runtime.integrateFabric("root", async ({ directory, command }) => {
    await exec(process.execPath, [command.split(" ")[1]!], { cwd: directory });
    return { ok: true, command: [command], exit_code: 0, fingerprint: "f".repeat(64), error: null };
  });
  assert.equal((await runtime.required("root")).fabric!.phase, "applied");
}));

test("preparing another Mission preserves the first Mission's dirty worktree ownership", async () => fixture(async (root, runtime) => {
  const first = await runtime.prepareFabric("root");
  await writeFile(join(first.units[0]!.fabricRoot!, "src/a.mjs"), "export default 1;\n");
  const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
  await missions.capture("other", { id: "other-request", text: "Independently fix a and b" });
  const mission = await missions.start("other", ["a and b return 1"]);
  await runtime.prepareMission("other", missionPlan(mission, ["a", "b"].map(name => ({ title: name, objective: `Fix ${name}`,
    read: [`src/${name}.mjs`, `test/${name}.mjs`], write: [`src/${name}.mjs`], validation: [`node test/${name}.mjs`] }))),
    { sessionID: "other-coordinator", callID: "other-call" });
  const second = await runtime.prepareFabric("other");
  assert.ok(second.fabric, second.fabricFallback);
  const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: root });
  assert.deepEqual((await lifecycle.reconcile()).map(tree => tree.phase), ["ready", "ready", "ready", "ready"]);
  const tree = first.fabric!.trees[0]!;
  await lifecycle.discardOwnedChanges(first.fabric!.tasks[0]!.worktree, tree.path, tree.baseSha, tree.branch, ["src/a.mjs"]);
  await lifecycle.cleanup(first.fabric!.tasks[0]!.worktree);
  assert.equal((await lifecycle.reconcile()).length, 3);
}));

test("native check admission binds actor, cwd and candidate and rejects changed results", async () => fixture(async (root, runtime) => {
  const initial = await runtime.prepareFabric("root"), before = await missionFabricTree(root);
  const { tasks } = await runtime.next("root", "coordinator") as any;
  for (const [i, name] of ["a", "b"].entries()) {
    await runtime.admitWorker("root", "coordinator", `call-${i}`, tasks[i]);
    await runtime.claimAdmittedWorkerPrompt("root", "coordinator", `worker-${i}`, tasks[i].prompt);
    await writeFile(join(initial.units[i]!.fabricRoot!, `src/${name}.mjs`), "export default 1;\n");
    await runtime.settled({ rootSessionID: "root", callID: `call-${i}`, childSessionID: `worker-${i}`,
      disposition: "succeeded", resultClass: "acceptance", evidence: [{ measurement: { criterion_ids: [] } }] } as any);
  }
  await assert.rejects(runtime.integrateFabric("root", async request => { throw new MissionFabricValidationRequired(request); }), MissionFabricValidationRequired);
  const request = (await runtime.required("root")).fabric!.pendingValidation!;
  let reserved = 0;
  const reserve = async () => { reserved++; };
  assert.equal(await runtime.admitFabricValidation("root", "unrelated", "check", request.command, request.directory, reserve), false);
  assert.equal(await runtime.admitFabricValidation("root", "coordinator", "check", request.command, root, reserve), false);
  assert.equal(reserved, 0);
  assert.equal(await runtime.admitFabricValidation("root", "coordinator", "check", request.command, request.directory, reserve), true);
  await assert.rejects(runtime.admitFabricValidation("root", "coordinator", "duplicate", request.command, request.directory, reserve), /not-ready/);
  await writeFile(join(request.directory, "src/a.mjs"), "export default 2;\n");
  runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  assert.equal(await runtime.settleFabricValidation("root", "coordinator", "check", async (_request, _started, fresh) => {
    assert.equal(fresh, false);
  }), true);
  assert.equal(await missionFabricTree(root), before);
}));

test("failed sibling does not revoke the other admitted writer or permit premature integration", async () => fixture(async (_root, runtime) => {
  await runtime.prepareFabric("root");
  const { tasks } = await runtime.next("root", "coordinator") as any;
  for (const i of [0, 1]) await runtime.admitWorker("root", "coordinator", `call-${i}`, tasks[i]);
  await runtime.settled({ rootSessionID: "root", callID: "call-0", disposition: "failed", resultClass: "acceptance", evidence: [] } as any);
  assert.equal((await runtime.required("root")).phase, "running");
  await runtime.claimAdmittedWorkerPrompt("root", "coordinator", "worker-1", tasks[1].prompt);
  await assert.rejects(runtime.integrateFabric("root", async () => { throw Error("must not validate"); }), /awaits-settlement/);
  await runtime.settled({ rootSessionID: "root", callID: "call-1", childSessionID: "worker-1", disposition: "succeeded", resultClass: "success", evidence: [] } as any);
  assert.equal((await runtime.required("root")).phase, "awaiting-decision");
}));

test("dirty base and explicit incompatible model use serial before any dispatch", async () => {
  for (const reason of ["dirty", "model"]) await fixture(async (root, runtime) => {
    if (reason === "dirty") await writeFile(join(root, "src/a.mjs"), "export default 9;\n");
    const state = await runtime.prepareFabric("root", reason === "model" ? "example/explicit-model#high" : undefined);
    assert.equal(state.fabric, undefined); assert.ok(state.fabricFallback);
    assert.equal(state.dispatched, 0);
    assert.ok((await runtime.next("root", "coordinator") as any).task);
  });
});

test("Fabric independence includes cross-unit reads and ambiguous scope", () => {
  assert.equal(missionFabricScopeConflict([{ read: ["src/a"], write: ["src/a"] }, { read: ["src/a"], write: ["src/b"] }]), true);
  assert.equal(missionFabricScopeConflict([{ read: ["."], write: ["src/a"] }, { read: ["src/b"], write: ["src/b"] }]), true);
  assert.equal(missionFabricScopeConflict([{ read: ["src/a", "test/a"], write: ["src/a"] }, { read: ["src/b", "test/b"], write: ["src/b"] }]), false);
});

test("cancellation revokes both exact Tasks and retains partial candidates across reload", async () => fixture(async (root, runtime) => {
  const state = await runtime.prepareFabric("root"), before = await missionFabricTree(root);
  const { tasks } = await runtime.next("root", "coordinator") as any;
  for (const i of [0, 1]) {
    await runtime.admitWorker("root", "coordinator", `call-${i}`, tasks[i]);
    await runtime.claimAdmittedWorkerPrompt("root", "coordinator", `worker-${i}`, tasks[i].prompt);
  }
  const path = join(state.units[0]!.fabricRoot!, "src/a.mjs");
  await writeFile(path, "export default 7;\n");
  assert.deepEqual(new Set(await runtime.interrupted("root", "explicit-cancellation")), new Set(["coordinator", "worker-0", "worker-1"]));
  runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const cancelled = await runtime.required("root");
  assert.equal(cancelled.phase, "cancelled"); assert.equal(cancelled.dispatched, 2);
  assert.ok(cancelled.units.every(unit => unit.status === "cancelled"));
  assert.match(await readFile(path, "utf8"), /7/);
  assert.equal(await missionFabricTree(root), before);
  await assert.rejects(runtime.claimAdmittedWorkerPrompt("root", "coordinator", "worker-0", tasks[0].prompt), /revoked/);
}));

test("cancelling combined validation aborts promptly and never applies the candidate", async () => fixture(async (root, runtime) => {
  const state = await runtime.prepareFabric("root"), before = await missionFabricTree(root);
  const { tasks } = await runtime.next("root", "coordinator") as any;
  for (const [i, name] of ["a", "b"].entries()) {
    await runtime.admitWorker("root", "coordinator", `call-${i}`, tasks[i]);
    await runtime.claimAdmittedWorkerPrompt("root", "coordinator", `worker-${i}`, tasks[i].prompt);
    await writeFile(join(state.units[i]!.fabricRoot!, `src/${name}.mjs`), "export default 1;\n");
    await runtime.settled({ rootSessionID: "root", callID: `call-${i}`, childSessionID: `worker-${i}`,
      disposition: "succeeded", resultClass: "acceptance", evidence: [{ measurement: { criterion_ids: [] } }] } as any);
  }
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = runtime.integrateFabric("root", async (_request, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    throw Error("unreachable");
  });
  const rejected = assert.rejects(pending, /explicit-cancellation/);
  await ready;
  await runtime.interrupted("root", "explicit-cancellation");
  await rejected;
  assert.equal((await runtime.required("root")).phase, "cancelled");
  assert.equal(await missionFabricTree(root), before);
}));
