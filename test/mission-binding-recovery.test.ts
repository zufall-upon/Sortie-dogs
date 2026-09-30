import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

for (const readOnly of [false, true]) test(`returned recoverable mission Worker releases overlap for serial ${readOnly ? "reader" : "writer"}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/serial-binding-"));
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  try {
    await writeFile(join(directory, "check.mjs"), "console.log('check');\n");
    const identities: Record<string, object> = { root: { agent: "dog-operator" },
      coordinator: { agent: "dogs-coordinator", parentID: "root" },
      old: { agent: "dog-worker-v010", parentID: "coordinator" }, next: { agent: "dog-worker-v010", parentID: "coordinator" } };
    const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async () => ({ data: [] }), messages: async () => ({ data: [] }),
    } } } as never);
    const tool = async (name: string, sessionID: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID }));
    const chat = (sessionID: string, text: string, agent: string) => hooks["chat.message"]!({ sessionID, messageID: sessionID + "-user", agent },
      { message: { id: sessionID + "-user", agent, model: { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }] });
    const dispatch = (sessionID: string, callID: string, task: object) => hooks["tool.execute.before"]!({ sessionID, callID, tool: "task" }, { args: structuredClone(task) });
    const inspect = async (sessionID: string, path: string, callID: string) => {
      await hooks["tool.execute.before"]!({ sessionID, callID, tool: "read" }, { args: { filePath: path } });
      await hooks["tool.execute.after"]!({ sessionID, callID, tool: "read" }, { output: "inspected" });
    };
    await chat("root", "Run the procedure", "dog-operator");
    const start = await tool("start_mission", "root", { requirements: ["Run procedure"] });
    await dispatch("root", "coordinator-call", start.task);
    await chat("coordinator", start.task.prompt, "dogs-coordinator");
    const unit = { title: "Run", objective: "Run procedure", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] };
    const first = await tool("plan_units", "coordinator", { units: [unit] });
    await dispatch("coordinator", "old-call", first.task);
    await chat("old", first.task.prompt, "dog-worker-v010");
    const runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const old = (await runtime.required("root")).units[0]!;
    await inspect("old", old.handoffPath, "initial-read");
    assert.equal((await tool("bind_write_gate", "old", { project_root: directory, manifest_path: old.manifestPath })).status, "bound");
    now += 29 * 60_000;
    await inspect("old", join(directory, "check.mjs"), "keep-authorization-live");
    now += 2 * 60_000;
    assert.equal((await tool("bind_write_gate", "old", { project_root: directory, manifest_path: old.manifestPath })).reason, "handoff-uninspected");
    identities.old = { agent: "dog-worker-v010", parentID: "coordinator", outcome: "interrupted" };
    await hooks["tool.execute.after"]!({ sessionID: "coordinator", callID: "old-call", tool: "task" },
      { output: "PROCESS_DEFECT: local: handoff-uninspected", metadata: { sessionId: "old" } });
    const second = await tool("plan_units", "coordinator", { units: [{ ...unit, title: "Continue", objective: "Continue retained operation",
      read: readOnly ? ["check.mjs", "result.txt"] : unit.read, write: readOnly ? [] : unit.write }], reason: "Returned Worker could not bind" });
    await dispatch("coordinator", "next-call", second.task);
    await chat("next", second.task.prompt, "dog-worker-v010");
    const next = (await runtime.required("root")).units[0]!;
    await inspect("next", next.handoffPath, "next-read");
    const bound = await tool("bind_write_gate", "next", { project_root: directory, manifest_path: next.manifestPath });
    assert.equal(bound.status, "bound", JSON.stringify(bound));
  } finally { Date.now = clock; await rm(directory, { recursive: true, force: true }); }
});
