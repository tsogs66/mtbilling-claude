@echo off
REM Run MT-Billing in a console window (no Windows service). Useful for debugging.
setlocal
set "ROOT=%~dp0..\.."
if not exist "%ROOT%\server\dist\index.js" set "ROOT=%~dp0.."
if not exist "%ROOT%\server\dist\index.js" (
  echo Build the app first: npm install ^&^& npm run build ^&^& npm --prefix server run build
  pause
  exit /b 1
)

if exist "%ROOT%\runtime\node.exe" (
  set "NODE=%ROOT%\runtime\node.exe"
) else (
  set "NODE=node"
)

cd /d "%ROOT%\server"
if not defined PORT set PORT=4000
if not defined SERVE_STATIC set SERVE_STATIC=1
echo Starting MT-Billing on http://127.0.0.1:%PORT%/
"%NODE%" dist\index.js
pause
