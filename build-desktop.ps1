# Build the Windows x64 installer from this checkout. Arguments are forwarded without shell interpolation.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/build-desktop.mjs') @args
exit $LASTEXITCODE
