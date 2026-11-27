@echo off
setlocal
cd /d "%~dp0"
node scripts\activate-stable.cjs
if errorlevel 1 exit /b 1
