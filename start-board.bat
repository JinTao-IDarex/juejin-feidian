@echo off
rem ============================================================
rem  juejin-boom  /  devil board launcher
rem  Double-click this file. It starts the local server in a
rem  second window and opens the board page in your browser.
rem  Close the "juejin-boom server" window to stop the server.
rem ============================================================
setlocal
cd /d "%~dp0"

echo ============================================================
echo   juejin-boom  -  devil board
echo ============================================================
echo.

if not exist "site\serve.mjs" (
  echo [X] site\serve.mjs not found.
  echo     Put this bat in the project root ^(next to package.json^).
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [X] node not found in PATH.
  echo     Install Node.js first, or hardcode the full path of node.exe.
  echo.
  pause
  exit /b 1
)

if not exist "site\.ai-config.json" (
  echo [!] site\.ai-config.json not found.
  echo     Scanning works, but AI scoring will refuse to run.
  echo     Use  board.html?mock=1  for a fake-score preview.
  echo.
)

echo [1/2] starting server on http://127.0.0.1:7100/
start "juejin-boom server" cmd /k node site\serve.mjs

echo [2/2] opening browser ...
timeout /t 2 >nul
start "" http://127.0.0.1:7100/board.html

echo.
echo   board        http://127.0.0.1:7100/board.html
echo   one track    http://127.0.0.1:7100/board.html?track=venom
echo   week range   http://127.0.0.1:7100/board.html?range=week
echo   fake scores  http://127.0.0.1:7100/board.html?mock=1
echo.
echo   card-draw page  http://127.0.0.1:7100/
echo.
echo   Server runs in the "juejin-boom server" window.
echo   Close that window to stop it.
echo.
pause
