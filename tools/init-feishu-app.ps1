<#
  init-feishu-app.ps1 —— 在一个**独立配置目录**里接入一个飞书应用（bot 身份），供 HITL 通道验证。

  三种接入方式（-Mode）：
    browser  默认。在当前终端前台拉起 lark-cli 的交互式 TUI，用浏览器/扫码授权一个**已有应用**
             （不需要你手抄 secret，点一次浏览器即可）。必须由你在真终端里运行，脚本无法代办。
    new      让 lark-cli 新建一个应用（--new），会打印一个 verification URL；适合拿一个全新 appId。
    secret   老路子：在本终端里粘贴 App Secret（不回显，只走子进程 stdin）。

  为什么必须独立配置目录：现有可用通道是 app2（cli_aa66f315697adc03，目录
  ~/.lark-cli-dsh-superagent-feishu2），验证新应用绝不能覆盖它。

  用法（新开一个终端）：
    pwsh -NoProfile -File D:\src\dsh\dsh-wechat-hitl\tools\init-feishu-app.ps1
    pwsh -NoProfile -File ... -Mode new
    pwsh -NoProfile -File ... -Mode secret
    pwsh -NoProfile -File ... -DryRun        # 只自检，不连网、不写配置
#>
param(
  [string]$AppId = 'cli_aa67e4041a381c02',
  [string]$ConfigDir = '',
  [ValidateSet('feishu', 'lark')][string]$Brand = 'feishu',
  [ValidateSet('browser', 'new', 'secret')][string]$Mode = 'browser',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Say([string]$t) { Write-Host $t }
function Ok([string]$t) { Write-Host "[OK]   $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "[WARN] $t" -ForegroundColor Yellow }
function Bad([string]$t) { Write-Host "[FAIL] $t" -ForegroundColor Red }

# ── 定位 lark-cli 运行器 ─────────────────────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Bad 'PATH 里找不到 node。'; exit 1 }
$runJs = 'C:/nvm4w/nodejs/node_modules/@larksuite/cli/scripts/run.js'
if (-not (Test-Path $runJs)) {
  $alt = Join-Path (Split-Path (Split-Path $node -Parent) -Parent) 'node_modules\@larksuite\cli\scripts\run.js'
  if (Test-Path $alt) { $runJs = $alt } else { Bad "找不到 lark-cli run.js：$runJs"; exit 1 }
}

# ── 独立配置目录 ────────────────────────────────────────────────────────────
if (-not $ConfigDir) { $ConfigDir = Join-Path $env:USERPROFILE ('.lark-cli-hitl-' + ($AppId -replace '^cli_', '')) }
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
$env:LARKSUITE_CLI_CONFIG_DIR = $ConfigDir
$env:NO_COLOR = '1'

Say ''
Say '=== 目标 ==='
Say ("  模式       : {0}" -f $Mode)
Say ("  appId 期望 : {0}" -f $AppId)
Say ("  brand      : {0}" -f $Brand)
Say ("  configDir  : {0}" -f $ConfigDir)
Say ("  env signal : OPENCLAW_HOME={0} HERMES_HOME={1} LARK_CHANNEL={2}" -f $env:OPENCLAW_HOME, $env:HERMES_HOME, $env:LARK_CHANNEL)
Say ''

if ($DryRun) {
  Ok 'DryRun：自检通过（未连网、未写配置）。'
  Say  ('正式运行：pwsh -NoProfile -File "{0}"' -f $PSCommandPath)
  exit 0
}

# ── 接入 ────────────────────────────────────────────────────────────────────
$exit = 0
if ($Mode -eq 'browser') {
  Say '接下来是 lark-cli 的交互界面（在当前终端里操作）：'
  Say "  1) 选「已有应用 / 从控制台导入」，不要选新建；"
Say ("  2) appId 填：{0}" -f $AppId)
  Say "  3) 它会给出验证链接或二维码：在浏览器里打开、登录飞书、确认授权；"
  Say "  4) 看到「配置成功」回到本终端即可，脚本随后自动自检。"
  Say ''
  & $node $runJs config init
  $exit = $LASTEXITCODE
}
elseif ($Mode -eq 'new') {
  Say '模式 new：将新建一个应用，屏幕上会出现 verification URL，浏览器打开完成创建。'
  & $node $runJs config init --new
  $exit = $LASTEXITCODE
}
else {
  $secure = Read-Host -AsSecureString -Prompt '粘贴 App Secret 后回车（不回显）'
  if ($secure.Length -eq 0) { Bad '没有读到内容，已取消。'; exit 1 }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
  function Invoke-Init([bool]$force) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $node
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    foreach ($a in @($runJs, 'config', 'init', '--app-id', $AppId, '--app-secret-stdin', '--brand', $Brand)) { $psi.ArgumentList.Add($a) }
    if ($force) { $psi.ArgumentList.Add('--force-init') }
    $psi.Environment['LARKSUITE_CLI_CONFIG_DIR'] = $ConfigDir
    $psi.Environment['NO_COLOR'] = '1'
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.WriteLine($secret)   # secret 只走 stdin，不进命令行
    $proc.StandardInput.Close()
    $o = $proc.StandardOutput.ReadToEnd()
    $e = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    return [pscustomobject]@{ Code = $proc.ExitCode; Out = $o; Err = $e }
  }
  Say '正在初始化（config init --app-secret-stdin）...'
  $r = Invoke-Init $false
  $secret = $null
  if ($r.Code -ne 0 -and ($r.Out + $r.Err) -match 'OPENCLAW_HOME|HERMES_HOME|config bind|force-init') {
    Warn 'Agent 上下文限制，改用 --force-init 重试（需要再贴一次 secret）。'
    $again = Read-Host -AsSecureString -Prompt '再粘贴一次 App Secret 后回车（不回显）'
    $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($again)
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2) | Out-Null
    $r = Invoke-Init $true
    $secret = $null
  }
  Say ($r.Out.Trim())
  if ($r.Err.Trim()) { Say $r.Err.Trim() }
  $exit = $r.Code
}

if ($exit -ne 0) { Bad ("接入未完成（退出码 {0}）。" -f $exit); exit $exit }

# ── 自检：确认落到了哪个 appId ──────────────────────────────────────────────
Say ''
Say '=== 已配置的应用 ==='
& $node $runJs config show 2>&1 | ForEach-Object { Say $_ }
Say ''
Say '=== bot 身份（我是谁 / 是否被策略拦） ==='
& $node $runJs api GET /open-apis/bot/v3/info 2>&1 | ForEach-Object { Say $_ }
Say ''
Say '=== 可见的群（0 条 = bot 还没被拉进任何群） ==='
& $node $runJs api GET /open-apis/im/v1/chats 2>&1 | ForEach-Object { Say $_ }
Say ''
Ok '自检完成。若 appId 不是期望值，说明 TUI 里选到了别的应用，重跑一次并选对。'
Say ('切到它只需：restart-feishu-daemon.ps1 -ConfigDir "{0}"' -f $ConfigDir)
