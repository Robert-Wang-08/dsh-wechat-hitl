#Requires -Version 7.0
<#
.SYNOPSIS
  飞书通道只读四层健康探针（2026-11-14 / M1）。

.DESCRIPTION
  只读。不启动、不停止、不杀任何进程，不改任何生产状态文件。
  四层：
    L1 daemon        心跳是否推进 + 入站(inbound)是否在收
    L2 instance      进程身份与单实例（CIM；受限环境枚举被拒时如实 unknown，绝不当 0 条）
    L3 orchestrator  superagent :3082 的 runtime / feishu 就绪
    L4 reply         回信重试是否在无限重试（只读 sqlite；退化到健康报告文件）

  退出码：0 = ready，1 = unhealthy，2 = unknown。
  unknown 绝不退化为 0（权限不足、工具缺失、超时都算 unknown）。

  正式运行位置：宿主 PowerShell 或计划任务（沙箱外）。
  在受限会话里跑时 L2 通常是 unknown / process-enum-denied，这是设计意图，不是 bug。

.EXAMPLE
  pwsh -NoProfile -File tools/test-feishu-health.ps1
  pwsh -NoProfile -File tools/test-feishu-health.ps1 -Json
  pwsh -NoProfile -File tools/test-feishu-health.ps1 -Json -SkipProcessCheck
#>
[CmdletBinding()]
param(
  [string]$HitlRoot,
  [string]$StateDir,
  [string]$OrchestratorUrl = 'http://127.0.0.1:3082/orchestrator/api/state',
  [string]$OrchestratorDb,
  [string]$HealthFile,
  [int]$HeartbeatMaxAgeSec = 15,
  [double]$ClockSkewToleranceSec = 5,
  [int]$SampleWaitSec = 6,
  [int]$HttpTimeoutSec = 5,
  [switch]$SkipProcessCheck,
  # 自检用：把「进程清单」用 JSON 文件注入，替代 CIM 枚举（沙箱内 CIM 被拒，身份逻辑否则无法验证）。
  # 每项字段：ProcessId / CreationDate(ISO 或 epoch ms) / ExecutablePath / CommandLine
  [string]$ProcessListFile,
  [switch]$SkipOrchestrator,
  [switch]$SkipReply,
  [switch]$NoWait,
  [switch]$Json
)

$ErrorActionPreference = 'Continue'

if (-not $HitlRoot) { $HitlRoot = Split-Path -Parent $PSScriptRoot }
if (-not $StateDir) { $StateDir = Join-Path $HitlRoot 'state' }
if (-not $OrchestratorDb) { $OrchestratorDb = Join-Path $env:USERPROFILE '.dsh\state\superagent\orchestrator.sqlite' }
if (-not $HealthFile) { $HealthFile = Join-Path $env:USERPROFILE '.dsh\state\superagent-health\latest.json' }

function New-Layer {
  param([string]$Name)
  return [ordered]@{ layer = $Name; state = 'unknown'; reason = $null; detail = [ordered]@{} }
}

function Set-Layer {
  param($Layer, [string]$State, $Reason, $Detail)
  $Layer['state'] = $State
  $Layer['reason'] = $Reason
  if ($null -ne $Detail) {
    foreach ($k in $Detail.Keys) { $Layer['detail'][$k] = $Detail[$k] }
  }
  return $Layer
}

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Get-ProcKind {
  # 只把「真的 node/bun 进程」算 daemon 实例。
  # 依据：restart-feishu-daemon.ps1 用 cmd.exe /c "...node ... feishu-daemon.mjs >> out" 启动，
  # 那个包装 cmd.exe 会一直活着（它要等子进程），命令行里同样含 feishu-daemon.mjs——
  # 2026-11-14 宿主实测把它误判成「第二个实例」（count=2 pids=35408 1732），必须排除壳。
  param($Proc)
  $name = [string]$Proc.Name
  $cmd = [string]$Proc.CommandLine
  if ($cmd) {
    # 命令行「首个 token」必须就是 node/bun（cmd 壳的首 token 是 cmd.exe）
    if ($cmd -match '^\s*"?[^"\s]*\\?(node|bun)(\.exe)?"?\s') { return 'node' }
    if ($cmd -match '^\s*"?[^"\s]*\\(cmd|powershell|pwsh|conhost|bash|sh|wsl|winpty)(\.exe)?"?\s') { return 'shell' }
  }
  if ($name -match '^(node|bun)(\.exe)?$') { return 'node' }
  if ($name -match '^(cmd|powershell|pwsh|conhost|bash|sh|wsl|winpty)(\.exe)?$') { return 'shell' }
  return 'other'
}

