@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node.exe >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node.exe"

if not defined NODE_EXE (
  echo Node.js was not found. Install Node.js 20 or newer to run the tests.
  pause
  exit /b 1
)

"%NODE_EXE%" --test tests\*.test.js
set "TEST_EXIT=%ERRORLEVEL%"
echo.
if %TEST_EXIT%==0 (echo All calculation tests passed.) else (echo Calculation tests failed with exit code %TEST_EXIT%.)
pause
exit /b %TEST_EXIT%
