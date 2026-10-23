/**
 * 全局错误处理中间件
 *
 * 对外脱敏：5xx 只回通用文案，真实堆栈只进日志，避免泄露内部结构。
 */

'use strict';

const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // CORS 拒绝单独处理，给前端一个明确提示
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({ success: false, error: '跨域请求被拒绝' });
  }

  logger.error('全局错误:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: status >= 500 ? '服务器内部错误' : (err.message || '请求错误'),
  });
}

module.exports = { errorHandler };
