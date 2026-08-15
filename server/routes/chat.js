const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const aiService = require('../services/ai');
const sensitiveService = require('../services/sensitive');
const humanService = require('../services/human');
const knowledgeService = require('../services/knowledge');
const unansweredService = require('../services/unanswered');
const { toCsv } = require('../utils/csv');
const metrics = require('../utils/metrics');
const { AiStreamClient } = require('../services/stream_client');
const { canAccessVisitorConversation } = require('../utils/access-control');

// AI 服务流式客户端（双段超时 + 熔断）
const aiStreamClient = new AiStreamClient({
  baseUrl: process.env.LANGCHAIN_SERVICE_URL || 'http://localhost:8000',
});

// visitorId 格式白名单正则
const VISITOR_ID_RE = /^v_\d{10,}_[a-z0-9]{4,20}$/;

// ============ SSE 流式会话管理 ============
const streamSessions = new Map(); // streamId -> { conversationId, tokens, fullContent, ended, callbacks }

function writeToStream(streamId, token) {
  const session = streamSessions.get(streamId);
  if (!session) return;
  session.tokens.push(token);
  session.callbacks.forEach(cb => cb({ type: 'token', data: token }));
}
function endStream(streamId, fullContent, type) {
  const session = streamSessions.get(streamId);
  if (!session) return;
  session.ended = true;
  session.fullContent = fullContent;
  session.callbacks.forEach(cb => cb({ type: 'end', data: { fullContent, type } }));
  // 5 分钟后清理
  setTimeout(() => streamSessions.delete(streamId), 5 * 60 * 1000);
}
function errorStream(streamId, errorMsg) {
  const session = streamSessions.get(streamId);
  if (!session) return;
  session.ended = true;
  session.callbacks.forEach(cb => cb({ type: 'error', data: errorMsg }));
  setTimeout(() => streamSessions.delete(streamId), 60000);
}

