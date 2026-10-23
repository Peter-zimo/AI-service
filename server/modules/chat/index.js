/**
 * chat 模块对外出口
 */

'use strict';

const chatService = require('./chat.service');

module.exports = {
  listRecentConversations: chatService.listRecentConversations,
};
