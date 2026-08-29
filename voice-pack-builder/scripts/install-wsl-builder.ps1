[CmdletBinding()]
param(
  [string]$UbuntuRootFsArchive,
  [string]$RootPath = 'E:\AI\AriadneSpeech',
  [string]$DistributionName = 'AriadneSpeechUbuntu',
  [switch]$StageOnly
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($RootPath)
if ($root -eq [System.IO.Path]::GetPathRoot($root)) { throw 'Refusing to install WSL at a drive root.' }
$wslRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'wsl\ubuntu'))
if (-not $wslRoot.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'WSL target escaped RootPath.' }
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$builderRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'builder\voice-pack-builder'))
if (-not $builderRoot.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Builder target escaped RootPath.' }
New-Item -ItemType Directory -Path $builderRoot -Force | Out-Null
foreach ($name in @('src','tests','recording-spec','prompts')) {
  $source = Join-Path $sourceRoot $name
  if (Test-Path -LiteralPath $source) { Copy-Item -Path $source -Destination $builderRoot -Recurse -Force }
}
foreach ($name in @('pyproject.toml','README.md','voice-pack.example.toml')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $builderRoot $name) -Force
}
Write-Host "Builder source staged at $builderRoot"
if ($StageOnly) { exit 0 }
if (-not $UbuntuRootFsArchive) { throw 'UbuntuRootFsArchive is required unless -StageOnly is used.' }
$archive = [System.IO.Path]::GetFullPath($UbuntuRootFsArchive)
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'Ubuntu rootfs archive was not found.' }

$status = & wsl.exe --status 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host 'WSL components are not enabled. Run the following once in an elevated PowerShell, reboot, and rerun this script:'
  Write-Host 'wsl.exe --install --no-distribution'
  exit 2
}
$existing = & wsl.exe --list --quiet
if ($existing -contains $DistributionName) { throw "WSL distribution already exists: $DistributionName" }
New-Item -ItemType Directory -Path $wslRoot -Force | Out-Null
& wsl.exe --import $DistributionName $wslRoot $archive --version 2
if ($LASTEXITCODE -ne 0) { throw 'WSL distribution import failed.' }
& wsl.exe -d $DistributionName -- bash -lc 'apt-get update && apt-get install -y build-essential cmake ninja-build ffmpeg git python3 python3-venv python3-pip && python3 -m venv /opt/ariadne-voice-builder && /opt/ariadne-voice-builder/bin/pip install --upgrade pip'
if ($LASTEXITCODE -ne 0) { throw 'WSL builder dependencies failed to install.' }
$builderWsl = '/mnt/' + $builderRoot.Substring(0, 1).ToLowerInvariant() + $builderRoot.Substring(2).Replace('\', '/')
& wsl.exe -d $DistributionName -- /opt/ariadne-voice-builder/bin/pip install -e $builderWsl
if ($LASTEXITCODE -ne 0) { throw 'Ariadne voice builder installation failed.' }
& wsl.exe -d $DistributionName -- ln -sf /opt/ariadne-voice-builder/bin/ariadne-voice /usr/local/bin/ariadne-voice
if ($LASTEXITCODE -ne 0) { throw 'Ariadne voice builder command installation failed.' }
Write-Host "WSL builder installed in $wslRoot"
Write-Host "Open it with: wsl.exe -d $DistributionName"
