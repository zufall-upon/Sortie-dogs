[CmdletBinding()]
param(
  [Parameter(Mandatory, Position=0)][ValidateSet('prepare','verify-publish')][string]$Action,
  [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [string]$Manifest = '.opencode/release.json'
)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'release.mjs') $Action --version $Version --manifest $Manifest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
