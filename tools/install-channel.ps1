# install-channel.ps1 — 微信 HITL 通道在新设备/重装后的一键安装（2026-11-02）。
#
# 做四件事（全部幂等，可重复执行）：
#   1) DSH 侧挂载：profiles/<name>/node_modules/dsh-wechat-hitl -> <repo>/pkg/dsh-wechat-hitl (junction)
#   2) 网关侧挂载：C:\openclaw-runtime\plugins\dsh-bridge      -> <repo>/gateway/dsh-bridge (junction)
#   3) OpenClaw 模型钉死：node tools/set-openclaw-model.mjs（写 ~/.openclaw/openclaw.json，自动备份）
#   4) 重启 OpenClaw 网关：tools/restart-gateway.ps1（写入启动器与登录自启钩子）
#
# 前置条件：
#   - 本仓库已 git pull（父仓含本子模块：git submodule update --init）
#   - C:\openclaw-runtime 已装好并完成微信登录（无则先装 OpenClaw runtime）
#   - 用户环境变量：DSHPACK_KEY_OPENCODE / DSHPACK_KEY_AIS / DSHPACK_BASE_AIS
#   - dsh-wechat-hitl 已在 cordis.patch.yml 挂载（insert: wechat-hitl）
#
# 用法：
#   pwsh -NoProfile -File tools\install-channel.ps1                      # 全部步骤
#   pwsh -NoProfile -File tools\install-channel.ps1 -SkipGatewayRestart  # 只做挂载与配置
param(
  [string[]]$ProfileNames = @('web', 'headless'),
  [switch]$SkipGatewayRestart,
  [switch]$SkipModelPin
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # tools/.. = repo root
Write-Host "[install-channel] repo root = $repo"

if (-not (Test-Path (Join-Path $repo 'lib\hitl-store.js'))) { throw "repo layout unexpected: $repo" }
function Write-Ok2([string]$msg) { Write-Host "[install-channel] OK: $msg" -ForegroundColor Green }

# 1) DSH 侧 junction
foreach ($prof in $ProfileNames) {
  $mount = Join-Path $env:USERPROFILE ".dsh\profiles\$prof\node_modules\dsh-wechat-hitl"
  $target = Join-Path $repo 'pkg\dsh-wechat-hitl'
  if (-not (Test-Path (Join-Path $env:USERPROFILE ".dsh\profiles\$prof"))) {
    Write-Warning "skip profile $prof：$env:USERPROFILE\.dsh\profiles\$prof 不存在"
    continue
  }
  $i = Get-Item $mount -Force -ErrorAction SilentlyContinue
  if ($i -and $i.LinkType -eq 'Junction') { Write-Host "[OK] $mount 已是 junction"; continue }
  if ($i) {
    $bak = "$mount.bak-" + (Get-Date -Format yyyyMMddHHmmss)
    Move-Item $mount $bak -Force
    Write-Host "旧副本已移到 $bak"
  }
  New-Item -ItemType Junction -Path $mount -Target $target | Out-Null
  Write-Ok2 $mount
}

# 2) 网关侧 junction
$runtimePlugin = 'C:\openclaw-runtime\plugins\dsh-bridge'
if (Test-Path 'C:\openclaw-runtime') {
  $target2 = Join-Path $repo 'gateway\dsh-bridge'
  $i2 = Get-Item $runtimePlugin -Force -ErrorAction SilentlyContinue
  if ($i2 -and $i2.LinkType -eq 'Junction') { Write-Host "[OK] $runtimePlugin 已是 junction" }
  else {
    if ($i2) {
      $bak2 = "$runtimePlugin.bak-" + (Get-Date -Format yyyyMMddHHmmss)
      Move-Item $runtimePlugin $bak2 -Force
      Write-Host "旧目录已移到 $bak2"
    }
    New-Item -ItemType Junction -Path $runtimePlugin -Target $target2 | Out-Null
    Write-Ok2 $runtimePlugin
  }
} else {
  Write-Warning 'C:\openclaw-runtime 不存在：先安装 OpenClaw runtime 再重跑本脚本（网关侧挂载跳过）'
}

# 3) OpenClaw 模型钉死（写 ~/.openclaw/openclaw.json，自动备份；可用 -SkipModelPin 跳过）
if (-not $SkipModelPin) {
  Write-Host '[install-channel] pin openclaw model ...'
  node (Join-Path $repo 'tools\set-openclaw-model.mjs')
}

# 4) 重启网关（加载网关插件 + 让配置生效）
if (-not $SkipGatewayRestart) {
  Write-Host '[install-channel] restart openclaw gateway ...'
  pwsh -NoProfile -File (Join-Path $repo 'tools\restart-gateway.ps1') -TimeoutSeconds 200 -Force
}

Write-Host @'
[install-channel] 完成后人工验收清单：
  1) gateway.log 出现 "agent model: opencode-go/deepseek-v4.1-flash" 与 dsh-bridge boot 行
  2) 微信发「推送状态」→ 收到带 会话码/识别码/R 编号 的回执
  3) state/hitl.log 出现 outbox-sent
  4) 重启 DSH Web 并新开会话（DSH 侧插件在模块缓存里）
'@
