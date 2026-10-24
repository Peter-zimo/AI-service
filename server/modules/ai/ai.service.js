/**
 * AI 对话服务
 *
 * 决策顺序：知识库命中 → 直接回答；否则调模型；模型不可用 → 兜底话术。
 * 会话历史保存在内存（每个会话最多 10 轮），进程重启即丢失。
 */

'use strict';

const knowledgeService = require('../knowledge');
const config = require('./ai-config');
const providers = require('./providers');
const { getDefaultResponse } = require('./responses');

const MAX_HISTORY_LENGTH = 10;

class AIService {
  constructor() {
    this.conversationHistory = new Map();
    this.maxHistoryLength = MAX_HISTORY_LENGTH;
  }

  // ============ 会话历史 ============

  getHistory(conversationId) {
    return this.conversationHistory.get(conversationId) || [];
  }

  addToHistory(conversationId, role, content) {
    if (!this.conversationHistory.has(conversationId)) {
      this.conversationHistory.set(conversationId, []);
    }
    const history = this.conversationHistory.get(conversationId);
    history.push({ role, content });
    if (history.length > this.maxHistoryLength) history.shift();
  }

  clearHistory(conversationId) {
    this.conversationHistory.delete(conversationId);
  }

  // ============ 配置 ============

  /** 主模型优先，备用模型兜底 */
  getAvailableProvider() {
    const cfg = config.getConfig();
    if (cfg.llm && cfg.llm.apiKey) return 'deepseek';
    if (cfg.fallback && cfg.fallback.apiKey) return 'zhipu';
    return null;
  }

  getProviderConfig(provider) {
    const cfg = config.getConfig();
    return provider === 'zhipu'
      ? (cfg.fallback || config.AI_CONFIG.fallback)
      : (cfg.llm || config.AI_CONFIG.llm);
  }

  updateConfig(cfg) {
    config.setConfig(cfg);
  }

  getConfigStatus() {
    const cfg = config.getConfig();
    return {
      llm: {
        provider: cfg.llm.provider || 'deepseek',
        hasKey: !!cfg.llm.apiKey,
        baseUrl: cfg.llm.baseUrl || '',
        model: cfg.llm.model || '',
      },
      fallback: {
        hasKey: !!cfg.fallback.apiKey,
        model: cfg.fallback.model || '',
      },
      availableProvider: this.getAvailableProvider(),
    };
  }

  // ============ 对话 ============

  async chat(conversationId, userMessage) {
    // 1. 知识库检索：Python 为权威；不可达时才用本地降级
    const remote = await knowledgeService.getBestMatchRemote(userMessage);
    const bestMatch = remote.ok ? remote.match : await knowledgeService.getBestMatch(userMessage);

    let knowledgeMatches = [];
    if (bestMatch) {
      // 兼容新旧两套评分体系
      const legacyScore = bestMatch.matchedKeywords !== undefined ? bestMatch.score : -1;
      const hybridScore = bestMatch.source ? bestMatch.score : -1;
      if (legacyScore >= 2 || hybridScore >= 0) knowledgeMatches = [bestMatch];
    }

    console.log(`[AI服务] 收到消息: "${userMessage}", 最佳匹配: ${
      bestMatch ? (bestMatch.question + ' score=' + bestMatch.score) : '无'
    }`);

    // 2. 知识库命中 → 直接返回，不走模型改写（保证优先级最高）
    if (bestMatch && knowledgeMatches.length > 0) {
      const isLegacy = bestMatch.matchedKeywords !== undefined;

      if (!(isLegacy && bestMatch.score < 2)) {
        this.addToHistory(conversationId, 'user', userMessage);
        this.addToHistory(conversationId, 'assistant', bestMatch.answer);
        console.log(`[AI服务] 知识库命中(score=${bestMatch.score})，直接返回，跳过AI`);

        return {
          type: 'knowledge',
          answer: bestMatch.answer,
          confidence: isLegacy
            ? Math.min(bestMatch.score / 10, 1)
            : Math.min(bestMatch.score * 2, 1),
          matchQuestion: bestMatch.question,
          provider: 'knowledge',
        };
      }
    }

    // 3. 尝试模型回答
    const provider = this.getAvailableProvider();
    console.log(`[AI服务] AI提供商: ${provider || '无'}`);

    if (provider) {
      try {
        return await this.chatWithAI(conversationId, userMessage, provider, knowledgeMatches);
      } catch (error) {
        console.error('AI调用失败:', error.message);
      }
    }

    // 4. 最终兜底
    return this.getDefaultResponse(userMessage);
  }

