# AI客服系统 - 项目记忆

## 基本信息

**项目路径**: `D:\AI应用\workbuddy files\ai-customer-service`

**技术栈**: Express + WebSocket + better-sqlite3

**启动命令**: `cd "D:\AI应用\workbuddy files\ai-customer-service" && npm start`

---

## SQLite 架构（2026-04-21 完成）

### 核心文件
- `server/services/sqlite.js`: 表初始化 + JSON→SQLite 自动迁移，WAL模式
- `server/services/database.js`: conversations/messages/ratings/stats 服务层，内存缓存每5秒刷新
- `server/services/knowledge.js`: 知识库 SQLite 存储

### 表结构
- `conversations`: 会话表（id, visitor_id, status, mode 等）
- `messages`: 消息表
- `ratings`: 评价表
- `stats`: 统计表
- `knowledge`: 知识库表
- 均有索引优化查询性能

### 踩坑经验
- **module.exports getter 覆盖同名属性**: Node.js 对象字面量中，getter 会覆盖同名属性值。解决方案：把 service 对象和 data 函数分离导出
- **外键约束迁移失败**: 迁移时先关闭外键约束，迁移完成后再开启
- **chat.js 用 `db.conversations.xxx`**，stats.js 用 `dbSvc._conversations()` 获取数组

---

## 修复记录

### 2026-04-21 关键Bug修复
1. **访客端无法回答**: 阈值 score >= 4 太高 → 改为 >= 2
2. **AI回复被敏感词过滤**: 敏感词库含"扫码""二维码"等业务词 → 清理
3. **管理后台404**: 前端调用 `/knowledge/list`，后端是 `/knowledge` → 统一路径

### 2026-04-21 SQLite 迁移（本次）
- 彻底完成 SQLite 替代 JSON 文件
- WAL 模式支持并发
- 自动从旧 JSON 数据迁移
