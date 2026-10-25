param([Parameter(Mandatory = $true)][string]$OutputRoot, [switch]$PhysicalTyping)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not [IO.Path]::IsPathRooted($OutputRoot)) { throw 'Draft evidence path must be absolute.' }
$taskOutput = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $taskOutput) { throw 'Draft evidence destination already exists.' }
New-Item -ItemType Directory -Path $taskOutput | Out-Null
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('AriadneChatDraft-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
[IO.File]::WriteAllText((Join-Path $taskOutput 'owned-fixture.json'),(@{format='ariadne-chat-draft-fixture.v1';root=$taskRoot}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$taskWorkspace=Join-Path $taskRoot 'workspace';New-Item -ItemType Directory -Path $taskWorkspace | Out-Null
$taskHasher=[Security.Cryptography.SHA256]::Create()
try{$taskHash=($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($taskWorkspace).ToLowerInvariant()))|ForEach-Object{$_.ToString('x2')}) -join ''}
finally{$taskHasher.Dispose()}
$workspaceId='workspace-'+$taskHash.Substring(0,20)
$electronPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'))
$nodePath = (Get-Command node -ErrorAction Stop).Source
$names = @('ARIADNE_SMOKE_TEST','ARIADNE_SMOKE_CHAT_DRAFTS','ARIADNE_SMOKE_DRAFT_PHASE','ARIADNE_SMOKE_TEST_OUTPUT','ARIADNE_SMOKE_USER_DATA',
  'ARIADNE_RUNTIME_NODE_EXECUTABLE','ARIADNE_APPLICATION_PROFILE','ARIADNE_SMOKE_NOTIFICATIONS','ARIADNE_SMOKE_DOMAIN_HEALTH',
  'ARIADNE_SMOKE_PROJECTION_CAPACITY','ARIADNE_SMOKE_PROFILE_VERIFY','ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT',
  'ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY','ELECTRON_RUN_AS_NODE')
$names += @('ARIADNE_SMOKE_WORKSPACE_ROOT','ARIADNE_SMOKE_WORKSPACE_ID','ARIADNE_SMOKE_DRAFT_PHYSICAL_TYPING')
$previous=@{};$previousPresence=@{}; foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process');$previousPresence[$name]=[Environment]::GetEnvironmentVariables('Process').Contains($name)}
$taskProcess=$null; $owned=@{}
function Get-DraftDescendants([int]$MainId) {
  $rows=@(Get-CimInstance Win32_Process); $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($MainId)
  do { $changed=$false; foreach($row in $rows) {
    if(-not $ids.Contains([int]$row.ProcessId) -and $ids.Contains([int]$row.ParentProcessId)){[void]$ids.Add([int]$row.ProcessId);$changed=$true}
  }} while($changed)
  return @($rows|Where-Object {$ids.Contains([int]$_.ProcessId) -and $_.ProcessId -ne $MainId})
}
function Stop-OwnedDraftChildren {
  foreach($id in @($owned.Keys)) {
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if($current -and $current.CreationDate -eq $owned[$id].CreationDate -and $current.CommandLine -eq $owned[$id].CommandLine){Stop-Process -Id $id -ErrorAction SilentlyContinue}
  }
}
try {
  $env:ARIADNE_SMOKE_TEST='1';$env:ARIADNE_SMOKE_CHAT_DRAFTS='1';$env:ARIADNE_SMOKE_TEST_OUTPUT=$taskOutput
  $env:ARIADNE_SMOKE_USER_DATA=$taskRoot;$env:ARIADNE_RUNTIME_NODE_EXECUTABLE=$nodePath;$env:ARIADNE_APPLICATION_PROFILE='desktop-default'
  $env:ARIADNE_SMOKE_WORKSPACE_ROOT=$taskWorkspace;$env:ARIADNE_SMOKE_WORKSPACE_ID=$workspaceId
  if($PhysicalTyping){$env:ARIADNE_SMOKE_DRAFT_PHYSICAL_TYPING='1'}else{Remove-Item -LiteralPath 'Env:ARIADNE_SMOKE_DRAFT_PHYSICAL_TYPING' -ErrorAction SilentlyContinue}
  foreach($name in @('ARIADNE_SMOKE_NOTIFICATIONS','ARIADNE_SMOKE_DOMAIN_HEALTH','ARIADNE_SMOKE_PROJECTION_CAPACITY','ARIADNE_SMOKE_PROFILE_VERIFY',
    'ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT','ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY','ELECTRON_RUN_AS_NODE')){Remove-Item -LiteralPath ('Env:'+ $name) -ErrorAction SilentlyContinue}
  $priorMainId=$null
  foreach($phase in @('initial','main-restart')) {
    $env:ARIADNE_SMOKE_DRAFT_PHASE=$phase
    $taskProcess=Start-Process -FilePath $electronPath -ArgumentList ('"'+(Join-Path $projectRoot 'app')+'"') -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $taskOutput "$phase.stdout.log") -RedirectStandardError (Join-Path $taskOutput "$phase.stderr.log")
    [void]$taskProcess.Handle
    $mainIdentity=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.Id)"
    if(-not $mainIdentity -or [string]::IsNullOrWhiteSpace([string]$mainIdentity.ExecutablePath) -or [IO.Path]::GetFullPath([string]$mainIdentity.ExecutablePath) -ne $electronPath){throw 'Draft Main identity could not be established; inspect preserved phase stderr.'}
    $deadline=[DateTime]::UtcNow.AddMinutes(2);$cut=$false
    while(-not $taskProcess.HasExited) {
      foreach($child in Get-DraftDescendants $taskProcess.Id){$owned[[int]$child.ProcessId]=$child}
      $requestPath=Join-Path $taskOutput 'restart-main-request.json'
      if($phase -eq 'initial' -and (Test-Path -LiteralPath $requestPath)) {
        $request=Get-Content -Raw -Encoding UTF8 -LiteralPath $requestPath | ConvertFrom-Json
        $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.Id)"
        if($request.format -ne 'ariadne-chat-draft-main-cut.v1' -or $request.mainPid -ne $taskProcess.Id -or -not $current `
          -or $current.CreationDate -ne $mainIdentity.CreationDate -or $current.CommandLine -ne $mainIdentity.CommandLine){throw 'Draft Main cut ownership mismatch.'}
        $priorMainId=$taskProcess.Id;Stop-Process -Id $taskProcess.Id;Stop-OwnedDraftChildren;$cut=$true;break
      }
      if([DateTime]::UtcNow -ge $deadline){throw "Draft Electron gate timed out: $phase"}
      Start-Sleep -Milliseconds 200;$taskProcess.Refresh()
    }
    $taskProcess.WaitForExit()
    if($phase -eq 'initial') {
      if(-not $cut){throw 'Draft initial phase failed before the physical Main cut.'}
      $taskProcess=$null;continue
    }
    $result=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $taskOutput 'chat-drafts.json') | ConvertFrom-Json
    if($taskProcess.ExitCode -ne 0 -or -not $result.passed -or $result.format -ne 'ariadne-electron-chat-drafts.v1' `
      -or $result.observations.priorMainPid -ne $priorMainId -or $result.observations.mainPid -eq $priorMainId){throw 'Draft Main restart acceptance failed.'}
    [IO.File]::WriteAllText((Join-Path $taskOutput 'gate.json'),(@{format='ariadne-chat-draft-gate.v1';passed=$true;root=$taskRoot;
      physicalOwnedMainCut=$true;priorMainPid=$priorMainId;newMainPid=$result.observations.mainPid}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    Write-Output 'Draft actual OS cipher, Renderer reload/DOM, original Core command reconciliation and physical Main restart passed.'
    $taskProcess=$null
  }
}
finally {
  if($taskProcess -and -not $taskProcess.HasExited) {
    foreach($child in Get-DraftDescendants $taskProcess.Id){$owned[[int]$child.ProcessId]=$child}
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.Id)" -ErrorAction SilentlyContinue
    if($current -and $current.CreationDate -eq $mainIdentity.CreationDate -and $current.CommandLine -eq $mainIdentity.CommandLine){Stop-Process -Id $taskProcess.Id -ErrorAction SilentlyContinue}
  }
  Stop-OwnedDraftChildren
  foreach($name in $names){if($previousPresence[$name]){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}else{Remove-Item -LiteralPath ('Env:'+ $name) -ErrorAction SilentlyContinue}}
}
