#Requires -Version 7.0
<# One bounded supervision pass. Never stops/restarts a live daemon or DSH service. #>
[CmdletBinding()]
param(
  [ValidateSet('Run','Install','Uninstall','Verify','none')][string]$Action='Run',
  [ValidateSet('Monitor','Repair')][string]$Mode='Repair',
  [string]$HitlRoot=(Split-Path -Parent $PSScriptRoot),
  [string]$StateDir,
  [ValidateRange(15,300)][int]$HeartbeatMaxAgeSec=30,
  [ValidateRange(1,120)][int]$AlertMergeMinutes=15,
  [switch]$NoToast,[switch]$NoRemote,[switch]$Json,
  # Offline fixture mode is always Monitor, cannot install or launch services.
  [string]$ObservationFile
)
$ErrorActionPreference='Stop'
if(!$StateDir){$StateDir=Join-Path $HitlRoot 'state'}
$StateDir=[IO.Path]::GetFullPath($StateDir)
$taskName='DSH-Feishu-Supervisor'
$pwsh=(Get-Command pwsh -ErrorAction Stop).Source
$node=(Get-Command node -ErrorAction Stop).Source
$runner=$PSCommandPath
$core=Join-Path $HitlRoot 'feishu/feishu-supervisor.mjs'
$stateFile=Join-Path $StateDir 'feishu-supervisor-state.json'
$logFile=Join-Path $StateDir 'feishu-supervisor.log'
function New-HiddenAction([string]$Executable,[string]$Arguments,[string]$Launcher,[string]$WorkingDirectory){
  $command='"'+$Executable+'" '+$Arguments
  $body=@('Option Explicit','Dim sh, code','Set sh = CreateObject("WScript.Shell")',('sh.CurrentDirectory = "'+$WorkingDirectory.Replace('"','""')+'"'),('code = sh.Run("'+$command.Replace('"','""')+'", 0, True)'),'WScript.Quit code') -join [Environment]::NewLine
  if(Test-Path -LiteralPath $Launcher){Copy-Item -LiteralPath $Launcher -Destination ($Launcher+'.bak-before-windowless') -Force}
  [IO.File]::WriteAllText($Launcher,$body,[Text.UnicodeEncoding]::new($false,$true))
  return New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32/wscript.exe') -Argument ('//B //Nologo "'+$Launcher+'"') -WorkingDirectory $WorkingDirectory
}

