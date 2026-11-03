import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { initializeProject } from "../dist/core/initialize.js";

const exec = promisify(execFile);

for (const mode of ["cancel", "cancel-before-child", "cancel-before-child-direct", "replace", "missed-after", "orphan-abort", "settled-orphan"]) test(`cold ${mode} after accepted work -> external outputs -> reload -> acceptance`, async () => {
  const replaceActive = mode === "replace";
  const unclaimed = mode.startsWith("cancel-before-child"), directReplacement = mode.endsWith("-direct");
  await mkdir(resolve("_testenv"), { recursive: true });
  const area = await mkdtemp(resolve("_testenv/mission-operations-"));
  const root = join(area, "project"), external = join(area, "global install");
  try {
    await mkdir(root);
    await exec("git", ["init", "--quiet"], { cwd: root });
    await initializeProject(root, "v010");
    await writeFile(join(root, "check.mjs"), [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      `assert.equal(readFileSync(${JSON.stringify(external)} + "/" + process.argv[2], "utf8"), "installed");`,
    ].join("\n"));
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, old: { agent: "dogs-coordinator", parentID: "root" },
      oldWorker: { agent: "dog-worker-v010", parentID: "old" },
      priorWorker: { agent: "dog-worker-v010", parentID: "old" },
      current: { agent: "dogs-coordinator", parentID: "root" },
      first: { agent: "dog-worker-v010", parentID: "current" },
      second: { agent: "dog-worker-v010", parentID: "current" },
      reviewer: { agent: "dog-reviewer-v010", parentID: "current" },
    };
    const aborted: string[] = [];
    let stopConfirmed = true;
    const nativeActive: Record<string, { type: string }> = {};
    const history: Record<string, unknown[]> = {};
    let childrenUnavailable = false, activeUnavailable = false;
    const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      active: async () => ({ data: activeUnavailable ? undefined : nativeActive }),
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => {
        if (childrenUnavailable && path.id === "old") throw new Error("native-child-history-unavailable");
        if (replaceActive && ["root", "old", "oldWorker", "priorWorker"].includes(path.id)) throw new Error("v2-history-owning-service-unavailable");
        return { data: Object.entries(identities).filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) };
      },
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }), abort: async ({ path }: { path: { id: string } }) => {
        aborted.push(path.id); return { data: stopConfirmed };
      },
    } } } as never);
    let hooks = await create();
    let turn = 0;
    const chat = async (id: string, text: string) => {
      const messageID = `user-${++turn}`;
      await hooks["chat.message"]!({ sessionID: id, messageID, agent: identities[id]!.agent }, {
        message: { id: messageID, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
        parts: [{ type: "text", text }],
      });
    };
    const tool = async (name: string, id: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: id }));
    const before = (id: string, callID: string, task: object) => hooks["tool.execute.before"]!(
      { tool: "task", sessionID: id, callID }, { args: structuredClone(task) });
    let runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);

    await chat("root", "Install the earlier release.");
    const old = await tool("start_mission", "root", { requirements: ["Install earlier release"] });
    await before("root", "old-call", old.task);
    await chat("old", old.task.prompt);
    const preparation = await tool("plan_units", "old", { units: [
      { title: "Old preparation", objective: "Prepare the earlier release", read: ["check.mjs"], write: [join(external, "old")], validation: ["node check.mjs old"] },
      { title: "Old install", objective: "Install earlier release", read: ["check.mjs"], write: ["old.txt"], validation: ["node check.mjs unfinished"] },
    ] });
    await before("old", "prior-worker-call", preparation.task);
    await chat("priorWorker", preparation.task.prompt);
    const priorUnit = (await runtime.required("root")).units[0]!;
    const priorRead = { tool: "read", sessionID: "priorWorker", callID: "prior-read", args: { filePath: priorUnit.handoffPath } };
    await hooks["tool.execute.before"]!(priorRead, { args: priorRead.args });
    await hooks["tool.execute.after"]!(priorRead, { output: "inspected" });
    await tool("bind_write_gate", "priorWorker", { project_root: root, manifest_path: priorUnit.manifestPath });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "old"), "installed");
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "priorWorker", callID: "prior-check" }, { args: { command: "node check.mjs old" } });
    const checkedPrior = await exec(process.execPath, ["check.mjs", "old"], { cwd: root });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "priorWorker", callID: "prior-check" }, { output: checkedPrior.stdout, metadata: { exit: 0, status: "completed" } });
    identities.priorWorker!.outcome = "succeeded";
    if (unclaimed) history.priorWorker = [{ info: { id: "prior-usage", role: "assistant", sessionID: "priorWorker",
      providerID: "openai", modelID: "gpt-6.1-sol", time: { created: Date.now(), completed: Date.now() },
      tokens: { input: 1000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }];
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "old", callID: "prior-worker-call" }, { output: "prepared", metadata: { sessionId: "priorWorker" } });
    assert.equal((await tool("operator_status", "root")).units[0].status, "succeeded");
    const planned = await tool("operator_next", "old");
    await before("old", "old-worker-call", planned.task);
    if (!unclaimed) await chat("oldWorker", planned.task.prompt);
    else history.old = [{ info: { role: "assistant", sessionID: "old" }, parts: [
      { type: "tool", tool: "task", callID: "old-worker-call", state: { status: "error", input: planned.task,
        error: { type: "aborted" }, time: { end: Date.now() } } },
    ] }];
    hooks = await create(); // Reload with a durable reservation and no process-local ownership Map.
    if (mode === "missed-after") {
      assert.equal((await tool("operator_status", "root")).budget.reserved_units, 1);
      identities.oldWorker!.outcome = "failed";
      history.old = [{ info: { role: "assistant", sessionID: "old" }, parts: [
        { type: "tool", tool: "task", callID: "old-worker-call", state: { status: "error" } },
      ] }];
      const recovered = await tool("operator_status", "root");
      assert.equal(recovered.budget.reserved_units, 0);
      assert.equal(recovered.units[1].status, "failed");
      assert.equal(recovered.units[1].result_class, "process-defect");
      assert.deepEqual(recovered.units[1].evidence, []);
    }
    if (mode === "orphan-abort") {
      assert.equal((await tool("operator_status", "root")).budget.reserved_units, 1,
        "an in-flight parent Task must not be interrupted by a status read");
      history.old = [{ info: { role: "assistant", sessionID: "old" }, parts: [
        { type: "tool", tool: "task", callID: "old-worker-call", state: { status: "error",
          input: planned.task, error: { type: "timeout" } } },
      ] }];
      assert.equal((await tool("operator_status", "root")).budget.reserved_units, 1);
      assert.deepEqual(aborted, [], "a non-aborted native error does not stop a child with an unknown outcome");
      (history.old[0] as { parts: { state: { error: { type: string } } }[] }).parts[0]!.state.error.type = "aborted";
      identities.oldWorker!.parentID = "foreign";
      assert.equal((await tool("operator_status", "root")).budget.reserved_units, 1);
      assert.deepEqual(aborted, [], "an unrelated child cannot be interrupted");
      identities.oldWorker!.parentID = "old";
      const terminal = (history.old[0] as { parts: { state: { input: Record<string, unknown>; metadata?: { sessionId: string } } }[] }).parts[0]!.state;
      terminal.input = { ...planned.task, prompt: "foreign Task" };
      assert.equal((await tool("operator_status", "root")).budget.reserved_units, 1);
      assert.deepEqual(aborted, [], "a foreign parent Task prompt cannot authorize an orphan interrupt");
      terminal.input = planned.task;
      terminal.metadata = { sessionId: "foreign" };
      assert.equal((await tool("operator_status", "root")).budget.reserved_units, 1);
      assert.deepEqual(aborted, [], "a foreign child reference cannot authorize an orphan interrupt");
      delete terminal.metadata;
      stopConfirmed = false;
      assert.equal((await tool("operator_status", "root")).budget.reserved_units, 1);
      assert.deepEqual(aborted, ["oldWorker"], "a refused interrupt cannot settle the reservation");
      stopConfirmed = true;
      const recovered = await tool("operator_status", "root");
      assert.deepEqual(aborted, ["oldWorker", "oldWorker"], "retry only the unconfirmed interrupt");
      assert.equal(recovered.mission_id, old.mission_id, "retain the original Mission rather than starting replacement work");
      assert.equal(recovered.budget.reserved_units, 0);
      assert.equal(recovered.units[1].status, "failed");
      assert.equal(recovered.units[1].result_class, "process-defect");
      assert.deepEqual(recovered.units[1].evidence, [], "an interrupt acknowledgement is not validation or acceptance");
      await tool("operator_status", "root");
      assert.deepEqual(aborted, ["oldWorker", "oldWorker"], "settled status does not repeat the interrupt");
    }
    if (!replaceActive) await tool("cancel_operator", "root", { reason: "plain" });
    // Native interruption may acknowledge closure before idle_outcome is written.
    const beforeBudget = (await tool("operator_status", "root")).budget;
    assert.equal(beforeBudget.reserved_units, replaceActive ? 1 : 0);
    const cancelled = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
    const ledgerPath = join(root, ".git/sortie-dogs/run-flight-v010", `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
    const settlements = async () => (await RunFlightLedger.readGoalFile(ledgerPath)).records.flatMap(({ event }) => event.kind === "unit.settled" ? [event] : []);
    const priorSettlements = unclaimed ? await settlements() : [];
    if (unclaimed) {
      assert.equal(cancelled.units[1]!.status, "cancelled");
      assert.equal(cancelled.units[1]!.childSessionID, null);
      assert.ok(priorSettlements.some(event => event.cost_usd !== null && event.cost_usd > 0), "retained prior native usage has a nonzero price");
      assert.equal(beforeBudget.settled_cost_usd, null, "the unclaimed Task's unknown usage is not fabricated as zero");
    }
    hooks = await create();
    assert.equal((await tool("operator_status", "root")).budget.consumed_units, beforeBudget.consumed_units);

    await chat("root", "Replace the cancelled installation with the newer release at two destinations.");
    const current = await tool("start_mission", "root", { intent: replaceActive ? "replace" : "new", requirements: ["Install newer release at both destinations"] });
    assert.notEqual(current.mission_id, old.mission_id);
    assert.deepEqual(current.requirements.map((item: { text: string }) => item.text), ["Install newer release at both destinations"]);
    if (!directReplacement) {
      await before("root", "current-call", current.task);
      await chat("current", current.task.prompt);
    }
    const declaration = { units: ["one", ...(directReplacement ? [] : ["two"])].map(name => ({
      title: `Install ${name}`, objective: `Write and verify destination ${name}`, read: ["check.mjs"],
      write: [join(external, name)], validation: [`node check.mjs ${name}`],
    })), ...(directReplacement ? { executor: "self" } : {}) };
    const planner = directReplacement ? "root" : "current";
    if (unclaimed) {
      const terminal = (history.old![0] as { parts: { callID: string; state: Record<string, unknown> }[] }).parts[0]!;
      const original = structuredClone(terminal), info = (history.old![0] as { info: { sessionID: string } }).info;
      const reject = async (pattern: RegExp) => {
        await assert.rejects(tool("plan_units", planner, declaration), pattern);
        const retained = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
        assert.equal(retained.runID, cancelled.runID, "rejected proof retains the old run");
        assert.deepEqual(retained.units.map(unit => unit.evidence), cancelled.units.map(unit => unit.evidence));
        assert.deepEqual((await tool("operator_status", "root")).budget, beforeBudget, "no double settlement or budget reset");
        assert.deepEqual(await settlements(), priorSettlements);
      };
      terminal.state.status = "running";
      await reject(/mission-cancelled-run-task-not-terminal/);
      terminal.state = structuredClone(original.state);
      terminal.callID = "another-call";
      await reject(/mission-cancelled-run-task-not-terminal/);
      terminal.callID = original.callID;
      terminal.state.input = { ...planned.task, prompt: "another Task" };
      await reject(/mission-cancelled-run-task-not-terminal/);
      terminal.state = structuredClone(original.state);
      const prefix = "SORTIE_OPERATOR_TASK_REF ", reference = JSON.parse(planned.task.prompt.slice(prefix.length));
      for (const changed of [{ ...reference, r: "foreign" }, { ...reference, n: "other-run" }, { ...reference, g: cancelled.generation }]) {
        terminal.state.input = { ...planned.task, prompt: prefix + JSON.stringify(changed) };
        await reject(/mission-cancelled-run-task-not-terminal/);
      }
      terminal.state = structuredClone(original.state);
      info.sessionID = "foreign";
      await reject(/mission-cancelled-run-task-not-terminal/);
      info.sessionID = "old";
      terminal.state.metadata = { sessionId: "foreign-child" };
      await reject(/mission-cancelled-run-task-not-terminal/);
      terminal.state = structuredClone(original.state);
      nativeActive.oldWorker = { type: "running" };
      await reject(/mission-superseded-worker-not-terminal/);
      delete nativeActive.oldWorker;
      childrenUnavailable = true;
      await reject(/native-child-history-unavailable/);
      childrenUnavailable = false;
      activeUnavailable = true;
      await reject(/mission-superseded-(?:coordinator|worker)-not-terminal/);
      activeUnavailable = false;
      hooks = await create();
    }
    if (mode === "settled-orphan") {
      // An earlier child is no longer in the current units and has no native idle outcome.
      // Cancellation already released the predecessor's reservations before this cold plan.
      identities.stranded = { agent: "dog-worker-v010", parentID: "old" };
      nativeActive.stranded = { type: "running" };
      const declaration = { units: [{ title: "Install one", objective: "Install newer release", read: ["check.mjs"],
        write: [join(external, "one")], validation: ["node check.mjs one"] }] };
      const beforeRun = await runtime.required("root");
      const beforeSpend = (await tool("operator_status", "root")).budget;
      await assert.rejects(tool("plan_units", "current", declaration), /active-or-unproven/);
      assert.ok(!aborted.includes("stranded"), "planning must not interrupt a live historical child");
      assert.equal((await runtime.required("root")).runID, beforeRun.runID);
      assert.deepEqual((await tool("operator_status", "root")).budget, beforeSpend);
      delete nativeActive.stranded;
      stopConfirmed = false;
      await assert.rejects(tool("plan_units", "current", declaration), /stop-unconfirmed/);
      assert.ok(!(await runtime.required("root")).stoppedChildren?.includes("stranded"));
      stopConfirmed = true;
    }
    const stopsBefore = aborted.length;
    await tool("operator_status", "root");
    await tool("operator_status", "root");
    assert.equal(aborted.length, stopsBefore, "persisted native acknowledgements prevent repeated cancellation");
    let next = await tool("plan_units", planner, declaration);
    if (unclaimed) {
      const archived = JSON.parse(await readFile(`${runtime.statePath("root")}.${cancelled.runID}.archive`, "utf8"));
      assert.deepEqual(archived, cancelled, "native proof is transient: archive retains original cancellation and success evidence");
      assert.equal(await readFile(join(external, "old"), "utf8"), "installed");
      const budget = (await tool("operator_status", "root")).budget;
      assert.equal(budget.consumed_units, beforeBudget.consumed_units);
      assert.equal(budget.settled_cost_usd, beforeBudget.settled_cost_usd);
      assert.deepEqual(await settlements(), priorSettlements, "new planning preserves both known costs and unknown usage without re-settlement");
      if (directReplacement) {
        assert.equal(next.status, "direct-unit-running");
        assert.equal(next.executor_session_id, "root");
        assert.equal(budget.reserved_units, 1, "only the new direct unit owns a reservation");
        assert.equal((await tool("start_direct_unit", "root")).run_id, next.run_id, "repeated activation does not dispatch again");
        assert.deepEqual((await tool("operator_status", "root")).budget, budget);
        return;
      }
    }
    if (mode === "settled-orphan") {
      assert.equal(identities.stranded!.outcome, undefined, "cancellation reconciliation does not forge a native outcome");
      assert.equal(aborted.filter(id => id === "stranded").length, 2, "retry only the previously unconfirmed acknowledgement");
      const calls = aborted.length;
      await tool("operator_status", "root");
      assert.equal(aborted.length, calls, "reconciled planning/status does not repeat cancellation");
    }
    runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
    for (const [index, id] of ["first", "second"].entries()) {
      if (index === 1) {
        hooks = await create();
        next = await tool("operator_next", "current");
      }
      if (index === 0) {
        await assert.rejects(before("current", "stale-task", planned.task), /operator-unit-not-authorized|operator-task-reference/);
        const unit = (await runtime.required("root")).units[0]!;
        const bytes = await readFile(unit.manifestPath);
        await writeFile(unit.manifestPath, "{}");
        await assert.rejects(before("current", "changed-control", next.task), /operator-contract-changed/);
        await writeFile(unit.manifestPath, bytes);
      }
      await before("current", `${id}-call`, next.task);
      await chat(id, next.task.prompt);
      const state = await runtime.required("root"), unit = state.units[index]!;
      const read = { tool: "read", sessionID: id, callID: `${id}-read`, args: { filePath: unit.handoffPath } };
      await hooks["tool.execute.before"]!(read, { args: read.args });
      await hooks["tool.execute.after"]!(read, { output: "inspected" });
      assert.equal((await tool("bind_write_gate", id, { project_root: root, manifest_path: unit.manifestPath })).status, "bound");
      // Syntax alone is not a new permission check or acceptance proof in a mission.
      for (const diagnostic of ['curl -I https://example.test', 'echo "$(git rev-parse HEAD)"', 'rg installed result.txt 2>/dev/null']) {
        await hooks["tool.execute.before"]!({ tool: "shell", sessionID: id, callID: `${id}-diagnostic` }, { args: { command: diagnostic } });
      }
      const name = index === 0 ? "one" : "two", destination = join(external, name);
      await hooks["tool.execute.before"]!({ tool: "write", sessionID: id, callID: `${id}-write` },
        { args: { filePath: destination, content: "installed" } });
      await mkdir(external, { recursive: true });
      await writeFile(destination, "installed");
      if (index === 0) {
        // The native checkpoint can omit both the initial prompt and the successful edit.
        // A fresh plugin must supply the durable assignment without inventing validation proof.
        const recoveredHooks = await create();
        const context = { system: [] as string[] }, compact = { context: [] as string[] };
        await recoveredHooks["experimental.chat.system.transform"]!({ sessionID: id }, context);
        await recoveredHooks["experimental.session.compacting"]!({ sessionID: id }, compact);
        for (const text of [context.system.join("\n"), compact.context.join("\n")]) {
          assert.match(text, /SORTIE_WORKER_CONTEXT/);
          assert.ok(text.includes(relative(root, unit.handoffPath).replaceAll("\\", "/")));
          assert.ok(text.includes(relative(root, unit.manifestPath).replaceAll("\\", "/")));
          assert.ok(text.includes("node check.mjs one"));
          assert.match(text, /inspect the actual diff and outputs/);
        }
        const observed = await tool("operator_status", id);
        assert.equal(observed.units[0].handoff_path, unit.handoffPath);
        assert.equal(observed.units[0].operation_manifest_path, unit.manifestPath);
        assert.equal(observed.units[0].evidence.length, 0, "recovered assignment must not fabricate proof");
        assert.equal(await readFile(destination, "utf8"), "installed", "existing edits survive recovery");
        assert.equal(await runtime.workerContext("root", "oldWorker"), undefined, "retired child must not inherit new work");
      }
      const command = `node check.mjs ${name}`;
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: id, callID: `${id}-validation` }, { args: { command } });
      const checked = await exec(process.execPath, ["check.mjs", name], { cwd: root });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: id, callID: `${id}-validation` }, { output: checked.stdout, metadata: { exit: 0, status: "completed" } });
      identities[id]!.outcome = "succeeded";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "current", callID: `${id}-call` }, { output: "installed", metadata: { sessionId: id } });
      const settled = await tool("operator_status", "root");
      assert.equal(settled.units[index].status, "succeeded", JSON.stringify(settled));
    }
    const validated = await tool("operator_status", "root");
    assert.equal(validated.completion.ready, true);
    assert.equal(validated.budget.consumed_units, beforeBudget.consumed_units + 2 + (replaceActive ? 1 : 0));
    assert.equal(validated.budget.max_units, beforeBudget.max_units);
    assert.equal(validated.budget.reserved_units, 0);
    assert.equal(validated.units[1].evidence[0].protected_binding_ref.source_policy, "declared-paths-v1");
    const review = await tool("review_mission", "current", { risk_tags: ["public-logic"], traces: ["Both installed files verified by real validator processes"] });
    await before("current", "review-call", review.task);
    identities.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "current", callID: "review-call" },
      { output: "PASS\nBoth installation destinations validated.", metadata: { sessionId: "reviewer" } });
    await tool("submit_mission", "current", { status: "ready", summary: "Installed and reviewed" });
    await writeFile(join(external, "two"), "changed");
    const stale = await tool("operator_status", "root");
    assert.equal(stale.completion.ready, false, "an actual external change still invalidates proof");
    assert.ok(stale.completion.blockers.some((blocker: { reason: string }) => blocker.reason === "candidate-changed"));
    await writeFile(join(external, "two"), "installed");
    assert.equal((await tool("complete_mission", "root")).status, "succeeded");
    assert.equal(await readFile(join(external, "one"), "utf8"), "installed");
  } finally { await rm(area, { recursive: true, force: true }); }
});

test("unclaimed root Worker cancellation requires its exact terminal and quiescent native child tree before direct restart", async () => {
  const root = await mkdtemp(resolve("_testenv/unclaimed-root-task-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await initializeProject(root, "v010");
    await writeFile(join(root, "check.mjs"), 'console.log("checked");\n');
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, loose: { agent: "dog-worker-v010", parentID: "root" },
    };
    let activity: Record<string, { type: string }> | undefined = { loose: { type: "running" } };
    const history: unknown[] = [], aborted: string[] = [];
    const create = () => SortieDogsV010Plugin({ directory: root, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      active: async () => ({ data: activity }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: path.id === "root" ? history : [] }),
      abort: async ({ path }: { path: { id: string } }) => { aborted.push(path.id); return { data: true }; },
    } } } as never);
    let hooks = await create();
    await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
      message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
      parts: [{ type: "text", text: "Write result and validate it" }],
    });
    const tool = async (name: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
    const unit = { title: "Write result", objective: "Write result and validate it", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] };
    const started = await tool("start_mission", { requirements: ["Write result and validate it"], unit, preferred_executor: "worker" });
    await hooks["tool.execute.before"]!({ sessionID: "root", callID: "fast-call", tool: "task" }, { args: structuredClone(started.task) });
    history.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "task", callID: "fast-call",
      state: { status: "error", input: started.task, error: { type: "aborted" }, time: { end: Date.now() } } }] });
    await tool("cancel_operator", { reason: "plain" });
    const before = (await tool("operator_status")).budget;
    assert.equal(before.consumed_units, 1); assert.equal(before.reserved_units, 0);
    hooks = await create();
    await tool("start_mission", { intent: "replace", requirements: ["Write result and validate it"] });
    const declaration = { executor: "self", units: [unit] };
    const reject = async () => {
      await assert.rejects(tool("plan_units", declaration), /mission-cancelled-run-task-not-terminal/);
      assert.deepEqual((await tool("operator_status")).budget, before);
      assert.deepEqual(aborted, [], "planning never interrupts a live or unproven root child");
    };
    await reject();
    activity = {};
    await reject(); // Inactive alone does not establish a child's terminal.
    identities.loose!.outcome = "interrupted";
    activity = undefined;
    await reject(); // Even a saved terminal cannot replace an unavailable active snapshot.
    activity = {};
    const continued = await tool("plan_units", declaration);
    assert.equal(continued.status, "direct-unit-running");
    const after = (await tool("operator_status")).budget;
    assert.equal(after.consumed_units, before.consumed_units); assert.equal(after.reserved_units, 1);
    assert.deepEqual(aborted, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
