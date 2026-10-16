import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalDeclaredValidationMembers, canonicalObservedValidationMembers } from "../dist/plugin/gate.js";
import { observedMissionValidation, observedMissionValidationSummary, reviewerCorrectionValidation } from "../dist/plugin/mission-review.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";

const exec = promisify(execFile);
const A = "python -m pytest -q test/core/linter_test.py -k persist";
const B = "python -m pytest -q test/cli/commands_test.py -k 'test_encoding or test__cli__command__fix'";
const bundled = `rmdir test/fixtures/unicode_write_repro && git diff --check && git diff -- src/sqlfluff/core/linter/linted_file.py test/core/linter_test.py && ${A}`;
const child = "author";
const history = (commands: readonly string[], exit: number | null = 0) => commands.map((command, i) => ({
  info: { role: "assistant", sessionID: child }, parts: [{ type: "tool", tool: "shell", callID: `call-${i}`,
    state: { status: "completed", input: { command }, metadata: { exit }, time: { start: 100 + i * 20, end: 110 + i * 20 } } }],
}));
const checks = (commands: readonly string[][]) => commands.map((command, i) => ({ command,
  childSessionID: child, callID: `call-${i}`, fresh: true, exitCode: 0,
  startedAt: new Date(100 + i * 20).toISOString(), endedAt: new Date(110 + i * 20).toISOString(),
})) as any;

test("retained mixed-chain tail is an observation, not a broader shell grant", () => {
  assert.equal(canonicalDeclaredValidationMembers(bundled, [A, B]), undefined);
  assert.deepEqual(canonicalObservedValidationMembers(bundled, [A, B]), [A]);
  assert.deepEqual(canonicalObservedValidationMembers(`git status --short && ${A} && ${B}`, [A, B]), [A, B]);
  const composite = `${A} && ${B}`;
  assert.deepEqual(canonicalObservedValidationMembers(`git status --short && ${composite}`, [composite]), [composite]);
  assert.equal(canonicalObservedValidationMembers(bundled, [composite]), undefined, "a partial composite proves nothing");
  assert.deepEqual(canonicalObservedValidationMembers(`echo 'quoted && text' && ${A}`, [A]), [A]);
});

test("observed tails do not cross shell state, altered recipes, extra work or declared occurrences", () => {
  for (const command of [
    `cd other && ${A}`, `export PYTHONPATH=other && ${A}`, `set -e && ${A}`, `. setup.sh && ${A}`,
    `eval 'true' && ${A}`, `exec true && ${A}`, `git status --short # hidden && ${A}`,
    `echo $(touch source.py) && ${A}`, `echo \`touch source.py\` && ${A}`,
    `echo "\`touch source.py\`" && ${A}`, `echo "$(touch source.py)" && ${A}`,
    `echo ready > result.txt && ${A}`, `(echo ready) && ${A}`, `echo ready; ${A}`, `echo ready || ${A}`,
    `echo ready | ${A}`, `echo ready & ${A}`, `echo ready && && ${A}`, `echo ready \\&& ${A}`,
    `echo ready && ${A} && echo after`, `echo ready && ${A}-different`,
    `echo ready && ${B} && ${A}`, `${A} && echo ready && ${B}`, `rm source.py && ${A}`,
  ]) assert.equal(canonicalObservedValidationMembers(command, [A, B]), undefined, command);
  assert.deepEqual(canonicalObservedValidationMembers(`git status --short && ${B} && ${A}`, [A, B, A], 1), [B, A]);
});

test("mixed tails retain native input/timing and need successful native exits for display", async () => {
  const native = history([bundled]);
  const observed = observedMissionValidation([A], child, native, 50);
  assert.deepEqual(observed, { attempts: [{ command: A, native_command: bundled, exit_code: 0,
    started_ms: 100, completed_ms: 110 }], not_observed: [], omitted_attempts: 0 });
  const summary = await observedMissionValidationSummary([A], child, async () => ({ data: native }), 50);
  assert.deepEqual(summary.commands, [{ command: A, native_command: bundled, exit_code: 0,
    observed_attempts: 1, latest_started_ms: 100, latest_completed_ms: 110 }]);
  for (const exit of [1, null]) assert.deepEqual(observedMissionValidation([A], child, history([bundled], exit), 50).attempts, []);
  for (const observed of [observedMissionValidation([A], "other", native, 50),
    observedMissionValidation([A], child, native, 200),
    observedMissionValidation([A], child, native, 50, resolve("_testenv/root"), { [A]: resolve("_testenv/elsewhere") })]) {
    assert.deepEqual(observed.attempts, []);
  }
});

