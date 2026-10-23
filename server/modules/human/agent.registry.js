/**
 * 坐席注册表
 *
 * 负责坐席账号的加载/持久化/登录校验/在线状态。
 * 不涉及排队与 WebSocket——那些在 queue.js 与 sockets.js。
 *
 * 数据存在 data/agents.json（明文文件，密码为 bcrypt 哈希）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

// 允许用环境变量覆盖数据文件路径：测试必须指到临时文件，
// 否则登录时的密码哈希升级会把测试账号写进真实配置
const DATA_PATH = process.env.AGENTS_DATA_PATH ||
  path.join(__dirname, '../../data/agents.json');

const AGENT_STATUS = {
  OFFLINE: 'offline', // 离线
  ONLINE: 'online',   // 在线（可分配）
  BUSY: 'busy',       // 忙碌（处理中）
};

/** agentId -> agentInfo */
const agents = new Map();

function load() {
  try {
    if (!fs.existsSync(DATA_PATH)) {
      createDefault();
      return;
    }

    const list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    list.forEach(agent => {
      // 启动时所有坐席置为离线，不沿用上次运行状态
      agent.status = AGENT_STATUS.OFFLINE;
      agent.currentConversation = null;
      agents.set(agent.id, agent);
    });
    console.log(`[人工客服] 已加载 ${list.length} 个客服账号`);
  } catch (e) {
    console.error('[人工客服] 加载客服数据失败:', e.message);
    createDefault();
  }
}

function createDefault() {
  const agent = {
    id: 'agent_001',
    name: '客服小A',
    avatar: '👩',
    password: 'CHANGE_ME_FIRST', // ⚠️ 首次部署必须修改默认密码
    status: AGENT_STATUS.OFFLINE,
    currentConversation: null,
    totalServed: 0,
    createdAt: new Date().toISOString(),
  };

  agents.set(agent.id, agent);
  save();
  console.log('[人工客服] 已创建默认客服账号: agent_001 / CHANGE_ME_FIRST（请立即修改！）');
}

function save() {
  try {
    // 落盘时重置运行时状态，避免把 online/busy 写进文件
    const list = Array.from(agents.values()).map(a => ({
      ...a,
      status: AGENT_STATUS.OFFLINE,
      currentConversation: null,
    }));
    fs.writeFileSync(DATA_PATH, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    console.error('[人工客服] 保存客服数据失败:', e.message);
  }
}

// ============ 查询 ============

/** 原始对象（内部使用，含密码） */
function getRaw(agentId) {
  return agents.get(agentId) || null;
}

/** 对外视图（不含密码） */
function toView(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar,
    status: agent.status,
    currentConversation: agent.currentConversation,
    totalServed: agent.totalServed,
  };
}

function getView(agentId) {
  return toView(getRaw(agentId));
}

function listAll() {
  return Array.from(agents.values()).map(toView);
}

/** 非离线（online + busy） */
function listOnline() {
  return Array.from(agents.values()).filter(a => a.status !== AGENT_STATUS.OFFLINE);
}

/** 当前正在处理该会话的坐席 */
function findByConversation(conversationId) {
  for (const agent of agents.values()) {
    if (agent.currentConversation === conversationId) return agent;
  }
  return null;
}

// ============ 状态 ============

function setStatus(agentId, status) {
  const agent = getRaw(agentId);
  if (!agent) return false;
  agent.status = status;
  return true;
}

function setCurrentConversation(agentId, conversationId) {
  const agent = getRaw(agentId);
  if (!agent) return false;
  agent.currentConversation = conversationId;
  return true;
}

function incrementServed(agentId) {
  const agent = getRaw(agentId);
  if (!agent) return false;
  agent.totalServed++;
  return true;
}

// ============ 登录与密码 ============

async function login(agentId, password) {
  const agent = getRaw(agentId);
  if (!agent) return { success: false, error: '客服账号不存在' };

  let matched = false;

  if (agent.password.startsWith('$2b$') || agent.password.startsWith('$2a$')) {
    matched = await bcrypt.compare(password, agent.password);
  } else if (agent.password === password) {
    // 旧明文密码：校验通过后自动升级为哈希
    matched = true;
    agent.password = await bcrypt.hash(password, 10);
    save();
    console.log(`[人工客服] 客服 ${agentId} 密码已自动升级为哈希存储`);
  }

  if (!matched) return { success: false, error: '密码错误' };

  return {
    success: true,
    agent: {
      id: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      totalServed: agent.totalServed,
    },
  };
}

async function changePassword(agentId, oldPassword, newPassword) {
  const result = await login(agentId, oldPassword);
  if (!result.success) return { success: false, error: '旧密码错误' };
  if (!newPassword || newPassword.length < 6) return { success: false, error: '新密码至少6位' };

  const agent = getRaw(agentId);
  agent.password = await bcrypt.hash(newPassword, 10);
  save();
  console.log(`[人工客服] 客服 ${agentId} 已修改密码`);
  return { success: true };
}

/**
 * 测试接缝
 *
 * 白盒测试需要注入指定 id 的坐席并清空状态。
 * 正式代码不要用——对外一律走 getView / listAll。
 */
const _test = {
  agents,
  reset() {
    agents.clear();
  },
};

module.exports = {
  AGENT_STATUS,
  load,
  save,
  getRaw,
  getView,
  listAll,
  listOnline,
  findByConversation,
  setStatus,
  setCurrentConversation,
  incrementServed,
  login,
  changePassword,
  _test,
};
