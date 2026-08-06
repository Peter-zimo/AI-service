const axios = require('axios');
const knowledgeService = require('./knowledge');
const { readAIConfig } = require('../utils/config');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../data/ai-config.json');

// 配置文件 mtime 缓存，避免无变化时重复读取
let _configMtime = null;

// 动态AI配置（从配置文件读取，主流结构：主模型 + 备用模型）
let AI_CONFIG = {
  // 主模型（OpenAI 兼容）
  llm: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.7
  },
  // 备用模型（可选，主模型不可用时降级）
  fallback: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash'
  },
  // 系统提示词
  systemPrompt: '你是一个专业的客服助手，说话简洁专业，热情友好。如果不知道答案就说"这个问题我暂时无法回答，我会反馈给相关人员"。'
};

const PLACEHOLDER_KEYS = ['your_deepseek_api_key_here', 'your_zhipu_api_key_here'];
const cleanKey = (k) => (k && !PLACEHOLDER_KEYS.includes(k)) ? k : '';

// 兼容旧结构 → 新结构
function migrateConfig(cfg) {
  if (cfg.llm) return cfg;
  if (!cfg.deepseek && !cfg.zhipu) return cfg;
  return {
    llm: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: cleanKey(cfg.deepseek?.apiKey), model: cfg.deepseek?.model || 'deepseek-chat', temperature: 0.7 },
    fallback: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: cleanKey(cfg.zhipu?.apiKey), model: cfg.zhipu?.model || 'glm-4-flash' },
    systemPrompt: cfg.systemPrompt
  };
}

// 同步加载初始配置（避免 async 竞态）
function syncLoadInitialConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = migrateConfig(JSON.parse(raw));

    if (config.llm) {
      AI_CONFIG.llm.provider = config.llm.provider || 'deepseek';
      AI_CONFIG.llm.baseUrl = config.llm.baseUrl || 'https://api.deepseek.com/v1';
      AI_CONFIG.llm.model = config.llm.model || 'deepseek-chat';
      AI_CONFIG.llm.temperature = config.llm.temperature ?? 0.7;
      const key = config.llm.apiKey || '';
      AI_CONFIG.llm.apiKey = cleanKey(key) || process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
    }
    if (config.fallback) {
      AI_CONFIG.fallback.baseUrl = config.fallback.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
      AI_CONFIG.fallback.model = config.fallback.model || 'glm-4-flash';
      const key = config.fallback.apiKey || '';
      AI_CONFIG.fallback.apiKey = cleanKey(key) || process.env.FALLBACK_API_KEY || process.env.ZHIPU_API_KEY || '';
    }
    AI_CONFIG.systemPrompt = config.systemPrompt || AI_CONFIG.systemPrompt;

    // 记录 mtime 防止重复加载
    _configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch (_) { /* 初始加载失败不影响后续异步加载 */ }
}

// 先同步加载，再启动异步刷新
syncLoadInitialConfig();

