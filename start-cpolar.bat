@echo off
chcp 65001 > nul
echo ========================================
echo   AI客服系统 - 一键启动内网穿透
echo ========================================
echo.

:: 检查客服服务是否在运行
echo [1/3] 检查客服服务状态...
curl -s http://localhost:3001/api/health > nul 2>&1
if %errorlevel% neq 0 (
    echo     [!] 客服服务未运行，正在启动...
    start "" "node" "c:/Users/Dell/WorkBuddy/20260416233822/ai-customer-service/server/index.js"
    timeout /t 3 /nobreak > nul
    echo     [OK] 客服服务已启动
) else (
    echo     [OK] 客服服务运行正常
)

:: 检查 cpolar
echo [2/3] 检查内网穿透工具...
where cpolar > nul 2>&1
if %errorlevel% neq 0 (
    echo     [!] cpolar 未找到
    echo.
    echo     请先安装 cpolar:
    echo     1. 访问 https://www.cpolar.com
    echo     2. 注册账号并获取 authtoken
    echo     3. 运行: cpolar authtoken 你的token
    echo.
    echo     或者手动运行以下命令:
    echo     %TEMP%\cpolar-cli\cpolar.exe http 3001
    echo.
    pause
    exit /b 1
)

:: 启动 cpolar
echo [3/3] 启动内网穿透...
echo.
echo     复制下面的公网地址，粘贴到小程序代码中
echo     路径: ai-customer-service/miniprogram/utils/customerServiceApi.js
echo     修改: const BASE_URL = '你的公网地址'
echo.
%TEMP%\cpolar-cli\cpolar.exe http 3001

pause
