import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

for (const verdict of ["PASS", "FINDINGS"] as const) test(`Fast-first ${verdict}: one direct Worker and an independent Reviewer`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-fast-review-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"),
      'import { readFileSync } from "node:fs";\nif (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n');
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
      reviewer: { agent: "dog-reviewer-v010", parentID: "root" },
    };
    const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
    } } } as never);
    await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: agents.root!.agent }, {
      message: { id: "request", agent: agents.root!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text: "Create result.txt with ready, validate and review it." }],
    });
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Create validated result.txt"] },
      { sessionID: "root" }));
    assert.match(started.next_action, /Default to plan_units/);
    const open = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.match(open.next_action, /Fast-lane.*plan one useful Worker/);
    assert.ok(open.task, "the same Coordinator reference remains available when the contract is not one unit");
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Write ready result",
      objective: "Create result.txt with ready followed by newline", read: ["check.mjs"], write: ["result.txt"],
      validation: ["node check.mjs"] }] }, { sessionID: "root" }));
    const worker = { args: structuredClone(planned.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, worker);
    await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-request", agent: agents.worker!.agent }, {
      message: { id: "worker-request", agent: agents.worker!.agent, model: { providerID: "openai", modelID: "gpt-6-luna-fast" } },
      parts: [{ type: "text", text: worker.args.prompt }],
    });
    const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } },
      { output: await readFile(unit.handoffPath, "utf8") });
    await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: directory, manifest_path: unit.manifestPath },
      { sessionID: "worker" });
    await writeFile(join(directory, "result.txt"), "ready\n");
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validation" },
      { args: { command: "node check.mjs" } });
    await exec(process.execPath, ["check.mjs"], { cwd: directory });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validation" },
      { output: "PASS", metadata: { exit: 0, status: "completed" } });
    agents.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
      { output: "Validated result", metadata: { sessionId: "worker" } });
    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(status.coordinator_session_id, null);
    assert.equal(status.units[0].status, "succeeded");
    assert.equal(status.task, undefined, "a successful Fast unit must not prompt a Coordinator dispatch");
    assert.match(status.next_action, /Fast-lane.*review_mission/);
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      traces: ["R1: result.txt has ready newline; node check.mjs exited 0"] }, { sessionID: "root" }));
    const pending = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(pending.task, undefined);
    assert.match(pending.next_action, /Fast-lane.*Reviewer Task/);
    const reviewer = { args: structuredClone(review.task) };
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "altered-review" },
      { args: { ...reviewer.args, prompt: reviewer.args.prompt + "\nchanged" } }), /mission-review-task-required/);
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "review-call" }, reviewer);
    agents.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "review-call" },
      { output: `${verdict}\nReviewed actual result and validation.`, metadata: { sessionId: "reviewer" } });
    const reviewed = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(reviewed.review.verdict, verdict === "PASS" ? "PASS" : "findings");
    assert.equal(reviewed.review.reviewer_session_id, "reviewer");
    assert.equal(reviewed.coordinator_session_id, null);
    if (verdict === "FINDINGS") {
      assert.ok(reviewed.task, "a concrete defect needs the same mission's Coordinator, not a new mission");
      assert.match(reviewed.next_action, /Fast-lane needs correction/);
      assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "ready\n", "Fast work survives escalation");
      agents.coordinator = { agent: "dogs-coordinator", parentID: "root" };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" },
        { args: structuredClone(reviewed.task) });
      await hooks["chat.message"]!({ sessionID: "coordinator", messageID: "coordinator-request", agent: agents.coordinator.agent }, {
        message: { id: "coordinator-request", agent: agents.coordinator.agent,
          model: { providerID: "openai", modelID: "gpt-6-sol" } },
        parts: [{ type: "text", text: reviewed.task.prompt }],
      });
      const correction = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Correct review finding",
        objective: "Keep the validated result and address the concrete review finding", read: ["check.mjs"],
        write: ["result.txt"], validation: ["node check.mjs"] }],
        reason: "The independent Reviewer found a concrete defect in the current candidate" }, { sessionID: "coordinator" }));
      assert.ok(correction.task);
      const escalated = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(escalated.id, started.mission_id);
      assert.equal(escalated.coordinator, "coordinator");
      assert.equal(escalated.review?.verdict, "findings", "a replan must not turn FINDINGS into PASS");
      return;
    }
    assert.equal(reviewed.task, undefined);
    assert.match(reviewed.next_action, /Fast-lane.*complete_mission/);
    const completed = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).coordinator, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
