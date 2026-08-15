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
 */

const express = require('express');
const router = express.Router();
const db = require('../services/sqlite');
const { v4: uuidv4 } = require('uuid');
const { jwtAuth } = require('../middleware/auth');

// visitorId 格式白名单（同步 chat.js）
const VISITOR_ID_RE = /^v_\d{10,}_[a-z0-9]{4,20}$/;

function validateVisitorId(vid) {
  return vid && typeof vid === 'string' && vid.length <= 64 && VISITOR_ID_RE.test(vid);
}

// ============ 写审计日志 ============
function logAction(conversationId, visitorId, action, params, result, status) {
  try {
    db.prepare(`
      INSERT INTO action_logs (id, conversation_id, visitor_id, action, params, result, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), conversationId, visitorId, action, JSON.stringify(params), JSON.stringify(result), status, new Date().toISOString());
  } catch (e) {
    console.error('[Actions] 审计日志写入失败:', e.message);
  }
}

// ============ 读操作 ============

// 查订单列表
router.get('/orders', jwtAuth(['admin']), (req, res) => {
  try {
    const { phone, visitorId } = req.query;
    if (!phone || phone.length < 8) {
      return res.status(400).json({ success: false, error: '缺少手机号或格式无效' });
    }

    const orders = db.prepare(
      'SELECT * FROM orders WHERE user_phone = ? ORDER BY created_at DESC LIMIT 20'
    ).all(phone);

    const totalFee = orders.reduce((s, o) => s + (o.fee || 0), 0);

    res.json({
      success: true,
      data: {
        orders: orders.map(o => ({
          id: o.id,
          startTime: o.start_time,
          endTime: o.end_time,
          startLocation: o.start_location,
          endLocation: o.end_location,
          fee: o.fee,
          status: o.status,
          bikeId: o.bike_id,
        })),
        total: orders.length,
        totalFee: Math.round(totalFee * 100) / 100,
      }
    });
  } catch (e) {
    console.error('[Actions] 查订单失败:', e.message);
    res.status(500).json({ success: false, error: '查询订单失败' });
  }
});

// 查单个订单
router.get('/order/:id', jwtAuth(['admin']), (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: '订单不存在' });
    }
    res.json({
      success: true,
      data: {
        id: order.id,
        userPhone: order.user_phone,
        startTime: order.start_time,
        endTime: order.end_time,
        startLocation: order.start_location,
        endLocation: order.end_location,
        fee: order.fee,
        status: order.status,
        bikeId: order.bike_id,
        createdAt: order.created_at,
      }
    });
  } catch (e) {
    console.error('[Actions] 查订单详情失败:', e.message);
    res.status(500).json({ success: false, error: '查询订单详情失败' });
  }
});

// ============ 写操作（需校验 visitorId + conversationId）============

function validateBody(req, res, next) {
  const { conversationId, visitorId } = req.body || {};
  if (!conversationId) {
    return res.status(400).json({ success: false, error: '缺少 conversationId' });
  }
  if (!visitorId || !validateVisitorId(visitorId)) {
    return res.status(400).json({ success: false, error: 'visitorId 格式无效' });
  }
  // 校验会话是否存在且 visitorId 归属
  try {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conv) return res.status(404).json({ success: false, error: '会话不存在' });
    if (conv.visitor_id !== visitorId) return res.status(403).json({ success: false, error: '无权操作此会话' });
  } catch (e) {
    return res.status(500).json({ success: false, error: '校验会话失败' });
  }
  next();
}

// 提交申诉
router.post('/complaint', validateBody, (req, res) => {
  try {
    const { conversationId, visitorId, orderId, reason } = req.body || {};
    if (!orderId || !reason || reason.trim().length < 5) {
      return res.status(400).json({ success: false, error: '缺少订单号或申诉原因（至少5字）' });
    }
    if (reason.length > 500) {
      return res.status(400).json({ success: false, error: '申诉原因过长（限500字）' });
    }

    const cleanReason = reason.trim();
    logAction(conversationId, visitorId, 'complaint', { orderId, reason: cleanReason }, { message: '申诉已提交，人工客服将在工作日内处理' }, 'submitted');

    res.json({
      success: true,
      data: {
        message: `申诉已提交！订单 ${orderId} 将在 1-3 个工作日内由人工客服审核处理，请留意通知。`,
        ticketId: uuidv4().slice(0, 8),
      }
    });
  } catch (e) {
    console.error('[Actions] 提交申诉失败:', e.message);
    res.status(500).json({ success: false, error: '提交申诉失败' });
  }
});

// 退款申请
router.post('/refund', validateBody, (req, res) => {
  try {
    const { conversationId, visitorId, orderId, reason } = req.body || {};
    if (!orderId || !reason || reason.trim().length < 5) {
      return res.status(400).json({ success: false, error: '缺少订单号或退款原因（至少5字）' });
    }
    if (reason.length > 500) {
      return res.status(400).json({ success: false, error: '退款原因过长（限500字）' });
    }

    const cleanReason = reason.trim();
    logAction(conversationId, visitorId, 'refund', { orderId, reason: cleanReason }, { message: '退款申请已提交' }, 'submitted');

    res.json({
      success: true,
      data: {
        message: `退款申请已提交！订单 ${orderId}，金额将在审核通过后 1-3 个工作日内原路退回。`,
        ticketId: uuidv4().slice(0, 8),
      }
    });
  } catch (e) {
    console.error('[Actions] 退款申请失败:', e.message);
    res.status(500).json({ success: false, error: '退款申请失败' });
  }
});

// 人工复核（扣费异议等）
router.post('/manual-review', validateBody, (req, res) => {
  try {
    const { conversationId, visitorId, issue } = req.body || {};
    if (!issue || issue.trim().length < 10) {
      return res.status(400).json({ success: false, error: '请描述具体问题（至少10字）' });
    }
    if (issue.length > 500) {
      return res.status(400).json({ success: false, error: '问题描述过长（限500字）' });
    }

    const cleanIssue = issue.trim();
    logAction(conversationId, visitorId, 'manual_review', { issue: cleanIssue }, { message: '已转人工复核' }, 'submitted');

    res.json({
      success: true,
      data: {
        message: '已记录您的问题，人工客服将在工作日内为您复核处理。',
        ticketId: uuidv4().slice(0, 8),
      }
    });
  } catch (e) {
    console.error('[Actions] 人工复核失败:', e.message);
    res.status(500).json({ success: false, error: '提交复核失败' });
  }
});

module.exports = router;
