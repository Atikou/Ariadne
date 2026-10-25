param([string]$OutputRoot = '', [string]$FixtureManifest = '')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskOutput = if ($OutputRoot) { [IO.Path]::GetFullPath($OutputRoot) } else { Join-Path $projectRoot 'artifacts\electron-projection-capacity' }
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$appRoot = Join-Path $projectRoot 'app'
$runtimeEntry = Join-Path $projectRoot 'runtime\dist\entry\runtime-process.js'
$nodePath = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
if ($FixtureManifest) {
  $fixture = Get-Content -Raw -Encoding utf8 -LiteralPath $FixtureManifest | ConvertFrom-Json
  if ($fixture.format -ne 'ariadne-projection-electron-capacity.v1' -or $fixture.messageCount -ne 10000 -or
    $fixture.sessionCount -ne 150 -or $fixture.serializedMessageBytes -le 64MB -or $fixture.pendingHandoffCount -ne 0) {
    throw 'Capacity fixture metadata is invalid or incomplete.'
  }
  $taskRoot = [IO.Path]::GetFullPath([string]$fixture.root)
  $workspaceId = [string]$fixture.workspaceId
} else {
  $taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('AriadneCapacity-' + [guid]::NewGuid().ToString('N'))
  $taskWorkspace = Join-Path $taskRoot 'workspace'
  New-Item -ItemType Directory -Path $taskWorkspace | Out-Null
  $taskIdentity = [IO.Path]::GetFullPath($taskWorkspace).ToLowerInvariant()
  $taskHasher = [Security.Cryptography.SHA256]::Create()
  try { $taskHash = ($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskIdentity)) | ForEach-Object { $_.ToString('x2') }) -join '' }
  finally { $taskHasher.Dispose() }
  $workspaceId = 'workspace-' + $taskHash.Substring(0, 20)
  & $nodePath (Join-Path $PSScriptRoot 'benchmarks\projection-electron-fixture.mjs') $taskRoot $workspaceId $taskOutput
  if ($LASTEXITCODE -ne 0) { throw 'Capacity fixture generation failed.' }
}
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $taskRoot.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path -Leaf $taskRoot).StartsWith('AriadneCapacity-')) {
  throw 'Capacity verification data must remain in its named TEMP directory.'
}

