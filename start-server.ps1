# AI客服系统启动脚本（带保活）
# 使用方法：右键"使用 PowerShell 运行" 或命令行：.\start-server.ps1

$port = 3456
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $scriptDir "server\index.js"

function Test-Port {
    param($port)
    try {
        $conn = Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue
        return $conn.TcpTestSucceeded
    } catch { return $false }
}

function Start-Service {
    Write-Host "正在启动 AI 客服服务..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath "node" -ArgumentList "`"$serverPath`"" -WindowStyle Hidden -PassThru
    Start-Sleep 2
    if (Test-Port $port) {
        Write-Host "✅ 服务启动成功！PID: $($proc.Id)" -ForegroundColor Green
        Write-Host "   管理后台: http://localhost:$port/admin.html" -ForegroundColor Gray
        Write-Host "   访客端:   http://localhost:$port" -ForegroundColor Gray
        return $proc
    } else {
        Write-Host "❌ 服务启动失败，请检查日志" -ForegroundColor Red
        return $null
    }
}

# 检查端口是否被占用
if (Test-Port $port) {
    $existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing) {
        Write-Host "端口 $port 已被占用 (PID: $($existing.OwningProcess))，尝试关闭..." -ForegroundColor Yellow
        Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue
        Start-Sleep 1
    }
}

# 启动服务
$process = Start-Service
if (-not $process) { exit 1 }

# 保活循环
Write-Host "`n服务监控已启动，按 Ctrl+C 停止...`n" -ForegroundColor Cyan
while ($true) {
    Start-Sleep 10
    
    # 检查进程是否存活
    $alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (-not $alive) {
        Write-Host "$(Get-Date -Format 'HH:mm:ss') 服务进程已退出，正在重启..." -ForegroundColor Yellow
        $process = Start-Service
        if (-not $process) { 
            Write-Host "重启失败，10秒后重试..." -ForegroundColor Red
            Start-Sleep 10
        }
        continue
    }
    
    # 检查端口响应
    if (-not (Test-Port $port)) {
        Write-Host "$(Get-Date -Format 'HH:mm:ss') 服务无响应，正在重启..." -ForegroundColor Yellow
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep 1
        $process = Start-Service
    }
}
