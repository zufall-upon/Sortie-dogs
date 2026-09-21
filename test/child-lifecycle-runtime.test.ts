import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { CancellableChildLifecycle } from "../dist/core/child-lifecycle-runtime.js";
import { EvidenceCapsuleStore } from "../dist/core/evidence-capsule.js";
import { RunFlightLedger, RunFlightLedgerError } from "../dist/core/run-flight-ledger.js";
import { terminateTree } from "../dist/core/worktree-commit-artifact.js";
import { ParallelDispatchCoordinator } from "../dist/core/worktree-parallel-dispatch.js";
import { ScopeLeaseRegistry } from "../dist/core/scope-lease-registry.js";
import { SortieDogsPlugin } from "../dist/plugin/index.js";
import type { ChildTerminalEvidence, ChildTerminalIdentity } from "../dist/core/child-terminal-reconciliation.js";
import { acceptAndComplete, commit, fabricContract, fabricUnit, fixture, openParallelCoordinator, run } from "./helpers/worktree-dispatch-fixture.ts";

const roots: string[] = [];
const allReleased = (): ChildTerminalEvidence => ({ terminal: "satisfied", tools_quiescent: "satisfied",
  artifact_window_closed: "satisfied", gate_released: "satisfied", lease_released: "satisfied",
  writer_released: "satisfied", worktree_released: "satisfied" });
const identity: ChildTerminalIdentity = { run_id: "run", unit_id: "unit", attempt_id: "attempt", predecessor_attempt_id: null,
  candidate_id: "base", route_id: "route", child_id: "child", call_id: "call" };
type ProfileEntry = { label: string; duration_ms: number };
type ProfileCallback = { calls: number; cumulative_ms: number; max_ms: number };
const roundedMs = (value: number) => Number(value.toFixed(3));
async function profileStep<T>(entries: ProfileEntry[], label: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await action(); } finally { entries.push({ label, duration_ms: roundedMs(performance.now() - started) }); }
}
async function profileCallback<T>(entry: ProfileCallback, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await action(); } finally {
    const duration = performance.now() - started;
    entry.calls += 1;
    entry.cumulative_ms = roundedMs(entry.cumulative_ms + duration);
    entry.max_ms = roundedMs(Math.max(entry.max_ms, duration));
  }
}
const callbackProfile = (): ProfileCallback => ({ calls: 0, cumulative_ms: 0, max_ms: 0 });
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
  let closeObserved = false;
  const closed = new Promise<void>((resolve) => child.once("close", () => { closeObserved = true; resolve(); }));
  const pids = await new Promise<number[]>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("process fixture did not start")), 10000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim()) as number[]); }
    });
  });
  return { child, closed, pids, stop: async () => { if (!closeObserved && alive(child.pid!)) await terminateTree(child, closed); } };
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

test("child lifecycle arms its registered deadline without readiness gating", async () => {
  const steps: ProfileEntry[] = [];
  const { ledger } = await profileStep(steps, "standalone", () => standalone());
  // Leave enough headroom for ledger setup on loaded CI hosts while still
  // proving that arm() honors a future registered deadline.
  const deadline_ms = Date.now() + 1000;
  let stopped = false;
  let stopCount = 0;
  let terminalCount = 0;
  let terminalResolve!: () => void;
  const terminalObserved = new Promise<void>((resolve) => { terminalResolve = resolve; });
  const lifecycle = await profileStep(steps, "lifecycle_open", () => CancellableChildLifecycle.open({ identity, deadline_ms }, ledger, {
    observe: async () => ({ observation: { identity, disposition: "cancelled" }, evidence: {
      ...allReleased(), terminal: stopped ? "satisfied" : "unsatisfied",
    } }),
    stop: async () => { stopCount += 1; stopped = true; },
    release: async () => {},
    terminal: async () => { terminalCount += 1; terminalResolve(); },
  }));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const registered = (await ledger.read()).state.children[0];
    assert.equal(registered.deadline_ms, deadline_ms);
    assert.ok(Date.now() < deadline_ms, "registered deadline must still be in the future before arm");
    lifecycle.arm();
    assert.equal(stopCount, 0);
    await profileStep(steps, "deadline_terminal", () => Promise.race([
      terminalObserved,
      new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("armed deadline did not reach terminal")), 5000); }),
    ]));
    assert.ok(Date.now() >= deadline_ms);
    assert.equal(stopCount, 1);
    assert.equal(terminalCount, 1);
    const final = await ledger.read();
    assert.equal(final.state.children[0].stop_trigger, "deadline_expired");
    assert.equal(final.state.children[0].terminal?.disposition, "cancelled");
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    lifecycle.dispose();
    console.log(JSON.stringify({ marker: "child-lifecycle-profile", case: "registered-deadline-arm", steps,
      stop_count: stopCount, terminal_count: terminalCount }));
  }
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

