<#
  restart-feishu-daemon.ps1 — 飞书 HITL 通道守护进程管理（2026-11-15 修复版）

  修复要点：
    1) start 前先枚举所有 feishu-daemon.mjs 进程；只要有一个就拒绝再起第二个；
    2) stop 先写 state/feishu-daemon.stop 让 daemon 优雅退出（关闭 lark-cli 的 stdin），
       超时才按 pid + 创建时间兜底强杀；不再只靠 Stop-Process -Force；
    3) status 同时核对心跳年龄、pid 存活、inbound 是否 ready，不再只看心跳；
    4) 支持 -ProcessListFile 注入假进程清单（自检用），不读生产进程。

  用法：
    pwsh -NoProfile -File restart-feishu-daemon.ps1                 # 启动（已有 daemon 则拒绝）
    pwsh -NoProfile -File restart-feishu-daemon.ps1 -Action stop
    pwsh -NoProfile -File restart-feishu-daemon.ps1 -Action status
    pwsh -NoProfile -File restart-feishu-daemon.ps1 -Action restart
#>
param(
  [ValidateSet('start','stop','status','restart')]
  [string]$Action = 'start',
  [int]$TimeoutSeconds = 30,
  [string]$ConfigDir = '',
  # 自检用：指向别的心跳文件；不传则用生产 state\feishu-daemon.json
  [string]$BeatFileOverride = '',
  # 自检用：用 JSON 进程清单替代 CIM 枚举（沙箱内 CIM 可能被拒）
  [string]$ProcessListFile = ''
)

$ErrorActionPreference = 'Continue'
$root = 'D:\src\dsh\dsh-wechat-hitl'
$daemon = Join-Path $root 'feishu\feishu-daemon.mjs'
$beatFile = if ($BeatFileOverride) { $BeatFileOverride } else { Join-Path $root 'state\feishu-daemon.json' }
$stateDir = Split-Path -Parent $beatFile
$outFile = Join-Path $stateDir 'feishu-daemon.out'
$stopFile = Join-Path $stateDir 'feishu-daemon.stop'
$lockFile = Join-Path $stateDir 'feishu-daemon.lock'

function Get-Beat {
  if (-not (Test-Path -LiteralPath $beatFile)) { return $null }
  try { return Get-Content -LiteralPath $beatFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-DaemonProcesses {
  # 注意：PowerShell 函数返回空数组会被展开成“无输出”，赋值后变成 $null。
  # 所以必须用 $script:processEnumOk 区分「枚举成功但 0 个」和「枚举失败」。
  $script:processEnumOk = $true
  if ($ProcessListFile) {
    try {
      $raw = Get-Content -LiteralPath $ProcessListFile -Raw | ConvertFrom-Json
      return @($raw)
    } catch { $script:processEnumOk = $false; return $null }
  }
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object {
          $_.CommandLine -and $_.CommandLine -match 'feishu-daemon\.mjs' -and
          $_.CommandLine -notmatch 'dsh-subprocess-local'
        })
  } catch { $script:processEnumOk = $false; return $null }
}

function Get-AgeSec([double]$TickAt) {
  return [math]::Round(((Get-Date).ToUniversalTime().ToFileTime() / 10000 - 11644473600000 - $TickAt) / 1000, 1)
}

function Get-StatusReport {
  $beat = Get-Beat
  if (-not $beat) {
    return [pscustomobject]@{ text = '心跳文件不存在：守护进程没起过（状态未知，不是健康）'; alive = $false; known = $false }
  }
  $procs = Get-DaemonProcesses
  if (-not $script:processEnumOk) {
    return [pscustomobject]@{ text = '无法枚举进程（CIM 被拒）：状态未知，不启动/不停止'; alive = $false; known = $false }
  }
  if ($null -eq $procs) { $procs = @() }
  $pidValue = [int]$beat.pid
  $pidMatch = @($procs | Where-Object { [int]$_.ProcessId -eq $pidValue }).Count -gt 0
  $pidAlive = if ($ProcessListFile) { $pidMatch } else { [bool](Get-Process -Id $pidValue -ErrorAction SilentlyContinue) }
  $age = Get-AgeSec ([double]$beat.tickAt)
  $inbound = [string]$beat.inbound
  $readyAt = if ($null -ne $beat.inboundReadyAt) { [double]$beat.inboundReadyAt } else { 0 }
  $alive = $age -le 30 -and $inbound -eq 'running' -and $pidAlive -and $pidMatch
  $text = "daemon pid=$pidValue alive=$alive ageSec=$age inbound=$inbound inboundReadyAt=$readyAt pidAlive=$pidAlive pidMatch=$pidMatch processCount=$($procs.Count)"
  return [pscustomobject]@{ text = $text; alive = $alive; known = $true }
}

