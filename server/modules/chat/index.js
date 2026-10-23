/**
 * chat 模块对外出口
 *
 * 结构：
 *   chat.repo.js             数据访问（唯一写 SQL 的地方）
 *   chat.service.js          后台会话列表查询
 *   message.service.js       消息主链路（校验→敏感词→落库→分流→AI）
 *   conversation.service.js  会话生命周期（创建/历史/评价/关闭/转人工/导出）
 *   ai-runner.js             LangChain 流式执行与降级链
 *   stream-session.js        SSE 流式会话注册表
 *   queue.js                 会话级串行队列
 *   validator.js             访客身份与归属校验
 *
 * 外部只允许 require('../modules/chat')。
 */

'use strict';

const messageService = require('./message.service');
const conversationService = require('./conversation.service');
const streamSession = require('./stream-session');

module.exports = {
  // 后台会话列表
  listRecentConversations: conversationService.listRecentConversations,

  // 消息
  sendMessage: messageService.sendMessage,

  // 会话
  createConversation: conversationService.createConversation,
  getConversationById: conversationService.getConversationById,
  getHistory: conversationService.getHistory,
  getStatus: conversationService.getStatus,
  getConversationStats: conversationService.getConversationStats,
  getDashboardStats: conversationService.getDashboardStats,
  rate: conversationService.rate,
  closeConversation: conversationService.closeConversation,
  transferToHuman: conversationService.transferToHuman,
  cancelQueue: conversationService.cancelQueue,
  exportConversationsCsv: conversationService.exportConversationsCsv,

  // 客服工作台
  addAgentMessage: conversationService.addAgentMessage,
  closeByAgent: conversationService.closeByAgent,
  getMessages: conversationService.getMessages,

  // SSE
  attachSse: streamSession.attachSse,
};

// 启动会话超时检查（与原 services/database.js 一致：模块加载即启动）
require('./conversation.scheduler').start();
