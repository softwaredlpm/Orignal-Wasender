@echo off
setlocal enabledelayedexpansion
title WA Sender - EXE Builder

:: Set colors
color 0E

echo.
echo  ##################################################
echo  #                                                #
echo  #             WA SENDER EXE BUILDER              #
echo  #         Packaging Node.js to Windows           #
echo  #                                                #
echo  ##################################################
echo.

:: Ensure correct directory using pushd for UNC support
echo [DEBUG] Script Location: %~dp0
pushd "%~dp0"
echo [INFO] Current Directory: %CD%

:: Check if package.json exists here
if not exist "package.json" (
    echo [ERROR] package.json NOT found in %CD%
    echo Please ensure this script is in the whatsapp_api folder.
    pause
    exit /b 1
)

:: Check for Node.js
echo [1/5] Checking Environment...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found.
    pause
    popd
    exit /b 1
)

:: Check if pkg is installed
where pkg >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Installing 'pkg' packaging tool globally...
    call npm install -g pkg
)
echo [OK] Packaging tools ready.

:: Close active instances to avoid "Access Denied"
echo [INFO] Ensuring no active instances are running...
taskkill /F /IM WASender.exe >nul 2>&1

:: Clean dist folder
echo [2/5] Cleaning distribution folder...
if exist "dist" (
    echo [INFO] Removing old 'dist' folder...
    rmdir /s /q "dist"
    if %ERRORLEVEL% NEQ 0 (
        echo [WARNING] Could not remove 'dist'. A file might be open or in use.
        echo Attempting to proceed anyway...
    )
)
if not exist "dist" mkdir "dist"
echo [OK] Dist folder prepared.

:: Build EXE
echo [3/5] Compiling Executable...
echo [NOTE] You may see some 'Warnings' about Puppeteer/Chromium. 
echo        THIS IS NORMAL. Please wait for the Success message...
echo.
echo Compiling...
:: Force node18 target to avoid 'node25' or version mismatch errors
call pkg . --targets node18-win-x64 --output dist/WASender.exe
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Compilation failed. 
    echo Check for syntax errors in package.json or missing files.
    pause
    popd
    exit /b 1
)
echo [OK] EXE compiled successfully.

:: Copy external assets
echo [4/5] Bundling external assets...
if exist "busy_config.json" (
    copy "busy_config.json" "dist\busy_config.json"
) else (
    echo { "firms": [] } > "dist\busy_config.json"
)

if exist "busy_db_bridge.ps1" (
    copy "busy_db_bridge.ps1" "dist\busy_db_bridge.ps1"
)

if not exist "dist\uploads" (
    mkdir "dist\uploads"
)

:: Copy logo for safety
if exist "public\logo.png" (
    copy "public\logo.png" "dist\logo.png"
)

if exist "public\RunBackground.vbs" (
    copy "public\RunBackground.vbs" "dist\Run - Silent (Background).vbs"
)

if exist "public\Stop - WASender.bat" (
    copy "public\Stop - WASender.bat" "dist\Stop - WASender.bat"
)

if exist "public\Open Dashboard.url" (
    copy "public\Open Dashboard.url" "dist\Open Dashboard.url"
)

echo [OK] Assets bundled.

:: Finalizing
echo [5/5] Finalizing...
echo.
echo ##################################################
echo #           BUILD COMPLETED SUCCESSFULLY!        #
echo ##################################################
echo.
echo Your application is ready in the 'dist' folder.
echo.
pause
popd
exit /b 0
