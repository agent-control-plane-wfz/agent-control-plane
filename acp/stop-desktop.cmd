@echo off
REM Stops the background server that start-desktop.cmd leaves running.
powershell -NoProfile -Command "try { Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction Stop | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop }; Write-Host 'Control Plane stopped.' } catch { Write-Host 'Control Plane is not running (nothing is listening on 7777).' }"
pause >nul
