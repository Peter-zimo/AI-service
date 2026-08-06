/**
 * 配置文件工具函数
 * 避免循环依赖问题
 */

const fs = require('fs').promises;
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../data/ai-config.json');
const BRAND_FILE = path.join(__dirname, '../data/brand.json');

// 默认配置（主流结构：单一主模型 + 可选备用模型，OpenAI 兼容）
const DEFAULT_CONFIG = {
  llm: {
    provider: 'deepseek',                     // 仅用于展示/日志，可任意命名
    baseUrl: 'https://api.deepseek.com/v1',   // OpenAI 兼容 Base URL
    apiKey: '',                               // API Key（安全存储于 .env 优先）
    model: 'deepseek-chat',
    temperature: 0.7
  },
  fallback: {                                 // 备用模型（可选，主模型不可用时降级）
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash'
  },
  systemPrompt: '你是一个专业的客服助手，说话简洁专业，热情友好。如果不知道答案就说"这个问题我暂时无法回答，我会反馈给相关人员"，并建议用户转人工客服。',
  updatedAt: null
};

// 旧版 ai-config.json（zhipu/deepseek 双结构）→ 新结构迁移
function migrateLegacyConfig(config) {
  if (config.llm) return config; // 已是新结构
  if (!config.deepseek && !config.zhipu) return config;
  const cleanKey = (k) => (k && k !== 'your_deepseek_api_key_here' && k !== 'your_zhipu_api_key_here') ? k : '';
  return {
    llm: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: cleanKey(config.deepseek?.apiKey),
      model: config.deepseek?.model || 'deepseek-chat',
      temperature: 0.7
    },
    fallback: {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: cleanKey(config.zhipu?.apiKey),
      model: config.zhipu?.model || 'glm-4-flash'
    },
    systemPrompt: config.systemPrompt || DEFAULT_CONFIG.systemPrompt,
    updatedAt: config.updatedAt
  };
}

// 确保配置文件目录存在
async function ensureConfigDir() {
  const configDir = path.dirname(CONFIG_FILE);
  try {
    await fs.access(configDir);
  } catch {
    await fs.mkdir(configDir, { recursive: true });
  }
}

// 读取AI配置（环境变量优先级高于 JSON 文件）
async function readAIConfig() {
  try {
    await ensureConfigDir();
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const migrated = migrateLegacyConfig(parsed);
    const config = { ...DEFAULT_CONFIG, ...migrated, llm: { ...DEFAULT_CONFIG.llm, ...(migrated.llm || {}) }, fallback: { ...DEFAULT_CONFIG.fallback, ...(migrated.fallback || {}) } };

    // 环境变量覆盖（安全存储 API Key）：LLM_* 优先，兼容旧 DEEPSEEK_API_KEY / ZHIPU_API_KEY
    const llmKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
    if (llmKey) config.llm.apiKey = llmKey;
    if (process.env.LLM_BASE_URL) config.llm.baseUrl = process.env.LLM_BASE_URL;
    if (process.env.LLM_MODEL) config.llm.model = process.env.LLM_MODEL;
    const fbKey = process.env.FALLBACK_API_KEY || process.env.ZHIPU_API_KEY;
    if (fbKey) config.fallback.apiKey = fbKey;
    if (process.env.FALLBACK_BASE_URL) config.fallback.baseUrl = process.env.FALLBACK_BASE_URL;
    if (process.env.FALLBACK_MODEL) config.fallback.model = process.env.FALLBACK_MODEL;

    if (global.aiService) {
      global.aiService.updateConfig(config);
    }
    return config;
  } catch {
    const fallback = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm }, fallback: { ...DEFAULT_CONFIG.fallback } };
    const llmKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
    if (llmKey) fallback.llm.apiKey = llmKey;
    if (process.env.LLM_BASE_URL) fallback.llm.baseUrl = process.env.LLM_BASE_URL;
    if (process.env.LLM_MODEL) fallback.llm.model = process.env.LLM_MODEL;
    const fbKey = process.env.FALLBACK_API_KEY || process.env.ZHIPU_API_KEY;
    if (fbKey) fallback.fallback.apiKey = fbKey;
    return fallback;
  }
}

// 保存AI配置
async function saveAIConfig(config) {
  await ensureConfigDir();
  const data = {
    ...config,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

// ========== 品牌配置 ==========
const DEFAULT_BRAND = {
  name: "AI智能客服",
  logo: "🤖",
  description: "智能客服助手，7×24小时为您服务",
  primaryColor: "#2563eb",
  headerGradientStart: "#2563eb",
  headerGradientEnd: "#1d4ed8",
  botName: "小智",
  welcomeMessage: "您好！我是{botName}，很高兴为您服务。<br><br>有什么可以帮到您？也可以点击上方快捷问题快速提问~",
  quickQuestions: [
    { text: "工作时间", question: "你们的工作时间是几点？" },
    { text: "转人工", action: "request_human" },
    { text: "价格咨询", question: "产品价格是多少？" },
    { text: "免费试用", question: "有免费试用吗？" }
  ],
  statusText: {
    active: "会话活跃中",
    idle: "会话空闲中",
    closed: "会话已结束",
    human: "人工客服：{agentName}",
    queue: "排队中（第{position}位）"
  },
  placeholder: "输入您的问题...",
  footerHint: "Enter 发送 · Shift+Enter 换行",
  ratingTitle: "本次服务评价",
  ratingSubtitle: "您的反馈帮助我们持续改进",
  hotline: "",
  copyright: ""
};

// 读取品牌配置（公开接口，不包含敏感信息）
async function readBrandConfig() {
  try {
    await ensureConfigDir();
    const data = await fs.readFile(BRAND_FILE, 'utf8');
    const config = JSON.parse(data);
    // 合并默认配置，确保字段完整
    return { ...DEFAULT_BRAND, ...config };
  } catch {
    return { ...DEFAULT_BRAND };
  }
}

// 保存品牌配置
async function saveBrandConfig(config) {
  await ensureConfigDir();
  const data = {
    ...config,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(BRAND_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

module.exports = {
  readAIConfig,
  saveAIConfig,
  DEFAULT_CONFIG,
  readBrandConfig,
  saveBrandConfig,
  DEFAULT_BRAND
};
