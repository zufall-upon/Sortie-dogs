import assert from "node:assert/strict";
import test from "node:test";
import { codexPowerShellCommand, resolveCodexMissionShell } from "../dist/codex/mission-shell.js";

test("PowerShell argv keeps the literal command, executable boundary and failure exit trailer", () => {
  const executable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const source = '$value = "日本語 $literal"; & "tool with spaces.exe" "a b"';
  const command = codexPowerShellCommand(executable, source);
  assert.deepEqual(command.slice(0, 4), [executable, "-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(command.length, 5);
  assert.equal(command[4], source + "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }");
});

test("POSIX Mission retains bash and does not silently select a Windows shell", { skip: process.platform === "win32" }, async () => {
  const shell = await resolveCodexMissionShell();
  assert.deepEqual(shell.command("node check.mjs"), ["/bin/bash", "-c", "node check.mjs"]);
  await assert.rejects(resolveCodexMissionShell("C:\\pwsh.exe"), /only supported on Windows/);
});
