/**
 * 消息数据访问层
 *
 * messages 表的全部 SQL 集中在这里。
 */

'use strict';

const db = require('../../infra/db');

/**
 * 追加一条消息，并顺带刷新所属会话的 updated_at
 */
async function add(id, conversationId, role, content, aiConfidence = null, source = null) {
  const ts = new Date().toISOString();

  await db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, ai_confidence, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, role, content, aiConfidence, source, ts);

  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(ts, conversationId);

  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    ai_confidence: aiConfidence,
    source,
    created_at: ts,
  };
}

async function getByConversation(conversationId) {
  return db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId);
}

async function countByConversation(conversationId) {
  return db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?')
    .get(conversationId).count;
}

module.exports = { add, getByConversation, countByConversation };
