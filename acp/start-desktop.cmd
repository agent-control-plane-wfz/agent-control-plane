@echo off
REM One-click desktop launcher for Control Plane: opens it as a chromeless app window
REM (no tabs, no address bar, its own taskbar entry). The server keeps running in the
REM background; stop it with stop-desktop.cmd.
setlocal
title Control Plane
set "HERE=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node 22 or newer, then double-click this file again.
  echo.
  pause
  exit /b 1
)

node "%HERE%scripts\start-web.mjs" --desktop
if errorlevel 1 (
  echo.
  echo [EXIT] code %ERRORLEVEL%
  pause >nul
)
exit /b %ERRORLEVEL%
