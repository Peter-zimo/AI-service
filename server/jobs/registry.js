/**
 * 异步任务注册表
 *
 * 职责：任务类型注册、入队、状态查询、worker 生命周期。
 * 队列后端在 infra/queue（内存 / Redis）。
 */

'use strict';

const queue = require('../infra/queue');
const { env } = require('../config');

const handlers = new Map();
const stops = new Map();

function register(type, handler) {
  if (typeof type !== 'string' || !type || typeof handler !== 'function') {
    throw new Error('register(type, handler) 参数无效');
  }
  handlers.set(type, handler);
}

function has(type) {
  return handlers.has(type);
}

function enqueue(type, payload) {
  if (!handlers.has(type)) {
    throw new Error(`未知任务类型: ${type}`);
  }
  return queue.publish(type, payload);
}

function getJob(id) {
  return queue.getJob(id);
}

function listJobs(filter) {
  return queue.listJobs(filter);
}

function stats() {
  return queue.stats();
}

function startWorkers() {
  if (stops.size > 0) return false;

  const concurrency = env.jobs ? env.jobs.concurrency : 2;
  for (const [type, handler] of handlers) {
    stops.set(type, queue.consume(type, handler, { concurrency }));
  }

  console.log(`[jobs] 已启动 ${stops.size} 个任务消费者（并发 ${concurrency}）`);
  return true;
}

function stopWorkers() {
  for (const stop of stops.values()) stop();
  stops.clear();
}

module.exports = {
  register,
  has,
  enqueue,
  getJob,
  listJobs,
  stats,
  startWorkers,
  stopWorkers,
  handlers,
};
