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

for (const self of [false, true]) test(`Fast-lane failed validation permits root correction then ${self ? "same-session formal checks" : "a second Worker"} and fresh Review`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-fast-recovery-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"),
      'import { readFileSync } from "node:fs";\nif (readFileSync("result.txt", "utf8") !== "fixed\\n") process.exit(1);\n');
    await writeFile(join(directory, "review-notes.txt"), "Original review context\n");
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, first: { agent: "dog-worker-v010", parentID: "root" },
      second: { agent: "dog-worker-v010", parentID: "root" }, reviewer: { agent: "dog-reviewer-v010", parentID: "root" },
    };
    const rootHistory: Record<string, unknown>[] = [];
    const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: path.id === "root" ? rootHistory : [] }), abort: async () => ({ data: true }),
    } } } as never);
    await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: agents.root!.agent }, {
      message: { id: "request", agent: agents.root!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text: "Fix result.txt and verify check.mjs" }],
    });
    const unit = { title: "Fix result",
      objective: "Create a result accepted by check.mjs", read: ["check.mjs"], write: ["result.txt"],
      validation: ["node check.mjs"] };
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed result"],
      ...(self ? { unit } : {}) }, { sessionID: "root" }));
    const planned = self ? started : JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [unit] }, { sessionID: "root" }));
    if (self) assert.equal(planned.task.subagent_type, "dog-worker-v010", "single call returns the actual configured Worker");
    const dispatch = async (task: Record<string, unknown>, id: "first" | "second", callID: string, content: string) => {
      const output = { args: structuredClone(task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID }, output);
      const childMessage = {
        message: { id: `${id}-request`, agent: agents[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-luna-fast" } },
        parts: [{ type: "text", text: String(output.args.prompt) }],
      };
      await hooks["chat.message"]!({ sessionID: id, messageID: `${id}-request`, agent: agents[id]!.agent }, childMessage);
      if (id === "second") assert.match(childMessage.parts[0]!.text,
        /normal_remediation_prior_validation: \{"command":\["node check.mjs"\],"exit_code":1\}/u,
      "the second Worker receives the actual failed command/exit instead of rediscovering it");
      const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: id, callID: `${callID}-handoff` }, { args: { filePath: unit.handoffPath } });
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: id, callID: `${callID}-handoff`, args: { filePath: unit.handoffPath } },
        { output: await readFile(unit.handoffPath, "utf8") });
      const bound = JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute(
        { project_root: directory, manifest_path: unit.manifestPath }, { sessionID: id }));
      assert.equal(bound.status, "bound", JSON.stringify(bound));
      await writeFile(join(directory, "result.txt"), content);
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: id, callID: `${callID}-check` }, { args: { command: "node check.mjs" } });
      let exit = 0;
      try { await exec(process.execPath, ["check.mjs"], { cwd: directory }); } catch { exit = 1; }
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: id, callID: `${callID}-check` },
        { output: exit ? "FAIL" : "PASS", metadata: { exit, status: exit ? "error" : "completed" } });
      if (id === "first") {
        await assert.rejects(hooks.tool!.sortie_v010_start_direct_unit.execute({}, { sessionID: "root" }),
          /operator-direct-unit-unavailable/u, "direct execution cannot take over a still-running Worker");
        await assert.rejects(hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" },
          { sessionID: "root" }), /operator-mission-normal-remediation-unavailable/u,
        "an in-flight Worker cannot be replaced even after its shell check returns");
      }
      agents[id]!.outcome = "succeeded";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID },
        { output: `Worker ${id} returned`, metadata: { sessionId: id } });
      return exit;
    };
    assert.equal(await dispatch(planned.task, "first", "first-call", "broken\n"), 1);
    const failed = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(failed.coordinator_session_id, null);
    assert.equal(failed.units[0].status, "failed");
    assert.match(failed.next_action, /retry_mission_unit/u);
    assert.equal(failed.attempts[0].failure.category, "implementation");
    agents.first!.outcome = "running";
    const notTerminal = JSON.parse(await hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: "root" }));
    assert.equal(notTerminal.status, "non_rescue");
    assert.equal(notTerminal.reason, "terminal_not_reconciled", "a non-terminal native child cannot be replaced");
    agents.first!.outcome = "succeeded";
    agents["historical-child"] = { agent: "dog-worker-v010", parentID: "first", outcome: "interrupted" };
    await assert.rejects(hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"], traces: ["check passed"] },
      { sessionID: "root" }), /mission-review-awaits-unit-validation/u);
    // Operator may make a tiny correction directly, but its edit is not validation evidence.
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "root", callID: "root-fix" },
      { args: { filePath: join(directory, "result.txt"), content: "fixed\n" } });
    await writeFile(join(directory, "result.txt"), "fixed\n");
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "root", callID: "root-fix" }, { output: "fixed" });
    const retry = JSON.parse(await hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: "root" }));
    assert.equal(retry.status, "normal_remediation_prepared", JSON.stringify(retry));
    if (self) {
      const direct = JSON.parse(await hooks.tool!.sortie_v010_start_direct_unit.execute({}, { sessionID: "root" }));
      assert.equal(direct.status, "direct-unit-running");
      const started = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "root", callID: "direct-check" }, { args: { command: "node check.mjs" } });
      await exec(process.execPath, ["check.mjs"], { cwd: directory });
      rootHistory.push({ info: { id: "root-validation", role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "bash", callID: "direct-check",
        state: { status: "completed", input: { command: "node check.mjs" }, metadata: { exit: 0 }, time: { start: started, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "root", callID: "direct-check" }, { output: "PASS", metadata: { exit: 0, status: "completed" } });
      await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: "root" });
    } else assert.equal(await dispatch(retry.task, "second", "second-call", "fixed\n"), 0);
    const run = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(run.phase, "awaiting-acceptance");
    assert.equal(mission.id, started.mission_id);
    assert.equal(mission.coordinator, null);
    assert.deepEqual(mission.attempts?.map(attempt => attempt.kind), ["implementation", self ? "direct_execution" : "normal_remediation"]);
    await writeFile(join(directory, "result.txt"), "changed after validation\n");
    const stale = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(stale.completion.ready, false);
    assert.match(stale.next_action, /Fast-lane: source or candidate changed after formal validation/u);
    await assert.rejects(hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      traces: ["Old check exited 0"] }, { sessionID: "root" }), /mission-review-awaits-current-validation/u,
    "a new Review may not bless an Operator edit against stale Worker validation");
    await writeFile(join(directory, "result.txt"), "fixed\n");
    const preparedReview = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      traces: ["check.mjs exited 0 after the correction"], evidence: [{ path: "review-notes.txt", offset: 1, limit: 1 }] },
    { sessionID: "root" }));
    await writeFile(join(directory, "result.txt"), "changed after Review preparation\n");
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "stale-review-call" },
      { args: structuredClone(preparedReview.task) }), /mission-review-awaits-current-validation/u,
    "a prepared Reviewer Task must not launch against source changed after its evidence was captured");
    await writeFile(join(directory, "result.txt"), "fixed\n");
    await writeFile(join(directory, "review-notes.txt"), "Changed review context\n");
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "stale-evidence-call" },
      { args: structuredClone(preparedReview.task) }), /mission-review-snapshot-stale/u,
    "changed review-only evidence must not be dispatched with an old Reviewer snapshot");
    await writeFile(join(directory, "review-notes.txt"), "Original review context\n");
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      traces: ["check.mjs exited 0 after the correction"], evidence: [{ path: "review-notes.txt", offset: 1, limit: 1 }] },
    { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "review-call" },
      { args: structuredClone(review.task) });
    agents.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "review-call" },
      { output: "PASS\nThe corrected result and check agree.", metadata: { sessionId: "reviewer" } });
    const completed = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    const final = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(final.review.verdict, "PASS");
    assert.equal(final.execution_summary.historical_failed_attempts, 1);
    assert.equal(final.budget.consumed_units, 2, "both execution units count against the same cumulative budget");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Fast-lane Reviewer FINDINGS use the SAME author correction and native self-recheck, never ordinary Worker retry", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-fast-findings-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "check.mjs"),
      'import { readFileSync } from "node:fs";\nif (!/^(ready|fixed)\\n$/.test(readFileSync("result.txt", "utf8"))) process.exit(1);\n');
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, worker1: { agent: "dog-worker-v010", parentID: "root" },
      reviewer1: { agent: "dog-reviewer-v010", parentID: "root" },
    };
    const history: Record<string, Record<string, unknown>[]> = { worker1: [], reviewer1: [] };
    const create = () => SortieDogsV010Plugin({ directory, reviewerCorrectionPermissions: true, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }), abort: async () => ({ data: true }),
    } } } as never);
    let hooks = await create();
    await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: agents.root!.agent }, {
      message: { id: "request", agent: agents.root!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text: "Make result.txt fixed, then review the actual code." }],
    });
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Result.txt must be fixed"] }, { sessionID: "root" }));
    const plan = (objective: string, reason?: string) => hooks.tool!.sortie_v010_plan_units.execute({
      units: [{ title: "Fix result", objective, read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }],
      ...(reason ? { reason } : {}),
    }, { sessionID: "root" });
    const perform = async (task: Record<string, unknown>, id: "worker1" | "reviewer1", value: string) => {
      const callID = id === "worker1" ? "worker1" : "correction-call";
      delete agents[id]!.outcome;
      const output = { args: structuredClone(task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID }, output);
      await hooks["chat.message"]!({ sessionID: id, messageID: `${id}-request`, agent: agents[id]!.agent }, {
         message: { id: `${id}-request`, agent: agents[id]!.agent, model: { providerID: "openai", modelID: id === "worker1" ? "gpt-6-luna-fast" : "gpt-6.1-sol" } },
        parts: [{ type: "text", text: String(output.args.prompt) }],
      });
      const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: id, callID: `${id}-handoff` }, { args: { filePath: unit.handoffPath } });
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: id, callID: `${id}-handoff`, args: { filePath: unit.handoffPath } },
        { output: await readFile(unit.handoffPath, "utf8") });
      const bound = JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute(
        { project_root: directory, manifest_path: unit.manifestPath }, { sessionID: id }));
      assert.equal(bound.status, "bound", JSON.stringify(bound));
      await writeFile(join(directory, "result.txt"), value);
      const started = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: id, callID: `${id}-check` }, { args: { command: "node check.mjs" } });
      await exec(process.execPath, ["check.mjs"], { cwd: directory });
      history[id]!.push({ info: { id: `${id}-validation`, role: "assistant", sessionID: id }, parts: [{ type: "tool", tool: "bash", callID: `${id}-check`,
        state: { status: "completed", input: { command: "node check.mjs" }, metadata: { exit: 0 }, time: { start: started, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: id, callID: `${id}-check` },
        { output: "PASS", metadata: { exit: 0, status: "completed" } });
      agents[id]!.outcome = "succeeded";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID },
        { output: id === "worker1" ? "Validated result" : "CORRECTION_READY\nFixed result and passed the inherited check.", metadata: { sessionId: id } });
    };
    const review = async (selfRecheck = false) => {
      const id = "reviewer1", callID = selfRecheck ? "self-recheck-call" : "review-call";
      const request = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
        traces: [selfRecheck ? "fixed value present; check passed" : "check passed, but requested fixed value is missing"] },
        { sessionID: "root" }));
      if (selfRecheck) {
        assert.equal(request.status, "self-recheck-required"); assert.equal(request.task.task_id, id);
        const pending = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        assert.equal(pending.coordinator, null);
        assert.match(pending.review?.task?.prompt ?? "", /^review_phase: verification$/mu);
        assert.ok(pending.review?.initialPrompt, "the first independent Review remains durable");
        hooks = await create(); // A fresh plugin/turn must admit the exact pending verification Task.
      }
      delete agents[id]!.outcome;
      const dispatch = { args: structuredClone(request.task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID }, dispatch);
      const promptID = `${callID}-prompt`;
      await hooks["chat.message"]!({ sessionID: id, messageID: promptID, agent: agents[id]!.agent }, {
        message: { id: promptID, agent: agents[id]!.agent, model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
        parts: [{ type: "text", text: String(dispatch.args.prompt) }],
      });
      history[id]!.push({ info: { id: promptID, role: "user", sessionID: id }, parts: [{ type: "text", text: dispatch.args.prompt }] });
      const candidate = (await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).review!.source;
      const text = selfRecheck ? `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate, unresolved_findings: [], residual_major: null })}\nCompared original fixed requirement, retained finding and correction with the actual inherited check.`
        : "FINDINGS\nMedium: result is ready, not the required fixed value; correct result.txt.";
      agents[id]!.outcome = "succeeded";
      history[id]!.push({ info: { id: `${callID}-terminal`, role: "assistant", sessionID: id, finish: "stop",
        time: { created: Date.now(), completed: Date.now() } }, parts: [{ type: "text", text }] });
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID }, { output: text, metadata: { sessionId: id } });
    };
    const first = JSON.parse(await plan("Create result.txt and check it"));
    await perform(first.task, "worker1", "ready\n");
    await review();
    const findings = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(findings.review.verdict, "findings");
    assert.match(findings.next_action, /repair_review.*SAME original Reviewer/u);
    await assert.rejects(hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: "root" }),
      /operator-mission-normal-remediation-unavailable/u);
    await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review/);
    const correction = JSON.parse(await hooks.tool!.sortie_v010_repair_review.execute({}, { sessionID: "root" }));
    assert.ok(correction.task, JSON.stringify(correction));
    assert.equal(correction.task.task_id, "reviewer1");
    assert.equal(correction.task.subagent_type, "dog-reviewer-v010");
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).review?.verdict,
      "findings", "old FINDINGS cannot become PASS when preparing correction");
    await perform(correction.task, "reviewer1", "fixed\n");
    await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review/);
    await review(true);
    const completed = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.equal(mission.id, started.mission_id);
    assert.equal(mission.coordinator, null);
    assert.equal(mission.review?.child, "reviewer1");
    assert.equal(mission.review?.verdict, "self-rechecked");
    assert.equal(mission.review?.mode, "self-recheck");
    assert.equal(mission.attempts?.length, 2);
    assert.equal(mission.attempts?.[1]?.kind, "reviewer_correction", "FINDINGS retains original Reviewer correction ownership");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
