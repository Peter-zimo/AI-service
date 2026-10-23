/**
 * Express 应用装配（Application Assembly）
 *
 * 本文件只做「接线」：中间件顺序、路由挂载、WebSocket 注册、错误兜底。
 * 不写业务逻辑、不写 SQL —— 业务在 modules/，数据在 *.repo.js。
 *
 * 进程级职责（读 .env、劫持 console、listen、优雅退出）在 index.js。
 */

'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const logger = require('./infra/logger');
const metrics = require('./infra/metrics');
const { helmetOptions } = require('./utils/security-headers');
const { isAllowedOrigin } = require('./utils/cors');
const { env } = require('./config');
const { isValidVisitorId } = require('./utils/visitor-id');
const { errorHandler } = require('./middleware/error-handler');

// ============ 路由 ============
const chatRoutes = require('./routes/chat');
const conversationRoutes = require('./routes/conversations.routes');
const knowledgeRoutes = require('./routes/knowledge');
const configRoutes = require('./routes/config');
const sensitiveRoutes = require('./routes/sensitive');
const humanRoutes = require('./routes/human');
const statsRoutes = require('./routes/stats');
const unansweredRoutes = require('./routes/unanswered');
const actionsRoutes = require('./routes/actions');
const qualityRoutes = require('./routes/quality');
const authRoutes = require('./routes/auth');
const debugRoutes = require('./routes/debug.routes');
const healthRoutes = require('./routes/health.routes');
const brandRoutes = require('./routes/brand.routes');

const humanService = require('./modules/human');
const chatService = require('./modules/chat');
const { jwtAuth, changePassword, verifyWebSocketAgentToken } = require('./middleware/auth');

// ============ 限流策略 ============

function createLimiters() {
  const base = {
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: '请求过于频繁，请稍后再试' },
  };

  return {
    // 访客聊天：防刷
    chat: rateLimit({ ...base, windowMs: 60 * 1000, max: env.limits.chatPerMinute }),
    // 创建会话：防批量
    create: rateLimit({ ...base, windowMs: 60 * 1000, max: env.limits.createPerMinute }),
    // 管理 API
    admin: rateLimit({ ...base, windowMs: 60 * 1000, max: env.limits.adminPerMinute }),
    // 登录：防在线猜密码
    login: rateLimit({
      ...base,
      windowMs: env.limits.loginWindowMs,
      max: env.limits.loginPerWindow,
      message: { success: false, error: '登录尝试过于频繁，请15分钟后再试' },
    }),
  };
}

// ============ 内部服务鉴权 ============

function internalServiceAuth(req, res, next) {
  const expected = env.ai.serviceToken || '';
  const received = req.get('X-Internal-Service-Token') || '';

  if (!expected || !received || expected.length !== received.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return res.status(401).json({ success: false, error: '未授权的内部服务调用' });
  }
  next();
}

// ============ WebSocket ============

const WS_HEARTBEAT_INTERVAL = 30 * 1000;

function attachWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  // 心跳：30 秒无 pong 判定僵尸连接
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

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const type = url.searchParams.get('type');
    const id = url.searchParams.get('id');
    const visitorId = url.searchParams.get('visitorId');
    const token = url.searchParams.get('token');

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    logger.info(`新连接: type=${type}, id=${id}`);

    if (type === 'agent' && id) {
      if (!verifyWebSocketAgentToken(token, id)) {
        ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: '身份验证失败' }));
        ws.close(1008, 'Unauthorized');
        return;
      }

      // 客服连接必须验证身份：agentId 必须存在
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
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (e) {
          logger.error('客服消息解析失败:', { error: e.message });
        }
      });

    } else if (type === 'user' && id) {
      // 访客端必须验证 visitorId 格式与归属
      if (!visitorId || !isValidVisitorId(visitorId)) {
        logger.warn(`拒绝连接: visitorId格式无效=${visitorId}`);
        ws.send(JSON.stringify({ type: 'error', code: 'INVALID_VISITOR_ID', message: '身份验证失败' }));
        ws.close(1008, 'Invalid visitorId');
        return;
      }

      const conversation = await chatService.getConversationById(id);

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

    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  return wss;
}

// ============ 应用装配 ============

