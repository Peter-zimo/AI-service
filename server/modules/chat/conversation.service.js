/**
 * 会话生命周期服务
 *
 * 创建 / 历史 / 评价 / 关闭 / 状态 / 统计 / 转人工 / 取消排队 / 导出。
 * 统一返回 { ok, status, body } 或直接返回数据，由路由层映射 HTTP。
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../services/database');
const aiService = require('../../services/ai');
const humanService = require('../../services/human');
const { toCsv } = require('../../utils/csv');
const { canAccessVisitorConversation } = require('../../utils/access-control');
const { CONVERSATION_STATUS, CONVERSATION_MODE } = require('../../config/constants');
const { validateVisitorId, enforceVisitorAccess } = require('./validator');
const repo = require('./chat.repo');

const EXPORT_LIMITS = { MAX_CONVS: 500, MAX_ROWS: 5000 };

const fail = (status, body) => ({ ok: false, status, body });
const ok = (payload) => ({ ok: true, payload });

// ============ 创建 ============

async function createConversation({ visitorId, visitorName }) {
  if (!visitorId) return fail(400, { success: false, error: '缺少visitorId' });
  if (!validateVisitorId(visitorId)) return fail(400, { success: false, error: 'visitorId格式无效' });

  const conversationId = uuidv4();
  await db.conversations.create(conversationId, visitorId, visitorName || '访客');
  await db.stats.incrementConversations();

  return ok({ success: true, conversationId });
}

// ============ 读 ============

/**
 * 按 id 取会话（供 WebSocket 连接校验等场景使用）
 * @param {string} id
 */
async function getConversationById(id) {
  return db.conversations.getById(id);
}

async function getHistory(conversationId, visitorId) {
  const conversation = await db.conversations.getById(conversationId);

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  const messages = await db.messages.getByConversation(conversationId);
  return ok({ success: true, messages });
}

async function getStatus(conversationId, visitorId) {
  const conversation = await db.conversations.getById(conversationId);
  if (!conversation) return fail(404, { success: false, error: '会话不存在' });

  if (!canAccessVisitorConversation(conversation, visitorId)) {
    return fail(403, { success: false, error: '无权访问此会话' });
  }

  return ok({
    success: true,
    status: conversation.status,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    lastMessageAt: conversation.last_message_at,
    closedAt: conversation.closed_at,
    closeReason: conversation.close_reason,
  });
}

async function getConversationStats() {
  const stats = await db.conversations.getStats();
  return ok({ success: true, stats });
}

async function getDashboardStats() {
  const today = (await db.stats.getToday()) || {
    total_conversations: 0, total_messages: 0, ai_handled: 0,
  };
  const week = await db.stats.getRecent(7);
  const summary = await db.stats.getSummary();

  return ok({ success: true, stats: { today, week, summary } });
}

// ============ 写 ============

