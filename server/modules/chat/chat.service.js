/**
 * 会话业务服务
 *
 * 当前仅承载后台会话列表；消息收发主链路（原 routes/chat.js 的 /message）
 * 将在 B2 迁入本模块的 message.service.js。
 */

'use strict';

const repo = require('./chat.repo');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * 后台会话列表
 * @param {number|string} rawLimit
 * @returns {Promise<Array>} 会话数组，最后一条消息收敛为 lastMessage 字段
 */
async function listRecentConversations(rawLimit) {
  const parsed = parseInt(rawLimit, 10);
  const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await repo.listRecentConversations(limit);

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

module.exports = { listRecentConversations, DEFAULT_LIMIT, MAX_LIMIT };
