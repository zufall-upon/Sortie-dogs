import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { missionOperatorContent } from "../dist/runtime-mission-assets.js";
import { CONTRACT_TEXT_LIMITS, MISSION_OBJECTIVE_LIMITS } from "../dist/core/contract-limits.js";
import { nativeContractReadView } from "../dist/plugin/native-contract-read.js";

const exec = promisify(execFile);

for (const verdict of ["PASS", "FINDINGS", "EVIDENCE_GAPS"] as const) test(`Fast-first ${verdict}: one direct Worker and an independent Reviewer`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-fast-review-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    if (verdict === 'PASS') {
      await exec('git', ['config', 'user.name', 'Fixture'], { cwd: directory });
      await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: directory });
    }
    await writeFile(join(directory, "check.mjs"),
      'import { readFileSync } from "node:fs";\nif (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n');
    await writeFile(join(directory, "public-contract.md"), "Public output is ready followed by a newline.\n");
    if (verdict === "PASS") await writeFile(join(directory, "build.mjs"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("result.txt", "ready\\n");\n');
    const history: Record<string, Record<string, unknown>[]> = { worker: [] };
    let workerHistoryReads = 0;
    let backgroundChild: string | undefined;
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
      reviewer: { agent: "dog-reviewer-v010", parentID: "root" },
    };
    const hooks = await SortieDogsV010Plugin({ directory, reviewerCorrectionPermissions: true,
      nativeBackground: { awaiting: async (id: string) => backgroundChild !== undefined && (id === "root" || id === backgroundChild) }, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async ({ path }: { path: { id: string } }) => {
        if (path.id === "worker") workerHistoryReads++;
        return { data: history[path.id] ?? [] };
      }, abort: async () => ({ data: true }),
    } } } as never);
    assert.match(hooks.tool!.sortie_v010_start_mission.description, /dispatch its Worker directly/u);
    for (const name of ['sortie_v010_start_mission', 'sortie_v010_plan_units']) {
      assert.match(hooks.tool![name]!.description, /meaningful formal check known from user, project or task context/u);
      assert.match(hooks.tool![name]!.description, /do not require \.git\/\*\* scope/u);
      assert.match(hooks.tool![name]!.description, /requested commit before independent Review/u);
    }
    const prohibitionDescription = (hooks.tool!.sortie_v010_start_mission.args.prohibited_write as { description: string }).description;
    assert.match(prohibitionDescription, /user or applicable instructions/u);
    assert.match(prohibitionDescription, /Never infer a parent glob/u);
    assert.match(prohibitionDescription, /Preserve the authorized clone and exact prohibited paths/u);
    assert.doesNotMatch(hooks.tool!.sortie_v010_start_mission.description, /Dispatch the Coordinator immediately/u);
    assert.match(missionOperatorContent(V010_RUNTIME_PROFILE, "test"),
      /full original request natively from its handoff/u);
    assert.match(hooks.tool!.sortie_v010_plan_units.description,
      /full original request\/public reproduction is supplied separately/u);
    assert.match(missionOperatorContent(V010_RUNTIME_PROFILE, "test"),
      /Do not list speculative write paths or unrelated test suites as a precaution/u);
    assert.match(hooks.tool!.sortie_v010_plan_units.description, /estimated read\/write scope/u);
    assert.match(missionOperatorContent(V010_RUNTIME_PROFILE, "test"), /EVIDENCE_GAPS is advisory/u);
    const original = `Create result.txt with ready, validate and review it.${verdict === 'PASS' ? ' Commit the result in this authorized clone; do not modify the upstream product.' : ''} Do not write forbidden.txt.`;
    await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: agents.root!.agent }, {
      message: { id: "request", agent: agents.root!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text: original }],
    });
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Create validated result.txt", "Do not write forbidden.txt"], prohibited_write: ["forbidden.txt"] },
      { sessionID: "root" }));
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required('root');
    assert.equal(mission.requests[0]!.text, original, 'request without a literal check command remains exact');
    assert.deepEqual(mission.prohibitedWrite, ['forbidden.txt'], 'semantic product restriction does not become an inferred parent prohibition');
    await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: 'Forbidden write',
      objective: 'Write forbidden file', read: ['check.mjs'], write: ['forbidden.txt'], validation: ['node check.mjs'] }] },
      { sessionID: 'root' }), /mission-explicit-write-prohibition/);
    await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: 'Empty check',
      objective: 'Write result', read: ['check.mjs'], write: ['result.txt'], validation: [] }] },
      { sessionID: 'root' }), /validation must contain exact commands/);
    assert.match(started.next_action, /Default to plan_units/);
    const open = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.match(open.next_action, /Fast-lane.*plan one useful Worker/);
    assert.ok(open.task, "the same Coordinator reference remains available when the contract is not one unit");
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Write ready result",
      objective: "Create result.txt with ready followed by newline", read: verdict === "PASS" ? ["."] : ["check.mjs"],
      write: ["result.txt"], validation: [...(verdict === "PASS" ? ["node build.mjs"] : []), "node check.mjs"] }] }, { sessionID: "root" }));
    const worker = { args: structuredClone(planned.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, worker);
    await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-request", agent: agents.worker!.agent }, {
      message: { id: "worker-request", agent: agents.worker!.agent, model: { providerID: "openai", modelID: "gpt-6-luna-fast" } },
      parts: [{ type: "text", text: worker.args.prompt }],
    });
    const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
    if (verdict === "PASS") {
      assert.deepEqual(unit.unit.read, [`${directory.replaceAll("\\", "/")}/**`]);
      assert.deepEqual(unit.unit.write, ["result.txt"], "root observation must not expand write scope");
    }
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } },
      { output: await readFile(unit.handoffPath, "utf8") });
    await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: directory, manifest_path: unit.manifestPath },
      { sessionID: "worker" });
    if (verdict === "PASS") {
      backgroundChild = "worker";
      const acknowledgement = { output: "Native Job started", metadata: { sessionID: "worker", status: "running" } };
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, acknowledgement);
      assert.equal(acknowledgement.output, "Native Job started", "running tool return remains the native acknowledgement");
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
      const pending = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
      assert.equal(pending.units[0].status, "running");
      assert.equal(pending.budget.reserved_units, 1, "root idle retains the admitted unit reservation");
      assert.deepEqual((hooks.backgroundOwner!("worker-call")!.core as { calls: string[] }).calls, ["worker-call"], "idle preserves terminal settlement ownership");
      await hooks["chat.message"]!({ sessionID: "root", messageID: "scope-change", agent: "dog-operator" }, {
        message: { id: "scope-change", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-sol" } },
        parts: [{ type: "text", text: "Also create another output." }],
      });
      const change = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ intent: "continue",
        requirements: ["Create validated result.txt", "Do not write forbidden.txt", "Create another output"] }, { sessionID: "root" }));
      assert.equal(change.status, "mission-contract-change-requires-replace");
      assert.match(change.next_action, /intent=replace/);
      assert.deepEqual((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).requests.map(item => item.id), ["request"], "frozen contract cannot adopt free text as a changed requirement");
    }
    if (verdict === "PASS") {
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "build" },
        { args: { command: "node build.mjs" } });
      await exec(process.execPath, ["build.mjs"], { cwd: directory });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "build" },
        { output: "built", metadata: { exit: 0, status: "completed" } });
      history.worker!.push({ info: { role: "assistant", sessionID: "worker" }, parts: [{ type: "tool", tool: "bash",
        state: { status: "completed", input: { command: "node build.mjs" }, metadata: { exit: 0 } },
        time: { ran: 1000, completed: 1100 } }] });
    } else await writeFile(join(directory, "result.txt"), "ready\n");
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validation" },
      { args: { command: "node check.mjs" } });
    await exec(process.execPath, ["check.mjs"], { cwd: directory });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validation" },
      { output: "PASS", metadata: { exit: 0, status: "completed" } });
    if (verdict === "PASS") history.worker!.push({ info: { role: "assistant", sessionID: "worker" }, parts: [{ type: "tool", tool: "bash",
      state: { status: "completed", input: { command: "node check.mjs" }, metadata: { exit: 0 } },
      time: { ran: 1200, completed: 1300 } }] });
    if (verdict === 'PASS') {
      // Ordinary requested delivery stays in the validated Worker, with no .git/** write scope or prior Review.
      for (const [callID, command, argv] of [
        ['git-add', 'git add -- result.txt', ['add', '--', 'result.txt']],
        ['git-commit', 'git commit -m "Create result"', ['commit', '-m', 'Create result']],
      ] as const) {
        await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 'worker', callID }, { args: { command } });
        const result = await exec('git', [...argv], { cwd: directory });
        await hooks['tool.execute.after']!({ tool: 'bash', sessionID: 'worker', callID },
          { output: result.stdout, metadata: { exit: 0, status: 'completed' } });
      }
      assert.match((await exec('git', ['log', '-1', '--format=%s'], { cwd: directory })).stdout, /Create result/);
      assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required('root')).review, undefined);
    }
    agents.worker!.outcome = "succeeded";
    if (verdict === "PASS") assert.deepEqual((hooks.backgroundOwner!("worker-call")!.core as { calls: string[] }).calls, ["worker-call"], "validation retains parent Task ownership");
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
      { output: "Validated result", metadata: { sessionId: "worker" } });
    backgroundChild = undefined;
    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(status.coordinator_session_id, null);
    assert.equal(status.units[0].status, "succeeded", JSON.stringify(status));
    assert.equal(status.task, undefined, "a successful Fast unit must not prompt a Coordinator dispatch");
    assert.match(status.next_action, /Fast-lane.*review_mission/);
    const historyReadsBeforeReview = workerHistoryReads;
    const storedEvidence = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units.map(unit => unit.evidence);
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      ...(verdict === "EVIDENCE_GAPS" ? {} : { traces: ["R1: result.txt has ready newline; node check.mjs exited 0"] }) }, { sessionID: "root" }));
    const reviewPrompt = (await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).review?.task?.prompt ?? "";
    const reviewValidation = JSON.parse(reviewPrompt.split("\n").find(line => line.startsWith("validation: "))!.slice("validation: ".length));
    for (const [index, unit] of reviewValidation.entries()) {
      assert.equal(unit.details_ref.path, new OperatorRuntime(directory, V010_RUNTIME_PROFILE).statePath("root"));
      assert.deepEqual(unit.evidence.map(({ protected_binding_ref, ...evidence }: Record<string, unknown>) => evidence),
        storedEvidence[index]!.map(({ protected_binding, ...evidence }) => evidence), "all execution/coverage/identity facts remain visible");
      assert.ok(unit.evidence.every((evidence: Record<string, unknown>) => !Object.hasOwn(evidence, "protected_binding")));
    }
    assert.deepEqual((await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units.map(unit => unit.evidence),
      storedEvidence, "display projection must not change authoritative validation evidence");
    assert.match(reviewPrompt, /Report FINDINGS only for concrete major or medium defects with a material impact/u);
    assert.match(reviewPrompt, /Do not turn minor style, wording, optional improvements or speculative edge cases into FINDINGS or EVIDENCE_GAPS/u);
    if (verdict === "PASS") {
      const native = JSON.parse(/^observed_validation: (.+)$/mu.exec(reviewPrompt)?.[1] ?? "null");
      assert.ok(native, "the stored native Reviewer prompt must include the build/test observation");
      assert.deepEqual(native?.[0]?.attempts?.map((item: { command: string; exit_code: number; started_ms: number }) =>
        [item.command, item.exit_code, item.started_ms]), [["node build.mjs", 0, 1000], ["node check.mjs", 0, 1200]],
        "the Reviewer sees the native build→test order");
      const accepted = JSON.parse(/^validation: (.+)$/mu.exec(reviewPrompt)?.[1] ?? "null");
      assert.ok(accepted?.[0]?.evidence?.length > 0);
      assert.ok(accepted[0].evidence.every((item: { execution: { command: string[] } }) =>
        item.execution.command[0] === "node check.mjs"), "the build observation is not acceptance evidence");
      assert.equal(workerHistoryReads - historyReadsBeforeReview, 1, "one native history read, no second check or Reviewer turn");
    }
    const pending = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(pending.task, undefined);
    assert.match(pending.next_action, /Fast-lane.*Reviewer Task/);
    const reviewer = { args: structuredClone(review.task) };
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "altered-review" },
      { args: { ...reviewer.args, prompt: reviewer.args.prompt + "\nchanged" } }), /mission-review-task-required/);
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "review-call" }, reviewer);
    await hooks["chat.message"]!({ sessionID: "reviewer", messageID: "reviewer-request", agent: agents.reviewer!.agent }, {
      message: { id: "reviewer-request", agent: agents.reviewer!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text: reviewer.args.prompt }],
    });
    if (verdict === "PASS") {
      backgroundChild = "reviewer";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "review-call" },
        { output: "Native Reviewer Job started", metadata: { sessionID: "reviewer", status: "running" } });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
      assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).review!.verdict, "pending");
    }
    for (const [tool, args] of [["read", { filePath: "public-contract.md" }], ["grep", { pattern: "ready" }], ["glob", { pattern: "*.mjs" }]] as const) {
      await hooks["tool.execute.before"]!({ tool, sessionID: "reviewer", callID: `review-${tool}` }, { args: { ...args } });
    }
    agents.reviewer!.outcome = "succeeded";
    history.reviewer = [{ info: { id: "reviewer-terminal", sessionID: "reviewer", role: "assistant", agent: agents.reviewer!.agent,
      finish: "stop", time: { created: Date.now(), completed: Date.now() } },
      parts: [{ type: "text", text: `${verdict}\n${verdict === "FINDINGS" ? "Medium: retained output violates a required consumer behavior; correct result.txt." : "Reviewed actual result and validation."}` }] }];
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "review-call" },
      { output: `${verdict}\nReviewed actual result and validation.`, metadata: { sessionId: "reviewer" } });
    backgroundChild = undefined;
    const reviewed = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(reviewed.review.verdict, verdict === "PASS" ? "PASS" : verdict === "EVIDENCE_GAPS" ? "evidence-gaps" : "findings");
    assert.equal(reviewed.review.reviewer_session_id, "reviewer");
    assert.equal(reviewed.coordinator_session_id, null);
    if (verdict === "FINDINGS") {
      await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review-required-or-stale/);
      assert.equal(reviewed.task, undefined, "FINDINGS do not dispatch a Coordinator/fresh Worker repair workaround");
      assert.match(reviewed.next_action, /Fast-lane: known Major\/Medium findings.*repair_review.*SAME original Reviewer's/);
      assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "ready\n", "Fast work survives escalation");
      const correction = JSON.parse(await hooks.tool!.sortie_v010_repair_review.execute({}, { sessionID: "root" }));
      assert.ok(correction.task);
      assert.equal(correction.task.task_id, "reviewer");
      assert.equal(correction.task.subagent_type, "dog-reviewer-v010");
      const correctedRun = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.deepEqual(correctedRun.units[0]!.unit.validation, ["node check.mjs"]);
      assert.equal(correctedRun.units[0]!.reviewerCorrection!.author, "reviewer");
      const escalated = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(escalated.id, started.mission_id);
      assert.equal(escalated.coordinator, null);
      assert.equal(escalated.review?.verdict, "findings", "correction preparation cannot turn FINDINGS into PASS");
      await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /correction-validation-missing/);
      return;
    }
    assert.equal(reviewed.task, undefined);
    assert.match(reviewed.next_action, /Fast-lane.*complete_mission/);
    if (verdict === "EVIDENCE_GAPS") {
      assert.equal(reviewed.review.evidence_gap_reviews, 1);
      assert.equal(reviewed.review.passed, false);
      assert.equal(reviewed.review.permits_submission, true);
      const repeated = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
        traces: ["Rewritten explanation of the same ready result"] }, { sessionID: "root" }));
      assert.equal(repeated.status, "review-recorded");
      assert.equal(repeated.task, undefined, "prose changes must not purchase another review of the same candidate");
    }
    const completed = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).coordinator, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const length of [2000, 2001, 3000, 3001, 32768]) test(`known-check direct dispatch: new objective ${length}, no Operator source/shell preparation`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-fast-objective-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory }); // Fixture setup, not Operator investigation.
    await writeFile(join(directory, "check.mjs"), 'if (!process.env.PATH) process.exit(1);\n');
    const original = "Use node check.mjs as formal validation. " + "Public context. ".repeat(500) +
      "\nExact late requirement: errors contain type error and <nil>. Do not publish or widen the budget.  ";
    const objective = "x".repeat(length);
    const agents = { root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" } };
    const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: keyof typeof agents } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      messages: async () => ({ data: [] }), children: async () => ({ data: [] }),
    } } } as never);
    const operatorCalls: string[] = [];
    await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: agents.root.agent }, {
      message: { id: "request", agent: agents.root.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text: original }],
    });
    operatorCalls.push("start_mission");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Implement exact public contract", "Validate without publishing"] }, { sessionID: "root" }));
    operatorCalls.push("plan_units");
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Implement public contract",
      objective, read: ["check.mjs"], write: ["src"], validation: ["node check.mjs"] }] }, { sessionID: "root" }));
    operatorCalls.push("task");
    const task = { args: structuredClone(planned.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, task);
    const runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const state = await runtime.required("root");
    assert.equal(state.units[0]!.status, "running", "real native Task admission does not require Operator source/shell calls");
    assert.deepEqual(operatorCalls, ["start_mission", "plan_units", "task"]);
    assert.equal(state.units[0]!.childSessionID, null, "Worker has not inspected source or bound a manifest yet");
    assert.equal(started.mission_id, (await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).id);
    await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-request", agent: agents.worker.agent }, {
      message: { id: "worker-request", agent: agents.worker.agent, model: { providerID: "openai", modelID: "gpt-6-luna-fast" } },
      parts: [{ type: "text", text: task.args.prompt }],
    });
    const unit = (await runtime.required("root")).units[0]!;
    const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
    assert.equal(MISSION_OBJECTIVE_LIMITS.target, 2000);
    assert.equal(MISSION_OBJECTIVE_LIMITS.maximum, 3000);
    assert.ok(Array.from(handoff.task.objective).length <= 3000);
    if (length <= 3000) assert.equal(handoff.task.objective, objective, "2000 is guidance, not a refusal boundary");
    else assert.equal(handoff.ext["sortie-dogs/mission-context"].unit_instruction, objective, "overflow is retained verbatim, without repair/reapproval");
    assert.equal(handoff.ext["sortie-dogs/mission-context"].original_requests[0].text, original);
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    const nativeRead = { output: await readFile(unit.handoffPath, "utf8") };
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } }, nativeRead);
    // V2's native Read uses this projection (the V2 hook regression below verifies its invocation).
    const nativeView = await nativeContractReadView(directory, { path: unit.handoffPath });
    assert.ok(nativeView?.includes(original), "native Worker sees the entire original, including late exact error/prohibition clauses");
    if (length > 3000) assert.ok(nativeView?.includes(objective), "native view also retains the full overflow instruction");
    assert.equal((await runtime.required("root")).receipt, null, "admission/contract display is not success");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy 32768-character objective retains exact saved handoff and Task identities on cold resume", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-legacy-objective-"));
  try {
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "legacy-request", text: "Original legacy request" });
    const mission = await missions.start("root", ["Preserve legacy work"]);
    const objective = "L".repeat(32768);
    const runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    // Saved pre-native-context Missions did not pass the separately retained original request.
    const state = await runtime.prepareMission("root", missionPlan(mission, [{ title: "Legacy unit", objective,
      read: [], write: ["src"], validation: ["node check.mjs"] }]));
    const handoff = await readFile(state.units[0]!.handoffPath, "utf8");
    assert.equal(CONTRACT_TEXT_LIMITS.objective, 32768);
    assert.equal(JSON.parse(handoff).task.objective, objective);
    const cold = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const resumed = await cold.required("root");
    assert.equal(resumed.units[0]!.unit.objective, objective);
    assert.deepEqual(resumed.units[0]!.hashes, state.units[0]!.hashes);
    const next = await cold.next("root", "root") as { task: { prompt: string } };
    assert.match(next.task.prompt, /^SORTIE_OPERATOR_TASK_REF /u);
    await cold.admitWorker("root", "root", "legacy-call", next.task as never);
    const restarted = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const claimed = await restarted.claimAdmittedWorkerPrompt("root", "root", "worker", next.task.prompt);
    assert.equal(claimed.prompt, state.units[0]!.task.prompt, "the opaque dispatch expands to the exact saved legacy Task");
    assert.equal(await readFile(state.units[0]!.handoffPath, "utf8"), handoff, "resume never regenerates/clips legacy objective");
    assert.deepEqual((await restarted.required("root")).units[0]!.hashes, state.units[0]!.hashes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("oversized objective copied from the original request references that exact text without a second full copy", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-objective-original-"));
  try {
    const original = "Full original request. ".repeat(200) + "\nLate exact constraint: type error and <nil>.  ";
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "request", text: original });
    const mission = await missions.start("root", ["Preserve the original request"]);
    const runtime = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    const state = await runtime.prepareMission("root", missionPlan(mission, [{ title: "Implement", objective: original,
      read: [], write: ["src"], validation: ["node check.mjs"] }]), undefined, undefined, [], false,
      { original_requests: mission.requests, requirements: mission.requirements });
    const handoff = JSON.parse(await readFile(state.units[0]!.handoffPath, "utf8"));
    assert.ok(handoff.task.objective.length <= 3000);
    assert.equal(handoff.ext["sortie-dogs/mission-context"].original_requests[0].text, original);
    assert.equal(handoff.ext["sortie-dogs/mission-context"].unit_instruction, undefined);
    assert.doesNotMatch(handoff.task.objective, /full unit_instruction/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
