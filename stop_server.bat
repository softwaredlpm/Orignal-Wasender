@echo off
echo Stopping WhatsApp Client on port 5000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do taskkill /PID %%a /F 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5001 ^| findstr LISTENING') do taskkill /PID %%a /F 2>nul

echo Killing orphaned WhatsApp Chrome processes...
powershell -Command "Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like '*wwebjs_auth*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Cleaning file locks...
powershell -Command "Get-ChildItem -Path '.wwebjs_auth' -Filter '*lock*' -Recurse -Force | Remove-Item -Force -ErrorAction SilentlyContinue"

echo Done.
pause
