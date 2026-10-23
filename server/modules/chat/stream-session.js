/**
 * SSE 流式会话注册表
 *
 * 一条用户消息对应一个 streamId。AI 在后台逐 token 产出，
 * 前端拿到 streamId 后连 /stream/:streamId 逐块接收。
 *
 * 设计要点：
 * - 前端可能晚于 AI 开始连接，所以 token 要缓冲、可重放
 * - 流结束后保留 5 分钟，供重连；错误流保留 60 秒
 */

'use strict';

const END_RETENTION_MS = 5 * 60 * 1000;
const ERROR_RETENTION_MS = 60 * 1000;

/** streamId -> { conversationId, tokens, fullContent, ended, callbacks } */
const sessions = new Map();

function createSession(streamId, conversationId) {
  sessions.set(streamId, {
    conversationId,
    tokens: [],
    fullContent: '',
    ended: false,
    callbacks: new Set(),
  });
  return sessions.get(streamId);
}

function getSession(streamId) {
  return sessions.get(streamId) || null;
}

/** 追加一个 token 并广播给已连接的客户端 */
function writeToken(streamId, token) {
  const session = sessions.get(streamId);
  if (!session) return;
  session.tokens.push(token);
  session.callbacks.forEach(cb => cb({ type: 'token', data: token }));
}

/**
 * 正常结束
 * @param {string} streamId
 * @param {string} fullContent 完整回答
 * @param {string} type 来源：ai / knowledge / fallback / knowledge-fallback
 */
function endStream(streamId, fullContent, type) {
  const session = sessions.get(streamId);
  if (!session) return;
  session.ended = true;
  session.fullContent = fullContent;
  session.callbacks.forEach(cb => cb({ type: 'end', data: { fullContent, type } }));
  setTimeout(() => sessions.delete(streamId), END_RETENTION_MS);
}

/** 异常结束 */
function errorStream(streamId, errorMsg) {
  const session = sessions.get(streamId);
  if (!session) return;
  session.ended = true;
  session.callbacks.forEach(cb => cb({ type: 'error', data: errorMsg }));
  setTimeout(() => sessions.delete(streamId), ERROR_RETENTION_MS);
}

/**
 * 把 SSE 响应接到某个流会话上。
 * 已缓冲的 token 先重放，未结束则注册回调继续推送。
 * @returns {boolean} false 表示会话不存在（调用方应回 404）
 */
function attachSse(res, streamId, req) {
  const session = sessions.get(streamId);
  if (!session) return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁止 nginx 缓冲
  });

  // 重放已产出的 token
  for (const token of session.tokens) {
    res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
  }

  // 已结束：直接补一个 end 事件收尾
  // 注：session.type 历史遗留未赋值，故此处恒为 'ai'。属已知问题，
  //     为保持重构零行为变化暂不修正，待后续单独处理。
  if (session.ended) {
    res.write(`event: end\ndata: ${JSON.stringify({
      fullContent: session.fullContent,
      type: session.type || 'ai',
    })}\n\n`);
    res.end();
    return true;
  }

  const callback = (event) => {
    if (event.type === 'token') {
      res.write(`event: token\ndata: ${JSON.stringify(event.data)}\n\n`);
    } else if (event.type === 'end') {
      res.write(`event: end\ndata: ${JSON.stringify(event.data)}\n\n`);
      res.end();
    } else if (event.type === 'error') {
      res.write(`event: error\ndata: ${JSON.stringify(event.data)}\n\n`);
      res.end();
    }
  };

  session.callbacks.add(callback);

  req.on('close', () => {
    session.callbacks.delete(callback);
  });

  return true;
}

module.exports = {
  createSession,
  getSession,
  writeToken,
  endStream,
  errorStream,
  attachSse,
};
