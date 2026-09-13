[CmdletBinding(DefaultParameterSetName = 'Launch')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Launch')]
  [Parameter(Mandatory, ParameterSetName = 'Controller')]
  [string]$Manifest,

  [Parameter(ParameterSetName = 'Launch')]
  [Parameter(ParameterSetName = 'Controller')]
  [ValidateSet('sortie')]
  [string]$Arm = 'sortie',

  [Parameter(ParameterSetName = 'Launch')]
  [ValidatePattern('^[A-Za-z0-9_.-]+$')]
  [string]$TaskName = 'SortieDogs-Frontier-Sortie',

  [Parameter(ParameterSetName = 'Launch')]
  [switch]$NoMonitor,

  [Parameter(Mandatory, ParameterSetName = 'Controller')]
  [switch]$Controller,

  [Parameter(Mandatory, ParameterSetName = 'Controller')]
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'

function Resolve-ManifestRelativePath([string]$ManifestPath, [string]$Value) {
  if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
  return [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ManifestPath) $Value))
}

function Write-AtomicJson([string]$Path, [System.Collections.IDictionary]$Value) {
  $temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Compress) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Quote-TaskArgument([string]$Value) {
  if ($Value -match '["\r\n]') { throw 'Task arguments cannot contain quotes or newlines.' }
  return '"' + $Value + '"'
}

$manifestPath = [IO.Path]::GetFullPath($Manifest)
$manifestValue = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$runtimeRoot = Resolve-ManifestRelativePath $manifestPath ([string]$manifestValue.paths.runtime_root)
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$statePath = Join-Path $runtimeRoot 'frontierharness-state.json'
$markerPath = Join-Path $runtimeRoot "$Arm-controller-launch.json"
$resultPath = Join-Path $runtimeRoot "$Arm-controller-result.json"
$stdoutPath = Join-Path $runtimeRoot "$Arm-controller.stdout.jsonl"
$stderrPath = Join-Path $runtimeRoot "$Arm-controller.stderr.log"

if ($PSCmdlet.ParameterSetName -eq 'Controller') {
  $exitCode = -1
  $status = 'failed'
  try {
    & $NodePath (Join-Path $PSScriptRoot 'run-local-case-study.mjs') 'run-arm' '--arm' $Arm '--manifest' $manifestPath `
      1> $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
    $status = if ($exitCode -eq 0) { 'complete' } else { 'failed' }
  } finally {
    Write-AtomicJson $resultPath ([ordered]@{
      schema_version = 1
      arm = $Arm
      status = $status
      exit_code = $exitCode
      completed_at = [DateTime]::UtcNow.ToString('o')
    })
  }
  exit $exitCode
}

if ($manifestValue.qualification_only -ne $true) {
  throw 'The scheduled Sortie launcher requires qualification_only:true.'
}
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.preflight.status -ne 'pass' -or $state.prepared.status -ne 'pass' -or
    $null -ne $state.arms.$Arm -or (Test-Path -LiteralPath $markerPath)) {
  throw 'Scheduled launch requires a prepared, unattempted arm without a launch marker.'
}
if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  throw 'The requested scheduled task already exists.'
}

$node = (Get-Command node -ErrorAction Stop).Source
$powerShell = (Get-Process -Id $PID).Path
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
foreach ($value in @($manifestPath, $node, $powerShell, $scriptPath)) {
  if ($value -match '["\r\n]') { throw 'Executable and file paths cannot contain quotes or newlines.' }
}

$markerHandle = [IO.File]::Open($markerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $marker = [ordered]@{
    schema_version = 1
    arm = $Arm
    task_name = $TaskName
    launched_at = [DateTime]::UtcNow.ToString('o')
    controller = 'windows-task-scheduler'
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes((($marker | ConvertTo-Json -Compress) + [Environment]::NewLine))
  $markerHandle.Write($bytes, 0, $bytes.Length)
} finally {
  $markerHandle.Dispose()
}

try {
  $arguments = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Quote-TaskArgument $scriptPath),
    '-Controller', '-Manifest', (Quote-TaskArgument $manifestPath), '-Arm', $Arm, '-NodePath', (Quote-TaskArgument $node)
  ) -join ' '
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $repositoryRoot
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $TaskName
} catch {
  Write-AtomicJson $resultPath ([ordered]@{
    schema_version = 1
    arm = $Arm
    status = 'launch-failed'
    exit_code = $null
    completed_at = [DateTime]::UtcNow.ToString('o')
  })
  throw
}

if (-not $NoMonitor) {
  $monitor = Join-Path $PSScriptRoot 'monitor-scheduled-arm.ps1'
  Start-Process -FilePath $powerShell -WindowStyle Normal -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-TaskArgument $monitor),
    '-RuntimeRoot', (Quote-TaskArgument $runtimeRoot), '-Arm', $Arm
  ) | Out-Null
}

[ordered]@{ status = 'launched'; arm = $Arm; task_name = $TaskName } | ConvertTo-Json -Compress
