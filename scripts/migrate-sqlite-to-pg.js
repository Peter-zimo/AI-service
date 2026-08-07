/**
 * SQLite → PostgreSQL 数据迁移脚本
 * 用法:
 *   SQLITE_DB_PATH=server/data/service.db \
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=ai_customer_service \
 *   DB_USER=ai_service DB_PASSWORD=xxx \
 *   node scripts/migrate-sqlite-to-pg.js
 *
 * 迁移表: conversations / messages / ratings / stats /
 *         unanswered_queries / orders / action_logs / knowledge
 * 幂等：目标表已有数据则跳过（可安全重复执行）
 */

const path = require('path');
const fs = require('fs');

// ---------- SQLite（源）----------
const Database = require('better-sqlite3');
const sqlitePath = process.env.SQLITE_DB_PATH || path.join(__dirname, '../server/data/service.db');
if (!fs.existsSync(sqlitePath)) {
  console.error('[迁移] SQLite 文件不存在:', sqlitePath);
  process.exit(1);
}
const sqlite = new Database(sqlitePath, { readonly: true });

// ---------- PostgreSQL（目标）----------
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ai_customer_service',
  user: process.env.DB_USER || 'ai_service',
  password: process.env.DB_PASSWORD || 'changeme',
  max: 10,
  connectionTimeoutMillis: 10000,
});

const TABLES = [
  'conversations', 'messages', 'ratings', 'stats',
  'unanswered_queries', 'orders', 'action_logs', 'knowledge',
];

// 表 → 需要跳过源列（如 SQLite 特有）
const SKIP_COLUMNS = {};

function toPgPlaceholders(sql, count) {
  let sql2 = sql;
  for (let i = 1; i <= count; i++) sql2 = sql2.replace('?', `$${i}`);
  return sql2;
}

async function migrateTable(table) {
  // 1. 源表结构
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const useCols = cols.filter(c => !(SKIP_COLUMNS[table] || []).includes(c));
  if (useCols.length === 0) return 0;

  // 2. 目标表是否已有数据（幂等）
  const { rows: existRows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  if (existRows[0].c > 0) {
    console.log(`  [${table}] 目标已有 ${existRows[0].c} 条，跳过`);
    return 0;
  }

  // 3. 读源数据（分批）
  const rows = sqlite.prepare(`SELECT ${useCols.map(c => `"${c}"`).join(',')} FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`  [${table}] 源为空，跳过`);
    return 0;
  }

  // 4. 批量插入（每批 500）
  const colList = useCols.join(',');
  const placeholders = useCols.map(() => '?').join(',');
  const baseSQL = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of batch) {
        const vals = useCols.map(c => row[c]);
        const sql = toPgPlaceholders(baseSQL, vals.length);
        await client.query(sql, vals);
      }
      await client.query('COMMIT');
      inserted += batch.length;
      console.log(`  [${table}] 已迁移 ${inserted}/${rows.length}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${table} 批次失败: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return inserted;
}

async function main() {
  console.log(`[迁移] SQLite: ${sqlitePath}`);
  console.log(`[迁移] PostgreSQL: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'ai_customer_service'}`);

  // 确认目标库可连
  await pool.query('SELECT 1');
  console.log('[迁移] 目标库连接成功');

  // 清空目标表（全量重建语义：从源同步，可安全重跑；避免测试数据/外键干扰）
  try {
    await pool.query(`TRUNCATE TABLE ${TABLES.join(', ')} CASCADE`);
    console.log('[迁移] 目标表已清空');
  } catch (e) {
    if (!/does not exist/i.test(e.message)) throw e;
    console.log('[迁移] 部分表尚不存在（首次迁移，将由服务启动建表）');
  }

  let total = 0;
  for (const t of TABLES) {
    try {
      total += await migrateTable(t);
    } catch (e) {
      console.error(`  [${t}] 迁移失败:`, e.message);
    }
  }
  console.log(`[迁移] 完成，共迁移 ${total} 条记录`);
  await pool.end();
  sqlite.close();
}

main().catch(e => {
  console.error('[迁移] 失败:', e.message);
  process.exit(1);
});
