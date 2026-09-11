[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$RunId,
  [string]$Repository=(Split-Path -Parent $PSScriptRoot),
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$') { throw 'invalid run id' }
$root=[IO.Path]::GetFullPath((Join-Path $Repository '_testenv'))
$dir=[IO.Path]::GetFullPath((Join-Path $root $RunId))
if (-not $dir.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'path traversal rejected' }
$statePath=Join-Path $dir 'state.json'

do {
  try {
    $state=Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    # Explicit projection is the monitor's complete output allowlist.
    $view=[ordered]@{
      schema=$state.schema;run_id=$state.run_id;status=$state.status;created_at=$state.created_at;started_at=$state.started_at;deadline_at=$state.deadline_at
      heartbeat=$state.heartbeat;progress=$state.progress;total_files=$state.total_files;phase=$state.phase;current_file=$state.current_file;runner_started_at=$state.runner_started_at
      scheduler_valid=$state.scheduler_valid;exit=$state.exit;cleanup_established=$state.cleanup_established;result_available=$state.result_available
      progress_truncated=$state.progress_truncated;output_truncated=$state.output_truncated;output_paths=$state.output_paths;files=@($state.files)
    }
    $view | ConvertTo-Json -Depth 8 -Compress
  } catch [System.IO.IOException] {
    # Atomic replacement can make the file briefly unavailable.
  } catch [System.Management.Automation.ItemNotFoundException] {
  } catch [System.ArgumentException] {
    # A concurrent writer may leave this read without a complete JSON document.
  }
  if (-not $Once) { Start-Sleep -Seconds 2 }
} while (-not $Once)
