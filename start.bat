@echo off
cd /d "%~dp0"

if not exist "node_modules\playwright" (
  echo Missing dependencies! Run install.bat first.
  pause
  exit /b 1
)

netstat -ano | findstr "LISTENING" | findstr ":3456" >nul 2>&1
if %errorlevel% equ 0 (
  echo Server already running.
  start "" http://localhost:3456
  exit /b 0
)

rem 1) tray (starts server + icon)
wscript //nologo "scripts\tray.vbs"

set /a _waited=0
:wait1
timeout /t 1 /nobreak >nul
set /a _waited+=1
netstat -ano | findstr "LISTENING" | findstr ":3456" >nul 2>&1
if %errorlevel% equ 0 goto :ok
if %_waited% lss 8 goto :wait1

rem 2) fallback: start server without tray (writes data\server-start.log)
echo Tray did not bring up port, starting server directly...
wscript //nologo "scripts\start.vbs"

set /a _waited=0
:wait2
timeout /t 1 /nobreak >nul
set /a _waited+=1
netstat -ano | findstr "LISTENING" | findstr ":3456" >nul 2>&1
if %errorlevel% equ 0 goto :ok
if %_waited% lss 12 goto :wait2

echo.
echo Start failed!
if exist "data\server-start.log" (
  echo --- data\server-start.log ---
  type "data\server-start.log"
)
if exist "data\server-err.log" (
  echo --- data\server-err.log ---
  type "data\server-err.log"
)
echo.
echo Manual test: node src\validate-server.js
pause
exit /b 1

:ok
echo BUG check tool started.
echo Open http://localhost:3456
start "" http://localhost:3456
exit /b 0