function Format-Ts {
  # ConvertFrom-Json 会把 ISO 字符串转成 [datetime]（Kind=Utc），人读时如果直接拼进字符串，
  # 就会把 UTC 当本地打印——2026-11-14 实测把 12:04:39(+08) 显示成 04:04:39，误判成「凌晨重启过」。
  param($Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [datetime]) {
    $d = if ($Value.Kind -eq [System.DateTimeKind]::Unspecified) {
      [DateTimeOffset]::new($Value)
    } else {
      [DateTimeOffset]$Value
    }
    return $d.ToLocalTime().ToString('yyyy-MM-ddTHH:mm:sszzz')
  }
  if ($Value -is [DateTimeOffset]) { return ([DateTimeOffset]$Value).ToLocalTime().ToString('yyyy-MM-ddTHH:mm:sszzz') }
  return [string]$Value
}

function ConvertTo-EpochMs {
  # CIM 的 CreationDate 是 [datetime]；注入清单可能给 ISO 字符串或 epoch 数字。
  # 数字 >1e12 视为毫秒、>1e9 视为秒；其余返回 $null（宁可不比对，也不瞎比对）。
  param($Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [datetime] -or $Value -is [DateTimeOffset]) {
    try { return ([DateTimeOffset]$Value).ToUnixTimeMilliseconds() } catch { return $null }
  }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
    $n = [double]$Value
    if ($n -gt 1e12) { return $n }
    if ($n -gt 1e9) { return ($n * 1000) }
    return $null
  }
  $s = [string]$Value
  if ($s -match '^[0-9]+$') { return (ConvertTo-EpochMs ([double]$s)) }
  try { return ([DateTimeOffset]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture)).ToUnixTimeMilliseconds() } catch { return $null }
}

function Get-HeartbeatAgeSec {
  param([double]$TickAt)
  return [math]::Round(((Get-NowMs) - $TickAt) / 1000, 1)
}

