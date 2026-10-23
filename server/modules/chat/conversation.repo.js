/**
 * 会话数据访问层
 *
 * conversations 表的全部 SQL 集中在这里。
 *
 * 说明：少数方法内部带有状态守卫（例如只在未关闭时更新），
 * 这类守卫与 SQL 条件强耦合，暂留在本层，避免迁移过程中改变行为。
 */

'use strict';

const db = require('../../infra/db');
const { CONVERSATION_STATUS, CONVERSATION_MODE } = require('../../config/constants');

const now = () => new Date().toISOString();

async function create(id, visitorId, visitorName) {
  // 同一访客开新会话前，先关掉他的上一个未关闭会话
  const existingActive = await getActiveByVisitor(visitorId);
  if (existingActive) {
    await close(existingActive.id, 'new_session');
  }

  const ts = now();
  await db.prepare(`
    INSERT INTO conversations (id, visitor_id, visitor_name, created_at, updated_at, last_message_at, status, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, visitorId, visitorName || '访客', ts, ts, ts,
    CONVERSATION_STATUS.ACTIVE, CONVERSATION_MODE.AI);

  console.log(`[会话] 创建新会话: ${id}, 访客: ${visitorId}`);
  return getById(id);
}

async function getById(id) {
  return (await db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)) || null;
}

async function getActiveByVisitor(visitorId) {
  return (await db.prepare(`
    SELECT * FROM conversations WHERE visitor_id = ? AND status != ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(visitorId, CONVERSATION_STATUS.CLOSED)) || null;
}

/** 刷新最后消息时间；idle 会话收到消息会恢复为 active */
async function updateLastMessage(id) {
  const c = await getById(id);
  if (!c || c.status === CONVERSATION_STATUS.CLOSED) return false;

  const ts = now();
  const nextStatus = c.status === CONVERSATION_STATUS.IDLE
    ? CONVERSATION_STATUS.ACTIVE
    : c.status;

  await db.prepare(`
    UPDATE conversations SET last_message_at = ?, updated_at = ?, status = ? WHERE id = ?
  `).run(ts, ts, nextStatus, id);

  if (c.status === CONVERSATION_STATUS.IDLE) {
    console.log(`[会话] ${id} 从idle恢复为active`);
  }
  return true;
}

async function setIdle(id) {
  const c = await getById(id);
  if (!c || c.status !== CONVERSATION_STATUS.ACTIVE) return false;

  const ts = now();
  await db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
    .run(CONVERSATION_STATUS.IDLE, ts, id);
  console.log(`[会话] ${id} 进入空闲状态`);
  return true;
}

async function close(id, reason = 'manual') {
  const c = await getById(id);
  if (!c || c.status === CONVERSATION_STATUS.CLOSED) return false;

  const ts = now();
  await db.prepare(`
    UPDATE conversations SET status = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?
  `).run(CONVERSATION_STATUS.CLOSED, ts, reason, ts, id);
  console.log(`[会话] ${id} 已关闭，原因: ${reason}`);
  return true;
}

/** 所有未关闭会话（超时检查用） */
async function listOpen() {
  return db.prepare('SELECT * FROM conversations WHERE status != ?')
    .all(CONVERSATION_STATUS.CLOSED);
}

async function getStats() {
  const total = await db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
  const active = await db.prepare('SELECT COUNT(*) as count FROM conversations WHERE status = ?')
    .get(CONVERSATION_STATUS.ACTIVE).count;
  const idle = await db.prepare('SELECT COUNT(*) as count FROM conversations WHERE status = ?')
    .get(CONVERSATION_STATUS.IDLE).count;
  const closed = await db.prepare('SELECT COUNT(*) as count FROM conversations WHERE status = ?')
    .get(CONVERSATION_STATUS.CLOSED).count;
  return { total, active, idle, closed };
}

async function list(limit = 100) {
  return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit);
}

async function setMode(id, mode, agentInfo = null) {
  const c = await getById(id);
  if (!c || c.status === CONVERSATION_STATUS.CLOSED) return false;

  const ts = now();
  if (agentInfo) {
    await db.prepare(`
      UPDATE conversations SET mode = ?, assigned_agent = ?, agent_name = ?, updated_at = ? WHERE id = ?
    `).run(mode, agentInfo.id, agentInfo.name, ts, id);
  } else {
    await db.prepare('UPDATE conversations SET mode = ?, updated_at = ? WHERE id = ?')
      .run(mode, ts, id);
  }

  console.log(`[会话] ${id} 模式切换为: ${mode}`);
  return true;
}

module.exports = {
  create,
  getById,
  getActiveByVisitor,
  updateLastMessage,
  setIdle,
  close,
  listOpen,
  getStats,
  list,
  setMode,
};