function Save-Atomic($path,$data){
  $tmp=$path+'.tmp-'+$PID
  [IO.File]::WriteAllText($tmp,($data|ConvertTo-Json -Depth 25),[Text.UTF8Encoding]::new($false))
  [IO.File]::Move($tmp,$path,$true)
}
function Log($data){[IO.File]::AppendAllText($logFile,($data|ConvertTo-Json -Depth 25 -Compress)+[Environment]::NewLine)}
function Invoke-Bounded([string]$exe,[string[]]$argv,[int]$seconds=25){
  $p=[Diagnostics.Process]::new();$p.StartInfo.FileName=$exe
  $p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true
  $p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true
  foreach($a in $argv){$p.StartInfo.ArgumentList.Add($a)}
  try{
    [void]$p.Start();$ot=$p.StandardOutput.ReadToEndAsync();$et=$p.StandardError.ReadToEndAsync()
    if(!$p.WaitForExit($seconds*1000)){
      # This is our launcher only, never a pre-existing service or its tree.
      $p.Kill();return @{exit=124;output='supervisor child timeout'}
    }
    return @{exit=$p.ExitCode;output=($ot.GetAwaiter().GetResult()+$et.GetAwaiter().GetResult()).Trim()}
  }finally{$p.Dispose()}
}
function Processes {
  try{
    $all=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe'" -ErrorAction Stop|ForEach-Object{
      @{ProcessId=[int]$_.ProcessId;ParentProcessId=[int]$_.ParentProcessId;Name=[string]$_.Name;CommandLine=[string]$_.CommandLine;CreationDate=if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{$null}}
    })
    return ,$all
  }catch{return $null}
}
function Beat {
  try{return Get-Content (Join-Path $StateDir 'feishu-daemon.json') -Raw|ConvertFrom-Json -AsHashtable}catch{return $null}
}
function Orchestrator {
  try{
    $o=Invoke-RestMethod 'http://127.0.0.1:3082/orchestrator/api/state' -Headers @{'x-orchestrator-request'='1'} -TimeoutSec 5
    if($o.health.runtime.state -eq 'ready' -and $o.health.feishu.state -eq 'ready'){return @{state='ready';reason='orchestrator-ready'}}
    if(!$o.health.runtime.state -or !$o.health.feishu.state){return @{state='unknown';reason='orchestrator-response-invalid'}}
    return @{state='unhealthy';reason='orchestrator-not-ready'}
  }catch{return @{state='unknown';reason='orchestrator-unreachable'}}
}
function Current-Control {
  if($env:DSH_WECHAT_HITL_SWITCH -in @('paused','stopped')){return [string]$env:DSH_WECHAT_HITL_SWITCH}
  $controlPath=Join-Path $StateDir 'control.json'
  if(Test-Path $controlPath){
    try{$control=Get-Content $controlPath -Raw|ConvertFrom-Json -AsHashtable; $channel=$control.channels.feishu.state; if($channel){return [string]$channel}}
    catch{return 'unknown'}
  }
  return 'running'
}
function Observe {
  $before=Beat
  if($before){$before.switchState=Current-Control}
  Start-Sleep -Seconds 6
  $current=Beat; if($current){$current.switchState=Current-Control}
  return @{beat=$current;previousBeat=$before;processes=(Processes);orchestrator=(Orchestrator);nowMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();daemonPath=(Join-Path $HitlRoot 'feishu/feishu-daemon.mjs')}
}
function Decide($ob,$prior,$repairResult=$null){
  if($null -ne $repairResult){$ob.repair=$repairResult}
  $ob.prior=$prior;$ob.maxAgeMs=$HeartbeatMaxAgeSec*1000;$ob.mergeMs=$AlertMergeMinutes*60000
  Save-Atomic $inputFile $ob
  $run=Invoke-Bounded $node @($core,'decide',$inputFile,$outputFile) 15
  if($run.exit -notin @(0,1,2) -or !(Test-Path $outputFile)){throw "decision core failed: $($run.output)"}
  $value=Get-Content $outputFile -Raw|ConvertFrom-Json -AsHashtable
  Remove-Item $outputFile -Force
  return $value
}
function Notify-Toast($message){
  if($NoToast){return @{state='disabled'}}
  try{
    [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null
    $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>DSH Feishu 监督</text><text>'+[Security.SecurityElement]::Escape($message)+'</text></binding></visual></toast>')
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DSH.FeishuSupervisor').Show((New-Object Windows.UI.Notifications.ToastNotification $xml))
    return @{state='submitted'}
  }catch{
    # PowerShell 7 在本机加载不了 Windows.UI.Notifications 的 WinRT 类型，改由 5.1 发送。
    # 5.1 需显式投影才拿得到 XmlDocument，故走独立脚本 tools/feishu-toast.ps1。
    $fallback = Join-Path $HitlRoot 'tools/feishu-toast.ps1'
    if (Test-Path -LiteralPath $fallback) {
      $ps51 = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
      $r = Invoke-Bounded $ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',$fallback,'-Title','DSH Feishu 通道监督','-Message',$message) 20
      if ($r.exit -eq 0) { return @{state='submitted-via-5.1';detail=$r.output} }
      return @{state='failed';error=($_.Exception.Message + ' | 5.1 fallback: ' + $r.output)}
    }
    return @{state='failed';error=$_.Exception.Message}
  }
}
# -Action none：只定义函数、不执行（供单测/交互式调用 Notify-Toast 等）。
if($Action -eq 'none'){ return }
if($ObservationFile -and ($Action -ne 'Run' -or $Mode -ne 'Monitor' -or !$NoToast -or !$NoRemote)){throw 'Fixture requires Run/Monitor/NoToast/NoRemote'}
if($Action -eq 'Install'){
  $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($existing){throw 'Task already exists; Verify or explicitly Uninstall first, never overwrite silently'}
  $argv='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$runner+'" -Mode '+$Mode+' -HitlRoot "'+$HitlRoot+'" -StateDir "'+$StateDir+'"'
  $launcher=Join-Path $StateDir 'feishu-supervisor-task.vbs'
  $a=New-HiddenAction $pwsh $argv $launcher $HitlRoot
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $triggers=@((New-ScheduledTaskTrigger -AtLogOn -User $user),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)))
  $pr=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $a -Trigger $triggers -Principal $pr -Settings $settings -Description 'Feishu death-only repair; unknown never starts; no DSH restart'|Out-Null
  Write-Output 'Registered DSH-Feishu-Supervisor (5 minutes + user logon; requires logged-in user).';exit 0
}
if($Action -eq 'Uninstall'){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false;exit 0}
if($Action -eq 'Verify'){
  $t=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $i=Get-ScheduledTaskInfo -TaskName $taskName
  $xml=Export-ScheduledTask -TaskName $taskName
  $launcher=Join-Path $StateDir 'feishu-supervisor-task.vbs'
  $launcherText=if(Test-Path -LiteralPath $launcher){Get-Content -LiteralPath $launcher -Raw}else{''}
  $windowless=([IO.Path]::GetFileName($t.Actions.Execute) -eq 'wscript.exe') -and ($t.Actions.Arguments -match [regex]::Escape($launcher)) -and ($launcherText.Contains($runner)) -and ($launcherText.Contains(', 0, True)'))
  $valid=$xml.Contains('<Interval>PT5M</Interval>') -and $xml.Contains('IgnoreNew') -and $windowless
  @{valid=$valid;windowless=$windowless;state=[string]$t.State;lastRun=[string]$i.LastRunTime;nextRun=[string]$i.NextRunTime;lastResult=$i.LastTaskResult;arguments=$t.Actions.Arguments;logonType=[string]$t.Principal.LogonType}|ConvertTo-Json
  if(!$valid){exit 1};exit 0
}
if(!(Test-Path -LiteralPath $StateDir -PathType Container)){throw 'StateDir missing; refusing to initialize production state'}
# Kernel mutex: exclusive across logon sessions, automatically released on process death.
$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($StateDir.ToLowerInvariant())))
$mutex=[Threading.Mutex]::new($false,('Global\DSH-Feishu-Supervisor-'+$hash))
$held=$false
$inputFile=Join-Path $StateDir ('.supervisor-input-'+$PID+'.json')
$outputFile=Join-Path $StateDir ('.supervisor-output-'+$PID+'.json')
try{
  try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
  if(!$held){Write-Output '{"state":"skipped","reason":"mutex-held"}';exit 0}
  $prior=@{incidents=@{};notifications=@()}
  if(Test-Path $stateFile){$prior=Get-Content $stateFile -Raw|ConvertFrom-Json -AsHashtable}
  if($ObservationFile){$ob=Get-Content $ObservationFile -Raw|ConvertFrom-Json -AsHashtable}else{$ob=Observe}
  $report=Decide $ob $prior
  # Persist incident and independent notification outbox BEFORE attempting repair or sending alerts.
  $saved=$report.persisted;$saved.notifications=@($prior.notifications)+@($report.events|ForEach-Object{@{event=$_;pending=$true;attempts=0}})
  Save-Atomic $stateFile $saved
  foreach($ev in $report.events){Log @{at=[DateTimeOffset]::Now.ToString('o');event=$ev}}
  if($Mode -eq 'Repair' -and $report.action -eq 'repair'){
    # Second process/heartbeat observation closes the check/start gap. Start script and daemon lock recheck again.
    $again=Decide (Observe) $saved
    if($again.action -eq 'repair'){
      $repair=Invoke-Bounded $pwsh @('-NoProfile','-File',(Join-Path $HitlRoot 'tools/restart-feishu-daemon.ps1'),'-Action','start','-StateDir',$StateDir,'-TimeoutSeconds','30') 45
      $report.repair=$repair
      Log @{at=[DateTimeOffset]::Now.ToString('o');op='repair-attempt';result=$repair}
      $report=Decide (Observe) $saved $repair
      $report.repair=$repair;$saved=$report.persisted
      $saved.notifications=@((Get-Content $stateFile -Raw|ConvertFrom-Json -AsHashtable).notifications)+@($report.events|ForEach-Object{@{event=$_;pending=$true;attempts=0}})
      foreach($ev in $report.events){Log @{at=[DateTimeOffset]::Now.ToString('o');event=$ev}}
      Save-Atomic $stateFile $saved
    }else{$report.repair=@{exit=2;output='repair cancelled: second observation no longer permits start'}}
  }
  # Direct CLI egress: independent of monitored daemon and its shared outbox. No incoming reply required.
  foreach($notice in @($saved.notifications|Where-Object pending|Select-Object -First 3)){
    $text='Feishu 通道监督：'+$notice.event.op+' / '+$notice.event.key+' / incident '+$notice.event.incidentId
    if($notice.event.ContainsKey('consecutiveFailures')){$text+=' / repair exit='+$notice.event.exit+' / consecutive failures='+$notice.event.consecutiveFailures}
    $notice.attempts=[int]$notice.attempts+1
    $toast=Notify-Toast $text
    if($NoRemote){$remote=@{exit=0;output='disabled'}}else{
      Save-Atomic $inputFile @{text=$text}
      $remote=Invoke-Bounded $node @((Join-Path $HitlRoot 'tools/feishu-supervisor-alert.mjs'),$inputFile) 20
    }
    $notice.remote=$remote;$notice.toast=$toast
    if($remote.exit -eq 0){$notice.pending=$false}
    Log @{at=[DateTimeOffset]::Now.ToString('o');op='notification-attempt';incidentId=$notice.event.incidentId;attempt=$notice.attempts;remote=$remote;toast=$toast}
    Save-Atomic $stateFile $saved
  }
  $saved.notifications=@($saved.notifications|Where-Object pending)+@($saved.notifications|Where-Object {!$_.pending}|Select-Object -Last 50)
  Save-Atomic $stateFile $saved
  Save-Atomic (Join-Path $StateDir 'feishu-supervisor-latest.json') $report
  if($Json){$report|ConvertTo-Json -Depth 25}else{Write-Output ('Feishu supervisor '+$report.verdict+'; mode='+$Mode+'; action='+$report.action)}
  if($report.verdict -eq 'ready'){exit 0};if($report.verdict -eq 'unknown'){exit 2};exit 1
}catch{
  if($held){Log @{at=[DateTimeOffset]::Now.ToString('o');op='supervisor-error';error=$_.Exception.Message}}
  Write-Error $_ -ErrorAction Continue;exit 2
}finally{
  if($held){Remove-Item $inputFile,$outputFile -Force -ErrorAction SilentlyContinue;$mutex.ReleaseMutex()};$mutex.Dispose()
}
