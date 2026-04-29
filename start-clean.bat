@echo off
cd /d "D:\AI应用\workbuddy files\ai-customer-service"
set NODE_ENV=production
node server/index.js 2>&1
