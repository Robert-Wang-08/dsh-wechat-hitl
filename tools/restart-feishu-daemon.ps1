<#
  restart-feishu-daemon.ps1 - 起飞书 HITL 通道守护进程（2026-11-05）

  与 restart-gateway.ps1 同一套路：用 WMI Win32_Process.Create 启动，父进程是 WmiPrvSE，
  脱离 DSH 的 Windows Job，DSH Web 重启不会把它带走。

  用法：
    pwsh -NoProfile -File restart-feishu-daemon.ps1                 # 启动（已在跑则只报状态）
    pwsh -NoProfile -File restart-feishu-daemon.ps1 -Action stop
    pwsh -NoProfile -File restart-feishu-daemon.ps1 -Action status
    pwsh -NoProfile -File restart-feishu-daemon.ps1 -Action restart

  参数：
    -TimeoutSeconds 30   等待心跳超时
    -ConfigDir <path>    lark-cli 配置目录（默认 ~/.lark-cli-dsh-superagent-feishu2；旧的 -dsh-superagent 仅作兜底）
#>
param(
  [ValidateSet('start','stop','status','restart')]
  [string]$Action = 'start',
  [int]$TimeoutSeconds = 30,
  [string]$ConfigDir = '',
  # 2026-11-14：仅用于自检/单测时指向别的心跳文件；不传则仍是 state\feishu-daemon.json。
  # 注意：不能叫 -BeatFile——PowerShell 变量大小写不敏感，会和脚本内的 $beatFile 撞车（实测被覆盖回生产路径）。
  [string]$BeatFileOverride = ''
)

$ErrorActionPreference = 'Continue'
$root = 'D:\src\dsh\dsh-wechat-hitl'
$daemon = Join-Path $root 'feishu\feishu-daemon.mjs'
$beatFile = Join-Path $root 'state\feishu-daemon.json'
$outFile = Join-Path $root 'state\feishu-daemon.out'
if ($BeatFileOverride) { $beatFile = $BeatFileOverride }

function Get-Beat {
  if (-not (Test-Path $beatFile)) { return $null }
  try { return Get-Content $beatFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-StatusReport {
  # 2026-11-14：拆出结构化状态，让 -Action status 能给三态退出码。
  # 原本 Show-Status 用 Write-Output 打行 + return 布尔，调用方一 Pipe 就丢掉布尔，只能恒 exit 0（假绿灯）。
  $beat = Get-Beat
  if (-not $beat) {
    return [pscustomobject]@{ text = '心跳文件不存在：守护进程没起过（状态未知，不是健康）'; alive = $false; known = $false }
  }
  $age = [math]::Round(((Get-Date).ToUniversalTime().ToFileTime() / 10000 - 11644473600000 - [double]$beat.tickAt) / 1000, 1)
  $alive = $age -le 30 -and $beat.inbound -eq "running"
  $text = "daemon pid=" + $beat.pid + "  alive=" + $alive + "  heartbeatAgeSec=" + $age + "  inbound=" + $beat.inbound + "  lastError=" + $beat.lastError
  return [pscustomobject]@{ text = $text; alive = $alive; known = $true }
}

function Show-Status {
  $report = Get-StatusReport
  Write-Output $report.text
  return $report.alive
}

if ($Action -eq 'status') {
  # 三态退出码（与 tools/test-feishu-health.ps1 一致）：0=健康 1=不健康 2=未知（心跳文件缺失）
  $report = Get-StatusReport
  Write-Output $report.text
  if (-not $report.known) { exit 2 }
  if ($report.alive) { exit 0 }
  exit 1
}

if ($Action -eq 'stop' -or $Action -eq 'restart') {
  $beat = Get-Beat
  if ($beat -and $beat.pid) {
    $proc = Get-Process -Id $beat.pid -ErrorAction SilentlyContinue
    if ($proc) { Stop-Process -Id $beat.pid -Force -ErrorAction SilentlyContinue; Write-Output ("stopped daemon pid " + $beat.pid) }
    else { Write-Output ("daemon pid " + $beat.pid + " 已不在") }
  } else { Write-Output '没有可停的守护进程' }
  Start-Sleep -Seconds 1
  if ($Action -eq 'stop') { exit 0 }
}

if (-not (Test-Path $daemon)) { Write-Output ("!!! 找不到守护进程入口：" + $daemon); exit 1 }

$beat = Get-Beat
if ($beat -and $beat.pid -and (Get-Process -Id $beat.pid -ErrorAction SilentlyContinue)) {
  $age = [math]::Round(((Get-Date).ToUniversalTime().ToFileTime() / 10000 - 11644473600000 - [double]$beat.tickAt) / 1000, 1)
  if ($age -le 30 -and $beat.inbound -eq "running") { Write-Output ("已在运行 pid=" + $beat.pid + "，跳过启动"); Show-Status | Out-Null; exit 0 }
}

$chosenConfig = $ConfigDir
if (-not $chosenConfig) {
  # 2026-11-06：默认改成 -feishu2 那一套（app cli_aa66f315697adc03，实测可用）。
  # 旧的 .lark-cli-dsh-superagent（app cli_aa6697691db89c00）被飞书 21001 数据安全策略拦，
  # 保留它做兜底，但不再当默认，避免"重启一次就回到被拦的机器人"。
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
  Write-Output ('!!! WMI 启动失败 ReturnValue=' + $spawn.ReturnValue + '，退回 Start-Process')
  $env:DSH_HITL_CHANNEL = 'feishu'
  $env:DSH_HITL_LARK_CONFIG_DIR = $chosenConfig
  $env:LARKSUITE_CLI_CONFIG_DIR = $chosenConfig
  Start-Process -FilePath $nodeExe -ArgumentList $daemon -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError ($outFile + '.err')
} else {
  Write-Output ('feishu daemon spawned detached (pid ' + $spawn.ProcessId + ', config=' + $chosenConfig + ')')
}

$rounds = [Math]::Ceiling($TimeoutSeconds / 2)
for ($i = 0; $i -lt $rounds; $i++) {
  Start-Sleep -Seconds 2
  $b = Get-Beat
  if ($b) {
    $age = [math]::Round(((Get-Date).ToUniversalTime().ToFileTime() / 10000 - 11644473600000 - [double]$b.tickAt) / 1000, 1)
    $newInstance = [double]$b.startedAt -ge $launchStartedAt
    if ($newInstance -and $b.inbound -eq "spawn-failed") {
      Write-Output ("!!! 入站启动失败：" + $b.lastError + "；请在宿主 PowerShell 运行同一脚本，勿在受限会话内重复启动")
      exit 1
    }
    if ($newInstance -and $age -le 10 -and $b.inbound -eq "running") { Write-Output ('daemon UP after ~' + (($i + 1) * 2) + 's (pid ' + $b.pid + ', inbound=' + $b.inbound + ')'); exit 0 }
  }
}
Write-Output ('!!! 守护进程在 ' + $TimeoutSeconds + 's 内没有写心跳，看 ' + $outFile)
exit 1
