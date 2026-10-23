/**
 * 业务执行数据访问层
 *
 * actions 模块中唯一允许写 SQL 的地方。
 */

'use strict';

const db = require('../../infra/db');

/** 按手机号查最近订单 */
async function findOrdersByPhone(phone, limit = 20) {
  return db.prepare(
    'SELECT * FROM orders WHERE user_phone = ? ORDER BY created_at DESC LIMIT ?'
  ).all(phone, limit);
}

/** 按 id 查订单 */
async function findOrderById(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

/** 按 id 查会话（用于校验归属） */
async function findConversationById(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

/** 写操作审计日志 */
async function insertActionLog(record) {
  return db.prepare(`
    INSERT INTO action_logs (id, conversation_id, visitor_id, action, params, result, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.conversationId,
    record.visitorId,
    record.action,
    JSON.stringify(record.params),
    JSON.stringify(record.result),
    record.status,
    record.createdAt
  );
}

module.exports = {
  findOrdersByPhone,
  findOrderById,
  findConversationById,
  insertActionLog,
};
