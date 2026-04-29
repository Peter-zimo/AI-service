const axios = require('axios');
const knowledgeService = require('./knowledge');
const { readAIConfig } = require('../utils/config');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../data/ai-config.json');

// 配置文件 mtime 缓存，避免无变化时重复读取
let _configMtime = null;

// 动态AI配置（从配置文件读取）
let AI_CONFIG = {
  // 智谱AI配置
  zhipu: {
    enabled: false,
    apiKey: '',
    model: 'glm-4-flash',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4'
  },
  // DeepSeek配置
  deepseek: {
    enabled: false,
    apiKey: '',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1'
  },
  // 默认使用的AI提供商: 'zhipu' | 'deepseek'
  defaultProvider: 'zhipu',
  // 系统提示词
  systemPrompt: '你是一个专业的客服助手，说话简洁专业，热情友好。如果不知道答案就说"这个问题我暂时无法回答，我会反馈给相关人员"。'
};

// 加载配置（仅当配置文件 mtime 变化时才重新读取）
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
    
    // 智谱AI配置
    if (config.zhipu) {
      AI_CONFIG.zhipu.apiKey = config.zhipu.apiKey || '';
      AI_CONFIG.zhipu.enabled = config.zhipu.enabled || false;
      AI_CONFIG.zhipu.model = config.zhipu.model || 'glm-4-flash';
    }
    
    // DeepSeek配置
    if (config.deepseek) {
      AI_CONFIG.deepseek.apiKey = config.deepseek.apiKey || '';
      AI_CONFIG.deepseek.enabled = config.deepseek.enabled || false;
      AI_CONFIG.deepseek.model = config.deepseek.model || 'deepseek-chat';
    }
    
    // 默认提供商
    AI_CONFIG.defaultProvider = config.defaultProvider || 'zhipu';
    AI_CONFIG.systemPrompt = config.systemPrompt || AI_CONFIG.systemPrompt;
    
    // 只在配置有变化时输出日志
    if (process.env.DEBUG_AI) {
      console.log('AI配置已加载:', {
        zhipu: { enabled: AI_CONFIG.zhipu.enabled, model: AI_CONFIG.zhipu.model },
        deepseek: { enabled: AI_CONFIG.deepseek.enabled, model: AI_CONFIG.deepseek.model },
        defaultProvider: AI_CONFIG.defaultProvider
      });
    }
  } catch (error) {
    console.error('加载AI配置失败:', error);
  }
}

// 初始加载
loadAIConfig();

