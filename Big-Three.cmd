@echo off
rem Double-click to start Big Three on Windows. Installs what it needs the first time.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies. This takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo Installation failed. See the messages above.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 pause
