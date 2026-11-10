param([switch]$Portable)
# Compatibility entry: build the active Mg2Fig V3 desktop line.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'buildDesktopMg2FigV3.ps1') @PSBoundParameters
