import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CancellableChildLifecycle } from "../dist/core/child-lifecycle-runtime.js";
import { EvidenceCapsuleStore } from "../dist/core/evidence-capsule.js";
import { RunFlightLedger, RunFlightLedgerError } from "../dist/core/run-flight-ledger.js";
import { terminateTree } from "../dist/core/worktree-commit-artifact.js";
import { ParallelDispatchCoordinator } from "../dist/core/worktree-parallel-dispatch.js";
import { ScopeLeaseRegistry } from "../dist/core/scope-lease-registry.js";
import { SortieDogsPlugin } from "../dist/plugin/index.js";
import type { ChildTerminalEvidence, ChildTerminalIdentity } from "../dist/core/child-terminal-reconciliation.js";
import { acceptAndComplete, commit, fabricContract, fabricUnit, fixture, run } from "./helpers/worktree-dispatch-fixture.ts";

const roots: string[] = [];
const allReleased = (): ChildTerminalEvidence => ({ terminal: "satisfied", tools_quiescent: "satisfied",
  artifact_window_closed: "satisfied", gate_released: "satisfied", lease_released: "satisfied",
  writer_released: "satisfied", worktree_released: "satisfied" });
const identity: ChildTerminalIdentity = { run_id: "run", unit_id: "unit", attempt_id: "attempt", predecessor_attempt_id: null,
  candidate_id: "base", route_id: "route", child_id: "child", call_id: "call" };
async function standalone() {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "child-runtime-"));
  roots.push(root);
  const file = join(root, "ledger.json");
  const access = { store: new EvidenceCapsuleStore(join(root, "capsules")), declared_capsule_ids: [], authorized_source_paths: [] };
  return { file, access, ledger: await RunFlightLedger.open(file, access) };
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function processTree() {
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.on('SIGTERM',()=>{if(child.exitCode!==null||child.signalCode!==null)process.exit(0);else child.once('exit',()=>process.exit(0));});
    console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", source], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const pids = await new Promise<number[]>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("process fixture did not start")), 10000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim()) as number[]); }
    });
  });
  return { child, closed, pids, stop: async () => { if (alive(child.pid!)) await terminateTree(child, closed); } };
}
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

test("artifact windows defer stopping; restart and concurrent replay preserve one stop and terminal event", async () => {
  const { file, access, ledger } = await standalone();
  let windowOpen = true;
  let stopped = false;
  let released = false;
  let stopCount = 0;
  const descriptor = { identity, deadline_ms: Date.now() - 1 };
  const runtime = {
    observe: async () => ({ observation: { identity, disposition: "cancelled" as const }, evidence: {
      ...allReleased(), terminal: stopped ? "satisfied" as const : "unsatisfied" as const,
      tools_quiescent: stopped ? "satisfied" as const : "unsatisfied" as const,
      artifact_window_closed: windowOpen ? "unsatisfied" as const : "satisfied" as const,
      worktree_released: released ? "satisfied" as const : "unsatisfied" as const,
    } }),
    stop: async () => { stopCount += 1; stopped = true; }, release: async () => { released = true; }, terminal: async () => {},
  };
  const lifecycle = await CancellableChildLifecycle.open(descriptor, ledger, runtime);
  assert.equal((await lifecycle.check()).status, "waiting");
  assert.equal(stopCount, 0);
  assert.equal((await ledger.read()).records.length, 1);
  windowOpen = false;
  const results = await Promise.all([lifecycle.check(), lifecycle.check(true)]);
  assert.ok(results.every(({ status }) => status === "terminal"));
  assert.equal(stopCount, 1);
  assert.deepEqual((await ledger.read()).records.map(({ event }) => event.kind), ["child.registered", "child.stop-requested", "child.terminal"]);
  const bytes = await readFile(file, "utf8");
  const reopened = await CancellableChildLifecycle.open(descriptor, await RunFlightLedger.open(file, access), runtime);
  assert.equal((await reopened.check(true)).status, "terminal");
  assert.equal(await readFile(file, "utf8"), bytes);
  await assert.rejects(ledger.append({ kind: "child.terminal", at: new Date().toISOString(), identity,
    disposition: "cancelled", evidence: { ...allReleased(), raw_log: "not permitted" } } as never),
    (error: unknown) => error instanceof RunFlightLedgerError && error.code === "invalid");
  assert.equal(await readFile(file, "utf8"), bytes);
  await assert.rejects(CancellableChildLifecycle.open({ ...descriptor, deadline_ms: descriptor.deadline_ms + 1 }, ledger, runtime), /descriptor-drift/);
  await assert.rejects(ledger.append({ kind: "child.terminal", at: new Date().toISOString(),
    identity: { ...identity, child_id: "late-child" }, disposition: "cancelled", evidence: allReleased() }),
    (error: unknown) => error instanceof RunFlightLedgerError && error.code === "transition");
});

