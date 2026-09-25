@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node.exe >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node.exe"

if not defined NODE_EXE (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo Node.js was not found. Opening the app directly in your browser.
  start "" "%~dp0index.html"
  exit /b 0
)

echo Starting Lattice at http://127.0.0.1:4173
echo Leave this window open while using the app. Press Ctrl+C to stop it.
"%NODE_EXE%" server.js
