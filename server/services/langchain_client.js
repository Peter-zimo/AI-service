/**
 * LangChain 服务客户端
 * 将 AI 调用转发到 Python + LangChain 服务
 */

const http = require('http');

const LANGCHAIN_SERVICE = process.env.LANGCHAIN_SERVICE_URL || 'http://localhost:8000';

/**
 * 解析 hostname 和 port
 */
function parseUrl(url) {
  const u = new URL(url);
  return { hostname: u.hostname, port: u.port || 8000, protocol: u.protocol };
}

/**
 * HTTP 请求封装
 */
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = parseUrl(LANGCHAIN_SERVICE);
    const postData = body ? JSON.stringify(body) : null;

    const options = {
      hostname,
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
      timeout: 30000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`LangChain 服务响应异常: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('error', err => reject(new Error(`LangChain 服务连接失败: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('LangChain 服务超时')); });

    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * AI 对话（非流式）
 */
async function chat(conversationId, message, useAgent = true) {
  return request('POST', '/api/chat', {
    conversation_id: conversationId,
    message,
    use_agent: useAgent,
  });
}

/**
 * 获取 LangChain 服务的 SSE 流 URL
 */
function getStreamUrl(conversationId, message) {
  const base = LANGCHAIN_SERVICE.replace(/\/+$/, '');
  return `${base}/api/chat/stream`;
}

/**
 * 获取 SSE 流请求体
 */
function getStreamBody(conversationId, message) {
  return JSON.stringify({
    conversation_id: conversationId,
    message,
    use_agent: false,
  });
}

/**
 * 知识库检索
 */
async function searchKnowledge(query) {
  const { hostname, port } = parseUrl(LANGCHAIN_SERVICE);
  const encoded = encodeURIComponent(query);
  return request('GET', `/api/kb/search?query=${encoded}`);
}

/**
 * 获取最佳匹配
 */
async function getBestMatch(query) {
  const { hostname, port } = parseUrl(LANGCHAIN_SERVICE);
  const encoded = encodeURIComponent(query);
  return request('GET', `/api/kb/best-match?query=${encoded}`);
}

/**
 * 健康检查
 */
async function health() {
  return request('GET', '/api/health');
}

module.exports = {
  chat,
  getStreamUrl,
  getStreamBody,
  searchKnowledge,
  getBestMatch,
  health,
};