# L1 daemon：心跳推进 + 入站状态
function Test-DaemonLayer {
  $layer = New-Layer 'daemon'
  if (-not (Test-Path -LiteralPath $StateDir)) {
    return Set-Layer $layer 'unknown' 'state-dir-missing' ([ordered]@{ stateDir = $StateDir })
  }
  $beatPath = Join-Path $StateDir 'feishu-daemon.json'
  if (-not (Test-Path -LiteralPath $beatPath)) {
    return Set-Layer $layer 'unknown' 'heartbeat-missing' ([ordered]@{ path = $beatPath })
  }
  try { $beat = Get-Content -LiteralPath $beatPath -Raw | ConvertFrom-Json }
  catch { return Set-Layer $layer 'unknown' 'heartbeat-unparsable' ([ordered]@{ path = $beatPath; error = $_.Exception.Message }) }

  $daemonPid = [int]$beat.pid
  $tickAt = [double]$beat.tickAt
  $startedAt = [double]$beat.startedAt
  $inbound = [string]$beat.inbound
  # 字段缺失/非法（老版本心跳或写坏）不能算「陈旧」，那是读不懂而不是状态坏。
  if ($tickAt -le 0 -or $startedAt -le 0 -or $daemonPid -le 0) {
    return Set-Layer $layer 'unknown' 'heartbeat-fields-invalid' ([ordered]@{ pid = $beat.pid; tickAt = $beat.tickAt; startedAt = $beat.startedAt })
  }
  $age1 = Get-HeartbeatAgeSec -TickAt $tickAt
  $aliveProc = [bool](Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)

  $sameInstance = $true
  $tickAdvanced = $null
  $advanceChecked = $false
  if (-not $NoWait) {
    Start-Sleep -Seconds $SampleWaitSec
    $beat2 = $null
    try { $beat2 = Get-Content -LiteralPath $beatPath -Raw | ConvertFrom-Json } catch { $beat2 = $null }
    if (-not $beat2) { return Set-Layer $layer 'unknown' 'heartbeat-resample-unreadable' ([ordered]@{ path = $beatPath }) }
    if ($beat2) {
      $advanceChecked = $true
      $sameInstance = ([int]$beat2.pid -eq $daemonPid) -and ([double]$beat2.startedAt -eq $startedAt)
      $tickAdvanced = ([double]$beat2.tickAt -gt $tickAt)
      $inbound = [string]$beat2.inbound
      $beat = $beat2
    }
  }

  $detail = [ordered]@{
    pid = $daemonPid
    pidAlive = $aliveProc
    inbound = $inbound
    heartbeatAgeSec = $age1
    maxAgeSec = $HeartbeatMaxAgeSec
    sameInstance = $sameInstance
    advanceChecked = $advanceChecked
    tickAdvanced = $tickAdvanced
    hint = $beat.hint
    lastError = $beat.lastError
    switchState = $beat.switchState
  }

  if ([string]::IsNullOrWhiteSpace($inbound)) { return Set-Layer $layer 'unknown' 'inbound-unknown' $detail }
  if ($age1 -lt (-1 * $ClockSkewToleranceSec)) { return Set-Layer $layer 'unknown' 'clock-skew' $detail }
  if ($inbound -eq 'starting') { return Set-Layer $layer 'unknown' 'inbound-starting' $detail }
  if ($inbound -eq 'spawn-failed') { return Set-Layer $layer 'unhealthy' 'inbound-spawn-failed' $detail }
  if ($inbound -eq 'stopped') { return Set-Layer $layer 'unhealthy' 'inbound-stopped' $detail }
  if ($inbound -eq 'disabled') { return Set-Layer $layer 'unhealthy' 'inbound-disabled' $detail }
  if ($inbound -eq 'blocked:policy') { return Set-Layer $layer 'unhealthy' 'inbound-blocked-policy' $detail }
  if ($inbound -like 'exited:*') { return Set-Layer $layer 'unhealthy' 'inbound-exited' $detail }
  if (-not $aliveProc) { return Set-Layer $layer 'unhealthy' 'daemon-pid-gone' $detail }
  if (-not $sameInstance) { return Set-Layer $layer 'unhealthy' 'instance-changed' $detail }
  if ($age1 -gt $HeartbeatMaxAgeSec) { return Set-Layer $layer 'unhealthy' 'heartbeat-stale' $detail }
  if ($advanceChecked -and -not $tickAdvanced) { return Set-Layer $layer 'unhealthy' 'heartbeat-not-advancing' $detail }
  if ($inbound -ne 'running') { return Set-Layer $layer 'unhealthy' ('inbound-' + $inbound) $detail }
  return Set-Layer $layer 'ready' $null $detail
}

