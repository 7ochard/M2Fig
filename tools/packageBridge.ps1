# Compatibility entry: package M2Fig R4; existing r3 artifacts stay frozen.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'packageBridgeR4.ps1')
