/**
 * 访客身份校验
 *
 * 访客侧接口必须携带 visitorId，且必须与该会话的 visitor_id 一致。
 * 抽成独立文件是因为 create / message / history / rate / close / status /
 * transfer / cancel-queue 八个入口都要用，散着写迟早不一致。
 */

'use strict';

/** visitorId 格式白名单：v_<10位以上时间戳>_<4~20位小写字母数字> */
const VISITOR_ID_RE = /^v_\d{10,}_[a-z0-9]{4,20}$/;
const MAX_VISITOR_ID_LENGTH = 64;

/**
 * @param {unknown} visitorId
 * @returns {boolean}
 */
function validateVisitorId(visitorId) {
  if (!visitorId || typeof visitorId !== 'string') return false;
  if (visitorId.length > MAX_VISITOR_ID_LENGTH) return false;
  return VISITOR_ID_RE.test(visitorId);
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

module.exports = { VISITOR_ID_RE, validateVisitorId, enforceVisitorAccess };
