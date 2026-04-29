const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const humanService = require('../services/human');
const db = require('../services/database');

// 客服登录
router.post('/login', async (req, res) => {
  try {
    const { agentId, password } = req.body || {};
    if (!agentId || !password) {
      return res.status(400).json({ success: false, error: '缺少账号或密码' });
    }

    const result = await humanService.login(agentId, password);
    res.json(result);
  } catch (error) {
    console.error('客服登录失败:', error);
    res.status(500).json({ success: false, error: '登录失败' });
  }
});

// 客服上线
router.post('/online', (req, res) => {
  try {
    const { agentId } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ success: false, error: '缺少agentId' });
    }

    const result = humanService.goOnline(agentId);
    res.json(result);
  } catch (error) {
    console.error('客服上线失败:', error);
    res.status(500).json({ success: false, error: '上线失败' });
  }
});

// 客服下线
router.post('/offline', (req, res) => {
  try {
    const { agentId } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ success: false, error: '缺少agentId' });
    }

    humanService.goOffline(agentId);
    res.json({ success: true, message: '已下线' });
  } catch (error) {
    console.error('客服下线失败:', error);
    res.status(500).json({ success: false, error: '下线失败' });
  }
});

// 获取客服信息
router.get('/agent/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = humanService.agents.get(agentId);
    
    if (!agent) {
      return res.status(404).json({ success: false, error: '客服不存在' });
    }

    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        status: agent.status,
        currentConversation: agent.currentConversation,
        totalServed: agent.totalServed
      }
    });
  } catch (error) {
    console.error('获取客服信息失败:', error);
    res.status(500).json({ success: false, error: '获取客服信息失败' });
  }
});

// 获取所有客服状态（管理用）
router.get('/agents', (req, res) => {
  try {
    const agents = humanService.getAllAgents();
    res.json({ success: true, agents });
  } catch (error) {
    console.error('获取客服列表失败:', error);
    res.status(500).json({ success: false, error: '获取客服列表失败' });
  }
});

// 获取队列信息
router.get('/queue', (req, res) => {
  try {
    const queueInfo = humanService.getQueueInfo();
    res.json({ success: true, queue: queueInfo });
  } catch (error) {
    console.error('获取队列信息失败:', error);
    res.status(500).json({ success: false, error: '获取队列信息失败' });
  }
});

// 客服发送消息给用户
router.post('/send-message', (req, res) => {
  try {
    const { agentId, conversationId, message } = req.body || {};
    if (!agentId || !conversationId || !message) {
      return res.status(400).json({ success: false, error: '缺少必要参数' });
    }

    const agent = humanService.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ success: false, error: '客服不存在' });
    }
    if (agent.currentConversation !== conversationId) {
      return res.status(403).json({ success: false, error: '您没有处理该会话' });
    }

    // 保存消息
    db.messages.add(uuidv4(), conversationId, 'agent', message);

    // 通过WebSocket发送给用户
    const sent = humanService.sendToUser(conversationId, {
      type: 'agent_message',
      message,
      agentName: agent.name,
      agentAvatar: agent.avatar,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, delivered: sent });
  } catch (error) {
    console.error('发送消息失败:', error);
    res.status(500).json({ success: false, error: '发送消息失败' });
  }
});

// 客服结束会话
router.post('/end-conversation', (req, res) => {
  try {
    const { agentId, conversationId } = req.body || {};
    if (!agentId || !conversationId) {
      return res.status(400).json({ success: false, error: '缺少必要参数' });
    }

    const agent = humanService.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ success: false, error: '客服不存在' });
    }
    if (agent.currentConversation !== conversationId) {
      return res.status(403).json({ success: false, error: '您没有处理该会话' });
    }

    // 结束会话
    const endedId = humanService.endConversation(agentId);
    if (endedId) {
      // 更新会话状态
      db.conversations.close(endedId, 'agent_ended');
      
      // 通知用户会话已结束
      humanService.sendToUser(conversationId, {
        type: 'conversation_ended',
        message: '客服已结束会话，请对本次服务进行评价',
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true, message: '会话已结束' });
  } catch (error) {
    console.error('结束会话失败:', error);
    res.status(500).json({ success: false, error: '结束会话失败' });
  }
});

// 获取会话历史（客服用）
router.get('/history/:conversationId', (req, res) => {
  try {
    const { conversationId } = req.params;
    const messages = db.messages.getByConversation(conversationId);
    const conversation = db.conversations.getById(conversationId);
    
    res.json({
      success: true,
      conversation: conversation ? {
        id: conversation.id,
        visitorName: conversation.visitor_name,
        status: conversation.status,
        mode: conversation.mode,
        createdAt: conversation.created_at
      } : null,
      messages
    });
  } catch (error) {
    console.error('获取历史失败:', error);
    res.status(500).json({ success: false, error: '获取历史失败' });
  }
});

module.exports = router;