// 异步加载配置（支持热更新）
async function loadAIConfig() {
  try {
    // 检查文件 mtime 是否变化
    let mtime = null;
    try {
      const stat = fs.statSync(CONFIG_FILE);
      mtime = stat.mtimeMs;
    } catch {
      // 配置文件不存在，跳过
      return;
    }
    if (_configMtime !== null && _configMtime === mtime) {
      return; // 文件未变化，跳过
    }
    _configMtime = mtime;

    const config = await readAIConfig();

    if (config.llm) {
      AI_CONFIG.llm.provider = config.llm.provider || 'deepseek';
      AI_CONFIG.llm.baseUrl = config.llm.baseUrl || 'https://api.deepseek.com/v1';
      AI_CONFIG.llm.model = config.llm.model || 'deepseek-chat';
      AI_CONFIG.llm.temperature = config.llm.temperature ?? 0.7;
      const configKey = config.llm.apiKey || '';
      AI_CONFIG.llm.apiKey = cleanKey(configKey) || process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
    }
    if (config.fallback) {
      AI_CONFIG.fallback.baseUrl = config.fallback.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
      AI_CONFIG.fallback.model = config.fallback.model || 'glm-4-flash';
      const configKey = config.fallback.apiKey || '';
      AI_CONFIG.fallback.apiKey = cleanKey(configKey) || process.env.FALLBACK_API_KEY || process.env.ZHIPU_API_KEY || '';
    }
    AI_CONFIG.systemPrompt = config.systemPrompt || AI_CONFIG.systemPrompt;

    // 只在配置有变化时输出日志
    if (process.env.DEBUG_AI) {
      console.log('AI配置已加载:', {
        llm: { provider: AI_CONFIG.llm.provider, baseUrl: AI_CONFIG.llm.baseUrl, model: AI_CONFIG.llm.model, hasKey: !!AI_CONFIG.llm.apiKey },
        fallback: { model: AI_CONFIG.fallback.model, hasKey: !!AI_CONFIG.fallback.apiKey }
      });
    }
  } catch (error) {
    console.error('加载AI配置失败:', error);
  }
}

// 异步刷新（热更新支持）
setInterval(loadAIConfig, 30000);

class AIService {
  constructor() {
    this.conversationHistory = new Map();
    this.maxHistoryLength = 10;
  }

  getHistory(conversationId) {
    return this.conversationHistory.get(conversationId) || [];
  }

