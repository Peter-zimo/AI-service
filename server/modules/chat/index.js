/**
 * chat 模块对外出口
 */

'use strict';

const chatService = require('./chat.service');
const repo = require('./chat.repo');

module.exports = {
  listRecentConversations: chatService.listRecentConversations,
  repo,
};
