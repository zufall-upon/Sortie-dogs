import assert from "node:assert/strict";
import test from "node:test";
import { missionValidationCommand } from "../dist/core/operator-mission.js";
import { canonicalDeclaredValidationMembers } from "../dist/plugin/gate.js";
import { reviewerCorrectionValidation } from "../dist/plugin/mission-review.js";

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

test("different payloads, expanding heredocs and additional shell work are not the registered check", () => {
  for (const input of [original.replace("2 + 2 == 4", "True"), original.replace("<<'PY'", "<<PY"),
    `${original}\nprintf done`, "cat <<'PY'\nprint('ready')\nassert 2 + 2 == 4\nPY"]) {
    assert.equal(canonicalDeclaredValidationMembers(input, commands), undefined);
    assert.equal(reviewerCorrectionValidation(commands, child, history([commands[0]!, input, commands[2]!]), 50).ready, false);
  }
});
