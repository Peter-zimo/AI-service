/**
 * AI 配置（运行时可变）
 *
 * 配置来源优先级：环境变量 > data/ai-config.json > 内置默认值。
 * 支持热更新：每 30 秒检查文件 mtime，变化才重新加载。
 *
 * 注意：AI_CONFIG 是可变对象，多处直接引用它，不要替换引用本身。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readAIConfig } = require('../../utils/config');

const CONFIG_FILE = path.join(__dirname, '../../data/ai-config.json');

const PLACEHOLDER_KEYS = ['your_deepseek_api_key_here', 'your_zhipu_api_key_here'];
const cleanKey = (k) => (k && !PLACEHOLDER_KEYS.includes(k)) ? k : '';

const AI_CONFIG = {
  llm: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.7,
  },
  fallback: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash',
  },
  systemPrompt: '你是一个专业的客服助手，说话简洁专业，热情友好。如果不知道答案就说"这个问题我暂时无法回答，我会反馈给相关人员"。',
};

let _configMtime = null;

/** 旧结构 { deepseek, zhipu } → 新结构 { llm, fallback } */
function migrateConfig(cfg) {
  if (cfg.llm) return cfg;
  if (!cfg.deepseek && !cfg.zhipu) return cfg;

  return {
    llm: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: cleanKey(cfg.deepseek?.apiKey),
      model: cfg.deepseek?.model || 'deepseek-chat',
      temperature: 0.7,
    },
    fallback: {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: cleanKey(cfg.zhipu?.apiKey),
      model: cfg.zhipu?.model || 'glm-4-flash',
    },
    systemPrompt: cfg.systemPrompt,
  };
}

/** 把一份配置写进 AI_CONFIG（保持对象引用不变） */
function applyConfig(config) {
  if (config.llm) {
    AI_CONFIG.llm.provider = config.llm.provider || 'deepseek';
    AI_CONFIG.llm.baseUrl = config.llm.baseUrl || 'https://api.deepseek.com/v1';
    AI_CONFIG.llm.model = config.llm.model || 'deepseek-chat';
    AI_CONFIG.llm.temperature = config.llm.temperature ?? 0.7;
    AI_CONFIG.llm.apiKey = cleanKey(config.llm.apiKey || '') ||
      process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  }

  if (config.fallback) {
    AI_CONFIG.fallback.baseUrl = config.fallback.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
    AI_CONFIG.fallback.model = config.fallback.model || 'glm-4-flash';
    AI_CONFIG.fallback.apiKey = cleanKey(config.fallback.apiKey || '') ||
      process.env.FALLBACK_API_KEY || process.env.ZHIPU_API_KEY || '';
  }

  AI_CONFIG.systemPrompt = config.systemPrompt || AI_CONFIG.systemPrompt;
}

/** 同步加载初始配置（避免异步竞态） */
function syncLoadInitialConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return;

    const config = migrateConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
    applyConfig(config);
    _configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch (_) {
    // 初始加载失败不影响后续异步加载
  }
}

/** 异步加载（文件未变化则跳过） */
async function loadAIConfig() {
  try {
    let mtime;
    try {
      mtime = fs.statSync(CONFIG_FILE).mtimeMs;
    } catch {
      return; // 配置文件不存在
    }

    if (_configMtime !== null && _configMtime === mtime) return;
    _configMtime = mtime;

    applyConfig(await readAIConfig());

    if (process.env.DEBUG_AI) {
      console.log('AI配置已加载:', {
        llm: {
          provider: AI_CONFIG.llm.provider,
          baseUrl: AI_CONFIG.llm.baseUrl,
          model: AI_CONFIG.llm.model,
          hasKey: !!AI_CONFIG.llm.apiKey,
        },
        fallback: { model: AI_CONFIG.fallback.model, hasKey: !!AI_CONFIG.fallback.apiKey },
      });
    }
  } catch (error) {
    console.error('加载AI配置失败:', error);
  }
}

/** 当前生效的配置（后台保存后通过 global 覆盖） */
function getConfig() {
  return global._aiConfig || AI_CONFIG;
}

/** 后台保存配置后写入全局缓存 */
function setConfig(config) {
  global._aiConfig = config;
}

function startAutoReload() {
  const timer = setInterval(loadAIConfig, 30 * 1000);
  timer.unref();
  return timer;
}

// 先同步加载，再启动异步刷新
syncLoadInitialConfig();

module.exports = {
  AI_CONFIG,
  CONFIG_FILE,
  cleanKey,
  migrateConfig,
  applyConfig,
  syncLoadInitialConfig,
  loadAIConfig,
  getConfig,
  setConfig,
  startAutoReload,
};
