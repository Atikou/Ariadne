param([Parameter(Mandatory = $true)][string]$OutputRoot, [switch]$Lifecycle, [switch]$MainRestart, [switch]$TaskCenter)
$ErrorActionPreference = 'Stop'
if ($MainRestart -and -not $Lifecycle) { throw 'Main restart requires the native lifecycle gate.' }
if ($TaskCenter -and (-not $Lifecycle -or $MainRestart)) { throw 'Task center delivery acceptance requires its initial lifecycle scope.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not [IO.Path]::IsPathRooted($OutputRoot)) { throw 'Notification evidence path must be absolute.' }
$taskOutput = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $taskOutput) { throw 'Notification evidence destination already exists.' }
New-Item -ItemType Directory -Path $taskOutput | Out-Null
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('AriadneDomainHealth-' + [guid]::NewGuid().ToString('N'))
$workspaceRoot = Join-Path $taskRoot 'workspace'
New-Item -ItemType Directory -Path $workspaceRoot | Out-Null
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskHash = ($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($workspaceRoot).ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) -join '' }
finally { $taskHasher.Dispose() }
$workspaceId = 'workspace-' + $taskHash.Substring(0, 20)
$nodePath = (Get-Command node).Source
& $nodePath (Join-Path $PSScriptRoot 'smoke\domain-health-fixture.mjs') $taskRoot $workspaceId $taskOutput inference-remote
if ($LASTEXITCODE -ne 0) { throw 'Notification fixture creation failed.' }
. (Join-Path $PSScriptRoot 'smoke\provider-certificate.ps1')
New-SmokeProviderCertificate -PfxPath (Join-Path $taskRoot 'provider.pfx') -CertificatePath (Join-Path $taskRoot 'provider-cert.pem') -Passphrase 'ariadne-electron-smoke'
$names = @('ARIADNE_SMOKE_TEST','ARIADNE_SMOKE_NOTIFICATIONS','ARIADNE_SMOKE_TEST_OUTPUT','ARIADNE_SMOKE_USER_DATA',
  'ARIADNE_SMOKE_NOTIFICATION_LIFECYCLE','ARIADNE_SMOKE_NOTIFICATION_MAIN_RESTART','ARIADNE_SMOKE_TASK_NOTIFICATION_ACCEPTANCE','ARIADNE_SMOKE_PROJECTION_PROBE',
  'ARIADNE_SMOKE_WORKSPACE_ROOT','ARIADNE_SMOKE_WORKSPACE_ID','ARIADNE_RUNTIME_NODE_EXECUTABLE','ARIADNE_APPLICATION_PROFILE',
  'ARIADNE_SMOKE_PROVIDER_BASE_URL','ARIADNE_SMOKE_PROVIDER_MODEL','ARIADNE_SMOKE_PROVIDER_STATE','NODE_EXTRA_CA_CERTS',
  'ARIADNE_SMOKE_DOMAIN_HEALTH','ARIADNE_SMOKE_PROJECTION_CAPACITY','ARIADNE_SMOKE_PROFILE_VERIFY','ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT','ELECTRON_RUN_AS_NODE')
