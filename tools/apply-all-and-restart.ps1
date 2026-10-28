# apply-all-and-restart.ps1 — 一条命令完成两件事并重启网关（给需要人工提权时用）
#
# 为什么需要它：DSH 沙箱只允许写 D:\nutstore\1.logseq，而这两处修复必须写工作区之外：
#   - C:\Users\<你>\.openclaw\extensions\openclaw-weixin\...   入站游标补丁
#   - C:\openclaw-runtime\plugins\dsh-bridge\index.js          出站进程内发送
# 在普通 PowerShell（非 DSH 沙箱）里跑本脚本，两步都能落地。
#
# 用法：pwsh -NoProfile -File apply-all-and-restart.ps1 [-Check]
param(
  [switch]$Check,
  [int]$TimeoutSeconds = 200
)
$ErrorActionPreference = 'Continue'
$toolsDir = $PSScriptRoot
$node = 'C:\openclaw-runtime\node.exe'

Write-Host '── 1/3 入站游标补丁（openclaw-weixin monitor）──' -ForegroundColor Cyan
if ($Check) {
  & pwsh -NoProfile -File (Join-Path $toolsDir 'apply-weixin-inbound-fix.ps1') -Check
} else {
  & pwsh -NoProfile -File (Join-Path $toolsDir 'apply-weixin-inbound-fix.ps1')
}
$inboundCode = $LASTEXITCODE

Write-Host '── 2/3 出站进程内补丁（dsh-bridge + hitl-store）──' -ForegroundColor Cyan
if ($Check) {
  & $node (Join-Path $toolsDir 'apply-outbound-inproc.mjs') --check
} else {
  & $node (Join-Path $toolsDir 'apply-outbound-inproc.mjs')
}
$egressCode = $LASTEXITCODE

if ($Check) {
  Write-Host ("检查完成：inbound=" + $inboundCode + " egress=" + $egressCode) -ForegroundColor Cyan
  exit ([Math]::Max($inboundCode, $egressCode))
}

Write-Host '── 3/3 重启网关（会重跑入站补丁并修好登录自启钩子）──' -ForegroundColor Cyan
& pwsh -NoProfile -File (Join-Path $toolsDir 'restart-gateway.ps1') -TimeoutSeconds $TimeoutSeconds
$restartCode = $LASTEXITCODE

Write-Host ("结果：inbound=" + $inboundCode + " egress=" + $egressCode + " restart=" + $restartCode) -ForegroundColor Cyan
exit ([Math]::Max([Math]::Max($inboundCode, $egressCode), $restartCode))
