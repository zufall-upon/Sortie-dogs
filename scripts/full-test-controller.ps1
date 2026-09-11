[CmdletBinding()]
param(
  [ValidateSet('Launch','Controller')][string]$Mode = 'Launch',
  [string]$RunId,
  [string]$Repository = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(1791,86400)][int]$OuterDeadlineSeconds = 2100
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath($Repository)
$testRoot = [IO.Path]::GetFullPath((Join-Path $repository '_testenv'))
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
$schema = 'sortie.full-test.v1'
$runnerDeadlineSeconds = 1790
$maxLogBytes = 1048576
$maxProgressFiles = 512

function Assert-RunId([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$') { throw 'invalid run id' }
}
function Get-RunDirectory([string]$id) {
  Assert-RunId $id
  $dir = [IO.Path]::GetFullPath((Join-Path $testRoot $id))
  if (-not $dir.StartsWith($testRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'path traversal rejected' }
  return $dir
}
function Write-CreateNewJson([string]$path, $value) {
  $json = $value | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
function Write-AtomicJson([string]$path, $value) {
  $tmp = "$path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllText($tmp, (($value | ConvertTo-Json -Depth 20 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($path)) { [IO.File]::Replace($tmp, $path, $null) } else { [IO.File]::Move($tmp, $path) }
}
function Read-Json([string]$path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop }
function Get-GitEvidence {
  $head = (& git -C $repository rev-parse HEAD 2>$null).Trim()
  $dirty = @(& git -C $repository status --porcelain 2>$null)
  [ordered]@{ head = $head; dirty = ($dirty.Count -gt 0); dirty_count = $dirty.Count }
}
function Resolve-NpmPath {
  $candidate = @("$env:ProgramFiles\nodejs\npm.cmd", "$env:APPDATA\npm\npm.cmd") | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $candidate) { $candidate = (Get-Command npm.cmd -ErrorAction Stop).Source }
  [IO.Path]::GetFullPath($candidate)
}
function Update-State($state, [string]$status, [hashtable]$extra = @{}) {
  $state.status = $status
  $state.heartbeat = [DateTime]::UtcNow.ToString('o')
  foreach ($key in $extra.Keys) { $state.$key = $extra[$key] }
  Write-AtomicJson $state.state_path $state
}
function Test-ProgressPath([string]$value) {
  return -not [string]::IsNullOrWhiteSpace($value) -and $value.Length -le 260 -and $value -notmatch '[\x00-\x1f]' -and $value -notmatch '(^|[\\/])\.\.?(?:[\\/]|$)'
}
function Find-ProgressFile($state, [string]$path) {
  foreach ($entry in @($state.files)) { if ($entry.file -eq $path) { return $entry } }
  return $null
}
function Set-FileProgress($state, [string]$path, [string]$status, [string]$phase, [bool]$sawOutput) {
  if (-not (Test-ProgressPath $path)) { return }
  $entry = Find-ProgressFile $state $path
  if ($null -eq $entry) {
    if (@($state.files).Count -ge $maxProgressFiles) { $state.progress_truncated = $true; return }
    $entry = [pscustomobject][ordered]@{ file=$path; status='enqueued'; phase=$phase; output_lines=0; updated_at=[DateTime]::UtcNow.ToString('o') }
    $state.files = @($state.files) + $entry
  }
  if ($status -in @('enqueued','running','complete')) { $entry.status = $status }
  if (-not [string]::IsNullOrWhiteSpace($phase) -and $phase.Length -le 64 -and $phase -match '^[A-Za-z0-9_.-]+$') { $entry.phase = $phase; $state.phase = $phase }
  if ($sawOutput -and $entry.output_lines -lt 1000000) { $entry.output_lines = [int]$entry.output_lines + 1 }
  $entry.updated_at = [DateTime]::UtcNow.ToString('o')
  $state.current_file = $path
  $state.progress = @($state.files | Where-Object { $_.status -eq 'complete' }).Count
}
function Convert-MarkerJson([string]$payload) {
  try { return $payload | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
}
function Parse-Progress([string]$line, $state) {
  # State receives only validated marker metadata; marker payload output text is never retained.
  if ($line -match '^SORTIE_FULL_TEST_RUNNER_STARTED(?:\s+(.+))?$') {
    $state.phase = 'runner'
    $state.runner_started_at = [DateTime]::UtcNow.ToString('o')
    return
  }
  if ($line -match '^SORTIE_FULL_FILE_OUTPUT\s+(.+)$') {
    $data = Convert-MarkerJson $Matches[1]
    if ($null -ne $data -and $null -ne $data.path -and $null -ne $data.phase) {
      Set-FileProgress $state ([string]$data.path) 'running' ([string]$data.phase) $true
    }
    return
  }
  if ($line -match '^SORTIE_FULL_SCHEDULER\s+(.+)$') {
    $data = Convert-MarkerJson $Matches[1]
    if ($null -eq $data) { return }
    if ($null -ne $data.files -and [int]$data.files -ge 0 -and [int]$data.files -le 10000) { $state.total_files = [int]$data.files }
    foreach ($transition in @($data.transitions)) {
      $status = switch ([string]$transition.status) { 'enqueued' {'enqueued'} 'started' {'running'} 'completed' {'complete'} default {$null} }
      if ($null -eq $status) { continue }
      foreach ($path in @($transition.paths)) { Set-FileProgress $state ([string]$path) $status ([string]$transition.phase) $false }
    }
    if ($null -ne $data.valid) { $state.scheduler_valid = [bool]$data.valid }
  }
}
function Add-BoundedLog([string]$path, [string]$line, $state, [string]$streamName) {
  if ($line.Length -gt 4096) { $line = $line.Substring(0, 4096); $state.output_truncated.$streamName = $true }
  $bytes = [Text.Encoding]::UTF8.GetByteCount($line + "`n")
  $length = if ([IO.File]::Exists($path)) { ([IO.FileInfo]$path).Length } else { 0 }
  if ($length + $bytes -gt $maxLogBytes) { $state.output_truncated.$streamName = $true; return }
  [IO.File]::AppendAllText($path, $line + "`n", [Text.UTF8Encoding]::new($false))
}
function Assert-ManifestArtifact([string]$actual, [string]$expected) {
  if ([IO.Path]::GetFullPath($actual) -ne [IO.Path]::GetFullPath($expected)) { throw 'manifest artifact path rejected' }
}

if ($Mode -eq 'Launch') {
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows only' }
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  if (-not $RunId) { $RunId = 'full-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + (Get-Random -Maximum 999999) }
  $dir = Get-RunDirectory $RunId
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $manifestPath = Join-Path $dir 'manifest.json'
  $markerPath = Join-Path $dir 'launch.marker'
  $taskName = "SortieDogs-FullTest-$RunId"
  $pwsh = [IO.Path]::GetFullPath((Get-Command pwsh.exe -ErrorAction Stop).Source)
  $npm = Resolve-NpmPath
  $evidence = Get-GitEvidence
  $createdAt = [DateTime]::UtcNow.ToString('o')
  $manifest = [ordered]@{
    schema=$schema; run_id=$RunId; repository=$repository; created_at=$createdAt; task_name=$taskName
    controller_path=$scriptPath; powershell_path=$pwsh; npm_path=$npm; npm_arguments=@('run','test:full'); exact_command="`"$npm`" run test:full"
    runner_deadline_seconds=$runnerDeadlineSeconds; outer_deadline_seconds=$OuterDeadlineSeconds; max_log_bytes=$maxLogBytes; max_progress_files=$maxProgressFiles
    git=$evidence; state_path=(Join-Path $dir 'state.json'); result_path=(Join-Path $dir 'result.json'); stdout_path=(Join-Path $dir 'stdout.log'); stderr_path=(Join-Path $dir 'stderr.log')
  }
  Write-CreateNewJson $manifestPath $manifest
  $hash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-CreateNewJson $markerPath ([ordered]@{ schema=$schema; run_id=$RunId; manifest_sha256=$hash; launched_at=$createdAt })
  $state = [pscustomobject][ordered]@{
    schema=$schema; run_id=$RunId; status='queued'; controller_pid=$null; child_pid=$null; created_at=$createdAt; started_at=$null; deadline_at=$null
    heartbeat=$createdAt; progress=0; total_files=$null; phase='queued'; current_file=$null; runner_started_at=$null; scheduler_valid=$null; exit=$null
    cleanup_established=$null; result_available=$false; progress_truncated=$false; output_truncated=[pscustomobject]@{stdout=$false;stderr=$false}
    output_paths=[pscustomobject]@{stdout=$manifest.stdout_path;stderr=$manifest.stderr_path}; state_path=$manifest.state_path; result_path=$manifest.result_path; files=@()
  }
  Write-CreateNewJson $manifest.state_path $state
  $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Mode Controller -RunId `"$RunId`" -Repository `"$repository`""
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Principal $principal -Force:$false | Out-Null
  try {
    Start-ScheduledTask -TaskName $taskName
  } catch {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Update-State $state 'failed' @{ phase='schedule-start-failed'; cleanup_established=$true }
    $state.result_available = $true
    Write-CreateNewJson $manifest.result_path ([ordered]@{schema=$schema;run_id=$RunId;status='failed';exit=$null;phase='schedule-start-failed';completed_at=[DateTime]::UtcNow.ToString('o');cleanup_established=$true;git=$manifest.git})
    Write-AtomicJson $state.state_path $state
    throw
  }
  Write-Output $RunId
  exit 0
}

Assert-RunId $RunId
$dir = Get-RunDirectory $RunId
$manifestPath = Join-Path $dir 'manifest.json'
$markerPath = Join-Path $dir 'launch.marker'
$controllerMarkerPath = Join-Path $dir 'controller.marker'
$manifest = Read-Json $manifestPath
$marker = Read-Json $markerPath
if ($manifest.run_id -ne $RunId -or $marker.run_id -ne $RunId -or $manifest.repository -ne $repository -or $manifest.controller_path -ne $scriptPath) { throw 'manifest run mismatch' }
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $marker.manifest_sha256) { throw 'manifest changed after launch' }
Assert-ManifestArtifact $manifest.state_path (Join-Path $dir 'state.json')
Assert-ManifestArtifact $manifest.result_path (Join-Path $dir 'result.json')
Assert-ManifestArtifact $manifest.stdout_path (Join-Path $dir 'stdout.log')
Assert-ManifestArtifact $manifest.stderr_path (Join-Path $dir 'stderr.log')
if ([int]$manifest.outer_deadline_seconds -le [int]$manifest.runner_deadline_seconds -or $manifest.npm_arguments.Count -ne 2 -or $manifest.npm_arguments[0] -ne 'run' -or $manifest.npm_arguments[1] -ne 'test:full') { throw 'manifest command rejected' }
if (-not [IO.Path]::IsPathFullyQualified([string]$manifest.npm_path) -or -not (Test-Path -LiteralPath $manifest.npm_path -PathType Leaf)) { throw 'manifest npm path rejected' }
$state = Read-Json $manifest.state_path
if ($state.status -ne 'queued') { throw 'duplicate launch or retry rejected' }
Write-CreateNewJson $controllerMarkerPath ([ordered]@{schema=$schema;run_id=$RunId;controller_pid=$PID;started_at=[DateTime]::UtcNow.ToString('o')})
$process = $null
$processStarted = $false
$terminalStatus = 'failed'
$terminalPhase = 'controller-failed'
$cleanupEstablished = $true
$exitCode = $null
try {
  $startedAt = [DateTime]::UtcNow
  $deadline = $startedAt.AddSeconds([int]$manifest.outer_deadline_seconds)
  $state.controller_pid = $PID
  $state.started_at = $startedAt.ToString('o')
  $state.deadline_at = $deadline.ToString('o')
  Update-State $state 'running' @{ phase='starting' }
  [IO.File]::WriteAllText($manifest.stdout_path, '', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($manifest.stderr_path, '', [Text.UTF8Encoding]::new($false))
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
  $process.StartInfo.FileName = [IO.Path]::GetFullPath([string]$manifest.npm_path)
  foreach ($argument in @($manifest.npm_arguments)) { $process.StartInfo.ArgumentList.Add([string]$argument) }
  $process.StartInfo.WorkingDirectory = $repository
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.CreateNoWindow = $true
  $stateSync = [object]::new()
  $outHandler = [Diagnostics.DataReceivedEventHandler]{
    param($sender,$event)
    if ($null -ne $event.Data) {
      [Threading.Monitor]::Enter($stateSync)
      try { Add-BoundedLog $manifest.stdout_path $event.Data $state 'stdout'; Parse-Progress $event.Data $state; Write-AtomicJson $state.state_path $state } finally { [Threading.Monitor]::Exit($stateSync) }
    }
  }
  $errHandler = [Diagnostics.DataReceivedEventHandler]{
    param($sender,$event)
    if ($null -ne $event.Data) {
      [Threading.Monitor]::Enter($stateSync)
      try { Add-BoundedLog $manifest.stderr_path $event.Data $state 'stderr'; Write-AtomicJson $state.state_path $state } finally { [Threading.Monitor]::Exit($stateSync) }
    }
  }
  $process.add_OutputDataReceived($outHandler)
  $process.add_ErrorDataReceived($errHandler)
  $process.Start() | Out-Null
  $processStarted = $true
  $state.child_pid = $process.Id
  Update-State $state 'running' @{ phase='npm' }
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  while (-not $process.HasExited) {
    if ([DateTime]::UtcNow -ge $deadline) {
      & taskkill.exe /PID $process.Id /T /F | Out-Null
      Start-Sleep -Milliseconds 500
      $process.Refresh()
      if (-not $process.HasExited) { $cleanupEstablished = $false; $terminalPhase = 'cleanup-failed'; throw 'timeout cleanup could not be established' }
      $terminalStatus = 'timed-out'; $terminalPhase = 'timeout'; break
    }
    Start-Sleep -Milliseconds 250
    [Threading.Monitor]::Enter($stateSync)
    try { $state.heartbeat=[DateTime]::UtcNow.ToString('o'); Write-AtomicJson $state.state_path $state } finally { [Threading.Monitor]::Exit($stateSync) }
  }
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  if ($terminalStatus -ne 'timed-out') { $terminalStatus = if ($exitCode -eq 0) {'complete'} else {'failed'}; $terminalPhase = 'complete' }
} catch {
  if ($processStarted -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if (-not $process.HasExited) { $cleanupEstablished = $false; $terminalPhase = 'cleanup-failed' }
  }
} finally {
  $state.exit = $exitCode
  $state.cleanup_established = $cleanupEstablished
  $state.status = $terminalStatus
  $state.phase = $terminalPhase
  $state.heartbeat = [DateTime]::UtcNow.ToString('o')
  Write-CreateNewJson $manifest.result_path ([ordered]@{schema=$schema;run_id=$RunId;status=$terminalStatus;exit=$exitCode;phase=$terminalPhase;completed_at=[DateTime]::UtcNow.ToString('o');cleanup_established=$cleanupEstablished;progress=$state.progress;total_files=$state.total_files;scheduler_valid=$state.scheduler_valid;output_paths=$state.output_paths;output_truncated=$state.output_truncated;git=$manifest.git})
  $state.result_available = $true
  Write-AtomicJson $state.state_path $state
}
if ($terminalStatus -ne 'complete') { exit 1 }
