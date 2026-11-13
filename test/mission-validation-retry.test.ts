import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);

for (const mode of ["single", "long", "variable-output", "first-failed", "first-missing", "recovered", "wrapped-recovered", "stale-first-tool"] as const) test(
  mode === "long" ? "long native validation keeps its original Worker and budget through setup repair"
    : mode === "variable-output" ? "declared variable-output validation survives public handoff binding and native result recording"
    : mode === "single" ? "same Worker reruns its exact failed check after setup repair without a new plan or source change"
      : `ordinary Worker requires every declared native check: ${mode}`, async () => {
  const longCommand = mode === "long", multiple = !["single", "long", "variable-output"].includes(mode);
  const checkArgs = ["check.mjs", ...(longCommand ? [`--command-bound=${"x".repeat(4096)}`] : [])];
  const validator = mode === "variable-output" ? 'OUT=.sortie-env/check.txt; node check.mjs && printf ok > "$OUT"'
    : mode === "stale-first-tool" ? "./.sortie-env/check-tool" : ["node", ...checkArgs].join(" ");
  const later = ["node --check check.mjs", "node --check ./check.mjs", "node -e 'process.exit(0)'"];
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/mission-validation-retry-"));
  try {
    for (const args of [["init", "--quiet"], ["config", "user.name", "test"], ["config", "user.email", "test@example.invalid"]]) {
      await exec("git", args, { cwd: root });
    }
    await writeFile(join(root, "check.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync(".sortie-env/logs/test.log", "ok"); console.log("PASS");\n');
    if (mode === "stale-first-tool") {
      await mkdir(join(root, ".sortie-env"), { recursive: true });
      await writeFile(join(root, ".sortie-env/check-tool"), "#!/bin/sh\nnode check.mjs\n");
      await chmod(join(root, ".sortie-env/check-tool"), 0o755);
    }
    await exec("git", ["add", "check.mjs"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "validator"], { cwd: root });
    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: "coordinator" },
    };
    const history: Record<string, unknown>[] = [];
    const hooks = await SortieDogsV010Plugin({ directory: root, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, info]) => info.parentID === path.id).map(([id, info]) => ({ id, ...info })) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: path.id === "worker" ? history : [] }), abort: async () => ({ data: true }),
    } } } as never);
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }],
    });
    await chat("root", "Run the existing check, repairing local setup if needed.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Run the existing check"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const next = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Validate", objective: "Run the check",
      read: ["check.mjs"], write: [], validation: [validator, ...(multiple ? later : [])] }] }, { sessionID: "coordinator" }));
    const task = { args: structuredClone(next.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, task);
    await chat("worker", task.args.prompt);
    const initial = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root"), unit = initial.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } }, { output: "inspected" });
    await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: root, manifest_path: unit.manifestPath }, { sessionID: "worker" });
    const calls = new Map<string, { args: { command: string }; started: number }>();
    const before = async (callID: string, args = { command: validator }) => {
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID }, { args });
      calls.set(callID, { args: { ...args }, started: Date.now() });
    };
    const after = async (callID: string, output: string, exit: number) => {
      const call = calls.get(callID)!;
      history.push({ info: { role: "assistant", sessionID: "worker" }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: call.args, metadata: { exit }, time: { start: call.started, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID, args: call.args }, { output, metadata: { exit, status: "completed" } });
    };
    if (mode !== "first-missing") await before("check-first");
    let failure: { code: number; stderr: string } | undefined;
    if (mode !== "first-missing") {
      try { await exec("bash", ["-c", validator], { cwd: root }); }
      catch (error) { failure = error as typeof failure; }
      assert.equal(failure?.code, 1);
      assert.match(failure!.stderr, /ENOENT/);
      await after("check-first", failure!.stderr, 1);
    }
    const runLater = async (round: string) => {
      if (mode === "wrapped-recovered") {
        const command = later.join(" && "), args = { command };
        await before(round, args);
        assert.equal(args.command, command);
        const result = await exec("bash", ["-c", command], { cwd: root });
        await after(round, result.stdout, 0);
        return;
      }
      for (const [index, command] of later.entries()) {
        const callID = `${round}-${index}`, args = { command };
        await before(callID, args);
        assert.equal(args.command, command, "the declared check must really execute");
        const result = await exec("bash", ["-c", command], { cwd: root });
        await after(callID, result.stdout, 0);
      }
    };
    if (multiple) await runLater("first-round");
    if (mode === "first-failed" || mode === "first-missing") {
      identities.worker!.outcome = "succeeded";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, { output: "later checks passed", metadata: { sessionId: "worker" } });
      const current = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.equal(current.units[0]!.status, "failed", "the last PASS cannot hide failed or unrun required checks");
      assert.equal(current.units[0]!.evidence.length, 0);
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
      assert.notEqual(status.completion?.ready, true);
      assert.equal(current.phase, "awaiting-decision");
      assert.deepEqual(status.acceptance_summary.formal_validation, []);
      const native = status.acceptance_summary.native_declared_validation[0].observations;
      assert(native.commands.some((item: { command: string; exit_code: number }) => item.command === later[2] && item.exit_code === 0));
      if (mode === "first-failed") assert(native.commands.some((item: { command: string; exit_code: number }) => item.command === validator && item.exit_code === 1));
      else assert(native.not_observed.includes(validator));
      return;
    }
    // Setup is intentionally outside candidate identity, just like the Anko Go log directory.
    await before("repair-setup", { command: 'node -e "require(\'node:fs\').mkdirSync(\'.sortie-env/logs\',{recursive:true})"' });
    await mkdir(join(root, ".sortie-env/logs"), { recursive: true });
    await after("repair-setup", "created log directory", 0);
    const retry = { command: validator };
    await before("check-retry", retry);
    assert.equal(retry.command, validator, "a failed check must run, not reuse a fake PASS");
    const result = await exec("bash", ["-c", validator], { cwd: root });
    await after("check-retry", result.stdout, 0);
    if (mode === "variable-output") assert.equal(await readFile(join(root, ".sortie-env/check.txt"), "utf8"), "ok");
    if (multiple) await runLater("recovered-round");
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, { output: "validated after local setup repair", metadata: { sessionId: "worker" } });
    const current = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
    assert.equal(current.runID, initial.runID);
    assert.equal(current.units[0]!.status, "succeeded");
    const key = createHash("sha256").update("v010\0root").digest("hex");
    const ledger = await (await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`))).readGoal();
    assert.equal(ledger.state.consumed_units, 1);
    if (multiple) {
      const recordedLater = mode === "wrapped-recovered" ? [[later, 0]] : later.map(command => [[command], 0]);
      assert.deepEqual(current.units[0]!.validationRegistration!.checks.map(check => [check.command, check.exitCode]),
        [[[validator], 1], ...(mode === "wrapped-recovered" ? [] : recordedLater), [[validator], 0], ...recordedLater]);
      assert.equal(current.units[0]!.validationRegistration!.matched?.length, 4);
      const status = () => hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }).then(JSON.parse);
      const accepted = await status();
      assert.equal(accepted.completion.ready, true);
      assert.deepEqual(accepted.acceptance_summary.formal_validation[0].required_checks.map((check: { declared_command: string }) => check.declared_command),
        [validator, ...later], "the full proof identifies every actual required check, not just the terminal command");
      if (mode === "stale-first-tool") {
        // Only the first command's executable changes; the final command and declared source do not.
        await writeFile(join(root, ".sortie-env/check-tool"), "#!/bin/sh\nnode check.mjs\n# changed tool\n");
        const stale = await status();
        assert.equal(stale.completion.ready, false);
        assert(stale.completion.blockers.some((blocker: { reason: string; next_action: string }) =>
          blocker.reason === "source-changed" && blocker.next_action.includes(validator)));
      }
      return;
    }
    assert.equal(ledger.state.validation_budget.consumed, 2);
    const validations = ledger.records.map(({ event }) => event).filter(event => event.kind === "validation.admission" && event.decision === "ALLOW");
    assert.equal(validations.length, 2);
    assert.equal(validations[0]!.evidence_key, validations[1]!.evidence_key, "source, candidate and command did not change");
    const outcomes = ledger.records.map(({ event }) => event).filter(event => event.kind === "validation.settled").map(event => event.outcome);
    assert.deepEqual(outcomes, ["failed", "passed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
