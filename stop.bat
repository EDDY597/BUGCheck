@echo off
cd /d "%~dp0"
echo Stopping BUG check tool...

rem 1) stop web service on 3456
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3456"') do (
  taskkill /F /PID %%a >nul 2>&1
)

rem 2) close tray icon (powershell running tray.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*tray.ps1*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"

echo Stopped.
pause
