import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

test("same Worker reruns its exact failed check after setup repair without a new plan or source change", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-validation-retry-"));
  try {
    for (const args of [["init", "--quiet"], ["config", "user.name", "test"], ["config", "user.email", "test@example.invalid"]]) {
      await exec("git", args, { cwd: root });
    }
    await writeFile(join(root, "check.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync(".sortie-env/logs/test.log", "ok"); console.log("PASS");\n');
    await exec("git", ["add", "check.mjs"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "validator"], { cwd: root });
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: "coordinator" },
    };
    const hooks = await SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
    } } } as never);
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }],
    });
    await chat("root", "Run the existing check, repairing local setup if needed.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Run the existing check"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const next = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Validate", objective: "Run the check",
      read: ["check.mjs"], write: [], validation: ["node check.mjs"] }] }, { sessionID: "coordinator" }));
    const task = { args: structuredClone(next.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, task);
    await chat("worker", task.args.prompt);
    const initial = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root"), unit = initial.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } }, { output: "inspected" });
    await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: root, manifest_path: unit.manifestPath }, { sessionID: "worker" });
    const before = (callID: string, args = { command: "node check.mjs" }) => hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID }, { args });
    const after = (callID: string, output: string, exit: number) => hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID }, { output, metadata: { exit, status: "completed" } });
    await before("check-first");
    let failure: { code: number; stderr: string } | undefined;
    try { await exec(process.execPath, ["check.mjs"], { cwd: root }); }
    catch (error) { failure = error as typeof failure; }
    assert.equal(failure?.code, 1);
    assert.match(failure!.stderr, /ENOENT/);
    await after("check-first", failure!.stderr, 1);
    // Setup is intentionally outside candidate identity, just like the Anko Go log directory.
    await before("repair-setup", { command: 'node -e "require(\'node:fs\').mkdirSync(\'.sortie-env/logs\',{recursive:true})"' });
    await mkdir(join(root, ".sortie-env/logs"), { recursive: true });
    await after("repair-setup", "created log directory", 0);
    const retry = { command: "node check.mjs" };
    await before("check-retry", retry);
    assert.equal(retry.command, "node check.mjs", "a failed check must run, not reuse a fake PASS");
    const result = await exec(process.execPath, ["check.mjs"], { cwd: root });
    await after("check-retry", result.stdout, 0);
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, { output: "validated after local setup repair", metadata: { sessionId: "worker" } });
    const current = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
    assert.equal(current.runID, initial.runID);
    assert.equal(current.units[0]!.status, "succeeded");
    const key = createHash("sha256").update("v010\0root").digest("hex");
    const ledger = await (await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`))).readGoal();
    assert.equal(ledger.state.consumed_units, 1);
    assert.equal(ledger.state.validation_budget.consumed, 2);
    const validations = ledger.records.map(({ event }) => event).filter(event => event.kind === "validation.admission" && event.decision === "ALLOW");
    assert.equal(validations.length, 2);
    assert.equal(validations[0]!.evidence_key, validations[1]!.evidence_key, "source, candidate and command did not change");
    const outcomes = ledger.records.map(({ event }) => event).filter(event => event.kind === "validation.settled").map(event => event.outcome);
    assert.deepEqual(outcomes, ["failed", "passed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
