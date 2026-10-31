@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  echo Install Node.js 18+ from https://nodejs.org then run this file again.
  echo.
  pause
  exit /b 1
)
node push-to-github.js
echo.
pause
