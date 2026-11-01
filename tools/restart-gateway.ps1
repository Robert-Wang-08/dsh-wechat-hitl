# restart-gateway.ps1 — 重启 OpenClaw 网关（含本机踩坑修补 + 启动前重新注入入站补丁）
#
# 背景（2026-10-26 / 2026-10-28 本机实测）：
#   1) 网关插件代码变更后热 reload 不生效，必须重启网关进程。
#   2) 直接 Stop-Process 杀网关会留下 openclaw.sqlite.cron-authority.lock（stale pid）；
#      下一次启动会在 gateway-run-bootstrap 阶段静默失败，日志只写 "The CLI command failed"。
#   3) openclaw-weixin 官方包升级会覆盖 dist/src 下的 monitor，入站游标补丁随之丢失。
#      因此每次启动前都跑一次幂等补丁（apply-weixin-inbound-fix.ps1），并保证登录自启也走这条路。
#   4) 2026-10-29 实测：从 DSH 会话里用 Start-Process 起的网关属于 DSH 的 Windows Job，
#      DSH Web 一重启（Job 关闭）网关就被带走，微信通道静默断掉。
#      所以这里改用 WMI Win32_Process.Create 启动，父进程是 WmiPrvSE，脱离 Job，DSH 重启不影响网关。
#   5) 2026-10-29 实测：进程内出站（inproc）对 contextToken 判定偏严，常报 contextToken missing
#      而 CLI 出口同一条消息能发出去，当时默认 DSH_BRIDGE_EGRESS=cli。
#   6) 2026-11-01 实测：CLI 出口每条要 spawn 一个 openclaw 子进程，单条 52–57 秒且串行，
#      积压时延迟按条数线性放大（用户报「通道发布时间的延长会比较多」）。
#      inproc 出口已在 lib 里修成三级取 token（内存→restoreContextTokens→账号 token 文件），
#      缺 token 时 drainOutbox 会自动退回 CLI（mode=cli-fallback），所以默认改回 inproc 快速通道，
#      保留 DSH_BRIDGE_EGRESS 环境变量可覆盖。
#
# 本脚本 = 停旧网关 + 清 stale lock + 重新注入入站补丁 + 修好登录自启钩子 + 脱离 Job 重启 + 等 18789 可用。
#
# 用法：pwsh -NoProfile -File restart-gateway.ps1 [-TimeoutSeconds 180]
param(
  [int]$TimeoutSeconds = 180,
  [switch]$Force
)
$ErrorActionPreference = 'Continue'
$stateDir = 'C:\Users\wwm_1\.openclaw\state'
$logFile = 'D:\src\dsh\dsh-wechat-hitl\state\gateway.log'
$toolsDir = 'D:\src\dsh\dsh-wechat-hitl\tools'

# 重启会有一两分钟入站空窗：这段时间你如果在微信里回了确认，那条答复会丢
# （2026-10-29 实测：05:58 重启，05:56 那条「37 1」没被处理 → 批准过期 → 会话又提权）。
# 有待确认在等答复时先警告，5 秒缓冲；赶时间加 -Force。
try {
  $pendingFile = Join-Path (Split-Path $logFile -Parent) 'pending.json'
  if (Test-Path $pendingFile) {
    $st = Get-Content $pendingFile -Raw | ConvertFrom-Json
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $live = @($st.requests.PSObject.Properties | Where-Object { $_.Value.status -eq 'pending' -and [int64]$_.Value.expiresAt -gt $nowMs } | ForEach-Object { $_.Value })
    if ($live.Count -gt 0 -and -not $Force) {
      Write-Output ('!!! 还有 ' + $live.Count + ' 条待确认在等你答复，重启期间它们的答复会丢：')
      foreach ($r in $live) {
        $left = [math]::Round(([int64]$r.expiresAt - $nowMs) / 60000, 1)
        Write-Output ('    R' + $r.id.ToString().Substring($r.id.ToString().Length - 6) + ' 剩余 ' + $left + ' 分钟：' + $r.question.ToString().Substring(0, [Math]::Min(40, $r.question.ToString().Length)))
      }
      Write-Output '    先回完再重启；或在 5 秒内 Ctrl+C。加 -Force 可无视。'
      Start-Sleep -Seconds 5
    }
  }
} catch { Write-Output ('pending 检查失败（不影响重启）：' + $_.Exception.Message) }

# 特征串用变量拼接：避免本脚本自身的命令行被误匹配后把自己杀掉
$a = 'openclaw'
$b = '.mjs'
$gateways = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $_.ExecutablePath -like '*openclaw-runtime*' -and
    $_.CommandLine -like "*$a*$b*" -and
    $_.CommandLine -like '*gateway run*' -and
    $_.CommandLine -notlike '*ptc-runtime*' -and
    $_.CommandLine -notlike '*dsh-subprocess-local*'
  }
