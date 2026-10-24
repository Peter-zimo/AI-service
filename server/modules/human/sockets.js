/**
 * WebSocket 连接注册表（薄封装）
 *
 * 实现已下沉到 infra/state/socket-registry，本文件保持原有导出形状。
 */

'use strict';

const state = require('../../infra/state');

module.exports = {
  registerAgent: (agentId, ws) => state.sockets.registerAgent(agentId, ws),
  registerUser: (conversationId, ws) => state.sockets.registerUser(conversationId, ws),
  unregisterAgent: (agentId) => state.sockets.unregisterAgent(agentId),
  removeBySocket: (ws) => state.sockets.removeBySocket(ws),
  sendToUser: (conversationId, message) => state.sockets.sendToUser(conversationId, message),
  sendToAgent: (agentId, message) => state.sockets.sendToAgent(agentId, message),
};
