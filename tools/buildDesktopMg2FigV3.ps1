param([switch]$Portable)
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskDesktop = Join-Path $taskRoot 'desktop'
$taskPython = (Get-Command python -CommandType Application | Select-Object -First 1).Source
$taskNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
& $taskPython -c 'import brotli; from PIL import Image'
if ($LASTEXITCODE -ne 0) { throw 'Python image runtime check failed.' }
$v3Manifest = [System.IO.Path]::GetFullPath((Join-Path $taskRoot 'dist/Mg2Fig-v3-local/manifest.json'))
if (-not (Test-Path -LiteralPath $v3Manifest -PathType Leaf)) {
  throw "Mg2Fig V3 manifest is missing; run tools/packageMg2FigV3.ps1 first: $v3Manifest"
}
$manifest = Get-Content -LiteralPath $v3Manifest -Raw -Encoding utf8 | ConvertFrom-Json
if ($manifest.id -ne '2712095548761342' -or $manifest.name -ne 'Mg2Fig V3') {
  throw 'The configured plugin does not match the Mg2Fig V3 identity.'
}
# Current source is the Mg2Fig V3 line. Keep development and packaged runtime
# pointing to the same manifest; frozen r3 binaries have their own resources.
$taskRuntime = [ordered]@{ repoRoot = $taskRoot; python = $taskPython; node = $taskNode; pluginManifest = $v3Manifest }
$taskRuntimePath = Join-Path $taskDesktop 'bridge-runtime.json'
$taskRuntimeJson = $taskRuntime | ConvertTo-Json
$taskPreviousRuntime = if (Test-Path -LiteralPath $taskRuntimePath -PathType Leaf) { [System.IO.File]::ReadAllBytes($taskRuntimePath) } else { $null }
if ($Portable) {
  [System.IO.File]::WriteAllText($taskRuntimePath, '{"portable":true}', (New-Object System.Text.UTF8Encoding($false)))
} else {
  $taskRuntimeJson | Set-Content -LiteralPath $taskRuntimePath -Encoding utf8
}
Push-Location -LiteralPath $taskDesktop
try {
  if (-not (Test-Path -LiteralPath 'node_modules/electron/dist/electron.exe' -PathType Leaf)) {
    & $taskNode --use-system-ca --use-env-proxy 'node_modules/electron/install.js'
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime download failed.' }
  }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Electron build failed.' }
} finally {
  Pop-Location
  if ($Portable) {
    if ($null -ne $taskPreviousRuntime) { [System.IO.File]::WriteAllBytes($taskRuntimePath, $taskPreviousRuntime) }
    else { $taskRuntimeJson | Set-Content -LiteralPath $taskRuntimePath -Encoding utf8 }
  }
}
$builtExe = Join-Path $taskRoot 'dist\desktop-v3\win-unpacked\Mg2Fig.exe'
$portableExe = Join-Path $taskRoot 'dist\desktop-v3\Mg2Fig.exe'
if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) { throw "Mg2Fig unpacked build output is missing: $builtExe" }
if (-not $Portable) {
  if (Test-Path -LiteralPath $portableExe -PathType Leaf) {
    Copy-Item -LiteralPath $portableExe -Destination (Join-Path $taskRoot 'Mg2Fig.exe') -Force
    Copy-Item -LiteralPath $portableExe -Destination (Join-Path $taskRoot 'M2Fig.exe') -Force
  } else {
    Copy-Item -LiteralPath $builtExe -Destination (Join-Path $taskRoot 'Mg2Fig.exe') -Force
    Copy-Item -LiteralPath $builtExe -Destination (Join-Path $taskRoot 'M2Fig.exe') -Force
  }
  $taskRuntimeJson | Set-Content -LiteralPath (Join-Path $taskRoot 'bridge-runtime.json') -Encoding utf8
  $taskRuntimeJson | Set-Content -LiteralPath (Join-Path $taskRoot 'dist\desktop-v3\win-unpacked\bridge-runtime.json') -Encoding utf8
}
Get-FileHash -LiteralPath $builtExe -Algorithm SHA256 | Format-List
Write-Output $builtExe
