@echo off
rem ============================================
rem  AI Customer Service System - Stop all
rem ============================================
title AI Customer Service - Stop
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  Stopping all services...
echo.

node start.js stop

echo.
echo  Press any key to close this window...
pause >nul