test("a protected success after durable stop intent keeps succeeded disposition", async () => {
  const { ledger } = await standalone();
  let protectedPhase = true;
  let terminal = false;
  let releases = 0;
  let stops = 0;
  const lifecycle = await CancellableChildLifecycle.open({ identity, deadline_ms: Date.now() - 1 }, ledger, {
    observe: async () => ({ observation: { identity, disposition: "succeeded" }, evidence: {
      ...allReleased(), terminal: terminal ? "satisfied" : "unsatisfied",
      artifact_window_closed: protectedPhase ? "unsatisfied" : "satisfied",
      worktree_released: releases > 0 ? "satisfied" : "unsatisfied",
    } }),
    stop: async () => { stops += 1; },
    release: async () => { releases += 1; },
    terminal: async () => {},
  });
  assert.equal((await lifecycle.check()).status, "waiting");
  protectedPhase = false;
  terminal = true;
  const result = await lifecycle.check();
  assert.equal(result.status, "terminal");
  if (result.status === "terminal") assert.equal(result.state.terminal?.disposition, "succeeded");
  assert.equal(stops, 0);
  assert.equal(releases, 1);
});

test("live takeover rejects a stale attempt identity before lifecycle effects", async () => {
  const { ledger } = await standalone();
  let effects = 0;
  const lifecycle = await CancellableChildLifecycle.open({ identity, deadline_ms: Date.now() + 60_000 }, ledger, {
    observe: async () => ({ observation: { identity, disposition: "cancelled" }, evidence: allReleased() }),
    stop: async () => { effects += 1; }, release: async () => { effects += 1; }, terminal: async () => { effects += 1; },
  });
  assert.deepEqual(await lifecycle.stopForTakeover({ ...identity, attempt_id: "stale" }), {
    status: "waiting", reason: "identity-drift",
  });
  assert.equal(effects, 0);
  lifecycle.dispose();
});

