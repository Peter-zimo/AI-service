/**
 * 数据库备份 / 恢复演练
 *
 * 做四件事（不修改源库）：
 *   1. 用 SQLite 在线备份 API 生成一致性备份（只读打开源库）
 *   2. 对备份做 integrity_check + 关键表行数 + knowledge 内容 hash
 *   3. 复制成 restored.db，重新打开并比对行数/hash
 *   4. 检查保留期内所有自动备份（service_YYYY-MM-DD.db）的完整性，最新一份不超过 48h
 *
 * 运行：npm run db:drill
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ROOT, 'server/data/service.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const DB_BASENAME = path.basename(DB_PATH, '.db');
const TABLES = ['knowledge', 'conversations', 'messages', 'ratings', 'stats'];
const STALE_MS = 48 * 60 * 60 * 1000;

let tempDir = null;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
}

function tableCounts(db, names) {
  const counts = {};
  for (const table of TABLES) {
    if (names.has(table)) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    }
  }
  return counts;
}

function knowledgeHash(db, names) {
  if (!names.has('knowledge')) return null;
  const rows = db.prepare('SELECT id, question, answer FROM knowledge ORDER BY id').all();
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function inspect(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const integrity = db.pragma('integrity_check', { simple: true });
  const names = tableNames(db);
  const counts = tableCounts(db, names);
  const hash = knowledgeHash(db, names);
  db.close();
  return { integrity, counts, hash, size: fs.statSync(file).size };
}

function inspectCopy(sourceFile, label) {
  const copy = path.join(tempDir, `inspect-${label}-${Date.now()}.db`);
  fs.copyFileSync(sourceFile, copy);
  if (fs.existsSync(sourceFile + '-wal')) {
    fs.copyFileSync(sourceFile + '-wal', copy + '-wal');
  }
  try {
    return inspect(copy);
  } finally {
    for (const p of [copy, `${copy}-shm`, `${copy}-wal`]) {
      fs.rmSync(p, { force: true });
    }
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`数据库不存在: ${DB_PATH}`);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-drill-'));

  try {
    const backupPath = path.join(tempDir, 'backup.db');
    const restoredPath = path.join(tempDir, 'restored.db');

    // 1. 在线一致性备份（只读打开源库，不触发 WAL checkpoint 改写）
    const source = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const started = Date.now();
    await source.backup(backupPath);
    const backupMs = Date.now() - started;
    source.close();

    // 2. 校验备份
    const backup = inspect(backupPath);

    // 3. 模拟恢复
    fs.copyFileSync(backupPath, restoredPath);
    const restored = inspect(restoredPath);

    const countsMatch = JSON.stringify(backup.counts) === JSON.stringify(restored.counts);
    const hashMatch = backup.hash === restored.hash;

    // 4. 检查保留期内的自动备份（只认标准日期文件）
    const autoBackups = [];
    if (fs.existsSync(BACKUP_DIR)) {
      const pattern = new RegExp(`^${escapeRegExp(DB_BASENAME)}_\\d{4}-\\d{2}-\\d{2}\\.db$`);
      const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => pattern.test(f))
        .sort();
      for (const file of files) {
        const full = path.join(BACKUP_DIR, file);
        const info = inspectCopy(full, file.replace(/\.db$/, ''));
        autoBackups.push({ file, ...info, mtime: fs.statSync(full).mtimeMs });
      }
    }

    const latestAuto = autoBackups[autoBackups.length - 1] || null;
    const corrupt = autoBackups.filter((b) => b.integrity !== 'ok');
    const latestFresh = latestAuto ? (Date.now() - latestAuto.mtime < STALE_MS) : false;

    const ok = backup.integrity === 'ok'
      && restored.integrity === 'ok'
      && countsMatch
      && hashMatch
      && corrupt.length === 0
      && latestFresh;

    const report = {
      db: DB_PATH,
      backupMs,
      backup: {
        size: backup.size,
        integrity: backup.integrity,
        counts: backup.counts,
        hash: backup.hash,
      },
      restored: {
        integrity: restored.integrity,
        counts: restored.counts,
        hash: restored.hash,
      },
      countsMatch,
      hashMatch,
      autoBackups,
      latestAuto: latestAuto
        ? { file: latestAuto.file, integrity: latestAuto.integrity, fresh: latestFresh }
        : null,
      corrupt: corrupt.map((b) => b.file),
      ok,
    };

    console.log(JSON.stringify(report, null, 2));
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('RESULT: FAIL');
  console.error(e.message);
  process.exitCode = 1;
});