function Get-CapacityDescendants([int]$MainId) {
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

$names = @('ARIADNE_SMOKE_TEST', 'ARIADNE_SMOKE_PROJECTION_CAPACITY', 'ARIADNE_SMOKE_CAPACITY_PHASE',
  'ARIADNE_SMOKE_TEST_OUTPUT', 'ARIADNE_SMOKE_USER_DATA', 'ARIADNE_SMOKE_WORKSPACE_ROOT', 'ARIADNE_SMOKE_WORKSPACE_ID',
  'ARIADNE_RUNTIME_NODE_EXECUTABLE', 'ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT', 'ARIADNE_SMOKE_PROFILE_VERIFY',
  'ARIADNE_APPLICATION_PROFILE', 'ELECTRON_RUN_AS_NODE')
$previous = @{}; foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$taskProcess = $null; $ownedDescendants = @()
try {
  $env:ARIADNE_SMOKE_TEST = '1'; $env:ARIADNE_SMOKE_PROJECTION_CAPACITY = '1'
  $env:ARIADNE_RUNTIME_NODE_EXECUTABLE = $nodePath
  $env:ARIADNE_APPLICATION_PROFILE = 'desktop-default'
  Remove-Item Env:ARIADNE_SMOKE_PROFILE_VERIFY, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  foreach ($phase in @('baseline', 'initial', 'main-restart')) {
    if ($phase -eq 'baseline') {
      $phaseRoot = Join-Path ([IO.Path]::GetTempPath()) ('AriadneCapacity-' + [guid]::NewGuid().ToString('N'))
      $phaseWorkspace = Join-Path $phaseRoot 'workspace'
      New-Item -ItemType Directory -Path $phaseWorkspace | Out-Null
      $phaseHasher = [Security.Cryptography.SHA256]::Create()
      try { $phaseHash = ($phaseHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($phaseWorkspace).ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) -join '' }
      finally { $phaseHasher.Dispose() }
      $phaseWorkspaceId = 'workspace-' + $phaseHash.Substring(0, 20)
    } else { $phaseRoot = $taskRoot; $phaseWorkspace = Join-Path $taskRoot 'workspace'; $phaseWorkspaceId = $workspaceId }
    $env:ARIADNE_SMOKE_USER_DATA = $phaseRoot; $env:ARIADNE_SMOKE_WORKSPACE_ROOT = $phaseWorkspace
    $env:ARIADNE_SMOKE_WORKSPACE_ID = $phaseWorkspaceId
    $phaseOutput = Join-Path $taskOutput $phase
    if (Test-Path -LiteralPath $phaseOutput) { throw "Capacity evidence destination already exists: $phaseOutput" }
    New-Item -ItemType Directory -Path $phaseOutput | Out-Null
    $env:ARIADNE_SMOKE_TEST_OUTPUT = $phaseOutput; $env:ARIADNE_SMOKE_CAPACITY_PHASE = $phase
    $env:ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT = if ($phase -eq 'initial') { '1' } else { '0' }
    $taskProcess = Start-Process -FilePath $electronPath -ArgumentList $appRoot -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $phaseOutput 'stdout.log') -RedirectStandardError (Join-Path $phaseOutput 'stderr.log')
    [void]$taskProcess.Handle
    $processSamples = [Collections.Generic.List[object]]::new()
    $nextSampleAt = [DateTime]::UtcNow
    $runtimeKilled = $false; $deadline = [DateTime]::UtcNow.AddMinutes(5)
    $resultPath = Join-Path $phaseOutput "capacity-$phase.json"
    while (-not $taskProcess.HasExited -and -not (Test-Path -LiteralPath $resultPath)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw "Capacity Electron timed out: $phase" }
      if ([DateTime]::UtcNow -ge $nextSampleAt -and $processSamples.Count -lt 180) {
        $runtimeRows = @(Get-CapacityDescendants $taskProcess.Id | Where-Object { ([string]$_.CommandLine).IndexOf($runtimeEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        foreach ($runtimeRow in $runtimeRows) {
          $runtimeProcess = Get-Process -Id $runtimeRow.ProcessId -ErrorAction SilentlyContinue
          if ($null -ne $runtimeProcess) { $processSamples.Add(@{ at = [DateTime]::UtcNow.ToString('o'); pid = $runtimeProcess.Id;
            workingSetBytes = $runtimeProcess.WorkingSet64; peakWorkingSetBytes = $runtimeProcess.PeakWorkingSet64;
            privateBytes = $runtimeProcess.PrivateMemorySize64; cpuSeconds = $runtimeProcess.TotalProcessorTime.TotalSeconds;
            startedAt = $runtimeProcess.StartTime.ToUniversalTime().ToString('o');
            readTransferBytes = [UInt64]$runtimeRow.ReadTransferCount; writeTransferBytes = [UInt64]$runtimeRow.WriteTransferCount;
            readOperations = [UInt64]$runtimeRow.ReadOperationCount; writeOperations = [UInt64]$runtimeRow.WriteOperationCount }) }
        }
        $nextSampleAt = [DateTime]::UtcNow.AddMilliseconds(500)
      }
      if ($phase -eq 'initial' -and -not $runtimeKilled -and (Test-Path -LiteralPath (Join-Path $phaseOutput 'runtime-kill.ready'))) {
        $runtimes = @(Get-CapacityDescendants $taskProcess.Id | Where-Object { ([string]$_.CommandLine).IndexOf($runtimeEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        if ($runtimes.Count -ne 1) { throw 'Capacity Runtime kill target is ambiguous or absent.' }
        Stop-Process -Id $runtimes[0].ProcessId -Force
        $runtimeKilled = $true
        Write-Output "Capacity Runtime killed: $($runtimes[0].ProcessId)"
      }
      Start-Sleep -Milliseconds 100; $taskProcess.Refresh()
    }
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "Capacity Electron exited without a result: $phase" }
    @{ format = 'ariadne-capacity-runtime-process-metrics.v1'; phase = $phase; dataRoot = $phaseRoot;
      samples = $processSamples.ToArray() } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $phaseOutput 'runtime-process-metrics.json')
    $result = Get-Content -Raw -Encoding utf8 -LiteralPath $resultPath | ConvertFrom-Json
    $startupTraces = @()
    foreach ($traceFile in @(Get-ChildItem -LiteralPath $phaseOutput -Filter 'runtime-startup-*.jsonl')) {
      $points = @(Get-Content -LiteralPath $traceFile.FullName -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json })
      if ($points.Count -lt 2 -or $points.Count -gt 128 -or $points[0].stage -ne 'bootstrap' -or
        @($points | Where-Object { $_.format -ne 'ariadne-runtime-startup-point.v2' -or $_.pid -ne $points[0].pid -or
          $null -eq $_.cpu -or $null -eq $_.wallTimeMs }).Count -ne 0) {
        throw 'Capacity Runtime startup trace is invalid.'
      }
      $startupTraces += @{ pid = $points[0].pid; completed = $points[-1].stage -eq 'ready'; points = $points }
    }
    @{ format = 'ariadne-capacity-startup-metrics.v1'; phase = $phase; traces = $startupTraces } |
      ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $phaseOutput 'runtime-startup-metrics.json')
    if (-not $result.passed) {
      $failureReason = if ($result.fatalError) { [string]$result.fatalError } elseif ($result.unexpectedRuntimeCrash) { 'Unexpected Runtime crash or handshake timeout.' } else { 'Console, scalar-query or response-capacity guard failed.' }
      throw "Capacity Electron failed: $phase; $failureReason"
    }
    $expectedRuntimeCount = if ($phase -eq 'initial') { 2 } else { 1 }
    if ($startupTraces.Count -ne $expectedRuntimeCount -or @($startupTraces | Where-Object { -not $_.completed }).Count -ne 0) {
      throw 'Capacity Runtime startup attribution is incomplete.'
    }
    if ($phase -eq 'initial') {
      if (-not $runtimeKilled) { throw 'Capacity Runtime crash was not observed.' }
      $ownedDescendants = @(Get-CapacityDescendants $taskProcess.Id)
      Stop-Process -Id $taskProcess.Id -Force
      foreach ($child in $ownedDescendants) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
      [void]$taskProcess.WaitForExit()
      Write-Output "Capacity Main killed after result: $($taskProcess.Id)"
    } else {
      if (-not $taskProcess.WaitForExit(30000)) { throw 'Capacity Main did not finish cleanup.' }
      if ($taskProcess.ExitCode -ne 0) { throw 'Capacity Main cleanup failed.' }
    }
    Write-Output "Capacity phase passed: $phase"
  }
  Write-Output "Capacity fixture retained: $taskRoot"
} finally {
  if ($null -ne $taskProcess -and -not $taskProcess.HasExited) {
    $ownedDescendants = @(Get-CapacityDescendants $taskProcess.Id)
    Stop-Process -Id $taskProcess.Id -Force -ErrorAction SilentlyContinue
    foreach ($child in $ownedDescendants) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
