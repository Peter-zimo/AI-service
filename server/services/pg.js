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

// 查询多条
async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

// 查询单条
async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

// 执行（INSERT/UPDATE/DELETE）
async function execute(sql, params = []) {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount, lastInsertRowid: null };
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

module.exports = { query, queryOne, execute, transaction, healthCheck, close, pool };
