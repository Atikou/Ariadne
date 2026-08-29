param(
  [string]$OutputRoot = "",
  [switch]$KeepData
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
$desktopRecoveryResultPath = Join-Path $artifactRoot "desktop-restart-delivery.json"
$stdoutPath = Join-Path $artifactRoot "electron-runtime-smoke.stdout.log"
$stderrPath = Join-Path $artifactRoot "electron-runtime-smoke.stderr.log"
$desktopRecoveryStdoutPath = Join-Path $artifactRoot "electron-desktop-recovery.stdout.log"
$desktopRecoveryStderrPath = Join-Path $artifactRoot "electron-desktop-recovery.stderr.log"
$smokeDataRoot = Join-Path ([IO.Path]::GetTempPath()) ("AriadneSmoke-" + [guid]::NewGuid().ToString("N"))
$workspaceRoot = Join-Path $smokeDataRoot "workspace"
$workspaceIdentity = [IO.Path]::GetFullPath($workspaceRoot).ToLowerInvariant()
$workspaceHasher = [Security.Cryptography.SHA256]::Create()
try {
  $workspaceHashBytes = $workspaceHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($workspaceIdentity))
} finally {
  $workspaceHasher.Dispose()
}
$workspaceHash = ($workspaceHashBytes | ForEach-Object { $_.ToString("x2") }) -join ""
$workspaceId = "workspace-" + $workspaceHash.Substring(0, 20)
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
$inboxBoundaryPath = Join-Path $smokeDataRoot "inbox-delivery-boundary.marker"
$questionBoundaryPath = Join-Path $smokeDataRoot "question-waiting-boundary.marker"
$effectBoundaryPath = Join-Path $smokeDataRoot "effect-started-boundary.marker"
$projectionBoundaryPath = Join-Path $smokeDataRoot "projection-pending-boundary.marker"
$runtimeKillAckRoot = Join-Path $workspaceRoot "runtime-kills"
$runtimeKillAckNames = @(
  "inbox-killed.json",
  "question-killed.json",
  "inference-killed.json",
  "effect-killed.json",
  "projection-killed.json"
)
$runtimeKillScenarios = @(
  "inbox_delivery",
  "crash_question",
  "crash_inference",
  "crash_effect",
  "crash_projection"
)
$providerPassphrase = "ariadne-electron-smoke"
$providerModel = "ariadne-smoke-model"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$providerProcess = $null
$boundaryProcess = $null
$process = $null
$desktopRecoveryProcess = $null
$mainCrashKilled = $false
$environmentNames = @(
  "ARIADNE_SMOKE_TEST",
  "ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY",
  "ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT",
  "ARIADNE_SMOKE_TEST_OUTPUT",
  "ARIADNE_SMOKE_USER_DATA",
  "ARIADNE_SMOKE_PROVIDER_BASE_URL",
  "ARIADNE_SMOKE_PROVIDER_MODEL",
  "ARIADNE_SMOKE_PROVIDER_STATE",
  "ARIADNE_SMOKE_WORKSPACE_ROOT",
  "ARIADNE_SMOKE_WORKSPACE_ID",
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
if ($KeepData) {
  [IO.File]::WriteAllText(
    (Join-Path $artifactRoot "smoke-data-root.txt"),
    $smokeDataRoot,
    [Text.UTF8Encoding]::new($false)
  )
}
New-Item -ItemType Directory -Path (Join-Path $workspaceRoot "fixtures") -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeKillAckRoot -Force | Out-Null
[IO.File]::WriteAllText(
  (Join-Path $workspaceRoot "fixtures\read.txt"),
  "ARIADNE_SMOKE_READ_FIXTURE",
  [Text.UTF8Encoding]::new($false)
)
try {
  Remove-Item -LiteralPath $resultPath, $desktopRecoveryResultPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stdoutPath, $stderrPath, $providerStdoutPath, $providerStderrPath, `
    $boundaryStdoutPath, $boundaryStderrPath, $desktopRecoveryStdoutPath, `
    $desktopRecoveryStderrPath -Force -ErrorAction SilentlyContinue
  New-SmokeProviderCertificate -PfxPath $providerPfxPath `
    -CertificatePath $providerCertificatePath -Passphrase $providerPassphrase
  $providerProcess = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden `
    -ArgumentList @(
      $providerScript,
      "--model", $providerModel,
      "--state", $providerStatePath,
      "--ready", $providerReadyPath,
      "--pfx", $providerPfxPath,
      "--passphrase", $providerPassphrase,
      "--workspace-id", $workspaceId,
      "--agent-db", $agentDatabasePath
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
  $env:ARIADNE_SMOKE_WORKSPACE_ROOT = $workspaceRoot
  $env:ARIADNE_SMOKE_WORKSPACE_ID = $workspaceId
  $env:ARIADNE_RUNTIME_NODE_EXECUTABLE = $nodePath
  $env:NODE_EXTRA_CA_CERTS = $providerCertificatePath
  $env:OPENAI_API_KEY = "ariadne-electron-smoke-key"
  $env:ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT = "1"
  Remove-Item Env:ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY -ErrorAction SilentlyContinue
  Remove-Item Env:DEEPSEEK_API_KEY, Env:MOONSHOT_API_KEY, Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
  $boundaryProcess = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden `
    -ArgumentList @(
      $boundaryScript,
      "--agent-db", $agentDatabasePath,
      "--projection-db", $projectionDatabasePath,
      "--provider-state", $providerStatePath,
      "--inbox-marker", $inboxBoundaryPath,
      "--question-marker", $questionBoundaryPath,
      "--effect-marker", $effectBoundaryPath,
      "--projection-marker", $projectionBoundaryPath
    ) -RedirectStandardOutput $boundaryStdoutPath -RedirectStandardError $boundaryStderrPath
  $process = Start-Process -FilePath $electronPath -ArgumentList $appRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  # Keep the native process handle alive so Windows PowerShell can read the
  # exit code after the asynchronous crash/restart watcher completes.
  [void]$process.Handle
  $runtimeKillPhase = 0
  $mainCrashDeadline = [DateTime]::UtcNow.AddMinutes(3)
  while (-not $process.HasExited) {
    if ([DateTime]::UtcNow -ge $mainCrashDeadline) {
      throw "Electron smoke did not reach the Main crash boundary before the deadline."
    }
    if ($runtimeKillPhase -lt 5 -and (Test-Path -LiteralPath $providerStatePath -PathType Leaf)) {
      $providerSnapshot = $null
      try {
        $providerSnapshot = Get-Content -Raw -Encoding UTF8 -LiteralPath $providerStatePath | ConvertFrom-Json
      }
      catch {
        # The Provider replaces this JSON atomically. A transient read failure is
        # not a failed boundary; the next poll reads the complete snapshot.
      }
      if ($null -ne $providerSnapshot) {
        $shouldKill = switch ($runtimeKillPhase) {
          0 { Test-Path -LiteralPath $inboxBoundaryPath -PathType Leaf }
          1 { Test-Path -LiteralPath $questionBoundaryPath -PathType Leaf }
          2 { $providerSnapshot.scenarios.crash_inference.requests -ge 1 }
          3 { Test-Path -LiteralPath $effectBoundaryPath -PathType Leaf }
          4 { Test-Path -LiteralPath $projectionBoundaryPath -PathType Leaf }
        }
        if ($shouldKill) {
          $runtime = Find-SmokeRuntimeProcess -ElectronProcessId $process.Id `
            -RuntimeEntryPath $runtimeEntryPath
          if ($null -ne $runtime) {
            $runtimeProcessId = [int]$runtime.ProcessId
            $stoppedRuntime = Stop-Process -Id $runtimeProcessId -Force -PassThru
            if (-not $stoppedRuntime.WaitForExit(5000)) {
              throw "Electron smoke Runtime process $runtimeProcessId did not exit after boundary kill."
            }
            $acknowledgement = [ordered]@{
              protocol = "ariadne-electron-smoke-runtime-kill.v1"
              phase = $runtimeKillPhase
              scenario = $runtimeKillScenarios[$runtimeKillPhase]
              runtimeProcessId = $runtimeProcessId
              killedAt = [DateTime]::UtcNow.ToString("O")
            } | ConvertTo-Json -Compress
            [IO.File]::WriteAllText(
              (Join-Path $runtimeKillAckRoot $runtimeKillAckNames[$runtimeKillPhase]),
              $acknowledgement,
              [Text.UTF8Encoding]::new($false)
            )
            $runtimeKillPhase += 1
          }
        }
      }
    }
    if (
      $runtimeKillPhase -eq 5 `
      -and (Test-Path -LiteralPath $resultPath -PathType Leaf)
    ) {
      $stoppedMain = Stop-Process -Id $process.Id -Force -PassThru
      if (-not $stoppedMain.WaitForExit(5000)) {
        throw "Electron smoke Main process did not exit after the recovery boundary kill."
      }
      $mainCrashKilled = $true
    }
    elseif (Test-Path -LiteralPath $resultPath -PathType Leaf) {
      $earlyResult = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultPath | ConvertFrom-Json
      if ($earlyResult.passed -ne $true) {
        throw "Electron smoke failed before the Main crash boundary."
      }
    }
    Start-Sleep -Milliseconds 10
    $process.Refresh()
  }
  [void]$process.WaitForExit()
  $process.Refresh()
  if ($runtimeKillPhase -ne 5) {
    throw "Electron smoke completed only $runtimeKillPhase of 5 Runtime boundary kills."
  }
  if (-not $mainCrashKilled) {
    throw "Electron smoke did not execute the Main crash boundary."
  }
  if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
    throw "Electron smoke test did not create a result file."
  }
  $result = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultPath | ConvertFrom-Json
  if ($result.passed -ne $true) {
    throw "Electron smoke result did not pass."
  }
  $env:ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY = "1"
  Remove-Item Env:ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT -ErrorAction SilentlyContinue
  $desktopRecoveryProcess = Start-Process -FilePath $electronPath -ArgumentList $appRoot `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $desktopRecoveryStdoutPath `
    -RedirectStandardError $desktopRecoveryStderrPath
  [void]$desktopRecoveryProcess.Handle
  $desktopRecoveryDeadline = [DateTime]::UtcNow.AddSeconds(60)
  while (-not $desktopRecoveryProcess.HasExited) {
    if ([DateTime]::UtcNow -ge $desktopRecoveryDeadline) {
      Stop-Process -Id $desktopRecoveryProcess.Id -Force -ErrorAction SilentlyContinue
      throw "Electron desktop-restart delivery verification timed out."
    }
    Start-Sleep -Milliseconds 50
    $desktopRecoveryProcess.Refresh()
  }
  [void]$desktopRecoveryProcess.WaitForExit()
  $desktopRecoveryProcess.Refresh()
  if ($desktopRecoveryProcess.ExitCode -ne 0) {
    throw "Electron desktop-restart delivery verification failed with exit code $($desktopRecoveryProcess.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $desktopRecoveryResultPath -PathType Leaf)) {
    throw "Electron desktop-restart delivery verification did not create a result file."
  }
  $desktopRecoveryResult = Get-Content -Raw -Encoding UTF8 `
    -LiteralPath $desktopRecoveryResultPath | ConvertFrom-Json
  if ($desktopRecoveryResult.passed -ne $true) {
    throw "Electron desktop-restart delivery result did not pass."
  }
  Write-Output "Electron smoke test passed: $artifactRoot"
}
finally {
  if ($null -ne $desktopRecoveryProcess -and -not $desktopRecoveryProcess.HasExited) {
    Stop-Process -Id $desktopRecoveryProcess.Id -Force -ErrorAction SilentlyContinue
    [void]$desktopRecoveryProcess.WaitForExit(5000)
  }
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    [void]$process.WaitForExit(5000)
  }
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
  if (-not $KeepData -and (Test-Path -LiteralPath $smokeDataRoot)) {
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
