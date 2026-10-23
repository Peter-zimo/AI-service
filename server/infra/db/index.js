/**
 * 数据库引擎入口
 *
 * 唯一职责：根据 DB_TYPE 选择引擎，并对外暴露统一的 db 句柄。
 * 上层只 require('infra/db')，不直接碰具体引擎文件。
 *
 * 注意：SQLite 引擎在 require 时会执行建表 / 迁移 / 备份（副作用），
 * 这是原有行为，保持不变。
 */

'use strict';

const usePostgres = process.env.DB_TYPE === 'postgres';

if (usePostgres) {
  console.log('[DB] 使用 PostgreSQL 引擎');
  // 表结构由 postgres.js 首次查询前自动 ensureSchemaReady（解决启动竞态）
  module.exports = require('./postgres-adapter');
} else {
  module.exports = require('./sqlite');
}
