# run-tests.ps1 — 跑单测（强制隔离状态目录，避免测试消息被推到微信）
#
# 生产状态目录：<HITL>/state（requests + outbox）
# 测试状态目录：<HITL>/state-test（每次清空）
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$hitl = Split-Path -Parent $here
$testState = Join-Path $hitl 'state-test'
if (Test-Path $testState) { Remove-Item $testState -Recurse -Force }
New-Item -ItemType Directory -Force -Path $testState | Out-Null
$env:DSH_WECHAT_HITL_STATE = $testState
# 注意：不要设 DSH_WECHAT_HITL_SKIP=1 —— 它会让插件整体静默，单测就测不到推送逻辑。
# 隔离靠「状态目录指向 state-test」+「不设 DSH_WECHAT_HITL_EGRESS 走发件箱」即可。
Push-Location $hitl
try {
  # 不用 node --test：它会为每个测试文件 spawn 子进程并用管道收集输出，
  # 而在 DSH 沙箱里 spawn(stdio:'pipe') 直接 EPERM（本机 2026-10-26 实测）。
  # 逐文件用 node 直接跑，测试在本进程内执行，沙箱内外都成立。
  # 串行（不用并发）：多个文件共用同一个隔离状态目录，并发写 pending.json
  # 会让「前后对比 outbox 条数」的断言偶发失败。
  $files = @(
    'test/hitl-store.test.mjs',
    'test/plugin.test.mjs',
    'test/switch.test.mjs',
    'test/lock.test.mjs'
  )
  $code = 0
  foreach ($f in $files) {
    Write-Output ('--- ' + $f)
    # 每个文件开跑前清空隔离目录：否则前一个用例留下的 control.json / 请求表
    # 会让后一个文件的「默认 running」「积压条数」类断言偶发失败
    # （2026-10-27 实测：switch.test 单跑 15/15，全量跑却挂 2–3 条）。
    if (Test-Path $testState) { Remove-Item $testState -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $testState | Out-Null
    node $f
    if ($LASTEXITCODE -ne 0) { $code = 1 }
  }
} finally {
  Pop-Location
}
Write-Output ("tests exit=" + $code + " (state isolated at " + $testState + ")")
exit $code
