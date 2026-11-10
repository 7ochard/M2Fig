@echo off
setlocal
if exist "%~dp0dist\desktop-v3\win-unpacked\Mg2Fig.exe" (
  start "" "%~dp0dist\desktop-v3\win-unpacked\Mg2Fig.exe"
  exit /b 0
)
if exist "%~dp0Mg2Fig.exe" (
  start "" "%~dp0Mg2Fig.exe"
  exit /b 0
)
if exist "%~dp0M2Fig.exe" (
  start "" "%~dp0M2Fig.exe"
  exit /b 0
)
echo Mg2Fig.exe is missing. Please build the desktop app first.
pause
exit /b 1
endlocal
