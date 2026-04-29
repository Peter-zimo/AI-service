# AI智能客服系统 — 完整部署操作手册

> 从零到上线，跟着做就行。预计耗时：**30分钟（不含备案）**

---

## 目录

1. [🚀 快速部署（免服务器）](#1-快速部署免服务器) ← **推荐先看这个**
2. [服务器选购](#2-服务器选购)
3. [域名与备案](#3-域名与备案)
4. [服务器基础配置](#4-服务器基础配置)
5. [部署应用](#5-部署应用)
6. [Nginx 反向代理 + HTTPS](#6-nginx-反向代理--https)
7. [安全加固](#7-安全加固)
8. [日常运维命令](#8-日常运维命令)
9. [常见问题排查](#9-常见问题排查)

---

## 1. 快速部署（免服务器）

适合：**不想买服务器 / 临时演示 / 面试 Demo**

### 方案 A：Railway（推荐，5分钟）

Railway 提供免费额度，支持 Node.js，永久有 HTTPS 地址。

**步骤：**

```
1. 注册 Railway：https://railway.app（用 GitHub 登录）

2. 创建 GitHub 仓库，上传代码：
   git init
   git add .
   git commit -m "Initial"
   git remote add origin https://github.com/你的用户名/ai-customer-service.git
   git push -u origin main

3. 在 Railway 创建项目：
   - Dashboard → New Project → Deploy from GitHub repo
   - 选择 ai-customer-service 仓库

4. 配置环境变量（Railway → Variables）：
   DEEPSEEK_API_KEY=你的API密钥
   BASIC_AUTH=admin:你想要的密码

5. 部署完成，自动获得 HTTPS 地址
```

**免费额度：** 500小时/月（单实例足够用）

---

### 方案 B：Render（永久免费）

```
1. 注册：https://render.com

2. 创建 Web Service：
   - Connect GitHub repo
   - Build Command: npm install
   - Start Command: npm start

3. 配置环境变量（同上）

4. 部署完成
```

---

### 方案 C：内网穿透（最简单，立即可用）

适合本地已运行服务，想要临时公网地址。

```bash
# 1. 下载 ngrok：https://ngrok.com/download

# 2. 启动服务
npm start

# 3. 新开终端运行 ngrok
ngrok http 3456

# 4. 获得公网地址，复制发给面试官
```

⚠️ 免费版限制：3-4个并发连接，每次重启IP会变

---

### 部署方式对比

| 方案 | 难度 | 稳定性 | 域名 | 费用 | 推荐场景 |
|------|------|--------|------|------|----------|
| Railway | ⭐ | ⭐⭐⭐ | 自动分配 | 免费500h/月 | **面试Demo首选** |
| Render | ⭐⭐ | ⭐⭐⭐ | 自动分配 | 免费 | 长期展示 |
| ngrok | ⭐ | ⭐⭐ | 每次变 | 免费/付费 | 临时测试 |
| 自建服务器 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 可自定义 | ¥50+/月 | 生产环境 |

---

## 2. 服务器选购

### 推荐方案：腾讯云/阿里云轻量应用服务器

| 配置 | 价格 | 说明 |
|------|------|------|
| **2核2G + 50G SSD** | ~¥50-70/月 | 最小可用配置 |
| **2核4G + 60G SSD** | ~¥80-120/月（推荐） | 稳定运行，推荐选这个 |
| **4核8G + 100G SSD** | ~¥200+/月 | 高并发或同时跑其他服务 |

### 购买要点

```
操作系统：选择 Ubuntu 22.04 LTS 或 Debian 12
区域：   选择离目标用户近的节点（国内用户选广州/上海/北京）
带宽：   4Mbps 够用，5-10Mbps 更流畅
不要买 Windows Server！Linux 部署更简单且省资源
```

> **新用户优惠**：腾讯云/阿里云新用户首年有大幅折扣，搜索「轻量应用服务器 新人」能找到 ¥50 左右的套餐。

### 备选：跳过备案（急用）

如果不想等备案，可以：
- **腾讯云香港轻量** — 国内访问稍慢但免备案
- **阿里云新加坡/香港节点** — 同上

⚠️ 注意：后续还是要备案，否则国内访问速度不稳定。

---

## 3. 域名与备案

### 2.1 买个域名

```
推荐平台：腾讯云 / 阿里云 / Cloudflare / Namecheap
价格：    .com 约 ¥55/年，.cn 约 ¥29/年

命名建议：
- 简短好记：aikefu.com、zhipukefu.com
- 带品牌感：xxx-service.com、xxx-bot.com
```

### 2.2 DNS 解析（购买后）

在域名控制台添加 A 记录：

| 记录类型 | 主机记录 | 记录值 |
|---------|---------|--------|
| A | @ | 你的服务器IP |
| A | www | 你的服务器IP |

### 2.3 ICP 备案（必须）

```
所需材料：
□ 身份证正面照片
□ 身份证反面照片
□ 手持身份证半身照
□ 网站负责人信息核验单（网站自动生成）
□ 幕布照片（背景有域名信息）

流程：
1. 登录云服务商的备案系统
2. 填写主体信息（个人/企业）
3. 填写网站信息
4. 提交管局审核（约 7-20 个工作日）
5. 通过后收到备案号

时间线：提交后一般 1-2 周出结果
提示：可以先部署到服务器上用 IP 访问，备案期间不影响使用
```

---

## 4. 服务器基础配置

### 3.1 SSH 连接服务器

```bash
# Windows 用 PowerShell 或终端工具（如 Termius/XShell）
ssh root@你的服务器IP

# 首次登录会要求修改密码
```

> **建议**：装个 Termius（免费），比直接 PowerShell 好用很多。

### 3.2 基础环境安装

```bash
# 一键安装所有依赖（复制粘贴执行即可）
apt update && apt upgrade -y

# 安装 Docker（最简单的官方脚本方式）
curl -fsSL https://get.docker.com | sh

# 安装 Git（用于拉代码）
apt install -y git

# 让当前用户能用 docker（不用 sudo）
usermod -aG docker $USER
# 执行完后需要重新登录一次 SSH 生效
```

### 3.3 安全基础设置

```bash
# 修改 SSH 端口（防暴力扫描）— 改成你喜欢的端口，比如 2222
sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config

# 禁止 root 密码登录（后续只能用密钥）
# sed -i 's/#PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

# 重启 SSH 服务
systemctl restart sshd

# 配置防火墙（只开放必要端口）
ufw allow 22/tcp      # SSH（如果改了端口就改成新端口）
ufw allow 80/tcp      # HTTP
ufw allow 443/tcp     # HTTPS
ufw allow 3456/tcp    # 应用端口（可选，如果不走 Nginx）
ufw enable            # 启用防火墙

echo "✅ 基础环境配置完成"
```

---

## 5. 部署应用

### 方案A：Git 拉代码 + Docker Compose（推荐 ✅）

```bash
# 进入你的家目录
cd ~

# 克隆代码（替换为你的仓库地址）
git clone https://github.com/你的用户名/ai-customer-service.git
cd ai-customer-service

# 创建实际的环境变量文件
cp .env.example .env

# 编辑 .env 文件，修改密码！
nano .env
# 把 AUTH_PASSWORD=你的强密码  改成一个复杂的密码
# 保存退出：Ctrl+O → Enter → Ctrl+X

# 一键启动！
docker compose up -d --build

# 查看是否启动成功
docker compose ps
docker compose logs -f --tail=20
```

启动成功后，浏览器访问 `http://你的服务器IP:3456` 应该能看到客服界面。

### 方案B：直接上传代码文件（没有 Git 仓库时用）

```bash
# 在本地电脑上，把项目打包
cd D:\AI应用\workbuddy files\ai-customer-service
# 排除 node_modules 和不需要的文件
tar --exclude='node_modules' --exclude='.git' --exclude='*.db' -czvf ../deploy.tar.gz .

# 上传到服务器（在本地 PowerShell 执行）
scp deploy.tar.gz root@你的服务器IP:/root/

# 在服务器上解压并部署
ssh root@你的服务器IP
cd /root
mkdir -p ai-customer-service && cd ai-customer-service
tar -xzvf ../deploy.tar.gz
cp .env.example .env
nano .env   # 修改密码
docker compose up -d --build
```

### 验证部署成功

```bash
# 检查容器状态
docker ps | grep ai-customer
# 应该显示 Up 状态

# 测试健康检查接口
curl http://localhost:3456/api/health
# 应该返回 {"status":"ok",...}

# 查看实时日志
docker compose logs -f
```

---

## 6. Nginx 反向代理 + HTTPS

### 5.1 安装 Nginx 和 Certbot

```bash
# 安装 Nginx
apt install -y nginx

# 安装 Certbot（免费 SSL 证书工具）
apt install -y certbot python3-certbot-nginx
```

### 5.2 配置 Nginx

```bash
# 把项目里的 Nginx 配置模板复制过去
cp nginx.conf.example /etc/nginx/conf.d/ai-customer.conf

# 编辑配置，把 yourdomain.com 改成你的真实域名
nano /etc/nginx/conf.d/ai-customer.conf
# 全局替换 :%s/yourdomain.com/你的域名/g （如果是 vi/vim）
# nano 里用 Ctrl+\ 进行全局替换

# 如果是 Docker 部署，需要把 upstream 的 host.docker.internal 改成宿主机内网IP
# 或者用 Docker 网络名：server ai-customer-service:3456;
```

Docker 部署时的特殊处理：

```bash
# 编辑 nginx.conf，把 upstream 部分改为：
# upstream ai_backend {
#     server ai-customer-service:3456;
#     keepalive 32;
# }
# 同时让 nginx 容器和应用容器在同一个网络中
```

更简单的做法——让 Nginx 直接在宿主机跑，通过 `host.docker.internal` 访问 Docker 内的服务。

### 5.3 测试并启用 Nginx

```bash
# 检查配置语法
nginx -t

# 重载配置
systemctl reload nginx

# 此时 http://你的域名 应该可以访问了
```

### 5.4 申请免费 SSL 证书（Let's Encrypt）

```bash
# ⚠️ 这一步需要域名已解析 + 备案完成
certbot --nginx -d 你的域名 -d www.你的域名

# 按提示操作：
# 1. 输入邮箱
# 2. 同意服务条款 (Y)
# 3. 是否订阅邮件 (N)
# 4. 选择重定向方式：选 2 (HTTPS 强制跳转)

# certbot 会自动修改 Nginx 配置，添加 SSL 设置和 HTTP→HTTPS 重定向
```

### 5.5 设置证书自动续期

```bash
# Certbot 通常会自动添加定时任务，检查一下
systemctl status certbot.timer

# 或者手动测试续期
certbot renew --dry-run
```

---

## 7. 安全加固

### 6.1 修改默认密码

```bash
# 务必在管理后台登录后立即修改默认密码
# 访问 https://你的域名/admin.html
# 默认账号：admin
# 默认密码：你在 .env 中设置的密码
```

### 6.2 配置 AI API Key

进入管理后台 → AI配置 → 填入智谱AI或DeepSeek的API Key

### 6.3 定期备份数据

```bash
# 创建备份脚本
cat > /root/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/root/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# 备份 Docker 卷数据
docker run --rm -v ai-customer-data:/data -v $BACKUP_DIR:/backup alpine tar czf /backup/data_$DATE.tar.gz -C /data .

# 保留最近7天的备份
find $BACKUP_DIR -name "data_*.tar.gz" -mtime +7 -delete

echo "备份完成: data_$DATE.tar.gz"
EOF

chmod +x /root/backup.sh

# 设置每天凌晨3点自动备份
(crontab -l 2>/dev/null; echo "0 3 * * * /root/backup.sh >> /var/log/backup.log 2>&1") | crontab -
```

---

## 8. 日常运维命令

### Docker 相关

```bash
docker compose ps              # 查看容器状态
docker compose logs -f         # 实时查看日志
docker compose restart         # 重启服务
docker compose down            # 停止服务
docker compose up -d --build   # 重新构建并启动（代码更新后用这个）
docker system df               # 查看磁盘占用
docker system prune -f         # 清理无用镜像释放空间
```

### Nginx 相关

```bash
nginx -t                      # 检查配置语法
systemctl reload nginx        # 重载配置（不断连）
systemctl restart nginx       # 重启 Nginx
tail -f /var/log/nginx/access.log  # 查看访问日志
tail -f /var/log/nginx/error.log   # 查看错误日志
```

### 服务器监控

```bash
# CPU / 内存 / 磁盘
htop                          # 实时资源监控（需先 apt install htop）
df -h                         # 磁盘使用情况
free -h                       # 内存使用情况

# 网络连通性
curl -I https://你的域名      # 检查站点是否正常响应
```

### 数据库备份/恢复

```bash
# 备份数据库
docker run --rm -v ai-ccustomer-data:/data -v /root:/backup alpine cp /data/ai-customer.db /backup/ai-customer_$(date +%Y%m%d).db

# 恢复数据库（谨慎操作！）
docker run --rm -v ai-customer-data:/data -v /root:/backup alpine cp /backup/ai-customer_xxx.db /data/ai-customer.db
docker compose restart
```

---

## 9. 常见问题排查

### Q1: 容器启动失败

```bash
# 查看详细错误日志
docker compose logs --tail=100

# 常见原因：
# - 端口被占用：lsof -i :3456 查看
# - .env 格式错误：确保没有多余的空格或引号
# - 权限不足：chmod -R 777 ./logs
```

### Q2: 页面打不开 / 502 错误

```bash
# 检查应用是否在跑
docker ps

# 检查 Nginx 配置
nginx -t
systemctl status nginx

# 检查防火墙
ufw status
```

### Q3: WebSocket 连接断开

```bash
# 确保 Nginx 配置中有以下内容：
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 86400s;

# 检查是否有反向代理层（如 Cloudflare）拦截了 WebSocket
# Cloudflare 需要开启 WebSocket 支持
```

### Q4: 内存不够用（OOM）

```bash
# 检查内存
free -h

# 如果是 2G 内存机器，考虑：
# 1. 增加 swap 空间
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 2. 限制 Node.js 内存
# 在 docker-compose.yml 中添加：
# environment:
#   - NODE_OPTIONS=--max-old-space-size=512
```

### Q5: 如何更新版本？

```bash
cd ~/ai-customer-service
git pull origin main          # 拉最新代码
docker compose up -d --build  # 重新构建并启动
# 如果数据库结构有变化，需要备份数据后再操作
```

---

## 📋 上线前最终检查清单

```
□ 服务器已购买，SSH 能正常连接
□ Docker 已安装，docker compose 可用
□ 代码已上传/克隆到服务器
□ .env 文件已创建，AUTH_PASSWORD 已修改为强密码
□ docker compose up -d --build 成功启动
□ curl http://localhost:3456/api/health 返回正常
□ 域名已解析到服务器 IP
□ Nginx 已配置，http://域名 可以访问
□ SSL 证书已申请，https://域名 正常工作
□ 管理后台登录正常，AI API Key 已配置
□ 自动备份定时任务已设置
□ 防火墙只开了 22/80/443 端口
```

全部打勾 ✅ → **恭喜，你的 AI 客服系统正式上线了！**
