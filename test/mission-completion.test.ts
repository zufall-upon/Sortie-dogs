import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { missionExecutionStatus, OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE, profileAgent } from "../dist/core/runtime-profile.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

function assertStatusOrder(packet: Record<string, unknown>): void {
  const keys = Object.keys(packet), summary = keys.indexOf("acceptance_summary"), units = keys.indexOf("units");
  assert.equal(keys[0], "mission_id", "status leads with actionable identity, not bulky acceptance evidence");
  for (const key of ["status", "budget", "attempts", "next_action", "completion"]) {
    assert.ok(keys.indexOf(key) >= 0 && keys.indexOf(key) < summary, `${key} precedes acceptance evidence`);
  }
  assert.ok(summary >= 0 && units > summary, "acceptance summary still precedes the full authority packet");
}

for (const mode of ["implementation", "executed", "execution-failed", "fast-lane-failure", "registered-operation", "failed-result-validation", "NO_START", "legacy-background", "missing-foreground-exit", "missing-error-exit"] as const) test(`mission completion keeps checks, review and operation outcomes separate: ${mode}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-completion-"));
  const failure = ["execution-failed", "fast-lane-failure", "registered-operation", "failed-result-validation"].includes(mode);
  const fast = mode === "fast-lane-failure" || mode === "registered-operation";
  const dispatcher = fast ? "root" : "coordinator";
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.name", "test"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    const validator = 'import { readFileSync, writeFileSync } from "node:fs";\n' +
      (mode === "implementation" || failure ? '' : 'writeFileSync("result.txt", "ready\\n");\n') +
      'if (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n' +
      (failure ? `const operation = JSON.parse(readFileSync("operation.json", "utf8"));\nif (operation.attempts !== 1 || operation.exit !== ${mode === "failed-result-validation" ? 0 : 1}) process.exit(1);\n` : '') +
      `console.log(JSON.stringify(${JSON.stringify({ status: mode, attempts: mode === "NO_START" ? 0 : 1, reward: 0 })}));\n`;
    const reference = "Public result contract: ready followed by a newline.\n";
    await writeFile(join(root, "reference.md"), reference);
    await writeFile(join(root, "check.mjs"), validator);
    if (failure) await writeFile(join(root, "run.mjs"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("result.txt", "ready\\n");\n' +
      'const result = {status: "execution-failed", attempts: 1, reward: 0, exit: 1};\n' +
      'writeFileSync("operation.json", JSON.stringify(result));\nconsole.log(JSON.stringify(result));\nprocess.exitCode = 1;\n');
    await exec("git", ["add", "check.mjs"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "validator"], { cwd: root });
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: dispatcher }, reviewer: { agent: "dog-reviewer-v010", parentID: dispatcher },
    };
    let latestSession: Record<string, unknown>;
    const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: latestSession = {
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
    await chat("root", mode === "failed-result-validation" ? "Run successfully once and validate the successful outcome. Do not accept a failed operation."
      : failure ? "Run once and collect its result, even on failure. Do not retry or fix it. Validate collected evidence, then review and accept it."
      : "Write and validate a ready result, then review and accept it.");
    const plannedUnit = { title: "Validated result", objective: mode === "failed-result-validation" ? "Run once and validate successful exit; failure must remain unaccepted"
      : failure ? "Run once and validate collected result; do not retry or fix the failed operation" : "Write result and validate it",
      read: ["check.mjs", ".sortie-dogs-v010/missions", ...(failure ? ["run.mjs"] : [])], write: ["result.txt", ...(failure ? ["operation.json"] : [])], validation: ["node check.mjs"] };
    const execution = { commands: mode === "implementation" ? [] : [failure ? "node run.mjs" : "node check.mjs"], directory: root };
    const requirements = [mode === "failed-result-validation" ? "Run successfully and validate successful execution"
      : failure ? "Run once and collect its result" : "Create a validated result"];
    let started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements,
      kind: mode === "implementation" ? "implementation" : "operation", ...(fast ? { execution,
        ...(mode === "registered-operation" ? {} : { unit: plannedUnit }) } : {}) }, { sessionID: "root" }));
    if (mode === "registered-operation") {
      const registered = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.deepEqual(registered.execution, { ...execution, observations: [] }, "execution without a unit is retained, not silently discarded");
      const previous = started.mission_id;
      started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements, unit: plannedUnit }, { sessionID: "root" }));
      assert.equal(started.mission_id, previous, "a known unit reuses the already registered command in the same Mission");
    }
    const baseline = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewBaseline, baseline);
    if (!fast) {
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
      await chat("coordinator", started.task.prompt);
    } else assert.equal(started.task.subagent_type, profileAgent(V010_RUNTIME_PROFILE, "dog-worker"), "known operation and result check dispatch directly without a Coordinator");
    if (mode === "executed") await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ units: [{
      title: "Incomplete operation", objective: "Run the operation", write: ["result.txt"], validation: ["node check.mjs"],
    }], execution: { commands: [], directory: root } }, { sessionID: "coordinator" }), /mission-operation-input/);
    const next = fast ? started : JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [plannedUnit], execution }, { sessionID: dispatcher }));
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewBaseline, baseline);
    if (mode === "implementation") assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).kind, "implementation");
    assert.deepEqual((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewScope?.write,
      failure ? ["operation.json", "result.txt"] : ["result.txt"]);
    const worker = { args: structuredClone(next.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: dispatcher, callID: "worker-call" }, worker);
    await chat("worker", worker.args.prompt);
    const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE), state = await runtime.required("root");
    const unit = state.units[0]!;
    const clock = Date.now;
    try {
      if (mode === "executed") { const aged = clock() + 31 * 60_000; Date.now = () => aged; }
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } }, { output: "inspected" });
      const binding = JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: root, manifest_path: unit.manifestPath }, { sessionID: "worker" }));
      assert.equal(binding.status, "bound", JSON.stringify(binding));
    } finally { Date.now = clock; }
    if (mode === "legacy-background" || mode.startsWith("missing-")) {
      // V2 returns a completed tool call for a launched background shell, with no process exit.
      // This is the metadata captured by the real Anko run, not an operation result.
      await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "background-launch" },
        { args: { command: "node check.mjs", workdir: root } });
      await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "background-launch" },
        { output: "", ...(mode === "missing-error-exit" ? { status: "error" } : {}),
          metadata: mode === "legacy-background" ? { status: "running", shellID: "sh_anko" } : { status: mode === "missing-error-exit" ? "error" : "completed" } });
      const observed = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.equal(observed.execution?.observations[0]?.outcome, undefined, "without a process exit there is no successful/failed process outcome");
      if (mode === "legacy-background") assert.equal(observed.execution?.observations[0]?.completedAt, undefined,
        "a background launch must not be recorded as a terminal failure or success");
      assert.equal(observed.execution?.observations[0]?.status, mode === "legacy-background" ? "running" : mode === "missing-error-exit" ? "error" : "completed");
      const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "launched" },
        { sessionID: "coordinator" }));
      assert.equal(submitted.status, "operation-incomplete");
      assert.equal(submitted.operation.status, mode === "legacy-background" ? "running" : "not-started");
      if (mode === "legacy-background") assert.match(submitted.next_action, /do not (?:relaunch|start another)/iu);
      return;
    }
    if (mode === "implementation") await writeFile(join(root, "result.txt"), "ready\n");
    if (mode === "executed") {
      await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "background-operation" },
        { args: { command: "node check.mjs", workdir: root, background: true, timeout: 0 } }),
      /mission-operation-background: run the declared command in foreground/);
      for (const command of ["node check.mjs | tee result.txt", "node check.mjs > result.txt",
        "node check.mjs 2> result.txt", "node check.mjs && echo done",
        "$ErrorActionPreference='Stop'; node check.mjs; echo done",
        `& '${process.execPath}' '${join(root, "check.mjs")}' > result.txt`]) {
        await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: `decorated-${command}` },
          { args: { command } }), /mission-operation-command-not-observed: run the declared operation command exactly/);
      }
      assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).execution?.observations.length, 0,
        "a decorated operation is corrected before it starts, without a second Worker or plan");
      await assert.rejects(readFile(join(root, "result.txt"), "utf8"), { code: "ENOENT" });
    }
    if (failure) {
      await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "operation" },
        { args: { command: "node run.mjs", workdir: root } });
      const failed = await exec(process.execPath, ["run.mjs"], { cwd: root }).then(() => assert.fail("operation must fail"),
        error => error as { code: number; stdout: string });
      assert.equal(failed.code, 1);
      await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "operation" },
        { output: failed.stdout, metadata: { exit: failed.code, status: "completed" } });
    }
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, { args: { command: "node check.mjs" } });
    const checked = await exec(process.execPath, ["check.mjs"], { cwd: root }).catch(error => {
      if (mode !== "failed-result-validation") throw error;
      assert.equal(error.code, 1);
      return { stdout: error.stdout };
    });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validate" },
      { output: checked.stdout, metadata: { exit: mode === "failed-result-validation" ? 1 : 0, status: "completed" } });
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: dispatcher, callID: "worker-call" }, { output: "validated", metadata: { sessionId: "worker" } });
    if (mode === "failed-result-validation") {
      assert.notEqual((await runtime.required("root")).units[0]!.status, "succeeded", "a terminal operation result never bypasses failed formal validation");
      await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "collected failure" },
        { sessionID: dispatcher }), /mission-units-incomplete/u);
      await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review-required-or-stale/u);
      assert.equal((await runtime.required("root")).receipt, null);
      const mission = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.equal(mission.execution!.observations.length, 1);
      assert.equal(mission.execution!.observations[0]!.exit, 1);
      return;
    }
    const validatedUnits = structuredClone((await runtime.required("root")).units);
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      traces: ["check.mjs observed ready result, exit 0"], evidence: [{ path: "reference.md", offset: 1, limit: 1 }] }, { sessionID: dispatcher }));
    const reviewer = { args: structuredClone(review.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: dispatcher, callID: "reviewer-call" }, reviewer);
    assert.match(reviewer.args.prompt, /host observes this invocation's native outcome after your terminal/u);
    assert.match(reviewer.args.prompt, /final acceptance is separate.*authorized by the current user request/u);
    assert.match(reviewer.args.prompt, /result-and-hold checkpoint does not require it/u);
    assert.doesNotMatch(reviewer.args.prompt, /List those as deferred Operator checks/u);
    assert.match(reviewer.args.prompt, /Public result contract: ready followed by a newline/u);
    assert.deepEqual((await runtime.required("root")).units, validatedUnits,
      "attaching undeclared project context does not replan, rerun validation, or dispatch another Worker");
    identities.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: dispatcher, callID: "reviewer-call" }, { output: "PASS\nThe result is validated.", metadata: { sessionId: "reviewer" } });
    if (mode === "NO_START") {
      const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
      await missions.update("root", mission => { mission.review!.verdict = "evidence-gaps"; mission.review!.evidenceGapReviews = 1; });
      const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "auxiliary check passed" }, { sessionID: "coordinator" }));
      assert.equal(submitted.status, "operation-incomplete");
      const cold = await create();
      const completed = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
      assert.equal(completed.status, "not-ready");
      assert.equal(completed.operation_status, "not-started");
      assert.equal((await runtime.required("root")).receipt, null);
      return;
    }
    await writeFile(join(root, "reference.md"), reference + "changed after review\n");
    if (!fast) await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "ready" },
      { sessionID: dispatcher }), /mission-review-required-or-stale/);
    await writeFile(join(root, "reference.md"), reference);
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).coordinator, fast ? null : "coordinator");
    const submittedText = fast ? await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })
      : await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "Validated result, reviewed independently" }, { sessionID: dispatcher });
    assert.notEqual(JSON.parse(submittedText).status, "operation-incomplete", "a terminal failure can be submitted as a collected result");
    if (fast) assertStatusOrder(JSON.parse(submittedText));
    else assert.equal(Object.keys(JSON.parse(submittedText))[0], "acceptance_summary", "submission summary precedes the full authority packet");
    if (failure) {
      const submitted = JSON.parse(submittedText);
      if (fast) {
        assert.equal(submitted.task, undefined, "a collected failure must not trigger an unnecessary Coordinator redispatch");
        assert.match(submitted.next_action, /complete_mission/u);
      }
      const operation = submitted.acceptance_summary.operation;
      assert.equal(operation.status, "execution-failed");
      assert.equal(operation.terminal_complete, true);
      assert.equal(operation.process_succeeded, false);
      assert.equal(operation.observations[0].exit, 1);
    }
    if (!fast) {
      identities.coordinator!.outcome = "succeeded";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { output: "ready", metadata: { sessionId: "coordinator" } });
    }
    const cold = await create();
    const status = async () => JSON.parse(await cold.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal((await status()).completion.ready, true);
    assertStatusOrder(await status());
    if (mode === "implementation") {
      const emptyNative = (await status()).acceptance_summary.native_declared_validation[0];
      assert.equal(emptyNative.status, "recorded-formal-evidence");
      assert.ok(emptyNative.evidence_ids.length);
      for (const historyMode of ["missing", "error", "invalid"] as const) {
        // Root role is already observed in this live instance. Change only the summary reader's API
        // availability; a cold root with no recovery API is a different existing host contract.
        const normalMessages = latestSession!.messages;
        if (historyMode === "missing") delete latestSession!.messages;
        else latestSession!.messages = async () => historyMode === "error"
          ? { data: undefined, error: { message: "unavailable" } } : { data: {} };
        const observed = await status();
        latestSession!.messages = normalMessages;
        assert.equal(observed.completion.ready, true, "history display failure adds no acceptance gate");
        assert.deepEqual(observed.acceptance_summary.native_declared_validation[0], emptyNative,
          "settled proof does not depend on refetching native history for display");
      }
    }
    // The oracle is read-only and therefore outside the review diff. Completion must still name it.
    await writeFile(join(root, "check.mjs"), validator + "// changed after validation\n");
    const blocked = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(blocked.status, "awaiting-evidence");
    assert.equal(blocked.receipt, null);
    assert.equal(blocked.completion.blockers[0].reason, "source-changed");
    assert.ok(blocked.completion.blockers[0].source_paths.includes("check.mjs"));
    const stale = await status();
    assert.deepEqual(stale.completion, blocked.completion);
    if (fast) assert.ok(stale.next_action.endsWith(blocked.next_action), "Fast-lane adds its direct source-reconciliation guidance");
    else assert.equal(stale.next_action, blocked.next_action, "status must not blindly send the root back to the same refused completion");
    await writeFile(join(root, "check.mjs"), validator);
    if (mode === "implementation") {
      await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).update("root", mission => {
        mission.review!.verdict = "evidence-gaps";
        mission.review!.evidenceGapReviews = 1;
        mission.review!.result = "EVIDENCE_GAPS\nThe decisive return line is not visible.";
      });
    }
    const completed = JSON.parse(await cold.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal(completed.receipt.status, "succeeded");
    if (failure) {
      assert.equal(completed.operation.status, "execution-failed", "Mission receipt success is not operation success");
      assert.equal(completed.operation.process_succeeded, false);
      assert.equal(completed.operation.observations[0].exit, 1);
      assert.match(completed.return_report, /execution-failed/u);
      assert.match(completed.return_report, /process did not succeed/u);
      const visible = { text: "✅ **DONE** — collected operation result\n\n**次:** なし" };
      await cold["experimental.text.complete"]!({ sessionID: "root", messageID: "final-failure", partID: "final-text" }, visible);
      assert.match(visible.text, /execution-failed/u, "the final user-facing renderer must not imply operation success");
      assert.match(visible.text, /process did not succeed/u);
    }
    if (mode === "implementation") {
      assert.match(completed.review_evidence_gaps, /decisive return line is not visible/u);
      assert.match(completed.return_report, /SourceReview\s+🟡 補足あり（非ブロッキング・PASSではない）/u);
      assert.match(completed.return_report, /レビュー補足\s+The decisive return line is not visible/u);
      assert.match(completed.return_report, /➡️ NEXT\nなし/u);
      const visible = { text: `✅ **DONE** — validated result\n\n**次:** なし\n\n${completed.return_report}` };
      await cold["experimental.text.complete"]!({ sessionID: "root", messageID: "final", partID: "final-text" }, visible);
      assert.match(visible.text, /SourceReview\s+🟡 補足あり（非ブロッキング・PASSではない）/u,
        "the final user-facing renderer must retain the native Review verdict, not only the completion tool result");
      assert.match(visible.text, /レビュー補足\s+The decisive return line is not visible/u);
      assert.doesNotMatch(visible.text, /SourceReview\s+未記録/u);
      assert.match(visible.text, /\*\*次:\*\* なし/u);
    }
    if (mode === "executed") {
      const visible = { text: "✅ **DONE** — validated operation\n\n**次:** なし" };
      await cold["experimental.text.complete"]!({ sessionID: "root", messageID: "final-pass", partID: "final-text" }, visible);
      assert.match(visible.text, /SourceReview\s+🟢 PASS（独立Reviewer）/u);
      assert.doesNotMatch(visible.text, /EVIDENCE_GAPS/u);
    }
    const final = await status();
    assert.equal(final.phase, "completed");
    if (failure) {
      assert.equal(final.operation.status, "execution-failed");
      assert.equal(final.operation.observations.length, 1, "result collection never reruns the failed operation");
    }
    assert.match(final.next_action, /no further dispatch or completion/);
    const key = createHash("sha256").update("v010\0root").digest("hex");
    const ledger = await (await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`))).readGoal();
    assert.equal(ledger.state.consumed_units, 1);
    assert.equal(ledger.state.outstanding_reservations.length, 0);
    assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.admission").length, 1, "review and acceptance must not require a second successful check");
    assert.equal(await readFile(join(root, "result.txt"), "utf8"), "ready\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const recoveryMode of ["saved", "missing-exit", "missing-error-exit", "conflicting-terminals", "conflict-after-recovery",
  "older-after-failure", "older-after-running", "direct-before-admission", "direct-after-admission", "cancel-during-recovery", "complete-during-recovery"] as const)
