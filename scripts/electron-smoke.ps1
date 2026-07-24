param(
  [string]$OutputRoot = ""
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $projectRoot "app"
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$artifactRoot = if ($OutputRoot) { $OutputRoot } else { Join-Path $projectRoot "artifacts\electron-runtime-smoke" }
$resultPath = Join-Path $artifactRoot "electron-runtime-smoke.json"
$smokeDataRoot = Join-Path ([IO.Path]::GetTempPath()) ("AriadneSmoke-" + [guid]::NewGuid().ToString("N"))

if (-not [IO.Path]::IsPathRooted($artifactRoot)) {
  throw "The smoke output directory must be absolute."
}
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw "Electron executable not found. Run npm install first."
}

New-Item -ItemType Directory -Path $smokeDataRoot | Out-Null
try {
  Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
  $env:ARIADNE_SMOKE_TEST = "1"
  $env:ARIADNE_SMOKE_TEST_OUTPUT = $artifactRoot
  $env:ARIADNE_SMOKE_USER_DATA = $smokeDataRoot
  $process = Start-Process -FilePath $electronPath -ArgumentList $appRoot -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    throw "Electron smoke test failed with exit code $($process.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
    throw "Electron smoke test did not create a result file."
  }
  $result = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultPath | ConvertFrom-Json
  if ($result.passed -ne $true) {
    throw "Electron smoke result did not pass."
  }
  Write-Output "Electron smoke test passed: $artifactRoot"
}
finally {
  Remove-Item Env:ARIADNE_SMOKE_TEST, Env:ARIADNE_SMOKE_TEST_OUTPUT, Env:ARIADNE_SMOKE_USER_DATA -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $smokeDataRoot) {
    $resolvedSmokeData = (Resolve-Path -LiteralPath $smokeDataRoot).Path
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedSmokeData.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Smoke cleanup target escaped the system temp directory."
    }
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
      $resolvedSmokeData,
      "OnlyErrorDialogs",
      "SendToRecycleBin"
    )
  }
}
