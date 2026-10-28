# 在 DSH 沙箱外执行：提交 focus-hub 文档批次 + ncbs/ca 变更
#
# 为什么需要你在外面跑：DSH 文件沙箱只允许写工作区，
#   git 在 D:\src 下建 .git/index.lock 会被拒（Permission denied），推送还会弹凭证交互。
#
# 用法：pwsh -NoProfile -File commit-src-repos.ps1 [-SkipPush]
# 幂等：已是干净状态的步骤会跳过；不 force push，不改写历史。

param([switch]$SkipPush)

$ErrorActionPreference = 'Continue'

function Show([string]$msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }

# ─────────────────────────── 1. focus-hub：先提交文档批次，再推送 ────────────────
$fh = 'D:\src\dsh\focus-hub'

Show 'focus-hub 当前状态'
& git -C $fh status --short | Select-Object -First 60
"ahead: " + (& git -C $fh rev-list --count 'origin/main..HEAD')

Show 'focus-hub 提交文档批次（不含 mvp/data、.bak、.ptc）'
$fhPaths = @(
  'docs/integration-prompts'
  'docs/session-log/2026/10/SESSION-20261027-1550-focus-hub-controlled-scan.md'
  'docs/superpowers/reports/2026-10-27-fh-controlled-scan-report.md'
  'docs/superpowers/reports/2026-10-27-fh-e2-acceptance-verify.json'
  'docs/superpowers/reports/2026-10-27-fh-s0-proxy-report.md'
  'docs/superpowers/specs/2026-10-27-beads-alternatives-comparison.md'
  'docs/superpowers/specs/2026-10-27-beads-ws-fh-verification.md'
  'docs/superpowers/specs/2026-10-27-focus-hub-capability-inventory-v3.md'
  'docs/superpowers/specs/2026-10-27-focus-hub-id-map.draft.json'
  'docs/superpowers/specs/2026-10-27-focus-hub-id-map.v1.json'
  'docs/superpowers/specs/2026-10-27-focus-hub-id-map.v2.json'
  'docs/superpowers/specs/2026-10-27-focus-hub-unified-master-design-v3.md'
  'docs/superpowers/specs/2026-10-27-focus-hub-v3-precontracts.md'
)
foreach ($p in $fhPaths) { & git -C $fh add -- $p }
& git -C $fh add -- mvp/test/analysis-chain.test.mjs start-8770.cmd mvp/railway-progress.html

if ((& git -C $fh diff --cached --name-only | Measure-Object).Count -gt 0) {
  & git -C $fh commit -m "docs(fh06): add v3 master design, capability inventory and 10-27 scan evidence"
  "commit exit=$LASTEXITCODE"
} else {
  "nothing staged, skip commit"
}

if (-not $SkipPush) {
  Show 'focus-hub 推送（会要求 GitHub 凭证）'
  & git -C $fh push origin main
  "push exit=$LASTEXITCODE"
  "still ahead: " + (& git -C $fh rev-list --count 'origin/main..HEAD')
}

# ─────────────────────────── 2. ncbs/ca：按目录分批提交 ────────────────────────
$ca = 'D:\src\ncbs\ca'

Show 'ncbs/ca 当前状态'
& git -C $ca status --short | Select-Object -First 20
"total changed: " + ((& git -C $ca status --porcelain | Measure-Object).Count)

$batches = @(
  @{ dir = 'docs/work-control'; msg = 'docs(work-control): sync run records and control entries' }
  @{ dir = 'docs/需求文档';    msg = 'docs(requirements): sync SRS product entry, defects and RTM' }
  @{ dir = 'docs/governance';  msg = 'docs(governance): sync data-standard registry and errorfix log' }
  @{ dir = 'docs/治理';        msg = 'docs(governance): sync data-standard governance entrance' }
  @{ dir = 'docs/migration-design'; msg = 'docs(migration): sync answer and common-element registries' }
)

foreach ($b in $batches) {
  $dir = $b.dir
  $existing = Join-Path $ca $dir
  if (-not (Test-Path $existing)) { "skip (missing): $dir"; continue }
  & git -C $ca add -A -- $dir
  if ((& git -C $ca diff --cached --name-only | Measure-Object).Count -gt 0) {
    & git -C $ca commit -m $b.msg
    "committed: $dir (exit=$LASTEXITCODE)"
  } else {
    "nothing to commit: $dir"
  }
}

Show 'ncbs/ca 剩余（应为空）'
& git -C $ca status --short | Select-Object -First 20

# ─────────────────────────── 3. 收尾 ──────────────────────────────────────────
Show '汇总'
"focus-hub ahead of origin: " + (& git -C $fh rev-list --count 'origin/main..HEAD')
"ncbs/ca branch: " + (& git -C $ca rev-parse --abbrev-ref HEAD) + "  dirty: " + ((& git -C $ca status --porcelain | Measure-Object).Count)
