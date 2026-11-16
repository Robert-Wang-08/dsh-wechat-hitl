#Requires -Version 7.0
<#
.SYNOPSIS
  tools/test-feishu-health.ps1 与 restart-feishu-daemon.ps1 -Action status 的自检（2026-11-14）。

.DESCRIPTION
  只用 $env:TEMP 下自建的假心跳 / 假进程清单，不读也不改生产 state，不启停任何进程。
  覆盖 L1(入站/心跳) 10 例、L2(进程身份，用 -ProcessListFile 注入) 6 例、status 三态 4 例。
  独立运行：pwsh -NoProfile -File test/test-feishu-health.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$probe = Join-Path $root 'tools\test-feishu-health.ps1'
$restart = Join-Path $root 'tools\restart-feishu-daemon.ps1'
if (-not (Test-Path $probe)) { throw "找不到探针：$probe" }
if (-not (Test-Path $restart)) { throw "找不到重启脚本：$restart" }

$work = Join-Path $env:TEMP ('feishu-health-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$script:fail = 0
$script:pass = 0

# 用一个真实存在的 pid（本测试进程自己）：否则探针会先命中 daemon-pid-gone，
# 把「心跳陈旧 / 不推进」这类语义用例盖掉（2026-11-14 实测踩过）。
$realPid = [System.Diagnostics.Process]::GetCurrentProcess().Id
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function New-Beat {
  param([string]$Dir, [hashtable]$Fields)
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  # 每次都用「当下」：整套测试要跑几十秒，若沿用脚本启动时刻，心跳会自己变陈旧，
  # 把 not-advancing 之类用例顶成 heartbeat-stale（2026-11-14 实测踩过）。
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $beat = @{ pid = $realPid; startedAt = $now - 3600000; tickAt = $now; inbound = 'running'; lastError = 'ok'; hint = $null; switchState = 'running' }
  foreach ($k in $Fields.Keys) { $beat[$k] = $Fields[$k] }
  $beat | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Dir 'feishu-daemon.json') -Encoding utf8
}

function Invoke-Probe {
  param([string]$StateDir, [int]$SampleWaitSec = 6, [string[]]$Extra = @(), [switch]$NoWaitProbe)
  $argv = @('-NoProfile', '-File', $probe, '-StateDir', $StateDir, '-SkipOrchestrator', '-SkipReply', '-SampleWaitSec', $SampleWaitSec, '-Json')
  if ($Extra -notcontains '-ProcessListFile') { $argv += '-SkipProcessCheck' }
  if ($NoWaitProbe) { $argv += '-NoWait' }
  $argv += $Extra
  $raw = & pwsh @argv
  $code = $LASTEXITCODE
  $parsed = $null
  try { $parsed = (($raw -join ([string][char]10)).Trim()) | ConvertFrom-Json } catch { $parsed = $null }
  return [pscustomobject]@{ exitCode = $code; json = $parsed }
}

function Report {
  param([string]$Name, [bool]$Ok, [string]$Got, [string]$Want)
  if ($Ok) { $script:pass++; Write-Output ('  ok   ' + $Name.PadRight(30) + ' ' + $Got) }
  else { $script:fail++; Write-Output ('  FAIL ' + $Name.PadRight(30) + ' got=' + $Got + ' want=' + $Want) }
}

# L1：只看 daemon 层
function Assert-Daemon {
  param([string]$Name, [string]$StateDir, [int]$SampleWaitSec, [int]$ExpectedExit, [string]$ExpectedReason)
  $r = Invoke-Probe $StateDir -SampleWaitSec $SampleWaitSec
  $l1 = if ($r.json) { $r.json.layers | Where-Object { $_.layer -eq 'daemon' } }
  $reason = if ($l1) { $l1.reason } else { '<no-json>' }
  Report $Name (($r.exitCode -eq $ExpectedExit) -and ($reason -eq $ExpectedReason)) ('exit=' + $r.exitCode + ' reason=' + $reason) ('exit=' + $ExpectedExit + ' reason=' + $ExpectedReason)
}

Write-Output '== L1 daemon / 入站 / 心跳 =='

Assert-Daemon 'state-dir-missing' (Join-Path $work 'no-such-dir') 6 2 'state-dir-missing'

$d = Join-Path $work 'spawn-failed'; New-Beat $d @{ inbound = 'spawn-failed'; lastError = 'Error: spawn EPERM' }
Assert-Daemon 'inbound-spawn-failed' $d 6 1 'inbound-spawn-failed'

$d = Join-Path $work 'stopped'; New-Beat $d @{ inbound = 'stopped' }
Assert-Daemon 'inbound-stopped' $d 6 1 'inbound-stopped'

$d = Join-Path $work 'exited'; New-Beat $d @{ inbound = 'exited:1' }
Assert-Daemon 'inbound-exited' $d 6 1 'inbound-exited'

