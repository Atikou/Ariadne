param(
  [string]$OutputRoot = "",
  [string[]]$Profiles = @("desktop-default", "desktop-no-speech", "desktop-stt-only", "desktop-tts-only")
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $projectRoot "app"
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$artifactRoot = if ($OutputRoot) { $OutputRoot } else { Join-Path $projectRoot "artifacts\electron-profile-matrix" }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$environmentNames = @(
  "ARIADNE_APPLICATION_PROFILE", "ARIADNE_SMOKE_TEST", "ARIADNE_SMOKE_PROFILE_VERIFY",
  "ARIADNE_SMOKE_TEST_OUTPUT", "ARIADNE_SMOKE_USER_DATA", "ARIADNE_SMOKE_WORKSPACE_ROOT",
  "ARIADNE_SMOKE_WORKSPACE_ID", "ARIADNE_RUNTIME_NODE_EXECUTABLE"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
  New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
  foreach ($profile in $Profiles) {
    $dataRoot = Join-Path ([IO.Path]::GetTempPath()) ("AriadneProfile-" + [guid]::NewGuid().ToString("N"))
    $workspaceRoot = Join-Path $dataRoot "workspace"
    $identity = [IO.Path]::GetFullPath($workspaceRoot).ToLowerInvariant()
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hashBytes = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)) }
    finally { $hasher.Dispose() }
    $hash = ($hashBytes | ForEach-Object { $_.ToString("x2") }) -join ""
    $workspaceId = "workspace-" + $hash.Substring(0, 20)
    $profileOutput = Join-Path $artifactRoot $profile
    New-Item -ItemType Directory -Path $workspaceRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $profileOutput -Force | Out-Null
    $env:ARIADNE_APPLICATION_PROFILE = $profile
    $env:ARIADNE_SMOKE_TEST = "1"
    $env:ARIADNE_SMOKE_PROFILE_VERIFY = "1"
    $env:ARIADNE_SMOKE_TEST_OUTPUT = $profileOutput
    $env:ARIADNE_SMOKE_USER_DATA = $dataRoot
    $env:ARIADNE_SMOKE_WORKSPACE_ROOT = $workspaceRoot
    $env:ARIADNE_SMOKE_WORKSPACE_ID = $workspaceId
    $env:ARIADNE_RUNTIME_NODE_EXECUTABLE = $nodePath
    $stdoutPath = Join-Path $profileOutput "stdout.log"
    $stderrPath = Join-Path $profileOutput "stderr.log"
    $process = Start-Process -FilePath $electronPath -ArgumentList $appRoot -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    [void]$process.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 50
      $process.Refresh()
    }
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "Electron profile verification timed out: $profile"
    }
    [void]$process.WaitForExit()
    $resultPath = Join-Path $profileOutput "profile-window.json"
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
      throw "Electron profile verification did not complete: $profile"
    }
    $result = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultPath | ConvertFrom-Json
    if ($result.passed -ne $true) { throw "Electron profile verification failed: $profile" }
    $resolvedData = (Resolve-Path -LiteralPath $dataRoot).Path
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedData.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Profile cleanup target escaped the system temp directory."
    }
    Remove-Item -LiteralPath $resolvedData -Recurse -Force
  }
  Write-Output "Electron profile matrix passed: $artifactRoot"
}
finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}
