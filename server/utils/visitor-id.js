/**
 * 访客标识（visitorId）校验
 *
 * 格式：v_<10 位以上数字>_<4~20 位小写字母数字>
 *
 * 之所以单独成文件：chat 模块、actions 模块、WebSocket 鉴权三处都要用，
 * 各写一份正则迟早会不一致（重构前就是三份重复）。
 */

'use strict';

const VISITOR_ID_RE = /^v_\d{10,}_[a-z0-9]{4,20}$/;
const MAX_VISITOR_ID_LENGTH = 64;

/**
 * @param {unknown} visitorId
 * @returns {boolean}
 */
function isValidVisitorId(visitorId) {
  if (!visitorId || typeof visitorId !== 'string') return false;
  if (visitorId.length > MAX_VISITOR_ID_LENGTH) return false;
  return VISITOR_ID_RE.test(visitorId);
}

module.exports = { VISITOR_ID_RE, MAX_VISITOR_ID_LENGTH, isValidVisitorId };