// ============ 会话级 LangChain 调用队列 ============
// 同一会话的 AI 处理串行执行：流式未完成时下一条消息不会抢占，
// 避免 AI 服务历史里缺失 assistant 分隔导致"回答上一次问题"的错位
const langchainQueues = new Map();
const AI_TASK_TIMEOUT_MS = 90000; // 单任务护栏：超时不再阻塞队列
function enqueueLangChain(conversationId, task) {
  const prev = langchainQueues.get(conversationId) || Promise.resolve();
  const guarded = async () => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`AI 任务超时(${AI_TASK_TIMEOUT_MS}ms)`)), AI_TASK_TIMEOUT_MS);
      if (timer && timer.unref) timer.unref();
    });
    try {
      return await Promise.race([task(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const next = prev.then(guarded, guarded);
  langchainQueues.set(conversationId, next);
  next.finally(() => {
    if (langchainQueues.get(conversationId) === next) langchainQueues.delete(conversationId);
  });
  return next;
}

function validateVisitorId(visitorId) {
  if (!visitorId || typeof visitorId !== 'string') return false;
  if (visitorId.length > 64) return false;
  return VISITOR_ID_RE.test(visitorId);
}

/**
 * 强制校验访客身份与会话所有权（安全修复：访客接口必须携带并匹配 visitorId）
 * 返回 null 表示通过；否则返回错误消息。
 */
function enforceVisitorAccess(conversation, visitorId) {
  if (!visitorId) return '缺少visitorId';
  if (!validateVisitorId(visitorId)) return 'visitorId格式无效';
  if (!conversation) return '会话不存在';
  if (conversation.visitor_id !== visitorId) return '无权访问此会话';
  return null;
}

// 创建新对话
router.post('/create', async (req, res) => {
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
    const result = await db.conversations.create(conversationId, visitorId, visitorName || '访客');
    console.log('[创建会话] 结果:', result);
    await db.stats.incrementConversations();
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

    // 检查会话是否存在且未关闭
    const conversation = await db.conversations.getById(conversationId);
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

    // 【安全修复】强制校验 visitorId 所有权（缺少或不属于该会话均拒绝）
    const accessErr = enforceVisitorAccess(conversation, visitorId);
    if (accessErr) {
      return res.status(403).json({ success: false, error: accessErr });
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
    await db.conversations.updateLastMessage(conversationId);

    // 保存用户消息
    await db.messages.add(uuidv4(), conversationId, 'user', trimmedMessage);
    await db.stats.incrementMessages();

    // 检查会话模式
    const updatedConversation = await db.conversations.getById(conversationId);
    
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

    // =====================================
    // AI处理（非人工模式或客服不在线）
    // → 统一走 LangChain Agent（全量Agent）
    // =====================================
    
    // 创建流式会话
    const streamId = uuidv4();
    streamSessions.set(streamId, {
      conversationId,
      tokens: [],
      fullContent: '',
      ended: false,
      callbacks: new Set()
    });
    console.log(`[LangChain Agent] 创建流式会话: ${streamId}`);

    // 后台异步执行 LangChain Agent 调用（按会话串行排队，保证历史顺序）
    enqueueLangChain(conversationId, async () => {
      try {
        // 熔断检查：熔断期内跳过 AI 调用，直接走知识库兜底
        if (aiStreamClient.isBreakerOpen) {
          throw new Error('AI 服务熔断中，直接走知识库兜底');
        }

        // 带双段超时的流式调用（首字节 30s + 流空闲 15s）
        const { reader, resetIdle, clearIdle, close } = await aiStreamClient.openChatStream({
          conversationId,
          message: trimmedMessage,
          useAgent: true,  // Agent 自主决策：知识库→AI→转人工→兜底
        });
        aiStreamClient.breaker.recordSuccess(); // 服务可达 → 重置失败计数

        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = '';
        let currentEvent = '';
        let detectedSource = 'ai';  // 从 SSE 事件中捕获真实来源（knowledge/ai/fallback）

        try {
          while (true) {
            resetIdle(); // 每次读取前重置空闲计时（15s 无数据 → abort）
            const { done, value } = await aiStreamClient.readChunk(reader);
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n');
            buffer = parts.pop() || '';

            for (const line of parts) {
              const trimmed = line.trim();
              if (trimmed.startsWith('event: ')) {
                currentEvent = trimmed.slice(7);
              } else if (trimmed.startsWith('data: ')) {
                const data = trimmed.slice(6);
                if (currentEvent === 'token') {
                  try {
                    const token = JSON.parse(data);
                    if (token) {
                      fullContent += token;
                      writeToStream(streamId, token);
                    }
                  } catch (_) {}
                } else if (currentEvent === 'knowledge') {
                  detectedSource = 'knowledge';
                  try {
                    const parsed = JSON.parse(data);
                    const content = typeof parsed === 'string' ? parsed : (parsed.fullContent || parsed.content || '');
                    if (content && !fullContent) fullContent = content;
                  } catch (_) {}
                } else if (currentEvent === 'end') {
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.type) detectedSource = parsed.type;
                    const content = typeof parsed === 'string' ? parsed : (parsed.fullContent || parsed.content || '');
                    if (content && !fullContent) fullContent = content;
                  } catch (_) {}
                } else if (currentEvent === 'error') {
                  console.error(`[LangChain Agent] 流式错误: ${data}`);
                }
                currentEvent = '';
              }
            }
          }
        } finally {
          clearIdle(); // 停止空闲计时
          close();     // 释放连接
        }

        // 流结束 → 用 LangChain LLM 检测敏感词（10s 超时，失败不阻塞）
        if (fullContent) {
          let finalContent = fullContent;
          try {
            const sensData = await aiStreamClient.checkSensitive(fullContent);
            if (sensData.success && sensData.data?.has_sensitive) {
              console.log(`[LangChain Agent] 语义检测到敏感内容: ${sensData.data.reason}`);
              finalContent = '抱歉，根据我的知识库，暂时没有找到与您问题相关的信息。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系真人客服获得帮助\n\n感谢您的理解！';
            }
          } catch (e) {
            console.error(`[LangChain Agent] 敏感检测失败: ${e.message}`);
          }

          const finalSource = (finalContent !== fullContent) ? 'fallback' : detectedSource;
          await db.messages.add(uuidv4(), conversationId, 'assistant', finalContent, null, finalSource);
          await db.stats.incrementAiHandled();
          endStream(streamId, finalContent, finalSource);
          metrics.inc('chat_messages_total', [finalSource]);
          // 运营闭环：fallback（AI 无法回答）记录到未答收集
          if (finalSource === 'fallback') {
            try { unansweredService.recordQuery(trimmedMessage); } catch(e) {}
          }
          console.log(`[LangChain Agent] 流式完成: ${streamId}`);
        } else {
          const fallback = {
            answer: '抱歉，我暂时没有找到与您问题相关的信息。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系真人客服\n\n感谢您的理解！',
            type: 'fallback',
          };
          await db.messages.add(uuidv4(), conversationId, 'assistant', fallback.answer, null, 'fallback');
          await db.stats.incrementAiHandled();
          endStream(streamId, fallback.answer, fallback.type);
          // 运营闭环：AI 完全无法回答，记录未答
          try { unansweredService.recordQuery(trimmedMessage); } catch(e) {}
        }
      } catch (err) {
        console.error(`[LangChain Agent] 请求失败: ${err.message}`);
        metrics.inc('ai_errors_total', ['langchain_failure']);
        aiStreamClient.breaker.recordFailure(); // 失败计数（连续 N 次 → 熔断）
        // Demo 兜底链：AI 服务不可用时，先查本地知识库，命中直接给答案
        let fallbackAnswer = '抱歉，AI 服务暂时不可用，请稍后重试。\n\n您也可以输入"转人工"联系真人客服，感谢您的理解！';
        let fallbackType = 'fallback';
        try {
          const kbMatch = await knowledgeService.getBestMatch(trimmedMessage);
          if (kbMatch) {
            fallbackAnswer = kbMatch.answer;
            fallbackType = 'knowledge-fallback';
            console.log(`[LangChain Agent] AI 不可用，知识库兜底命中: ${kbMatch.question}`);
          }
        } catch (kbErr) {
          console.error(`[LangChain Agent] 知识库兜底失败: ${kbErr.message}`);
        }
        await db.messages.add(uuidv4(), conversationId, 'assistant', fallbackAnswer, null, fallbackType);
        await db.stats.incrementAiHandled();
        endStream(streamId, fallbackAnswer, fallbackType);
        // 运营闭环：AI 服务异常也记录
        try { unansweredService.recordQuery(trimmedMessage); } catch(e) {}
      }
    });

    return res.json({
      success: true,
      type: 'streaming',
      streamId,
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
router.get('/history/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { visitorId } = req.query; // 访客端必须传递 visitorId

    // 【安全修复】强制校验 visitorId 所有权（缺少或不属于该会话均拒绝）
    const conversation = await db.conversations.getById(conversationId);
    const accessErr = enforceVisitorAccess(conversation, visitorId);
    if (accessErr) {
      return res.status(403).json({ success: false, error: accessErr });
    }

    const messages = await db.messages.getByConversation(conversationId);
    res.json({ success: true, messages });
  } catch (error) {
    console.error('获取历史失败:', error);
    res.status(500).json({ success: false, error: '获取历史失败' });
  }
});


// 注意：/list 路由已移至 index.js 管理 API 区（需 basicAuth）



// 评价对话
router.post('/rate', async (req, res) => {
  try {
    const { conversationId, score, comment, visitorId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }

    // 【安全修复】强制校验 visitorId 所有权
    const conversation = await db.conversations.getById(conversationId);
    const accessErr = enforceVisitorAccess(conversation, visitorId);
    if (accessErr) {
      return res.status(403).json({ success: false, error: accessErr });
    }

    const validScore = Math.min(5, Math.max(1, parseInt(score) || 3));
    await db.ratings.add(uuidv4(), conversationId, validScore, comment || null);
    await db.conversations.close(conversationId, 'rated');
    aiService.clearHistory(conversationId);
    res.json({ success: true });
  } catch (error) {
    console.error('评价失败:', error);
    res.status(500).json({ success: false, error: '评价失败' });
  }
});

// 手动关闭会话
router.post('/close', async (req, res) => {
  try {
    const { conversationId, visitorId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }

    const conversation = await db.conversations.getById(conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }

    // 【安全修复】强制校验 visitorId 所有权（访客关闭必须属于该会话）
    const accessErr = enforceVisitorAccess(conversation, visitorId);
    if (accessErr) {
      return res.status(403).json({ success: false, error: accessErr });
    }

    if (conversation.status === db.conversations.STATUS.CLOSED) {
      return res.json({ success: true, message: '会话已处于关闭状态' });
    }
    
    await db.conversations.close(conversationId, 'manual');
    aiService.clearHistory(conversationId);
    
    res.json({ success: true, message: '会话已关闭' });
  } catch (error) {
    console.error('关闭会话失败:', error);
    res.status(500).json({ success: false, error: '关闭会话失败' });
  }
});

// 获取会话状态
router.get('/status/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await db.conversations.getById(conversationId);
    
    if (!conversation) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }
    if (!canAccessVisitorConversation(conversation, req.query.visitorId)) {
      return res.status(403).json({ success: false, error: '无权访问此会话' });
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
router.get('/conversation-stats', async (req, res) => {
  try {
    const stats = await db.conversations.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('获取会话统计失败:', error);
    res.status(500).json({ success: false, error: '获取会话统计失败' });
  }
});

// 请求转人工
router.post('/transfer-to-human', async (req, res) => {
  try {
    const { conversationId, visitorId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }

    const conversation = await db.conversations.getById(conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }

    // 【安全修复】强制校验 visitorId 所有权
    const accessErr = enforceVisitorAccess(conversation, visitorId);
    if (accessErr) {
      return res.status(403).json({ success: false, error: accessErr });
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
        await db.conversations.setMode(conversationId, db.conversations.MODE.QUEUE);
      } else {
        // 直接分配
        await db.conversations.setMode(conversationId, db.conversations.MODE.HUMAN, result.agent);
      }
    }

    res.json(result);
  } catch (error) {
    console.error('转人工失败:', error);
    res.status(500).json({ success: false, error: '转人工失败' });
  }
});

// 取消排队
router.post('/cancel-queue', async (req, res) => {
  try {
    const { conversationId, visitorId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ success: false, error: '缺少conversationId' });
    }

    const conversation = await db.conversations.getById(conversationId);

    // 【安全修复】强制校验 visitorId 所有权
    const accessErr = enforceVisitorAccess(conversation, visitorId);
    if (accessErr) {
      return res.status(403).json({ success: false, error: accessErr });
    }

    if (conversation && conversation.mode === db.conversations.MODE.QUEUE) {
      humanService.cancelQueue(conversationId);
      await db.conversations.setMode(conversationId, db.conversations.MODE.AI);
    }

    res.json({ success: true, message: '已取消排队' });
  } catch (error) {
    console.error('取消排队失败:', error);
    res.status(500).json({ success: false, error: '取消排队失败' });
  }
});

// 获取统计数据
router.get('/stats', async (req, res) => {
  try {
    const todayStats = await db.stats.getToday() || { total_conversations: 0, total_messages: 0, ai_handled: 0 };
    const recentStats = await db.stats.getRecent(7);
    const summary = await db.stats.getSummary();
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
router.get('/export/:format', async (req, res) => {
  try {
    // 限制导出量，防止内存耗尽
    const MAX_CONVS = 500;      // 最多导出会话数
    const MAX_ROWS = 5000;      // 最多导出消息行数
    
    const conversations = await db.conversations.list(MAX_CONVS);
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

    // 添加导出说明
    if (rows.length >= MAX_ROWS) {
      console.log(`[导出] 数据量已达上限(${MAX_ROWS}行)，如有需要请分批导出`);
    }

    if (req.params.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=conversations_${now}.csv`);
      return res.send('\uFEFF' + toCsv(rows));
    }

    res.status(400).json({ success: false, error: '不支持的格式，请使用 csv' });
  } catch (error) {
    console.error('导出对话失败:', error);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});


// ── SSE 流式端点 ───────────────────────────────────────────────
// 前端收到 { type: 'streaming', streamId } 后，连接此端点逐 token 接收 AI 回答
router.get('/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const session = streamSessions.get(streamId);

  if (!session) {
    return res.status(404).json({ success: false, error: '流式会话不存在或已过期' });
  }

  // 设置 SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'  // 禁止 nginx 缓冲
  });

  // 先发送所有已缓冲的 tokens
  for (const token of session.tokens) {
    res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
  }

  // 如果流已结束，直接发送 end 事件
  if (session.ended) {
    res.write(`event: end\ndata: ${JSON.stringify({ fullContent: session.fullContent, type: session.type || 'ai' })}\n\n`);
    return res.end();
  }

  // 注册回调接收后续 tokens
  const callback = (event) => {
    if (event.type === 'token') {
      res.write(`event: token\ndata: ${JSON.stringify(event.data)}\n\n`);
    } else if (event.type === 'end') {
      res.write(`event: end\ndata: ${JSON.stringify(event.data)}\n\n`);
      res.end();
    } else if (event.type === 'error') {
      res.write(`event: error\ndata: ${JSON.stringify(event.data)}\n\n`);
      res.end();
    }
  };

  session.callbacks.add(callback);

  // 客户端断开时清理
  req.on('close', () => {
    session.callbacks.delete(callback);
  });
});

module.exports = router;
