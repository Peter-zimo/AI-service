/**
 * 访客聊天路由
 *
 * 只做「取参 → 调 service → 返回」。业务在 modules/chat，SQL 在 chat.repo.js。
 * 认证与限流在 app.js 挂载时施加（访客接口免认证，靠 visitorId 校验归属）。
 */

'use strict';

const express = require('express');
const chat = require('../modules/chat');
const { jwtAuth } = require('../middleware/auth');

const router = express.Router();

/** 把服务层的 { ok, status, body } 映射为响应 */
function reply(res, result) {
  if (!result.ok) return res.status(result.status).json(result.body);
  return res.json(result.payload);
}

function guard(res, error, logLabel, clientMessage) {
  console.error(`${logLabel}:`, error);
  res.status(500).json({ success: false, error: clientMessage });
}

// ============ 创建会话 ============
router.post('/create', async (req, res) => {
  try {
    const { visitorId, visitorName } = req.body || {};
    reply(res, await chat.createConversation({ visitorId, visitorName }));
  } catch (error) {
    guard(res, error, '创建对话失败', '创建对话失败，请稍后重试');
  }
});

// ============ 发送消息 ============
router.post('/message', async (req, res) => {
  try {
    const { conversationId, message, visitorId } = req.body || {};
    reply(res, await chat.sendMessage({ conversationId, message, visitorId }));
  } catch (error) {
    guard(res, error, '发送消息失败', '处理消息失败，请稍后重试');
  }
});

// ============ 对话历史 ============
router.get('/history/:conversationId', async (req, res) => {
  try {
    reply(res, await chat.getHistory(req.params.conversationId, req.query.visitorId));
  } catch (error) {
    guard(res, error, '获取历史失败', '获取历史失败');
  }
});

// 注意：/list 路由挂在 app.js 管理 API 区（需 JWT）

// ============ 评价 ============
router.post('/rate', async (req, res) => {
  try {
    reply(res, await chat.rate(req.body || {}));
  } catch (error) {
    guard(res, error, '评价失败', '评价失败');
  }
});

// ============ 关闭会话 ============
router.post('/close', async (req, res) => {
  try {
    reply(res, await chat.closeConversation(req.body || {}));
  } catch (error) {
    guard(res, error, '关闭会话失败', '关闭会话失败');
  }
});

// ============ 会话状态 ============
router.get('/status/:conversationId', async (req, res) => {
  try {
    reply(res, await chat.getStatus(req.params.conversationId, req.query.visitorId));
  } catch (error) {
    guard(res, error, '获取会话状态失败', '获取会话状态失败');
  }
});

// ============ 会话统计 ============
router.get('/conversation-stats', async (req, res) => {
  try {
    reply(res, await chat.getConversationStats());
  } catch (error) {
    guard(res, error, '获取会话统计失败', '获取会话统计失败');
  }
});

// ============ 转人工 ============
router.post('/transfer-to-human', async (req, res) => {
  try {
    reply(res, await chat.transferToHuman(req.body || {}));
  } catch (error) {
    guard(res, error, '转人工失败', '转人工失败');
  }
});

// ============ 取消排队 ============
router.post('/cancel-queue', async (req, res) => {
  try {
    reply(res, await chat.cancelQueue(req.body || {}));
  } catch (error) {
    guard(res, error, '取消排队失败', '取消排队失败');
  }
});

// ============ 站点统计 ============
router.get('/stats', async (req, res) => {
  try {
    reply(res, await chat.getDashboardStats());
  } catch (error) {
    guard(res, error, '获取统计失败', '获取统计失败');
  }
});

// ============ 导出对话（CSV） ============
// 含全量访客ID与消息内容，必须鉴权；此前漏了 JWT，任何人都能拉走整库会话
router.get('/export/:format', jwtAuth(['admin', 'agent']), async (req, res) => {
  try {
    if (req.params.format !== 'csv') {
      return res.status(400).json({ success: false, error: '不支持的格式，请使用 csv' });
    }

    const { csv, filenameDate } = await chat.exportConversationsCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=conversations_${filenameDate}.csv`);
    res.send(csv);
  } catch (error) {
    guard(res, error, '导出对话失败', '导出失败');
  }
});

// ============ SSE 流式接收 ============
// 前端收到 { type: 'streaming', streamId } 后连接此端点，逐 token 接收 AI 回答
router.get('/stream/:streamId', async (req, res) => {
  const attached = chat.attachSse(res, req.params.streamId, req);
  if (!attached) {
    return res.status(404).json({ success: false, error: '流式会话不存在或已过期' });
  }
});

module.exports = router;