# L2 instance：进程身份与单实例
function Test-InstanceLayer {
  param([int]$ExpectedPid, [double]$ExpectedStartedAt)
  $layer = New-Layer 'instance'
  if ($SkipProcessCheck) { return Set-Layer $layer 'unknown' 'skipped' ([ordered]@{ skipped = $true }) }
  $procs = $null
  if ($ProcessListFile) {
    if (-not (Test-Path -LiteralPath $ProcessListFile)) {
      return Set-Layer $layer 'unknown' 'process-list-file-missing' ([ordered]@{ path = $ProcessListFile })
    }
    try { $procs = @(Get-Content -LiteralPath $ProcessListFile -Raw | ConvertFrom-Json) }
    catch { return Set-Layer $layer 'unknown' 'process-list-unparsable' ([ordered]@{ path = $ProcessListFile; error = $_.Exception.Message }) }
  } else {
    try {
      # 不按 Name='node.exe' 过滤：守护脚本被包在 cmd.exe /c 里，二进制也可能改名；
      # 认命令行里的 feishu-daemon.mjs 更稳。
      $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'feishu-daemon\.mjs' })
    } catch {
      # 权限被拒绝不能读成 0 条：0 条会被误判成「进程没了」，进而被自动修复逻辑误杀/误起。
      # 但仍然顺手做「不依赖枚举」的那一半核对（pid 存在性 + 创建时间漂移），人读时有用；
      # 状态必须仍是 unknown——「只有一个实例」这件事用 Get-Process 证明不了。
      $pidAlive = [bool](Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)
      $driftProbe = $null
      if ($pidAlive -and $ExpectedStartedAt -gt 0) {
        try {
          $procStart = (Get-Process -Id $ExpectedPid -ErrorAction Stop).StartTime
          $driftProbe = [math]::Round((([DateTimeOffset]$procStart).ToUnixTimeMilliseconds() - $ExpectedStartedAt) / 1000, 1)
        } catch { $driftProbe = $null }
      }
      return Set-Layer $layer 'unknown' 'process-enum-denied' ([ordered]@{
        error = $_.Exception.Message
        pidAlive = $pidAlive
        startTimeDriftSec = $driftProbe
        duplicateCheck = 'unavailable'
      })
    }
  }
  $daemonProcs = @($procs | Where-Object { (Get-ProcKind $_) -eq 'node' })
  $wrappers = @($procs | Where-Object { (Get-ProcKind $_) -ne 'node' })
  $wrapperInfo = @($wrappers | ForEach-Object { [string]$_.ProcessId + ':' + [string]$_.Name })
  $count = $daemonProcs.Count
  if ($count -eq 0) {
    # 有壳无 node：说明壳还在但真正的 daemon 已退出（或命令根本没起来）
    return Set-Layer $layer 'unhealthy' 'daemon-process-not-found' ([ordered]@{ count = 0; expectedPid = $ExpectedPid; wrappers = $wrapperInfo })
  }
  if ($count -gt 1) {
    return Set-Layer $layer 'unhealthy' 'multiple-instances' ([ordered]@{ count = $count; pids = @($daemonProcs | ForEach-Object { $_.ProcessId }); wrappers = $wrapperInfo })
  }
  $p = $daemonProcs[0]
  if ($ExpectedPid -le 0) {
    # 只有进程、没有心跳 pid 可比对：单实例数得清，但「是不是那个实例」无法证明 → unknown，不给绿。
    return Set-Layer $layer 'unknown' 'no-heartbeat-to-compare' ([ordered]@{ count = 1; pid = [int]$p.ProcessId })
  }
  $drift = $null
  $ok = ([int]$p.ProcessId -eq $ExpectedPid)
  if ($ExpectedStartedAt -gt 0) {
    $createdMs = ConvertTo-EpochMs $p.CreationDate
    if ($null -ne $createdMs) {
      $drift = [math]::Round(($createdMs - $ExpectedStartedAt) / 1000, 1)
      if ([math]::Abs($drift) -gt 180) { $ok = $false }
    }
  }
  $detail = [ordered]@{
    count = 1
    pid = [int]$p.ProcessId
    expectedPid = $ExpectedPid
    createdDriftSec = $drift
    executable = $p.ExecutablePath
    matchedProcesses = $procs.Count
    wrappers = $wrapperInfo
  }
  if (-not $ok) { return Set-Layer $layer 'unhealthy' 'instance-mismatch' $detail }
  return Set-Layer $layer 'ready' $null $detail
}

