@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/
  exit /b 1
)
node scripts\setup-simple-publisher.cjs %*
exit /b %ERRORLEVEL%
