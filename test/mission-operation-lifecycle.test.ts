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

test("cancelled mission -> new native Coordinator -> external outputs -> cold second unit -> review and acceptance", async () => {
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
      current: { agent: "dogs-coordinator", parentID: "root" },
      first: { agent: "dog-worker-v010", parentID: "current" },
      second: { agent: "dog-worker-v010", parentID: "current" },
      reviewer: { agent: "dog-reviewer-v010", parentID: "current" },
    };
    const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
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
    const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);

    await chat("root", "Install the earlier release.");
    const old = await tool("start_mission", "root", { requirements: ["Install earlier release"] });
    await before("root", "old-call", old.task);
    await chat("old", old.task.prompt);
    const planned = await tool("plan_units", "old", { units: [{ title: "Old install", objective: "Install earlier release",
      read: ["check.mjs"], write: ["old.txt"], validation: ["node check.mjs old"] }] });
    await before("old", "old-worker-call", planned.task);
    await chat("oldWorker", planned.task.prompt);
    await tool("cancel_operator", "root", { reason: "plain" });
    identities.old!.outcome = "interrupted";
    identities.oldWorker!.outcome = "interrupted";
    const beforeBudget = (await tool("operator_status", "root")).budget;

    await chat("root", "Replace the cancelled installation with the newer release at two destinations.");
    const current = await tool("start_mission", "root", { intent: "new", requirements: ["Install newer release at both destinations"] });
    assert.notEqual(current.mission_id, old.mission_id);
    await before("root", "current-call", current.task);
    await chat("current", current.task.prompt);
    let next = await tool("plan_units", "current", { units: ["one", "two"].map(name => ({
      title: `Install ${name}`, objective: `Write and verify destination ${name}`, read: ["check.mjs"],
      write: [join(external, name)], validation: [`node check.mjs ${name}`],
    })) });
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
      const name = index === 0 ? "one" : "two", destination = join(external, name);
      await hooks["tool.execute.before"]!({ tool: "write", sessionID: id, callID: `${id}-write` },
        { args: { filePath: destination, content: "installed" } });
      await mkdir(external, { recursive: true });
      await writeFile(destination, "installed");
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
    assert.equal(validated.budget.consumed_units, beforeBudget.consumed_units + 2);
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
