import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const controller = readFileSync(new URL("../scripts/full-test-controller.ps1", import.meta.url), "utf8");
const monitor = readFileSync(new URL("../scripts/monitor-full-test.ps1", import.meta.url), "utf8");

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
    assert.match(controller, /FileName = \[IO\.Path\]::GetFullPath\(\[string\]\$manifest\.npm_path\)/u);
    assert.match(controller, /WorkingDirectory = \$repository/u);
    assert.match(controller, /max_log_bytes=\$maxLogBytes/u);
    assert.match(controller, /max_progress_files=\$maxProgressFiles/u);
    assert.match(controller, /manifest changed after launch/u);
    assert.match(controller, /manifest artifact path rejected/u);
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
    assert.match(controller, /OuterDeadlineSeconds = 2100/u);
    assert.match(controller, /outer_deadline_seconds -le \[int\]\$manifest\.runner_deadline_seconds/u);
    assert.match(controller, /taskkill\.exe \/PID \$process\.Id \/T \/F/u);
    assert.match(controller, /cleanup-failed/u);
    assert.match(controller, /Write-CreateNewJson \$manifest\.result_path/u);
    assert.match(controller, /Write-CreateNewJson \$manifest\.result_path[\s\S]*\$state\.result_available = \$true[\s\S]*Write-AtomicJson \$state\.state_path/u);
  });

  it("keeps monitor read-only, allowlisted, and supports one-shot operation", () => {
    assert.match(monitor, /\[switch\]\$Once/u);
    assert.doesNotMatch(monitor, /Start-Process|Register-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|taskkill|Write-|Set-Content|Add-Content/u);
    assert.match(monitor, /complete output allowlist/u);
    assert.match(monitor, /output_paths/u);
    assert.match(monitor, /files=@\(\$state\.files\)/u);
    assert.match(monitor, /catch \[System\.IO\.IOException\]/u);
  });
});
