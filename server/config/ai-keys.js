/**
 * AI 密钥解析（配置层）
 *
 * 优先级：环境变量 > ai-config.json（后台可编辑）
 * 兼容新结构 { llm, fallback } 与旧结构 { deepseek, zhipu }。
 *
 * 之所以单独成文件：knowledge、ai 等多个模块都要判断"有没有可用的 key"，
 * 如果各自复制一份，迟早不一致。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const AI_CONFIG_PATH = path.join(__dirname, '../data/ai-config.json');

const PLACEHOLDERS = new Set([
  'your_deepseek_api_key_here',
  'your_zhipu_api_key_here',
]);

const ENV_MAP = {
  deepseek: {
    apiKey: ['LLM_API_KEY', 'DEEPSEEK_API_KEY'],
    baseUrl: ['LLM_BASE_URL', 'DEEPSEEK_BASE_URL'],
    model: ['LLM_MODEL', 'DEEPSEEK_MODEL'],
  },
  zhipu: {
    apiKey: ['FALLBACK_API_KEY', 'ZHIPU_API_KEY'],
    baseUrl: ['FALLBACK_BASE_URL', 'ZHIPU_BASE_URL'],
    model: ['FALLBACK_MODEL', 'ZHIPU_MODEL'],
  },
};

/** 读取 ai-config.json，失败返回 null */
function readAIConfigFile() {
  try {
    if (fs.existsSync(AI_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[配置] 读取 AI 配置失败:', e.message);
  }
  return null;
}

function clean(value) {
  return value && !PLACEHOLDERS.has(value) ? value : '';
}

/**
 * 取某个 provider 的配置项
 * @param {'deepseek'|'zhipu'} provider 主模型 / 备用模型
 * @param {'apiKey'|'baseUrl'|'model'} key
 * @returns {string} 未配置返回空串
 */
function getConfigValue(provider, key) {
  const envKeys = ENV_MAP[provider]?.[key];
  if (envKeys) {
    for (const name of envKeys) {
      if (process.env[name]) return process.env[name];
    }
  }

  const config = readAIConfigFile();
  if (!config) return '';

  // 新结构：llm = 主模型，fallback = 备用模型
  const node = provider === 'zhipu' ? config.fallback : config.llm;
  if (node) {
    const val = clean(node[key]);
    if (val) return val;
  }

  // 旧结构兼容
  return clean(config?.[provider]?.[key]);
}

module.exports = { getConfigValue, readAIConfigFile };
