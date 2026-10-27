/**
 * 数据库备份 / 恢复演练
 *
 * 做三件事（不修改源库）：
 *   1. 用 SQLite 在线备份 API 生成一致性备份
 *   2. 对备份做 integrity_check + 关键表行数统计
 *   3. 把备份复制成 restored.db，重新打开并比对行数
 * 顺带检查最近一次自动备份（server/data/backups/service_*.db）的完整性。
 *
 * 运行：npm run db:drill
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ROOT, 'server/data/service.db');
const BACKUP_DIR = path.join(ROOT, 'server/data/backups');
const TABLES = ['knowledge', 'conversations', 'messages', 'ratings', 'stats'];

function tableCounts(db) {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  const counts = {};
  for (const table of TABLES) {
    if (names.has(table)) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    }
  }
  return counts;
}

function inspect(file) {
  const db = new Database(file, { readonly: true });
  const integrity = db.pragma('integrity_check', { simple: true });
  const counts = tableCounts(db);
  db.close();
  return { integrity, counts, size: fs.statSync(file).size };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`数据库不存在: ${DB_PATH}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-drill-'));
  const backupPath = path.join(tempDir, 'backup.db');
  const restoredPath = path.join(tempDir, 'restored.db');

  // 1. 在线一致性备份
  const source = new Database(DB_PATH);
  const started = Date.now();
  await source.backup(backupPath);
  const backupMs = Date.now() - started;
  source.close();

  // 2. 校验备份
  const backup = inspect(backupPath);

  // 3. 模拟恢复：复制备份并重新打开比对
  fs.copyFileSync(backupPath, restoredPath);
  const restored = inspect(restoredPath);

  const countsMatch = JSON.stringify(backup.counts) === JSON.stringify(restored.counts);
  const ok = backup.integrity === 'ok' && countsMatch;

  // 顺带检查最近一次自动备份
  let latestAuto = null;
  if (fs.existsSync(BACKUP_DIR)) {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^service_\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    if (files.length > 0) {
      const file = files[files.length - 1];
      const full = path.join(BACKUP_DIR, file);
      const info = inspect(full);
      latestAuto = { file, ...info };
    }
  }

  const report = {
    db: DB_PATH,
    backupMs,
    backup: { size: backup.size, integrity: backup.integrity, counts: backup.counts },
    restored: { integrity: restored.integrity, counts: restored.counts },
    countsMatch,
    latestAuto,
    ok,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');

  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('RESULT: FAIL');
  console.error(e.message);
  process.exit(1);
});
