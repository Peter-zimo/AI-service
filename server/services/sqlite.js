/**
 * SQLite 核心数据库模块
 * 使用 better-sqlite3（WAL 模式支持并发读写）
 * 当 DB_TYPE=postgres 时自动切换到 PostgreSQL
 */

// ===== 双引擎切换 =====
if (process.env.DB_TYPE === 'postgres') {
  const pg = require('./pg');
  // 异步适配：包装 pg.query 为类 better-sqlite3 同步接口
  // 注意：调用方需在 async 上下文中使用 await db.xxx()
  const db = {
    _pg: true,
    prepare: (sql) => ({
      all: (...params) => pg.query(sql, params),
      get: (...params) => pg.queryOne(sql, params),
      run: (...params) => pg.execute(sql, params),
    }),
    exec: (sql) => pg.execute(sql),
    transaction: (fn) => pg.transaction(fn),
    pragma: () => {},              // PG 不需要
    backup: () => {},              // PG 用 pg_dump
    healthCheck: () => pg.healthCheck(),
  };
  console.log('[DB] 使用 PostgreSQL 引擎');
  module.exports = db;
  return;
}

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.SQLITE_DB_PATH || path.join(dataDir, 'service.db');

// 创建数据库连接
const db = new Database(dbPath);

// 启用 WAL 模式（如失败则回退到 DELETE 模式）
try { db.pragma('journal_mode = WAL'); } catch (e) { console.error('[SQLite] WAL 模式设置失败:', e.message); }
db.pragma('foreign_keys = ON');

// 初始化表结构
function initSchema() {
  // 会话表
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
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
    )
  `);

  // 消息表
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ai_confidence REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);

  // 评价表
  db.exec(`
    CREATE TABLE IF NOT EXISTS ratings (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);

  // 统计表
  db.exec(`
    CREATE TABLE IF NOT EXISTS stats (
      date TEXT PRIMARY KEY,
      total_conversations INTEGER DEFAULT 0,
      total_messages INTEGER DEFAULT 0,
      ai_handled INTEGER DEFAULT 0
    )
  `);

  // 未匹配查询（知识库反馈闭环）
  db.exec(`
    CREATE TABLE IF NOT EXISTS unanswered_queries (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      answer TEXT,
      created_by TEXT,
      created_at TEXT
    )
  `);

  // 订单模拟表（用于任务执行工具演示）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
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
      )
    `);
  } catch (e) {
    if (e.code !== 'SQLITE_READONLY') console.error('[SQLite] 创建 orders 表失败:', e.message);
  }

  // 操作审计日志（Agent 写操作留痕）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        params TEXT,
        result TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    `);
  } catch (e) {
    if (e.code !== 'SQLITE_READONLY') console.error('[SQLite] 创建 action_logs 表失败:', e.message);
  }

  // 创建索引（加速查询）
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON conversations(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_ratings_conversation ON ratings(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_unanswered_status ON unanswered_queries(status);
      CREATE INDEX IF NOT EXISTS idx_unanswered_query ON unanswered_queries(query);
      CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(user_phone);
      CREATE INDEX IF NOT EXISTS idx_action_logs_conversation ON action_logs(conversation_id);
    `);
  } catch (e) {
    if (e.code !== 'SQLITE_READONLY') console.error('[SQLite] 创建索引失败:', e.message);
  }

  console.log('[SQLite] 数据库表初始化完成');
}

// 迁移：新增 source 列（幂等）
function migrateAddSourceColumn() {
  try {
    db.exec("ALTER TABLE messages ADD COLUMN source TEXT DEFAULT NULL");
    console.log('[SQLite] 消息表新增 source 列');
  } catch (_) {
    // 列已存在，忽略
  }
}

// 执行迁移（从 JSON 文件迁移数据）
function migrateFromJSON() {
  const jsonPath = path.join(dataDir, 'service.json');
  if (!fs.existsSync(jsonPath)) {
    console.log('[SQLite] 无旧数据，跳过迁移');
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    // 禁用外键约束，避免迁移时引用问题
    db.pragma('foreign_keys = OFF');

    const migrate = db.transaction(() => {
      // 1. 先迁移会话
      if (data.conversations && data.conversations.length > 0) {
        const insertConv = db.prepare(`
          INSERT OR IGNORE INTO conversations
          (id, visitor_id, visitor_name, created_at, updated_at, last_message_at, status, mode, assigned_agent, agent_name, closed_at, close_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const c of data.conversations) {
          insertConv.run(c.id, c.visitor_id, c.visitor_name, c.created_at, c.updated_at, c.last_message_at,
            c.status, c.mode, c.assigned_agent, c.agent_name, c.closed_at, c.close_reason);
        }
        console.log(`[SQLite] 迁移会话: ${data.conversations.length} 条`);
      }

      // 2. 再迁移消息
      if (data.messages && data.messages.length > 0) {
        const insertMsg = db.prepare(`
          INSERT OR IGNORE INTO messages (id, conversation_id, role, content, ai_confidence, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const m of data.messages) {
          insertMsg.run(m.id, m.conversation_id, m.role, m.content, m.ai_confidence, m.created_at);
        }
        console.log(`[SQLite] 迁移消息: ${data.messages.length} 条`);
      }

      // 3. 迁移评价
      if (data.ratings && data.ratings.length > 0) {
        const insertRating = db.prepare(`
          INSERT OR IGNORE INTO ratings (id, conversation_id, score, comment, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const r of data.ratings) {
          insertRating.run(r.id, r.conversation_id, r.score, r.comment, r.created_at);
        }
        console.log(`[SQLite] 迁移评价: ${data.ratings.length} 条`);
      }

      // 4. 迁移统计
      if (data.stats && data.stats.length > 0) {
        const insertStat = db.prepare(`
          INSERT OR REPLACE INTO stats (date, total_conversations, total_messages, ai_handled)
          VALUES (?, ?, ?, ?)
        `);
        for (const s of data.stats) {
          insertStat.run(s.date, s.total_conversations, s.total_messages, s.ai_handled);
        }
        console.log(`[SQLite] 迁移统计: ${data.stats.length} 条`);
      }
    });
    migrate();

    // 恢复外键约束
    db.pragma('foreign_keys = ON');
    console.log('[SQLite] JSON 数据迁移完成');
  } catch (e) {
    console.error('[SQLite] 迁移失败:', e.message);
  }
}

