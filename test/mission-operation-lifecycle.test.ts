import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { initializeProject } from "../dist/core/initialize.js";

const exec = promisify(execFile);

for (const mode of ["cancel", "replace", "missed-after"]) test(`cold ${mode} after accepted work -> external outputs -> reload -> acceptance`, async () => {
  const replaceActive = mode === "replace";
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
    const history: Record<string, unknown[]> = {};
    const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => {
        if (replaceActive) throw new Error("v2-history-owning-service-unavailable");
        return { data: Object.entries(identities).filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) };
      },
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }), abort: async ({ path }: { path: { id: string } }) => {
        aborted.push(path.id); return { data: true };
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
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "old", callID: "prior-worker-call" }, { output: "prepared", metadata: { sessionId: "priorWorker" } });
    assert.equal((await tool("operator_status", "root")).units[0].status, "succeeded");
    const planned = await tool("operator_next", "old");
    await before("old", "old-worker-call", planned.task);
    await chat("oldWorker", planned.task.prompt);
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
    if (!replaceActive) await tool("cancel_operator", "root", { reason: "plain" });
    // Native interruption may acknowledge closure before idle_outcome is written.
    const beforeBudget = (await tool("operator_status", "root")).budget;
    assert.equal(beforeBudget.reserved_units, replaceActive ? 1 : 0);
    hooks = await create();
    assert.equal((await tool("operator_status", "root")).budget.consumed_units, beforeBudget.consumed_units);

    await chat("root", "Replace the cancelled installation with the newer release at two destinations.");
    const current = await tool("start_mission", "root", { intent: replaceActive ? "replace" : "new", requirements: ["Install newer release at both destinations"] });
    assert.notEqual(current.mission_id, old.mission_id);
    assert.deepEqual(current.requirements.map((item: { text: string }) => item.text), ["Install newer release at both destinations"]);
    await before("root", "current-call", current.task);
    await chat("current", current.task.prompt);
    const stopsBefore = aborted.length;
    await tool("operator_status", "root");
    await tool("operator_status", "root");
    assert.equal(aborted.length, stopsBefore, "persisted native acknowledgements prevent repeated cancellation");
    let next = await tool("plan_units", "current", { units: ["one", "two"].map(name => ({
      title: `Install ${name}`, objective: `Write and verify destination ${name}`, read: ["check.mjs"],
      write: [join(external, name)], validation: [`node check.mjs ${name}`],
    })) });
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
          assert.ok(text.includes(unit.handoffPath));
          assert.ok(text.includes(unit.manifestPath));
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
    assert.equal(validated.units[1].evidence[0].protected_binding.source_policy, "declared-paths-v1");
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
