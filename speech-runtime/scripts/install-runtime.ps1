[CmdletBinding()]
param(
  [string]$RootPath = 'E:\AI\AriadneSpeech',
  [string]$NodeVersion = '22.23.2'
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath($RootPath)
if (-not [System.IO.Path]::IsPathRooted($resolvedRoot)) { throw 'RootPath must be absolute.' }
if ($resolvedRoot -eq [System.IO.Path]::GetPathRoot($resolvedRoot)) { throw 'Refusing to install at a drive root.' }
$drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($resolvedRoot).TrimEnd('\').TrimEnd(':'))
if ($drive.Free -lt 20GB) { throw 'At least 20 GB free space is required before installing the speech toolchain.' }

$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $resolvedRoot 'runtime'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ariadne-speech-install-{0}" -f [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
  $archiveName = "node-v$NodeVersion-win-x64.zip"
  $baseUrl = "https://nodejs.org/download/release/v$NodeVersion"
  $archivePath = Join-Path $tempRoot $archiveName
  $sumsPath = Join-Path $tempRoot 'SHASUMS256.txt'
  Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archivePath
  Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sumsPath
  $sumLine = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1
  if (-not $sumLine) { throw 'Node checksum entry was not found.' }
  $expected = ($sumLine -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'Node archive checksum mismatch.' }

  $expanded = Join-Path $tempRoot 'node'
  Expand-Archive -LiteralPath $archivePath -DestinationPath $expanded
  $nodeSource = Join-Path $expanded "node-v$NodeVersion-win-x64"
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $nodeSource '*') -Destination $runtimeRoot -Recurse -Force
  New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'dist') -Force | Out-Null
  Copy-Item -Path (Join-Path $sourceRoot 'src\*') -Destination (Join-Path $runtimeRoot 'dist') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination (Join-Path $runtimeRoot 'package.json') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'package-lock.json') -Destination (Join-Path $runtimeRoot 'package-lock.json') -Force
  New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'tools') -Force | Out-Null
  Copy-Item -Path (Join-Path $sourceRoot 'tools\*') -Destination (Join-Path $runtimeRoot 'tools') -Recurse -Force

  foreach ($relative in @('models\stt', 'models\vad', 'models\kws', 'voices\builtin', 'voices\installed', 'builder', 'datasets', 'checkpoints', 'wsl')) {
    New-Item -ItemType Directory -Path (Join-Path $resolvedRoot $relative) -Force | Out-Null
  }
  Push-Location $runtimeRoot
  try {
    & (Join-Path $runtimeRoot 'npm.cmd') ci --omit=dev --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'Speech runtime dependency installation failed.' }
  } finally {
    Pop-Location
  }
  & (Join-Path $runtimeRoot 'node.exe') (Join-Path $runtimeRoot 'dist\sidecar.mjs') --module-root $resolvedRoot --self-test
  if ($LASTEXITCODE -ne 0) { throw 'Speech Sidecar self-test failed.' }
  Write-Host "Ariadne speech runtime installed at $runtimeRoot"
  Write-Host 'Models are intentionally not bundled. Review models/README.md, then run scripts/install-model-assets.ps1 -AcceptModelLicenses.'
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
