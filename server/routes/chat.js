const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const aiService = require('../services/ai');
const sensitiveService = require('../services/sensitive');
const humanService = require('../services/human');
const XLSX = require('xlsx');

// visitorId 格式白名单正则
const VISITOR_ID_RE = /^v_\d{10,}_[a-z0-9]{4,20}$/;

function validateVisitorId(visitorId) {
  if (!visitorId || typeof visitorId !== 'string') return false;
  if (visitorId.length > 64) return false;
  return VISITOR_ID_RE.test(visitorId);
}

// 创建新对话
router.post('/create', (req, res) => {
  try {
    const { visitorId, visitorName } = req.body || {};
    if (!visitorId) {
      return res.status(400).json({ success: false, error: '缺少visitorId' });
    }
    // visitorId 格式校验
    if (!validateVisitorId(visitorId)) {
      return res.status(400).json({ success: false, error: 'visitorId格式无效' });
    }
    const conversationId = uuidv4();
    console.log('[创建会话] db.conversations 类型:', typeof db.conversations);
    console.log('[创建会话] db.conversations.create:', typeof db.conversations?.create);
    const result = db.conversations.create(conversationId, visitorId, visitorName || '访客');
    console.log('[创建会话] 结果:', result);
    db.stats.incrementConversations();
    res.json({ success: true, conversationId });
  } catch (error) {
    console.error('创建对话失败:', error);
    res.status(500).json({ success: false, error: '创建对话失败，请稍后重试' });
  }
});

// 发送消息
router.post('/message', async (req, res) => {
  try {
    const { conversationId, message, visitorId } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: '消息不能为空' });
    }
    if (typeof message !== 'string' || message.length > 2000) {
      return res.status(400).json({ success: false, error: '消息长度不能超过2000字符' });
    }
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }
    if (visitorId && !validateVisitorId(visitorId)) {
      return res.status(400).json({ success: false, error: 'visitorId格式无效' });
    }

    // 检查会话是否存在且未关闭
    const conversation = db.conversations.getById(conversationId);
    if (!conversation) {
      return res.status(400).json({ success: false, error: '会话不存在' });
    }
    if (conversation.status === db.conversations.STATUS.CLOSED) {
      return res.status(400).json({ 
        success: false, 
        error: '会话已结束，请刷新页面开始新对话',
        code: 'CONVERSATION_CLOSED'
      });
    }
    
    // 【P3-3安全修复】校验 visitorId 是否属于该会话
    if (visitorId) {
      if (!validateVisitorId(visitorId)) {
        return res.status(400).json({ success: false, error: 'visitorId格式无效' });
      }
      if (conversation.visitor_id !== visitorId) {
        return res.status(403).json({ success: false, error: '无权在此会话中发言' });
      }
    }

    const trimmedMessage = message.trim();

    // 敏感词检测 - 用户输入
    const sensitiveCheck = sensitiveService.detect(trimmedMessage);
    if (sensitiveCheck.hasSensitive) {
      // 记录日志
      sensitiveService.logDetection(conversationId, 'user', trimmedMessage, sensitiveCheck, visitorId);
      return res.status(400).json({
        success: false,
        error: '消息包含敏感内容，请修改后重试',
        code: 'SENSITIVE_WORD_DETECTED',
        sensitiveWords: sensitiveCheck.words
      });
    }

    // 更新会话最后消息时间
    db.conversations.updateLastMessage(conversationId);

    // 保存用户消息
    db.messages.add(uuidv4(), conversationId, 'user', trimmedMessage);
    db.stats.incrementMessages();

    // 检查会话模式
    const updatedConversation = db.conversations.getById(conversationId);
    
    // 如果是人工模式，转发给客服
    if (updatedConversation.mode === db.conversations.MODE.HUMAN) {
      const agent = humanService.getAgentByConversation(conversationId);
      if (agent) {
        // 通过WebSocket转发给客服
        humanService.sendToAgent(agent.id, {
          type: 'user_message',
          conversationId,
          message: trimmedMessage,
          timestamp: new Date().toISOString()
        });
        
        res.json({
          success: true,
          response: {
            message: '',  // 人工模式下不立即返回消息
            type: 'human_pending',
            confidence: 1
          },
          conversation: {
            status: updatedConversation.status,
            mode: updatedConversation.mode,
            agentName: updatedConversation.agent_name,
            lastMessageAt: updatedConversation.last_message_at
          }
        });
        return;
      }
    }

    // AI处理（非人工模式或客服不在线）
    let aiResponse = await aiService.chat(conversationId, trimmedMessage);

    // 敏感词检测 - AI回复
    const aiSensitiveCheck = sensitiveService.detect(aiResponse.answer);
    if (aiSensitiveCheck.hasSensitive) {
      // 记录日志
      sensitiveService.logDetection(conversationId, 'ai', aiResponse.answer, aiSensitiveCheck, visitorId);
      console.log(`[敏感词] AI回复包含敏感词，已替换: ${aiSensitiveCheck.words.join(', ')}`);
      // 替换为安全回复（使用新的兜底消息）
      aiResponse = {
        type: 'fallback',
        answer: '抱歉，根据我的知识库，暂时没有找到与您问题相关的信息。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系真人客服获得帮助\n\n感谢您的理解！',
        confidence: 0.3
      };
    }

    // 保存AI回复
    db.messages.add(uuidv4(), conversationId, 'assistant', aiResponse.answer, aiResponse.confidence || null);

    if (['knowledge', 'ai', 'filtered'].includes(aiResponse.type)) {
      db.stats.incrementAiHandled();
    }

    res.json({
      success: true,
      response: {
        message: aiResponse.answer,
        type: aiResponse.type,
        confidence: aiResponse.confidence,
        matchQuestion: aiResponse.matchQuestion || null
      },
      conversation: {
        status: updatedConversation.status,
        mode: updatedConversation.mode,
        lastMessageAt: updatedConversation.last_message_at
      }
    });
  } catch (error) {
    console.error('发送消息失败:', error);
    res.status(500).json({ success: false, error: '处理消息失败，请稍后重试' });
  }
});