test(`saved native operation calls recover through Mission APIs without replay or acceptance: ${recoveryMode}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-native-operation-recovery-"));
  const rootID = "ses_eea93a19dffdxZz9nRa10N2N3R", coordinator = "ses_ec815701fffeFp40d2WOjl6yU8";
  const worker = "ses_ec823140dffeGYr1ZirFUyDC6Z";
  const direct = recoveryMode.startsWith("direct-");
  const nativeOwner = direct ? coordinator : worker;
  const identities: Record<string, { agent: string; parentID?: string; outcome?: string; time?: { created: number } }> = {
    [rootID]: { agent: "dog-operator" },
    [coordinator]: { agent: "dogs-coordinator", parentID: rootID },
    [worker]: { agent: "dog-worker-v010", parentID: coordinator, outcome: "succeeded", time: { created: Date.now() - 10_000 } },
  };
  const history: Record<string, Record<string, unknown>[]> = {};
  let duringRecoveryRead: (() => Promise<void>) | undefined;
  const create = () => SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
    children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
      .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
    messages: async ({ path }: { path: { id: string } }) => {
      if (path.id === nativeOwner && duringRecoveryRead) {
        const transition = duringRecoveryRead; duringRecoveryRead = undefined;
        await transition();
      }
      return { data: history[path.id] ?? [] };
    }, abort: async () => ({ data: true }),
  } } } as never);
  let hooks: Awaited<ReturnType<typeof create>>;
  let turn = 0;
  const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user-${++turn}`, agent: identities[id]!.agent }, {
    message: { id: `${id}-user-${turn}`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
    parts: [{ type: "text", text }],
  });
  const tool = async (name: string, id: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: id }));
  const before = (id: string, callID: string, task: object) => hooks["tool.execute.before"]!({ tool: "task", sessionID: id, callID }, { args: structuredClone(task) });
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "check.mjs"), 'console.log("PASS");\n');
    hooks = await create();
    const declaredCommands = ["git pull --ff-only origin main", "node 'apply.mjs' 'plan.json'"];
    await chat(rootID, "Run the registered release operation once and report its result.");
    const started = await tool("start_mission", rootID, { requirements: ["Run the registered release operation once and report its result"],
      kind: "operation", execution: { commands: declaredCommands, directory: root } });
    await before(rootID, "coordinator-call", started.task);
    await chat(coordinator, started.task.prompt);
    const planned = await tool("plan_units", coordinator, { ...(direct ? { executor: "self" } : {}), units: [{ title: "Collect operation result", objective: "Record the run result",
      read: ["check.mjs"], write: ["result.json"], validation: ["node check.mjs"] }] });
    if (!direct) {
      await before(coordinator, "call_9bf3a49fc67c463f98b241ede95a5cbc", planned.task);
      await chat(worker, planned.task.prompt);
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: coordinator, callID: "call_9bf3a49fc67c463f98b241ede95a5cbc" },
        { output: "completed", metadata: { sessionId: worker } });
    }

    const nativePull = "$ErrorActionPreference='Stop'; git pull --ff-only origin main";
    const nativeApply = `$ErrorActionPreference='Stop'; & ${quote(process.execPath)} ${quote(join(root, "apply.mjs"))} ${quote(join(root, "plan.json"))}`;
    const start = Date.now() - (recoveryMode === "direct-before-admission" ? 4_000 : 0);
    history[nativeOwner] = [
      { info: { role: "assistant", sessionID: nativeOwner, time: { created: start } }, parts: [{ type: "tool", tool: "bash",
        callID: "call_7c9218e8ae644cec9bfd4125081d2d16", state: { status: "completed", input: { command: nativePull, workdir: root },
          output: "Already up to date.", metadata: { exit: 0, status: "completed" }, time: { start, end: start + 1_812 } } }] },
      { info: { role: "assistant", sessionID: nativeOwner, time: { created: start + 10 } }, parts: [{ type: "tool", tool: "bash",
        callID: "call_c2320cce5c63457eae3553a5ab6d1f1c", state: { status: "completed", input: { command: nativeApply, workdir: root },
          output: "applied-and-matched", metadata: { exit: 0, status: "completed" }, time: { start: start + 10, end: start + 11_378 } } }] },
      { info: { role: "assistant", sessionID: nativeOwner, time: { created: start + 20 } }, parts: [{ type: "tool", tool: "bash",
        callID: "call_foreign_owner", sessionID: "ses_other_worker", state: { status: "completed",
          input: { command: nativeApply, workdir: root }, output: "not-this-session", metadata: { exit: 0, status: "completed" },
          time: { start: start + 20, end: start + 21 } } }] },
    ];
    const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
    const beforeRecovery = await missions.required(rootID);
    assert.deepEqual(beforeRecovery.execution!.observations, [], "legacy state lacks the exact-match observations");
    assert.equal(missionExecutionStatus(beforeRecovery), "not-started");

    hooks = await create();
    if (recoveryMode === "cancel-during-recovery" || recoveryMode === "complete-during-recovery") {
      duringRecoveryRead = async () => {
        if (recoveryMode === "cancel-during-recovery") await tool("cancel_operator", rootID, { reason: "plain" });
        // Fault injection models the same phase write made by concurrent successful completion.
        else await missions.update(rootID, current => { current.phase = "completed"; });
      };
      await tool("operator_status", rootID);
      const terminal = await missions.required(rootID);
      assert.equal(terminal.phase, recoveryMode === "cancel-during-recovery" ? "cancelled" : "completed");
      assert.deepEqual(terminal.execution!.observations, [], "a late history response cannot rewrite a terminal Mission");
      return;
    }
    type NativeFixtureRecord = { parts: { state: { metadata: { exit?: number } } }[] };
    if (recoveryMode === "missing-exit" || recoveryMode === "missing-error-exit") {
      delete (history[nativeOwner]![1] as NativeFixtureRecord).parts[0]!.state.metadata.exit;
      if (recoveryMode === "missing-error-exit") Object.assign((history[nativeOwner]![1] as NativeFixtureRecord).parts[0]!.state, { status: "error" });
    }
    if (recoveryMode === "conflict-after-recovery") {
      assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed");
    }
    if (recoveryMode === "conflicting-terminals" || recoveryMode === "conflict-after-recovery") {
      const failed = structuredClone(history[nativeOwner]![1]) as NativeFixtureRecord;
      failed.parts[0]!.state.metadata.exit = 1;
      history[nativeOwner]!.splice(1, 0, failed);
    }
    if (recoveryMode === "older-after-failure" || recoveryMode === "older-after-running") {
      await missions.update(rootID, current => { current.execution!.observations.push({ command: declaredCommands[1]!, directory: root,
        callID: "later-native-call", sessionID: nativeOwner, startedAt: new Date(start + 20_000).toISOString(),
        ...(recoveryMode === "older-after-failure" ? { completedAt: new Date(start + 21_000).toISOString(),
          status: "completed" as const, exit: 1, outcome: "execution-failed" as const } : { status: "running" as const }) }); });
    }
    const submitted = await tool("submit_mission", coordinator, { status: "blocked", summary: "Existing native operation completed; other evidence remains separate." });
    if (recoveryMode === "direct-before-admission") {
      assert.equal(submitted.acceptance_summary.operation.status, "not-started", "boundary-page calls before direct admission belong to earlier work");
      assert.deepEqual((await missions.required(rootID)).execution!.observations, []);
      return;
    }
    if (["missing-exit", "missing-error-exit", "conflicting-terminals", "conflict-after-recovery"].includes(recoveryMode)) {
      const operation = submitted.acceptance_summary.operation;
      assert.equal(operation.status, "not-started", "missing or contradictory native exits cannot establish terminal completion");
      assert.equal(operation.terminal_complete, false);
      assert.equal(operation.process_succeeded, null);
      const repeated = await tool("operator_status", rootID);
      assert.equal(repeated.acceptance_summary.operation.status, "not-started");
      if (recoveryMode === "missing-exit") {
        const incomplete = operation.observations.find((item: { callID: string }) => item.callID === "call_c2320cce5c63457eae3553a5ab6d1f1c");
        assert.equal(incomplete?.outcome, undefined, "no exit is not a real execution-failed outcome");
        (history[nativeOwner]![1] as NativeFixtureRecord).parts[0]!.state.metadata.exit = 0;
        assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed",
          "retrieving an actual exit completes the same call without a retry or false conflict");
      }
      return;
    }
    if (recoveryMode === "older-after-failure" || recoveryMode === "older-after-running") {
      assert.equal(submitted.acceptance_summary.operation.status, recoveryMode === "older-after-failure" ? "execution-failed" : "running",
        "an older recovered success cannot replace a newer native failure or live process");
      assert.ok((await missions.required(rootID)).execution!.observations.some(item => item.callID === "later-native-call"), "retain the original native record");
      return;
    }
    assert.equal(submitted.acceptance_summary.operation.status, "executed");
    assert.equal(submitted.acceptance_summary.operation.process_succeeded, true);
    assert.deepEqual(submitted.acceptance_summary.operation.observations.map((item: { callID: string }) => item.callID), [
      "call_7c9218e8ae644cec9bfd4125081d2d16", "call_c2320cce5c63457eae3553a5ab6d1f1c",
    ]);
    assert.ok(submitted.acceptance_summary.operation.observations.every((item: { sessionID: string; exit: number }) => item.sessionID === nativeOwner && item.exit === 0));
    assert.equal((await missions.required(rootID)).execution!.observations.length, 2);

    const recovered = await tool("operator_status", rootID);
    const repeated = await tool("operator_status", rootID);
    assert.equal(recovered.acceptance_summary.operation.status, "executed");
    assert.deepEqual(repeated.budget, recovered.budget, "read-only recovery consumes no unit or additional budget");
    assert.equal((await missions.required(rootID)).execution!.observations.length, 2, "native call IDs prevent duplicate records");
    assert.notEqual(recovered.phase, "completed", "operation recovery is not formal validation, Review or acceptance");
    if (direct) return;
    history[worker]!.push(structuredClone(history[worker]![1]!));
    assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed", "identical terminal records are not contradictory");

    const nativeRecord = (callID: string, status: string, exit: number | undefined, at: number, resultStatus = status, background = false) => ({
      info: { role: "assistant", sessionID: worker, time: { created: at } },
      parts: [{ type: "tool", tool: "bash", callID, state: { status,
        input: { command: nativeApply, workdir: root, ...(background ? { background: true } : {}) }, output: exit === undefined ? "still running" : "apply result",
        metadata: { ...(exit === undefined ? {} : { exit }), status: resultStatus },
        time: { start: at, ...(status === "running" ? {} : { end: at + 5 }) } } }],
    });
    const runningAt = start + 20_000;
    history[worker]!.push(nativeRecord("call_running", "completed", undefined, runningAt, "running", true));
    const running = await tool("operator_status", rootID);
    assert.equal(running.acceptance_summary.operation.status, "running", "a later native launch stays running, not completed");
    assert.equal(running.acceptance_summary.operation.observations.at(-1).callID, "call_running");

    const foregroundAt = runningAt + 1;
    history[worker]!.push(nativeRecord("call_foreground", "running", undefined, foregroundAt));
    assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "running");
    history[worker]!.push(nativeRecord("call_foreground", "completed", 0, foregroundAt));
    assert.equal((await tool("operator_status", rootID)).acceptance_summary.operation.status, "executed", "normal running-to-terminal transition is not a conflict");

    const failedAt = runningAt + 10;
    history[worker]!.push(nativeRecord("call_failed", "completed", 1, failedAt));
    const failed = await tool("operator_status", rootID);
    assert.equal(failed.acceptance_summary.operation.status, "execution-failed", "a later nonzero native exit stays failed");
    assert.equal(failed.acceptance_summary.operation.observations.at(-1).callID, "call_failed");
    assert.equal(failed.acceptance_summary.operation.observations.at(-1).exit, 1);

    const conflictingAt = failedAt + 10;
    history[worker]!.push(nativeRecord("call_conflict", "error", undefined, conflictingAt, "running"));
    const conflicting = await tool("operator_status", rootID);
    assert.equal(conflicting.acceptance_summary.operation.status, "execution-failed", "contradictory native status cannot promote a failed result");
    assert.equal(conflicting.acceptance_summary.operation.observations.some((item: { callID: string }) => item.callID === "call_conflict"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional mission consultations record bounded use and skip reasons with native model and outcome", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-consultation-"));
  try {
    const rootRole = profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator");
    const identities: Record<string, Record<string, unknown>> = {
      root: { agent: rootRole },
      coordinator: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-operator"), parentID: "root" },
      advisor: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-advisor"), parentID: "coordinator",
        model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" }, outcome: "succeeded" },
      scout: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-scout"), parentID: "coordinator",
        model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" }, outcome: "succeeded" },
    };
    const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
    } } } as never);
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent as string }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text }],
    });
    await chat("root", "Implement this change and consult only for concrete gaps.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute(
      { requirements: ["Complete the requested change"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);

    const skipped = JSON.parse(await hooks.tool!.sortie_v010_skip_mission_consultation.execute(
      { role: "advisor", reason: "The acceptance and implementation path are already explicit; no material choice remains." },
      { sessionID: "coordinator" }));
    assert.equal(skipped.status, "recorded");
    const scoutSkipped = JSON.parse(await hooks.tool!.sortie_v010_skip_mission_consultation.execute(
      { role: "scout", reason: "The declared validator and its invocation were already observed directly." },
      { sessionID: "coordinator" }));
    assert.equal(scoutSkipped.status, "recorded");
    const advisorPrompt = "strategy_trigger: architecture-choice\nShould the existing parser remain the entrypoint? The current call sites show no alternate route.";
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "advisor-call" }, { args: {
      subagent_type: profileAgent(V010_RUNTIME_PROFILE, "dog-advisor"), description: "Bounded architecture question", prompt: advisorPrompt,
    } });
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "advisor-call" },
      { output: "Keep the parser as the entrypoint.", metadata: { sessionId: "advisor" } });

    const scoutPrompt = `missing_evidence_code: validation\nproject_root: ${root}\nknown_paths: ["check.mjs"]\nWhich exact command is the declared validator?`;
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "scout-call" }, { args: {
      subagent_type: profileAgent(V010_RUNTIME_PROFILE, "dog-scout"), description: "One missing validation fact", prompt: scoutPrompt,
    } });
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "scout-call" },
      { output: "The declared command is node check.mjs.", metadata: { sessionId: "scout" } });

    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.deepEqual(status.consultations.map((entry: Record<string, unknown>) => [entry.role, entry.disposition]), [
      ["advisor", "skipped"], ["scout", "skipped"], ["advisor", "dispatched"], ["scout", "dispatched"],
    ]);
    assert.match(status.consultations[0].reason, /no material choice remains/u);
    assert.match(status.consultations[1].reason, /validator.*observed directly/u);
    assert.equal(status.consultations[2].trigger, "architecture-choice");
    assert.match(status.consultations[2].question, /Should the existing parser/u);
    assert.equal(status.consultations[2].observedModel, "openai/gpt-6-sol");
    assert.equal(status.consultations[2].observedVariant, "xhigh");
    assert.equal(status.consultations[2].outcome, "completed");
    assert.equal(status.consultations[3].trigger, "validation");
    assert.equal(status.consultations[3].observedModel, "openai/gpt-6-luna-fast");
    assert.equal(status.consultations[3].outcome, "completed");
    assert.equal(status.phase, "running", "optional consultations do not block or accept the mission");
  } finally { await rm(root, { recursive: true, force: true }); }
});