$d = Join-Path $work 'blocked'; New-Beat $d @{ inbound = 'blocked:policy' }
Assert-Daemon 'inbound-blocked-policy' $d 6 1 'inbound-blocked-policy'

$d = Join-Path $work 'starting'; New-Beat $d @{ inbound = 'starting' }
Assert-Daemon 'inbound-starting-unknown' $d 6 2 'inbound-starting'

$d = Join-Path $work 'stale'; New-Beat $d @{ tickAt = $nowMs - 120000 }
Assert-Daemon 'heartbeat-stale' $d 6 1 'heartbeat-stale'

$d = Join-Path $work 'skew'; New-Beat $d @{ tickAt = $nowMs + 60000 }
Assert-Daemon 'clock-skew-unknown' $d 6 2 'clock-skew'

$d = Join-Path $work 'frozen'; New-Beat $d @{}
Assert-Daemon 'heartbeat-not-advancing' $d 2 1 'heartbeat-not-advancing'

$d = Join-Path $work 'pid-gone'; New-Beat $d @{ pid = 999999999 }
Assert-Daemon 'daemon-pid-gone' $d 6 1 'daemon-pid-gone'

$d = Join-Path $work 'bad-fields'; New-Beat $d @{ tickAt = 0 }
Assert-Daemon 'heartbeat-fields-invalid' $d 6 2 'heartbeat-fields-invalid'

Write-Output '== L2 进程身份（-ProcessListFile 注入，代替受限会话里被禁的 CIM）=='
$l2dir = Join-Path $work 'l2'
$startedMs = $nowMs - 3600000
New-Beat $l2dir @{ startedAt = $startedMs }
$isoStarted = [DateTimeOffset]::FromUnixTimeMilliseconds($startedMs).ToString('o')
$isoDrift = [DateTimeOffset]::FromUnixTimeMilliseconds($startedMs - 3600000).ToString('o')

function Write-ProcList {
  param([string]$Name, [object[]]$Items)
  $f = Join-Path $work ($Name + '.json')
  if (@($Items).Count -eq 0) { '[]' | Set-Content -LiteralPath $f -Encoding utf8 }
  else { ConvertTo-Json -InputObject @($Items) -Depth 4 | Set-Content -LiteralPath $f -Encoding utf8 }
  return $f
}

function Assert-Instance {
  param([string]$Name, [string]$StateDir, [string]$ProcFile, [int]$ExpectedExit, [string]$ExpectedState, [string]$ExpectedReason = '')
  $r = Invoke-Probe $StateDir -Extra @('-ProcessListFile', $ProcFile) -NoWaitProbe
  $inst = if ($r.json) { $r.json.layers | Where-Object { $_.layer -eq 'instance' } }
  $state = if ($inst) { $inst.state } else { '<no-json>' }
  $reason = if ($inst) { $inst.reason } else { '' }
  $ok = ($r.exitCode -eq $ExpectedExit) -and ($state -eq $ExpectedState) -and ($ExpectedReason -eq '' -or $reason -eq $ExpectedReason)
  Report $Name $ok ('exit=' + $r.exitCode + ' state=' + $state + ' reason=' + $reason) ('exit=' + $ExpectedExit + ' state=' + $ExpectedState + ' reason=' + $ExpectedReason)
}

$goodProc = @{ ProcessId = $realPid; Name = 'node.exe'; CreationDate = $isoStarted; ExecutablePath = 'C:\node.exe'; CommandLine = 'node feishu-daemon.mjs' }
# 真实宿主的形态：cmd.exe /c 包一层（壳会一直活着，命令行里也有 feishu-daemon.mjs）
$wrapperProc = @{ ProcessId = 35408; Name = 'cmd.exe'; CreationDate = $isoStarted; ExecutablePath = 'C:\Windows\System32\cmd.exe'; CommandLine = 'cmd.exe /c "set DSH_HITL_CHANNEL=feishu&& node ""C:\node.exe"" ""D:\src\dsh\dsh-wechat-hitl\feishu\feishu-daemon.mjs"""' }
# L3/L4 被 skip，整体必然是 unknown(2)；instance 自己是 ready 才算过
Assert-Instance 'instance-ready' $l2dir (Write-ProcList 'p0' @($goodProc)) 2 'ready'
Assert-Instance 'instance-not-found' $l2dir (Write-ProcList 'p1' @()) 1 'unhealthy' 'daemon-process-not-found'
Assert-Instance 'instance-multiple' $l2dir (Write-ProcList 'p2' @($goodProc, @{ ProcessId = 777; CreationDate = $isoStarted; CommandLine = 'node feishu-daemon.mjs' })) 1 'unhealthy' 'multiple-instances'
Assert-Instance 'instance-pid-mismatch' $l2dir (Write-ProcList 'p3' @(@{ ProcessId = 999999; CreationDate = $isoStarted; CommandLine = 'node feishu-daemon.mjs' })) 1 'unhealthy' 'instance-mismatch'
Assert-Instance 'instance-created-drift' $l2dir (Write-ProcList 'p4' @(@{ ProcessId = $realPid; CreationDate = $isoDrift; CommandLine = 'node feishu-daemon.mjs' })) 1 'unhealthy' 'instance-mismatch'
$noBeatDir = Join-Path $work 'l2-nobeat'; New-Item -ItemType Directory -Force -Path $noBeatDir | Out-Null
Assert-Instance 'instance-no-heartbeat' $noBeatDir (Write-ProcList 'p5' @($goodProc)) 2 'unknown' 'no-heartbeat-to-compare'
# 回归 2026-11-14 宿主误报：壳 + 真身 必须算 1 个实例
Assert-Instance 'instance-with-cmd-wrapper' $l2dir (Write-ProcList 'p6' @($wrapperProc, $goodProc)) 2 'ready'
Assert-Instance 'instance-wrapper-only' $l2dir (Write-ProcList 'p7' @($wrapperProc)) 1 'unhealthy' 'daemon-process-not-found'
Assert-Instance 'instance-two-real' $l2dir (Write-ProcList 'p8' @($goodProc, @{ ProcessId = 4242; Name = 'node.exe'; CreationDate = $isoStarted; CommandLine = 'node feishu-daemon.mjs' })) 1 'unhealthy' 'multiple-instances'

