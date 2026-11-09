@echo off
setlocal
if not exist "%~dp0M2Fig.exe" (
  echo M2Fig.exe is missing. Please build the desktop app first.
  pause
  exit /b 1
)
start "" "%~dp0M2Fig.exe"
endlocal
