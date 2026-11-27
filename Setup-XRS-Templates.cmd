@echo off
setlocal
cd /d "%~dp0"

echo XRS-Templates Setup Wizard
echo --------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install the LTS version from https://nodejs.org/
  pause
  exit /b 1
)
for /f "tokens=1" %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo Node.js 24 or newer is required. The detected version is too old.
  pause
  exit /b 1
)
where gh >nul 2>nul
if errorlevel 1 (
  echo GitHub CLI is required. Install the official CLI from https://cli.github.com/
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo Git for Windows is required. Install it from https://git-scm.com/download/win
  pause
  exit /b 1
)

node scripts\setup-wizard.cjs
set RESULT=%ERRORLEVEL%
if not "%RESULT%"=="0" echo Setup stopped safely. No production flag was enabled.
pause
exit /b %RESULT%
