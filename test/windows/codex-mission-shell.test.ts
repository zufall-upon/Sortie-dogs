import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCodexMissionShell } from "../../dist/codex/mission-shell.js";

const exec = promisify(execFile);
test("Windows Mission executes literal PowerShell and preserves command failures", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sortie codex shell 日本語 "));
  try {
    const shell = await resolveCodexMissionShell();
    assert.match(shell.description, /PowerShell 7/);
    const run = async (source: string) => {
      const [command, ...args] = shell.command(source);
      return exec(command, args, { cwd: directory, windowsHide: true });
    };
    await writeFile(join(directory, "check with spaces.mjs"), "console.log(process.argv[2]); process.exit(Number(process.argv[3]))");
    const node = process.execPath.replaceAll("'", "''");
    const source = `& '${node}' './check with spaces.mjs' '日本語 $literal a b'`;
    assert.equal((await run(source + " 0")).stdout.trim(), "日本語 $literal a b");
    await assert.rejects(run(source + " 7"), (error: any) => error.code === 7);
    await assert.rejects(run("Write-Error 'failed check'"), (error: any) => error.code === 1);
    await assert.rejects(run("throw 'failed check'"), (error: any) => error.code === 1);
    await assert.rejects(run("exit 9"), (error: any) => error.code === 9);
    await assert.rejects(run("Get-NotAnExistingCommand"), (error: any) => error.code === 1);
    const pinned = await resolveCodexMissionShell(shell.command("")[0]);
    assert.deepEqual(pinned.command("Get-Location"), shell.command("Get-Location"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows Mission rejects missing or non-absolute PowerShell selections before execution", { skip: process.platform !== "win32" }, async () => {
  for (const executable of ["pwsh.exe", "C:\\missing-sortie-shell\\pwsh.exe", "C:\\Windows\\System32\\cmd.exe"])
    await assert.rejects(resolveCodexMissionShell(executable), /existing|absolute/);
});
