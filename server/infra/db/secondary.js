/**
 * 打开一个独立的 SQLite 数据库文件
 *
 * 用于主库之外的辅助库（如质量评测审计库）。
 * 与 infra/db/index.js 的区别：那个是「服务主库」的单例，这里按路径开新连接。
 *
 * 统一入口的意义：所有 SQLite 连接都在 infra 层创建，
 * 避免各模块各自 new Database() 导致 WAL 配置、目录创建逻辑各写一遍。
 */

'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

/**
 * @param {string} filePath 数据库文件路径
 * @param {{readonly?: boolean}} [options]
 * @returns {import('better-sqlite3').Database}
 */
function openDatabase(filePath, { readonly = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new Database(filePath, readonly ? { readonly: true } : {});

  // 只读连接不能改 pragma，写连接开 WAL 支持并发读写
  if (!readonly) {
    db.pragma('journal_mode = WAL');
  }

  // 多个进程（例如并行测试）可能同时打开同一个库，
  // 建表/建索引时容易撞 SQLITE_BUSY。给一个等待窗口而不是直接抛错。
  db.pragma('busy_timeout = 5000');

  return db;
}

module.exports = { openDatabase };
