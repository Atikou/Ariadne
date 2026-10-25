param(
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [string]$MemorySessionId = '',
  [switch]$TaskCenter,
  [switch]$AllModules,
  [switch]$PendingDecisions,
  [switch]$TaskReminderRestart,
  [string]$PreviousEvidence = ''
)
$ErrorActionPreference = 'Stop'
if (@(@($TaskCenter, $TaskReminderRestart, $AllModules, $PendingDecisions, [bool]$MemorySessionId) | Where-Object { $_ }).Count -gt 1) { throw 'Module revisit scopes cannot be combined.' }
if ($TaskReminderRestart -and -not $PreviousEvidence) { throw 'Task reminder restart requires previous actual native evidence.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskDataRoot = [IO.Path]::GetFullPath($DataRoot)
$taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $taskDataRoot.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -or
  -not (([IO.Path]::GetFileName($taskDataRoot).StartsWith('AriadneSmoke-')) -or
    ($TaskReminderRestart -and [IO.Path]::GetFileName($taskDataRoot).StartsWith('AriadneDomainHealth-'))) -or
  -not (Test-Path -LiteralPath (Join-Path $taskDataRoot 'runtime/data/public-projection/projection.db'))) {
  throw 'Module UI revisit requires an existing isolated AriadneSmoke data directory.'
}
$taskOutput = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $taskOutput) { throw 'Module UI evidence output already exists.' }
New-Item -ItemType Directory -Path $taskOutput | Out-Null
if ($TaskReminderRestart) {
  $taskPrior = Get-Content -LiteralPath $PreviousEvidence -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([IO.Path]::GetFullPath($taskPrior.root) -ne $taskDataRoot -or (Get-Process -Id $taskPrior.mainPid -ErrorAction SilentlyContinue)) {
    throw 'Previous isolated native Main is still running or belongs to another directory.'
  }
  & node (Join-Path $PSScriptRoot 'smoke/task-notification-restart-checkpoint.mjs') $taskDataRoot $PreviousEvidence (Join-Path $taskOutput 'task-reminder-restart-checkpoint.json')
  if ($LASTEXITCODE -ne 0) { throw 'Read-only task reminder restart checkpoint failed.' }
}
$taskWorkspace = Join-Path $taskDataRoot 'workspace'
$taskIdentity = [IO.Path]::GetFullPath($taskWorkspace).ToLowerInvariant()
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskIdentity))).Replace('-', '').ToLowerInvariant() }
finally { $taskHasher.Dispose() }
$taskEnvironment = @{
  ARIADNE_SMOKE_TEST = '1'; ARIADNE_SMOKE_MODULE_UI_REVISIT = $(if ($TaskReminderRestart) { 'tasks-reminder-restart' } elseif ($AllModules) { 'all' } elseif ($PendingDecisions) { 'decisions' } elseif ($TaskCenter) { 'tasks' } elseif ($MemorySessionId) { 'memory' } else { '1' });
  ARIADNE_SMOKE_MEMORY_REVISIT_SESSION = $(if ($MemorySessionId) { $MemorySessionId } else { $null });
  ARIADNE_SMOKE_TEST_OUTPUT = $taskOutput; ARIADNE_SMOKE_USER_DATA = $taskDataRoot;
  ARIADNE_SMOKE_WORKSPACE_ROOT = $taskWorkspace; ARIADNE_SMOKE_WORKSPACE_ID = 'workspace-' + $taskHash.Substring(0,20);
  ARIADNE_RUNTIME_NODE_EXECUTABLE = (Get-Command node -ErrorAction Stop).Source;
  ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT = $null; ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY = $null;
  ELECTRON_RUN_AS_NODE = $null
}
$taskPrevious = @{}
$taskProcess = $null
try {
  foreach ($taskName in $taskEnvironment.Keys) {
    $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
    if ($null -eq $taskEnvironment[$taskName]) { Remove-Item -LiteralPath ('Env:' + $taskName) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($taskName, $taskEnvironment[$taskName], 'Process') }
  }
  $taskProcess = Start-Process -FilePath (Join-Path $projectRoot 'node_modules/electron/dist/electron.exe') -ArgumentList (Join-Path $projectRoot 'app') -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $taskOutput 'module-ui.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'module-ui.stderr.log')
  [void]$taskProcess.Handle
  $taskDeadline = [DateTime]::UtcNow.AddSeconds(180)
  while (-not $taskProcess.HasExited) {
    if ([DateTime]::UtcNow -ge $taskDeadline) { throw 'Scoped module UI revisit timed out.' }
    Start-Sleep -Milliseconds 100
    $taskProcess.Refresh()
  }
  [void]$taskProcess.WaitForExit()
  if ($taskProcess.ExitCode -ne 0) { throw 'Scoped module UI revisit failed.' }
  $taskEvidenceFiles = if ($TaskReminderRestart) { @('task-notification-main-restart.json') } elseif ($AllModules) { @('module-opening.json') } elseif ($PendingDecisions) { @('pending-decisions.json') } elseif ($TaskCenter) { @('task-center-source-execution.json','task-center-layout-1000.json','task-center-layout-1600.json') } elseif ($MemorySessionId) { @('memory-refresh-editing-execution.json') } else { @('agent-status-directory-execution.json','agent-status-layout-1000.json','agent-status-layout-1600.json') }
  foreach ($taskName in $taskEvidenceFiles) {
    if (-not ((Get-Content -LiteralPath (Join-Path $taskOutput $taskName) -Raw | ConvertFrom-Json).passed)) { throw ('Failed module evidence: ' + $taskName) }
  }
  Write-Output ('Actual isolated Source module revisit passed: ' + $taskOutput)
} finally {
  if ($null -ne $taskProcess) {
    $taskProcess.Refresh()
    if (-not $taskProcess.HasExited) { & taskkill.exe /PID $taskProcess.Id /T /F | Out-Null }
    $taskProcess.Dispose()
  }
  foreach ($taskName in $taskPrevious.Keys) {
    if ($null -eq $taskPrevious[$taskName]) { Remove-Item -LiteralPath ('Env:' + $taskName) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process') }
  }
}