  addToHistory(conversationId, role, content) {
    if (!this.conversationHistory.has(conversationId)) {
      this.conversationHistory.set(conversationId, []);
    }
    const history = this.conversationHistory.get(conversationId);
    history.push({ role, content });
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  clearHistory(conversationId) {
    this.conversationHistory.delete(conversationId);
  }

  // 获取可用的AI提供商（主模型优先，备用模型兜底）
  getAvailableProvider() {
    // 强制重新加载配置
    const config = global._aiConfig || AI_CONFIG;
    if (config.llm && config.llm.apiKey) {
      return 'deepseek';
    }
    if (config.fallback && config.fallback.apiKey) {
      return 'zhipu';
    }
    return null;
  }

  // 获取指定 provider 对应的配置（'deepseek' → 主模型，'zhipu' → 备用模型）
  getProviderConfig(provider) {
    const config = global._aiConfig || AI_CONFIG;
    return provider === 'zhipu' ? (config.fallback || AI_CONFIG.fallback) : (config.llm || AI_CONFIG.llm);
  }

  // 更新全局配置缓存
  updateConfig(config) {
    global._aiConfig = config;
  }

  async chat(conversationId, userMessage) {
    // 1. 查询知识库获取最佳匹配（混合检索：FTS5 + 语义向量 + RRF）
    const bestMatch = await knowledgeService.getBestMatch(userMessage);
    let knowledgeMatches = [];
    if (bestMatch) {
      // 兼容新旧两种评分体系
      const legacyScore = bestMatch.matchedKeywords !== undefined ? bestMatch.score : -1;
      const hybridScore = bestMatch.source ? bestMatch.score : -1;
      if (legacyScore >= 2 || hybridScore >= 0) {
        knowledgeMatches = [bestMatch];
      }
    }

    console.log(`[AI服务] 收到消息: "${userMessage}", 最佳匹配: ${bestMatch ? (bestMatch.question + ' score=' + bestMatch.score) : '无'}`);

    // 2. 检查AI配置
    const provider = this.getAvailableProvider();
    console.log(`[AI服务] AI提供商: ${provider || '无'}`);

    // 3. 知识库有匹配 → 直接返回知识库答案（不走AI改写，保证优先级最高）
    if (bestMatch && knowledgeMatches.length > 0) {
      // 传统评分: score >= 2 才返回；混合评分: 有source说明通过了阈值
      const isLegacy = bestMatch.matchedKeywords !== undefined;
      if (isLegacy && bestMatch.score < 2) {
        // 传统评分不足，不走知识库
      } else {
        this.addToHistory(conversationId, 'user', userMessage);
        this.addToHistory(conversationId, 'assistant', bestMatch.answer);
        console.log(`[AI服务] 知识库命中(score=${bestMatch.score})，直接返回，跳过AI`);
        return {
          type: 'knowledge',
          answer: bestMatch.answer,
          confidence: isLegacy ? Math.min(bestMatch.score / 10, 1) : Math.min(bestMatch.score * 2, 1),
          matchQuestion: bestMatch.question,
          provider: 'knowledge'
        };
      }
    }

    // 4. 知识库没有命中 → 尝试AI回答
    if (provider) {
      try {
        return await this.chatWithAI(conversationId, userMessage, provider, knowledgeMatches);
      } catch (error) {
        console.error('AI调用失败:', error.message);
      }
    }

    // 5. 最终兜底回复（必须提示转人工）
    return this.getDefaultResponse(userMessage);
  }

  async chatWithAI(conversationId, userMessage, provider, knowledgeMatches = []) {
    try {
      const history = this.getHistory(conversationId);
      
      // 构建系统提示词，融入知识库内容
      let systemPrompt = AI_CONFIG.systemPrompt;
      
      // 如果有知识库匹配，将相关内容加入系统提示词
      if (knowledgeMatches.length > 0) {
        const knowledgeContext = knowledgeMatches.map((k, i) => 
          `[知识${i + 1}] Q: ${k.question}\nA: ${k.answer}`
        ).join('\n\n');
        
        systemPrompt += `\n\n=== 知识库参考 ===\n以下是与用户问题相关的知识库内容，请优先参考这些内容回答。如果知识库内容足以回答问题，请直接使用；如果不够，请结合你的知识补充回答。\n\n${knowledgeContext}\n\n=== 回答要求 ===\n1. 优先使用知识库中的准确信息\n2. 保持专业、友好的语气\n3. 如果知识库中没有相关信息，请明确说明"根据我的知识库，暂时没有找到相关信息"，然后给出你的建议`;
      }
      
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage }
      ];

      let response;
      if (provider === 'zhipu') {
        response = await this.callZhipuAI(messages);
      } else if (provider === 'deepseek') {
        response = await this.callDeepSeek(messages);
      } else {
        throw new Error('没有可用的AI提供商');
      }

      this.addToHistory(conversationId, 'user', userMessage);
      this.addToHistory(conversationId, 'assistant', response);

      return {
        type: 'ai',
        answer: response,
        confidence: 0.9,
        provider: provider
      };
    } catch (error) {
      console.error(`AI调用错误(${provider}):`, error.message);
      
      // 如果当前提供商失败，尝试另一个
      const fallbackProvider = provider === 'zhipu' ? 'deepseek' : 'zhipu';
      if (fallbackProvider !== provider && this.getAvailableProvider() === fallbackProvider) {
        console.log(`尝试切换到 ${fallbackProvider}...`);
        return await this.chatWithAI(conversationId, userMessage, fallbackProvider);
      }
      
      return this.getDefaultResponse(userMessage);
    }
  }

  /**
   * 流式 AI 回答（SSE）
   * @param {string} conversationId
   * @param {string} userMessage
   * @param {string} provider - 'zhipu' | 'deepseek'
   * @param {Array} knowledgeMatches - 知识库参考
   * @param {function} onToken - 每收到一个 token 回调(token:string)
   * @param {function} onEnd - 流结束回调(fullContent:string)
   * @param {function} onError - 异常回调(err:Error)
   */
  async streamChatWithAI(conversationId, userMessage, provider, knowledgeMatches, onToken, onEnd, onError) {
    try {
      const history = this.getHistory(conversationId);

      // 构建系统提示词（同 chatWithAI）
      let systemPrompt = AI_CONFIG.systemPrompt;
      if (knowledgeMatches.length > 0) {
        const knowledgeContext = knowledgeMatches.map((k, i) =>
          `[知识${i + 1}] Q: ${k.question}\nA: ${k.answer}`
        ).join('\n\n');
        systemPrompt += `\n\n=== 知识库参考 ===\n${knowledgeContext}\n\n=== 回答要求 ===\n1. 优先使用知识库准确信息\n2. 保持专业友好语气\n3. 未命中则明确说明"根据知识库暂时没有找到相关信息"`;
      }

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage }
      ];

      const pc = this.getProviderConfig(provider);
      const config = { baseURL: pc.baseUrl, model: pc.model, apiKey: pc.apiKey };

      // 使用原生 https 替代 axios 流式（axios 1.x stream 在 Node.js 下有 data 事件不触发的问题）
      const url = new URL(`${config.baseURL}/chat/completions`);
      const https = require('https');
      const postData = JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2000
      });

      let fullContent = '';
      let buffer = '';

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 30000
      }, (res) => {
        if (res.statusCode !== 200) {
          console.error(`[AI流式] DeepSeek 返回非200: ${res.statusCode}`);
          onError(new Error(`AI 服务返回 ${res.statusCode}`));
          return;
        }
        res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            this.addToHistory(conversationId, 'user', userMessage);
            this.addToHistory(conversationId, 'assistant', fullContent);
            onEnd(fullContent);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content || '';
            if (token) {
              fullContent += token;
              onToken(token);
            }
          } catch (_) { /* 忽略解析失败的碎片 */ }
        }
      });

      res.on('end', () => {
        if (fullContent) {
          // 流结束但没收到 [DONE] 标记，仍然完成并保存
          this.addToHistory(conversationId, 'user', userMessage);
          this.addToHistory(conversationId, 'assistant', fullContent);
          onEnd(fullContent);
        } else {
          onError(new Error('AI 返回为空'));
        }
      });

      res.on('error', err => {
        onError(err);
      });
    }); // 结束 https.request 回调

    req.write(postData);
    req.end();
    req.on('error', err => onError(err));

    } catch (err) {
      // 主提供商失败，尝试备用
      const fallbackProvider = provider === 'zhipu' ? 'deepseek' : 'zhipu';
      if (fallbackProvider !== provider && this.getAvailableProvider() === fallbackProvider) {
        console.log(`[AI流式] ${provider} 失败，切换到 ${fallbackProvider}`);
        return this.streamChatWithAI(conversationId, userMessage, fallbackProvider, knowledgeMatches, onToken, onEnd, onError);
      }
      onError(err);
    }
  }

  // 调用智谱AI（备用模型）
  async callZhipuAI(messages) {
    return this.callChatCompletions(this.getProviderConfig('zhipu'), messages);
  }

  // 调用DeepSeek（主模型）
  async callDeepSeek(messages) {
    return this.callChatCompletions(this.getProviderConfig('deepseek'), messages);
  }

  // 通用 OpenAI 兼容调用（任意 Base URL + API Key + Model）
  async callChatCompletions(pc, messages, maxTokens = 2000) {
    const response = await axios.post(
      `${pc.baseUrl}/chat/completions`,
      {
        model: pc.model,
        messages,
        temperature: pc.temperature ?? 0.7,
        max_tokens: maxTokens
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${pc.apiKey}`
        },
        timeout: 30000,
        proxy: false // 绕过系统 HTTP_PROXY，直连模型服务
      }
    );

    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    }
    throw new Error('AI返回格式异常');
  }

  // 测试AI连接（直接使用传入的配置，不依赖已保存状态）
  async testConnection({ baseUrl, apiKey, model }) {
    try {
      console.log(`[AI测试] 测试连接: ${baseUrl} / ${model}`);
      const testMessages = [
        { role: 'system', content: '你是一个测试助手' },
        { role: 'user', content: '你好，请回复"测试成功"' }
      ];

      const response = await axios.post(
        `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`,
        {
          model,
          messages: testMessages,
          temperature: 0.7,
          max_tokens: 100
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          timeout: 15000,
          proxy: false // 绕过系统 HTTP_PROXY，直连模型服务
        }
      );

      if (response.data && response.data.choices && response.data.choices[0]) {
        return { success: true, message: '连接正常，API Key 有效' };
      }
      return { success: false, message: '返回格式异常' };
    } catch (error) {
      console.error(`[AI测试] 连接失败:`, error.message);
      if (error.code === 'ECONNREFUSED') {
        return { success: false, message: '无法连接到 AI 服务器(ECONNREFUSED)' };
      }
      if (error.code === 'ENOTFOUND') {
        return { success: false, message: 'DNS 解析失败，请检查 Base URL(ENOTFOUND)' };
      }
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return { success: false, message: '连接超时，请检查网络或稍后重试' };
      }
      if (error.response) {
        const status = error.response.status;
        if (status === 401) {
          return { success: false, message: 'API Key 无效或已过期(401)' };
        }
        if (status === 404) {
          return { success: false, message: '接口地址不存在(404)，请检查 Base URL' };
        }
        if (status === 429) {
          return { success: false, message: '请求过于频繁，请稍后再试(429)' };
        }
        if (status === 500) {
          return { success: false, message: 'AI 服务器内部错误(500)，请稍后重试' };
        }
        return { success: false, message: `API 错误(${status}): ${(error.response.data && (error.response.data.error?.message || error.response.data.message)) || '未知错误'}` };
      }
      return { success: false, message: error.message || '连接失败' };
    }
  }

  getDefaultResponse(userMessage) {
    const lowerMsg = userMessage.toLowerCase();

    if (lowerMsg.includes('转人工') || lowerMsg.includes('真人') || lowerMsg.includes('人工客服')) {
      return {
        type: 'transfer',
        answer: '好的，我帮您转接人工客服，请稍候...\n\n当前排队人数：1人\n预计等待时间：2-3分钟',
        confidence: 1,
        provider: 'system'
      };
    }

    if (lowerMsg.includes('你好') || lowerMsg.includes('hi') || lowerMsg.includes('hello') || lowerMsg.includes('在吗')) {
      return {
        type: 'greeting',
        answer: '您好！很高兴为您服务。我是AI智能客服，可以帮您解答常见问题。\n\n您可以咨询产品信息、了解服务内容、查询订单问题~\n\n如果遇到知识库无法解答的问题，可以输入"转人工"联系真人客服~',
        confidence: 1,
        provider: 'system'
      };
    }

    if (lowerMsg.includes('再见') || lowerMsg.includes('拜拜') || lowerMsg.includes('谢谢')) {
      return {
        type: 'farewell',
        answer: '感谢您的咨询！如有其他问题，随时欢迎回来。\n\n祝您生活愉快！',
        confidence: 1,
        provider: 'system'
      };
    }

    // 知识库没有匹配时的回复（必须提示转人工）
    return {
      type: 'fallback',
      answer: '抱歉，根据我的知识库，暂时没有找到与您问题相关的信息。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系真人客服获得帮助\n\n感谢您的理解！',
      confidence: 0.3,
      provider: 'system'
    };
  }

  // 获取当前配置状态
  getConfigStatus() {
    const config = global._aiConfig || AI_CONFIG;
    return {
      llm: {
        provider: config.llm.provider || 'deepseek',
        hasKey: !!config.llm.apiKey,
        baseUrl: config.llm.baseUrl || '',
        model: config.llm.model || ''
      },
      fallback: {
        hasKey: !!config.fallback.apiKey,
        model: config.fallback.model || ''
      },
      availableProvider: this.getAvailableProvider()
    };
  }
}

module.exports = new AIService();
