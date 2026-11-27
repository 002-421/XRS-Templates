@echo off
setlocal
cd /d "%~dp0"
set "PREFLIGHT_ONLY="
if /I "%~1"=="--preflight-only" set "PREFLIGHT_ONLY=1"

echo XRS-Templates Setup Wizard
echo --------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install the LTS version from https://nodejs.org/
  if not defined PREFLIGHT_ONLY pause
  exit /b 1
)
for /f "tokens=1" %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo Node.js 24 or newer is required. The detected version is too old.
  if not defined PREFLIGHT_ONLY pause
  exit /b 1
)
where gh >nul 2>nul
if errorlevel 1 (
  echo GitHub CLI is required. Install the official CLI from https://cli.github.com/
  if not defined PREFLIGHT_ONLY pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo Git for Windows is required. Install it from https://git-scm.com/download/win
  if not defined PREFLIGHT_ONLY pause
  exit /b 1
)

if defined PREFLIGHT_ONLY goto preflight

node scripts\setup-wizard.cjs
set RESULT=%ERRORLEVEL%
if not "%RESULT%"=="0" echo Setup stopped safely. No production flag was enabled.
pause
exit /b %RESULT%

:preflight
node scripts\setup-wizard.cjs --preflight-only
exit /b
