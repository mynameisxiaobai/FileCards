@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\dist\electron.exe" goto NEEDINSTALL
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:NEEDINSTALL
echo Electron is not installed yet.
echo Run this once in this folder:  npm install
pause
exit /b 1
