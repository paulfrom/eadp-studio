# Materialize the fixed DSH source recorded in release.lock.json; see scripts/dependence-update.mjs.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
foreach ($tool in @('node', 'git', 'tar')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Error "error: '$tool' is required to update the fixed DSH source."
    exit 1
  }
}
node (Join-Path (Get-Location) 'scripts/dependence-update.mjs')
exit $LASTEXITCODE
