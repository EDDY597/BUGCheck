@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Install - BUG Check Tool

echo ============================================
echo   BUG Check Tool - First-time install
echo ============================================
echo.

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%p in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%p"
  )
)
if not defined NODE_EXE if exist "%~dp0tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if defined NODE_EXE (
  echo Found Node.js: %NODE_EXE%
  goto :do_npm
)

echo Node.js not found. Download portable LTS to tools\node ...
set "PS1=%TEMP%\bug-install-node.ps1"
> "%PS1%" echo $ErrorActionPreference = 'Stop'
>> "%PS1%" echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
>> "%PS1%" echo $root = $args[0]
>> "%PS1%" echo $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
>> "%PS1%" echo $lts = @($idx ^| Where-Object { $_.lts })[0]
>> "%PS1%" echo if (-not $lts) { throw 'cannot resolve LTS' }
>> "%PS1%" echo $v = $lts.version
>> "%PS1%" echo $zip = Join-Path $env:TEMP ('node-' + $v + '-win-x64.zip')
>> "%PS1%" echo $url = 'https://nodejs.org/dist/' + $v + '/node-' + $v + '-win-x64.zip'
>> "%PS1%" echo Write-Host ('Download ' + $url)
>> "%PS1%" echo Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 600
>> "%PS1%" echo $tools = Join-Path $root 'tools'
>> "%PS1%" echo if (Test-Path $tools) { Remove-Item $tools -Recurse -Force }
>> "%PS1%" echo New-Item -ItemType Directory -Path $tools -Force ^| Out-Null
>> "%PS1%" echo Expand-Archive -Path $zip -DestinationPath $tools -Force
>> "%PS1%" echo $src = Join-Path $tools ('node-' + $v + '-win-x64')
>> "%PS1%" echo $dst = Join-Path $tools 'node'
>> "%PS1%" echo Move-Item -Path $src -Destination $dst -Force
>> "%PS1%" echo Remove-Item $zip -Force -ErrorAction SilentlyContinue
>> "%PS1%" echo $exe = Join-Path $dst 'node.exe'
>> "%PS1%" echo if (-not (Test-Path $exe)) { throw 'node.exe missing after extract' }
>> "%PS1%" echo ^& $exe -v
>> "%PS1%" echo Write-Host 'portable node ready'

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" "%~dp0."
if errorlevel 1 (
  echo [FAIL] Could not download Node.js.
  echo Install manually from https://nodejs.org ^(LTS^), then run install.bat again.
  start "" "https://nodejs.org/"
  del "%PS1%" >nul 2>&1
  pause
  exit /b 1
)
del "%PS1%" >nul 2>&1
set "NODE_EXE=%~dp0tools\node\node.exe"

:do_npm
rem Prefer portable node/npx on PATH so child scripts (playwright) work
if exist "%~dp0tools\node" set "PATH=%~dp0tools\node;%PATH%"

echo.
echo [1/3] Installing npm dependencies (needs network)...
call npm install --no-fund --no-audit --ignore-scripts
if errorlevel 1 (
  echo [FAIL] npm install failed. Check network, then run install.bat again.
  pause
  exit /b 1
)

echo.
echo [1b/3] Downloading Playwright Chromium (needs network)...
if exist "%~dp0node_modules\playwright\cli.js" (
  call node "%~dp0node_modules\playwright\cli.js" install chromium
) else (
  call npx --no-install playwright install chromium
)
if errorlevel 1 (
  echo [FAIL] Playwright Chromium install failed.
  echo Check network/proxy, then run install.bat again.
  pause
  exit /b 1
)

echo.
echo [2/3] Register auto-start on logon (tray + server)...
set TASK_NAME=BUGCheck-Autostart
set VBS=%~dp0scripts\tray.vbs
schtasks /Create /F /TN "%TASK_NAME%" /TR "wscript.exe \"%VBS%\"" /SC ONLOGON /RL LIMITED >nul 2>&1
if %errorlevel% equ 0 (
  echo OK: tray and web service start after Windows logon.
) else (
  echo WARN: could not register auto-start.
  echo Right-click install.bat - Run as administrator, or use start.bat only.
)

echo.
echo [3/3] Done.
echo Next: double-click start.bat, open Settings, fill OpenProject
echo username and password. Then click Run Validation.
echo.
pause