function createApp() {
  const app = express();
  const server = http.createServer(app);
  const limiters = createLimiters();

  // ---------- 安全中间件 ----------
  app.use(helmet(helmetOptions));

  app.use(cors({
    origin: (origin, callback) => {
      // 允许无 Origin 请求（本地直接打开、Postman 等）
      if (isAllowedOrigin(origin, env.nodeEnv, env.allowedOrigins)) {
        return callback(null, true);
      }
      if (env.isProduction && !env.allowedOrigins) {
        return callback(new Error('CORS blocked: production allowlist is required'));
      }
      callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  }));

  app.use(express.json({ limit: env.limits.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: env.limits.bodyLimit }));

  // ---------- 静态资源 ----------
  // 管理后台与客服台页面本身免认证（内部 API 走 JWT）
  app.get(['/admin.html', '/agent.html'], async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, '../public', req.path));
  });

  app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));

  // ---------- 可观测 ----------
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      // 用「挂载前缀 + 路由模式」拼出稳定的指标标签。
      // 只取 req.route.path 时，子路由恒为 '/'，会把所有端点塌缩成一个标签。
      const routePattern = req.route?.path || '';
      const route = (req.baseUrl || '') + (routePattern === '/' ? '' : routePattern) ||
        req.path || 'unknown';
      metrics.inc('http_requests_total', [req.method, route, String(res.statusCode)]);
      metrics.observe('http_request_duration_ms', duration, [req.method, route]);
    });
    next();
  });

  app.get('/api/metrics', jwtAuth(['admin']), async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics.toPrometheusText());
  });

  // 健康检查（公开）
  app.use('/api/health', healthRoutes);

  // 内部服务调用（Python AI 服务拉知识库）
  app.get('/api/internal/knowledge', internalServiceAuth, async (req, res) => {
    const knowledgeService = require('./modules/knowledge');
    res.json({ success: true, data: await knowledgeService.getAll() });
  });

  // ---------- 认证 ----------
  app.use('/api/auth/login', limiters.login);
  app.use('/api/auth', authRoutes);

  // ---------- 调试端点（仅管理员，且仅非生产环境） ----------
  if (!env.isProduction) {
    app.use('/api/debug', jwtAuth(['admin']), debugRoutes);
  } else {
    app.get('/api/debug/{*splat}', async (req, res) => {
      res.status(404).json({ success: false, error: '该接口在生产环境已禁用' });
    });
  }

  // ---------- 访客 API ----------
  app.post('/api/chat/create', limiters.create);
  app.post('/api/chat/message', limiters.chat);

  // 后台会话列表必须挂在 /api/chat 之前，否则会被前缀路由吞掉
  app.use('/api/chat/list', limiters.admin, jwtAuth(['admin', 'agent']), conversationRoutes);

  app.use('/api/chat', chatRoutes);
  app.use('/api/actions', limiters.chat, actionsRoutes);

  // 品牌配置（公开，访客端加载皮肤）；必须挂在 /api/config 管理路由之前
  app.use('/api/config/brand', brandRoutes);

  // ---------- 管理 API ----------
  app.use('/api/knowledge', limiters.admin, jwtAuth(['admin', 'agent']), knowledgeRoutes);
  app.use('/api/quality', limiters.admin, jwtAuth(['admin']), qualityRoutes);
  app.use('/api/config', limiters.admin, jwtAuth(['admin']), configRoutes.router);
  app.use('/api/sensitive', limiters.admin, jwtAuth(['admin', 'agent']), sensitiveRoutes);
  app.use('/api/human/login', limiters.login);
  app.use('/api/human', (req, res, next) => {
    if (req.path === '/login') return next();
    return jwtAuth(['agent', 'admin'])(req, res, next);
  }, humanRoutes);
  app.use('/api/stats', limiters.admin, jwtAuth(['admin', 'agent', 'readonly']), statsRoutes);
  app.use('/api/unanswered', limiters.admin, jwtAuth(['admin', 'agent']), unansweredRoutes);

  // ---------- 基础设施 ----------
  // 数据库建表在 infra/db 加载时完成；chat 模块加载时会启动会话超时检查
  require('./modules/chat');

  // AI 服务全局引用（供配置同步回调使用；utils/config.js 仍依赖它，B4 收口）
  global.aiService = require('./modules/ai');

  // ---------- WebSocket ----------
  const wss = attachWebSocket(server);

  // ---------- 错误兜底（必须最后） ----------
  app.use(errorHandler);

  return { app, server, wss };
}

module.exports = { createApp };
