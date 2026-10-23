/**
 * 业务执行路由（Agent 任务执行层）
 *
 * 读操作（Agent 直接调用，低风险）：
 *   GET /orders?phone=xxx     → 查订单列表
 *   GET /order/:id            → 查订单详情
 *
 * 写操作（需 Agent 二次确认后调用，写审计日志）：
 *   POST /complaint           → 提交申诉
 *   POST /refund              → 退款申请
 *   POST /manual-review       → 人工复核
 *
 * 本文件只做「取参 → 调 service → 返回」，业务与 SQL 都在 modules/actions。
 */

'use strict';

const express = require('express');
const { jwtAuth } = require('../middleware/auth');
const actions = require('../modules/actions');

const router = express.Router();

/** 统一把领域错误映射为 HTTP 响应 */
function handleError(res, error, logLabel) {
  if (error instanceof actions.ActionError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  console.error(`[Actions] ${logLabel}:`, error.message);
  res.status(500).json({ success: false, error: logLabel });
}

/** 写操作前置校验中间件 */
async function validateBody(req, res, next) {
  const { conversationId, visitorId } = req.body || {};
  try {
    await actions.assertConversationOwnership(conversationId, visitorId);
    next();
  } catch (error) {
    handleError(res, error, '校验会话失败');
  }
}

// ============ 读操作 ============

router.get('/orders', jwtAuth(['admin']), async (req, res) => {
  try {
    const data = await actions.listOrders(req.query.phone);
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, '查询订单失败');
  }
});

router.get('/order/:id', jwtAuth(['admin']), async (req, res) => {
  try {
    const data = await actions.getOrder(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, '查询订单详情失败');
  }
});

// ============ 写操作 ============

router.post('/complaint', validateBody, async (req, res) => {
  try {
    const data = await actions.submitComplaint(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, '提交申诉失败');
  }
});

router.post('/refund', validateBody, async (req, res) => {
  try {
    const data = await actions.submitRefund(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, '退款申请失败');
  }
});

router.post('/manual-review', validateBody, async (req, res) => {
  try {
    const data = await actions.submitManualReview(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, '提交复核失败');
  }
});

module.exports = router;
