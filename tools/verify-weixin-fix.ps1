# verify-weixin-fix.ps1 — 只读验收：入站补丁是否生效 + 出站是否进程内
#
# 用法：pwsh -NoProfile -File verify-weixin-fix.ps1
# 前置：先跑 restart-gateway.ps1（网关必须在补丁之后启动过），并发一条微信消息。
param(
  [string]$WeixinLog = "$env:TEMP\openclaw\openclaw-$(Get-Date -Format 'yyyy-MM-dd').log"
)
$state = 'D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\state'
$dbg   = 'C:\Users\wwm_1\.openclaw\state\dsh-bridge-debug.log'
$ext   = 'C:\Users\wwm_1\.openclaw\extensions\openclaw-weixin'
$ok = 0; $bad = 0
function Pass($m) { Write-Host ("  [PASS] " + $m) -ForegroundColor Green; $script:ok++ }
function Fail($m) { Write-Host ("  [FAIL] " + $m) -ForegroundColor Red; $script:bad++ }
function Info($m) { Write-Host ("  [info] " + $m) -ForegroundColor Gray }
function Head($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

Head "== 1) 补丁文件 =="
foreach ($f in @("$ext\src\monitor\monitor.ts", "$ext\dist\src\monitor\monitor.js")) {
  if (-not (Test-Path $f)) { Fail "缺文件 $f"; continue }
  $m = (Select-String -Path $f -Pattern 'cursor-advanced-after-processing' -SimpleMatch).Count
  $d = (Select-String -Path $f -Pattern 'inbound-dropped' -SimpleMatch).Count
  & 'C:\openclaw-runtime\node.exe' --check $f 2>$null
  if ($m -ge 1 -and $d -ge 1 -and $LASTEXITCODE -eq 0) { Pass ("$(Split-Path $f -Leaf): marker=$m inbound-dropped=$d node-check=0") }
  else { Fail ("$(Split-Path $f -Leaf): marker=$m inbound-dropped=$d node-check=$LASTEXITCODE") }
}
$store = 'D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\lib\hitl-store.js'
$s = (Select-String -Path $store -Pattern 'inproc-egress-v2' -SimpleMatch).Count
if ($s -ge 1) { Pass "hitl-store.js 含进程内出站实现（inproc-egress-v2）" } else { Fail "hitl-store.js 未含进程内出站实现" }

Head "== 2) 网关是否已加载补丁（进程启动时间 vs 文件时间）=="
$listen = netstat -ano | Select-String ':18789\s+.*LISTENING' | Select-Object -First 1
if (-not $listen) { Fail "18789 没有监听（网关没起）" }
else {
  $gwpid = ($listen.Line -split '\s+')[-1]
  Info ("监听 pid = " + $gwpid)
  $proc = Get-Process -Id $gwpid -ErrorAction SilentlyContinue
  $fileTime = (Get-Item "$ext\dist\src\monitor\monitor.js").LastWriteTime
  if ($proc) {
    Info ("网关启动时间 = " + $proc.StartTime + " / 补丁文件时间 = " + $fileTime)
    if ($proc.StartTime -gt $fileTime) { Pass "网关启动晚于补丁写入 → 已加载补丁代码" }
    else { Fail "网关启动早于补丁写入 → 仍在跑旧代码，需要重启" }
  } else { Info "取不到该 pid 的进程信息（沙箱限制），改为看日志" }
}

Head "== 3) 入站：真实消息是否被处理或明确丢弃 =="
$gl = Join-Path $state 'gateway.log'
if (Test-Path $gl) {
  $tail = Get-Content $gl -Tail 400
  $processed = ($tail | Select-String 'inbound: from=|inbound message: from=').Count
  $dropped = ($tail | Select-String 'inbound-dropped').Count
  Info ("最近 400 行：inbound 处理记录 $processed 条，inbound-dropped $dropped 条")
  if ($dropped -gt 0) { Pass "有 inbound-dropped 留痕（不是静默丢失）" }
  elseif ($processed -gt 0) { Pass "有 inbound 处理记录" }
  else { Info "最近没有入站活动，发一条微信消息再看" }
  $mon = $tail | Select-String 'weixin monitor started' | Select-Object -Last 1
  if ($mon) { Info ("最近一次 monitor 启动：" + $mon.Line) }
} else { Fail "缺 $gl" }

Head "== 4) 出站：进程内 or 回退 CLI =="
$hl = Join-Path $state 'hitl.log'
if (Test-Path $hl) {
  $last = Get-Content $hl -Tail 800 | Select-String 'inproc-egress|outbox-egress|inproc-sent|inproc-error'
  if ($last) {
    foreach ($l in ($last | Select-Object -Last 6)) { Info ($l.Line.Substring(0, [Math]::Min(200, $l.Line.Length))) }
    if ($last | Select-String '"state":"ready"') { Pass "进程内出站模块加载成功（state=ready）" }
    if ($last | Select-String '"state":"unavailable"') { Fail "进程内模块加载失败（state=unavailable）→ 已退回 CLI，见 error 字段" }
    if ($last | Select-String 'outbox-egress.*"mode":"inproc"') { Pass "实际出口 = inproc" }
    if ($last | Select-String 'inproc-sent') { Pass "已有进程内发送成功记录（inproc-sent）" }
  } else { Info "hitl.log 里还没有出口记录，触发一次推送再看" }
} else { Fail "缺 $hl" }
if (Test-Path $dbg) {
  $d2 = Get-Content $dbg -Tail 200 | Select-String 'egress|inproc'
  if ($d2) { Info ("dsh-bridge 调试日志：" + ($d2 | Select-Object -Last 1).Line) }
}

Head "== 汇总 =="
Write-Host ("  通过 " + $ok + " 项，失败 " + $bad + " 项")
if ($bad -gt 0) { exit 1 } else { exit 0 }
