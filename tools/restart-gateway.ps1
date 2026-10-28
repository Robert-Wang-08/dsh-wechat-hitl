# restart-gateway.ps1 — 重启 OpenClaw 网关（含本机踩坑修补 + 启动前重新注入入站补丁）
#
# 背景（2026-10-26 / 2026-10-28 本机实测）：
#   1) 网关插件代码变更后热 reload 不生效，必须重启网关进程。
#   2) 直接 Stop-Process 杀网关会留下 openclaw.sqlite.cron-authority.lock（stale pid）；
#      下一次启动会在 gateway-run-bootstrap 阶段静默失败，日志只写 "The CLI command failed"。
#   3) openclaw-weixin 官方包升级会覆盖 dist/src 下的 monitor，入站游标补丁随之丢失。
#      因此每次启动前都跑一次幂等补丁（apply-weixin-inbound-fix.ps1），并保证登录自启也走这条路。
#
# 本脚本 = 停旧网关 + 清 stale lock + 重新注入入站补丁 + 修好登录自启钩子 + 后台重启 + 等 18789 可用。
#
# 用法：pwsh -NoProfile -File restart-gateway.ps1 [-TimeoutSeconds 180]
param(
  [int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Continue'
$stateDir = 'C:\Users\wwm_1\.openclaw\state'
$logFile = 'D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\state\gateway.log'
$toolsDir = 'D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\tools'

# 特征串用变量拼接：避免本脚本自身的命令行被误匹配后把自己杀掉
$a = 'openclaw'
$b = '.mjs'
$gateways = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
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
$startupBody = @'
@echo off
rem 登录自启：先重新注入 openclaw-weixin 入站游标补丁（幂等），再起网关。
rem 官方包升级会覆盖 dist/src 下的 monitor，所以这一步不能省。
pwsh -NoProfile -WindowStyle Hidden -File "D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\tools\apply-weixin-inbound-fix.ps1"
start "" /min "C:\openclaw-runtime\openclaw.cmd" gateway run
'@
try {
  $current = if (Test-Path $startupCmd) { Get-Content $startupCmd -Raw } else { '' }
  if ($current -notmatch 'apply-weixin-inbound-fix') {
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
$launcherBody = '@echo off' + [Environment]::NewLine + '"C:\openclaw-runtime\openclaw.cmd" gateway run > "' + $logFile + '" 2>&1' + [Environment]::NewLine
Set-Content -Path $launcher -Value $launcherBody -Encoding ascii

Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $launcher -WindowStyle Hidden
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
