/**
 * 业务执行领域错误
 *
 * 带 status 的错误由路由层直接映射为 HTTP 响应，
 * 这样 service 不必知道 HTTP 的存在，路由也不必写业务分支。
 */

'use strict';

class ActionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
  }
}

module.exports = { ActionError };
