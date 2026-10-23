/**
 * WebSocket 连接注册表
 *
 * 只维护「谁连着」与「往哪发」，不关心业务语义。
 */

'use strict';

const OPEN = 1;

/** agentId -> ws */
const agentSockets = new Map();
/** conversationId -> ws */
const userSockets = new Map();

function registerAgent(agentId, ws) {
  agentSockets.set(agentId, ws);
  console.log(`[人工客服] 客服 ${agentId} WebSocket已连接`);
}

function registerUser(conversationId, ws) {
  userSockets.set(conversationId, ws);
  console.log(`[人工客服] 用户 ${conversationId} WebSocket已连接`);
}

function unregisterAgent(agentId) {
  agentSockets.delete(agentId);
}

/**
 * 按 socket 反查并移除
 * @returns {{agentId?: string, conversationId?: string}} 命中的归属，供调用方做后续处理
 */
function removeBySocket(ws) {
  for (const [agentId, socket] of agentSockets.entries()) {
    if (socket === ws) {
      agentSockets.delete(agentId);
      return { agentId };
    }
  }

  for (const [conversationId, socket] of userSockets.entries()) {
    if (socket === ws) {
      userSockets.delete(conversationId);
      return { conversationId };
    }
  }

  return {};
}

function sendToUser(conversationId, message) {
  const ws = userSockets.get(conversationId);
  if (ws && ws.readyState === OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function sendToAgent(agentId, message) {
  const ws = agentSockets.get(agentId);
  if (ws && ws.readyState === OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

module.exports = {
  registerAgent,
  registerUser,
  unregisterAgent,
  removeBySocket,
  sendToUser,
  sendToAgent,
};
