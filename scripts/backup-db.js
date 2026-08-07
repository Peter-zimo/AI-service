/**
 * PostgreSQL 自动备份脚本（跨平台）
 *
 * 用法:
 *   手动:   node scripts/backup-db.js
 *   定时:   Windows 计划任务 或 cron 每日调用本脚本
 *
 * 功能:
 *   1. 通过 pg_dump 备份到 backups/ 目录（文件名含日期）
 *   2. 自动清理 30 天前的旧备份（保留策略可配 BACKUP_RETENTION_DAYS）
 *   3. 输出备份结果
 *
 * 环境变量:
 *   DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD  — PG 连接（默认同 .env）
 *   PG_DUMP_CMD  — pg_dump 命令（默认 'pg_dump'，Docker 部署可设为 'docker exec ai-cs-postgres pg_dump'）
 *   BACKUP_DIR   — 备份目录（默认 server/data/backups）
 *   BACKUP_RETENTION_DAYS — 保留天数（默认 30）
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '../server/data/backups');
const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = process.env.DB_PORT || '5432';
const dbName = process.env.DB_NAME || 'ai_customer_service';
const dbUser = process.env.DB_USER || 'ai_service';
const dbPassword = process.env.DB_PASSWORD || 'changeme';

// Docker 部署时可用: docker exec ai-cs-postgres pg_dump
const pgDumpCmd = (process.env.PG_DUMP_CMD || 'pg_dump').split(/\s+/);

function ensureDir() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
}

function runBackup() {
  ensureDir();
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(backupDir, `db_${date}.sql`);
  const args = [
    ...pgDumpCmd.slice(1),
    '-h', dbHost, '-p', dbPort, '-U', dbUser, '-d', dbName,
    '--no-owner', '--no-privileges', '-f', file,
  ];
  console.log(`[备份] 执行: ${pgDumpCmd[0]} ${args.join(' ')}`);
  execFileSync(pgDumpCmd[0], args, {
    env: { ...process.env, PGPASSWORD: dbPassword },
    stdio: 'inherit',
  });
  const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`[备份] 完成: ${file} (${sizeMB} MB)`);
  cleanup();
  return file;
}

function cleanup() {
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(backupDir)) {
    if (!f.startsWith('db_') || !f.endsWith('.sql')) continue;
    const p = path.join(backupDir, f);
    const mtime = fs.statSync(p).mtimeMs;
    if (mtime < cutoff) {
      fs.unlinkSync(p);
      removed++;
      console.log(`[备份] 清理过期: ${f}`);
    }
  }
  if (removed === 0) console.log(`[备份] 无 ${retentionDays} 天前的过期备份`);
}

try {
  const file = runBackup();
  console.log(`[备份] 成功 → ${file}`);
  console.log(`[备份] 保留策略: ${retentionDays} 天`);
} catch (e) {
  console.error('[备份] 失败:', e.message);
  process.exit(1);
}
