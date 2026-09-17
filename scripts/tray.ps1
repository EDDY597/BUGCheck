# tray.ps1 — system tray for BUG Check Tool (UTF-8 BOM required)
param(
  [int]$Port = 3456
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$serverJs = Join-Path $root "src\validate-server.js"
$openUrl = "http://localhost:$Port"

$mutex = New-Object System.Threading.Mutex($false, "Global\BUGCheckTray")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Test-PortOpen {
  $out = & netstat -ano 2>$null | Select-String "LISTENING" | Select-String ":$Port"
  return [bool]$out
}

function Start-ServerHidden {
  if (Test-PortOpen) { return }
  if (-not (Test-Path $serverJs)) { return }
  $logDir = Join-Path $root "data"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  $outLog = Join-Path $logDir "server-start.log"
  $errLog = Join-Path $logDir "server-err.log"
  $node = $null
  $portable = Join-Path $root "tools\node\node.exe"
  if (Test-Path $portable) { $node = $portable }
  if (-not $node) {
    try { $node = (Get-Command node -ErrorAction Stop).Source } catch {}
  }
  if (-not $node) { $node = "node" }
  try {
    Start-Process -FilePath $node -ArgumentList "src\validate-server.js" `
      -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog | Out-Null
  } catch {
    try { Add-Content -Path $errLog -Value ("Start-Process failed: " + $_.Exception.Message) } catch {}
  }
  Start-Sleep -Seconds 3
}

function Stop-Server {
  $lines = & netstat -ano 2>$null | Select-String "LISTENING" | Select-String ":$Port"
  foreach ($line in $lines) {
    $parts = -split $line.ToString()
    $pidv = $parts[-1]
    if ($pidv -match '^\d+$') {
      try { Stop-Process -Id ([int]$pidv) -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

function Open-Page { try { Start-Process $openUrl } catch {} }

$iconPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$baseIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($iconPath)

$script:icon = New-Object System.Windows.Forms.NotifyIcon
$script:icon.Icon = $baseIcon
$script:icon.Visible = $true

function Update-Tray {
  if (Test-PortOpen) {
    $script:icon.Text = "BUG校验工具 - 运行中"
    $script:openItem.Enabled = $true
    $script:startItem.Enabled = $false
    $script:stopItem.Enabled = $true
  } else {
    $script:icon.Text = "BUG校验工具 - 未启动"
    $script:openItem.Enabled = $false
    $script:startItem.Enabled = $true
    $script:stopItem.Enabled = $false
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$script:openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:openItem.Text = "打开网页 (localhost:$Port)"
$script:openItem.Add_Click({ Open-Page })
$menu.Items.Add($script:openItem)

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$script:startItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:startItem.Text = "启动服务"
$script:startItem.Add_Click({ Start-ServerHidden; Update-Tray })
$menu.Items.Add($script:startItem)

$script:stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:stopItem.Text = "停止服务"
$script:stopItem.Add_Click({ Stop-Server; Update-Tray })
$menu.Items.Add($script:stopItem)

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem.Text = "重启服务"
$restartItem.Add_Click({
  Stop-Server
  Start-Sleep -Seconds 1
  Start-ServerHidden
  Update-Tray
})
$menu.Items.Add($restartItem)

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "退出托盘（保留服务）"
$exitItem.Add_Click({
  $script:icon.Visible = $false
  $script:icon.Dispose()
  $timer.Stop()
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($exitItem)

$exitAllItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitAllItem.Text = "退出托盘并停止服务"
$exitAllItem.Add_Click({
  Stop-Server
  $script:icon.Visible = $false
  $script:icon.Dispose()
  $timer.Stop()
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($exitAllItem)

$script:icon.ContextMenuStrip = $menu
$script:icon.Add_DoubleClick({ Open-Page })

Start-ServerHidden
Update-Tray

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Tray })
$timer.Start()

[System.Windows.Forms.Application]::Run()

try { $script:icon.Visible = $false; $script:icon.Dispose() } catch {}
try { $mutex.ReleaseMutex() } catch {}
$mutex.Dispose()
