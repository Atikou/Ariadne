param(
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

function New-SmokeProviderCertificate {
  param(
    [Parameter(Mandatory = $true)][string]$PfxPath,
    [Parameter(Mandatory = $true)][string]$CertificatePath,
    [Parameter(Mandatory = $true)][string]$Passphrase
  )

  $rsa = [Security.Cryptography.RSA]::Create(2048)
  try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      "CN=localhost",
      $rsa,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName("localhost")
    $san.AddIpAddress([Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
    )
    $usage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature `
      -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
    $request.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $true)
    )
    $oids = [Security.Cryptography.OidCollection]::new()
    [void]$oids.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
    $request.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
    )
    $certificate = $request.CreateSelfSigned(
      [DateTimeOffset]::UtcNow.AddMinutes(-5),
      [DateTimeOffset]::UtcNow.AddDays(2)
    )
    try {
      [IO.File]::WriteAllBytes(
        $PfxPath,
        $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $Passphrase)
      )
      $certificateBytes = $certificate.Export(
        [Security.Cryptography.X509Certificates.X509ContentType]::Cert
      )
      $certificatePem = "-----BEGIN CERTIFICATE-----`n" `
        + [Convert]::ToBase64String($certificateBytes, [Base64FormattingOptions]::InsertLineBreaks) `
        + "`n-----END CERTIFICATE-----`n"
      [IO.File]::WriteAllText(
        $CertificatePath,
        $certificatePem,
        [Text.UTF8Encoding]::new($false)
      )
    }
    finally {
      $certificate.Dispose()
    }
  }
  finally {
    $rsa.Dispose()
  }
}

function Find-SmokeRuntimeProcess {
  param(
    [Parameter(Mandatory = $true)][int]$ElectronProcessId,
    [Parameter(Mandatory = $true)][string]$RuntimeEntryPath
  )

  $processes = @(Get-CimInstance Win32_Process)
  $descendants = [Collections.Generic.HashSet[int]]::new()
  [void]$descendants.Add($ElectronProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($candidate in $processes) {
      $candidateId = [int]$candidate.ProcessId
      if (
        -not $descendants.Contains($candidateId) `
        -and $descendants.Contains([int]$candidate.ParentProcessId)
      ) {
        [void]$descendants.Add($candidateId)
        $changed = $true
      }
    }
  }
  $matches = @($processes | Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.ProcessId -ne $ElectronProcessId `
      -and $descendants.Contains([int]$_.ProcessId) `
      -and $commandLine.IndexOf($RuntimeEntryPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($matches.Count -gt 1) {
    throw "Electron smoke found multiple Runtime child processes."
  }
  return $matches | Select-Object -First 1
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $projectRoot "app"
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$artifactRoot = if ($OutputRoot) { $OutputRoot } else { Join-Path $projectRoot "artifacts\electron-runtime-smoke" }
$resultPath = Join-Path $artifactRoot "electron-runtime-smoke.json"
$stdoutPath = Join-Path $artifactRoot "electron-runtime-smoke.stdout.log"
$stderrPath = Join-Path $artifactRoot "electron-runtime-smoke.stderr.log"
$smokeDataRoot = Join-Path ([IO.Path]::GetTempPath()) ("AriadneSmoke-" + [guid]::NewGuid().ToString("N"))
$workspaceRoot = Join-Path $smokeDataRoot "workspace"
$providerReadyPath = Join-Path $smokeDataRoot "provider-ready.json"
$providerStatePath = Join-Path $smokeDataRoot "provider-state.json"
$providerPfxPath = Join-Path $smokeDataRoot "provider.pfx"
$providerCertificatePath = Join-Path $smokeDataRoot "provider-ca.pem"
$providerStdoutPath = Join-Path $artifactRoot "electron-smoke-provider.stdout.log"
$providerStderrPath = Join-Path $artifactRoot "electron-smoke-provider.stderr.log"
$boundaryStdoutPath = Join-Path $artifactRoot "electron-smoke-boundary.stdout.log"
$boundaryStderrPath = Join-Path $artifactRoot "electron-smoke-boundary.stderr.log"
$providerScript = Join-Path $PSScriptRoot "electron-smoke-provider.mjs"
$boundaryScript = Join-Path $PSScriptRoot "electron-smoke-boundary-watcher.mjs"
$runtimeEntryPath = Join-Path $projectRoot "runtime\dist\entry\runtime-process.js"
$agentDatabasePath = Join-Path $smokeDataRoot "runtime\data\agent-control\agent-control.db"
$projectionDatabasePath = Join-Path $smokeDataRoot "runtime\data\public-projection\projection.db"
$effectBoundaryPath = Join-Path $smokeDataRoot "effect-started-boundary.marker"
$projectionBoundaryPath = Join-Path $smokeDataRoot "projection-pending-boundary.marker"
$providerPassphrase = "ariadne-electron-smoke"
$providerModel = "ariadne-smoke-model"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$providerProcess = $null
$boundaryProcess = $null
$environmentNames = @(
  "ARIADNE_SMOKE_TEST",
  "ARIADNE_SMOKE_TEST_OUTPUT",
  "ARIADNE_SMOKE_USER_DATA",
  "ARIADNE_SMOKE_PROVIDER_BASE_URL",
  "ARIADNE_SMOKE_PROVIDER_MODEL",
  "ARIADNE_SMOKE_PROVIDER_STATE",
  "ARIADNE_WORKSPACE_ROOT",
  "ARIADNE_RUNTIME_NODE_EXECUTABLE",
  "NODE_EXTRA_CA_CERTS",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "MOONSHOT_API_KEY",
  "ANTHROPIC_API_KEY"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

if (-not [IO.Path]::IsPathRooted($artifactRoot)) {
  throw "The smoke output directory must be absolute."
}
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw "Electron executable not found. Run npm install first."
}

New-Item -ItemType Directory -Path $smokeDataRoot | Out-Null
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $workspaceRoot "fixtures") -Force | Out-Null
[IO.File]::WriteAllText(
  (Join-Path $workspaceRoot "fixtures\read.txt"),
  "ARIADNE_SMOKE_READ_FIXTURE",
  [Text.UTF8Encoding]::new($false)
)
try {
  Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stdoutPath, $stderrPath, $providerStdoutPath, $providerStderrPath, `
    $boundaryStdoutPath, $boundaryStderrPath -Force -ErrorAction SilentlyContinue
  New-SmokeProviderCertificate -PfxPath $providerPfxPath `
    -CertificatePath $providerCertificatePath -Passphrase $providerPassphrase
  $providerProcess = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden `
    -ArgumentList @(
      $providerScript,
      "--model", $providerModel,
      "--state", $providerStatePath,
      "--ready", $providerReadyPath,
      "--pfx", $providerPfxPath,
      "--passphrase", $providerPassphrase
    ) -RedirectStandardOutput $providerStdoutPath -RedirectStandardError $providerStderrPath
  $providerDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $providerReadyPath -PathType Leaf)) {
    if ($providerProcess.HasExited) {
      throw "Electron smoke Provider exited before readiness with code $($providerProcess.ExitCode)."
    }
    if ([DateTime]::UtcNow -ge $providerDeadline) {
      throw "Electron smoke Provider did not become ready."
    }
    Start-Sleep -Milliseconds 50
  }
  $providerReady = Get-Content -Raw -Encoding UTF8 -LiteralPath $providerReadyPath | ConvertFrom-Json
  if ($providerReady.protocol -ne "ariadne-electron-smoke-provider-ready.v1") {
    throw "Electron smoke Provider returned an invalid readiness document."
  }
  $env:ARIADNE_SMOKE_TEST = "1"
  $env:ARIADNE_SMOKE_TEST_OUTPUT = $artifactRoot
  $env:ARIADNE_SMOKE_USER_DATA = $smokeDataRoot
  $env:ARIADNE_SMOKE_PROVIDER_BASE_URL = [string]$providerReady.baseUrl
  $env:ARIADNE_SMOKE_PROVIDER_MODEL = $providerModel
  $env:ARIADNE_SMOKE_PROVIDER_STATE = $providerStatePath
  $env:ARIADNE_WORKSPACE_ROOT = $workspaceRoot
  $env:ARIADNE_RUNTIME_NODE_EXECUTABLE = $nodePath
  $env:NODE_EXTRA_CA_CERTS = $providerCertificatePath
  $env:OPENAI_API_KEY = "ariadne-electron-smoke-key"
  Remove-Item Env:DEEPSEEK_API_KEY, Env:MOONSHOT_API_KEY, Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $electronPath -ArgumentList $appRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  # Keep the native process handle alive so Windows PowerShell can read the
  # exit code after the asynchronous crash/restart watcher completes.
  [void]$process.Handle
  $runtimeKillPhase = 0
  while (-not $process.HasExited) {
    if ($runtimeKillPhase -lt 3 -and (Test-Path -LiteralPath $providerStatePath -PathType Leaf)) {
      try {
        $providerSnapshot = Get-Content -Raw -Encoding UTF8 -LiteralPath $providerStatePath | ConvertFrom-Json
        $shouldKill = switch ($runtimeKillPhase) {
          0 { $providerSnapshot.scenarios.crash_inference.requests -ge 1 }
          1 { Test-Path -LiteralPath $effectBoundaryPath -PathType Leaf }
          2 { Test-Path -LiteralPath $projectionBoundaryPath -PathType Leaf }
        }
        if ($shouldKill) {
          if ($runtimeKillPhase -eq 0 -and $null -eq $boundaryProcess) {
            $boundaryProcess = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden `
              -ArgumentList @(
                $boundaryScript,
                "--agent-db", $agentDatabasePath,
                "--projection-db", $projectionDatabasePath,
                "--effect-marker", $effectBoundaryPath,
                "--projection-marker", $projectionBoundaryPath
              ) -RedirectStandardOutput $boundaryStdoutPath -RedirectStandardError $boundaryStderrPath
          }
          $runtime = Find-SmokeRuntimeProcess -ElectronProcessId $process.Id `
            -RuntimeEntryPath $runtimeEntryPath
          if ($null -ne $runtime) {
            Stop-Process -Id ([int]$runtime.ProcessId) -Force
            $runtimeKillPhase += 1
          }
        }
      }
      catch {
        if ($_.Exception.Message -like "Electron smoke found multiple Runtime*") { throw }
      }
    }
    Start-Sleep -Milliseconds 10
    $process.Refresh()
  }
  [void]$process.WaitForExit()
  $process.Refresh()
  if ($runtimeKillPhase -ne 3) {
    throw "Electron smoke completed only $runtimeKillPhase of 3 Runtime boundary kills."
  }
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
  if ($null -ne $boundaryProcess -and -not $boundaryProcess.HasExited) {
    Stop-Process -Id $boundaryProcess.Id -Force -ErrorAction SilentlyContinue
    [void]$boundaryProcess.WaitForExit(5000)
  }
  if ($null -ne $providerProcess -and -not $providerProcess.HasExited) {
    Stop-Process -Id $providerProcess.Id -Force -ErrorAction SilentlyContinue
    [void]$providerProcess.WaitForExit(5000)
  }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
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
