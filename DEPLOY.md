# AI智能客服系统 - Docker 部署指南

## 一键启动

```bash
# 进入项目目录
cd ai-customer-service

# 后台启动（自动构建镜像+启动容器）
docker compose up -d

# 查看运行状态
docker compose ps

# 查看日志
docker compose logs -f
```

## 启动后访问

| 页面 | 地址 |
|------|------|
| 访客端 | http://localhost:3456 |
| 管理后台 | http://localhost:3456/admin.html |
| 客服工作台 | http://localhost:3456/agent.html |

**默认账号**：`admin` / `admin123`

## 自定义配置

### 修改端口
```bash
PORT=8080 docker compose up -d
```

### 修改管理员密码（首次部署前）
创建 `.env` 文件：
```env
AUTH_USERNAME=admin
AUTH_PASSWORD=你的密码
```
然后 `docker compose up -d`

## 数据持久化

所有数据存储在 Docker 命名卷 `ai-customer-data` 中，包括：
- 品牌配置 (`brand.json`)
- 知识库数据
- 敏感词库
- 聊天记录 (SQLite数据库)

**容器重建/升级不会丢失数据。**

## 常用命令

| 操作 | 命令 |
|------|------|
| 启动 | `docker compose up -d` |
| 停止 | `docker compose down` |
| 重启 | `docker compose restart` |
| 查看状态 | `docker compose ps` |
| 实时日志 | `docker compose logs -f` |
| 进入容器 | `docker exec -it ai-customer-service sh` |
| 备份数据 | `docker run --rm -v ai-customer-data:/data alpine tar czf /backup.tar.gz -C /data .` |
| 升级 | `git pull && docker compose up -d --build` |

## 生产环境建议

1. **修改默认密码**：务必通过 `.env` 设置 `AUTH_PASSWORD`
2. **反向代理**：用 Nginx/Caddy 做 HTTPS 反代
3. **资源限制**：在 docker-compose.yml 加 `deploy.resources.limits`
4. **日志收集**：对接 ELK/Loki 或使用 `docker compose logs`
