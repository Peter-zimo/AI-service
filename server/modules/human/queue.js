/**
 * 排队队列
 *
 * 纯数据结构：谁在排队、排第几。不负责分配，也不负责通知——
 * 分配策略与位置广播都在 human.service.js，避免这里反向依赖业务。
 */

'use strict';

/** [{ conversationId, visitorInfo, queuedAt }] */
const items = [];

function enqueue(conversationId, visitorInfo = {}) {
  items.push({
    conversationId,
    visitorInfo,
    queuedAt: new Date().toISOString(),
  });
  return items.length;
}

/** 插到队首（坐席下线时会话需要优先重排） */
function unshift(conversationId, visitorInfo = {}) {
  items.unshift({
    conversationId,
    visitorInfo,
    queuedAt: new Date().toISOString(),
  });
  return items.length;
}

/** 取出队首 */
function dequeue() {
  return items.shift() || null;
}

function remove(conversationId) {
  const index = items.findIndex(q => q.conversationId === conversationId);
  if (index < 0) return false;
  items.splice(index, 1);
  return true;
}

function indexOf(conversationId) {
  return items.findIndex(q => q.conversationId === conversationId);
}

function has(conversationId) {
  return indexOf(conversationId) >= 0;
}

function length() {
  return items.length;
}

/** 对外视图：不含 visitorInfo */
function list() {
  return items.map((q, i) => ({
    position: i + 1,
    conversationId: q.conversationId,
    queuedAt: q.queuedAt,
  }));
}

/** 供广播使用（需要 conversationId 顺序） */
function snapshot() {
  return items.map(q => ({ conversationId: q.conversationId }));
}

/**
 * 测试接缝：暴露内部数组，供白盒测试注入与清空。
 * 正式代码不要用——对外一律走 list() / length()。
 */
const _test = {
  queue: items,
  reset() {
    items.length = 0;
  },
};

module.exports = {
  enqueue, unshift, dequeue, remove, indexOf, has, length, list, snapshot, _test,
};
