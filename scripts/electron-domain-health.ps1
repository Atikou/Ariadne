param([Parameter(Mandatory = $true)][string]$OutputRoot, [ValidateSet('source','memory','memory-model','journal','execution','conversation','projection','inference','inference-local','inference-remote','task','task-resume')][string]$Scenario = 'source')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not [IO.Path]::IsPathRooted($OutputRoot)) { throw 'Domain health evidence root must be absolute.' }
$taskOutput = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $taskOutput) { throw 'Domain health evidence destination already exists.' }
New-Item -ItemType Directory -Path $taskOutput | Out-Null
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('AriadneDomainHealth-' + [guid]::NewGuid().ToString('N'))
$taskWorkspace = Join-Path $taskRoot 'workspace'
New-Item -ItemType Directory -Path $taskWorkspace | Out-Null
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskHash = ($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($taskWorkspace).ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) -join '' }
finally { $taskHasher.Dispose() }
$workspaceId = 'workspace-' + $taskHash.Substring(0, 20)
$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath (Join-Path $PSScriptRoot 'smoke\domain-health-fixture.mjs') $taskRoot $workspaceId $taskOutput $Scenario
if ($LASTEXITCODE -ne 0) { throw 'Domain health fixture generation failed.' }
$fixture = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $taskOutput 'fixture.json') | ConvertFrom-Json

function Get-DomainHealthDescendants([int]$MainId) {
  $rows = @(Get-CimInstance Win32_Process)
  $ids = [Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($MainId)
  do {
    $changed = $false
    foreach ($row in $rows) {
      if (-not $ids.Contains([int]$row.ProcessId) -and $ids.Contains([int]$row.ParentProcessId)) {
        [void]$ids.Add([int]$row.ProcessId); $changed = $true
      }
    }
  } while ($changed)
  return @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.ProcessId -ne $MainId })
}
$names = @('ARIADNE_SMOKE_TEST','ARIADNE_SMOKE_DOMAIN_HEALTH','ARIADNE_SMOKE_DOMAIN_PHASE','ARIADNE_SMOKE_DOMAIN_SCENARIO','ARIADNE_SMOKE_TEST_OUTPUT',
  'ARIADNE_SMOKE_USER_DATA','ARIADNE_SMOKE_WORKSPACE_ROOT','ARIADNE_SMOKE_WORKSPACE_ID','ARIADNE_RUNTIME_NODE_EXECUTABLE',
  'ARIADNE_APPLICATION_PROFILE','ARIADNE_SMOKE_PROJECTION_CAPACITY','ARIADNE_SMOKE_PROFILE_VERIFY','ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT','ELECTRON_RUN_AS_NODE','NODE_EXTRA_CA_CERTS')
