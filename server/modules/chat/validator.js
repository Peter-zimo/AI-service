/**
 * 访客身份校验
 *
 * 访客侧接口必须携带 visitorId，且必须与该会话的 visitor_id 一致。
 * 格式校验复用 utils/visitor-id，避免与 actions / WebSocket 各写一份正则。
 */

'use strict';

const { isValidVisitorId } = require('../../utils/visitor-id');

/**
 * @param {unknown} visitorId
 * @returns {boolean}
 */
function validateVisitorId(visitorId) {
  return isValidVisitorId(visitorId);
}

/**
 * 强制校验访客身份与会话所有权
 * @param {object|null} conversation
 * @param {string} visitorId
 * @returns {string|null} null 表示通过；否则返回错误文案
 */
function enforceVisitorAccess(conversation, visitorId) {
  if (!visitorId) return '缺少visitorId';
  if (!validateVisitorId(visitorId)) return 'visitorId格式无效';
  if (!conversation) return '会话不存在';
  if (conversation.visitor_id !== visitorId) return '无权访问此会话';
  return null;
}

module.exports = { validateVisitorId, enforceVisitorAccess };
