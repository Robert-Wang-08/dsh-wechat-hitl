#Requires -Version 7.0
<## Register the Feishu supervisor as a user scheduled task. This never restarts DSH services. ##>
[CmdletBinding()]
param([ValidateSet('Install','Uninstall','Verify')][string]$Action='Install', [ValidateSet('Monitor','Repair')][string]$Mode='Repair')
$runner=Join-Path $PSScriptRoot 'feishu-supervisor.ps1'
if(-not (Test-Path -LiteralPath $runner)){throw "missing runner: $runner"}
& pwsh -NoProfile -File $runner -Action $Action -Mode $Mode
exit $LASTEXITCODE
