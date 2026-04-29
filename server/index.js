const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const logger = require('./utils/logger');

// ===== 全局日志劫持：所有模块的 console.log/warn/error 自动走 winston =====
const _origConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error
};
console.log = (...args) => { _origConsole.log(...args); logger.info(args.map(String).join(' ')); };
console.warn = (...args) => { _origConsole.warn(...args); logger.warn(args.map(String).join(' ')); };
console.error = (...args) => { _origConsole.error(...args); logger.error(args.map(String).join(' ')); };

// 加载 .env 环境变量（Node 20+ 内置支持，无需 dotenv）
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
  logger.info('.env 已加载');
}

// 强制 UTF-8 输出
process.env.LANG = 'zh_CN.UTF-8';
const chatRoutes = require('./routes/chat');
const knowledgeRoutes = require('./routes/knowledge');
const configRoutes = require('./routes/config');
const sensitiveRoutes = require('./routes/sensitive');
const humanRoutes = require('./routes/human');
const statsRoutes = require('./routes/stats');
const humanService = require('./services/human');
const { basicAuth, changePassword } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3456;

// 创建HTTP服务器（为WebSocket做准备）
const server = http.createServer(app);

// ===== 安全中间件 =====

// 1. helmet — 安全响应头（X-Frame-Options / X-Content-Type-Options / HSTS 等）
app.use(helmet({
  // 允许内嵌 iframe（访客端可能被嵌入第三方页面）
  frameguard: false,
  // 关闭 CSP，前端用了内联脚本
  contentSecurityPolicy: false
}));

// 2. CORS — 收窄跨域白名单
//    生产环境请在 .env 配置 ALLOWED_ORIGINS（逗号分隔）
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(',').map(s => s.trim())
  : null; // null = 开发模式，允许全部

app.use(cors({
  origin: (origin, callback) => {
    // 允许无 Origin 请求（本地直接打开、Postman 等）
    if (!origin) return callback(null, true);
    if (!allowedOrigins) return callback(null, true); // 未配置白名单 = 开发模式全放行
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true
}));

// 3. 请求体大小限制
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

// 4. 限流规则
//    访客聊天：1分钟内最多 30 条消息（防刷）
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '请求过于频繁，请稍后再试' }
});

//    创建会话：1分钟内最多 10 次（防批量创建）
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '创建会话过于频繁，请稍后再试' }
});

//    管理 API：1分钟内最多 120 次
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '请求过于频繁，请稍后再试' }
});

// 静态文件中间件（排除管理页面）
app.get(['/admin.html', '/agent.html'], basicAuth, (req, res) => {
  const filePath = path.join(__dirname, '../public', req.path);
  res.sendFile(filePath);
});
app.use(express.static(path.join(__dirname, '../public')));

// 健康检查（无需认证）
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 修改管理后台密码（需要认证）
app.post('/api/auth/change-password', basicAuth, changePassword);


// 调试端点（仅开发环境，生产环境返回404）
if (process.env.NODE_ENV !== 'production') {
  app.get(['/api/debug/dir', '/api/debug/knowledge', '/api/debug/ai-test'], basicAuth);

  app.get('/api/debug/dir', (req, res) => {
    res.json({ 
      __dirname: __dirname, 
      cwd: process.cwd(),
      file: __filename
    });
  });

  app.get('/api/debug/knowledge', (req, res) => {
    const knowledgeService = require('./services/knowledge');
    const testQuery = req.query.q || '工作时间';
    const results = knowledgeService.search(testQuery);
    res.json({ 
      totalItems: knowledgeService.knowledgeBase.length,
      testQuery: testQuery,
      searchResults: results.map(r => ({
        question: r.question,
        score: r.score,
        matchedKeywords: r.matchedKeywords
      }))
    });
  });

  app.get('/api/debug/ai-test', async (req, res) => {
    const aiService = require('./services/ai');
    const testQuery = req.query.q || '如何扫码开锁';
    try {
      const result = await aiService.chat('test-conv', testQuery);
      res.json({
        query: testQuery,
        result: {
          type: result.type,
          answer: result.answer,
          confidence: result.confidence,
          matchQuestion: result.matchQuestion
        }
      });
    } catch (error) {
      res.json({
        query: testQuery,
        error: error.message
      });
    }
  });
} else {
  // 生产环境：调试接口返回404
  app.get('/api/debug/*', (req, res) => {
    res.status(404).json({ success: false, error: '该接口在生产环境已禁用' });
  });
}

