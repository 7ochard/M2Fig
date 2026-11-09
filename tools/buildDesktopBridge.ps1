# Compatibility entry: build the active M2Fig R4 line.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'buildDesktopBridgeR4.ps1')
