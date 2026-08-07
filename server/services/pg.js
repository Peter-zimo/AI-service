/**
 * PostgreSQL 数据库适配器
 * 当 DB_TYPE=postgres 时替代 better-sqlite3
 * 
 * API 兼容 better-sqlite3 的核心方法：
 *   db.prepare(sql).all(params)  →  query(sql, params)
 *   db.prepare(sql).get(params)  →  queryOne(sql, params)
 *   db.prepare(sql).run(params)  →  execute(sql, params)
 *   db.exec(sql)                  →  execute(sql)
 *   db.transaction(fn)            →  transaction(fn)
 *   db.pragma(key)                →  仅 journal_mode=WAL 被忽略
 *   db.backup(path)               →  pg_dump 替代
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ai_customer_service',
  user: process.env.DB_USER || 'ai_service',
  password: process.env.DB_PASSWORD || 'changeme',
  max: parseInt(process.env.DB_POOL_MAX || '20'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// 连接池错误处理
pool.on('error', (err) => {
  console.error('[PG] 连接池异常:', err.message);
});

// better-sqlite3 的 ? 占位符 → PG 的 $1..$n
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// 首次查询前先确保表结构就绪（幂等：只建一次，解决启动竞态）
let _schemaPromise = null;
function ensureSchemaReady() {
  if (!_schemaPromise) {
    _schemaPromise = ensureSchema().catch(e => {
      console.error('[PG] 建表失败:', e.message);
    });
  }
  return _schemaPromise;
}

// 查询多条
async function query(sql, params = []) {
  await ensureSchemaReady();
  const result = await pool.query(convertPlaceholders(sql), params);
  return result.rows;
}

// 查询单条
async function queryOne(sql, params = []) {
  await ensureSchemaReady();
  const result = await pool.query(convertPlaceholders(sql), params);
  return result.rows[0] || null;
}

// 执行（INSERT/UPDATE/DELETE）
async function execute(sql, params = []) {
  await ensureSchemaReady();
  const result = await pool.query(convertPlaceholders(sql), params);
  return { changes: result.rowCount, lastInsertRowid: null };
}

// 建表（PG 方言，与 sqlite.js initSchema 表结构一致）
async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      visitor_name TEXT DEFAULT '访客',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT,
      status TEXT DEFAULT 'active',
      mode TEXT DEFAULT 'ai',
      assigned_agent TEXT,
      agent_name TEXT,
      closed_at TEXT,
      close_reason TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ai_confidence REAL,
      source TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )`,
    `CREATE TABLE IF NOT EXISTS ratings (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )`,
    `CREATE TABLE IF NOT EXISTS stats (
      date TEXT PRIMARY KEY,
      total_conversations INTEGER DEFAULT 0,
      total_messages INTEGER DEFAULT 0,
      ai_handled INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS unanswered_queries (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      answer TEXT,
      created_by TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_phone TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      start_location TEXT,
      end_location TEXT,
      fee REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      bike_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS action_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT,
      result TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      keywords TEXT NOT NULL,
      embedding TEXT DEFAULT NULL,
      created_at TEXT,
      updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON conversations(visitor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ratings_conversation ON ratings(conversation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_unanswered_status ON unanswered_queries(status)`,
    `CREATE INDEX IF NOT EXISTS idx_unanswered_query ON unanswered_queries(query)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(user_phone)`,
    `CREATE INDEX IF NOT EXISTS idx_action_logs_conversation ON action_logs(conversation_id)`,
  ];
  for (const sql of statements) {
    await pool.query(sql);
  }
  console.log('[PG] 数据库表初始化完成');
}

// 事务
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (sql, params) => client.query(sql, params),
    });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 健康检查
async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (_) {
    return false;
  }
}

// 关闭连接池
async function close() {
  await pool.end();
}

module.exports = { query, queryOne, execute, transaction, healthCheck, close, pool, ensureSchema, convertPlaceholders };