# L3 orchestrator：:3082 runtime / feishu 就绪
function Test-OrchestratorLayer {
  $layer = New-Layer 'orchestrator'
  if ($SkipOrchestrator) { return Set-Layer $layer 'unknown' 'skipped' ([ordered]@{ skipped = $true }) }
  $code = 0
  $content = $null
  try {
    $resp = Invoke-WebRequest -Uri $OrchestratorUrl -Method Get -TimeoutSec $HttpTimeoutSec -SkipHttpErrorCheck -ErrorAction Stop -Headers @{ 'X-Orchestrator-Request' = '1' }
    $code = [int]$resp.StatusCode
    $content = $resp.Content
  } catch {
    return Set-Layer $layer 'unhealthy' 'connect-failed' ([ordered]@{ url = $OrchestratorUrl; error = $_.Exception.Message })
  }
  if ($code -eq 403) { return Set-Layer $layer 'unknown' 'http-forbidden' ([ordered]@{ url = $OrchestratorUrl; httpStatus = $code }) }
  if ($code -eq 404) { return Set-Layer $layer 'unhealthy' 'route-not-activated' ([ordered]@{ url = $OrchestratorUrl; httpStatus = $code }) }
  if ($code -ne 200) { return Set-Layer $layer 'unhealthy' ('http-' + $code) ([ordered]@{ url = $OrchestratorUrl; httpStatus = $code }) }
  $s = $null
  try { $s = $content | ConvertFrom-Json } catch { return Set-Layer $layer 'unknown' 'unexpected-shape' ([ordered]@{ httpStatus = $code; error = 'json-parse' }) }
  if (-not $s.health) { return Set-Layer $layer 'unknown' 'unexpected-shape' ([ordered]@{ httpStatus = $code; error = 'health-missing' }) }
  if (-not $s.health.runtime -or -not $s.health.feishu) {
    return Set-Layer $layer 'unknown' 'unexpected-shape' ([ordered]@{ httpStatus = $code; error = 'health.runtime/feishu-missing' })
  }

  $runtimeState = [string]$s.health.runtime.state
  if ([string]::IsNullOrWhiteSpace($runtimeState)) { return Set-Layer $layer 'unknown' 'unexpected-shape' ([ordered]@{ httpStatus = $code; error = 'runtime.state-missing' }) }
  $feishuState = [string]$s.health.feishu.state
  if ([string]::IsNullOrWhiteSpace($feishuState)) { return Set-Layer $layer 'unknown' 'unexpected-shape' ([ordered]@{ httpStatus = $code; error = 'feishu.state-missing' }) }
  $problem = $s.setup.problem
  $feishuProblem = $s.setup.feishuProblem
  $detail = [ordered]@{
    runtime = $runtimeState
    runtimeAt = (Format-Ts $s.health.runtime.at)
    feishu = $feishuState
    feishuAt = (Format-Ts $s.health.feishu.at)
    problem = $problem
    feishuProblem = $feishuProblem
  }
  if ($runtimeState -ne 'ready') { return Set-Layer $layer 'unhealthy' ('runtime-' + $runtimeState) $detail }
  if ($feishuState -ne 'ready') { return Set-Layer $layer 'unhealthy' ('feishu-' + $feishuState) $detail }
  if ($problem) { return Set-Layer $layer 'unhealthy' 'setup-problem' $detail }
  if ($feishuProblem) { return Set-Layer $layer 'unhealthy' 'setup-feishu-problem' $detail }
  return Set-Layer $layer 'ready' $null $detail
}