foreach ($p in $gateways) {
  Write-Output ("stopping gateway pid " + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

$lock = Join-Path $stateDir 'openclaw.sqlite.cron-authority.lock'
if (Test-Path $lock) {
  $stale = $true
  try {
    $info = Get-Content $lock -Raw | ConvertFrom-Json
    if ($info.pid) {
      $alive = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
      if ($alive) { $stale = $false }
    }
  } catch { $stale = $true }
  if ($stale) {
    Move-Item $lock ($lock + '.stale-' + (Get-Date -Format yyyyMMddHHmmss)) -Force
    Write-Output 'removed stale cron-authority lock'
  } else {
    Write-Output 'cron-authority lock held by a live pid, left alone'
  }
}

# ① 入站丢消息补丁：幂等，官方包升级覆盖后自动重新注入。失败不阻塞网关启动，但必须吼出来。
$patcher = Join-Path $toolsDir 'apply-weixin-inbound-fix.ps1'
if (Test-Path $patcher) {
  try {
    & pwsh -NoProfile -File $patcher | ForEach-Object { Write-Output ('patch: ' + $_) }
    if ($LASTEXITCODE -ne 0) {
      Write-Output ('!!! 入站补丁失败（退出码 ' + $LASTEXITCODE + '）：官方包可能改了 monitor 结构，本次启动没有入站游标修复 !!!')
    }
  } catch {
    Write-Output ('!!! 入站补丁异常（网关照常启动，但入站修复未生效）：' + $_.Exception.Message + ' !!!')
  }
} else {
  Write-Output ('!!! 找不到入站补丁脚本：' + $patcher + ' !!!')
}

# ② 登录自启钩子：Startup 文件夹里的 OpenClaw-Gateway.cmd 也要先打补丁再起网关，
#    否则「开机自启」这条真实启动路径没有修复，升级后照样丢消息。
$startupCmd = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\OpenClaw-Gateway.cmd'
# 注意：注释一律用 ASCII。cmd 按 OEM 代码页读这个文件，中文注释会被写成「?」，
# 而且 2026-11-01 发现 hook 里少了 DSH_BRIDGE_EGRESS=cli —— 那条缺失正是
# 「重启之后推送全丢」的复发路径（网关退回进程内出口，缺 contextToken 就永远发不出去）。
$startupBody = @'
@echo off
rem Login autostart: re-inject the openclaw-weixin inbound cursor patch (idempotent),
rem then start the gateway.
rem Egress: in-process fast path (token fallback fixed 2026-11-01); drainOutbox
rem auto-falls back to the CLI path if the contextToken is still unavailable.
set DSH_BRIDGE_EGRESS=inproc
pwsh -NoProfile -WindowStyle Hidden -File "D:\src\dsh\dsh-wechat-hitl\tools\apply-weixin-inbound-fix.ps1"
start "" /min "C:\openclaw-runtime\openclaw.cmd" gateway run
'@
try {
  $current = if (Test-Path $startupCmd) { Get-Content $startupCmd -Raw } else { '' }
  # 幂等条件必须同时覆盖两件事：
  #   1) 有没有入站补丁钩子；
  #   2) 有没有 DSH_BRIDGE_EGRESS 设置（2026-11-01 补：旧的 hook 只有补丁钩子，
  #      于是这条真实启动路径一直用进程内出口 → 重启后所有推送都发不出去，
  #      而脚本只检查第 1 条，永远「跳过」，问题就被一直保留下来）。
  #      2026-11-01 晚间起固定为 inproc（快速通道），CLI 只作缺 token 时的自动兜底。
  if ($current -notmatch 'apply-weixin-inbound-fix' -or $current -notmatch 'DSH_BRIDGE_EGRESS=inproc') {
    if (Test-Path $startupCmd) {
      Copy-Item $startupCmd ($startupCmd + '.bak-' + (Get-Date -Format yyyyMMddHHmmss)) -Force
    }
    Set-Content -Path $startupCmd -Value $startupBody -Encoding ascii
    Write-Output ('登录自启已接入补丁钩子：' + $startupCmd)
  } else {
    Write-Output '登录自启已带补丁钩子，跳过'
  }
} catch {
  Write-Output ('登录自启钩子写入失败（不影响本次网关启动）：' + $_.Exception.Message)
}

$launcher = Join-Path $stateDir 'start-gateway.cmd'
$launcherBody = '@echo off' + [Environment]::NewLine +
  'set DSH_BRIDGE_EGRESS=inproc' + [Environment]::NewLine +
  '"C:\openclaw-runtime\openclaw.cmd" gateway run >> "' + $logFile + '" 2>&1' + [Environment]::NewLine
Set-Content -Path $launcher -Value $launcherBody -Encoding ascii

# 脱离 DSH 的 Windows Job：WMI 创建的进程父级是 WmiPrvSE，DSH Web 重启不会把它带走。
# （用 Start-Process 时网关活不过一次 DSH 重启，2026-10-29 实测。）
$spawn = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('cmd.exe /c "' + $launcher + '"') }
if ($spawn.ReturnValue -ne 0) {
  Write-Output ('!!! WMI 启动失败（ReturnValue=' + $spawn.ReturnValue + '），退回 Start-Process !!!')
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $launcher -WindowStyle Hidden
} else {
  Write-Output ('gateway launcher spawned detached (pid ' + $spawn.ProcessId + ')')
}
$rounds = [Math]::Ceiling($TimeoutSeconds / 5)
for ($i = 0; $i -lt $rounds; $i++) {
  Start-Sleep -Seconds 5
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:18789/' -TimeoutSec 3 -UseBasicParsing
    Write-Output ("gateway UP after ~" + (($i + 1) * 5) + "s: HTTP " + $resp.StatusCode)
    exit 0
  } catch { }
}
Write-Output ("gateway did NOT come up within " + $TimeoutSeconds + "s; see " + $logFile)
exit 1