test("unconfirmed release cannot publish terminal; a retry resumes durable stop intent", async () => {
  const { ledger } = await standalone();
  let stopped = false;
  let canRelease = false;
  let released = false;
  const runtime = {
    observe: async () => ({ observation: { identity, disposition: "cancelled" as const }, evidence: {
      ...allReleased(), terminal: stopped ? "satisfied" as const : "unsatisfied" as const,
      worktree_released: released ? "satisfied" as const : "unsatisfied" as const,
    } }),
    stop: async () => { stopped = true; },
    release: async () => { if (!canRelease) throw new Error("fixture release failure"); released = true; },
    terminal: async () => {},
  };
  const lifecycle = await CancellableChildLifecycle.open({ identity, deadline_ms: Date.now() - 1 }, ledger, runtime);
  assert.equal((await lifecycle.check()).status, "waiting");
  assert.equal((await ledger.read()).state.children[0].terminal, null);
  canRelease = true;
  assert.equal((await lifecycle.check()).status, "terminal");
  assert.equal((await ledger.read()).records.filter(({ event }) => event.kind === "child.stop-requested").length, 1);
});

test("local lease disposal is not mistaken for durable release", async () => {
  const { file } = await standalone();
  const registry = new ScopeLeaseRegistry(`${file}-leases`, { ttlMs: 2000 });
  const lease = await registry.acquire({ scope: { read: [], write: ["owned.txt"] }, ownerId: "child" });
  lease.close();
  assert.equal(await lease.isReleased(), false);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(await lease.isReleased(), true);
});

test("a slow host returns bounded pending evidence without overlapping stop operations", async () => {
  const { ledger } = await standalone();
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let stopped = false;
  let calls = 0;
  const lifecycle = await CancellableChildLifecycle.open({ identity, deadline_ms: Date.now() - 1 }, ledger, {
    observe: async () => ({ observation: { identity, disposition: "cancelled" },
      evidence: { ...allReleased(), terminal: stopped ? "satisfied" : "unsatisfied" } }),
    stop: async () => { calls += 1; await blocked; stopped = true; },
    release: async () => {}, terminal: async () => {},
  });
  try {
    assert.deepEqual(await lifecycle.check(), { status: "waiting", reason: "runtime-pending" });
    const retry = lifecycle.check(true);
    unblock();
    assert.equal((await retry).status, "terminal");
    assert.equal(calls, 1);
    assert.equal((await ledger.read()).records.filter(({ event }) => event.kind === "child.stop-requested").length, 1);
  } finally { unblock(); lifecycle.dispose(); }
});

test("identity changes between observation and stop are rejected before effects", async () => {
  const { ledger } = await standalone();
  let reads = 0;
  let effects = 0;
  const lifecycle = await CancellableChildLifecycle.open({ identity, deadline_ms: Date.now() - 1 }, ledger, {
    observe: async () => ({ observation: { identity: ++reads === 1 ? identity : { ...identity, child_id: "other" },
      disposition: "cancelled" }, evidence: { ...allReleased(), terminal: "unsatisfied" } }),
    stop: async () => { effects += 1; }, release: async () => { effects += 1; }, terminal: async () => { effects += 1; },
  });
  assert.equal((await lifecycle.check()).status, "waiting");
  assert.equal(effects, 0);
  assert.equal((await ledger.read()).state.children[0].terminal, null);
});

