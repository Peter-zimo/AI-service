const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

// 客服状态常量
const AGENT_STATUS = {
  OFFLINE: 'offline',   // 离线
  ONLINE: 'online',     // 在线（可分配）
  BUSY: 'busy'          // 忙碌（处理中）
};

// 会话模式常量
const CONVERSATION_MODE = {
  AI: 'ai',         // AI模式
  QUEUE: 'queue',   // 排队中
  HUMAN: 'human'    // 人工模式
};

class HumanService {
  constructor() {
    this.agents = new Map();        // 客服集合：agentId -> agentInfo
    this.queue = [];                // 排队队列：[conversationId, ...]
    this.connections = new Map();   // WebSocket连接：agentId -> ws
    this.userConnections = new Map(); // 用户连接：conversationId -> ws
    this.loadAgents();
  }

  // 加载客服数据
  loadAgents() {
    const dataPath = path.join(__dirname, '../data/agents.json');
    try {
      if (fs.existsSync(dataPath)) {
        const data = fs.readFileSync(dataPath, 'utf-8');
        const agents = JSON.parse(data);
        agents.forEach(agent => {
          // 启动时所有客服设为离线
          agent.status = AGENT_STATUS.OFFLINE;
          agent.currentConversation = null;
          this.agents.set(agent.id, agent);
        });
        console.log(`[人工客服] 已加载 ${agents.length} 个客服账号`);
      } else {
        // 创建默认客服
        this.createDefaultAgent();
      }
    } catch (e) {
      console.error('[人工客服] 加载客服数据失败:', e.message);
      this.createDefaultAgent();
    }
  }

  // 创建默认客服
  createDefaultAgent() {
    const defaultAgent = {
      id: 'agent_001',
      name: '客服小A',
      avatar: '👩',
      password: 'CHANGE_ME_FIRST', // ⚠️ 首次部署必须修改默认密码
      status: AGENT_STATUS.OFFLINE,
      currentConversation: null,
      totalServed: 0,
      createdAt: new Date().toISOString()
    };
    this.agents.set(defaultAgent.id, defaultAgent);
    this.saveAgents();
    console.log('[人工客服] 已创建默认客服账号: agent_001 / CHANGE_ME_FIRST（请立即修改！）');
  }

  // 保存客服数据
  saveAgents() {
    const dataPath = path.join(__dirname, '../data/agents.json');
    try {
      const agents = Array.from(this.agents.values()).map(a => ({
        ...a,
        status: AGENT_STATUS.OFFLINE, // 保存时重置状态
        currentConversation: null
      }));
      fs.writeFileSync(dataPath, JSON.stringify(agents, null, 2), 'utf-8');
    } catch (e) {
      console.error('[人工客服] 保存客服数据失败:', e.message);
    }
  }