// 获取对话历史
router.get('/history/:conversationId', (req, res) => {
  try {
    const { conversationId } = req.params;
    const { visitorId } = req.query; // 访客端必须传递 visitorId
    
    // 【P3-3安全修复】校验 visitorId 是否属于该会话
    if (visitorId) {
      if (!validateVisitorId(visitorId)) {
        return res.status(400).json({ success: false, error: 'visitorId格式无效' });
      }
      const conversation = db.conversations.getById(conversationId);
      if (!conversation) {
        return res.status(404).json({ success: false, error: '会话不存在' });
      }
      if (conversation.visitor_id !== visitorId) {
        return res.status(403).json({ success: false, error: '无权访问此会话' });
      }
    }
    
    const messages = db.messages.getByConversation(conversationId);
    res.json({ success: true, messages });
  } catch (error) {
    console.error('获取历史失败:', error);
    res.status(500).json({ success: false, error: '获取历史失败' });
  }
});


// 注意：/list 路由已移至 index.js 管理 API 区（需 basicAuth）



// 评价对话
router.post('/rate', (req, res) => {
  try {
    const { conversationId, score, comment, visitorId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }
    
    // 【P3-3安全修复】校验 visitorId 是否属于该会话
    if (visitorId) {
      if (!validateVisitorId(visitorId)) {
        return res.status(400).json({ success: false, error: 'visitorId格式无效' });
      }
      const conversation = db.conversations.getById(conversationId);
      if (!conversation) {
        return res.status(404).json({ success: false, error: '会话不存在' });
      }
      if (conversation.visitor_id !== visitorId) {
        return res.status(403).json({ success: false, error: '无权评价此会话' });
      }
    }
    
    const validScore = Math.min(5, Math.max(1, parseInt(score) || 3));
    db.ratings.add(uuidv4(), conversationId, validScore, comment || null);
    db.conversations.close(conversationId, 'rated');
    aiService.clearHistory(conversationId);
    res.json({ success: true });
  } catch (error) {
    console.error('评价失败:', error);
    res.status(500).json({ success: false, error: '评价失败' });
  }
});

