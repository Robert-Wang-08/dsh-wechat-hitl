# apply-weixin-inbound-fix.ps1 — 修复 openclaw-weixin 入站丢消息（幂等补丁入口）
#
# 问题（2026-10-28 13:25 实测丢了一条审批回复）：
#   src/monitor/monitor.ts 先 saveGetUpdatesBuf 再 processOneMessage。处理抛异常
#   （SqliteSessionMutationConflictError: while preparing session-entry.patch）被外层 catch
#   当成「轮询失败」，按已推进的游标重拉；服务端认为消息已投递 → 该条消息永久丢失。
#
# 补丁后：
#   1) 游标在本批消息处理完成（成功，或已重试并记录丢弃）之后才推进；
#   2) 单条消息最多尝试 3 次（1 次原始 + 2 次重试），仍失败则跳过；
#   3) 跳过必留痕：日志出现 inbound-dropped（含 sessionId / seq / msgId / 错误类型）。
#
# 覆盖两个目标（缺一不可）：
#   - src/monitor/monitor.ts           源码（人工可读、未来重新 build 的源头）
#   - dist/src/monitor/monitor.js      网关真正加载的运行时产物
#     （openclaw 加载插件时优先 package.json 的 openclaw.runtimeExtensions，
#       见 openclaw/dist/bundled-dir-BeWxNo9f.mjs:78。只改 src 不会生效。）
#
# 幂等：已含 marker cursor-advanced-after-processing 的目标直接跳过。
# 升级自愈：官方包升级覆盖 dist/src 后，下次启动由 restart-gateway.ps1 调用本脚本重新注入。
#
# 用法：
#   pwsh -NoProfile -File apply-weixin-inbound-fix.ps1 -Check   # 只检查，不写
#   pwsh -NoProfile -File apply-weixin-inbound-fix.ps1          # 打补丁（写前备份）
param(
    [switch]$Check,
    [string]$ExtensionDir = "$env:USERPROFILE\.openclaw\extensions\openclaw-weixin",
    [string]$NodeExe = 'C:\openclaw-runtime\node.exe'
)

$ErrorActionPreference = 'Stop'
$patcher = Join-Path $PSScriptRoot 'weixin-inbound-patcher.mjs'

if (-not (Test-Path $patcher)) {
    Write-Host "缺少补丁核心：$patcher" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $NodeExe)) {
    Write-Host "找不到 node：$NodeExe" -ForegroundColor Red
    exit 1
}

$args = @($patcher, '--extension-dir', $ExtensionDir)
if ($Check) { $args += '--check' }

& $NodeExe @args
$code = $LASTEXITCODE

switch ($code) {
    0 {
        if ($Check) {
            Write-Host "检查通过（未写入）。" -ForegroundColor Green
        } else {
            Write-Host "补丁就绪。改完后需重启网关生效：pwsh -NoProfile -File .\restart-gateway.ps1 200" -ForegroundColor Green
        }
    }
    2 {
        Write-Host "补丁锚点与当前版本不符，未写入（或已回滚）。官方包可能改了 monitor 结构，需人工核对其 getUpdates 成功分支。" -ForegroundColor Red
    }
    default {
        Write-Host "补丁失败，退出码 $code。文件未被修改。" -ForegroundColor Red
    }
}
exit $code
