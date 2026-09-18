@echo off
echo Stopping any existing server instances...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000') do taskkill /PID %%a /F 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5001') do taskkill /PID %%a /F 2>nul

echo Killing orphaned WhatsApp Chrome processes...
powershell -Command "Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like '*wwebjs_auth*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Cleaning file locks...
powershell -Command "Get-ChildItem -Path '.wwebjs_auth' -Filter '*lock*' -Recurse -Force | Remove-Item -Force -ErrorAction SilentlyContinue"

timeout /t 2 /nobreak >nul
echo Starting WhatsApp Client Server...
node server.js
pause