$previous = @{}; foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$taskProvider = $null; $taskProcess = $null; $owned = @{}
function Get-NotificationDescendants([int]$MainId) {
  $rows = @(Get-CimInstance Win32_Process); $ids = [Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($MainId)
  do { $changed = $false; foreach ($row in $rows) {
    if (-not $ids.Contains([int]$row.ProcessId) -and $ids.Contains([int]$row.ParentProcessId)) { [void]$ids.Add([int]$row.ProcessId); $changed = $true }
  } } while ($changed)
  return @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.ProcessId -ne $MainId })
}
try {
  $probe = Join-Path $taskRoot 'projection-probe.js'
  & $nodePath (Join-Path $PSScriptRoot 'build-smoke-projection-probe.mjs') $probe
  if ($LASTEXITCODE -ne 0) { throw 'Notification projection probe build failed.' }
  $env:ARIADNE_SMOKE_PROJECTION_PROBE = $probe
  if ($Lifecycle) { $env:ARIADNE_SMOKE_NOTIFICATION_LIFECYCLE = '1' }
  else { Remove-Item Env:ARIADNE_SMOKE_NOTIFICATION_LIFECYCLE -ErrorAction SilentlyContinue }
  if ($MainRestart) { $env:ARIADNE_SMOKE_NOTIFICATION_MAIN_RESTART = '1' }
  else { Remove-Item Env:ARIADNE_SMOKE_NOTIFICATION_MAIN_RESTART -ErrorAction SilentlyContinue }
  if ($TaskCenter) { $env:ARIADNE_SMOKE_TASK_NOTIFICATION_ACCEPTANCE = '1' }
  else { Remove-Item Env:ARIADNE_SMOKE_TASK_NOTIFICATION_ACCEPTANCE -ErrorAction SilentlyContinue }
  $env:NODE_EXTRA_CA_CERTS = Join-Path $taskRoot 'provider-cert.pem'
  $providerReady = Join-Path $taskRoot 'provider-ready.json'; $providerState = Join-Path $taskRoot 'provider-state.json'
  $model = 'ariadne-notification-smoke-model'
  $taskProvider = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden -ArgumentList @(
    (Join-Path $PSScriptRoot 'electron-smoke-provider.mjs'), '--model', $model, '--state', $providerState, '--ready', $providerReady,
    '--pfx', (Join-Path $taskRoot 'provider.pfx'), '--passphrase', 'ariadne-electron-smoke', '--workspace-id', $workspaceId,
    '--agent-db', (Join-Path $taskRoot 'runtime\data\agent-control\agent-control.db')) `
    -RedirectStandardOutput (Join-Path $taskOutput 'provider.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'provider.stderr.log')
  [void]$taskProvider.Handle
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $providerReady)) {
    $taskProvider.Refresh(); if ($taskProvider.HasExited -or [DateTime]::UtcNow -ge $readyDeadline) { throw 'Notification Provider fixture not ready.' }
    Start-Sleep -Milliseconds 100
  }
  $provider = Get-Content -Raw -Encoding UTF8 -LiteralPath $providerReady | ConvertFrom-Json
  if ($provider.protocol -ne 'ariadne-electron-smoke-provider-ready.v1') { throw 'Notification Provider ready format invalid.' }
  $env:ARIADNE_SMOKE_TEST = '1'; $env:ARIADNE_SMOKE_NOTIFICATIONS = '1'; $env:ARIADNE_SMOKE_TEST_OUTPUT = $taskOutput
  $env:ARIADNE_SMOKE_USER_DATA = $taskRoot; $env:ARIADNE_SMOKE_WORKSPACE_ROOT = $workspaceRoot; $env:ARIADNE_SMOKE_WORKSPACE_ID = $workspaceId
  $env:ARIADNE_RUNTIME_NODE_EXECUTABLE = $nodePath; $env:ARIADNE_APPLICATION_PROFILE = 'desktop-default'
  $env:ARIADNE_SMOKE_PROVIDER_BASE_URL = [string]$provider.baseUrl; $env:ARIADNE_SMOKE_PROVIDER_MODEL = $model; $env:ARIADNE_SMOKE_PROVIDER_STATE = $providerState
  Remove-Item Env:ARIADNE_SMOKE_DOMAIN_HEALTH, Env:ARIADNE_SMOKE_PROJECTION_CAPACITY, Env:ARIADNE_SMOKE_PROFILE_VERIFY, Env:ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $taskProcess = Start-Process -FilePath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe') -ArgumentList (Join-Path $projectRoot 'app') `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskOutput 'stdout.log') -RedirectStandardError (Join-Path $taskOutput 'stderr.log')
  [void]$taskProcess.Handle
  $taskDeadline = [DateTime]::UtcNow.AddMinutes(5)
  $taskRestartHandled = $false
  $taskMainRestartHandled = $false
  while (-not $taskProcess.HasExited) {
    foreach ($child in Get-NotificationDescendants $taskProcess.Id) { $owned[[int]$child.ProcessId] = $child }
    $taskRestartRequest = Join-Path $taskOutput 'restart-runtime-request.json'
    if ($Lifecycle -and -not $taskRestartHandled -and (Test-Path -LiteralPath $taskRestartRequest)) {
      $taskRequest = Get-Content -LiteralPath $taskRestartRequest -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($taskRequest.mainPid -ne $taskProcess.Id) { throw 'Notification Runtime restart request owner mismatch.' }
      $taskEntry = Join-Path $projectRoot 'runtime\dist\entry\runtime-process.js'
      $taskCandidates = @(Get-NotificationDescendants $taskProcess.Id | Where-Object {
        $_.ParentProcessId -eq $taskProcess.Id -and $_.ExecutablePath -eq $nodePath -and $_.CommandLine.Contains($taskEntry)
      })
      if ($taskCandidates.Count -ne 1) { throw 'Notification Runtime restart target is not unique.' }
      $taskRuntime = $taskCandidates[0]
      $taskCurrent = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskRuntime.ProcessId)"
      if ($taskCurrent.CreationDate -ne $taskRuntime.CreationDate -or $taskCurrent.CommandLine -ne $taskRuntime.CommandLine) {
        throw 'Notification Runtime restart target identity changed.'
      }
      Stop-Process -Id $taskRuntime.ProcessId -ErrorAction Stop
      [IO.File]::WriteAllText((Join-Path $taskOutput 'runtime-restart-proof.json'),
        (@{ mainPid = $taskProcess.Id; runtimePid = $taskRuntime.ProcessId; physicalOwnedRuntimeKill = $true;
          executablePath = $taskRuntime.ExecutablePath; entryPath = $taskEntry; killedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false))
      $taskRestartHandled = $true
    }
    $taskMainRequest = Join-Path $taskOutput 'restart-main-request.json'
    if ($MainRestart -and -not $taskMainRestartHandled -and (Test-Path -LiteralPath $taskMainRequest)) {
      $taskRequest = Get-Content -LiteralPath $taskMainRequest -Raw -Encoding UTF8 | ConvertFrom-Json
      $taskCurrentMain = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.Id)"
      $taskElectron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
      if ($taskRequest.mainPid -ne $taskProcess.Id -or $taskCurrentMain.ExecutablePath -ne $taskElectron) { throw 'Main restart target mismatch.' }
      $taskBeforePid = $taskProcess.Id
      Stop-Process -Id $taskBeforePid -ErrorAction Stop
      $taskProcess.WaitForExit()
      foreach ($id in $owned.Keys) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if ($current -and $current.CreationDate -eq $owned[$id].CreationDate -and $current.CommandLine -eq $owned[$id].CommandLine) {
          Stop-Process -Id $id -ErrorAction Stop
        }
      }
      $taskProcess = Start-Process -FilePath $taskElectron -ArgumentList (Join-Path $projectRoot 'app') -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $taskOutput 'main-restart.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'main-restart.stderr.log')
      [void]$taskProcess.Handle
      [IO.File]::WriteAllText((Join-Path $taskOutput 'main-restart-proof.json'),
        (@{ previousMainPid=$taskBeforePid; newMainPid=$taskProcess.Id; physicalOwnedMainKill=$true;
          executablePath=$taskElectron; restartedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
      $taskMainRestartHandled = $true
    }
    if ([DateTime]::UtcNow -ge $taskDeadline) { throw 'Native Decision notification gate timed out.' }
    Start-Sleep -Milliseconds 250; $taskProcess.Refresh()
  }
  $taskProcess.WaitForExit()
  if ($taskProcess.ExitCode -ne 0) { throw 'Native Decision notification gate failed.' }
  $result = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $taskOutput 'decision-notification.json') | ConvertFrom-Json
  if ($Lifecycle) {
    if (-not $result.passed -or -not $result.observations.nativeLifecycleCompleted) { throw 'Native display lifecycle was not accepted.' }
    if ($TaskCenter -and -not $result.observations.taskReminders.completedRunNativeShown) { throw 'Terminal task native delivery was not accepted.' }
    if ($TaskCenter -and -not $result.observations.taskReminders.failedRunNativeShown) { throw 'Failed task native delivery was not accepted.' }
    Write-Output 'Native display lifecycle passed; this gate does not accept a physical Windows click.'
  } else {
    if (-not $result.passed -or -not $result.observations.actualWindowsClickObserved) { throw 'Native Decision notification was not accepted.' }
    Write-Output 'Actual production Decision notification shown and physically clicked; exact Session and Decision rendered.'
  }
}
finally {
  if ($taskProcess -and -not $taskProcess.HasExited) {
    foreach ($child in Get-NotificationDescendants $taskProcess.Id) { $owned[[int]$child.ProcessId] = $child }
    Stop-Process -Id $taskProcess.Id -ErrorAction SilentlyContinue
  }
  foreach ($id in $owned.Keys) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $owned[$id].CreationDate -and $current.CommandLine -eq $owned[$id].CommandLine) {
      Stop-Process -Id $id -ErrorAction SilentlyContinue
    }
  }
  if ($taskProvider -and -not $taskProvider.HasExited) { Stop-Process -Id $taskProvider.Id -ErrorAction SilentlyContinue }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