$previous = @{}; foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$taskProcess = $null; $taskProvider = $null; $owned = @{}
try {
  if ($Scenario -eq 'inference-remote') {
    . (Join-Path $PSScriptRoot 'smoke\provider-certificate.ps1')
    $taskCertificate = Join-Path $taskRoot 'provider-cert.pem'
    New-SmokeProviderCertificate -PfxPath (Join-Path $taskRoot 'provider.pfx') -CertificatePath $taskCertificate -Passphrase 'ariadne-electron-smoke'
    $env:NODE_EXTRA_CA_CERTS = $taskCertificate
    $taskProviderArguments = '"' + (Join-Path $PSScriptRoot 'smoke\remote-health-provider.mjs') + '" "' + $taskRoot + '"'
    $taskProvider = Start-Process -FilePath $nodePath -ArgumentList $taskProviderArguments -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $taskOutput 'provider.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'provider.stderr.log')
    [void]$taskProvider.Handle
    $taskProviderDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'provider-ready.json'))) {
      $taskProvider.Refresh()
      if ($taskProvider.HasExited -or [DateTime]::UtcNow -ge $taskProviderDeadline) { throw 'Remote health Provider fixture failed to start.' }
      Start-Sleep -Milliseconds 100
    }
  }
  $env:ARIADNE_SMOKE_TEST = '1'; $env:ARIADNE_SMOKE_DOMAIN_HEALTH = '1'
  $env:ARIADNE_SMOKE_DOMAIN_SCENARIO = $Scenario
  $env:ARIADNE_SMOKE_USER_DATA = $taskRoot; $env:ARIADNE_SMOKE_WORKSPACE_ROOT = $taskWorkspace
  $env:ARIADNE_SMOKE_WORKSPACE_ID = $workspaceId; $env:ARIADNE_RUNTIME_NODE_EXECUTABLE = $nodePath
  $env:ARIADNE_APPLICATION_PROFILE = 'desktop-default'
  Remove-Item Env:ARIADNE_SMOKE_PROJECTION_CAPACITY, Env:ARIADNE_SMOKE_PROFILE_VERIFY, Env:ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  foreach ($phase in @('initial','main-restart')) {
    $phaseOutput = Join-Path $taskOutput $phase
    New-Item -ItemType Directory -Path $phaseOutput | Out-Null
    $env:ARIADNE_SMOKE_DOMAIN_PHASE = $phase; $env:ARIADNE_SMOKE_TEST_OUTPUT = $phaseOutput
    $taskProcess = Start-Process -FilePath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe') -ArgumentList (Join-Path $projectRoot 'app') `
      -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $phaseOutput 'stdout.log') -RedirectStandardError (Join-Path $phaseOutput 'stderr.log')
    [void]$taskProcess.Handle
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    while (-not $taskProcess.HasExited) {
      foreach ($child in Get-DomainHealthDescendants $taskProcess.Id) { $owned[[int]$child.ProcessId] = $child }
      if ([DateTime]::UtcNow -ge $deadline) { throw "Domain health Electron timed out: $phase" }
      Start-Sleep -Milliseconds 250; $taskProcess.Refresh()
    }
    $taskProcess.WaitForExit()
    $resultPath = Join-Path $phaseOutput 'domain-health.json'
    if ($taskProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) { throw "Domain health native run failed: $phase" }
    $result = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultPath | ConvertFrom-Json
    if (-not $result.passed -or $result.format -ne 'ariadne-electron-domain-health.v1') { throw "Domain health acceptance failed: $phase" }
    if ($Scenario -in @('source','memory','memory-model','journal','execution','conversation','projection','inference')) {
      $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixture.databasePath).Hash.ToLowerInvariant()
      if ($sourceHash -ne $fixture.corruptSourceSha256) { throw 'Domain health verification changed original malformed source bytes.' }
      Write-Output "Domain health $phase passed; original source bytes retained."
    } elseif ($Scenario -eq 'inference-local') {
      & $nodePath (Join-Path $PSScriptRoot 'smoke\domain-health-fixture.mjs') $taskRoot $workspaceId $taskOutput verify-inference-local
      if ($LASTEXITCODE -ne 0) { throw 'Local inference verification failed model retention or qualification source audit.' }
      Write-Output "Local inference $phase passed; original model bytes retained and actual qualification source audited."
    } elseif ($Scenario -eq 'inference-remote') {
      if (-not $result.observations.realHttpsFailureObserved -or -not $result.observations.sameBindingResponseRecovered -or -not $result.observations.warningClearedAfterResponse) {
        throw 'Remote inference verification did not cover actual failure and successful response.'
      }
      Write-Output "Remote inference $phase passed; actual HTTPS failure and same-binding recovery observed."
    } else {
      & $nodePath (Join-Path $PSScriptRoot 'smoke\domain-health-fixture.mjs') $taskRoot $workspaceId $taskOutput verify-task
      if ($LASTEXITCODE -ne 0) { throw 'Task fault native verification changed original task effects.' }
      Write-Output "Task fault $phase passed; original task effects retained."
    }
    $taskProcess = $null
  }
  [IO.File]::WriteAllText((Join-Path $taskOutput 'gate.json'), (@{ format='ariadne-domain-health-gate.v1'; scenario=$Scenario; passed=$true;
    root=$taskRoot; sourceBytesRetained=($Scenario -in @('source','memory','memory-model','journal','execution','conversation','projection','inference')); originalModelBytesRetained=($Scenario -eq 'inference-local'); originalTaskEffectsRetained=($Scenario -in @('task','task-resume')); phases=@('initial','main-restart') } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
finally {
  if ($taskProvider -and -not $taskProvider.HasExited) { Stop-Process -Id $taskProvider.Id -ErrorAction SilentlyContinue }
  if ($taskProcess -and -not $taskProcess.HasExited) {
    foreach ($child in Get-DomainHealthDescendants $taskProcess.Id) { $owned[[int]$child.ProcessId] = $child }
    Stop-Process -Id $taskProcess.Id -ErrorAction SilentlyContinue
  }
  foreach ($id in $owned.Keys) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $owned[$id].CreationDate -and $current.CommandLine -eq $owned[$id].CommandLine) {
      Stop-Process -Id $id -ErrorAction SilentlyContinue
    }
  }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