// 每30秒刷新一次配置（支持热更新）
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

  // 获取可用的AI提供商
  getAvailableProvider() {
    // 强制重新加载配置
    const config = global._aiConfig || AI_CONFIG;
    if (config.zhipu && config.zhipu.enabled && config.zhipu.apiKey) {
      return 'zhipu';
    }
    if (config.deepseek && config.deepseek.enabled && config.deepseek.apiKey) {
      return 'deepseek';
    }
    return null;
  }

  // 更新全局配置缓存
  updateConfig(config) {
    global._aiConfig = config;
  }

  async chat(conversationId, userMessage) {
    // 1. 查询知识库获取相关内容（优先级最高）
    const knowledgeMatches = knowledgeService.search(userMessage);
    const bestMatch = knowledgeMatches.length > 0 ? knowledgeMatches[0] : null;

    console.log(`[AI服务] 收到消息: "${userMessage}", 知识库匹配: ${knowledgeMatches.length}, 最佳匹配: ${bestMatch ? bestMatch.question : '无'}`);

    // 2. 检查AI配置
    const provider = this.getAvailableProvider();
    console.log(`[AI服务] AI提供商: ${provider || '无'}`);

    // 3. 知识库有匹配 → 直接返回知识库答案（不走AI改写，保证优先级最高）
    if (bestMatch && bestMatch.score >= 2) {
      this.addToHistory(conversationId, 'user', userMessage);
      this.addToHistory(conversationId, 'assistant', bestMatch.answer);
      console.log(`[AI服务] 知识库命中(score=${bestMatch.score})，直接返回，跳过AI`);
      return {
        type: 'knowledge',
        answer: bestMatch.answer,
        confidence: Math.min(bestMatch.score / 10, 1),
        matchQuestion: bestMatch.question,
        provider: 'knowledge'
      };
    }

    // 4. 知识库没有命中 → 尝试AI回答
    if (provider) {
      try {
        return await this.chatWithAI(conversationId, userMessage, provider, []);
      } catch (error) {
        console.error('AI调用失败:', error.message);
      }
    }

    // 6. 最终兜底回复（必须提示转人工）
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

  // 调用智谱AI
  async callZhipuAI(messages) {
    const response = await axios.post(
      `${AI_CONFIG.zhipu.baseURL}/chat/completions`,
      {
        model: AI_CONFIG.zhipu.model,
        messages,
        temperature: 0.7,
        max_tokens: 2000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_CONFIG.zhipu.apiKey}`
        },
        timeout: 30000
      }
    );

    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    }
    throw new Error('智谱AI返回格式异常');
  }

  // 调用DeepSeek
  async callDeepSeek(messages) {
    const response = await axios.post(
      `${AI_CONFIG.deepseek.baseURL}/chat/completions`,
      {
        model: AI_CONFIG.deepseek.model,
        messages,
        temperature: 0.7,
        max_tokens: 2000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_CONFIG.deepseek.apiKey}`
        },
        timeout: 30000
      }
    );

    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    }
    throw new Error('DeepSeek返回格式异常');
  }

  // 测试AI连接（使用最新配置）
  async testProvider(provider) {
    try {
      console.log(`[AI测试] 开始测试${provider}连接...`);
      
      // 重新加载最新配置
      let latestConfig;
      try {
        latestConfig = await readAIConfig();
      } catch (configError) {
        console.error('[AI测试] 读取配置失败:', configError);
        return { success: false, message: '读取配置文件失败: ' + configError.message };
      }
      
      // 检查配置是否有效
      if (!latestConfig) {
        return { success: false, message: '配置为空，请先保存API Key' };
      }
      
      console.log(`[AI测试] 配置加载完成:`, {
        zhipu: { hasKey: !!(latestConfig.zhipu && latestConfig.zhipu.apiKey), enabled: latestConfig.zhipu && latestConfig.zhipu.enabled },
        deepseek: { hasKey: !!(latestConfig.deepseek && latestConfig.deepseek.apiKey), enabled: latestConfig.deepseek && latestConfig.deepseek.enabled }
      });
      
      const testMessages = [
        { role: 'system', content: '你是一个测试助手' },
        { role: 'user', content: '你好，请回复"测试成功"' }
      ];

      if (provider === 'zhipu') {
        const apiKey = latestConfig.zhipu && latestConfig.zhipu.apiKey;
        if (!apiKey) {
          console.log('[AI测试] 智谱AI API Key未配置');
          return { success: false, message: '智谱AI API Key未配置，请先填写API Key并点击保存' };
        }
        console.log('[AI测试] 调用智谱AI API...');
        const result = await this.callZhipuAIWithKey(testMessages, apiKey, (latestConfig.zhipu && latestConfig.zhipu.model) || 'glm-4-flash');
        console.log('[AI测试] 智谱AI响应:', result);
        return { success: true, message: '连接正常，API Key有效' };
      } else if (provider === 'deepseek') {
        const apiKey = latestConfig.deepseek && latestConfig.deepseek.apiKey;
        if (!apiKey) {
          console.log('[AI测试] DeepSeek API Key未配置');
          return { success: false, message: 'DeepSeek API Key未配置，请先填写API Key并点击保存' };
        }
        console.log('[AI测试] 调用DeepSeek API...');
        const result = await this.callDeepSeekWithKey(testMessages, apiKey, (latestConfig.deepseek && latestConfig.deepseek.model) || 'deepseek-chat');
        console.log('[AI测试] DeepSeek响应:', result);
        return { success: true, message: '连接正常，API Key有效' };
      } else {
        return { success: false, message: '未知的AI提供商' };
      }
    } catch (error) {
      console.error(`[AI测试] ${provider}连接失败:`, error);
      // 提供更具体的错误信息
      if (error.code === 'ECONNREFUSED') {
        return { success: false, message: '无法连接到AI服务器(ECONNREFUSED)' };
      }
      if (error.code === 'ENOTFOUND') {
        return { success: false, message: 'DNS解析失败，请检查网络(ENOTFOUND)' };
      }
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return { success: false, message: '连接超时，请检查网络或稍后重试' };
      }
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;
        console.error(`[AI测试] API返回错误(${status}):`, errorData);
        if (status === 401) {
          return { success: false, message: 'API Key无效或已过期(401)' };
        }
        if (status === 429) {
          return { success: false, message: '请求过于频繁，请稍后再试(429)' };
        }
        if (status === 500) {
          return { success: false, message: 'AI服务器内部错误(500)，请稍后重试' };
        }
        return { success: false, message: `API错误(${status}): ${errorData && errorData.error && errorData.error.message ? errorData.error.message : (errorData && errorData.message ? errorData.message : '未知错误')}` };
      }
      return { success: false, message: error.message || '连接失败' };
    }
  }

  // 使用指定Key调用智谱AI（用于测试）
  async callZhipuAIWithKey(messages, apiKey, model) {
    const response = await axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: model,
        messages,
        temperature: 0.7,
        max_tokens: 100
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 15000
      }
    );

    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    }
    throw new Error('智谱AI返回格式异常');
  }

  // 使用指定Key调用DeepSeek（用于测试）
  async callDeepSeekWithKey(messages, apiKey, model) {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: model,
        messages,
        temperature: 0.7,
        max_tokens: 100
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 15000
      }
    );

    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    }
    throw new Error('DeepSeek返回格式异常');
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
    return {
      zhipu: {
        enabled: AI_CONFIG.zhipu.enabled,
        hasKey: !!AI_CONFIG.zhipu.apiKey,
        model: AI_CONFIG.zhipu.model
      },
      deepseek: {
        enabled: AI_CONFIG.deepseek.enabled,
        hasKey: !!AI_CONFIG.deepseek.apiKey,
        model: AI_CONFIG.deepseek.model
      },
      defaultProvider: AI_CONFIG.defaultProvider,
      availableProvider: this.getAvailableProvider()
    };
  }
}

module.exports = new AIService();
