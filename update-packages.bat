@echo off
REM ============================================
REM WhatsApp Client - Quick Package Updater
REM ============================================

echo.
echo ============================================
echo   WhatsApp Client - Quick Update
echo ============================================
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Change to script directory
cd /d "%~dp0"

REM Check if package.json exists
if not exist "package.json" (
    echo [ERROR] package.json not found!
    pause
    exit /b 1
)

echo [INFO] Updating packages...
echo.

echo [INFO] Forcing update of whatsapp-web.js to latest...
call npm install github:pedroslopez/whatsapp-web.js#main

call npm update

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Update failed!
    pause
    exit /b 1
)

echo.
echo [INFO] Updating launcher packages...
if exist "launcher\package.json" (
    cd launcher
    call npm update
    cd ..
)

echo.
echo [SUCCESS] All packages updated successfully!
echo.
pause