// 手动关闭会话
router.post('/close', (req, res) => {
  try {
    const { conversationId, visitorId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }
    
    const conversation = db.conversations.getById(conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }
    
    // 【P3-3安全修复】访客端关闭会话必须校验 visitorId
    // 管理端请求不带 visitorId（通过 admin 认证已有权限）
    if (visitorId) {
      if (!validateVisitorId(visitorId)) {
        return res.status(400).json({ success: false, error: 'visitorId格式无效' });
      }
      if (conversation.visitor_id !== visitorId) {
        return res.status(403).json({ success: false, error: '无权关闭此会话' });
      }
    }
    
    if (conversation.status === db.conversations.STATUS.CLOSED) {
      return res.json({ success: true, message: '会话已处于关闭状态' });
    }
    
    db.conversations.close(conversationId, 'manual');
    aiService.clearHistory(conversationId);
    
    res.json({ success: true, message: '会话已关闭' });
  } catch (error) {
    console.error('关闭会话失败:', error);
    res.status(500).json({ success: false, error: '关闭会话失败' });
  }
});

// 获取会话状态
router.get('/status/:conversationId', (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = db.conversations.getById(conversationId);
    
    if (!conversation) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }
    
    res.json({
      success: true,
      status: conversation.status,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      lastMessageAt: conversation.last_message_at,
      closedAt: conversation.closed_at,
      closeReason: conversation.close_reason
    });
  } catch (error) {
    console.error('获取会话状态失败:', error);
    res.status(500).json({ success: false, error: '获取会话状态失败' });
  }
});

// 获取会话统计
router.get('/conversation-stats', (req, res) => {
  try {
    const stats = db.conversations.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('获取会话统计失败:', error);
    res.status(500).json({ success: false, error: '获取会话统计失败' });
  }
});

// 请求转人工
router.post('/transfer-to-human', (req, res) => {
  try {
    const { conversationId, visitorId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }

    const conversation = db.conversations.getById(conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }
    if (conversation.status === db.conversations.STATUS.CLOSED) {
      return res.status(400).json({ success: false, error: '会话已关闭' });
    }
    if (conversation.mode === db.conversations.MODE.HUMAN) {
      return res.json({ 
        success: true, 
        alreadyInHuman: true,
        agentName: conversation.agent_name,
        message: '您已在人工服务中'
      });
    }
    if (conversation.mode === db.conversations.MODE.QUEUE) {
      const queueInfo = humanService.getQueueInfo();
      const position = queueInfo.items.findIndex(i => i.conversationId === conversationId) + 1;
      return res.json({
        success: true,
        inQueue: true,
        position: position || queueInfo.length,
        message: `当前排队位置：第${position || queueInfo.length}位，请耐心等待`
      });
    }

    // 请求转人工
    const result = humanService.requestHuman(conversationId, {
      visitorId,
      visitorName: conversation.visitor_name
    });

    if (result.success) {
      if (result.inQueue) {
        // 进入队列
        db.conversations.setMode(conversationId, db.conversations.MODE.QUEUE);
      } else {
        // 直接分配
        db.conversations.setMode(conversationId, db.conversations.MODE.HUMAN, result.agent);
      }
    }

    res.json(result);
  } catch (error) {
    console.error('转人工失败:', error);
    res.status(500).json({ success: false, error: '转人工失败' });
  }
});

// 取消排队
router.post('/cancel-queue', (req, res) => {
  try {
    const { conversationId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }

    const conversation = db.conversations.getById(conversationId);
    if (conversation && conversation.mode === db.conversations.MODE.QUEUE) {
      humanService.cancelQueue(conversationId);
      db.conversations.setMode(conversationId, db.conversations.MODE.AI);
    }

    res.json({ success: true, message: '已取消排队' });
  } catch (error) {
    console.error('取消排队失败:', error);
    res.status(500).json({ success: false, error: '取消排队失败' });
  }
});

