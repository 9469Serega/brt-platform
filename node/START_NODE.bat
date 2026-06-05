@echo off
title BRT Blockchain Node
color 0A
echo.
echo  ========================================
echo   BRT Blockchain Node v1.0
echo   HTTP  : http://localhost:8545
echo   WS    : ws://localhost:8546
echo  ========================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found!
    echo Please install Python from https://python.org
    echo Make sure to check "Add to PATH" during install
    pause
    exit /b 1
)

REM Install deps silently if needed
echo [INFO] Checking dependencies...
pip install flask flask-cors websockets ecdsa base58 --quiet --exists-action i 2>nul

echo [INFO] Starting node...
echo.
python brt_node.py

pause
