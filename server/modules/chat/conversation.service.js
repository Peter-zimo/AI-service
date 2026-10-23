/**
 * 会话生命周期服务
 *
 * 创建 / 历史 / 评价 / 关闭 / 状态 / 统计 / 转人工 / 取消排队 / 导出。
 * 统一返回 { ok, status, body } 或直接返回数据，由路由层映射 HTTP。
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const conversationRepo = require('./conversation.repo');
const messageRepo = require('./message.repo');
const ratingRepo = require('./rating.repo');
const aiService = require('../ai');
const humanService = require('../human');
const { canAccessVisitorConversation } = require('../../utils/access-control');
const { CONVERSATION_STATUS, CONVERSATION_MODE } = require('../../config/constants');
const stats = require('../stats');
const { validateVisitorId, enforceVisitorAccess } = require('./validator');
const listRepo = require('./chat.repo');
const exportService = require('./export.service');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;


const fail = (status, body) => ({ ok: false, status, body });
const ok = (payload) => ({ ok: true, payload });

// ============ 后台会话列表 ============

/**
 * 后台会话列表（带最后一条消息）
 * @param {number|string} rawLimit 非数字或 0 回落默认值，再收敛到 1~500
 */
async function listRecentConversations(rawLimit) {
  const parsed = parseInt(rawLimit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(parsed, 1), MAX_LIMIT);

  const rows = await listRepo.listRecentConversations(limit);

  return rows.map(row => {
    const conv = { ...row };

    if (row.last_message_content) {
      conv.lastMessage = {
        content: row.last_message_content,
        sender: row.last_message_role,
        created_at: row.last_message_at,
      };
    } else {
      conv.lastMessage = null;
    }

    delete conv.last_message_content;
    delete conv.last_message_role;
    delete conv.last_message_at;

    return conv;
  });
}

// ============ 创建 ============

async function createConversation({ visitorId, visitorName }) {
  if (!visitorId) return fail(400, { success: false, error: '缺少visitorId' });
  if (!validateVisitorId(visitorId)) return fail(400, { success: false, error: 'visitorId格式无效' });

  const conversationId = uuidv4();
  await conversationRepo.create(conversationId, visitorId, visitorName || '访客');
  await stats.incrementConversations();

  return ok({ success: true, conversationId });
}

// ============ 读 ============

/**
 * 按 id 取会话（供 WebSocket 连接校验等场景使用）
 * @param {string} id
 */
async function getConversationById(id) {
  return conversationRepo.getById(id);
}

async function getHistory(conversationId, visitorId) {
  const conversation = await conversationRepo.getById(conversationId);

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  const messages = await messageRepo.getByConversation(conversationId);
  return ok({ success: true, messages });
}

async function getStatus(conversationId, visitorId) {
  const conversation = await conversationRepo.getById(conversationId);
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
  const stats = await conversationRepo.getStats();
  return ok({ success: true, stats });
}

async function getDashboardStats() {
  return ok({ success: true, stats: await stats.getDailySnapshot() });
}

// ============ 写 ============

async function rate({ conversationId, score, comment, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await conversationRepo.getById(conversationId);
  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  // 与重构前语义一致：parseInt 不指定进制，非数字回落 3，再夹到 1~5
  const validScore = Math.min(5, Math.max(1, parseInt(score) || 3));
  await ratingRepo.add(uuidv4(), conversationId, validScore, comment || null);
  await conversationRepo.close(conversationId, 'rated');
  aiService.clearHistory(conversationId);

  return ok({ success: true });
}

async function closeConversation({ conversationId, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await conversationRepo.getById(conversationId);
  if (!conversation) return fail(404, { success: false, error: '会话不存在' });

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  if (conversation.status === CONVERSATION_STATUS.CLOSED) {
    return ok({ success: true, message: '会话已处于关闭状态' });
  }

  await conversationRepo.close(conversationId, 'manual');
  aiService.clearHistory(conversationId);

  return ok({ success: true, message: '会话已关闭' });
}

// ============ 转人工 ============

async function transferToHuman({ conversationId, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await conversationRepo.getById(conversationId);
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
      await conversationRepo.setMode(conversationId, CONVERSATION_MODE.QUEUE);
    } else {
      await conversationRepo.setMode(conversationId, CONVERSATION_MODE.HUMAN, result.agent);
    }
  }

  return ok(result);
}

async function cancelQueue({ conversationId, visitorId }) {
  if (!conversationId) return fail(400, { success: false, error: '缺少conversationId' });

  const conversation = await conversationRepo.getById(conversationId);

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) return fail(403, { success: false, error: accessErr });

  if (conversation && conversation.mode === CONVERSATION_MODE.QUEUE) {
    humanService.cancelQueue(conversationId);
    await conversationRepo.setMode(conversationId, CONVERSATION_MODE.AI);
  }

  return ok({ success: true, message: '已取消排队' });
}

// ============ 供客服工作台使用 ============

/** 客服发送的消息落库 */
async function addAgentMessage(conversationId, content) {
  return messageRepo.add(uuidv4(), conversationId, 'agent', content);
}

/** 客服结束会话 */
async function closeByAgent(conversationId) {
  return conversationRepo.close(conversationId, 'agent_ended');
}

/** 取某会话的全部消息（客服用，无访客归属校验） */
async function getMessages(conversationId) {
  return messageRepo.getByConversation(conversationId);
}


module.exports = {
  listRecentConversations,
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
  exportConversationsCsv: exportService.exportConversationsCsv,
  addAgentMessage,
  closeByAgent,
  getMessages,
};
