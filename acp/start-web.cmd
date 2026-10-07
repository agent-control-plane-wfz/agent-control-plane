@echo off
REM One-click launcher for the ACP web console.  Double-click this file.
REM It delegates to scripts\start-web.mjs, which resolves WORKSPACE_DIR,
REM starts the server, and opens the browser once the port is live.
setlocal
title ACP Web Console
set "HERE=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node 22 or newer, then double-click this file again.
  echo.
  pause
  exit /b 1
)

node "%HERE%scripts\start-web.mjs"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" echo [EXIT] code %EXITCODE%
echo Server stopped. Press any key to close this window.
pause >nul
exit /b %EXITCODE%
