[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$RuntimeRoot,

  [ValidateSet('bare', 'sortie')]
  [string]$Arm = 'sortie',

  [switch]$Once,

  [ValidateRange(1, 300)]
  [int]$IntervalSeconds = 5
)

$ErrorActionPreference = 'Stop'
$runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
$statePath = Join-Path $runtimePath 'frontierharness-state.json'
$heartbeatPath = Join-Path $runtimePath "$Arm-controller.stderr.log"
$resultPath = Join-Path $runtimePath "$Arm-controller-result.json"
$lastHeartbeat = $null

function Select-Number($Value) {
  if ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or
      $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]) { return $Value }
  return $null
}

function Write-MonitorEvent([System.Collections.IDictionary]$Value) {
  Write-Output (('[frontiermonitor] ' + ($Value | ConvertTo-Json -Compress -Depth 5)))
}

function Read-SelectedState {
  if (-not [IO.File]::Exists($statePath)) {
    return [ordered]@{ kind = 'state'; arm = $Arm; availability = 'missing' }
  }
  try {
    $value = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
    $armState = $value.arms.$Arm
    return [ordered]@{
      kind = 'state'
      arm = $Arm
      availability = 'available'
      preflight_status = [string]$value.preflight.status
      prepared_status = [string]$value.prepared.status
      attempted = $armState.attempted -eq $true
      started_at = if ($armState.started_at -is [string]) { $armState.started_at } else { $null }
      active_pid = Select-Number $armState.active_pid
      run_status = if ($armState.run.status -is [string]) { $armState.run.status } else { $null }
      exit = Select-Number $armState.run.exit
      timed_out = $armState.run.timed_out -eq $true
      watchdog = if ($armState.run.watchdog -is [string]) { $armState.run.watchdog } else { $null }
      operation_failure = if ($armState.run.operation_failure -is [string]) { $armState.run.operation_failure } else { $null }
      terminal_outcome = if ($armState.run.terminal_outcome -is [string]) { $armState.run.terminal_outcome } else { $null }
      expected_operation_status = if ($armState.run.expected_operation.status -is [string]) {
        $armState.run.expected_operation.status
      } else { $null }
      stopped_reason = if ($value.stopped.reason -is [string]) { $value.stopped.reason } else { $null }
    }
  } catch {
    return [ordered]@{ kind = 'state'; arm = $Arm; availability = 'temporarily-unavailable' }
  }
}

function Read-SelectedHeartbeat {
  if (-not [IO.File]::Exists($heartbeatPath)) { return $null }
  try {
    $lines = @(Get-Content -LiteralPath $heartbeatPath -Tail 200 -ErrorAction Stop)
    [array]::Reverse($lines)
    foreach ($line in $lines) {
      if ($line -isnot [string] -or -not $line.StartsWith('[frontierharness] ')) { continue }
      $value = $line.Substring(18) | ConvertFrom-Json
      if ($value.phase -ne "run-arm:$Arm") { continue }
      return [ordered]@{
        kind = 'heartbeat'
        arm = $Arm
        phase = "run-arm:$Arm"
        pid = Select-Number $value.pid
        elapsed_seconds = Select-Number $value.elapsed_seconds
        last_activity_seconds = Select-Number $value.last_activity_seconds
        last_progress_seconds = Select-Number $value.last_progress_seconds
        progress_changes = Select-Number $value.progress_changes
        stdout_bytes = Select-Number $value.stdout_bytes
        stderr_bytes = Select-Number $value.stderr_bytes
      }
    }
  } catch {}
  return $null
}

function Read-SelectedResult {
  if (-not [IO.File]::Exists($resultPath)) { return $null }
  try {
    $value = [IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
    return [ordered]@{
      kind = 'controller-result'
      arm = $Arm
      status = if ($value.status -in @('complete', 'failed', 'launch-failed')) { $value.status } else { 'unknown' }
      exit_code = Select-Number $value.exit_code
      completed_at = if ($value.completed_at -is [string]) { $value.completed_at } else { $null }
    }
  } catch { return $null }
}

do {
  Write-MonitorEvent (Read-SelectedState)
  $heartbeat = Read-SelectedHeartbeat
  if ($null -ne $heartbeat) {
    $encoded = $heartbeat | ConvertTo-Json -Compress
    if ($encoded -ne $lastHeartbeat) {
      Write-MonitorEvent $heartbeat
      $lastHeartbeat = $encoded
    }
  }
  $result = Read-SelectedResult
  if ($null -ne $result) { Write-MonitorEvent $result }
  if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
} while (-not $Once)
