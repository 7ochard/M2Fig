$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginRoot = Join-Path $taskRoot 'ReceiveFromMasterGo'
$publicDocs = Join-Path $taskRoot 'docs/public'
# Mg2Fig V3 uses the fixed plugin ID and 17-entry package whitelist.
# Its fixed id must never equal the frozen r3 id (1662512589841230294).
$v3ManifestName = 'Mg2Fig V3'
$v3ManifestId = '2712095548761342'
$taskExporterRuntime = (& (Join-Path $PSScriptRoot 'prepareMasterGoPlugin.ps1') | ConvertFrom-Json)
$exporterRoot = Split-Path -Parent $taskExporterRuntime.manifest
$outputRoot = Join-Path $taskRoot 'dist'
$packageRoot = Join-Path $outputRoot 'Mg2Fig-v3-local'
$zipPath = Join-Path $outputRoot 'Mg2Fig-v3-local.zip'
$legacyPackageRoot = Join-Path $outputRoot 'M2Fig-r4-local'
$legacyZipPath = Join-Path $outputRoot 'M2Fig-r4-local.zip'

$packageSources = [ordered]@{
  'code.js' = Join-Path $pluginRoot 'code.js'
  'ui.html' = Join-Path $pluginRoot 'ui.html'
  'THIRD_PARTY_NOTICES.md' = Join-Path $pluginRoot 'THIRD_PARTY_NOTICES.md'
  'LICENSE' = Join-Path $taskRoot 'LICENSE'
  'USAGE.md' = Join-Path $publicDocs 'USAGE.md'
  'BRIDGE_VERIFICATION.md' = Join-Path $publicDocs 'BRIDGE_VERIFICATION.md'
  'docs/RESTORE_PERFORMANCE_ACCEPTANCE.md' = Join-Path $publicDocs 'RESTORE_PERFORMANCE_ACCEPTANCE.md'
  'docs/R4_PIPELINE_REVIEW.md' = Join-Path $publicDocs 'R4_PIPELINE_REVIEW.md'
  'docs/LOCAL_EXPORT_GUI.md' = Join-Path $publicDocs 'LOCAL_EXPORT_GUI.md'
  'docs/CACHED_IMAGE_VALIDATION.md' = Join-Path $publicDocs 'CACHED_IMAGE_VALIDATION.md'
  'SOP.md' = Join-Path $publicDocs 'SOP.md'
  'SendToFigma/manifest.json' = Join-Path $exporterRoot 'manifest.json'
  'SendToFigma/code.js' = Join-Path $exporterRoot 'code.js'
  'SendToFigma/ui.html' = Join-Path $exporterRoot 'ui.html'
  'licenses/heic-to-LGPL-3.0.txt' = Join-Path $pluginRoot 'licenses/heic-to-LGPL-3.0.txt'
  'licenses/GPL-3.0.txt' = Join-Path $pluginRoot 'licenses/GPL-3.0.txt'
}
foreach ($source in $packageSources.Values) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Package source is missing: $source"
  }
}
foreach ($targetRoot in @($packageRoot, $legacyPackageRoot)) {
  foreach ($entryName in $packageSources.Keys) {
    $destination = Join-Path $targetRoot $entryName
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $packageSources[$entryName] -Destination $destination -Force
  }
}

$sourceManifestPath = Join-Path $pluginRoot 'manifest.json'
$v3Manifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($v3ManifestId -eq '1662512589841230294' -or $v3Manifest.id -ne $v3ManifestId) {
  throw "Active source manifest must use the established plugin id: $v3ManifestId"
}
$v3Manifest.name = $v3ManifestName
$v3Manifest.id = $v3ManifestId
$v3ManifestJson = $v3Manifest | ConvertTo-Json -Depth 6
$v3ManifestJson | Set-Content -LiteralPath (Join-Path $packageRoot 'manifest.json') -Encoding utf8
$v3ManifestJson | Set-Content -LiteralPath (Join-Path $legacyPackageRoot 'manifest.json') -Encoding utf8

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipEntries = @($packageSources.Keys) + 'manifest.json'
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    foreach ($entryName in $zipEntries) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, (Join-Path $packageRoot $entryName), $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $zipStream.Dispose()
}
Copy-Item -LiteralPath $zipPath -Destination $legacyZipPath -Force
Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
Write-Output $zipPath
