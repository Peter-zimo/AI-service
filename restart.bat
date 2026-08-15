@echo off
echo 正在停止旧进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3456') do taskkill /F /PID %%a >nul 2>&1
timeout /t 2 >nul

echo 启动 AI 客服系统...
cd /d "D:\AI应用\workbuddy files\ai-customer-service"
node server/index.js
pause