function Stop-Daemon {
  $procs = Get-DaemonProcesses
  if (-not $script:processEnumOk) {
    # CIM 被拒时只能看心跳 pid；不要盲杀无关进程
    $beat = Get-Beat
    $procs = @()
    if ($beat -and $beat.pid -and (Get-Process -Id ([int]$beat.pid) -ErrorAction SilentlyContinue)) {
      $procs = @([pscustomobject]@{ ProcessId = [int]$beat.pid; CreationDate = $null })
    }
  } elseif ($null -eq $procs) { $procs = @() }
  if ($procs.Count -eq 0) {
    Write-Host '没有可停的守护进程'
    return $true
  }
  $targets = @($procs | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; CreationDate = $_.CreationDate } })
  $beatBeforeStop = Get-Beat
  $childPid = if ($beatBeforeStop -and $beatBeforeStop.childPid) { [int]$beatBeforeStop.childPid } else { 0 }
  Write-Host ('stopping daemon pid(s): ' + (($targets | ForEach-Object { $_.ProcessId }) -join ', '))

  # 优雅停止：daemon 轮询 stop 文件，关闭 lark-cli stdin 后自行退出。
  try { Set-Content -LiteralPath $stopFile -Value ((Get-Date).ToString('o')) -Encoding utf8 } catch { Write-Host ('WARN 写 stop 文件失败：' + $_.Exception.Message) }
  $deadline = (Get-Date).AddSeconds([Math]::Max(2, $TimeoutSeconds))
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $remaining = @($targets | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) { break }
  }
  $remaining = @($targets | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  if ($remaining.Count -gt 0) {
    Write-Host ('!!! daemon 未在 ' + $TimeoutSeconds + 's 内优雅退出，按原 pid 兜底强杀：' + (($remaining | ForEach-Object { $_.ProcessId }) -join ', '))
    foreach ($p in $remaining) {
      # 只用停止开始时枚举到的 pid；pid 复用风险由“几秒内”窗口和 daemon 单实例锁兜底。
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
  }
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  $left = @($targets | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  if ($left.Count -gt 0) {
    Write-Host ('!!! 仍有 daemon 进程存活：' + (($left | ForEach-Object { $_.ProcessId }) -join ', '))
    return $false
  }
  # daemon 被强杀时，lark-cli event consume 子进程可能变成孤儿；按心跳里的 childPid 清理。
  if ($childPid -gt 0 -and (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) {
    $cp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $childPid) -ErrorAction SilentlyContinue
    if ($cp -and $cp.CommandLine -match 'event\s+consume') {
      Write-Host ('cleaning orphaned inbound child pid=' + $childPid)
      Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
    } else {
      Write-Host ('WARN 心跳 childPid=' + $childPid + ' 仍存活，但无法确认是 event consume；未强杀')
    }
  }
  Write-Host 'daemon stopped'
  return $true
}

function Start-Daemon {
  $procs = Get-DaemonProcesses
  if (-not $script:processEnumOk) {
    Write-Host '!!! 无法枚举进程（CIM 被拒）：拒绝启动，避免再起一个重复 daemon'
    return 2
  }
  if ($null -eq $procs) { $procs = @() }
  if ($procs.Count -gt 0) {
    Write-Host ('!!! 已有 daemon 进程：' + (($procs | ForEach-Object { "$($_.ProcessId)@$($_.CreationDate)" }) -join ', ') + '；拒绝再起第二个')
    return 1
  }
  if (-not (Test-Path -LiteralPath $daemon)) { Write-Host ("!!! 找不到守护进程入口：" + $daemon); return 1 }
  # 不要在这里删 feishu-daemon.lock：锁是 daemon 的第二道防线。
  # 旧版文件锁/明确 owner 已死的目录锁由 daemon 自己判断并抢占；无 owner 的锁目录拒绝抢占，避免 TOCTOU。
  if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue }

  $chosenConfig = $ConfigDir
  if (-not $chosenConfig) {
    $preferred = Join-Path $env:USERPROFILE '.lark-cli-dsh-superagent-feishu2'
    $legacy = Join-Path $env:USERPROFILE '.lark-cli-dsh-superagent'
    if (Test-Path $preferred) { $chosenConfig = $preferred }
    elseif (Test-Path $legacy) { $chosenConfig = $legacy }
    else { $chosenConfig = Join-Path $env:USERPROFILE '.lark-cli-feishu-hitl' }
  }
  $launchStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $nodeExe = (Get-Command node).Source
  $cmdLine = 'cmd.exe /c "set DSH_HITL_CHANNEL=feishu&& set DSH_HITL_LARK_CONFIG_DIR=' + $chosenConfig + '&& set LARKSUITE_CLI_CONFIG_DIR=' + $chosenConfig + '&& ""' + $nodeExe + '"" ""' + $daemon + '"" >> ""' + $outFile + '"" 2>&1"'
  $spawn = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
  if ($spawn.ReturnValue -ne 0) {
    Write-Host ('!!! WMI 启动失败 ReturnValue=' + $spawn.ReturnValue + '，退回 Start-Process（耐久性较低）')
    $env:DSH_HITL_CHANNEL = 'feishu'
    $env:DSH_HITL_LARK_CONFIG_DIR = $chosenConfig
    $env:LARKSUITE_CLI_CONFIG_DIR = $chosenConfig
    Start-Process -FilePath $nodeExe -ArgumentList $daemon -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError ($outFile + '.err')
  } else {
    Write-Host ('feishu daemon spawned detached (launcher pid ' + $spawn.ProcessId + ', config=' + $chosenConfig + ')')
  }

  $rounds = [Math]::Ceiling($TimeoutSeconds / 2)
  for ($i = 0; $i -lt $rounds; $i++) {
    Start-Sleep -Seconds 2
    $b = Get-Beat
    if ($b) {
      $age = Get-AgeSec ([double]$b.tickAt)
      $newInstance = [double]$b.startedAt -ge $launchStartedAt
      $pids = Get-DaemonProcesses
      $pidMatch = if ($null -ne $pids) { @($pids | Where-Object { [int]$_.ProcessId -eq [int]$b.pid }).Count -gt 0 } else { $false }
      if ($newInstance -and $b.inbound -eq 'blocked:spawn') {
        Write-Host ('!!! 入站连续启动失败：' + $b.lastError + '；请在宿主/计划任务层排查，勿在受限会话里重启')
        return 1
      }
      if ($newInstance -and $age -le 10 -and $b.inbound -eq 'running' -and $pidMatch) {
        Write-Host ('daemon UP after ~' + (($i + 1) * 2) + 's (pid ' + $b.pid + ', inbound=' + $b.inbound + ', readyAt=' + $b.inboundReadyAt + ')')
        return 0
      }
    }
  }
  Write-Host ('!!! 守护进程在 ' + $TimeoutSeconds + 's 内没有进入 ready，看 ' + $outFile)
  return 1
}

switch ($Action) {
  'status' {
    $report = Get-StatusReport
    Write-Host $report.text
    if (-not $report.known) { exit 2 }
    if ($report.alive) { exit 0 }
    exit 1
  }
  'stop' {
    if (Stop-Daemon) { exit 0 } else { exit 1 }
  }
  'start' {
    exit (Start-Daemon)
  }
  'restart' {
    if (-not (Stop-Daemon)) { exit 1 }
    Start-Sleep -Seconds 1
    exit (Start-Daemon)
  }
}