  // 客服登录（async，支持 bcrypt 哈希验证）
  async login(agentId, password) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, error: '客服账号不存在' };
    }

    // 兼容旧明文密码（首次启动自动迁移）
    let passwordMatch = false;
    if (agent.password.startsWith('$2b$') || agent.password.startsWith('$2a$')) {
      passwordMatch = await bcrypt.compare(password, agent.password);
    } else {
      // 旧明文：验证通过后自动升级为哈希
      if (agent.password === password) {
        passwordMatch = true;
        agent.password = await bcrypt.hash(password, 10);
        this.saveAgents();
        console.log(`[人工客服] 客服 ${agentId} 密码已自动升级为哈希存储`);
      }
    }

    if (!passwordMatch) {
      return { success: false, error: '密码错误' };
    }
    return {
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        totalServed: agent.totalServed
      }
    };
  }

  // 【P1-2安全修复】根据ID获取客服信息（用于WebSocket身份鉴权）
  getAgentById(agentId) {
    return this.agents.get(agentId) || null;
  }

  // 修改客服密码
  async changeAgentPassword(agentId, oldPassword, newPassword) {
    const result = await this.login(agentId, oldPassword);
    if (!result.success) return { success: false, error: '旧密码错误' };
    if (!newPassword || newPassword.length < 6) return { success: false, error: '新密码至少6位' };

    const agent = this.agents.get(agentId);
    agent.password = await bcrypt.hash(newPassword, 10);
    this.saveAgents();
    console.log(`[人工客服] 客服 ${agentId} 已修改密码`);
    return { success: true };
  }

  // 客服上线
  goOnline(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return { success: false, error: '客服不存在' };
    
    agent.status = AGENT_STATUS.ONLINE;
    console.log(`[人工客服] ${agent.name} 已上线`);
    
    // 尝试分配排队中的会话
    this.processQueue();
    return {
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar
      }
    };
  }

  // 客服下线
  goOffline(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    
    // 如果正在处理会话，将会话重新放入队列
    if (agent.currentConversation) {
      this.returnToQueue(agent.currentConversation);
      agent.currentConversation = null;
    }
    
    agent.status = AGENT_STATUS.OFFLINE;
    this.connections.delete(agentId);
    console.log(`[人工客服] ${agent.name} 已下线`);
    return true;
  }

  // 客服忙碌（开始处理会话）
  setBusy(agentId, conversationId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    
    agent.status = AGENT_STATUS.BUSY;
    agent.currentConversation = conversationId;
    console.log(`[人工客服] ${agent.name} 开始处理会话: ${conversationId}`);
    return true;
  }

  // 客服结束会话
  endConversation(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    
    const conversationId = agent.currentConversation;
    if (conversationId) {
      agent.totalServed++;
      agent.currentConversation = null;
      agent.status = AGENT_STATUS.ONLINE;
      console.log(`[人工客服] ${agent.name} 结束会话: ${conversationId}，总计服务: ${agent.totalServed}`);
      
      // 尝试分配下一个
      setTimeout(() => this.processQueue(), 1000);
      return conversationId;
    }
    return null;
  }

  // 用户请求转人工
  requestHuman(conversationId, visitorInfo = {}) {
    // 检查是否有在线客服
    const onlineAgents = this.getOnlineAgents();
    
    if (onlineAgents.length === 0) {
      return {
        success: false,
        error: '当前无客服在线',
        message: '当前无客服在线，请留言或稍后再试'
      };
    }

    // 检查是否已在队列中
    const queueIndex = this.queue.findIndex(q => q.conversationId === conversationId);
    if (queueIndex >= 0) {
      return {
        success: true,
        inQueue: true,
        position: queueIndex + 1,
        message: `当前排队位置：第${queueIndex + 1}位，请耐心等待`
      };
    }

    // 尝试直接分配
    const availableAgent = onlineAgents.find(a => a.status === AGENT_STATUS.ONLINE);
    if (availableAgent) {
      this.assignToAgent(conversationId, availableAgent.id, visitorInfo);
      return {
        success: true,
        inQueue: false,
        agent: {
          id: availableAgent.id,
          name: availableAgent.name,
          avatar: availableAgent.avatar
        },
        message: `已为您分配客服${availableAgent.name}，请描述您的问题`
      };
    }

    // 所有客服都忙，加入队列
    this.queue.push({
      conversationId,
      visitorInfo,
      queuedAt: new Date().toISOString()
    });

    const position = this.queue.length;
    console.log(`[人工客服] 会话 ${conversationId} 加入队列，当前位置: ${position}`);
    
    return {
      success: true,
      inQueue: true,
      position,
      message: `当前排队位置：第${position}位，请耐心等待`
    };
  }

  // 分配会话给客服
  assignToAgent(conversationId, agentId, visitorInfo) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    this.setBusy(agentId, conversationId);

    // 通知客服
    const ws = this.connections.get(agentId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'new_conversation',
        conversationId,
        visitorInfo,
        timestamp: new Date().toISOString()
      }));
    }

    // 通知用户
    const userWs = this.userConnections.get(conversationId);
    if (userWs && userWs.readyState === 1) {
      userWs.send(JSON.stringify({
        type: 'agent_assigned',
        agent: {
          id: agent.id,
          name: agent.name,
          avatar: agent.avatar
        },
        message: `客服${agent.name}已接入，请描述您的问题`
      }));
    }

    return true;
  }

  // 处理队列
  processQueue() {
    if (this.queue.length === 0) return;

    const onlineAgents = this.getOnlineAgents();
    const availableAgents = onlineAgents.filter(a => a.status === AGENT_STATUS.ONLINE);

    if (availableAgents.length === 0) return;

    // 分配队列中的会话
    while (this.queue.length > 0 && availableAgents.length > 0) {
      const queueItem = this.queue.shift();
      const agent = availableAgents.shift();
      
      this.assignToAgent(queueItem.conversationId, agent.id, queueItem.visitorInfo);
      
      // 更新队列中其他用户的位置
      this.notifyQueueUpdate();
    }
  }

  // 通知队列中的用户位置更新
  notifyQueueUpdate() {
    this.queue.forEach((item, index) => {
      const userWs = this.userConnections.get(item.conversationId);
      if (userWs && userWs.readyState === 1) {
        userWs.send(JSON.stringify({
          type: 'queue_update',
          position: index + 1,
          message: `当前排队位置：第${index + 1}位，请耐心等待`
        }));
      }
    });
  }

  // 会话重新放入队列（客服下线时）
  returnToQueue(conversationId) {
    const index = this.queue.findIndex(q => q.conversationId === conversationId);
    if (index < 0) {
      this.queue.unshift({
        conversationId,
        visitorInfo: {},
        queuedAt: new Date().toISOString()
      });
      this.notifyQueueUpdate();
    }
  }

  // 用户取消排队
  cancelQueue(conversationId) {
    const index = this.queue.findIndex(q => q.conversationId === conversationId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.notifyQueueUpdate();
      return true;
    }
    return false;
  }

  // 获取在线客服列表
  getOnlineAgents() {
    return Array.from(this.agents.values()).filter(
      a => a.status !== AGENT_STATUS.OFFLINE
    );
  }

  // 获取所有客服
  getAllAgents() {
    return Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      status: a.status,
      currentConversation: a.currentConversation,
      totalServed: a.totalServed
    }));
  }

  // 获取队列信息
  getQueueInfo() {
    return {
      length: this.queue.length,
      items: this.queue.map((q, i) => ({
        position: i + 1,
        conversationId: q.conversationId,
        queuedAt: q.queuedAt
      }))
    };
  }

  // 注册客服WebSocket
  registerAgentSocket(agentId, ws) {
    this.connections.set(agentId, ws);
    console.log(`[人工客服] 客服 ${agentId} WebSocket已连接`);
  }

  // 注册用户WebSocket
  registerUserSocket(conversationId, ws) {
    this.userConnections.set(conversationId, ws);
    console.log(`[人工客服] 用户 ${conversationId} WebSocket已连接`);
  }

  // 移除WebSocket
  removeSocket(ws) {
    // 查找并移除客服连接
    for (const [agentId, socket] of this.connections.entries()) {
      if (socket === ws) {
        this.goOffline(agentId);
        break;
      }
    }
    // 查找并移除用户连接
    for (const [convId, socket] of this.userConnections.entries()) {
      if (socket === ws) {
        this.userConnections.delete(convId);
        break;
      }
    }
  }

  // 转发消息给用户
  sendToUser(conversationId, message) {
    const ws = this.userConnections.get(conversationId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  // 转发消息给客服
  sendToAgent(agentId, message) {
    const ws = this.connections.get(agentId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  // 获取处理某会话的客服
  getAgentByConversation(conversationId) {
    for (const agent of this.agents.values()) {
      if (agent.currentConversation === conversationId) {
        return agent;
      }
    }
    return null;
  }
}

module.exports = new HumanService();
module.exports.AGENT_STATUS = AGENT_STATUS;
module.exports.CONVERSATION_MODE = CONVERSATION_MODE;
