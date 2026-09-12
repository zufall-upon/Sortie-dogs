import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const controller = readFileSync(new URL("../scripts/full-test-controller.ps1", import.meta.url), "utf8");
const monitor = readFileSync(new URL("../scripts/monitor-full-test.ps1", import.meta.url), "utf8");
const execFileAsync = promisify(execFile);

describe("durable full-test controller contract", () => {
  it("launches one limited, non-overlapping unlimited scheduled task", () => {
    assert.match(controller, /MultipleInstances IgnoreNew/u);
    assert.match(controller, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/u);
    assert.match(controller, /WindowsIdentity\]::GetCurrent\(\)\.Name/u);
    assert.match(controller, /New-ScheduledTaskPrincipal.*RunLevel Limited/su);
    assert.match(controller, /Register-ScheduledTask[\s\S]*Start-ScheduledTask/u);
    assert.equal((controller.match(/Start-ScheduledTask -TaskName/g) ?? []).length, 1);
    assert.match(controller, /Write-CreateNewJson \$manifestPath/u);
    assert.match(controller, /Write-CreateNewJson \$markerPath/u);
    assert.match(controller, /Write-CreateNewJson \$controllerMarkerPath/u);
    assert.match(controller, /duplicate launch or retry rejected/u);
  });

  it("pins the exact npm process and immutable bounded records", () => {
    assert.match(controller, /npm_path=\$npm/u);
    assert.match(controller, /npm_arguments=@\('run','test:full'\)/u);
    assert.match(controller, /Start-Process -FilePath \(\[IO\.Path\]::GetFullPath\(\[string\]\$manifest\.npm_path\)\)/u);
    assert.match(controller, /-WorkingDirectory \$repository/u);
    assert.match(controller, /max_log_bytes=\$maxLogBytes/u);
    assert.match(controller, /max_progress_files=\$maxProgressFiles/u);
    assert.match(controller, /manifest changed after launch/u);
    assert.match(controller, /manifest artifact path rejected/u);
  });

  it("atomically overwrites an existing state without File.Replace", () => {
    assert.match(controller, /if \(\[IO\.File\]::Exists\(\$path\)\) \{ \[IO\.File\]::Move\(\$tmp, \$path, \$true\) \}/u);
    assert.doesNotMatch(controller, /\[IO\.File\]::Replace\(/u);
  });

  it("retries only transient sharing violations for bounded state and result writes", () => {
    assert.match(controller, /\$writeRetryAttempts = 5/u);
    assert.match(controller, /function Invoke-SharingViolationRetry/u);
    assert.match(controller, /catch \[IO\.IOException\]/u);
    assert.match(controller, /\(\$_\.Exception\.HResult -band 0xFFFF\) -eq 32/u);
    assert.match(controller, /if \(-not \$isSharingViolation -or \$attempt -eq \$writeRetryAttempts\) \{ throw \}/u);
    assert.match(controller, /Start-Sleep -Milliseconds \$writeRetryDelayMilliseconds/u);
    assert.match(controller, /function Write-CreateNewJson[\s\S]*?Invoke-SharingViolationRetry[\s\S]*?\[IO\.File\]::Open/u);
    assert.match(controller, /function Write-AtomicJson[\s\S]*?Invoke-SharingViolationRetry[\s\S]*?\[IO\.File\]::Move/u);
    assert.match(controller, /finally \{[\s\S]*?\[IO\.File\]::Exists\(\$tmp\)[\s\S]*?\[IO\.File\]::Delete\(\$tmp\)/u);
  });

  it("derives every persistent artifact from the bounded _testenv run directory", () => {
    assert.match(controller, /\$testRoot\s*=\s*\[IO\.Path\]::GetFullPath\(\(Join-Path \$repository '_testenv'\)\)/u);
    assert.match(
      controller,
      /function Get-RunDirectory[\s\S]*?Assert-RunId \$id[\s\S]*?\$dir\s*=\s*\[IO\.Path\]::GetFullPath\(\(Join-Path \$testRoot \$id\)\)[\s\S]*?\$dir\.StartsWith\(\$testRoot\.TrimEnd\('\\'\) \+ '\\',[\s\S]*?throw 'path traversal rejected'[\s\S]*?return \$dir/u,
    );

    assert.match(
      controller,
      /\$dir = Get-RunDirectory \$RunId[\s\S]*?\$manifestPath = Join-Path \$dir 'manifest\.json'[\s\S]*?\$markerPath = Join-Path \$dir 'launch\.marker'/u,
    );
    assert.match(
      controller,
      /state_path=\(Join-Path \$dir 'state\.json'\); result_path=\(Join-Path \$dir 'result\.json'\); stdout_path=\(Join-Path \$dir 'stdout\.log'\); stderr_path=\(Join-Path \$dir 'stderr\.log'\)/u,
    );
    assert.match(
      controller,
      /\$dir = Get-RunDirectory \$RunId[\s\S]*?\$controllerMarkerPath = Join-Path \$dir 'controller\.marker'[\s\S]*?Assert-ManifestArtifact \$manifest\.state_path \(Join-Path \$dir 'state\.json'\)[\s\S]*?Assert-ManifestArtifact \$manifest\.result_path \(Join-Path \$dir 'result\.json'\)[\s\S]*?Assert-ManifestArtifact \$manifest\.stdout_path \(Join-Path \$dir 'stdout\.log'\)[\s\S]*?Assert-ManifestArtifact \$manifest\.stderr_path \(Join-Path \$dir 'stderr\.log'\)/u,
    );
    assert.match(
      controller,
      /Write-CreateNewJson \$manifestPath \$manifest[\s\S]*?Write-CreateNewJson \$markerPath[\s\S]*?Write-CreateNewJson \$manifest\.state_path \$state[\s\S]*?Write-CreateNewJson \$controllerMarkerPath[\s\S]*?WriteAllText\(\$manifest\.stdout_path[\s\S]*?WriteAllText\(\$manifest\.stderr_path[\s\S]*?Write-CreateNewJson \$manifest\.result_path/u,
    );
  });

  it("parses runner JSON metadata without retaining raw marker output in state", () => {
    assert.match(controller, /SORTIE_FULL_TEST_RUNNER_STARTED/u);
    assert.match(controller, /SORTIE_FULL_FILE_OUTPUT\\s\+\(\.\+\)/u);
    assert.match(controller, /Convert-MarkerJson \$Matches\[1\]/u);
    assert.match(controller, /Set-FileProgress/u);
    assert.match(controller, /SORTIE_FULL_SCHEDULER\\s\+\(\.\+\)/u);
    assert.doesNotMatch(controller, /\$state\.(?:line|raw_output|message)\s*=/u);
  });

  it("encloses the runner deadline and fails closed on process-tree cleanup", () => {
    assert.match(controller, /runnerDeadlineSeconds = 1790/u);
    assert.match(controller, /OuterDeadlineSeconds = 1800/u);
    assert.match(controller, /outer_deadline_seconds -le \[int\]\$manifest\.runner_deadline_seconds/u);
    assert.match(controller, /taskkill\.exe \/PID \$process\.Id \/T \/F/u);
    assert.match(controller, /cleanup-failed/u);
    assert.match(controller, /Write-CreateNewJson \$manifest\.result_path/u);
    assert.match(controller, /Write-CreateNewJson \$manifest\.result_path[\s\S]*\$state\.result_available = \$true[\s\S]*Write-AtomicJson \$state\.state_path/u);
  });

  it("polls redirected files without DataReceived callbacks", () => {
    assert.doesNotMatch(controller, /DataReceivedEventHandler|BeginOutputReadLine|BeginErrorReadLine/u);
    assert.match(
      controller,
      /Start-Process[\s\S]*?-RedirectStandardOutput \$manifest\.stdout_redirect_path[\s\S]*?-RedirectStandardError \$manifest\.stderr_redirect_path/u,
    );
    assert.match(
      controller,
      /while \(-not \$process\.HasExited\)[\s\S]*?Read-RedirectOutput \$manifest\.stdout_redirect_path[\s\S]*?Read-RedirectOutput \$manifest\.stderr_redirect_path[\s\S]*?Redirect progress is best-effort[\s\S]*?\$state\.heartbeat=/u,
    );
    assert.match(controller, /function Read-RedirectOutput[\s\S]*?Add-BoundedLog[\s\S]*?Parse-Progress/u);
    assert.match(controller, /finally \{[\s\S]*?\[IO\.File\]::Delete\(\$redirectPath\)[\s\S]*?Write-CreateNewJson \$manifest\.result_path/u);
  });

  it("keeps monitor read-only, allowlisted, and supports one-shot operation", () => {
    assert.match(monitor, /\[switch\]\$Once/u);
    assert.doesNotMatch(monitor, /Start-Process|Register-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|taskkill|Write-|Set-Content|Add-Content/u);
    assert.match(monitor, /complete output allowlist/u);
    assert.match(monitor, /output_paths/u);
    assert.match(monitor, /files=@\(\$state\.files\)/u);
    assert.match(monitor, /catch \[System\.IO\.IOException\]/u);
  });

  it("consumes complete redirected lines before EOF and keeps only the unfinished suffix", { skip: process.platform !== "win32" }, async () => {
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
      assert.equal(result.output_lines, 1, "idle polling must not replay completed lines");
      assert.ok(result.log_bytes <= 256);
      assert.equal(result.truncated, true, "log truncation must not stop progress parsing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records external-child completion and runner timeout as distinct terminal artifacts", { skip: process.platform !== "win32" }, async () => {
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
          outer_deadline_seconds: 1800, runner_deadline_seconds: 1790,
          npm_path: npm, npm_arguments: ["run", "test:full"], git: { head: "fixture", dirty: false, dirty_count: 0 },
          state_path: join(dir, "state.json"), result_path: join(dir, "result.json"),
          stdout_path: join(dir, "stdout.log"), stderr_path: join(dir, "stderr.log"),
          stdout_redirect_path: join(dir, "stdout.redirect"), stderr_redirect_path: join(dir, "stderr.redirect"),
        };
        const manifestJson = JSON.stringify(manifest);
        await writeFile(join(dir, "manifest.json"), manifestJson);
        await writeFile(join(dir, "launch.marker"), JSON.stringify({ run_id: runId,
          manifest_sha256: createHash("sha256").update(manifestJson).digest("hex") }));
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
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
