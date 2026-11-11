@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setupM2FigRuntime.ps1"
if errorlevel 1 (
  echo Mg2Fig setup failed. Read the message above before retrying.
  pause
  exit /b 1
)
echo Mg2Fig V3 is ready. Open Mg2Fig.exe to continue.
pause
endlocal
