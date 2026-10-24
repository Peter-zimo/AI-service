/**
 * 请求上下文（AsyncLocalStorage）
 *
 * 让任意深度的调用（service → infra → client）都能拿到当前 requestId，
 * 无需层层传参。日志、出站请求头都从这里取。
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function run(store, fn) {
  return storage.run(store, fn);
}

function get() {
  return storage.getStore() || {};
}

function getRequestId() {
  return get().requestId;
}

module.exports = { run, get, getRequestId };