  /** 拼装系统提示词（带知识库参考时追加约束） */
  buildSystemPrompt(knowledgeMatches) {
    let systemPrompt = config.getConfig().systemPrompt;

    if (knowledgeMatches.length > 0) {
      const knowledgeContext = knowledgeMatches
        .map((k, i) => `[知识${i + 1}] Q: ${k.question}\nA: ${k.answer}`)
        .join('\n\n');

      systemPrompt += `\n\n=== 知识库参考 ===\n以下是与用户问题相关的知识库内容，请优先参考这些内容回答。如果知识库内容足以回答问题，请直接使用；如果不够，请结合你的知识补充回答。\n\n${knowledgeContext}\n\n=== 回答要求 ===\n1. 优先使用知识库中的准确信息\n2. 保持专业、友好的语气\n3. 如果知识库中没有相关信息，请明确说明"根据我的知识库，暂时没有找到相关信息"，然后给出你的建议`;
    }

    return systemPrompt;
  }

  async chatWithAI(conversationId, userMessage, provider, knowledgeMatches = []) {
    try {
      const history = this.getHistory(conversationId);
      const messages = [
        { role: 'system', content: this.buildSystemPrompt(knowledgeMatches) },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage },
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

      return { type: 'ai', answer: response, confidence: 0.9, provider };

    } catch (error) {
      console.error(`AI调用错误(${provider}):`, error.message);

      // 主模型失败时切备用模型
      const fallbackProvider = provider === 'zhipu' ? 'deepseek' : 'zhipu';
      if (fallbackProvider !== provider && this.getAvailableProvider() === fallbackProvider) {
        console.log(`尝试切换到 ${fallbackProvider}...`);
        return await this.chatWithAI(conversationId, userMessage, fallbackProvider);
      }

      return this.getDefaultResponse(userMessage);
    }
  }

  /**
   * 流式回答（SSE）
   * @param {function} onToken 每个 token 回调
   * @param {function} onEnd 结束回调（完整内容）
   * @param {function} onError 异常回调
   */
  async streamChatWithAI(conversationId, userMessage, provider, knowledgeMatches, onToken, onEnd, onError) {
    try {
      const history = this.getHistory(conversationId);
      const messages = [
        { role: 'system', content: this.buildSystemPrompt(knowledgeMatches) },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage },
      ];

      // 历史写入时机与重构前保持一致
      const persistAndEnd = (fullContent) => {
        this.addToHistory(conversationId, 'user', userMessage);
        this.addToHistory(conversationId, 'assistant', fullContent);
        onEnd(fullContent);
      };

      providers.streamCompletion({
        pc: this.getProviderConfig(provider),
        messages,
        onToken,
        onEnd: persistAndEnd,
        onError,
      });

    } catch (err) {
      const fallbackProvider = provider === 'zhipu' ? 'deepseek' : 'zhipu';
      if (fallbackProvider !== provider && this.getAvailableProvider() === fallbackProvider) {
        console.log(`[AI流式] ${provider} 失败，切换到 ${fallbackProvider}`);
        return this.streamChatWithAI(
          conversationId, userMessage, fallbackProvider, knowledgeMatches,
          onToken, onEnd, onError
        );
      }
      onError(err);
    }
  }

  // ============ 供应商调用 ============

  callZhipuAI(messages) {
    return providers.callChatCompletions(this.getProviderConfig('zhipu'), messages);
  }

  callDeepSeek(messages) {
    return providers.callChatCompletions(this.getProviderConfig('deepseek'), messages);
  }

  callChatCompletions(pc, messages, maxTokens) {
    return providers.callChatCompletions(pc, messages, maxTokens);
  }

  testConnection(params) {
    return providers.testConnection(params);
  }

  getDefaultResponse(userMessage) {
    return getDefaultResponse(userMessage);
  }
}

module.exports = { AIService, MAX_HISTORY_LENGTH };