test("bound ordered tail finishes without a standalone repetition; old logs acquire no proof", () => {
  const native = history([bundled, B]), bindings = checks([[A], [B]]);
  const result = reviewerCorrectionValidation([A, B], child, native, 50, bindings);
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.deepEqual(result.matched, [{ callID: "call-0", member: 0, occurrence: 0 }, { callID: "call-1", member: 0, occurrence: 1 }]);
  for (const registered of [undefined, {}]) {
    assert.equal(reviewerCorrectionValidation([A, B], child, native, 50, bindings, undefined, undefined, registered).ready, true);
    for (const bound of [undefined, [], bindings.map((check: any) => ({ ...check, fresh: false })),
      bindings.map((check: any) => ({ ...check, childSessionID: "other" })),
      bindings.map((check: any) => ({ ...check, exitCode: 1 }))]) {
      assert.equal(reviewerCorrectionValidation([A, B], child, native, 50, bound, undefined, undefined, registered).ready, false);
    }
  }
  for (const exit of [1, null]) assert.equal(reviewerCorrectionValidation([A], child, history([bundled], exit), 50, checks([[A]])).ready, false);
  assert.equal(reviewerCorrectionValidation([A, B, A], child, native, 50, bindings).ready, false, "a repeated declaration still needs another native occurrence");
  assert.equal(reviewerCorrectionValidation([A, B], child, history([`echo ready && ${B} && ${A}`]), 50, checks([[B, A]])).ready, false);
  const registered = { [A]: new Date(200).toISOString() };
  assert.equal(reviewerCorrectionValidation([A, B], child, native, 50, bindings, undefined, undefined, registered).ready, false,
    "registration cannot rebind a previously successful native tail");
});

test("an unambiguous final-check refresh selects its new binding without repeating the prefix", () => {
  const native = history([A, B, B]), bindings = checks([[A], [B], [B]]);
  const result = reviewerCorrectionValidation([A, B], child, native, 50, bindings);
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.deepEqual(result.matched, [{ callID: "call-0", member: 0, occurrence: 0 }, { callID: "call-2", member: 0, occurrence: 1 }]);
  for (const exit of [1, null]) {
    const failed = history([A, B, B]);
    failed[2]!.parts[0]!.state.metadata.exit = exit;
    assert.equal(reviewerCorrectionValidation([A, B], child, failed, 50, bindings).ready, false,
      "a failed or unknown latest tail cannot fall back to the old success");
  }
  const stale = bindings.map((check: any, i: number) => ({ ...check, fresh: i !== 2 }));
  assert.equal(reviewerCorrectionValidation([A, B], child, native, 50, stale).ready, false);
  assert.equal(reviewerCorrectionValidation([A, B, A], child, history([A, B, A, A]), 50, checks([[A], [B], [A], [A]])).ready, true);
  assert.deepEqual(reviewerCorrectionValidation([A, B, A], child, history([A, B, A, A]), 50, checks([[A], [B], [A], [A]])).matched,
    [{ callID: "call-0", member: 0, occurrence: 0 }, { callID: "call-1", member: 0, occurrence: 1 }, { callID: "call-2", member: 0, occurrence: 2 }],
    "ambiguous repeated declarations retain the existing occurrence rules");
});

