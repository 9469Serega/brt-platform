@echo off
echo ================================================
echo  BRT Node - Build Script
echo ================================================
echo.
echo [1/3] Installing dependencies...
pip install flask flask-cors websockets ecdsa base58 pyinstaller --quiet
echo.
echo [2/3] Building exe (this takes 1-2 minutes)...
pyinstaller brt_node.spec --clean --noconfirm
echo.
echo [3/3] Done!
echo Output: dist\brt_node.exe
echo.
echo To run: double-click dist\brt_node.exe
echo Or drag it anywhere on your PC and run from there.
echo.
pause
