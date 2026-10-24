/**
 * request-id 中间件
 *
 * 优先复用上游传入的 X-Request-Id（网关/前端），否则生成 UUID。
 * 写入 req.id、响应头，并放进 AsyncLocalStorage 供日志与出站请求使用。
 */

'use strict';

const crypto = require('crypto');
const context = require('../infra/request-context');

const HEADER = 'x-request-id';
const MAX_LEN = 128;

function requestId(req, res, next) {
  const incoming = req.get(HEADER);
  const id = typeof incoming === 'string' && incoming.length > 0 && incoming.length <= MAX_LEN
    ? incoming
    : crypto.randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);

  context.run({ requestId: id, method: req.method, path: req.originalUrl || req.url }, next);
}

module.exports = { requestId, HEADER };
