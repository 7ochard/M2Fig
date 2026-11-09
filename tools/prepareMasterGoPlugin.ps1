param([string]$RunName = '')
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $taskRoot 'SendToFigma'
foreach ($name in @('manifest.json', 'code.js', 'ui.html')) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $name) -PathType Leaf)) {
    throw "Missing plugin file: $name"
  }
}
$codeHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'code.js') -Algorithm SHA256).Hash
$uiHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'ui.html') -Algorithm SHA256).Hash
$buildKey = $codeHash.Substring(0, 8).ToLowerInvariant() + '-' + $uiHash.Substring(0, 8).ToLowerInvariant()
if (-not $RunName) { $RunName = Get-Date -Format 'yyyyMMdd-HHmmss-fff' }
if ($RunName -notmatch '^[A-Za-z0-9_-]+$') { throw 'RunName must contain only letters, numbers, _ or -.' }
$runtimeRoot = Join-Path $taskRoot "artifacts/runtime/$RunName-$buildKey/SendToFigma"
if (Test-Path -LiteralPath $runtimeRoot) { throw "Runtime already exists; choose another RunName: $runtimeRoot" }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
foreach ($name in @('code.js', 'ui.html')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $runtimeRoot $name)
}
$copiedCodeHash = (Get-FileHash -LiteralPath (Join-Path $runtimeRoot 'code.js') -Algorithm SHA256).Hash
$copiedUiHash = (Get-FileHash -LiteralPath (Join-Path $runtimeRoot 'ui.html') -Algorithm SHA256).Hash
if ($copiedCodeHash -ne $codeHash -or $copiedUiHash -ne $uiHash) {
  throw 'Plugin build changed during preparation; rerun after the build completes.'
}
# MasterGo assigns a local development id. Keep the upstream manifest intact.
$manifest = [ordered]@{
  name = "M2Fig Export $buildKey"
  api = '1.0.0'
  main = 'code.js'
  ui = 'ui.html'
}
$manifestPath = Join-Path $runtimeRoot 'manifest.json'
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
[pscustomobject]@{ manifest = $manifestPath; name = $manifest.name; codeSha256 = $codeHash; uiSha256 = $uiHash } | ConvertTo-Json