// 初始化
initSchema();
migrateAddSourceColumn();
migrateFromJSON();

// ===== 预填订单模拟数据（用于任务执行工具演示）=====
function seedOrders() {
  try {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM orders').get();
    if (count.cnt > 0) return;

  const now = new Date().toISOString();
  const day = (offset) => {
    const d = new Date(new Date().getTime() - offset * 24 * 3600 * 1000);
    return d.toISOString();
  };

  const sampleOrders = [
    { id: 'R20260801', phone: '13800000001', start: day(3), end: day(3), startLoc: '万达广场', endLoc: '中山路', fee: 1.5, status: 'completed', bike: 'B001' },
    { id: 'R20260802', phone: '13800000001', start: day(2), end: day(2), startLoc: '地铁站A口', endLoc: '科技园', fee: 2.5, status: 'completed', bike: 'B003' },
    { id: 'R20260803', phone: '13800000001', start: day(1), end: null, startLoc: '学校东门', endLoc: null, fee: 0, status: 'active', bike: 'B005' },
    { id: 'R20260804', phone: '13800000001', start: day(0), end: day(0), startLoc: '商业街', endLoc: '万达广场', fee: 1.5, status: 'completed', bike: 'B001' },
    { id: 'R20260805', phone: '13800000001', start: day(2), end: null, startLoc: '火车站南广场', endLoc: null, fee: 8.0, status: 'pending', bike: 'B007' },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO orders (id, user_phone, start_time, end_time, start_location, end_location, fee, status, bike_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const o of sampleOrders) {
      stmt.run(o.id, o.phone, o.start, o.end, o.startLoc, o.endLoc, o.fee, o.status, o.bike, now);
    }
  });
  insertAll();
  console.log(`[SQLite] 预填订单模拟数据: ${sampleOrders.length} 条`);
  } catch (e) {
    if (e.code !== 'SQLITE_READONLY') console.error('[SQLite] 预填订单数据失败:', e.message);
  }
}

seedOrders();

// ===== 数据库自动备份（每日凌晨3点，保留最近7天）=====
const backupDir = path.join(__dirname, '../data/backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

function backupDatabase() {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const backupPath = path.join(backupDir, `service_${dateStr}.db`);
    if (fs.existsSync(backupPath)) return;
    db.backup(backupPath);
    console.log(`[SQLite] 备份完成: ${backupPath}`);
    // 清理7天前的备份
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(backupDir)) {
      if (file.startsWith('service_') && file.endsWith('.db')) {
        const filePath = path.join(backupDir, file);
        if (Date.now() - fs.statSync(filePath).mtimeMs > SEVEN_DAYS) {
          fs.unlinkSync(filePath);
          console.log(`[SQLite] 清理旧备份: ${file}`);
        }
      }
    }
  } catch (e) {
    console.error('[SQLite] 备份失败:', e.message);
  }
}
backupDatabase(); // 启动时备份一次
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 3 && now.getMinutes() < 1) backupDatabase();
}, 60 * 60 * 1000);

module.exports = db;
