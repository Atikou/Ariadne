[CmdletBinding()]
param(
  [string]$RootPath = 'E:\AI\AriadneSpeech',
  [switch]$AcceptModelLicenses
)

$ErrorActionPreference = 'Stop'
if (-not $AcceptModelLicenses) {
  throw 'Review speech-runtime/models/README.md and rerun with -AcceptModelLicenses for local-only installation.'
}

$resolvedRoot = [System.IO.Path]::GetFullPath($RootPath)
$runtimeRoot = Join-Path $resolvedRoot 'runtime'
$node = Join-Path $runtimeRoot 'node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Install the speech runtime before installing model assets.' }
$drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($resolvedRoot).TrimEnd('\').TrimEnd(':'))
if ($drive.Free -lt 5GB) { throw 'At least 5 GB free space is required while model archives are extracted.' }

$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ariadne-speech-models-{0}" -f [guid]::NewGuid())
$downloadRoot = Join-Path $resolvedRoot 'runtime\.model-download-cache'
$extractRoot = Join-Path $tempRoot 'extract'
New-Item -ItemType Directory -Path $downloadRoot, $extractRoot -Force | Out-Null

$assets = @(
  [ordered]@{ id='stt'; tag='asr-models'; name='sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2'; size=458187351; digest=$null; license='Weight license requires local review'; redistributionAllowed=$false },
  [ordered]@{ id='vad'; tag='asr-models'; name='silero_vad.onnx'; size=643854; digest='9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'; license='See upstream release'; redistributionAllowed=$false },
  [ordered]@{ id='kws'; tag='kws-models'; name='sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2'; size=32885699; digest='68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'; license='Weight license requires local review'; redistributionAllowed=$false },
  [ordered]@{ id='tts'; tag='tts-models'; name='vits-melo-tts-zh_en.tar.bz2'; size=167006755; digest=$null; license='Bundled LICENSE plus MODEL_CARD'; redistributionAllowed=$false }
)

try {
  $headers = @{ 'User-Agent' = 'AriadneSpeechInstaller/1.0' }
  $locks = @()
  foreach ($asset in $assets) {
    Write-Host "Downloading $($asset.id): $($asset.name)"
    $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/$($asset.tag)"
    $remote = $release.assets | Where-Object { $_.name -eq $asset.name } | Select-Object -First 1
    if (-not $remote) { throw "Official release asset not found: $($asset.name)" }
    if ([int64]$remote.size -ne [int64]$asset.size) { throw "Official release asset size changed: $($asset.name)" }
    $path = Join-Path $downloadRoot $asset.name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne [int64]$asset.size) {
      Invoke-WebRequest -Headers $headers -Uri $remote.browser_download_url -OutFile $path
    } else {
      Write-Host "Using cached archive: $($asset.name)"
    }
    if ((Get-Item -LiteralPath $path).Length -ne [int64]$asset.size) { throw "Downloaded size mismatch: $($asset.name)" }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $remoteDigest = if ($remote.digest -and $remote.digest.StartsWith('sha256:')) { $remote.digest.Substring(7).ToLowerInvariant() } else { $null }
    $expected = if ($asset.digest) { $asset.digest } else { $remoteDigest }
    if ($expected -and $actual -ne $expected) { throw "SHA-256 mismatch: $($asset.name)" }
    $locks += [ordered]@{
      id=$asset.id; source=$remote.browser_download_url; size=[int64]$asset.size; sha256=$actual
      digestAuthority=if ($expected) { 'upstream-github-release' } else { 'local-install-lock' }
      license=$asset.license; redistributionAllowed=$asset.redistributionAllowed
    }
  }

  $sttArchive = Join-Path $downloadRoot $assets[0].name
  $kwsArchive = Join-Path $downloadRoot $assets[2].name
  $ttsArchive = Join-Path $downloadRoot $assets[3].name
  foreach ($pair in @(@($sttArchive,'stt'), @($kwsArchive,'kws'), @($ttsArchive,'tts'))) {
    $destination = Join-Path $extractRoot $pair[1]
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    & tar.exe -xf $pair[0] -C $destination
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $($pair[0])" }
  }

  $sttSource = Get-ChildItem -LiteralPath (Join-Path $extractRoot 'stt') -Directory | Select-Object -First 1
  $kwsSource = Get-ChildItem -LiteralPath (Join-Path $extractRoot 'kws') -Directory | Select-Object -First 1
  $ttsSource = Get-ChildItem -LiteralPath (Join-Path $extractRoot 'tts') -Directory | Select-Object -First 1
  if (-not $sttSource -or -not $kwsSource -or -not $ttsSource) { throw 'An official archive did not contain its expected top-level directory.' }

  $sttTarget = Join-Path $resolvedRoot 'models\stt'
  $vadTarget = Join-Path $resolvedRoot 'models\vad'
  $kwsTarget = Join-Path $resolvedRoot 'models\kws'
  New-Item -ItemType Directory -Path $sttTarget, $vadTarget, $kwsTarget -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $sttSource.FullName 'encoder-epoch-99-avg-1.int8.onnx') -Destination $sttTarget -Force
  Copy-Item -LiteralPath (Join-Path $sttSource.FullName 'decoder-epoch-99-avg-1.onnx') -Destination $sttTarget -Force
  Copy-Item -LiteralPath (Join-Path $sttSource.FullName 'joiner-epoch-99-avg-1.int8.onnx') -Destination $sttTarget -Force
  Copy-Item -LiteralPath (Join-Path $sttSource.FullName 'tokens.txt') -Destination $sttTarget -Force
  $sttManifest = [ordered]@{
    model='Streaming Zipformer small bilingual zh-en INT8'; encoder='encoder-epoch-99-avg-1.int8.onnx'
    decoder='decoder-epoch-99-avg-1.onnx'; joiner='joiner-epoch-99-avg-1.int8.onnx'; tokens='tokens.txt'
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $sttTarget 'model.json'), $sttManifest, [System.Text.UTF8Encoding]::new($false))
  Copy-Item -LiteralPath (Join-Path $downloadRoot 'silero_vad.onnx') -Destination (Join-Path $vadTarget 'silero_vad.onnx') -Force

  foreach ($name in @('encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx','decoder-epoch-13-avg-2-chunk-8-left-64.onnx','joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx','tokens.txt','en.phone')) {
    Copy-Item -LiteralPath (Join-Path $kwsSource.FullName $name) -Destination $kwsTarget -Force
  }
  $kwsManifest = [ordered]@{
    model='Zipformer zh-en 3M INT8 chunk-8'; encoder='encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx'
    decoder='decoder-epoch-13-avg-2-chunk-8-left-64.onnx'; joiner='joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx'
    tokens='tokens.txt'; tokensType='phone+ppinyin'; lexicon='en.phone'
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $kwsTarget 'model.json'), $kwsManifest, [System.Text.UTF8Encoding]::new($false))

  @('Ariadne @Ariadne') | Set-Content -LiteralPath (Join-Path $kwsTarget 'keywords.raw.txt') -Encoding utf8
  & $node (Join-Path $runtimeRoot 'tools\compile-keywords.mjs') --tokens (Join-Path $kwsTarget 'tokens.txt') --lexicon (Join-Path $kwsTarget 'en.phone') --input (Join-Path $kwsTarget 'keywords.raw.txt') --output (Join-Path $kwsTarget 'keywords.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Default keyword compilation failed.' }

  & $node (Join-Path $sourceRoot 'tools\build-builtin-voice.mjs') --source $ttsSource.FullName --module-root $resolvedRoot
  if ($LASTEXITCODE -ne 0) { throw 'Built-in voice pack generation or test synthesis failed.' }
  [ordered]@{ schemaVersion=1; installedAt=(Get-Date).ToUniversalTime().ToString('o'); assets=$locks } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resolvedRoot 'models\model-assets.lock.json') -Encoding utf8

  & $node (Join-Path $runtimeRoot 'dist\sidecar.mjs') --module-root $resolvedRoot --self-test
  if ($LASTEXITCODE -ne 0) { throw 'Speech Sidecar model self-test failed.' }
  Write-Host "Speech models and built-in voice installed under $resolvedRoot"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
