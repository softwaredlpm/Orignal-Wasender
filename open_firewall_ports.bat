@echo off
:: ============================================================
::  WASender - Windows Firewall Port Opener
::  Opens ports 5000-5010 (Default + up to 10 extra accounts)
::  Run this script as Administrator!
:: ============================================================

setlocal enabledelayedexpansion

echo.
echo  =====================================================
echo   WASender Firewall Setup
echo   Opening ports 5000 - 5010 (Inbound + Outbound)
echo  =====================================================
echo.

:: --- Check for Administrator privileges ---
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo  [ERROR] This script must be run as Administrator!
    echo.
    echo  Right-click the file and choose:
    echo  "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo  [OK] Running as Administrator.
echo.

:: --- Define port range ---
set START_PORT=5000
set END_PORT=5010
set APP_NAME=WASender

:: --- Remove old rules first (clean slate) ---
echo  Removing old WASender firewall rules (if any)...
netsh advfirewall firewall delete rule name="%APP_NAME% Inbound"  >nul 2>&1
netsh advfirewall firewall delete rule name="%APP_NAME% Outbound" >nul 2>&1

set FAIL_COUNT=0

:: --- Add Inbound rules ---
echo.
echo  Adding Inbound rules...
echo  -------------------------------------------------------

for /L %%P in (%START_PORT%,1,%END_PORT%) do (
    netsh advfirewall firewall add rule ^
        name="%APP_NAME% Inbound" ^
        dir=in ^
        action=allow ^
        protocol=TCP ^
        localport=%%P ^
        description="WASender WhatsApp Sender - Port %%P" ^
        enable=yes ^
        profile=any >nul 2>&1

    if !errorlevel! EQU 0 (
        echo  [+] Inbound  TCP %%P   OK
    ) else (
        echo  [!] Inbound  TCP %%P   FAILED
        set /a FAIL_COUNT+=1
    )
)

:: --- Add Outbound rules ---
echo.
echo  Adding Outbound rules...
echo  -------------------------------------------------------

for /L %%P in (%START_PORT%,1,%END_PORT%) do (
    netsh advfirewall firewall add rule ^
        name="%APP_NAME% Outbound" ^
        dir=out ^
        action=allow ^
        protocol=TCP ^
        localport=%%P ^
        description="WASender WhatsApp Sender - Port %%P" ^
        enable=yes ^
        profile=any >nul 2>&1

    if !errorlevel! EQU 0 (
        echo  [+] Outbound TCP %%P   OK
    ) else (
        echo  [!] Outbound TCP %%P   FAILED
        set /a FAIL_COUNT+=1
    )
)

:: --- Summary ---
echo.
echo  -------------------------------------------------------
if %FAIL_COUNT% EQU 0 (
    echo  [SUCCESS] All ports opened successfully!
) else (
    echo  [WARNING] %FAIL_COUNT% rule(s) failed. Check Windows Firewall.
)

echo.
echo  Ports opened: %START_PORT% to %END_PORT%
echo.
echo  Port Map:
echo    5000 = Default Account  (Main UI + API)
echo    5001 = Account 2
echo    5002 = Account 3
echo    5003 = Account 4
echo    5004 = Account 5
echo    5005 = Account 6
echo    5006 = Account 7
echo    5007 = Account 8
echo    5008 = Account 9
echo    5009 = Account 10
echo    5010 = Account 11
echo.
echo  To verify, run in PowerShell:
echo    netsh advfirewall firewall show rule name="WASender Inbound"
echo.
pause
endlocal
