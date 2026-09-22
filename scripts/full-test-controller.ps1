[CmdletBinding()]
param(
  [ValidateSet('Launch','Controller')][string]$Mode = 'Launch',
  [string]$RunId,
  [string]$Repository = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(2100,86400)][int]$OuterDeadlineSeconds = 2400
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
$writeRetryAttempts = 5
$writeRetryDelayMilliseconds = 100
$stateWriteIntervalMilliseconds = 1000

function Assert-RunId([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$') { throw 'invalid run id' }
}
function Get-RunDirectory([string]$id) {
  Assert-RunId $id
  $dir = [IO.Path]::GetFullPath((Join-Path $testRoot $id))
  if (-not $dir.StartsWith($testRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'path traversal rejected' }
  return $dir
}
function Invoke-SharingViolationRetry([scriptblock]$operation) {
  for ($attempt = 1; $attempt -le $writeRetryAttempts; $attempt++) {
    try { & $operation; return }
    catch [IO.IOException] {
      $isSharingViolation = ($_.Exception.HResult -band 0xFFFF) -eq 32
      if (-not $isSharingViolation -or $attempt -eq $writeRetryAttempts) { throw }
      Start-Sleep -Milliseconds $writeRetryDelayMilliseconds
    }
  }
}
function Write-CreateNewJson([string]$path, $value) {
  $json = $value | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
  Invoke-SharingViolationRetry {
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  }
}
function Write-AtomicJson([string]$path, $value) {
  $tmp = "$path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($tmp, (($value | ConvertTo-Json -Depth 20 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
    Invoke-SharingViolationRetry {
      if ([IO.File]::Exists($path)) { [IO.File]::Move($tmp, $path, $true) } else { [IO.File]::Move($tmp, $path) }
    }
  } finally {
    if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
  }
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
  if ($line -match '^SORTIE_FULL_PROGRESS\s+(.+)$') {
    $data = Convert-MarkerJson $Matches[1]
    if ($null -eq $data) { return }
    $status = switch ([string]$data.status) { 'enqueued' {'enqueued'} 'started' {'running'} 'completed' {'complete'} default {$null} }
    if ($null -eq $status) { return }
    if ($status -eq 'enqueued' -and $data.phase -eq 'scheduler') { $state.total_files = @($data.paths).Count }
    foreach ($path in @($data.paths)) { Set-FileProgress $state ([string]$path) $status ([string]$data.phase) $false }
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
function Read-RedirectOutput([string]$redirectPath, [ref]$offset, [ref]$pending, [string]$logPath, $state, [string]$streamName, [bool]$parseProgress, [bool]$flush) {
  if ([IO.File]::Exists($redirectPath)) {
    $stream = [IO.File]::Open($redirectPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
      if ($stream.Length -lt [long]$offset.Value) { $offset.Value = [long]0 }
      $stream.Position = [long]$offset.Value
      $remaining = [int]($stream.Length - $stream.Position)
      if ($remaining -gt 0) {
        $bytes = [byte[]]::new($remaining)
        $read = $stream.Read($bytes, 0, $remaining)
        $offset.Value = $stream.Position
        if ($read -gt 0) { $pending.Value += [Text.Encoding]::UTF8.GetString($bytes, 0, $read) }
      }
    } finally { $stream.Dispose() }
  }
  $lines = @([string]$pending.Value -split "`r?`n")
  $completeCount = if ($flush) { $lines.Count } else { [Math]::Max(0, $lines.Count - 1) }
  for ($index = 0; $index -lt $completeCount; $index++) {
    if ($flush -and $index -eq $lines.Count - 1 -and $lines[$index].Length -eq 0) { continue }
    Add-BoundedLog $logPath $lines[$index] $state $streamName
    if ($parseProgress) { Parse-Progress $lines[$index] $state }
  }
  $pending.Value = if ($flush -or $lines.Count -eq 0) { '' } else { $lines[$lines.Count - 1] }
}
function Assert-ManifestArtifact([string]$actual, [string]$expected) {
  if ([IO.Path]::GetFullPath($actual) -ne [IO.Path]::GetFullPath($expected)) { throw 'manifest artifact path rejected' }
}
function Stop-TestOwner($process, [string]$cancelPath) {
  # Let the router close its WSL ownership pipe and await bounded Linux cleanup first.
  [IO.File]::WriteAllText($cancelPath, 'cancel')
  if ($process.WaitForExit(10000)) { return $true }
  & taskkill.exe /PID $process.Id /T /F | Out-Null
  $process.WaitForExit(3000) | Out-Null
  return $false
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
    stdout_redirect_path=(Join-Path $dir 'stdout.redirect'); stderr_redirect_path=(Join-Path $dir 'stderr.redirect')
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
Assert-ManifestArtifact $manifest.stdout_redirect_path (Join-Path $dir 'stdout.redirect')
Assert-ManifestArtifact $manifest.stderr_redirect_path (Join-Path $dir 'stderr.redirect')
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
$stdoutOffset = [long]0
$stderrOffset = [long]0
$stdoutPending = ''
$stderrPending = ''
try {
  $startedAt = [DateTime]::UtcNow
  $deadline = $startedAt.AddSeconds([int]$manifest.outer_deadline_seconds)
  $state.controller_pid = $PID
  $state.started_at = $startedAt.ToString('o')
  $state.deadline_at = $deadline.ToString('o')
  Update-State $state 'running' @{ phase='starting' }
  [IO.File]::WriteAllText($manifest.stdout_path, '', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($manifest.stderr_path, '', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($manifest.stdout_redirect_path, '', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($manifest.stderr_redirect_path, '', [Text.UTF8Encoding]::new($false))
  $previousCancelPath = $env:SORTIE_TEST_CANCEL_FILE
  $env:SORTIE_TEST_CANCEL_FILE = Join-Path $dir 'cancel.request'
  try {
    $process = Start-Process -FilePath ([IO.Path]::GetFullPath([string]$manifest.npm_path)) -ArgumentList @($manifest.npm_arguments) -WorkingDirectory $repository -NoNewWindow -PassThru -RedirectStandardOutput $manifest.stdout_redirect_path -RedirectStandardError $manifest.stderr_redirect_path
  } finally { $env:SORTIE_TEST_CANCEL_FILE = $previousCancelPath }
  $processStarted = $true
  $state.child_pid = $process.Id
  Update-State $state 'running' @{ phase='npm' }
  $nextStateWrite = [DateTime]::UtcNow
  while (-not $process.HasExited) {
    if ([DateTime]::UtcNow -ge $deadline) {
      $cleanupEstablished = Stop-TestOwner $process (Join-Path $dir 'cancel.request')
      Start-Sleep -Milliseconds 500
      $process.Refresh()
      if (-not $process.HasExited -or -not $cleanupEstablished) { $cleanupEstablished = $false; $terminalPhase = 'cleanup-failed'; throw 'timeout cleanup could not be established' }
      $terminalStatus = 'timed-out'; $terminalPhase = 'timeout'; break
    }
    Start-Sleep -Milliseconds 250
    try {
      Read-RedirectOutput $manifest.stdout_redirect_path ([ref]$stdoutOffset) ([ref]$stdoutPending) $manifest.stdout_path $state 'stdout' $true $false
      Read-RedirectOutput $manifest.stderr_redirect_path ([ref]$stderrOffset) ([ref]$stderrPending) $manifest.stderr_path $state 'stderr' $false $false
    } catch {
      # Redirect progress is best-effort; the main loop still owns heartbeat, deadline, and terminal result.
    }
    $now = [DateTime]::UtcNow
    if ($now -ge $nextStateWrite) {
      $state.heartbeat=$now.ToString('o')
      Write-AtomicJson $state.state_path $state
      $nextStateWrite = $now.AddMilliseconds($stateWriteIntervalMilliseconds)
    }
  }
  $process.WaitForExit()
  try {
    Read-RedirectOutput $manifest.stdout_redirect_path ([ref]$stdoutOffset) ([ref]$stdoutPending) $manifest.stdout_path $state 'stdout' $true $true
    Read-RedirectOutput $manifest.stderr_redirect_path ([ref]$stderrOffset) ([ref]$stderrPending) $manifest.stderr_path $state 'stderr' $false $true
  } catch {
    # Final redirect polling remains best-effort; terminal state is authoritative.
  }
  $exitCode = $process.ExitCode
  if ($terminalStatus -ne 'timed-out') {
    if ($exitCode -eq 124) { $terminalStatus = 'timed-out'; $terminalPhase = 'runner-timeout' }
    else { $terminalStatus = if ($exitCode -eq 0) {'complete'} else {'failed'}; $terminalPhase = 'complete' }
  }
} catch {
  if ($processStarted -and -not $process.HasExited) {
    $cleanupEstablished = Stop-TestOwner $process (Join-Path $dir 'cancel.request')
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if (-not $process.HasExited) { $cleanupEstablished = $false; $terminalPhase = 'cleanup-failed' }
  }
} finally {
  foreach ($redirectPath in @($manifest.stdout_redirect_path, $manifest.stderr_redirect_path)) {
    try { if ([IO.File]::Exists($redirectPath)) { [IO.File]::Delete($redirectPath) } } catch { $cleanupEstablished = $false; $terminalPhase = 'cleanup-failed' }
  }
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