// 获取统计数据
router.get('/stats', (req, res) => {
  try {
    const todayStats = db.stats.getToday() || { total_conversations: 0, total_messages: 0, ai_handled: 0 };
    const recentStats = db.stats.getRecent(7);
    const summary = db.stats.getSummary();
    res.json({
      success: true,
      stats: { today: todayStats, week: recentStats, summary }
    });
  } catch (error) {
    console.error('获取统计失败:', error);
    res.status(500).json({ success: false, error: '获取统计失败' });
  }
});

// 导出对话记录（支持 XLSX / CSV）【P3-1安全修复：增加分页和大小限制】
router.get('/export/:format', (req, res) => {
  try {
    // 限制导出量，防止内存耗尽
    const MAX_CONVS = 500;      // 最多导出会话数
    const MAX_ROWS = 5000;      // 最多导出消息行数
    
    const conversations = db.conversations.list(MAX_CONVS);
    const allRatings = db._db.prepare('SELECT * FROM ratings').all();
    const now = new Date().toISOString().slice(0, 10);

    // 构建逐条记录（每条消息一行）
    const rows = [];
    let rowCount = 0;
    
    for (const conv of conversations) {
      if (rowCount >= MAX_ROWS) break; // 达到上限则停止
      
      const msgs = db._db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conv.id);
      const rating = allRatings.find(r => r.conversation_id === conv.id);
      const modeMap = { ai: 'AI', queue: '排队中', human: '人工' };
      const statusMap = { active: '进行中', idle: '等待中', closed: '已结束' };

      if (msgs.length > 0) {
        msgs.forEach(msg => {
          if (rowCount >= MAX_ROWS) return;
          rows.push({
            '对话ID': conv.id,
            '访客': conv.visitor_name || '访客',
            '消息内容': msg.content,
            '角色': msg.role === 'user' ? '访客' : (msg.role === 'agent' ? '客服' : 'AI'),
            '处理方式': modeMap[conv.mode] || conv.mode,
            '会话状态': statusMap[conv.status] || conv.status,
            '满意度': rating ? `${rating.score}星` : '未评价',
            '评价内容': rating ? rating.comment || '' : '',
            '消息时间': msg.created_at ? msg.created_at.replace('T', ' ').slice(0, 19) : '',
            '会话创建时间': conv.created_at ? conv.created_at.replace('T', ' ').slice(0, 19) : '',
          });
          rowCount++;
        });
      } else {
        // 无消息的会话（不计入行数限制）
        rows.push({
          '对话ID': conv.id,
          '访客': conv.visitor_name || '访客',
          '消息内容': '(无消息)',
          '角色': '',
          '处理方式': modeMap[conv.mode] || conv.mode,
          '会话状态': statusMap[conv.status] || conv.status,
          '满意度': rating ? `${rating.score}星` : '未评价',
          '评价内容': rating ? rating.comment || '' : '',
          '消息时间': '',
          '会话创建时间': conv.created_at ? conv.created_at.replace('T', ' ').slice(0, 19) : '',
        });
      }
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 36 }, { wch: 12 }, { wch: 60 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 20 }, { wch: 22 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '对话记录');

    // 添加导出说明
    if (rows.length >= MAX_ROWS) {
      console.log(`[导出] 数据量已达上限(${MAX_ROWS}行)，如有需要请分批导出`);
    }

    if (req.params.format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=conversations_${now}.xlsx`);
      return res.end(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    }

    if (req.params.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=conversations_${now}.csv`);
      return res.send('\uFEFF' + XLSX.utils.sheet_to_csv(ws));
    }

    res.status(400).json({ success: false, error: '不支持的格式，请使用 xlsx / csv' });
  } catch (error) {
    console.error('导出对话失败:', error);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});

module.exports = router;
