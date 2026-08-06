-- AI智能客服系统 PostgreSQL 迁移脚本
-- 执行时机：首次 docker-compose up 时自动运行（docker-entrypoint-initdb.d）

-- 会话表
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    visitor_id TEXT NOT NULL,
    visitor_name TEXT DEFAULT '访客',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active',
    mode TEXT DEFAULT 'ai',
    assigned_agent TEXT,
    agent_name TEXT,
    closed_at TIMESTAMPTZ,
    close_reason TEXT
);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ai_confidence REAL,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 评价表
CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    score INTEGER NOT NULL,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 统计表
CREATE TABLE IF NOT EXISTS stats (
    date DATE PRIMARY KEY,
    total_conversations INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    ai_handled INTEGER DEFAULT 0
);

-- 未匹配查询（知识库闭环）
CREATE TABLE IF NOT EXISTS unanswered_queries (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT DEFAULT 'pending',
    answer TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ
);

-- 订单模拟表
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_phone TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    start_location TEXT,
    end_location TEXT,
    fee REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    bike_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 操作审计日志
CREATE TABLE IF NOT EXISTS action_logs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    params JSONB,
    result JSONB,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 会话结局（运营闭环）
CREATE TABLE IF NOT EXISTS conversation_outcomes (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'unsolved', 'escalated', 'abandoned')),
    source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
    operator TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 用户表（JWT 认证）
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent', 'readonly')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 默认管理员（密码: admin123，首次登录后须修改）
INSERT INTO users (id, username, password_hash, role)
VALUES ('u_admin', 'admin', '$2b$10$placeholder_change_after_first_login', 'admin')
ON CONFLICT (username) DO NOTHING;

-- 索引
CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON conversations(visitor_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_mode ON conversations(mode);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ratings_conversation ON ratings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_unanswered_status ON unanswered_queries(status);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(user_phone);
CREATE INDEX IF NOT EXISTS idx_action_logs_conversation ON action_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_conversation ON conversation_outcomes(conversation_id);

-- 预填订单种子数据
INSERT INTO orders (id, user_phone, start_time, end_time, start_location, end_location, fee, status, bike_id)
VALUES
    ('R20260801', '13800000001', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days', '万达广场', '中山路', 1.5, 'completed', 'B001'),
    ('R20260802', '13800000001', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', '地铁站A口', '科技园', 2.5, 'completed', 'B003'),
    ('R20260803', '13800000001', NOW() - INTERVAL '1 day', NULL, '学校东门', NULL, 0, 'active', 'B005'),
    ('R20260804', '13800000001', NOW(), NOW(), '商业街', '万达广场', 1.5, 'completed', 'B001'),
    ('R20260805', '13800000001', NOW() - INTERVAL '2 days', NULL, '火车站南广场', NULL, 8.0, 'pending', 'B007')
ON CONFLICT (id) DO NOTHING;
