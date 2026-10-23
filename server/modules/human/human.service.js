/**
 * 人工客服编排
 *
 * 组合三个基础件：坐席注册表（agent.registry）、排队队列（queue）、
 * WebSocket 连接（sockets）。所有「策略」都在这里：上下线、分配、排队推进、广播。
 */

'use strict';

const registry = require('./agent.registry');
const queue = require('./queue');
const sockets = require('./sockets');

const { AGENT_STATUS } = registry;

// ============ 坐席状态 ============

function goOnline(agentId) {
  const agent = registry.getRaw(agentId);
  if (!agent) return { success: false, error: '客服不存在' };

  registry.setStatus(agentId, AGENT_STATUS.ONLINE);
  console.log(`[人工客服] ${agent.name} 已上线`);

  processQueue();

  return {
    success: true,
    agent: { id: agent.id, name: agent.name, avatar: agent.avatar },
  };
}

function goOffline(agentId) {
  const agent = registry.getRaw(agentId);
  if (!agent) return false;

  // 正在处理的会话要退回队列，不能让用户干等
  if (agent.currentConversation) {
    returnToQueue(agent.currentConversation);
    registry.setCurrentConversation(agentId, null);
  }

  registry.setStatus(agentId, AGENT_STATUS.OFFLINE);
  sockets.unregisterAgent(agentId);
  console.log(`[人工客服] ${agent.name} 已下线`);
  return true;
}

function setBusy(agentId, conversationId) {
  const agent = registry.getRaw(agentId);
  if (!agent) return false;

  registry.setStatus(agentId, AGENT_STATUS.BUSY);
  registry.setCurrentConversation(agentId, conversationId);
  console.log(`[人工客服] ${agent.name} 开始处理会话: ${conversationId}`);
  return true;
}

/** 结束当前会话，返回被结束的 conversationId */
function endConversation(agentId) {
  const agent = registry.getRaw(agentId);
  if (!agent) return null;

  const conversationId = agent.currentConversation;
  if (!conversationId) return null;

  registry.incrementServed(agentId);
  registry.setCurrentConversation(agentId, null);
  registry.setStatus(agentId, AGENT_STATUS.ONLINE);
  console.log(`[人工客服] ${agent.name} 结束会话: ${conversationId}，总计服务: ${agent.totalServed}`);

  // 错开一拍再分配，给前端留出渲染时间
  setTimeout(() => processQueue(), 1000);
  return conversationId;
}

// ============ 转人工与分配 ============

function requestHuman(conversationId, visitorInfo = {}) {
  const onlineAgents = registry.listOnline();

  if (onlineAgents.length === 0) {
    return {
      success: false,
      error: '当前无客服在线',
      message: '当前无客服在线，请留言或稍后再试',
    };
  }

  // 已在队列中：直接回报当前位置
  if (queue.has(conversationId)) {
    const position = queue.indexOf(conversationId) + 1;
    return {
      success: true,
      inQueue: true,
      position,
      message: `当前排队位置：第${position}位，请耐心等待`,
    };
  }

  // 有空闲坐席：直接分配
  const available = onlineAgents.find(a => a.status === AGENT_STATUS.ONLINE);
  if (available) {
    assignToAgent(conversationId, available.id, visitorInfo);
    return {
      success: true,
      inQueue: false,
      agent: { id: available.id, name: available.name, avatar: available.avatar },
      message: `已为您分配客服${available.name}，请描述您的问题`,
    };
  }

  // 全忙：入队
  const position = queue.enqueue(conversationId, visitorInfo);
  console.log(`[人工客服] 会话 ${conversationId} 加入队列，当前位置: ${position}`);

  return {
    success: true,
    inQueue: true,
    position,
    message: `当前排队位置：第${position}位，请耐心等待`,
  };
}

function assignToAgent(conversationId, agentId, visitorInfo) {
  const agent = registry.getRaw(agentId);
  if (!agent) return false;

  setBusy(agentId, conversationId);

  sockets.sendToAgent(agentId, {
    type: 'new_conversation',
    conversationId,
    visitorInfo,
    timestamp: new Date().toISOString(),
  });

  sockets.sendToUser(conversationId, {
    type: 'agent_assigned',
    agent: { id: agent.id, name: agent.name, avatar: agent.avatar },
    message: `客服${agent.name}已接入，请描述您的问题`,
  });

  return true;
}

function processQueue() {
  if (queue.length() === 0) return;

  const available = registry.listOnline().filter(a => a.status === AGENT_STATUS.ONLINE);
  if (available.length === 0) return;

  while (queue.length() > 0 && available.length > 0) {
    const item = queue.dequeue();
    const agent = available.shift();
    assignToAgent(item.conversationId, agent.id, item.visitorInfo);
    notifyQueueUpdate();
  }
}

/** 广播排队位置变化 */
function notifyQueueUpdate() {
  queue.snapshot().forEach((item, index) => {
    sockets.sendToUser(item.conversationId, {
      type: 'queue_update',
      position: index + 1,
      message: `当前排队位置：第${index + 1}位，请耐心等待`,
    });
  });
}

function returnToQueue(conversationId) {
  if (!queue.has(conversationId)) {
    queue.unshift(conversationId, {});
    notifyQueueUpdate();
  }
}

function cancelQueue(conversationId) {
  if (queue.remove(conversationId)) {
    notifyQueueUpdate();
    return true;
  }
  return false;
}

// ============ 查询 ============

function getQueueInfo() {
  return { length: queue.length(), items: queue.list() };
}

function getAllAgents() {
  return registry.listAll();
}

function getAgentById(agentId) {
  return registry.getRaw(agentId);
}

function getAgentView(agentId) {
  return registry.getView(agentId);
}

function getAgentByConversation(conversationId) {
  return registry.findByConversation(conversationId);
}

// ============ WebSocket ============

function registerAgentSocket(agentId, ws) {
  sockets.registerAgent(agentId, ws);
}

function registerUserSocket(conversationId, ws) {
  sockets.registerUser(conversationId, ws);
}

function removeSocket(ws) {
  const owner = sockets.removeBySocket(ws);
  if (owner.agentId) goOffline(owner.agentId);
}

function sendToUser(conversationId, message) {
  return sockets.sendToUser(conversationId, message);
}

function sendToAgent(agentId, message) {
  return sockets.sendToAgent(agentId, message);
}

// ============ 账号 ============

function login(agentId, password) {
  return registry.login(agentId, password);
}

function changePassword(agentId, oldPassword, newPassword) {
  return registry.changePassword(agentId, oldPassword, newPassword);
}

module.exports = {
  goOnline,
  goOffline,
  setBusy,
  endConversation,
  requestHuman,
  assignToAgent,
  processQueue,
  notifyQueueUpdate,
  returnToQueue,
  cancelQueue,
  getQueueInfo,
  getAllAgents,
  getAgentById,
  getAgentView,
  getAgentByConversation,
  registerAgentSocket,
  registerUserSocket,
  removeSocket,
  sendToUser,
  sendToAgent,
  login,
  changePassword,
};
