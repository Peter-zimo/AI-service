-- pgvector：知识库向量检索（PostgreSQL）
-- 仅在新库初始化时由 docker-entrypoint-initdb.d 执行；
-- 已有库由 server/infra/db/postgres.js 的 ensureSchema 幂等补齐。

CREATE EXTENSION IF NOT EXISTS vector;

-- 001_init.sql 未包含 knowledge 表（由应用侧 ensureSchema 创建），这里补上
CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    keywords TEXT NOT NULL,
    embedding TEXT DEFAULT NULL,
    embedding_vec vector(1024),
    created_at TEXT,
    updated_at TEXT
);

ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding_vec vector(1024);

-- HNSW + 余弦距离；dim 固定 1024，短向量零填充（余弦相似度不变）
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_vec
    ON knowledge USING hnsw (embedding_vec vector_cosine_ops);