for (const priorComplete of [false, true]) for (const failedExit of [5, null]) {
  test(`failed unique final-check retry retains its valid prefix: completed=${priorComplete}, exit=${failedExit}`, () => {
    const commands = priorComplete ? [A, B, B, B] : [A, B, B];
    const native = history(commands), bindings = checks(commands.map(command => [command]));
    const failedIndex = commands.length - 2;
    native[failedIndex]!.parts[0]!.state.metadata.exit = failedExit;
    bindings[failedIndex].exitCode = failedExit; bindings[failedIndex].fresh = false;
    const result = reviewerCorrectionValidation([A, B], child, native, 50, bindings);
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.deepEqual(result.matched, [
      { callID: "call-0", member: 0, occurrence: 0 },
      { callID: `call-${commands.length - 1}`, member: 0, occurrence: 1 },
    ]);
    const unfinished = reviewerCorrectionValidation([A, B], child, native.slice(0, -1), 50, bindings);
    assert.equal(unfinished.ready, false, "failed or unknown tail is not a PASS until a real retry succeeds");
    assert.equal(unfinished.failure?.exitCode, failedExit);
    assert.equal(unfinished.nextOccurrence, 1, "the actual failed tail, not its passed prefix, remains next");
    for (const staleIndex of [0, commands.length - 1]) {
      const stale = bindings.map((check: any, index: number) => ({ ...check, fresh: index !== staleIndex && check.fresh }));
      assert.equal(reviewerCorrectionValidation([A, B], child, native, 50, stale).ready, false,
        "a retry cannot promote stale prefix or tail evidence");
    }
    const overlap = structuredClone(native);
    overlap.at(-1)!.parts[0]!.state.time.start = overlap[failedIndex]!.parts[0]!.state.time.end - 1;
    assert.equal(reviewerCorrectionValidation([A, B], child, overlap, 50, bindings).ready, false);
  });
}

test("failed composite or repeated final declarations cannot lend a partial prefix to retry", () => {
  const native = history([A, `${A} && ${B}`, B]);
  native[1]!.parts[0]!.state.metadata.exit = 1;
  const bindings = checks([[A], [A, B], [B]]);
  bindings[1].exitCode = 1; bindings[1].fresh = false;
  assert.equal(reviewerCorrectionValidation([A, B], child, native, 50, bindings).ready, false,
    "a failed chain proves no individual member passed");
  const repeated = history([A, B, B, B]), repeatedBindings = checks([[A], [B], [B], [B]]);
  repeated[2]!.parts[0]!.state.metadata.exit = 1;
  repeatedBindings[2].exitCode = 1; repeatedBindings[2].fresh = false;
  assert.equal(reviewerCorrectionValidation([A, B, B], child, repeated, 50, repeatedBindings).ready, false,
    "ambiguous repeated occurrences keep their existing ordering rules");
});

