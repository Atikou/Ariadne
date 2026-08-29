[CmdletBinding()]
param([string]$RootPath = 'E:\AI\AriadneSpeech')

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($RootPath)
if ($root -eq [System.IO.Path]::GetPathRoot($root)) { throw 'Refusing to download at a drive root.' }
$imageRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'builder\images'))
if (-not $imageRoot.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Image target escaped RootPath.' }
New-Item -ItemType Directory -Path $imageRoot -Force | Out-Null

$name = 'ubuntu-24.04.4-wsl-amd64.wsl'
$path = Join-Path $imageRoot $name
$url = "https://releases.ubuntu.com/24.04.4/$name"
$expected = '9b2f7730dc68227dd04a9f3e5eab86ad85caf556b8606ad94f1f29ff5c4fd3f5'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
  Invoke-WebRequest -Uri $url -OutFile $path -Headers @{ 'User-Agent' = 'AriadneVoiceBuilder/1.0' }
}
$actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Ubuntu WSL image SHA-256 mismatch.' }
[ordered]@{ source=$url; sha256=$actual; verifiedAt=(Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $imageRoot 'ubuntu-24.04.4-wsl-amd64.lock.json') -Encoding utf8
Write-Host $path
