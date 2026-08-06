/**
 * 数据库初始化脚本
 * 解决 sandbox 下原 service.db 只读问题：复制→在新副本建表→写回
 * 用法: node init-db.js
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'server/data/service.db');
const tmpPath = path.join(__dirname, 'server/data/service_init.db');

// 1. 复制数据库到临时文件（副本可写）
console.log('[init-db] 复制数据库...');
fs.copyFileSync(dbPath, tmpPath);
console.log('[init-db] 副本已创建');

const db = new Database(tmpPath);
db.pragma('journal_mode = WAL');  // 预创建 WAL 文件

// 2. 建表
try {
  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, user_phone TEXT NOT NULL,
    start_time TEXT NOT NULL, end_time TEXT,
    start_location TEXT, end_location TEXT,
    fee REAL DEFAULT 0, status TEXT DEFAULT 'active',
    bike_id TEXT, created_at TEXT NOT NULL
  )`);
  console.log('[init-db] orders 表已就绪');
} catch (e) {
  console.error('[init-db] 创建 orders 失败:', e.message);
}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS action_logs (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL, action TEXT NOT NULL,
    params TEXT, result TEXT, status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`);
  console.log('[init-db] action_logs 表已就绪');
} catch (e) {
  console.error('[init-db] 创建 action_logs 失败:', e.message);
}

try { db.exec('CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(user_phone)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_action_logs_conversation ON action_logs(conversation_id);'); } catch (_) {}

// 3. 预填种子数据
const count = db.prepare('SELECT COUNT(*) as cnt FROM orders').get();
if (count.cnt === 0) {
  const now = new Date().toISOString();
  const day = (offset) => {
    const d = new Date(Date.now() - offset * 24 * 3600 * 1000);
    return d.toISOString();
  };

  const orders = [
    { id: 'R20260801', phone: '13800000001', start: day(3), end: day(3), startLoc: '万达广场', endLoc: '中山路', fee: 1.5, status: 'completed', bike: 'B001' },
    { id: 'R20260802', phone: '13800000001', start: day(2), end: day(2), startLoc: '地铁站A口', endLoc: '科技园', fee: 2.5, status: 'completed', bike: 'B003' },
    { id: 'R20260803', phone: '13800000001', start: day(1), end: null, startLoc: '学校东门', endLoc: null, fee: 0, status: 'active', bike: 'B005' },
    { id: 'R20260804', phone: '13800000001', start: day(0), end: day(0), startLoc: '商业街', endLoc: '万达广场', fee: 1.5, status: 'completed', bike: 'B001' },
    { id: 'R20260805', phone: '13800000001', start: day(2), end: null, startLoc: '火车站南广场', endLoc: null, fee: 8.0, status: 'pending', bike: 'B007' },
  ];

  const stmt = db.prepare('INSERT OR IGNORE INTO orders (id, user_phone, start_time, end_time, start_location, end_location, fee, status, bike_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertAll = db.transaction(() => {
    for (const o of orders) stmt.run(o.id, o.phone, o.start, o.end, o.startLoc, o.endLoc, o.fee, o.status, o.bike, now);
  });
  insertAll();
  console.log(`[init-db] 预填 ${orders.length} 条订单`);
} else {
  console.log(`[init-db] 已有 ${count.cnt} 条订单，跳过预填`);
}

db.close();

// 4. 覆盖回原文件
fs.copyFileSync(tmpPath, dbPath);
console.log('[init-db] 已写回原数据库');

// 5. 验证
const verify = new Database(dbPath);
const tables = verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orders','action_logs')").all();
console.log('[init-db] 验证新表:', tables.map(t => t.name).join(', '));
const orderCount = verify.prepare('SELECT COUNT(*) as c FROM orders').get();
console.log('[init-db] 订单数:', orderCount.c);
verify.close();

// 6. 清理临时文件
try { fs.unlinkSync(tmpPath); console.log('[init-db] 临时文件已清理'); } catch (_) {}

console.log('[init-db] 全部完成');
