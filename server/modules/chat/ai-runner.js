/**
 * AI 流式执行器
 *
 * 负责一次完整的 LangChain Agent 调用：发起流 → 解析 SSE → 敏感词复检 →
 * 落库 → 结束流；任一步失败则走「知识库兜底 → 通用兜底」的降级链。
 *
 * 这里是全系统最长的链路，因此单独成文件：改 AI 行为只看这一个文件。
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const messageRepo = require('./message.repo');
const metrics = require('../../infra/metrics');
const unansweredService = require('../../services/unanswered');
const knowledgeService = require('../../modules/knowledge');
const stats = require('../stats');
const { AiStreamClient } = require('../../services/stream_client');
const { env } = require('../../config');
const streamSession = require('./stream-session');

// AI 服务流式客户端（双段超时 + 熔断）
const aiStreamClient = new AiStreamClient({
  baseUrl: env.ai.langchainServiceUrl,
});

const FALLBACK_TEXT = '抱歉，我暂时没有找到与您问题相关的信息。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系真人客服\n\n感谢您的理解！';
const SERVICE_DOWN_TEXT = '抱歉，AI 服务暂时不可用，请稍后重试。\n\n您也可以输入"转人工"联系真人客服，感谢您的理解！';
const SENSITIVE_TEXT = '抱歉，根据我的知识库，暂时没有找到与您问题相关的信息。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系真人客服获得帮助\n\n感谢您的理解！';

/**
 * 消费 LangChain 的 SSE 流，逐 token 写入会话。
 * @returns {Promise<{fullContent: string, detectedSource: string}>}
 */
async function consumeStream({ conversationId, message, streamId }) {
  const { reader, resetIdle, clearIdle, close } = await aiStreamClient.openChatStream({
    conversationId,
    message,
    useAgent: true, // Agent 自主决策：知识库→AI→转人工→兜底
  });
  aiStreamClient.breaker.recordSuccess(); // 服务可达 → 重置失败计数

  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let currentEvent = '';
  let detectedSource = 'ai'; // 从 SSE 事件捕获真实来源（knowledge/ai/fallback）

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
          continue;
        }
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);

        if (currentEvent === 'token') {
          try {
            const token = JSON.parse(data);
            if (token) {
              fullContent += token;
              streamSession.writeToken(streamId, token);
            }
          } catch (_) { /* 忽略畸形 token */ }
        } else if (currentEvent === 'knowledge') {
          detectedSource = 'knowledge';
          try {
            const parsed = JSON.parse(data);
            const content = typeof parsed === 'string' ? parsed : (parsed.fullContent || parsed.content || '');
            if (content && !fullContent) fullContent = content;
          } catch (_) { /* 忽略 */ }
        } else if (currentEvent === 'end') {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type) detectedSource = parsed.type;
            const content = typeof parsed === 'string' ? parsed : (parsed.fullContent || parsed.content || '');
            if (content && !fullContent) fullContent = content;
          } catch (_) { /* 忽略 */ }
        } else if (currentEvent === 'error') {
          console.error(`[LangChain Agent] 流式错误: ${data}`);
        }

        currentEvent = '';
      }
    }
  } finally {
    clearIdle();
    close();
  }

  return { fullContent, detectedSource };
}

/**
 * 流结束后的收尾：敏感词复检 → 落库 → 结束流 → 运营闭环
 */
async function finishWithContent({ conversationId, message, streamId, fullContent, detectedSource }) {
  let finalContent = fullContent;

  // 用 LangChain 做一次语义敏感词检测（10s 超时，失败不阻塞）
  try {
    const sensData = await aiStreamClient.checkSensitive(fullContent);
    if (sensData.success && sensData.data?.has_sensitive) {
      console.log(`[LangChain Agent] 语义检测到敏感内容: ${sensData.data.reason}`);
      finalContent = SENSITIVE_TEXT;
    }
  } catch (e) {
    console.error(`[LangChain Agent] 敏感检测失败: ${e.message}`);
  }

  const finalSource = (finalContent !== fullContent) ? 'fallback' : detectedSource;

  await messageRepo.add(uuidv4(), conversationId, 'assistant', finalContent, null, finalSource);
  await stats.incrementAiHandled();
  streamSession.endStream(streamId, finalContent, finalSource);
  metrics.inc('chat_messages_total', [finalSource]);

  if (finalSource === 'fallback') {
    try { unansweredService.recordQuery(message); } catch (e) { /* 闭环记录失败不影响回复 */ }
  }

  console.log(`[LangChain Agent] 流式完成: ${streamId}`);
}

/**
 * 执行一次 AI 回复（在会话队列中调用）
 */
async function runAgentStream({ conversationId, message, streamId }) {
  try {
    // 熔断期内直接跳过 AI，走知识库兜底
    if (aiStreamClient.isBreakerOpen) {
      throw new Error('AI 服务熔断中，直接走知识库兜底');
    }

    const { fullContent, detectedSource } = await consumeStream({
      conversationId, message, streamId,
    });

    if (fullContent) {
      await finishWithContent({ conversationId, message, streamId, fullContent, detectedSource });
      return;
    }

    // 流正常结束但没有任何内容 → 通用兜底
    await messageRepo.add(uuidv4(), conversationId, 'assistant', FALLBACK_TEXT, null, 'fallback');
    await stats.incrementAiHandled();
    streamSession.endStream(streamId, FALLBACK_TEXT, 'fallback');
    try { unansweredService.recordQuery(message); } catch (e) { /* 忽略 */ }

  } catch (err) {
    console.error(`[LangChain Agent] 请求失败: ${err.message}`);
    metrics.inc('ai_errors_total', ['langchain_failure']);
    aiStreamClient.breaker.recordFailure(); // 连续失败 N 次 → 熔断

    // 降级链第一级：本地知识库
    let fallbackAnswer = SERVICE_DOWN_TEXT;
    let fallbackType = 'fallback';

    try {
      const kbMatch = await knowledgeService.getBestMatch(message);
      if (kbMatch) {
        fallbackAnswer = kbMatch.answer;
        fallbackType = 'knowledge-fallback';
        console.log(`[LangChain Agent] AI 不可用，知识库兜底命中: ${kbMatch.question}`);
      }
    } catch (kbErr) {
      console.error(`[LangChain Agent] 知识库兜底失败: ${kbErr.message}`);
    }

    await messageRepo.add(uuidv4(), conversationId, 'assistant', fallbackAnswer, null, fallbackType);
    await stats.incrementAiHandled();
    streamSession.endStream(streamId, fallbackAnswer, fallbackType);
    try { unansweredService.recordQuery(message); } catch (e) { /* 忽略 */ }
  }
}

module.exports = {
  runAgentStream,
  aiStreamClient,
  FALLBACK_TEXT,
  SERVICE_DOWN_TEXT,
};