# L4 reply：回信是否在无限重试
function Test-ReplyLayer {
  $layer = New-Layer 'reply'
  if ($SkipReply) { return Set-Layer $layer 'unknown' 'skipped' ([ordered]@{ skipped = $true }) }
  $helper = Join-Path $HitlRoot 'tools\feishu-reply-health.mjs'
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd -and (Test-Path -LiteralPath $helper) -and (Test-Path -LiteralPath $OrchestratorDb)) {
    $raw = $null
    try { $raw = (& $nodeCmd.Source $helper $OrchestratorDb 2>$null) -join '' } catch { $raw = $null }
    $parsed = $null
    if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null } }
    if ($parsed -and $parsed.ok) {
      $pending = [int]$parsed.pending
      $detail = [ordered]@{
        source = 'sqlite'
        db = $OrchestratorDb
        pending = $pending
        maxAttempts = [int]$parsed.maxAttempts
        oldestSince = (Format-Ts $parsed.sample.since)
        lastError = $parsed.sample.error
      }
      if ($pending -gt 0) { return Set-Layer $layer 'unhealthy' 'reply-retry-storm' $detail }
      return Set-Layer $layer 'ready' $null $detail
    }
    $GLOBAL:LAST_REPLY_SQLITE_ERROR = if ($parsed) { [string]$parsed.error } else { 'unparsable-output' }
  }
  # 退化：读健康报告文件里 id=superagent 的 reply 组件
  if (Test-Path -LiteralPath $HealthFile) {
    $h = $null
    try { $h = Get-Content -LiteralPath $HealthFile -Raw | ConvertFrom-Json } catch { $h = $null }
    if ($h) {
      $inst = @($h.instances | Where-Object { $_.id -eq 'superagent' })[0]
      if (-not $inst) { return Set-Layer $layer 'unknown' 'reply-health-unavailable' ([ordered]@{ source = 'health-file'; reason = 'instance-superagent-missing' }) }
      $replyState = [string]$inst.components.reply.state
      $detail = [ordered]@{
        source = 'health-file'
        healthFile = $HealthFile
        observedAt = (Format-Ts $inst.observedAt)
        replyState = $replyState
        sqliteFallbackReason = $GLOBAL:LAST_REPLY_SQLITE_ERROR
      }
      if ($replyState -eq 'error') { return Set-Layer $layer 'unhealthy' 'reply-error' $detail }
      if ($replyState -eq 'ready') { return Set-Layer $layer 'ready' $null $detail }
      return Set-Layer $layer 'unknown' 'reply-health-unavailable' $detail
    }
  }
  return Set-Layer $layer 'unknown' 'reply-health-unavailable' ([ordered]@{ db = $OrchestratorDb; healthFile = $HealthFile; sqliteFallbackReason = $GLOBAL:LAST_REPLY_SQLITE_ERROR })
}

# 采集
$l1 = Test-DaemonLayer
$expectedPid = 0
$expectedStartedAt = 0
$beatPath = Join-Path $StateDir 'feishu-daemon.json'
if (Test-Path -LiteralPath $beatPath) {
  try {
    $b = Get-Content -LiteralPath $beatPath -Raw | ConvertFrom-Json
    $expectedPid = [int]$b.pid
    $expectedStartedAt = [double]$b.startedAt
  } catch {}
}
$l2 = Test-InstanceLayer -ExpectedPid $expectedPid -ExpectedStartedAt $expectedStartedAt
$l3 = Test-OrchestratorLayer
$l4 = Test-ReplyLayer
$layers = @($l1, $l2, $l3, $l4)

$states = @($layers | ForEach-Object { $_.state })
if ($states -contains 'unhealthy') { $verdict = 'unhealthy' }
elseif ($states -contains 'unknown') { $verdict = 'unknown' }
else { $verdict = 'ready' }
$exitCode = switch ($verdict) { 'ready' { 0 } 'unhealthy' { 1 } default { 2 } }

$bad = @($layers | Where-Object { $_.state -ne 'ready' } | ForEach-Object { $_.layer + ':' + $(if ($_.reason) { $_.reason } else { $_.state }) })
if ($bad.Count -eq 0) { $summary = '四层均 ready' }
else { $summary = '需关注 ' + ($bad -join ', ') + '（verdict=' + $verdict + '）' }

$collectedAt = [DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz')
if ($Json) {
  $payload = [ordered]@{
    schemaVersion = '1.0'
    collectedAt = $collectedAt
    verdict = $verdict
    exitCode = $exitCode
    summary = $summary
    layers = $layers
  }
  $payload | ConvertTo-Json -Depth 8
} else {
  Write-Output ('飞书通道健康探针 · ' + $collectedAt)
  foreach ($l in $layers) {
    $reason = if ($l.reason) { $l.reason } else { '-' }
    $d = ($l.detail.GetEnumerator() | Where-Object { $null -ne $_.Value } | ForEach-Object { $_.Key + '=' + $_.Value }) -join ' '
    Write-Output ('  [' + $l.state.PadRight(9) + '] ' + $l.layer.PadRight(12) + ' ' + $reason.PadRight(24) + ' ' + $d)
  }
  Write-Output ('VERDICT: ' + $verdict + '（exit ' + $exitCode + '）  ' + $summary)
}
exit $exitCode
