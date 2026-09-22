@echo off
setlocal enabledelayedexpansion
title WA Sender - Microsoft ACE OLEDB (64-bit) Setup

:: Set colors
color 0B

echo.
echo  ##################################################
echo  #                                                #
echo  #         MICROSOFT ACE OLEDB 64-BIT SETUP       #
echo  #          Access Database Engine Driver         #
echo  #                                                #
echo  ##################################################
echo.

:: Check 64-bit Architecture
if "%PROCESSOR_ARCHITECTURE%"=="x86" (
    if "%PROCESSOR_ARCHITEW6432%"=="" (
        echo [ERROR] This driver is meant for 64-bit Windows systems.
        echo Your system is detected as 32-bit.
        pause
        exit /b 1
    )
)

echo [1/3] Checking if Microsoft ACE OLEDB is already installed...
powershell -NoProfile -Command "if ((Test-Path 'HKLM:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.12.0') -or (Test-Path 'HKLM:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.16.0') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\REGISTRY\MACHINE\Software\Classes\Microsoft.ACE.OLEDB.12.0') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\REGISTRY\MACHINE\Software\Classes\Microsoft.ACE.OLEDB.16.0')) { exit 0 } else { exit 1 }"

if %ERRORLEVEL% EQU 0 (
    echo [OK] Microsoft ACE OLEDB 64-bit is ALREADY installed on this machine!
    echo BUSY Access (.mdb) connections are ready to use.
    echo.
    echo Would you like to reinstall or repair anyway?
    echo 1. Reinstall / Repair Driver
    echo 2. Exit
    echo.
    set /p repchoice="Enter your choice (1-2): "
    if "!repchoice!" NEQ "1" (
        exit /b 0
    )
) else (
    echo [INFO] Microsoft ACE OLEDB driver is NOT detected on this machine.
)

echo.
echo [2/3] Preparing Microsoft Access Database Engine 64-bit...
echo.
echo How would you like to obtain the driver?
echo 1. Automatic Download & Silent Install (Recommended)
echo 2. Open Official Microsoft Download Page in Browser
echo 3. Exit
echo.
set /p dchoice="Enter your choice (1-3): "

if "%dchoice%"=="1" (
    echo.
    echo [INFO] Downloading AccessDatabaseEngine_X64.exe from Microsoft...
    echo Please wait, this may take a moment...
    
    set "INSTALLER_FILE=%TEMP%\accessdatabaseengine_X64.exe"
    
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri 'https://download.microsoft.com/download/2/4/3/24375514-16C3-4E4A-9813-11FB89FE1F9F/AccessDatabaseEngine_X64.exe' -OutFile '%INSTALLER_FILE%' -UseBasicParsing; exit 0 } catch { exit 1 }"
    
    if not exist "%INSTALLER_FILE%" (
        echo [WARNING] Direct download failed. Opening official Microsoft download center...
        start https://www.microsoft.com/en-us/download/details.aspx?id=54920
        pause
        exit /b 0
    )
    
    echo [3/3] Installing Microsoft Access Database Engine (64-bit)...
    echo Running installer with /passive flag...
    start /wait "" "%INSTALLER_FILE%" /passive
    
    echo.
    echo [OK] Installation process completed!
    echo Verifying installation...
    
    powershell -NoProfile -Command "if ((Test-Path 'HKLM:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.12.0') -or (Test-Path 'HKLM:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.16.0')) { exit 0 } else { exit 1 }"
    if %ERRORLEVEL% EQU 0 (
        echo [SUCCESS] Microsoft ACE OLEDB Provider is successfully registered!
    ) else (
        echo [NOTE] Driver installed. If you have 32-bit Office installed, please restart your PC to complete registration.
    )
)

if "%dchoice%"=="2" (
    echo.
    echo [INFO] Opening Microsoft Download Center in your default browser...
    start https://www.microsoft.com/en-us/download/details.aspx?id=54920
    echo.
    echo Please download and run 'accessdatabaseengine_X64.exe'.
)

echo.
pause
exit /b 0
