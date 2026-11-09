# Compatibility entry: the current desktop application is Electron.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'buildDesktopBridge.ps1')
