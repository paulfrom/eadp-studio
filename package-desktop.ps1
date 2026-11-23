# Package the last prepared Windows x64 payload without rebuilding TypeScript/DSH.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/package-desktop.mjs') @args
exit $LASTEXITCODE
