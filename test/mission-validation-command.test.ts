import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { missionValidationCommand } from "../dist/core/operator-mission.js";
import { canonicalDeclaredValidationMembers } from "../dist/plugin/gate.js";
import { observedMissionValidation, observedMissionValidationSummary, reviewerCorrectionValidation } from "../dist/plugin/mission-review.js";

const original = "python - <<'PY'\nprint('ready')\nassert 2 + 2 == 4\nPY";
const registered = missionValidationCommand(original);
const commands = ["python -c \"assert True\"", registered, "git diff --check"];
const child = "same-author";
const history = (inputs: readonly string[], exits: readonly number[] = inputs.map(() => 0)) => inputs.map((command, index) => ({
  info: { role: "assistant", sessionID: child },
  parts: [{ type: "tool", tool: "shell", callID: `native-${index}`,
    time: { ran: 100 + index * 10, completed: 105 + index * 10 },
    state: { status: "completed", input: { command }, metadata: { exit: exits[index] } } }],
}));

test("the original quoted Python heredoc matches its existing Mission registration identity", () => {
  assert.deepEqual(canonicalDeclaredValidationMembers(original, commands), [registered]);
  assert.deepEqual(canonicalDeclaredValidationMembers(registered, commands), [registered]);
  assert.deepEqual(canonicalDeclaredValidationMembers(original, [original]), [original.replace(/\s+/g, " ")],
    "legacy raw declarations retain their existing whitespace-normalized identity");
});

test("ordered native checks using the original heredoc finish without a conversion-only rerun", () => {
  const result = reviewerCorrectionValidation(commands, child, history([commands[0]!, original, commands[2]!]), 50);
  assert.equal(result.ready, true);
  assert.deepEqual(result.matched, [
    { callID: "native-0", member: 0, occurrence: 0 },
    { callID: "native-1", member: 0, occurrence: 1 },
    { callID: "native-2", member: 0, occurrence: 2 },
  ]);
  const checks = commands.map((command, index) => ({ childSessionID: child, callID: `native-${index}`,
    command: [command], fresh: true, exitCode: 0, startedAt: new Date(100 + index * 10).toISOString(),
    endedAt: new Date(105 + index * 10).toISOString() }));
  assert.equal(reviewerCorrectionValidation(commands, child,
    history([commands[0]!, original, commands[2]!]), 50, checks).ready, true);
  assert.equal(reviewerCorrectionValidation(commands, child,
    history([commands[0]!, original, commands[2]!]), 50, checks.map(c => ({ ...c, fresh: false }))).ready, false,
    "matching the original heredoc cannot bypass protected-source freshness");
});

test("the matched heredoc retains its actual native failure rather than inferred success", () => {
  const result = reviewerCorrectionValidation(commands, child, history([commands[0]!, original], [0, 1]), 50);
  assert.equal(result.ready, false);
  assert.deepEqual(result.failure, { command: [registered], outcome: "fail", exitCode: 1 });
});

test("native heredoc display reports the registered check without a conversion-only rerun", () => {
  const native = history([commands[0]!, original, commands[2]!]);
  const result = observedMissionValidation(commands, child, native, 50);
  assert.deepEqual(result, { attempts: commands.map((command, index) => ({ command, exit_code: 0,
    started_ms: 100 + index * 10, completed_ms: 105 + index * 10 })), not_observed: [], omitted_attempts: 0 });
  assert.equal(reviewerCorrectionValidation(commands, child, native, 50).ready, true,
    "the display must agree with the already-working native acceptance matcher");
});

test("native heredoc display retains failed and unknown exits", () => {
  const native = history([original, original], [1, 0]);
  delete (native[1]!.parts[0]!.state.metadata as { exit?: number }).exit;
  const result = observedMissionValidation([registered], child, native, 50);
  assert.deepEqual(result, { attempts: [
    { command: registered, exit_code: 1, started_ms: 100, completed_ms: 105 },
    { command: registered, exit_code: null, started_ms: 110, completed_ms: 115 },
  ], not_observed: [], omitted_attempts: 0 });
  assert.equal(reviewerCorrectionValidation([registered], child, native, 50).ready, false,
    "an observed failure or missing exit is not successful validation");
});

test("native heredoc summary groups equivalent inputs without losing their real outcomes", async () => {
  const native = history([original, registered, original, original], [0, 0, 0, 1]);
  let reads = 0;
  const summary = await observedMissionValidationSummary([registered], child, async () => {
    reads++; return { data: native };
  }, 50);
  assert.deepEqual(summary.commands, [
    { command: registered, exit_code: 0, observed_attempts: 3, latest_started_ms: 120, latest_completed_ms: 125 },
    { command: registered, exit_code: 1, observed_attempts: 1, latest_started_ms: 130, latest_completed_ms: 135 },
  ]);
  assert.deepEqual(summary.not_observed, []);
  assert.equal(reads, 1, "display repair does not request another history or model turn");
});

test("native heredoc display retains session, admission time and registered directory checks", () => {
  const root = resolve("_testenv/heredoc-root"), external = resolve("_testenv/heredoc-external");
  const native = history([original]);
  Object.assign(native[0]!.parts[0]!.state.input, { workdir: external });
  const directories = { [registered]: external };
  const result = observedMissionValidation([registered], child, native, 50, root, directories);
  assert.deepEqual(result.attempts, [{ command: registered, directory: external,
    exit_code: 0, started_ms: 100, completed_ms: 105 }]);
  assert.deepEqual(result.not_observed, []);
  for (const observed of [
    observedMissionValidation([registered], "another-author", native, 50, root, directories),
    observedMissionValidation([registered], child, native, 200, root, directories),
    observedMissionValidation([registered], child, native, 50, root),
  ]) {
    assert.deepEqual(observed.attempts, []);
    assert.deepEqual(observed.not_observed, [registered]);
  }
});

test("native heredoc display does not include different scripts or undeclared shell work", () => {
  for (const input of [original.replace("2 + 2 == 4", "True"), original.replace("<<'PY'", "<<PY"),
    `${original}\nprintf done`, "cat <<'PY'\nprint('ready')\nassert 2 + 2 == 4\nPY"]) {
    assert.deepEqual(observedMissionValidation([registered], child, history([input]), 50), {
      attempts: [], not_observed: [registered], omitted_attempts: 0,
    });
  }
});

test("different payloads, expanding heredocs and additional shell work are not the registered check", () => {
  for (const input of [original.replace("2 + 2 == 4", "True"), original.replace("<<'PY'", "<<PY"),
    `${original}\nprintf done`, "cat <<'PY'\nprint('ready')\nassert 2 + 2 == 4\nPY"]) {
    assert.equal(canonicalDeclaredValidationMembers(input, commands), undefined);
    assert.equal(reviewerCorrectionValidation(commands, child, history([commands[0]!, input, commands[2]!]), 50).ready, false);
  }
});