async function rate({ conversationId, score, comment, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await db.conversations.getById(conversationId);
  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  const validScore = Math.min(5, Math.max(1, parseInt(score, 10) || 3));
  await db.ratings.add(uuidv4(), conversationId, validScore, comment || null);
  await db.conversations.close(conversationId, 'rated');
  aiService.clearHistory(conversationId);

  return ok({ success: true });
}

async function closeConversation({ conversationId, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await db.conversations.getById(conversationId);
  if (!conversation) return fail(404, { success: false, error: '会话不存在' });

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  if (conversation.status === CONVERSATION_STATUS.CLOSED) {
    return ok({ success: true, message: '会话已处于关闭状态' });
  }

  await db.conversations.close(conversationId, 'manual');
  aiService.clearHistory(conversationId);

  return ok({ success: true, message: '会话已关闭' });
}

// ============ 转人工 ============

async function transferToHuman({ conversationId, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await db.conversations.getById(conversationId);
  if (!conversation) return fail(404, { success: false, error: '会话不存在' });

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  if (conversation.status === CONVERSATION_STATUS.CLOSED) {
    return fail(400, { success: false, error: '会话已关闭' });
  }

  if (conversation.mode === CONVERSATION_MODE.HUMAN) {
    return ok({
      success: true,
      alreadyInHuman: true,
      agentName: conversation.agent_name,
      message: '您已在人工服务中',
    });
  }

  if (conversation.mode === CONVERSATION_MODE.QUEUE) {
    const queueInfo = humanService.getQueueInfo();
    const position = queueInfo.items.findIndex(i => i.conversationId === conversationId) + 1;
    return ok({
      success: true,
      inQueue: true,
      position: position || queueInfo.length,
      message: `当前排队位置：第${position || queueInfo.length}位，请耐心等待`,
    });
  }

  const result = humanService.requestHuman(conversationId, {
    visitorId,
    visitorName: conversation.visitor_name,
  });

  if (result.success) {
    if (result.inQueue) {
      await db.conversations.setMode(conversationId, CONVERSATION_MODE.QUEUE);
    } else {
      await db.conversations.setMode(conversationId, CONVERSATION_MODE.HUMAN, result.agent);
    }
  }

  return ok(result);
}

async function cancelQueue({ conversationId, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await db.conversations.getById(conversationId);

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  if (conversation && conversation.mode === CONVERSATION_MODE.QUEUE) {
    humanService.cancelQueue(conversationId);
    await db.conversations.setMode(conversationId, CONVERSATION_MODE.AI);
  }

  return ok({ success: true, message: '已取消排队' });
}

// ============ 导出 ============

const MODE_LABEL = { ai: 'AI', queue: '排队中', human: '人工' };
const STATUS_LABEL = { active: '进行中', idle: '等待中', closed: '已结束' };

const fmtTime = (value) => (value ? value.replace('T', ' ').slice(0, 19) : '');

/**
 * 导出对话记录为 CSV 文本（每条消息一行）
 * @returns {Promise<{csv: string, filenameDate: string}>}
 */
async function exportConversationsCsv() {
  const conversations = await db.conversations.list(EXPORT_LIMITS.MAX_CONVS);
  const allRatings = await repo.listAllRatings();
  const rows = [];
  let rowCount = 0;

  for (const conv of conversations) {
    if (rowCount >= EXPORT_LIMITS.MAX_ROWS) break;

    const msgs = await repo.listMessagesByConversation(conv.id);
    const rating = allRatings.find(r => r.conversation_id === conv.id);

    // 列顺序必须与历史导出一致，否则下游脚本会错列
    const common = {
      '对话ID': conv.id,
      '访客': conv.visitor_name || '访客',
      '处理方式': MODE_LABEL[conv.mode] || conv.mode,
      '会话状态': STATUS_LABEL[conv.status] || conv.status,
      '满意度': rating ? `${rating.score}星` : '未评价',
      '评价内容': rating ? rating.comment || '' : '',
      '会话创建时间': fmtTime(conv.created_at),
    };

    if (msgs.length > 0) {
      for (const msg of msgs) {
        if (rowCount >= EXPORT_LIMITS.MAX_ROWS) break;
        rows.push({
          '对话ID': common['对话ID'],
          '访客': common['访客'],
          '消息内容': msg.content,
          '角色': msg.role === 'user' ? '访客' : (msg.role === 'agent' ? '客服' : 'AI'),
          '处理方式': common['处理方式'],
          '会话状态': common['会话状态'],
          '满意度': common['满意度'],
          '评价内容': common['评价内容'],
          '消息时间': fmtTime(msg.created_at),
          '会话创建时间': common['会话创建时间'],
        });
        rowCount++;
      }
    } else {
      // 无消息的会话不计入行数上限
      rows.push({
        '对话ID': common['对话ID'],
        '访客': common['访客'],
        '消息内容': '(无消息)',
        '角色': '',
        '处理方式': common['处理方式'],
        '会话状态': common['会话状态'],
        '满意度': common['满意度'],
        '评价内容': common['评价内容'],
        '消息时间': '',
        '会话创建时间': common['会话创建时间'],
      });
    }
  }

  if (rows.length >= EXPORT_LIMITS.MAX_ROWS) {
    console.log(`[导出] 数据量已达上限(${EXPORT_LIMITS.MAX_ROWS}行)，如有需要请分批导出`);
  }

  return {
    csv: '\uFEFF' + toCsv(rows),
    filenameDate: new Date().toISOString().slice(0, 10),
  };
}

module.exports = {
  createConversation,
  getConversationById,
  getHistory,
  getStatus,
  getConversationStats,
  getDashboardStats,
  rate,
  closeConversation,
  transferToHuman,
  cancelQueue,
  exportConversationsCsv,
};
