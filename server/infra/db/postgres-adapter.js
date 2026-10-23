/**
 * PostgreSQL 适配器
 *
 * 把 postgres.js 的异步接口包装成 better-sqlite3 的「形似同步」接口，
 * 让上层 repo 不必区分两套引擎。
 *
 * 重要：这只是形式上的统一，底层仍是异步。
 * 调用方必须 `await db.prepare(sql).all(...)` —— 忘了 await 会拿到 Promise。
 * 这是历史设计，B2 保留原有语义不做改动，避免牵连所有 repo。
 */

'use strict';

const pg = require('./postgres');

const adapter = {
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

module.exports = adapter;