for (const changedSource of [false, true]) test(`cold direct finish reuses the prefix after a final report-only refresh: source changed=${changedSource}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/refreshed-tail-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "source.txt"), "fixed\n");
    await writeFile(join(directory, "report.json"), "{}\n");
    await writeFile(join(directory, "check.mjs"), 'import {readFileSync, writeFileSync} from "node:fs"; writeFileSync("cache.txt", "generated\\n"); if (readFileSync("source.txt", "utf8") !== "fixed\\n") process.exit(1);\n');
    const native: Record<string, unknown>[] = [];
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async () => ({ data: { id: "root", agent: "dog-operator", outcome: "running" } }),
      messages: async () => ({ data: native }), children: async () => ({ data: [] }),
    } } } as never);
    let hooks = await create();
    await hooks["chat.message"]!({ sessionID: "root", messageID: "real-task", agent: "dog-operator" }, {
      message: { id: "real-task", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
      parts: [{ type: "text", text: "Validate the source, retaining the report." }],
    });
    await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed source and retained report"] }, { sessionID: "root" });
    await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [{
      title: "Validate fixed source", objective: "Validate source and retain report",
      read: ["check.mjs", "source.txt"], write: ["source.txt", "report.json", "cache.txt"], validation: ["node check.mjs", "git diff --check"],
    }] }, { sessionID: "root" });
    const runNative = async (command: string, callID: string) => {
      const args = { command, workdir: directory }, start = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "root", callID }, { args });
      await exec("/bin/sh", ["-c", command], { cwd: directory });
      native.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: args, metadata: { exit: 0 }, time: { start, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "root", callID, args }, { output: "PASS", metadata: { exit: 0 } });
    };
    await runNative("node check.mjs", "prefix");
    await runNative("git diff --check", "old-tail");
    await writeFile(join(directory, "report.json"), '{"integrated":true}\n');
    if (changedSource) await writeFile(join(directory, "source.txt"), "broken\n");
    await runNative("git diff --check", "new-tail");
    hooks = await create();
    const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: "root" }));
    assert.equal(finished.status, changedSource ? "direct-unit-awaits-validation" : "awaiting-acceptance", JSON.stringify(finished));
    assert.equal(native.length, 3, "the original prefix is never rerun");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const changedSource of [false, true]) test(`cold direct finish retains a successful prefix after final-check setup repair: source changed=${changedSource}`, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/retried-final-check-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(join(directory, "source.txt"), "fixed\n");
    await writeFile(join(directory, "prefix.mjs"), 'import {readFileSync} from "node:fs"; if(readFileSync("source.txt", "utf8") !== "fixed\\n") process.exit(1);\n');
    await writeFile(join(directory, "tail.mjs"), 'import {readFileSync} from "node:fs"; if(readFileSync(".sortie-env/ready", "utf8") !== "ready\\n") process.exit(1);\n');
    const native: Record<string, unknown>[] = [];
    const create = () => SortieDogsV010Plugin({ directory, client: { session: {
      get: async () => ({ data: { id: "root", agent: "dog-operator", outcome: "running" } }),
      messages: async () => ({ data: native }), children: async () => ({ data: [] }),
    } } } as never);
    let hooks = await create();
    await hooks["chat.message"]!({ sessionID: "root", messageID: "retry-task", agent: "dog-operator" }, {
      message: { id: "retry-task", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
      parts: [{ type: "text", text: "Run both existing checks, repairing local setup if needed without repeating an unchanged passed check." }],
    });
    await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Both checks pass for the fixed source"] }, { sessionID: "root" });
    await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [{
      title: "Validate fixed source", objective: "Run prefix and final environment-dependent check",
      read: ["source.txt", "prefix.mjs", "tail.mjs"], write: ["source.txt"], validation: ["node prefix.mjs", "node tail.mjs"],
    }] }, { sessionID: "root" });
    const readRun = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    const initial = await readRun();
    const runNative = async (command: string, callID: string) => {
      const args = { command, workdir: directory }, start = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "root", callID }, { args });
      let exit = 0, output = "";
      try { output = (await exec("/bin/sh", ["-c", command], { cwd: directory })).stdout; }
      catch (error) { exit = Number((error as { code?: unknown }).code) || 1; output = String((error as { stderr?: unknown }).stderr ?? ""); }
      native.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: args, metadata: { exit }, time: { start, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "root", callID, args }, { output, metadata: { exit } });
      return exit;
    };
    assert.equal(await runNative("node prefix.mjs", "passed-prefix"), 0);
    const prefix = structuredClone((await readRun()).units[0]!.directExecution!.checks[0]);
    assert.ok(prefix, "the native prefix must have a persisted binding");
    assert.equal(await runNative("node tail.mjs", "failed-tail"), 1);
    const failed = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: "root" }));
    assert.equal(failed.status, "direct-unit-awaits-validation");
    assert.match(failed.reason, /validation-failed/);
    await mkdir(join(directory, ".sortie-env"));
    await writeFile(join(directory, ".sortie-env/ready"), "ready\n");
    if (changedSource) await writeFile(join(directory, "source.txt"), "changed\n");
    assert.equal(await runNative("node tail.mjs", "retried-tail"), 0);
    hooks = await create();
    const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: "root" }));
    assert.equal(finished.status, changedSource ? "direct-unit-awaits-validation" : "awaiting-acceptance", JSON.stringify(finished));
    if (changedSource) assert.match(finished.reason, /validation-stale/);
    const current = await readRun(), saved = current.units[0]!.directExecution!.checks;
    assert.equal(current.runID, initial.runID);
    assert.deepEqual(saved.find(check => check.callID === "passed-prefix"), prefix, "old proof is retained, not relabeled or rerun");
    assert.equal(native.length, 3);
    assert.deepEqual(saved.map(check => check.exitCode), [0, 1, 0], "failed native outcome remains in history");
    if (!changedSource) {
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
      assert.equal(status.budget.consumed_units, 1, "repair uses the same existing direct unit");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const mode of ["fresh", "changed-input", "stale-after", "wrong-cwd", "failed-prefix"] as const) {
  test(`live direct tail captures the existing snapshot and survives cold recovery: ${mode}`, async t => {
    await mkdir(resolve("_testenv"), { recursive: true });
      const directory = await mkdtemp(resolve("_testenv/observed-tail-"));
    try {
      await exec("git", ["init", "--quiet"], { cwd: directory });
      await mkdir(join(directory, "scratch"));
      await writeFile(join(directory, "source.txt"), "fixed\n");
      await writeFile(join(directory, "check.mjs"), 'import {readFileSync} from "node:fs"; if (readFileSync("source.txt", "utf8") !== "fixed\\n") process.exit(1);\n');
      if (mode === "wrong-cwd") {
        await writeFile(join(directory, "scratch", "source.txt"), "fixed\n");
        await writeFile(join(directory, "scratch", "check.mjs"), await readFile(join(directory, "check.mjs")));
      }
      const native: Record<string, unknown>[] = [];
      const create = () => SortieDogsV010Plugin({ directory, client: { session: {
        get: async () => ({ data: { id: "root", agent: "dog-operator", outcome: "running" } }),
        messages: async () => ({ data: native }), children: async () => ({ data: [] }),
      } } } as never);
      let hooks = await create();
      await hooks["chat.message"]!({ sessionID: "root", messageID: "real-task", agent: "dog-operator" }, {
        message: { id: "real-task", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
        parts: [{ type: "text", text: "Validate the fixed source with node check.mjs." }],
      });
      await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed source"] }, { sessionID: "root" });
      const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [{
        title: "Validate fixed source", objective: "Validate fixed source, removing the empty scratch directory",
        read: ["check.mjs", "source.txt"], write: ["source.txt", "scratch/**"], validation: ["node check.mjs"],
      }] }, { sessionID: "root" }));
      assert.equal(planned.status, "direct-unit-running", JSON.stringify(planned));
      const run = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      // A concurrent change makes the native check pass after its start snapshot
      // pinned broken bytes. That binding stays stale, not repaired after the fact.
      if (mode === "changed-input") await writeFile(join(directory, "source.txt"), "broken\n");
      const prefix = mode === "failed-prefix" ? "rmdir missing" : "rmdir scratch";
      const command = `${mode === "wrong-cwd" ? "" : `${prefix} && `}git diff --check && node check.mjs`;
      const workdir = mode === "wrong-cwd" ? join(directory, "scratch") : directory;
      const args = { command, workdir }, callID = "bundled-native", start = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "root", callID }, { args });
      let exit = 0;
      if (mode === "changed-input") await writeFile(join(directory, "source.txt"), "fixed\n");
      try { await exec("/bin/sh", ["-c", command], { cwd: workdir }); }
      catch (error) { exit = Number((error as { code?: unknown }).code) || 1; }
      native.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: args, metadata: { exit }, time: { start, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "root", callID, args }, { output: exit ? "FAIL" : "PASS", metadata: { exit } });
      const saved = (await run()).units[0]!.directExecution!.checks;
      if (mode === "wrong-cwd") assert.equal(saved.length, 0);
      else {
        assert.equal(saved.length, 1, "the actual bundled native call has one captured check, no standalone check");
        assert.deepEqual(saved[0]!.command, ["node check.mjs"]);
        assert.equal(saved[0]!.callID, callID);
        assert.equal(saved[0]!.fresh, mode !== "changed-input" && mode !== "failed-prefix");
        assert.equal(saved[0]!.binding.freshness?.toolchain?.commands[0], command, "freshness pins the FULL actual native command");
      }
      if (mode === "stale-after") await writeFile(join(directory, "source.txt"), "changed after validation\n");
      hooks = await create();
      const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: "root" }));
      assert.equal(finished.status, mode === "fresh" ? "awaiting-acceptance" : "direct-unit-awaits-validation", JSON.stringify(finished));
      assert.equal(exit, mode === "failed-prefix" ? 1 : 0, "actual native command outcome, not a fabricated tail result");
      t.diagnostic(JSON.stringify({ mode, native_command: command, native_exit: exit, captured_checks: saved.length,
        fresh_when_observed: saved[0]?.fresh ?? null, cold_finish: finished.status, native_calls: native.length }));
      assert.deepEqual((await run()).units[0]!.directExecution!.checks, saved, "cold finish never adds or rewrites historical proof");
      assert.equal(native.length, 1, "no repetition/extra dispatch needed for the valid check");
      assert.equal(await readFile(join(directory, "source.txt"), "utf8"), mode === "stale-after" ? "changed after validation\n" : "fixed\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
