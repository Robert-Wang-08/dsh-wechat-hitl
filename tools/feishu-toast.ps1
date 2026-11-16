#Requires -Version 5.1
<#
  Windows 桌面 toast 通知（Windows PowerShell 5.1 专用）。
  PowerShell 7 在本机加载不了 Windows.UI.Notifications 的 WinRT 类型，5.1 可以；
  监督器在 PS7 失败时用 powershell.exe 调用本脚本。
  注意：WinRT 类型只能用类型字面量拿到，New-Object 按名字解析会失败，故用 Activator。
  退出码：0 = 已提交系统；1 = 失败。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message
)
$ErrorActionPreference = 'Stop'
try {
  $xmlType = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $toastType = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $manager = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $xml = [Activator]::CreateInstance($xmlType)
  $safeTitle = [System.Security.SecurityElement]::Escape($Title)
  $safeMessage = [System.Security.SecurityElement]::Escape($Message)
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text><text>' + $safeMessage + '</text></binding></visual></toast>')
  $toastObj = [Activator]::CreateInstance($toastType, @($xml))
  $manager::CreateToastNotifier('DSH.FeishuSupervisor').Show($toastObj)
  Write-Output 'submitted'
  exit 0
} catch {
  Write-Output ('failed: ' + $_.Exception.Message)
  exit 1
}