param(
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [ValidateSet('prepare','retain','save','discard','verify-discard','recovery','storage-failure','verify-storage-failure','popout')][string]$Phase='prepare',
  [string]$TaskRoot
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not[IO.Path]::IsPathRooted($OutputRoot)){throw 'File draft output must be absolute.'}
$taskOutput=[IO.Path]::GetFullPath($OutputRoot)
if(Test-Path -LiteralPath $taskOutput){throw 'File draft evidence path already exists.'}
New-Item -ItemType Directory -Path $taskOutput | Out-Null
if($Phase-in @('prepare','recovery','storage-failure','popout')){
  if($TaskRoot){throw 'Prepare creates its own TEMP.'}
  $TaskRoot=Join-Path ([IO.Path]::GetTempPath()) ('AriadneFileDraft-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path (Join-Path $TaskRoot 'workspace\Sensitive') | Out-Null
  & fsutil.exe file setCaseSensitiveInfo (Join-Path $TaskRoot 'workspace\Sensitive') enable *> (Join-Path $taskOutput 'case-sensitive-setup.log')
  if($LASTEXITCODE-ne 0){throw 'Owned case-sensitive directory setup failed.'}
}else{
  if(-not$TaskRoot-or -not[IO.Path]::IsPathRooted($TaskRoot)){throw 'Restart requires the exact prior TEMP.'}
  $TaskRoot=(Resolve-Path -LiteralPath $TaskRoot).Path
  $tempRoot=(Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')+'\'
  if(-not$TaskRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)-or -not[IO.Path]::GetFileName($TaskRoot).StartsWith('AriadneFileDraft-')){throw 'Restart scope is not owned TEMP.'}
  if(-not(Test-Path -LiteralPath (Join-Path $TaskRoot 'file-draft-checkpoint.json'))){throw 'Restart identity checkpoint is missing.'}
}
$taskWorkspace=Join-Path $TaskRoot 'workspace'
$taskHasher=[Security.Cryptography.SHA256]::Create()
try{$taskHash=($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($taskWorkspace).ToLowerInvariant()))|ForEach-Object{$_.ToString('x2')}) -join ''}finally{$taskHasher.Dispose()}
$workspaceId='workspace-'+$taskHash.Substring(0,20)
$electronPath=[IO.Path]::GetFullPath((Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'))
$nodePath=(Get-Command node -ErrorAction Stop).Source
$names=@('ARIADNE_SMOKE_TEST','ARIADNE_SMOKE_FILE_DRAFTS','ARIADNE_SMOKE_FILE_DRAFT_PHASE','ARIADNE_SMOKE_TEST_OUTPUT','ARIADNE_SMOKE_USER_DATA',
  'ARIADNE_RUNTIME_NODE_EXECUTABLE','ARIADNE_APPLICATION_PROFILE','ARIADNE_SMOKE_WORKSPACE_ROOT','ARIADNE_SMOKE_WORKSPACE_ID','ELECTRON_RUN_AS_NODE',
  'ARIADNE_SMOKE_COMPOSER_KEYBOARD','ARIADNE_SMOKE_CHAT_DRAFTS','ARIADNE_SMOKE_NOTIFICATIONS','ARIADNE_SMOKE_DOMAIN_HEALTH','ARIADNE_SMOKE_PROJECTION_CAPACITY',
  'ARIADNE_SMOKE_PROFILE_VERIFY','ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT','ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY','ARIADNE_SMOKE_PROVIDER_BASE_URL',
  'ARIADNE_SMOKE_PROVIDER_MODEL','ARIADNE_SMOKE_PROVIDER_STATE','ARIADNE_SMOKE_PROJECTION_PROBE','OPENAI_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','ANTHROPIC_API_KEY')
$previous=@{};$presence=@{};foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process');$presence[$name]=[Environment]::GetEnvironmentVariables('Process').Contains($name)}
$main=$null;$mainIdentity=$null;$owned=@{};$taskLock=$null
function Capture-FileDraftChildren([int]$MainId){
  $rows=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add($MainId)
  do{$changed=$false;foreach($row in $rows){if(-not$ids.Contains([int]$row.ProcessId)-and $ids.Contains([int]$row.ParentProcessId)){[void]$ids.Add([int]$row.ProcessId);$changed=$true}}}while($changed)
  foreach($row in $rows){if($ids.Contains([int]$row.ProcessId)-and $row.ProcessId-ne $MainId){$owned[[int]$row.ProcessId]=$row}}
}
function Stop-FileDraftIdentity($identity){
  if(-not$identity){return};$current=Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.ProcessId)" -ErrorAction SilentlyContinue
  if($current-and $current.CreationDate-eq $identity.CreationDate-and $current.CommandLine-eq $identity.CommandLine-and $current.ExecutablePath-eq $identity.ExecutablePath){Stop-Process -Id $identity.ProcessId -ErrorAction SilentlyContinue}
}
try{
  foreach($name in $names){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
  $env:ARIADNE_SMOKE_TEST='1';$env:ARIADNE_SMOKE_FILE_DRAFTS='1';$env:ARIADNE_SMOKE_FILE_DRAFT_PHASE=$Phase
  $env:ARIADNE_SMOKE_TEST_OUTPUT=$taskOutput;$env:ARIADNE_SMOKE_USER_DATA=$TaskRoot;$env:ARIADNE_RUNTIME_NODE_EXECUTABLE=$nodePath
  $env:ARIADNE_APPLICATION_PROFILE='desktop-default';$env:ARIADNE_SMOKE_WORKSPACE_ROOT=$taskWorkspace;$env:ARIADNE_SMOKE_WORKSPACE_ID=$workspaceId
  $main=Start-Process -FilePath $electronPath -PassThru -WindowStyle Hidden -ArgumentList ('"'+(Join-Path $projectRoot 'app')+'"') `
    -RedirectStandardOutput (Join-Path $taskOutput 'main.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'main.stderr.log')
  [void]$main.Handle;$mainIdentity=Get-CimInstance Win32_Process -Filter "ProcessId=$($main.Id)"
  if(-not$mainIdentity-or [string]::IsNullOrWhiteSpace($mainIdentity.ExecutablePath)-or [IO.Path]::GetFullPath($mainIdentity.ExecutablePath)-ne $electronPath){throw 'File draft Main identity is unavailable.'}
  [IO.File]::WriteAllText((Join-Path $taskOutput 'launch.json'),(@{phase=$Phase;root=$TaskRoot;mainPid=$main.Id}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $deadline=[DateTime]::UtcNow.AddMinutes(5);$cut=$false
  while(-not$main.HasExited){
    Capture-FileDraftChildren $main.Id
    if($Phase-eq 'storage-failure'-and -not$taskLock-and(Test-Path -LiteralPath (Join-Path $taskOutput 'lock-ready.json'))){
      $taskLockReady=Get-Content -LiteralPath (Join-Path $taskOutput 'lock-ready.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      if($taskLockReady.mainPid-ne $main.Id){throw 'Sharing-denial Main identity changed.'}
      $taskLockPath=[IO.Path]::GetFullPath((Join-Path $TaskRoot 'file-drafts.json'))
      if([IO.Path]::GetDirectoryName($taskLockPath)-ne $TaskRoot){throw 'Sharing-denial file is outside owned TEMP.'}
      $taskLock=[IO.File]::Open($taskLockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      [IO.File]::WriteAllText((Join-Path $taskOutput 'locked.json'),(@{mainPid=$main.Id;actualWindowsShareLock=$true}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    }
    if($Phase-in @('prepare','storage-failure')-and(Test-Path -LiteralPath (Join-Path $taskOutput 'cut-ready.json'))){
      $ready=Get-Content -LiteralPath (Join-Path $taskOutput 'cut-ready.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      if($ready.mainPid-ne $main.Id){throw 'File draft cut PID changed.'}
      Stop-FileDraftIdentity $mainIdentity;$cut=$true;break
    }
    if(Test-Path -LiteralPath (Join-Path $taskOutput 'file-drafts.json')){
      $early=Get-Content -LiteralPath (Join-Path $taskOutput 'file-drafts.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      if(-not$early.passed){throw ('File draft native helper failed: '+$early.fatalError)}
    }
    if([DateTime]::UtcNow-ge $deadline){throw 'File draft native phase exceeded five minutes.'}
    Start-Sleep -Milliseconds 150;$main.Refresh()
  }
  $main.WaitForExit()
  $result=Get-Content -LiteralPath (Join-Path $taskOutput 'file-drafts.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($result.format-ne 'ariadne-file-draft-native.v1'-or -not$result.passed-or $result.mainPid-ne $main.Id){throw 'File draft phase evidence failed.'}
  if($Phase-in @('prepare','storage-failure')){if(-not$cut){throw 'Actual Main interruption did not occur.'}}
  else{
    if($main.ExitCode-ne 0){throw 'Normal file draft quit failed.'}
    if($Phase-notin @('verify-discard','recovery','verify-storage-failure','popout')){
      $choiceDeadline=[DateTime]::UtcNow.AddSeconds(5)
      while(-not(Test-Path -LiteralPath (Join-Path $taskOutput 'operator-choice.json'))){if([DateTime]::UtcNow-ge $choiceDeadline){throw 'Native operator receipt did not arrive.'};Start-Sleep -Milliseconds 50}
      $choice=Get-Content -LiteralPath (Join-Path $taskOutput 'operator-choice.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      $expected=if($Phase-eq 'retain'){'保留草稿并退出'}elseif($Phase-eq 'save'){'保存全部并退出'}else{'丢弃草稿并退出'}
      if($choice.phase-ne $Phase-or $choice.choice-ne $expected-or -not$choice.physical){throw 'Native operator choice evidence is missing.'}
    }
  }
  [IO.File]::WriteAllText((Join-Path $taskOutput 'gate.json'),(@{format='ariadne-file-draft-gate.v1';passed=$true;phase=$Phase;root=$TaskRoot;mainPid=$main.Id;actualMainCut=$cut;normalExit=(-not$cut)}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Write-Output "File draft $Phase phase passed."
}finally{
  if($main-and -not$main.HasExited){Capture-FileDraftChildren $main.Id;Stop-FileDraftIdentity $mainIdentity}
  foreach($id in @($owned.Keys)){Stop-FileDraftIdentity $owned[$id]}
  if($taskLock){$taskLock.Dispose()}
  foreach($name in $names){if($presence[$name]){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}else{Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}}
}
