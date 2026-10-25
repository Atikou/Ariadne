param([Parameter(Mandatory=$true)][string]$OutputRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'smoke\provider-certificate.ps1')
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not [IO.Path]::IsPathRooted($OutputRoot)){throw 'Keyboard evidence path must be absolute.'}
$taskOutput=[IO.Path]::GetFullPath($OutputRoot)
if(Test-Path -LiteralPath $taskOutput){throw 'Keyboard evidence path already exists.'}
New-Item -ItemType Directory -Path $taskOutput | Out-Null
$taskRoot=Join-Path ([IO.Path]::GetTempPath()) ('AriadneComposerKeyboard-'+[guid]::NewGuid().ToString('N'))
$taskWorkspace=Join-Path $taskRoot 'workspace'
New-Item -ItemType Directory -Path $taskWorkspace | Out-Null
$taskHasher=[Security.Cryptography.SHA256]::Create()
try{$taskHash=($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($taskWorkspace).ToLowerInvariant()))|ForEach-Object{$_.ToString('x2')}) -join ''}finally{$taskHasher.Dispose()}
$workspaceId='workspace-'+$taskHash.Substring(0,20)
$electronPath=[IO.Path]::GetFullPath((Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'))
$nodePath=(Get-Command node -ErrorAction Stop).Source
$providerScript=Join-Path $PSScriptRoot 'electron-smoke-provider.mjs'
$providerReady=Join-Path $taskRoot 'provider-ready.json';$providerState=Join-Path $taskRoot 'provider-state.json'
$pfx=Join-Path $taskRoot 'provider.pfx';$ca=Join-Path $taskRoot 'provider-ca.pem';$passphrase=[guid]::NewGuid().ToString('N')
$probe=Join-Path $taskRoot 'projection-probe.js';$model='ariadne-smoke-model'
$names=@('ARIADNE_SMOKE_TEST','ARIADNE_SMOKE_COMPOSER_KEYBOARD','ARIADNE_SMOKE_TEST_OUTPUT','ARIADNE_SMOKE_USER_DATA','ARIADNE_SMOKE_PROJECTION_PROBE',
  'ARIADNE_RUNTIME_NODE_EXECUTABLE','ARIADNE_APPLICATION_PROFILE','ARIADNE_SMOKE_WORKSPACE_ROOT','ARIADNE_SMOKE_WORKSPACE_ID',
  'ARIADNE_SMOKE_PROVIDER_BASE_URL','ARIADNE_SMOKE_PROVIDER_MODEL','ARIADNE_SMOKE_PROVIDER_STATE','NODE_EXTRA_CA_CERTS','OPENAI_API_KEY',
  'DEEPSEEK_API_KEY','MOONSHOT_API_KEY','ANTHROPIC_API_KEY','ELECTRON_RUN_AS_NODE','ARIADNE_SMOKE_CHAT_DRAFTS','ARIADNE_SMOKE_NOTIFICATIONS',
  'ARIADNE_SMOKE_DOMAIN_HEALTH','ARIADNE_SMOKE_PROJECTION_CAPACITY','ARIADNE_SMOKE_PROFILE_VERIFY','ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT','ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY')
$previous=@{};$presence=@{};foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process');$presence[$name]=[Environment]::GetEnvironmentVariables('Process').Contains($name)}
$main=$null;$provider=$null;$owned=@{}
function Capture-KeyboardChildren([int]$MainId){
  $rows=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add($MainId)
  do{$changed=$false;foreach($row in $rows){if(-not $ids.Contains([int]$row.ProcessId)-and $ids.Contains([int]$row.ParentProcessId)){[void]$ids.Add([int]$row.ProcessId);$changed=$true}}}while($changed)
  foreach($row in $rows){if($ids.Contains([int]$row.ProcessId)-and $row.ProcessId-ne $MainId){$owned[[int]$row.ProcessId]=$row}}
}
function Stop-KeyboardIdentity($identity){
  if(-not $identity){return};$current=Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.ProcessId)" -ErrorAction SilentlyContinue
  if($current-and $current.CreationDate-eq $identity.CreationDate-and $current.CommandLine-eq $identity.CommandLine){Stop-Process -Id $identity.ProcessId -ErrorAction SilentlyContinue}
}
try{
  & $nodePath (Join-Path $PSScriptRoot 'build-smoke-projection-probe.mjs') $probe
  if($LASTEXITCODE-ne 0){throw 'Keyboard projection probe build failed.'}
  New-SmokeProviderCertificate -PfxPath $pfx -CertificatePath $ca -Passphrase $passphrase
  $provider=Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden -ArgumentList @($providerScript,'--model',$model,'--state',$providerState,'--ready',$providerReady,'--pfx',$pfx,'--passphrase',$passphrase,'--workspace-id',$workspaceId,'--agent-db',(Join-Path $taskRoot 'runtime\data\agent-control\agent-control.db')) `
    -RedirectStandardOutput (Join-Path $taskOutput 'provider.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'provider.stderr.log')
  $providerIdentity=Get-CimInstance Win32_Process -Filter "ProcessId=$($provider.Id)"
  $readyDeadline=[DateTime]::UtcNow.AddSeconds(15)
  while(-not(Test-Path -LiteralPath $providerReady)){if($provider.HasExited-or [DateTime]::UtcNow-ge $readyDeadline){throw 'Keyboard local Provider readiness failed.'};Start-Sleep -Milliseconds 50}
  $ready=Get-Content -LiteralPath $providerReady -Raw -Encoding UTF8 | ConvertFrom-Json
  if($ready.protocol-ne 'ariadne-electron-smoke-provider-ready.v1'){throw 'Keyboard Provider readiness identity invalid.'}
  foreach($name in $names){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
  $env:ARIADNE_SMOKE_TEST='1';$env:ARIADNE_SMOKE_COMPOSER_KEYBOARD='1';$env:ARIADNE_SMOKE_TEST_OUTPUT=$taskOutput
  $env:ARIADNE_SMOKE_USER_DATA=$taskRoot;$env:ARIADNE_SMOKE_PROJECTION_PROBE=$probe;$env:ARIADNE_RUNTIME_NODE_EXECUTABLE=$nodePath;$env:ARIADNE_APPLICATION_PROFILE='desktop-default'
  $env:ARIADNE_SMOKE_WORKSPACE_ROOT=$taskWorkspace;$env:ARIADNE_SMOKE_WORKSPACE_ID=$workspaceId
  $env:ARIADNE_SMOKE_PROVIDER_BASE_URL=$ready.baseUrl;$env:ARIADNE_SMOKE_PROVIDER_MODEL=$model;$env:ARIADNE_SMOKE_PROVIDER_STATE=$providerState
  $env:NODE_EXTRA_CA_CERTS=$ca;$env:OPENAI_API_KEY='ariadne-electron-smoke-key'
  $main=Start-Process -FilePath $electronPath -PassThru -WindowStyle Hidden -ArgumentList ('"'+(Join-Path $projectRoot 'app')+'"') `
    -RedirectStandardOutput (Join-Path $taskOutput 'main.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'main.stderr.log')
  [void]$main.Handle;$mainIdentity=Get-CimInstance Win32_Process -Filter "ProcessId=$($main.Id)"
  if(-not $mainIdentity-or [string]::IsNullOrWhiteSpace($mainIdentity.ExecutablePath)-or [IO.Path]::GetFullPath($mainIdentity.ExecutablePath)-ne $electronPath){throw 'Keyboard Main identity unavailable.'}
  $deadline=[DateTime]::UtcNow.AddMinutes(5)
  while(-not $main.HasExited){Capture-KeyboardChildren $main.Id;if([DateTime]::UtcNow-ge $deadline){throw 'Keyboard physical interaction gate timed out.'};Start-Sleep -Milliseconds 200;$main.Refresh()}
  $main.WaitForExit();$result=Get-Content -LiteralPath (Join-Path $taskOutput 'composer-keyboard.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($main.ExitCode-ne 0-or $result.format-ne 'ariadne-composer-keyboard.v1'-or -not $result.passed){throw 'Keyboard acceptance failed; inspect preserved trace.'}
  [IO.File]::WriteAllText((Join-Path $taskOutput 'gate.json'),(@{format='ariadne-composer-keyboard-gate.v1';passed=$true;root=$taskRoot;mainPid=$main.Id}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Write-Output 'Trusted Windows IME candidate, physical Shift+Enter and ordinary Enter production delivery passed.'
}finally{
  if($main-and -not $main.HasExited){Capture-KeyboardChildren $main.Id;Stop-KeyboardIdentity $mainIdentity}
  foreach($id in @($owned.Keys)){Stop-KeyboardIdentity $owned[$id]};Stop-KeyboardIdentity $providerIdentity
  foreach($name in $names){if($presence[$name]){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}else{Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}}
}
