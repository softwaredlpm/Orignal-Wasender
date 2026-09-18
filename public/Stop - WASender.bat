@echo off
echo Stopping WA Sender...
taskkill /F /IM WASender.exe /T
echo.
echo Application stopped.
timeout /t 3
