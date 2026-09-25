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
  echo Node.js was not found, including the Codex bundled runtime.
  echo Install Node.js to run these calculation tests.
  pause
  exit /b 1
)

"%NODE_EXE%" --test tests\*.test.js
set "TEST_EXIT=%ERRORLEVEL%"
echo.
if %TEST_EXIT%==0 (echo All calculation tests passed.) else (echo Calculation tests failed with exit code %TEST_EXIT%.)
pause
exit /b %TEST_EXIT%
