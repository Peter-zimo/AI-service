/**
 * 运行时配置（Runtime Config）
 *
 * 唯一职责：把散落各处的 process.env 读取集中到一处，做类型转换、默认值与启动校验。
 *
 * 约定：
 *   - 业务代码不要直接读 process.env，统一 require('../config')
 *   - 本模块只做「读 + 转换 + 校验」，不做任何业务判断
 *   - 校验函数 validate() 只在进程启动时调用，避免测试环境因缺变量而崩
 *
 * 注意：本文件不是 ai-config.json 的读写层（那是 utils/config.js 的职责）。
 */

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ============ 基础转换 ============

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : String(v).trim();
}

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function list(name, fallback = []) {
  const v = str(name);
  if (!v) return fallback;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

// ============ 配置结构 ============

const nodeEnv = str('NODE_ENV', 'development');

const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isDevelopment: nodeEnv === 'development',
  isTest: nodeEnv === 'test' || !!process.env.NODE_TEST_CONTEXT,

  port: num('PORT', num('NODE_PORT', 3456)),
  allowedOrigins: str('ALLOWED_ORIGINS'),

  db: {
    type: str('DB_TYPE', 'sqlite'),
    sqlitePath: str('SQLITE_DB_PATH') || path.join(ROOT, 'server', 'data', 'service.db'),
    disableBackup: bool('DISABLE_DB_BACKUP', false),
    backupDir: str('BACKUP_DIR'),
    backupRetentionDays: num('BACKUP_RETENTION_DAYS', 7),
    pgDumpCmd: str('PG_DUMP_CMD', 'pg_dump'),
    pg: {
      host: str('DB_HOST', 'localhost'),
      port: num('DB_PORT', 5432),
      database: str('DB_NAME', 'ai_customer_service'),
      user: str('DB_USER', 'postgres'),
      password: str('DB_PASSWORD', ''),
      poolMax: num('DB_POOL_MAX', 10),
    },
  },

  ai: {
    // 主模型（OpenAI 兼容）
    baseUrl: str('LLM_BASE_URL', str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1')),
    apiKey: str('LLM_API_KEY') || str('DEEPSEEK_API_KEY'),
    model: str('LLM_MODEL', str('DEEPSEEK_MODEL', 'deepseek-chat')),
    temperature: num('LLM_TEMPERATURE', 0.7),
    timeout: num('LLM_TIMEOUT', 60),
    // 备用模型
    fallback: {
      baseUrl: str('FALLBACK_BASE_URL', str('ZHIPU_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4')),
      apiKey: str('FALLBACK_API_KEY') || str('ZHIPU_API_KEY'),
      model: str('FALLBACK_MODEL', str('ZHIPU_MODEL', 'glm-4-flash')),
    },
    // Python LangChain 服务
    langchainServiceUrl: str('LANGCHAIN_SERVICE_URL', 'http://localhost:8000'),
    serviceToken: str('AI_SERVICE_TOKEN'),
    debug: bool('DEBUG_AI', false),
  },

  security: {
    sensitiveLogKey: str('SENSITIVE_LOG_KEY'),
  },

  logging: {
    level: str('LOG_LEVEL', 'info'),
  },

  limits: {
    bodyLimit: str('BODY_LIMIT', '200kb'),
    chatPerMinute: num('RATE_CHAT_PER_MIN', 30),
    createPerMinute: num('RATE_CREATE_PER_MIN', 10),
    adminPerMinute: num('RATE_ADMIN_PER_MIN', 120),
    loginPerWindow: num('RATE_LOGIN_PER_WINDOW', 10),
    loginWindowMs: num('RATE_LOGIN_WINDOW_MS', 15 * 60 * 1000),
  },

  quality: {
    auditDbPath: str('QUALITY_AUDIT_DB_PATH'),
  },

  // 状态层后端：配置 REDIS_URL 即启用 Redis（需 npm i redis），否则内存后端
  redis: {
    url: str('REDIS_URL'),
    keyPrefix: str('REDIS_KEY_PREFIX', 'cs:'),
  },

  // 异步任务：单机默认内联 worker；生产可设 INLINE_WORKERS=false 并独立跑 node server/worker.js
  jobs: {
    inline: bool('INLINE_WORKERS', true),
    concurrency: num('WORKER_CONCURRENCY', 2),
    maxAttempts: num('JOB_MAX_ATTEMPTS', 3),
  },
};

// ============ 启动校验 ============

/**
 * 启动配置校验。
 *
 * 默认行为：只输出告警，不阻断启动 —— 避免重构引入「线上起不来」的新风险。
 * 需要严格模式时设置 STRICT_CONFIG=1，关键项缺失将直接拒绝启动。
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
function validate() {
  const issues = [];

  if (env.isProduction) {
    if (!env.allowedOrigins) {
      issues.push('生产环境未配置 ALLOWED_ORIGINS，带 Origin 的跨域请求将被全部拒绝');
    }
    if (!env.ai.serviceToken) {
      issues.push('生产环境未配置 AI_SERVICE_TOKEN，内部服务调用将不可用');
    } else if (env.ai.serviceToken.length < 32) {
      issues.push('AI_SERVICE_TOKEN 少于 32 位，建议更换为更长的随机串');
    }
    if (!env.security.sensitiveLogKey) {
      issues.push('生产环境未设置 SENSITIVE_LOG_KEY，敏感词日志将无法加密');
    }
    if (env.db.type === 'postgres' && !env.db.pg.password) {
      issues.push('使用 PostgreSQL 但未配置 DB_PASSWORD');
    }
  }

  if (!env.ai.apiKey) {
    issues.push('未配置 LLM_API_KEY，AI 生成能力不可用（知识库检索仍可用）');
  }

  // 只有显式开启严格模式才阻断启动
  if (bool('STRICT_CONFIG', false)) {
    return { errors: issues, warnings: [] };
  }
  return { errors: [], warnings: issues };
}

/** 对外暴露一份脱敏快照，便于 /api/health 与排障 */
function snapshot() {
  return {
    nodeEnv: env.nodeEnv,
    port: env.port,
    db: { type: env.db.type, sqlitePath: env.db.sqlitePath },
    ai: {
      baseUrl: env.ai.baseUrl,
      model: env.ai.model,
      hasApiKey: !!env.ai.apiKey,
      hasFallbackKey: !!env.ai.fallback.apiKey,
      langchainServiceUrl: env.ai.langchainServiceUrl,
    },
    security: { hasSensitiveLogKey: !!env.security.sensitiveLogKey },
  };
}

module.exports = { env, validate, snapshot };
