@echo off
setlocal enabledelayedexpansion
title WA Sender - Quick Setup

:: Set colors
color 0B

echo.
echo  ##################################################
echo  #                                                #
echo  #             WA SENDER QUICK SETUP              #
echo  #         Premium Accounting Automation          #
echo  #                                                #
echo  ##################################################
echo.

:: Check for Node.js
echo [1/4] Checking System Requirements...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Node.js is NOT installed!
    echo Please download and install Node.js from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js detected.

:: Ensure correct directory
cd /d "%~dp0"

:: Create necessary folders
echo [2/4] Initializing Project Folders...
if not exist "uploads" (
    mkdir "uploads"
    echo [OK] Created 'uploads' directory.
) else (
    echo [OK] 'uploads' directory exists.
)

:: Install Dependencies
echo [3/4] Installing Required Packages...
echo This may take a few minutes depending on your internet speed...
echo.

call npm install --no-audit --no-fund
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] npm install failed. Please check your internet connection.
    pause
    exit /b 1
)
echo.
echo [OK] Dependencies installed successfully.

:: Finalizing
echo [4/4] Finalizing Installation...
echo.
echo ##################################################
echo #           INSTALLATION SUCCESSFUL!             #
echo ##################################################
echo.
echo What would you like to do now?
echo 1. Start WA Sender Dashboard
echo 2. Install Microsoft ACE OLEDB (64-bit) for BUSY Access DB
echo 3. Exit
echo.

set /p choice="Enter your choice (1-3): "

if "%choice%"=="1" (
    echo.
    echo Launching server...
    start cmd /k "node server.js"
    timeout /t 3 >nul
    start http://localhost:5000
    echo Dashboard launched!
)

if "%choice%"=="2" (
    call "%~dp0install-ace-oledb-64.bat"
)

echo.
echo Thank you for choosing WA Sender.
pause
exit /b 0
