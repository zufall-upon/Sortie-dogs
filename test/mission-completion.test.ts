import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE, profileAgent } from "../dist/core/runtime-profile.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

for (const mode of ["implementation", "executed", "NO_START", "legacy-background"] as const) test(`mission completion keeps checks, review and operation outcomes separate: ${mode}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-completion-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.name", "test"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    const validator = 'import { readFileSync, writeFileSync } from "node:fs";\n' +
      (mode === "implementation" ? '' : 'writeFileSync("result.txt", "ready\\n");\n') +
      'if (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n' +
      `console.log(JSON.stringify(${JSON.stringify({ status: mode, attempts: mode === "NO_START" ? 0 : 1, reward: 0 })}));\n`;
    const reference = "Public result contract: ready followed by a newline.\n";
    await writeFile(join(root, "reference.md"), reference);
    await writeFile(join(root, "check.mjs"), validator);
    await exec("git", ["add", "check.mjs"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "validator"], { cwd: root });
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: "coordinator" }, reviewer: { agent: "dog-reviewer-v010", parentID: "coordinator" },
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
    await chat("root", "Write and validate a ready result, then review and accept it.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Create a validated result"],
      kind: mode === "implementation" ? "implementation" : "operation" }, { sessionID: "root" }));
    const baseline = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewBaseline, baseline);
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    if (mode === "executed") await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ units: [{
      title: "Incomplete operation", objective: "Run the operation", write: ["result.txt"], validation: ["node check.mjs"],
    }], execution: { commands: [], directory: root } }, { sessionID: "coordinator" }), /mission-operation-input/);
    const next = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Validated result", objective: "Write result and validate it",
      read: ["check.mjs", ".sortie-dogs-v010/missions"], write: ["result.txt"], validation: ["node check.mjs"] }],
      execution: { commands: mode === "implementation" ? [] : ["node check.mjs"], directory: root } }, { sessionID: "coordinator" }));
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewBaseline, baseline);
    if (mode === "implementation") assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).kind, "implementation");
    assert.deepEqual((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).reviewScope?.write, ["result.txt"]);
    const worker = { args: structuredClone(next.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, worker);
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
    if (mode === "legacy-background") {
      // V2 returns a completed tool call for a launched background shell, with no process exit.
      // This is the metadata captured by the real Anko run, not an operation result.
      await hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "background-launch" },
        { args: { command: "node check.mjs", workdir: root } });
      await hooks["tool.execute.after"]!({ tool: "shell", sessionID: "worker", callID: "background-launch" },
        { output: "", metadata: { status: "running", shellID: "sh_anko" } });
      const observed = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.equal(observed.execution?.observations[0]?.completedAt, undefined,
        "a background launch must not be recorded as a terminal failure or success");
      assert.equal(observed.execution?.observations[0]?.status, "running");
      const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "launched" },
        { sessionID: "coordinator" }));
      assert.equal(submitted.status, "operation-incomplete");
      assert.equal(submitted.operation.status, "running");
      assert.match(submitted.next_action, /do not (?:relaunch|start another)/iu);
      return;
    }
    if (mode === "implementation") await writeFile(join(root, "result.txt"), "ready\n");
    if (mode === "executed") {
      await assert.rejects(hooks["tool.execute.before"]!({ tool: "shell", sessionID: "worker", callID: "background-operation" },
        { args: { command: "node check.mjs", workdir: root, background: true, timeout: 0 } }),
      /mission-operation-background: run the declared command in foreground/);
      for (const command of ["node check.mjs | tee result.txt", "node check.mjs > result.txt",
        "node check.mjs 2> result.txt", "node check.mjs && echo done"]) {
        await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: `decorated-${command}` },
          { args: { command } }), /mission-operation-command-not-observed: run the declared operation command exactly/);
      }
      assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).execution?.observations.length, 0,
        "a decorated operation is corrected before it starts, without a second Worker or plan");
      await assert.rejects(readFile(join(root, "result.txt"), "utf8"), { code: "ENOENT" });
    }
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, { args: { command: "node check.mjs" } });
    const checked = await exec(process.execPath, ["check.mjs"], { cwd: root });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, { output: checked.stdout, metadata: { exit: 0, status: "completed" } });
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, { output: "validated", metadata: { sessionId: "worker" } });
    const validatedUnits = structuredClone((await runtime.required("root")).units);
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
      traces: ["check.mjs observed ready result, exit 0"], evidence: [{ path: "reference.md", offset: 1, limit: 1 }] }, { sessionID: "coordinator" }));
    const reviewer = { args: structuredClone(review.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "reviewer-call" }, reviewer);
    assert.match(reviewer.args.prompt, /deferred Operator checks/);
    assert.match(reviewer.args.prompt, /Public result contract: ready followed by a newline/u);
    assert.deepEqual((await runtime.required("root")).units, validatedUnits,
      "attaching undeclared project context does not replan, rerun validation, or dispatch another Worker");
    identities.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "reviewer-call" }, { output: "PASS\nThe result is validated.", metadata: { sessionId: "reviewer" } });
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
    await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "ready" },
      { sessionID: "coordinator" }), /mission-review-required-or-stale/);
    await writeFile(join(root, "reference.md"), reference);
    assert.equal((await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).coordinator, "coordinator");
    const submittedText = await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "Validated result, reviewed independently" }, { sessionID: "coordinator" });
    assert.equal(Object.keys(JSON.parse(submittedText))[0], "acceptance_summary", "summary precedes the full authority packet");
    identities.coordinator!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { output: "ready", metadata: { sessionId: "coordinator" } });
    const cold = await create();
    const status = async () => JSON.parse(await cold.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal((await status()).completion.ready, true);
    assert.equal(Object.keys(await status())[0], "acceptance_summary");
    if (mode === "implementation") {
      const emptyNative = (await status()).acceptance_summary.native_declared_validation[0];
      assert.equal(emptyNative.status, "available");
      assert.deepEqual(emptyNative.observations.commands, []);
      assert.deepEqual(emptyNative.observations.not_observed, ["node check.mjs"]);
      for (const [historyMode, reason] of [["missing", "native-worker-history-api-unavailable"],
        ["error", "native-worker-history-api-error"], ["invalid", "native-worker-history-response-not-array"]] as const) {
        // Root role is already observed in this live instance. Change only the summary reader's API
        // availability; a cold root with no recovery API is a different existing host contract.
        const normalMessages = latestSession!.messages;
        if (historyMode === "missing") delete latestSession!.messages;
        else latestSession!.messages = async () => historyMode === "error"
          ? { data: undefined, error: { message: "unavailable" } } : { data: {} };
        const observed = await status();
        latestSession!.messages = normalMessages;
        assert.equal(observed.completion.ready, true, "history display failure adds no acceptance gate");
        assert.equal(observed.acceptance_summary.native_declared_validation[0].status, "unavailable");
        assert.equal(observed.acceptance_summary.native_declared_validation[0].reason, reason);
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
    assert.equal(stale.next_action, blocked.next_action, "status must not blindly send the root back to the same refused completion");
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
    assert.match(final.next_action, /no further dispatch or completion/);
    const key = createHash("sha256").update("v010\0root").digest("hex");
    const ledger = await (await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`))).readGoal();
    assert.equal(ledger.state.consumed_units, 1);
    assert.equal(ledger.state.outstanding_reservations.length, 0);
    assert.equal(ledger.records.filter(({ event }) => event.kind === "validation.admission").length, 1, "review and acceptance must not require a second successful check");
    assert.equal(await readFile(join(root, "result.txt"), "utf8"), "ready\n");
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