test("cancelling one child preserves accepted sibling artifacts and both accepted snapshots", async () => {
  const steps: ProfileEntry[] = [];
  const callbacks = { observe: callbackProfile(), stop: callbackProfile(), release: callbackProfile(), terminal: callbackProfile() };
  let poll_iterations = 0;
  const value = await profileStep(steps, "fixture", () => fixture("siblings")); roots.push(value.root);
  const coordinator = await openParallelCoordinator(value.repository);
  const prepared = await profileStep(steps, "prepareFabric", () =>
    coordinator.prepareFabric(fabricContract(value.sha, [fabricUnit("a", 0), fabricUnit("b", 1)]), "root"));
  assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") return;
  const [a, b] = prepared.snapshot.ready;
  await profileStep(steps, "bind_a", () => coordinator.bindDispatch("root", "call-a", a));
  await profileStep(steps, "bind_b", () => coordinator.bindDispatch("root", "call-b", b));
  const sibling = await profileStep(steps, "acceptAndComplete", () => acceptAndComplete(coordinator, b, "call-b", "child-b"));
  const ledger = await profileStep(steps, "childLedger", () => coordinator.childLedger("root", a, "call-a", "child-a"));
  const current = { run_id: a.run_id, unit_id: a.task_id, attempt_id: a.dispatch_id, predecessor_attempt_id: null,
    candidate_id: a.base_sha, route_id: a.parallel_group, child_id: "child-a", call_id: "call-a" };
  let stopped = false;
  const lifecycle = await profileStep(steps, "lifecycle_open", () => CancellableChildLifecycle.open(
    { identity: current, deadline_ms: Date.now() - 1 }, ledger, {
      observe: async () => profileCallback(callbacks.observe, async () => ({ observation: { identity: current, disposition: "cancelled" }, evidence: { ...allReleased(),
        terminal: stopped ? "satisfied" : "unsatisfied", worktree_released: await coordinator.childWorktreeReleased(a) ? "satisfied" : "unsatisfied" } })),
      stop: async () => profileCallback(callbacks.stop, async () => { stopped = true; }),
      release: async () => profileCallback(callbacks.release, async () => { await coordinator.releaseChildWorktree("root", a, "call-a", "child-a", allReleased()); }),
      terminal: async () => profileCallback(callbacks.terminal, async () => { await coordinator.completeCall("root", "call-a", "child-a", "cancelled"); }),
    }));
  const completion = await profileStep(steps, "lifecycle_check", async () => {
    let result = await lifecycle.check();
    const finishBy = Date.now() + 60000;
    while (result.status === "waiting" && result.reason === "runtime-pending" && Date.now() < finishBy) {
      poll_iterations += 1;
      result = await lifecycle.check();
      if (result.status === "waiting" && result.reason === "runtime-pending") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return result;
  });
  assert.equal(completion.status, "terminal");
  await profileStep(steps, "snapshot_assertions", async () => {
    const after = await coordinator.snapshot("root", a.run_id);
    assert.deepEqual(after!.tasks.find(({ descriptor }) => descriptor.dispatch_id === b.dispatch_id)!.artifact, sibling.artifact);
    assert.equal(after!.fabric!.candidate_head, prepared.snapshot.fabric!.candidate_head);
    assert.equal((await run(value.repository, "rev-parse", "main")).trim(), value.sha);
    await assert.rejects(coordinator.demoteFailedFabricUnit("root", a.run_id, a.task_id), { code: "wave-not-ready" });
  });
  await profileStep(steps, "release_sibling", () => coordinator.releaseChildWorktree("root", b, "call-b", "child-b", allReleased()));
  await profileStep(steps, "reopen", async () => {
    assert.equal((await run(value.repository, "cat-file", "-t", sibling.artifact.commit_sha)).trim(), "commit");
    assert.ok((await run(value.repository, "for-each-ref", "--format=%(objectname)", "refs/sortie-dogs/luna-fabric-sources")).includes(sibling.artifact.commit_sha));
    const reopened = await openParallelCoordinator(value.repository);
    assert.deepEqual((await reopened.snapshot("root", a.run_id))!.tasks.find(({ descriptor }) => descriptor.dispatch_id === b.dispatch_id)!.artifact, sibling.artifact);
  });
  console.log(JSON.stringify({ marker: "child-lifecycle-profile", case: "accepted-sibling", steps, callbacks, poll_iterations }));
});

test("plugin deadline takes over one critical child and preserves an unrelated lane", async (t) => {
  const steps: ProfileEntry[] = [];
  const callbacks = { abort: callbackProfile(), tree_stop: callbackProfile() };
  let poll_iterations = 0;
  const transitions: Array<{ at_ms: number; event: "ledger-terminal" | "final-snapshot"; observed_at: string;
    terminal_at: string | null; source_phase: string | null; source_attempt: number | null;
    demotion_phase: string | null; attempt2_phase: string | null }> = [];
  const transition_durations: Record<"terminal_to_snapshot_ms", number | null> = { terminal_to_snapshot_ms: null };
  const value = await profileStep(steps, "fixture", () => fixture("child")); roots.push(value.root);
  const { base, contractPath } = await profileStep(steps, "git_setup", async () => {
    await writeFile(join(value.repository, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
    await run(value.repository, "add", ".gitignore"); await commit(value.repository, "-qm", "fixture controls");
    const base = (await run(value.repository, "rev-parse", "HEAD")).trim();
    await run(value.repository, "checkout", "--detach", base);
    await mkdir(join(value.repository, ".opencode"));
    const contractPath = join(value.repository, ".opencode", "sortie-dogs-luna-fabric.json");
    await writeFile(contractPath, JSON.stringify(fabricContract(base, [
      fabricUnit("a", 0), fabricUnit("b", 1, { depends_on: ["a"] }), fabricUnit("c", 2),
    ])));
    return { base, contractPath };
  });
  const tree = await profileStep(steps, "process_fixture", () => processTree());
  const oldTimeout = process.env.SORTIE_CHILD_DEADLINE_MS;
  process.env.SORTIE_CHILD_DEADLINE_MS = "2000";
  let hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>;
  let aborts = 0;
  let abortAt = 0;
  let releaseFailure: unknown;
  let capturedLifecycle: CancellableChildLifecycle | undefined;
  let capturedIdentity: ChildTerminalIdentity | undefined;
  let targetArmCaptures = 0;
  let armRestored = false;
  let armResumed = false;
  let artifactResult: Promise<string> | undefined;
  let artifactSettled: { output?: string; error?: unknown } | undefined;
  const originalReleaseChildWorktree = ParallelDispatchCoordinator.prototype.releaseChildWorktree;
  ParallelDispatchCoordinator.prototype.releaseChildWorktree = async function (...releaseArgs) {
    try { return await originalReleaseChildWorktree.apply(this, releaseArgs); }
    catch (error) { releaseFailure = error; throw error; }
  };
  const client = { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: path.id === "root"
      ? { id: "root", agent: "dog-coordinator" } : { id: path.id, agent: "dog-luna-worker", parentID: "root" } }),
    abort: async ({ path }: { path: { id: string } }) => {
      return profileCallback(callbacks.abort, async () => {
        assert.equal(path.id, "child"); aborts += 1; abortAt = Date.now();
        await profileCallback(callbacks.tree_stop, () => tree.stop()); assert.ok(tree.pids.every((pid) => !alive(pid)));
        await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "child" } } });
        return { data: true };
      });
    },
  } } as never;
  try {
    const prepared = await profileStep(steps, "prepare", async () => {
      hooks = await SortieDogsPlugin({ directory: value.repository, client, childLifecycleCheckWaitMs: 100 });
      await hooks["chat.message"]!({ sessionID: "root", agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "fixture" }] });
      return JSON.parse(await hooks.tool!.sortie_prepare_luna_fabric.execute({ contract_path: contractPath }, { sessionID: "root", agent: "dog-coordinator" }));
    });
    assert.equal(prepared.status, "prepared");
    const descriptor = prepared.ready[0];
    const args = { subagent_type: "dog-luna-worker", prompt: ["context_digest:", `  task_id: ${descriptor.task_id}`,
      `  run_id: ${descriptor.run_id}`, "  role: implementation", "  source_manifest: [base.txt]",
      "  acceptance:", ...descriptor.acceptance.map((text: string) => `    - ${text}`), "  validation: no canonical validation"].join("\n") };
    const originalArm = CancellableChildLifecycle.prototype.arm;
    const armMock = t.mock.method(CancellableChildLifecycle.prototype, "arm", function (this: CancellableChildLifecycle) {
      const current = (this as unknown as { descriptor: { identity: ChildTerminalIdentity } }).descriptor.identity;
      const targeted = current.child_id === "child" && current.call_id === "call" && current.run_id === descriptor.run_id &&
        current.unit_id === descriptor.task_id && current.attempt_id === descriptor.dispatch_id;
      if (targeted && targetArmCaptures === 0) {
        targetArmCaptures += 1;
        capturedLifecycle = this;
        capturedIdentity = current;
        return;
      }
      originalArm.call(this);
    });
    await profileStep(steps, "task_activation_bind", async () => {
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
    });
    const coordinator = await openParallelCoordinator(value.repository);
    const changedPath = join(descriptor.managed_path, descriptor.scope_write[0]);
    await mkdir(dirname(changedPath), { recursive: true });
    await writeFile(changedPath, "deadline-owned-output\n");
    const validationStarted = join(value.root, "validation-started.pid");
    const artifactArgs = { run_id: descriptor.run_id, dispatch_id: descriptor.dispatch_id,
      validation_executable: process.execPath, validation_args_json: JSON.stringify(["-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", validationStarted]),
      timeout_ms: "60000" };
    await hooks["tool.execute.before"]!({ tool: "sortie_create_parallel_commit_artifact", sessionID: "child", callID: "artifact" },
      { args: artifactArgs });
    artifactResult = hooks.tool!.sortie_create_parallel_commit_artifact!.execute(artifactArgs,
      { sessionID: "child", agent: "dog-luna-worker" });
    void artifactResult.then((output) => { artifactSettled = { output }; }, (error: unknown) => { artifactSettled = { error }; });
    const validationStartDeadline = Date.now() + 45_000;
    while (await stat(validationStarted).catch(() => undefined) === undefined && Date.now() < validationStartDeadline) {
      if (artifactSettled !== undefined) {
        const reason = artifactSettled.error instanceof Error ? `${artifactSettled.error.name}: ${artifactSettled.error.message}` :
          artifactSettled.error === undefined ? artifactSettled.output : String(artifactSettled.error);
        throw new Error(`contained validation settled before start marker: ${reason}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.notEqual(await stat(validationStarted).catch(() => undefined), undefined, "contained validation did not start");
    const before = await coordinator.snapshot("root", prepared.run_id);
    const boundDescriptor = before!.tasks.find((task) => task.descriptor.dispatch_id === descriptor.dispatch_id)!.descriptor;
    const ledger = await coordinator.childLedger("root", boundDescriptor, "call", "child");
    assert.equal(targetArmCaptures, 1);
    assert.deepEqual(capturedIdentity, { run_id: descriptor.run_id, unit_id: descriptor.task_id,
      attempt_id: descriptor.dispatch_id, predecessor_attempt_id: null, candidate_id: descriptor.base_sha,
      route_id: descriptor.parallel_group, child_id: "child", call_id: "call" });
    armMock.mock.restore();
    armRestored = true;
    capturedLifecycle!.arm();
    armResumed = true;
    const after = await profileStep(steps, "poll", async () => {
      const pollStarted = performance.now();
      const expires = Date.now() + 120000;
      let terminalObservedAt: number | undefined;
      while (Date.now() < expires) {
        const current = await ledger.read();
        if (current.state.children[0].terminal !== null) {
          terminalObservedAt = performance.now();
          const terminalRecord = current.records.find(({ event }) => event.kind === "child.terminal");
          transitions.push({ at_ms: roundedMs(terminalObservedAt - pollStarted), event: "ledger-terminal",
            observed_at: new Date().toISOString(), terminal_at: terminalRecord?.event.at ?? null,
            source_phase: null, source_attempt: null, demotion_phase: null, attempt2_phase: null });
          break;
        }
        poll_iterations += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.notEqual(terminalObservedAt, undefined, "child ledger did not reach terminal before poll deadline");
      const snapshot = (await coordinator.snapshot("root", prepared.run_id))!;
      const source = snapshot.tasks.find((task) => task.descriptor.task_id === "a");
      const attempt2 = snapshot.tasks.find((task) => task.descriptor.task_id === "a" && task.descriptor.attempt === 2);
      const snapshotObservedAt = performance.now();
      transition_durations.terminal_to_snapshot_ms = roundedMs(snapshotObservedAt - terminalObservedAt!);
      transitions.push({ at_ms: roundedMs(snapshotObservedAt - pollStarted), event: "final-snapshot",
        observed_at: new Date().toISOString(), terminal_at: null, source_phase: source?.phase ?? null,
        source_attempt: source?.descriptor.attempt ?? null, demotion_phase: snapshot.fabric?.transition ?? null,
        attempt2_phase: attempt2?.phase ?? null });
      return snapshot;
    });
    const history = await ledger.read();
    const artifactOutput = await artifactResult;
    await hooks["tool.execute.after"]!({ tool: "sortie_create_parallel_commit_artifact", sessionID: "child", callID: "artifact",
      args: artifactArgs }, { output: artifactOutput });
    assert.equal(JSON.parse(artifactOutput).reason, "artifact-validation-failed");
    assert.equal(history.state.children[0].stop_trigger, "deadline_expired");
    assert.equal(history.state.children[0].terminal?.disposition, "cancelled",
      releaseFailure instanceof Error ? `${releaseFailure.name}: ${releaseFailure.message}` : String(releaseFailure));
    assert.equal(history.records.filter(({ event }) => event.kind === "child.terminal").length, 1);
    assert.equal(aborts, 1);
    assert.ok(abortAt >= history.state.children[0].deadline_ms && abortAt - history.state.children[0].deadline_ms < 15_000,
      `deadline abort was late by ${abortAt - history.state.children[0].deadline_ms}ms`);
    assert.ok(tree.pids.every((pid) => !alive(pid)));
    assert.equal(await stat(boundDescriptor.managed_path).catch(() => undefined), undefined);
    assert.equal(after!.fabric!.candidate_head, before!.fabric!.candidate_head);
    const attempt2 = after!.tasks.find((task) => task.descriptor.task_id === "a");
    assert.equal(attempt2!.descriptor.attempt, 2, JSON.stringify(after));
    assert.equal(attempt2!.descriptor.base_sha, before!.fabric!.candidate_head);
    assert.equal(attempt2!.phase, "reserved");
    assert.ok(after!.ready.some((entry) => entry.dispatch_id === attempt2!.descriptor.dispatch_id));
    const unrelated = after!.tasks.find((task) => task.descriptor.task_id === "c");
    assert.equal(unrelated!.descriptor.attempt, 1);
    assert.notEqual(unrelated!.phase, "cancelled");
    assert.equal(after!.fabric!.demotions.length, 1);
    assert.equal((await run(value.repository, "rev-parse", "main")).trim(), base);
    const leases = JSON.parse(await readFile(join(value.repository, ".git", "sortie-dogs", "scope-leases", "scope-leases.json"), "utf8"));
    assert.equal(leases.leases.length, 0);
    await profileStep(steps, "cleanup_cancel", async () => {
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "call", args },
        { output: JSON.stringify({ task_id: "child", status: "completed", run_id: prepared.run_id, dispatch_id: descriptor.dispatch_id }) });
      assert.equal((await ledger.read()).records.filter(({ event }) => event.kind === "child.terminal").length, 1);
      const cancelled = JSON.parse(await hooks.tool!.sortie_cancel_parallel_dispatch.execute({ run_id: prepared.run_id }, { sessionID: "root" }));
      assert.equal(cancelled.status, "cancelled");
      assert.equal((await run(value.repository, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1);
    });
  } finally {
    if (!armRestored) {
      t.mock.restoreAll();
      armRestored = true;
    }
    if (capturedLifecycle !== undefined && !armResumed) {
      capturedLifecycle.arm();
      armResumed = true;
    }
    await artifactResult?.catch(() => undefined);
    ParallelDispatchCoordinator.prototype.releaseChildWorktree = originalReleaseChildWorktree;
    if (oldTimeout === undefined) delete process.env.SORTIE_CHILD_DEADLINE_MS; else process.env.SORTIE_CHILD_DEADLINE_MS = oldTimeout;
    await profileStep(steps, "process_stop", () => tree.stop());
    console.log(JSON.stringify({ marker: "child-lifecycle-profile", case: "deadline-takeover", steps, callbacks, poll_iterations,
      transitions, transition_durations }));
  }
});
