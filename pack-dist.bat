@echo off
cd /d "%~dp0"
if defined MIMO_PYTHON (
  "%MIMO_PYTHON%" "%~dp0scripts\pack_dist.py"
) else (
  python "%~dp0scripts\pack_dist.py"
)
pause
