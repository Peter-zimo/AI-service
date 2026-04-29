$ErrorActionPreference = 'Stop'
$projectDir = "d:\AI应用\workbuddy files\ai-customer-service"
Set-Location -Path $projectDir
Write-Host "[启动] 工作目录: $(Get-Location)"
Write-Host "[启动] 正在启动服务器..."
node server\index.js
