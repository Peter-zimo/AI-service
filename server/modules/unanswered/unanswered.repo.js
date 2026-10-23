/**
 * 未匹配查询数据访问层
 *
 * unanswered_queries 表的全部 SQL。
 */

'use strict';

const db = require('../../infra/db');
const { v4: uuidv4 } = require('uuid');

/** 找同名的 pending 记录 */
async function findPendingByQuery(query) {
  return db.prepare(
    "SELECT id, count FROM unanswered_queries WHERE query = ? AND status = 'pending'"
  ).get(query);
}

async function bumpCount(id) {
  await db.prepare(
    'UPDATE unanswered_queries SET count = count + 1, last_seen = ? WHERE id = ?'
  ).run(new Date().toISOString(), id);
}

async function insert(query) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO unanswered_queries (id, query, count, first_seen, last_seen, status, created_at)
    VALUES (?, ?, 1, ?, ?, 'pending', ?)
  `).run(uuidv4(), query, now, now, now);
}

async function getById(id) {
  return (await db.prepare('SELECT * FROM unanswered_queries WHERE id = ?').get(id)) || null;
}

async function listByStatus(status, limit) {
  if (status === 'all') {
    return db.prepare(
      'SELECT * FROM unanswered_queries ORDER BY count DESC, last_seen DESC LIMIT ?'
    ).all(limit);
  }
  return db.prepare(
    'SELECT * FROM unanswered_queries WHERE status = ? ORDER BY count DESC, last_seen DESC LIMIT ?'
  ).all(status, limit);
}

/** 运营复核用：只取需要的列 */
async function listForReview(limit) {
  return db.prepare(`
    SELECT query, count, first_seen, last_seen, status FROM unanswered_queries
    ORDER BY count DESC, last_seen DESC LIMIT ?
  `).all(limit);
}

async function markAdded(id, answer, createdBy) {
  await db.prepare(
    "UPDATE unanswered_queries SET status = 'added', answer = ?, created_by = ? WHERE id = ?"
  ).run(answer, createdBy, id);
}

async function markDismissed(id) {
  await db.prepare("UPDATE unanswered_queries SET status = 'dismissed' WHERE id = ?").run(id);
}

async function countByStatus(status) {
  return (await db.prepare(
    'SELECT COUNT(*) as count FROM unanswered_queries WHERE status = ?'
  ).get(status)).count;
}

async function topPending(limit) {
  return db.prepare(
    "SELECT query, count FROM unanswered_queries WHERE status = 'pending' ORDER BY count DESC LIMIT ?"
  ).all(limit);
}

/** 按首次出现日期聚合（倒序） */
async function dailyNew(days) {
  return db.prepare(`
    SELECT substr(first_seen,1,10) as day, COUNT(*) as new_count
    FROM unanswered_queries GROUP BY day ORDER BY day DESC LIMIT ?
  `).all(days);
}

/** 某天已处理（added + dismissed）的数量 */
async function solvedOn(day) {
  return (await db.prepare(
    "SELECT COUNT(*) as c FROM unanswered_queries WHERE substr(first_seen,1,10) = ? AND status IN ('added','dismissed')"
  ).get(day)).c;
}

module.exports = {
  findPendingByQuery,
  bumpCount,
  insert,
  getById,
  listByStatus,
  listForReview,
  markAdded,
  markDismissed,
  countByStatus,
  topPending,
  dailyNew,
  solvedOn,
};
