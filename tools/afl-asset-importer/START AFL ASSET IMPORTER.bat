@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the AFL Asset Importer.
  echo Install Node.js LTS from https://nodejs.org and then double-click this file again.
  pause
  exit /b 1
)
node launcher-server.js
pause
