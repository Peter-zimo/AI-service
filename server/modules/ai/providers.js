/**
 * 模型供应商调用
 *
 * 统一走 OpenAI 兼容协议（/chat/completions），主模型与备用模型只是 baseUrl/model 不同。
 * 所有请求显式 proxy:false —— 本机可能注入 HTTP_PROXY，会导致连不上模型服务。
 */

'use strict';

const axios = require('axios');
const https = require('https');

const DEFAULT_TIMEOUT = 30000;
const MAX_TOKENS = 2000;

/** 非流式调用 */
async function callChatCompletions(pc, messages, maxTokens = MAX_TOKENS) {
  const response = await axios.post(
    `${pc.baseUrl}/chat/completions`,
    {
      model: pc.model,
      messages,
      temperature: pc.temperature ?? 0.7,
      max_tokens: maxTokens,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pc.apiKey}`,
      },
      timeout: DEFAULT_TIMEOUT,
      proxy: false, // 绕过系统 HTTP_PROXY，直连模型服务
    }
  );

  if (response.data && response.data.choices && response.data.choices[0]) {
    return response.data.choices[0].message.content;
  }
  throw new Error('AI返回格式异常');
}

/**
 * 流式调用（SSE）
 *
 * 用原生 https 而非 axios：axios 1.x 的 stream 在 Node.js 下 data 事件不触发。
 * 注意：保持与原实现一致的控制流 —— [DONE] 时回调 onEnd，若随后 'end' 事件
 * 仍有内容则再次回调（历史行为，暂不改动以免影响调用方）。
 */
function streamCompletion({ pc, messages, onToken, onEnd, onError }) {
  const url = new URL(`${pc.baseUrl}/chat/completions`);

  const postData = JSON.stringify({
    model: pc.model,
    messages,
    stream: true,
    temperature: 0.7,
    max_tokens: MAX_TOKENS,
  });

  let fullContent = '';
  let buffer = '';

  const req = https.request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${pc.apiKey}`,
      'Content-Length': Buffer.byteLength(postData),
    },
    timeout: DEFAULT_TIMEOUT,
  }, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[AI流式] ${pc.model} 返回非200: ${res.statusCode}`);
      onError(new Error(`AI 服务返回 ${res.statusCode}`));
      return;
    }

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
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
        } catch (_) {
          // 忽略解析失败的碎片
        }
      }
    });

    res.on('end', () => {
      if (fullContent) {
        onEnd(fullContent);
      } else {
        onError(new Error('AI 返回为空'));
      }
    });

    res.on('error', (err) => onError(err));
  });

  req.write(postData);
  req.end();
  req.on('error', (err) => onError(err));
}

/** 连通性测试（直接用传入配置，不依赖已保存状态） */
async function testConnection({ baseUrl, apiKey, model }) {
  try {
    console.log(`[AI测试] 测试连接: ${baseUrl} / ${model}`);

    const response = await axios.post(
      `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`,
      {
        model,
        messages: [
          { role: 'system', content: '你是一个测试助手' },
          { role: 'user', content: '你好，请回复"测试成功"' },
        ],
        temperature: 0.7,
        max_tokens: 100,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 15000,
        proxy: false,
      }
    );

    if (response.data && response.data.choices && response.data.choices[0]) {
      return { success: true, message: '连接正常，API Key 有效' };
    }
    return { success: false, message: '返回格式异常' };
  } catch (error) {
    console.error('[AI测试] 连接失败:', error.message);

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
      const KNOWN = {
        401: 'API Key 无效或已过期(401)',
        404: '接口地址不存在(404)，请检查 Base URL',
        429: '请求过于频繁，请稍后再试(429)',
        500: 'AI 服务器内部错误(500)，请稍后重试',
      };
      if (KNOWN[status]) return { success: false, message: KNOWN[status] };

      const detail = error.response.data &&
        (error.response.data.error?.message || error.response.data.message);
      return { success: false, message: `API 错误(${status}): ${detail || '未知错误'}` };
    }

    return { success: false, message: error.message || '连接失败' };
  }
}

module.exports = { callChatCompletions, streamCompletion, testConnection, MAX_TOKENS };
