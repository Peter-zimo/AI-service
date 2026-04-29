# ===========================================
# WorkBuddy AI 客服系统 - Railway 部署配置
# ===========================================

# 1. 注册 Railway
#    访问 https://railway.app 并用 GitHub 登录

# 2. 创建项目
#    railway init
#    或在 Railway Dashboard 点击 "New Project" → "Deploy from GitHub repo"

# 3. 上传代码到 GitHub
#    git init
#    git add .
#    git commit -m "Initial commit"
#    git remote add origin https://github.com/你的用户名/ai-customer-service.git
#    git push -u origin main

# 4. 关联 GitHub 仓库到 Railway
#    Railway Dashboard → Connect GitHub repo → 选择 ai-customer-service

# 5. 配置环境变量（Railway Dashboard → Variables）
#    添加以下变量：

# ===========================================
# 必填变量
# ===========================================

# DeepSeek API Key（AI对话能力）
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 备用 AI API Key（可选，用于双接口降级）
# ZHIPU_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 管理后台认证（格式：用户名:密码）
BASIC_AUTH=admin:你的密码

# ===========================================
# 可选变量（有默认值）
# ===========================================

# 服务端口（ Railway 会自动设置 PORT，无需配置）
# PORT=3456

# Node 环境
NODE_ENV=production

# 品牌配置（JSON格式）
# BRAND_NAME=智能客服
# BRAND_WELCOME=您好，请问有什么可以帮您？

# 日志加密密钥（32位随机字符串）
# SENSITIVE_LOG_KEY=your_32_character_random_string_here

# ===========================================
# 注意事项
# ===========================================

# 1. 首次部署需要几分钟时间，Railway 会自动检测 Node.js 项目
# 2. 部署完成后，Railway 会分配一个 .railway.app 域名
# 3. 数据库文件会存储在 Railway 提供的持久化存储中
# 4. 免费额度：500小时/月（单实例足够用）
# 5. 如果需要自定义域名，在 Railway Dashboard → Settings → Networking 中配置

# ===========================================
# 常用命令
# ===========================================

# railway login          # 登录
# railway init           # 初始化项目
# railway up             # 部署
# railway logs           # 查看日志
# railway open           # 打开在线地址
# railway variables      # 查看环境变量
