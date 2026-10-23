/**
 * 业务执行服务
 *
 * 读操作（Agent 直接调用）：订单列表 / 订单详情
 * 写操作（二次确认后调用）：申诉 / 退款 / 人工复核，均写审计日志
 *
 * 所有校验失败统一抛 ActionError(status, message)，由路由层映射为 HTTP。
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const repo = require('./actions.repo');
const { ActionError } = require('./errors');

// visitorId 格式白名单（与 chat 模块保持一致）
const VISITOR_ID_RE = /^v_\d{10,}_[a-z0-9]{4,20}$/;

const LIMITS = {
  ORDER_LIST: 20,
  REASON_MIN: 5,
  ISSUE_MIN: 10,
  TEXT_MAX: 500,
};

function isValidVisitorId(visitorId) {
  return !!visitorId && typeof visitorId === 'string' &&
    visitorId.length <= 64 && VISITOR_ID_RE.test(visitorId);
}

/** 写审计日志，失败不影响主流程 */
async function logAction(conversationId, visitorId, action, params, result, status) {
  try {
    await repo.insertActionLog({
      id: uuidv4(),
      conversationId,
      visitorId,
      action,
      params,
      result,
      status,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[Actions] 审计日志写入失败:', e.message);
  }
}

// ============ 读操作 ============

/**
 * 按手机号查订单列表
 * @param {string} phone
 */
async function listOrders(phone) {
  if (!phone || phone.length < 8) {
    throw new ActionError(400, '缺少手机号或格式无效');
  }

  const orders = await repo.findOrdersByPhone(phone, LIMITS.ORDER_LIST);
  const totalFee = orders.reduce((sum, o) => sum + (o.fee || 0), 0);

  return {
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
  };
}

/** 查订单详情 */
async function getOrder(id) {
  const order = await repo.findOrderById(id);
  if (!order) throw new ActionError(404, '订单不存在');

  return {
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
  };
}

// ============ 会话归属校验 ============

/**
 * 写操作前置校验：visitorId 合法 + 会话存在 + 归属匹配
 * @returns {Promise<void>}
 * @throws {ActionError}
 */
async function assertConversationOwnership(conversationId, visitorId) {
  if (!conversationId) throw new ActionError(400, '缺少 conversationId');
  if (!isValidVisitorId(visitorId)) throw new ActionError(400, 'visitorId 格式无效');

  let conversation;
  try {
    conversation = await repo.findConversationById(conversationId);
  } catch (e) {
    throw new ActionError(500, '校验会话失败');
  }

  if (!conversation) throw new ActionError(404, '会话不存在');
  if (conversation.visitor_id !== visitorId) throw new ActionError(403, '无权操作此会话');
}

// ============ 写操作 ============

function assertReason(reason, label) {
  if (!reason || reason.trim().length < LIMITS.REASON_MIN) {
    throw new ActionError(400, `缺少订单号或${label}原因（至少${LIMITS.REASON_MIN}字）`);
  }
  if (reason.length > LIMITS.TEXT_MAX) {
    throw new ActionError(400, `${label}原因过长（限${LIMITS.TEXT_MAX}字）`);
  }
}

/** 提交申诉 */
async function submitComplaint({ conversationId, visitorId, orderId, reason }) {
  if (!orderId) throw new ActionError(400, '缺少订单号或申诉原因（至少5字）');
  assertReason(reason, '申诉');

  const cleanReason = reason.trim();
  await logAction(
    conversationId, visitorId, 'complaint',
    { orderId, reason: cleanReason },
    { message: '申诉已提交，人工客服将在工作日内处理' },
    'submitted'
  );

  return {
    message: `申诉已提交！订单 ${orderId} 将在 1-3 个工作日内由人工客服审核处理，请留意通知。`,
    ticketId: uuidv4().slice(0, 8),
  };
}

/** 申请退款 */
async function submitRefund({ conversationId, visitorId, orderId, reason }) {
  if (!orderId) throw new ActionError(400, '缺少订单号或退款原因（至少5字）');
  assertReason(reason, '退款');

  const cleanReason = reason.trim();
  await logAction(
    conversationId, visitorId, 'refund',
    { orderId, reason: cleanReason },
    { message: '退款申请已提交' },
    'submitted'
  );

  return {
    message: `退款申请已提交！订单 ${orderId}，金额将在审核通过后 1-3 个工作日内原路退回。`,
    ticketId: uuidv4().slice(0, 8),
  };
}

/** 转人工复核（扣费异议等） */
async function submitManualReview({ conversationId, visitorId, issue }) {
  if (!issue || issue.trim().length < LIMITS.ISSUE_MIN) {
    throw new ActionError(400, `请描述具体问题（至少${LIMITS.ISSUE_MIN}字）`);
  }
  if (issue.length > LIMITS.TEXT_MAX) {
    throw new ActionError(400, `问题描述过长（限${LIMITS.TEXT_MAX}字）`);
  }

  const cleanIssue = issue.trim();
  await logAction(
    conversationId, visitorId, 'manual_review',
    { issue: cleanIssue },
    { message: '已转人工复核' },
    'submitted'
  );

  return {
    message: '已记录您的问题，人工客服将在工作日内为您复核处理。',
    ticketId: uuidv4().slice(0, 8),
  };
}

module.exports = {
  isValidVisitorId,
  listOrders,
  getOrder,
  assertConversationOwnership,
  submitComplaint,
  submitRefund,
  submitManualReview,
};
