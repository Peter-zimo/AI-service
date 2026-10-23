/**
 * 会话列表聚合查询（后台）
 *
 * 带「最后一条消息」的跨表查询放这里：
 * 它既不属于单纯的 conversations，也不属于单纯的 messages。
 * 单表 CRUD 分别在 conversation.repo / message.repo / rating.repo。
 */

'use strict';

const db = require('../../infra/db');

/**
 * 按创建时间倒序取会话列表，附带最后一条消息。
 * @param {number} limit 已由上层收敛过的条数
 */
async function listRecentConversations(limit) {
  return db.prepare(`
    SELECT c.*,
      (SELECT m.content FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC LIMIT 1) AS last_message_content,
      (SELECT m.role FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC LIMIT 1) AS last_message_role,
      (SELECT m.created_at FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
    FROM conversations c
    ORDER BY c.created_at DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { listRecentConversations };
