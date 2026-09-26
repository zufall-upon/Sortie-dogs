import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

test("mission validation survives review, submission, reload and final acceptance with live control reads", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-completion-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.name", "test"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    const validator = 'import { readFileSync } from "node:fs";\nif (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n';
    await writeFile(join(root, "check.mjs"), validator);
    await exec("git", ["add", "check.mjs"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "validator"], { cwd: root });
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: "coordinator" }, reviewer: { agent: "dog-reviewer-v010", parentID: "coordinator" },
    };
    const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
    } } } as never);
    const hooks = await create();
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text }],
    });
    await chat("root", "Write and validate a ready result, then review and accept it.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Create a validated result"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const next = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Validated result", objective: "Write result and validate it",
      read: ["check.mjs", ".sortie-dogs-v010/missions"], write: ["result.txt"], validation: ["node check.mjs"] }] }, { sessionID: "coordinator" }));
    const worker = { args: structuredClone(next.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, worker);
    await chat("worker", worker.args.prompt);
    const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE), state = await runtime.required("root");
    const unit = state.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } }, { output: "inspected" });
    assert.equal(JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: root, manifest_path: unit.manifestPath }, { sessionID: "worker" })).status, "bound");
    await writeFile(join(root, "result.txt"), "ready\n");
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, { args: { command: "node check.mjs" } });
    const checked = await exec(process.execPath, ["check.mjs"], { cwd: root });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, { output: checked.stdout, metadata: { exit: 0, status: "completed" } });
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, { output: "validated", metadata: { sessionId: "worker" } });
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"], traces: ["check.mjs observed ready result, exit 0"] }, { sessionID: "coordinator" }));
    const reviewer = { args: structuredClone(review.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "reviewer-call" }, reviewer);
    assert.match(reviewer.args.prompt, /deferred Operator checks/);
    identities.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "reviewer-call" }, { output: "PASS\nThe result is validated.", metadata: { sessionId: "reviewer" } });
    await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "Validated result, reviewed independently" }, { sessionID: "coordinator" });
    identities.coordinator!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { output: "ready", metadata: { sessionId: "coordinator" } });
    const cold = await create();
    const status = async () => JSON.parse(await cold.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal((await status()).completion.ready, true);
    // The oracle is read-only and therefore outside the review diff. Completion must still name it.
    await writeFile(join(root, "check.mjs"), validator + "// changed after validation\n");
    const blocked = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(blocked.status, "awaiting-evidence");
    assert.equal(blocked.receipt, null);
    assert.equal(blocked.completion.blockers[0].reason, "source-changed");
    assert.ok(blocked.completion.blockers[0].source_paths.includes("check.mjs"));
    const stale = await status();
    assert.deepEqual(stale.completion, blocked.completion);
    assert.equal(stale.next_action, blocked.next_action, "status must not blindly send the root back to the same refused completion");
    await writeFile(join(root, "check.mjs"), validator);
    const completed = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal(completed.receipt.status, "succeeded");
    const final = await status();
    assert.equal(final.phase, "completed");
    assert.match(final.next_action, /no further dispatch or completion/);
    const key = createHash("sha256").update("v010\0root").digest("hex");
    const ledger = await (await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`))).readGoal();
    assert.equal(ledger.state.consumed_units, 1);
    assert.equal(ledger.state.outstanding_reservations.length, 0);
    assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.admission").length, 1, "review and acceptance must not require a second successful check");
    assert.equal(await readFile(join(root, "result.txt"), "utf8"), "ready\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
