param([switch]$CheckOnly, [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $taskNode -e "if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.')"
if ($LASTEXITCODE -ne 0) { throw 'Node.js check failed. Install a supported Node.js runtime and retry.' }
$taskVenvPython = Join-Path $taskRoot '.venv/Scripts/python.exe'
if (Test-Path -LiteralPath $taskVenvPython -PathType Leaf) {
  $taskPython = $taskVenvPython
} else {
  $taskPython = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  & $taskPython -c "import sys; assert sys.version_info >= (3,10), 'Python 3.10 or newer is required'"
  if ($LASTEXITCODE -ne 0) { throw 'Python check failed. Install Python 3.10 or newer and retry.' }
  if (-not ($CheckOnly -or $SkipInstall)) {
    & $taskPython -m venv (Join-Path $taskRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the local Python environment.' }
    $taskPython = $taskVenvPython
  }
}
& $taskPython -c "import sys; assert sys.version_info >= (3,10), 'Python 3.10 or newer is required'"
if ($LASTEXITCODE -ne 0) { throw 'The selected Python environment is not supported.' }
if (-not ($CheckOnly -or $SkipInstall)) {
  & $taskPython -m pip install --disable-pip-version-check -r (Join-Path $taskRoot 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
  Push-Location -LiteralPath (Join-Path $taskRoot 'ReceiveFromMasterGo')
  try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Locked Node dependency installation failed.' }
  } finally { Pop-Location }
}
& $taskPython -c 'import brotli; from PIL import Image'
if ($LASTEXITCODE -ne 0) { throw 'Brotli or Pillow is missing. Run SetupM2Fig.cmd without SkipInstall.' }
foreach ($taskRelative in @('tools/desktop_bridge_worker.py', 'tools/local_bridge_export.py', 'tools/readMasterGoCache.py', 'tools/convertCachedMasterGo.js', 'tools/inspectLargeBridgePackage.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $taskRelative) -PathType Leaf)) { throw "Backend source is missing: $taskRelative" }
}
& $taskNode -e "const p=require('node:path'),fs=require('node:fs'),r=process.argv[1];const e=require(p.join(r,'ReceiveFromMasterGo/node_modules/esbuild'));e.transformSync('const ready = true',{loader:'js'});const h=p.join(r,'ReceiveFromMasterGo/node_modules/heic-to/src/lib/libheif-without-unsafe-eval.js');if(!fs.existsSync(h))throw new Error('heic-to runtime is missing');" $taskRoot
if ($LASTEXITCODE -ne 0) { throw 'Receiving plugin dependencies are missing or incompatible. Run SetupM2Fig.cmd without SkipInstall.' }
$taskManifestPath = Join-Path $taskRoot 'dist/M2Fig-r4-local/manifest.json'
if (-not (Test-Path -LiteralPath $taskManifestPath -PathType Leaf)) {
  if ($CheckOnly) { throw 'The prebuilt plugin is missing. Run SetupM2Fig.cmd to prepare it.' }
  & (Join-Path $taskRoot 'tools/packageBridgeR4.ps1')
}
$taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($taskManifest.id -ne '2712095548761342') { throw 'The plugin does not have the established M2Fig R4 ID.' }
$taskRuntime = [ordered]@{ repoRoot = $taskRoot; python = [System.IO.Path]::GetFullPath($taskPython); node = [System.IO.Path]::GetFullPath($taskNode); pluginManifest = $taskManifestPath }
if (-not $CheckOnly) {
  $taskRuntime | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'bridge-runtime.json') -Encoding utf8
  $taskRuntime | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'desktop/bridge-runtime.json') -Encoding utf8
}
[pscustomobject]@{ status = 'ready'; checkOnly = [bool]$CheckOnly; configurationWritten = (-not $CheckOnly); runtime = $taskRuntime } | ConvertTo-Json -Depth 4
