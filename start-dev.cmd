@echo off
cd /d "%~dp0app"
start "" "node_modules\electron\dist\electron.exe" .
