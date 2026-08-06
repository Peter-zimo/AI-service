@echo off
rem ============================================
rem  AI Customer Service System - One-click start
rem  Double-click to start all services.
rem  Double-click start-stop.bat to stop.
rem ============================================
title AI Customer Service - Start
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  Starting AI Customer Service System...
echo  Do NOT close this window. Closing it will stop services.
echo.

node start.js start

echo.
echo  Press any key to close this window...
pause >nul
