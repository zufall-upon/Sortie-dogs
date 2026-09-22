import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

assert.equal(process.platform, "win32", "Windows suite requires Windows");
const controller = readFileSync(new URL("../../scripts/full-test-controller.ps1", import.meta.url), "utf8");
const execFileAsync = promisify(execFile);

it("consumes complete redirected lines before EOF and keeps only the unfinished suffix", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "controller-stream-"));
  try {
    const probe = join(root, "probe.ps1");
    const definitions = controller.slice(0, controller.indexOf("if ($Mode -eq 'Launch')"));
    await writeFile(probe, definitions + `
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$maxLogBytes = 256
$state = [pscustomobject]@{ phase='queued'; runner_started_at=$null; total_files=$null; current_file=$null; progress=0; progress_truncated=$false; files=@(); output_truncated=[pscustomobject]@{stdout=$false;stderr=$false} }
$redirect = Join-Path $testRoot 'stdout.redirect'
$log = Join-Path $testRoot 'stdout.log'
$offset = [long]0
$pending = ''
$output = 'SORTIE_FULL_FILE_OUTPUT {"phase":"nonintegration","path":"test/sample.test.ts","line":"ok 1"}'
$partial = $output.Substring(0, 30)
[IO.File]::WriteAllText($redirect, "SORTIE_FULL_TEST_RUNNER_STARTED\r\n" + 'SORTIE_FULL_PROGRESS {"status":"enqueued","phase":"scheduler","paths":["test/sample.test.ts"]}' + "\n" + $partial)
Read-RedirectOutput $redirect ([ref]$offset) ([ref]$pending) $log $state 'stdout' $true $false
$startedBeforeEof = $null -ne $state.runner_started_at
$pendingMatches = $pending -eq $partial
$totalBeforeEof = $state.total_files
Read-RedirectOutput $redirect ([ref]$offset) ([ref]$pending) $log $state 'stdout' $true $false
[IO.File]::AppendAllText($redirect, $output.Substring(30) + "\n" + 'SORTIE_FULL_PROGRESS {"status":"completed","phase":"nonintegration","paths":["test/sample.test.ts"]}' + "\n" + 'unfinished line')
Read-RedirectOutput $redirect ([ref]$offset) ([ref]$pending) $log $state 'stdout' $true $false
$completedBeforeEof = $state.progress
$suffixMatches = $pending -eq 'unfinished line'
Read-RedirectOutput $redirect ([ref]$offset) ([ref]$pending) $log $state 'stdout' $true $true
[ordered]@{ started_before_eof=$startedBeforeEof; pending_matches=$pendingMatches; total_before_eof=$totalBeforeEof; completed_before_eof=$completedBeforeEof; suffix_matches=$suffixMatches; pending_after_flush=$pending; output_lines=$state.files[0].output_lines; log_bytes=([IO.FileInfo]$log).Length; truncated=$state.output_truncated.stdout } | ConvertTo-Json -Compress
`);
    const { stdout } = await execFileAsync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", probe, "-Repository", root], { timeout: 15_000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.started_before_eof, true);
    assert.equal(result.pending_matches, true);
    assert.equal(result.total_before_eof, 1);
    assert.equal(result.completed_before_eof, 1);
    assert.equal(result.suffix_matches, true);
    assert.equal(result.pending_after_flush, "");
    assert.equal(result.output_lines, 1);
    assert.ok(result.log_bytes <= 256);
    assert.equal(result.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("records external-child completion and runner timeout as distinct terminal artifacts", async () => {
  for (const exit of [0, 124]) {
    const root = await mkdtemp(join(process.cwd(), "_testenv", "controller-child-"));
    try {
      const runId = "fixture-run";
      const dir = join(root, "_testenv", runId);
      await mkdir(dir, { recursive: true });
      const npm = join(root, "npm.cmd");
      const child = join(root, "child.cjs");
      await writeFile(npm, `@echo off\r\n"${process.execPath}" "${child}"\r\nexit /b %ERRORLEVEL%\r\n`);
      await writeFile(child, `console.log('SORTIE_FULL_TEST_RUNNER_STARTED');\nconsole.log('SORTIE_FULL_PROGRESS ' + JSON.stringify({status:'enqueued',phase:'scheduler',paths:['test/fixture.test.ts']}));\nconsole.log('SORTIE_FULL_PROGRESS ' + JSON.stringify({status:'completed',phase:'nonintegration',paths:['test/fixture.test.ts']}));\nsetTimeout(()=>process.exit(${exit}),100);\n`);
      const manifest = {
        run_id: runId, repository: root, controller_path: resolve("scripts/full-test-controller.ps1"),
        outer_deadline_seconds: 2400, runner_deadline_seconds: 1790,
        npm_path: npm, npm_arguments: ["run", "test:full"], git: { head: "fixture", dirty: false, dirty_count: 0 },
        state_path: join(dir, "state.json"), result_path: join(dir, "result.json"),
        stdout_path: join(dir, "stdout.log"), stderr_path: join(dir, "stderr.log"),
        stdout_redirect_path: join(dir, "stdout.redirect"), stderr_redirect_path: join(dir, "stderr.redirect"),
      };
      const manifestJson = JSON.stringify(manifest);
      await writeFile(join(dir, "manifest.json"), manifestJson);
      await writeFile(join(dir, "launch.marker"), JSON.stringify({ run_id: runId, manifest_sha256: createHash("sha256").update(manifestJson).digest("hex") }));
      await writeFile(manifest.state_path, JSON.stringify({ status: "queued", controller_pid: null, child_pid: null,
        started_at: null, deadline_at: null, heartbeat: null, phase: "queued", runner_started_at: null,
        progress: 0, total_files: null, current_file: null, scheduler_valid: null, files: [], progress_truncated: false,
        exit: null, cleanup_established: null, result_available: false,
        output_truncated: { stdout: false, stderr: false }, output_paths: { stdout: manifest.stdout_path, stderr: manifest.stderr_path },
        state_path: manifest.state_path, result_path: manifest.result_path }));
      const execution = execFileAsync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", manifest.controller_path,
        "-Mode", "Controller", "-RunId", runId, "-Repository", root], { timeout: 15_000 });
      if (exit === 0) await execution;
      else await assert.rejects(execution, { code: 1 });
      const result = JSON.parse(await readFile(manifest.result_path, "utf8"));
      const state = JSON.parse(await readFile(manifest.state_path, "utf8"));
      assert.equal(result.exit, exit);
      assert.equal(result.status, exit === 0 ? "complete" : "timed-out");
      assert.equal(result.phase, exit === 0 ? "complete" : "runner-timeout");
      assert.equal(result.cleanup_established, true);
      assert.equal(result.progress, 1);
      assert.equal(state.result_available, true);
      assert.ok(state.child_pid > 0 && state.controller_pid > 0 && state.child_pid !== state.controller_pid);
      assert.equal(await readFile(join(dir, "manifest.json"), "utf8"), manifestJson);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