test("cancelling one child preserves accepted sibling artifacts and both accepted snapshots", async () => {
  const value = await fixture("siblings"); roots.push(value.root);
  const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
  const prepared = await coordinator.prepareFabric(fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root");
  assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") return;
  const [a, b] = prepared.snapshot.ready;
  await coordinator.bindDispatch("root", "call-a", a);
  await coordinator.bindDispatch("root", "call-b", b);
  const sibling = await acceptAndComplete(coordinator, b, "call-b", "child-b");
  const ledger = await coordinator.childLedger("root", a, "call-a", "child-a");
  const current = { run_id: a.run_id, unit_id: a.task_id, attempt_id: a.dispatch_id, predecessor_attempt_id: null,
    candidate_id: a.base_sha, route_id: a.parallel_group, child_id: "child-a", call_id: "call-a" };
  let stopped = false;
  const lifecycle = await CancellableChildLifecycle.open({ identity: current, deadline_ms: Date.now() - 1 }, ledger, {
    observe: async () => ({ observation: { identity: current, disposition: "cancelled" }, evidence: { ...allReleased(),
      terminal: stopped ? "satisfied" : "unsatisfied", worktree_released: await coordinator.childWorktreeReleased(a) ? "satisfied" : "unsatisfied" } }),
    stop: async () => { stopped = true; },
    release: async () => { await coordinator.releaseChildWorktree("root", a, "call-a", "child-a", allReleased()); },
    terminal: async () => { await coordinator.completeCall("root", "call-a", "child-a", "cancelled"); },
  });
  let completion = await lifecycle.check();
  const finishBy = Date.now() + 60000;
  while (completion.status === "waiting" && completion.reason === "runtime-pending" && Date.now() < finishBy) {
    completion = await lifecycle.check();
  }
  assert.equal(completion.status, "terminal");
  const after = await coordinator.snapshot("root", a.run_id);
  assert.deepEqual(after!.tasks.find(({ descriptor }) => descriptor.dispatch_id === b.dispatch_id)!.artifact, sibling.artifact);
  assert.equal(after!.fabric!.candidate_head, prepared.snapshot.fabric!.candidate_head);
  assert.equal((await run(value.repository, "rev-parse", "main")).trim(), value.sha);
  await assert.rejects(coordinator.demoteFailedFabricUnit("root", a.run_id, a.task_id), { code: "wave-not-ready" });
  await coordinator.releaseChildWorktree("root", b, "call-b", "child-b", allReleased());
  assert.equal((await run(value.repository, "cat-file", "-t", sibling.artifact.commit_sha)).trim(), "commit");
  assert.ok((await run(value.repository, "for-each-ref", "--format=%(objectname)", "refs/sortie-dogs/luna-fabric-sources")).includes(sibling.artifact.commit_sha));
  const reopened = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
  assert.deepEqual((await reopened.snapshot("root", a.run_id))!.tasks.find(({ descriptor }) => descriptor.dispatch_id === b.dispatch_id)!.artifact, sibling.artifact);
});

test("plugin deadline stops a real process tree and reconciles worktree, gate, lease, and one durable terminal", async () => {
  const value = await fixture("child"); roots.push(value.root);
  await writeFile(join(value.repository, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
  await run(value.repository, "add", ".gitignore"); await commit(value.repository, "-qm", "fixture controls");
  const base = (await run(value.repository, "rev-parse", "HEAD")).trim();
  await mkdir(join(value.repository, ".opencode"));
  const contractPath = join(value.repository, ".opencode", "sortie-dogs-luna-fabric.json");
  await writeFile(contractPath, JSON.stringify(fabricContract(base, [fabricUnit("a", 0), fabricUnit("b", 1)])));
  const tree = await processTree();
  const oldTimeout = process.env.SORTIE_CHILD_DEADLINE_MS;
  process.env.SORTIE_CHILD_DEADLINE_MS = "5000";
  let hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>;
  let aborts = 0;
  const client = { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: path.id === "root"
      ? { id: "root", agent: "dog-coordinator" } : { id: path.id, agent: "dog-luna-worker", parentID: "root" } }),
    abort: async ({ path }: { path: { id: string } }) => {
      assert.equal(path.id, "child"); aborts += 1;
      await tree.stop(); assert.ok(tree.pids.every((pid) => !alive(pid)));
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "child" } } });
      return { data: true };
    },
  } } as never;
  try {
    hooks = await SortieDogsPlugin({ directory: value.repository, client });
    await hooks["chat.message"]!({ sessionID: "root", agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "fixture" }] });
    const prepared = JSON.parse(await hooks.tool!.sortie_prepare_luna_fabric.execute({ contract_path: contractPath }, { sessionID: "root", agent: "dog-coordinator" }));
    assert.equal(prepared.status, "prepared");
    const descriptor = prepared.ready[0];
    const args = { subagent_type: "dog-luna-worker", prompt: ["context_digest:", `  task_id: ${descriptor.task_id}`,
      `  run_id: ${descriptor.run_id}`, "  role: implementation", "  source_manifest: [base.txt]",
      "  acceptance:", ...descriptor.acceptance.map((text: string) => `    - ${text}`), "  validation: no canonical validation"].join("\n") };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "call" }, { args });
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root" } } } });
    await hooks["chat.message"]!({ sessionID: "child", agent: "dog-luna-worker", parentID: "root" } as never,
      { message: { agent: "dog-luna-worker", model: {} }, parts: [{ type: "text", text: args.prompt }] });
    const readArgs = { filePath: descriptor.handoff_path };
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "read" }, { args: readArgs });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "child", callID: "read", args: readArgs }, { output: "read" });
    const bound = JSON.parse(await hooks.tool!.sortie_bind_write_gate.execute({ project_root: descriptor.managed_path,
      manifest_path: descriptor.operation_manifest }, { sessionID: "child" }));
    assert.equal(bound.status, "bound");
    const coordinator = await ParallelDispatchCoordinator.open({ repositoryRoot: value.repository });
    const before = await coordinator.snapshot("root", prepared.run_id);
    const boundDescriptor = before!.tasks.find((task) => task.descriptor.dispatch_id === descriptor.dispatch_id)!.descriptor;
    const ledger = await coordinator.childLedger("root", boundDescriptor, "call", "child");
    const expires = Date.now() + 60000;
    while ((await ledger.read()).state.children[0].terminal === null && Date.now() < expires) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const history = await ledger.read();
    assert.equal(history.state.children[0].stop_trigger, "deadline_expired");
    assert.equal(history.state.children[0].terminal?.disposition, "cancelled");
    assert.equal(history.records.filter(({ event }) => event.kind === "child.terminal").length, 1);
    assert.equal(aborts, 1);
    assert.ok(tree.pids.every((pid) => !alive(pid)));
    assert.equal(await coordinator.childWorktreeReleased(boundDescriptor), true);
    const after = await coordinator.snapshot("root", prepared.run_id);
    assert.equal(after!.fabric!.candidate_head, before!.fabric!.candidate_head);
    assert.equal((await run(value.repository, "rev-parse", "main")).trim(), base);
    const leases = JSON.parse(await readFile(join(value.repository, ".git", "sortie-dogs", "scope-leases", "scope-leases.json"), "utf8"));
    assert.equal(leases.leases.length, 0);
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "call", args },
      { output: JSON.stringify({ task_id: "child", status: "completed", run_id: prepared.run_id, dispatch_id: descriptor.dispatch_id }) });
    assert.equal((await ledger.read()).records.filter(({ event }) => event.kind === "child.terminal").length, 1);
    const cancelled = JSON.parse(await hooks.tool!.sortie_cancel_parallel_dispatch.execute({ run_id: prepared.run_id }, { sessionID: "root" }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1);
  } finally {
    if (oldTimeout === undefined) delete process.env.SORTIE_CHILD_DEADLINE_MS; else process.env.SORTIE_CHILD_DEADLINE_MS = oldTimeout;
    await tree.stop();
  }
});
