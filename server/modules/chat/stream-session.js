/**
 * SSE 流式会话注册表（HTTP 适配层）
 *
 * 状态本身在 infra/state/stream-registry，本文件只负责把状态映射成 SSE 响应。
 * 这样单机内存与 Redis 两种后端共用同一套 HTTP 行为。
 */

'use strict';

const state = require('../../infra/state');

function createSession(streamId, conversationId) {
  return state.streams.create(streamId, conversationId);
}

function getSession(streamId) {
  return state.streams.get(streamId);
}

function writeToken(streamId, token) {
  state.streams.writeToken(streamId, token);
}

function endStream(streamId, fullContent, type) {
  state.streams.end(streamId, fullContent, type);
}

function errorStream(streamId, errorMsg) {
  state.streams.error(streamId, errorMsg);
}

/**
 * 把 SSE 响应接到某个流会话上。
 * 已缓冲的 token 先重放，未结束则注册回调继续推送。
 * @returns {Promise<boolean>} false 表示会话不存在（调用方应回 404）
 */
async function attachSse(res, streamId, req) {
  const session = await state.streams.getOrFetch(streamId);
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

  // 已结束：直接补一个 end 事件收尾，type 用记录下来的真实来源
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

  const unsubscribeLocal = state.streams.subscribe(streamId, callback);
  const unsubscribeRemote = await state.streams.subscribeRemote(streamId, callback);

  req.on('close', () => {
    unsubscribeLocal();
    if (typeof unsubscribeRemote === 'function') unsubscribeRemote();
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
