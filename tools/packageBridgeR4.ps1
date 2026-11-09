$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginRoot = Join-Path $taskRoot 'ReceiveFromMasterGo'
$publicDocs = Join-Path $taskRoot 'docs/public'
# M2Fig continues the existing R4 identity and 17-entry package whitelist.
# Its fixed id must never equal the frozen r3 id (1662512589841230294).
$r4ManifestName = 'M2Fig（本地 r4）'
$r4ManifestId = '2712095548761342'
$taskExporterRuntime = (& (Join-Path $PSScriptRoot 'prepareMasterGoPlugin.ps1') | ConvertFrom-Json)
$exporterRoot = Split-Path -Parent $taskExporterRuntime.manifest
$outputRoot = Join-Path $taskRoot 'dist'
$packageRoot = Join-Path $outputRoot 'M2Fig-r4-local'
$zipPath = Join-Path $outputRoot 'M2Fig-r4-local.zip'

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
foreach ($entryName in $packageSources.Keys) {
  $destination = Join-Path $packageRoot $entryName
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $packageSources[$entryName] -Destination $destination -Force
}

# The active source manifest now also represents R4. Preserve its identity;
# existing r3 artifacts stay frozen and are never a packaging destination.
$sourceManifestPath = Join-Path $pluginRoot 'manifest.json'
$r4Manifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($r4ManifestId -eq '1662512589841230294' -or $r4Manifest.id -ne $r4ManifestId) {
  throw "Active source manifest must use the established R4 id: $r4ManifestId"
}
$r4Manifest.name = $r4ManifestName
$r4Manifest.id = $r4ManifestId
$r4Manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $packageRoot 'manifest.json') -Encoding utf8

# Explicit entry names preserve the Figma manifest at the archive root while
# keeping the MasterGo plugin separate. Never archive an entire working folder
# or an active runtime copy under artifacts/.
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
Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
Write-Output $zipPath
