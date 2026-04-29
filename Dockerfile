# AI智能客服系统 Docker镜像
# 多阶段构建：先构建依赖，再打包运行

# ========== 阶段1：安装依赖 ==========
FROM node:20-alpine AS builder
WORKDIR /app

# 先复制package文件，利用Docker缓存层（依赖不变时跳过npm install）
COPY package.json package-lock.json* ./
RUN npm install --production && npm cache clean --force

# ========== 阶段2：运行镜像 ==========
FROM node:20-alpine

# 安装基础工具（调试用）
RUN apk add --no-cache tzdata curl

# 设置时区为上海
ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV PORT=3456

WORKDIR /app

# 从builder阶段复制node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制应用代码
COPY . .

# 创建数据目录（用于挂载持久化卷）
RUN mkdir -p /app/server/data /app/logs

# 暴露端口
EXPOSE 3456

# 健康检查：每30s检查一次，超时5s，连续3次失败标记unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3456/api/health || exit 1

# 启动命令
CMD ["node", "server/index.js"]