// ============ 访客 API（无需认证）============
app.post('/api/chat/create', createLimiter);   // 创建会话限流
app.post('/api/chat/message', chatLimiter);    // 聊天消息限流

// 对话列表（需要认证）— 必须在 chatRoutes 挂载之前注册，否则会被 app.use 吞掉
app.get('/api/chat/list', adminLimiter, basicAuth, (req, res) => {
  try {
    const db = require('./services/database');
    const limit = parseInt(req.query.limit) || 100;
    const clampedLimit = Math.min(Math.max(limit, 1), 500);

    const result = db._db.prepare(`
      SELECT c.*,
        (SELECT m.content FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC LIMIT 1) AS last_message_content,
        (SELECT m.role FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC LIMIT 1) AS last_message_role,
        (SELECT m.created_at FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
      FROM conversations c
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(clampedLimit).map(row => {
      const conv = { ...row };
      if (row.last_message_content) {
        conv.lastMessage = {
          content: row.last_message_content,
          sender: row.last_message_role,
          created_at: row.last_message_at
        };
        delete conv.last_message_content;
        delete conv.last_message_role;
        delete conv.last_message_at;
      } else {
        conv.lastMessage = null;
      }
      return conv;
    });

    res.json({ success: true, conversations: result });
  } catch (error) {
    console.error('获取对话列表失败:', error);
    res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

app.use('/api/chat', chatRoutes);  // 访客聊天，无需认证
app.get('/api/config/brand', (req, res) => {
  // 品牌配置公开接口（访客端加载品牌皮肤）
  const { readBrandConfig } = require('./utils/config');
  readBrandConfig().then(config => {
    res.json({ success: true, data: config });
  }).catch(err => {
    res.status(500).json({ success: false, message: '获取品牌配置失败' });
  });
});

// ============ 管理 API（需要认证）============
app.use('/api/knowledge', adminLimiter, basicAuth, knowledgeRoutes);  // 知识库管理
app.use('/api/config', adminLimiter, basicAuth, configRoutes.router);  // 系统配置
app.use('/api/sensitive', adminLimiter, basicAuth, sensitiveRoutes);   // 敏感词管理
app.use('/api/human', basicAuth, humanRoutes);                         // 人工客服（WebSocket 协调，不加次数限流）
app.use('/api/stats', adminLimiter, basicAuth, statsRoutes);           // 数据统计

// 初始化数据库（已包含超时检查启动）
const db = require('./services/database');

// 设置 AI 服务的全局引用（用于配置同步）
const aiService = require('./services/ai');
global.aiService = aiService;

// WebSocket服务器
const wss = new WebSocket.Server({ server, path: '/ws' });

// ===== WebSocket 心跳检测（30秒无 pong 则判定为僵尸连接并关闭）=====
const WS_HEARTBEAT_INTERVAL = 30 * 1000; // 30秒
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      logger.warn('心跳超时，关闭僵尸连接');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_HEARTBEAT_INTERVAL);
heartbeatTimer.unref(); // 不阻止进程退出

// visitorId 格式白名单正则（与 chat.js 保持一致）
const VISITOR_ID_RE = /^v_\d{10,}_[a-z0-9]{4,20}$/;

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type');
  const id = url.searchParams.get('id');
  const visitorId = url.searchParams.get('visitorId');

  // 标记为存活
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  logger.info(`新连接: type=${type}, id=${id}`);

  if (type === 'agent' && id) {
    // 【P1-2安全修复】客服连接必须验证身份：agentId 必须在系统中存在且当前在线
    const agent = humanService.getAgentById(id);
    if (!agent) {
      logger.warn(`拒绝客服连接: agentId不存在=${id}`);
      ws.send(JSON.stringify({ type: 'error', code: 'AGENT_NOT_FOUND', message: '客服账号不存在' }));
      ws.close(1008, 'Agent not found');
      return;
    }
    humanService.registerAgentSocket(id, ws);
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        // 处理客服消息
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        logger.error('客服消息解析失败:', { error: e.message });
      }
    });
  } else if (type === 'user' && id) {
    // 【P3-2安全修复】访客端连接必须验证 visitorId
    if (!visitorId || !VISITOR_ID_RE.test(visitorId)) {
      logger.warn(`拒绝连接: visitorId格式无效=${visitorId}`);
      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_VISITOR_ID', message: '身份验证失败' }));
      ws.close(1008, 'Invalid visitorId');
      return;
    }
    
    // 验证 visitorId 与会话的访客ID是否匹配
    const db = require('./services/database');
    const conversation = db.conversations.getById(id);
    if (!conversation) {
      logger.warn(`拒绝连接: 会话不存在 id=${id}`);
      ws.send(JSON.stringify({ type: 'error', code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' }));
      ws.close(1008, 'Conversation not found');
      return;
    }
    if (conversation.visitor_id !== visitorId) {
      logger.warn(`拒绝连接: visitorId不匹配 expected=${conversation.visitor_id} got=${visitorId}`);
      ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: '无权访问此会话' }));
      ws.close(1008, 'Unauthorized');
      return;
    }
    
    // 校验通过，注册连接
    humanService.registerUserSocket(id, ws);
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        logger.error('访客消息解析失败:', { error: e.message });
      }
    });
  } else {
    // 参数缺失
    logger.warn(`拒绝连接: 缺少必要参数 type=${type} id=${id}`);
    ws.close(1008, 'Missing required parameters');
    return;
  }

  ws.on('close', () => {
    logger.info(`连接关闭: type=${type}, id=${id}`);
    humanService.removeSocket(ws);
  });

  ws.on('error', (err) => {
    logger.error('WebSocket错误:', { error: err.message });
  });

  // 发送连接成功消息
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

// 全局错误中间件 — 脱敏 error.message，防止栈信息泄露到前端
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // CORS 拒绝
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({ success: false, error: '跨域请求被拒绝' });
  }
  // 打印真实错误到后端日志
  logger.error('全局错误:', { error: err.message, stack: err.stack, url: req.url, method: req.method });
  // 前端只给通用消息
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ success: false, error: status >= 500 ? '服务器内部错误' : (err.message || '请求错误') });
});

// 全局异常捕获（防止未处理的Promise拒绝和未捕获异常导致进程静默退出）
process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', { error: reason?.message || String(reason), stack: reason?.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('未捕获的异常:', { error: err.message, stack: err.stack });
  // 给PM2一个优雅退出的机会，而不是立即crash循环
  setTimeout(() => { process.exit(1); }, 1000);
});

// 优雅退出
process.on('SIGTERM', () => {
  logger.info('收到SIGTERM，正在关闭...');
  server.close(() => {
    if (db && db.stopCacheRefresh) db.stopCacheRefresh();
    logger.info('服务器已关闭');
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  logger.info('收到SIGINT，正在关闭...');
  server.close(() => process.exit(0));
});

// 启动服务器
server.listen(PORT, () => {
  logger.info(`
╔══════════════════════════════════════════════════╗
║         AI智能客服系统已启动                      ║
╠══════════════════════════════════════════════════╣
║  访客端: http://localhost:${PORT}                 ║
║  管理后台: http://localhost:${PORT}/admin.html   ║
║  客服工作台: http://localhost:${PORT}/agent.html ║
╚══════════════════════════════════════════════════╝
  `);
});
