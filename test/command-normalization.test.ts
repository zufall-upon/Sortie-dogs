import assert from "node:assert/strict";
import test from "node:test";
import { missionValidationCommand } from "../dist/core/mission-validation-command.js";
import { canonicalDeclaredValidationMembers, normalizeCommand } from "../dist/plugin/gate.js";
import { observedMissionValidation, reviewerCorrectionValidation } from "../dist/plugin/mission-review.js";

const original = "python - <<'PY'\nimport json\nqueries = ('SELECT [hello]\\nFROM\\n    mytable', 'SELECT a.[hello]\\nFROM\\n    mytable AS a')\nprint(json.dumps(queries))\nPY";
const registered = missionValidationCommand(original);
const history = (command: string) => [{ info: { role: "assistant", sessionID: "author" },
  parts: [{ type: "tool", tool: "shell", callID: "native-check", time: { ran: 100, completed: 110 },
    state: { status: "completed", input: { command }, metadata: { exit: 0 } } }] }];

test("normalization preserves Python heredoc data after shell-escaped apostrophes", () => {
  assert.equal(normalizeCommand(registered), registered);
  assert.equal(normalizeCommand(normalizeCommand(registered)), registered);
  assert.deepEqual(canonicalDeclaredValidationMembers(original, [registered]), [registered]);
});

test("escaped double quotes do not expose quoted payload whitespace to normalization", () => {
  const command = String.raw`node -e "console.log(\"first   second\")"`;
  assert.equal(normalizeCommand(`  ${command.replace("node -e", "node   -e")}  `), command);
  assert.equal(normalizeCommand(normalizeCommand(command)), command);
});

test("backslash-escaped unquoted whitespace stays part of the argument", () => {
  const command = String.raw`printf %s first\ \ second`;
  assert.equal(normalizeCommand(`  ${command.replace("printf %s", "printf   %s")}  `), command);
  assert.equal(normalizeCommand(normalizeCommand(command)), command);
});

test("backslashes remain literal inside single quotes and even escape pairs still close double quotes", () => {
  for (const command of [String.raw`printf %s 'first\   second'`, String.raw`printf %s "first\\"   second`]) {
    assert.equal(normalizeCommand(command), command.replace('"   second', '" second'));
  }
  assert.equal(normalizeCommand(String.raw`printf %s "first\path   second"`), String.raw`printf %s "first\path   second"`);
});

test("different quoted indentation is not the same declared validation", () => {
  const changed = registered.replaceAll("    mytable", " mytable");
  assert.notEqual(normalizeCommand(changed), normalizeCommand(registered));
  assert.equal(canonicalDeclaredValidationMembers(changed, [registered]), undefined);
  assert.equal(reviewerCorrectionValidation([registered], "author", history(changed), 50).ready, false);
});

test("the original heredoc preserves its registered identity in native display and acceptance", () => {
  const native = history(original);
  assert.deepEqual(observedMissionValidation([registered], "author", native, 50), {
    attempts: [{ command: registered, exit_code: 0, started_ms: 100, completed_ms: 110 }],
    not_observed: [], omitted_attempts: 0,
  });
  assert.equal(reviewerCorrectionValidation([registered], "author", native, 50).ready, true);
});

test("absolute Windows and POSIX call-operator paths retain existing identities", () => {
  for (const executable of [String.raw`C:\tools\python.exe`, "C:/tools/python.exe", String.raw`\\server\tools\python.exe`, "/opt/tools/python"]) {
    assert.equal(normalizeCommand(`& '${executable}'   --version`), `${executable} --version`);
  }
  assert.notEqual(normalizeCommand("& 'relative-tool' --version"), normalizeCommand("relative-tool --version"));
});
