@echo off
cd /d "%~dp0"
echo 正在停止旧服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3456 ^| findstr LISTENING') do (
    echo 杀死进程 %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul
echo 正在启动服务...
start "AI客服服务" node server\index.js
timeout /t 2 /nobreak >nul
echo 服务已启动，请访问 http://localhost:3456
