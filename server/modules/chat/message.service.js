/**
 * 消息处理服务（/message 主链路）
 *
 * 一个入口串起六步，每步独立可读：
 *   1. 入参校验
 *   2. 会话状态与访客归属校验
 *   3. 敏感词检测
 *   4. 落库（用户消息 + 统计）
 *   5. 分流：人工模式 → 转发客服；否则 → AI
 *   6. 创建流式会话并异步启动 AI
 *
 * 返回统一为 { ok, status, body }，由路由层原样映射，服务层不碰 HTTP。
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../services/database');
const sensitiveService = require('../../services/sensitive');
const humanService = require('../../services/human');
const { CONVERSATION_STATUS, CONVERSATION_MODE, MESSAGE } = require('../../config/constants');
const { enforceVisitorAccess } = require('./validator');
const streamSession = require('./stream-session');
const queue = require('./queue');
const aiRunner = require('./ai-runner');

function fail(status, body) {
  return { ok: false, status, body };
}

/**
 * 处理一条访客消息
 * @param {{conversationId: string, message: string, visitorId: string}} input
 */
async function sendMessage(input) {
  const { conversationId, message, visitorId } = input || {};

  // ---- 1. 入参校验 ----
  // 先判类型再调 trim()：非字符串直接 trim 会抛异常，最终变成 500
  if (message === undefined || message === null) {
    return fail(400, { success: false, error: '消息不能为空' });
  }
  if (typeof message !== 'string') {
    return fail(400, { success: false, error: '消息格式无效' });
  }
  if (!message.trim()) {
    return fail(400, { success: false, error: '消息不能为空' });
  }
  if (message.length > MESSAGE.MAX_LENGTH) {
    return fail(400, { success: false, error: `消息长度不能超过${MESSAGE.MAX_LENGTH}字符` });
  }
  if (!conversationId) {
    return fail(400, { success: false, error: '缺少conversationId' });
  }

  // ---- 2. 会话状态与归属 ----
  const conversation = await db.conversations.getById(conversationId);
  if (!conversation) {
    return fail(400, { success: false, error: '会话不存在' });
  }
  if (conversation.status === CONVERSATION_STATUS.CLOSED) {
    return fail(400, {
      success: false,
      error: '会话已结束，请刷新页面开始新对话',
      code: 'CONVERSATION_CLOSED',
    });
  }

  const accessErr = enforceVisitorAccess(conversation, visitorId);
  if (accessErr) {
    return fail(403, { success: false, error: accessErr });
  }

  const trimmedMessage = message.trim();

  // ---- 3. 敏感词 ----
  const sensitiveCheck = sensitiveService.detect(trimmedMessage);
  if (sensitiveCheck.hasSensitive) {
    sensitiveService.logDetection(conversationId, 'user', trimmedMessage, sensitiveCheck, visitorId);
    return fail(400, {
      success: false,
      error: '消息包含敏感内容，请修改后重试',
      code: 'SENSITIVE_WORD_DETECTED',
      sensitiveWords: sensitiveCheck.words,
    });
  }

  // ---- 4. 落库 ----
  await db.conversations.updateLastMessage(conversationId);
  await db.messages.add(uuidv4(), conversationId, 'user', trimmedMessage);
  await db.stats.incrementMessages();

  const updatedConversation = await db.conversations.getById(conversationId);

  // ---- 5a. 人工模式：转发给客服，不立即返回内容 ----
  if (updatedConversation.mode === CONVERSATION_MODE.HUMAN) {
    const agent = humanService.getAgentByConversation(conversationId);
    if (agent) {
      humanService.sendToAgent(agent.id, {
        type: 'user_message',
        conversationId,
        message: trimmedMessage,
        timestamp: new Date().toISOString(),
      });

      return {
        ok: true,
        payload: {
          success: true,
          response: {
            message: '',
            type: 'human_pending',
            confidence: 1,
          },
          conversation: {
            status: updatedConversation.status,
            mode: updatedConversation.mode,
            agentName: updatedConversation.agent_name,
            lastMessageAt: updatedConversation.last_message_at,
          },
        },
      };
    }
  }

  // ---- 5b. AI 模式：建流式会话，后台异步执行 ----
  const streamId = uuidv4();
  streamSession.createSession(streamId, conversationId);
  console.log(`[LangChain Agent] 创建流式会话: ${streamId}`);

  // 不 await：先返回 streamId，前端立刻连 SSE
  queue.enqueue(conversationId, () => aiRunner.runAgentStream({
    conversationId,
    message: trimmedMessage,
    streamId,
  }));

  return {
    ok: true,
    payload: {
      success: true,
      type: 'streaming',
      streamId,
      conversation: {
        status: updatedConversation.status,
        mode: updatedConversation.mode,
        lastMessageAt: updatedConversation.last_message_at,
      },
    },
  };
}

module.exports = { sendMessage };
