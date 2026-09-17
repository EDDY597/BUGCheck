# notify.ps1 — 通知 + 可点击打开结果页（UTF-8 BOM）
param(
  [string]$Title = "BUG校验工具",
  [string]$Message = "校验完成",
  [string]$OpenUrl = "http://localhost:3456"
)

function Escape-Xml([string]$s) {
  if ($null -eq $s) { return "" }
  return $s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;")
}

function Open-ResultUrl {
  try { Start-Process $OpenUrl } catch {}
}

# 1) Toast（仅作提醒；协议激活在 PowerShell 托管下不可靠，点击以托盘为准）
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  $t = Escape-Xml $Title
  $m = Escape-Xml ($Message + " — 点击托盘图标或气泡可打开结果")
  $u = Escape-Xml $OpenUrl
  $xml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>$t</text>
      <text>$m</text>
    </binding>
  </visual>
  <actions>
    <action content="查看结果" activationType="protocol" arguments="$u" />
  </actions>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification($doc)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
} catch {}

# 2) 托盘气泡：点击气泡 / 双击图标 / 右键菜单 均可打开结果页
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon("$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe")
$ni.Text = "BUG校验 — 点击打开结果"
$ni.Visible = $true

function Close-Tray {
  try { $ni.Visible = $false; $ni.Dispose() } catch {}
  [System.Windows.Forms.Application]::Exit()
}

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "打开结果页"
$openItem.Add_Click({ Open-ResultUrl; Close-Tray })
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "关闭提示"
$exitItem.Add_Click({ Close-Tray })
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add($openItem)
$menu.Items.Add($exitItem)
$ni.ContextMenuStrip = $menu

$ni.Add_DoubleClick({ Open-ResultUrl; Close-Tray })
$ni.Add_BalloonTipClicked({ Open-ResultUrl; Close-Tray })
$ni.Add_BalloonTipClosed({ })  # 气泡关掉不退出，图标仍在，可双击

[void]$ni.ShowBalloonTip(10000, $Title, ($Message + "`n点击此提示打开结果页"), [System.Windows.Forms.ToolTipIcon]::Info)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 180000  # 3 分钟无操作自动消失
$timer.Add_Tick({ Close-Tray })
$timer.Start()

[System.Windows.Forms.Application]::Run()
exit 0
