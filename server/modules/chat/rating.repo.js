/**
 * 评价数据访问层
 *
 * ratings 表的全部 SQL 集中在这里。
 */

'use strict';

const db = require('../../infra/db');

async function add(id, conversationId, score, comment = null) {
  const ts = new Date().toISOString();
  await db.prepare(`
    INSERT INTO ratings (id, conversation_id, score, comment, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, conversationId, score, comment, ts);

  return { id, conversation_id: conversationId, score, comment, created_at: ts };
}

async function getByConversation(conversationId) {
  return (await db.prepare('SELECT * FROM ratings WHERE conversation_id = ?')
    .get(conversationId)) || null;
}

async function getAverage() {
  const row = await db.prepare('SELECT AVG(score) as avg FROM ratings').get();
  return row.avg || 0;
}

async function getAll() {
  return db.prepare('SELECT * FROM ratings ORDER BY created_at DESC').all();
}

module.exports = { add, getByConversation, getAverage, getAll };