Write-Output '== L3 时间戳呈现（UTC 不得被当本地）=='
# 软用例：3082 不可达时跳过，不判失败（宿主上跑才有意义）
$liveRaw = & pwsh -NoProfile -File $probe -SkipProcessCheck -SkipReply -NoWait -Json
$liveCode = $LASTEXITCODE
$live = $null
try { $live = (($liveRaw -join ([string][char]10)).Trim()) | ConvertFrom-Json } catch { $live = $null }
$orch = if ($live) { $live.layers | Where-Object { $_.layer -eq 'orchestrator' } }
if (-not $orch -or $orch.reason -eq 'connect-failed') {
  Write-Output '  skip  l3-timestamp                  3082 不可达，跳过'
} elseif ($orch.reason -eq 'skipped') {
  Write-Output '  skip  l3-timestamp                  orchestrator 被跳过'
} else {
  # 注意：ConvertFrom-Json 会把 ISO 串再转成 [datetime]，[string] 后偏移就丢，
  # 所以断言必须看原始 JSON 文本（这正是之前 UTC 被当本地读的同一个坑）。
  $rawText = ($liveRaw -join ([string][char]10))
  $m = [regex]::Match($rawText, '"runtimeAt":\s*"([^"]+)"')
  $at = if ($m.Success) { $m.Groups[1].Value } else { '<missing>' }
  Report 'l3-timestamp-local-offset' ($at -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$') ('runtimeAt=' + $at) 'ISO8601 带本地偏移，如 2026-11-14T12:04:39+08:00'
}

Write-Output '== restart-feishu-daemon.ps1 -Action status =='
$statusMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$okBeat = Join-Path $work 'ok.json'
@{ pid = 1; startedAt = $statusMs; tickAt = $statusMs; inbound = 'running'; lastError = 'x' } | ConvertTo-Json | Set-Content -LiteralPath $okBeat -Encoding utf8
$badBeat = Join-Path $work 'bad.json'
@{ pid = 1; startedAt = $statusMs; tickAt = $statusMs; inbound = 'spawn-failed'; lastError = 'EPERM' } | ConvertTo-Json | Set-Content -LiteralPath $badBeat -Encoding utf8
$staleBeat = Join-Path $work 'stale.json'
@{ pid = 1; startedAt = $statusMs - 600000; tickAt = $statusMs - 600000; inbound = 'running'; lastError = 'x' } | ConvertTo-Json | Set-Content -LiteralPath $staleBeat -Encoding utf8
# 状态现在同时核对 pid；注入假进程清单，避免测试依赖真实系统进程。
$statusProcFile = Join-Path $work 'status-procs.json'
@(@{ ProcessId = 1; Name = 'node.exe'; CreationDate = $statusMs; CommandLine = 'node feishu-daemon.mjs' }) | ConvertTo-Json | Set-Content -LiteralPath $statusProcFile -Encoding utf8

function Assert-Status {
  param([string]$Name, [string]$BeatPath, [int]$Expected)
  & pwsh -NoProfile -File $restart -Action status -BeatFileOverride $BeatPath -ProcessListFile $statusProcFile | Out-Null
  $code = $LASTEXITCODE
  Report $Name ($code -eq $Expected) ('exit=' + $code) ('exit=' + $Expected)
}
Assert-Status 'status-healthy' $okBeat 0
Assert-Status 'status-unhealthy' $badBeat 1
Assert-Status 'status-stale' $staleBeat 1
Assert-Status 'status-unknown' (Join-Path $work 'nope.json') 2

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ('feishu-health tests: pass=' + $script:pass + ' fail=' + $script:fail)
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
