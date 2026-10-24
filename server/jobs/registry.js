/**
 * 异步任务注册表
 *
 * 职责：任务类型注册、入队、状态查询、重试/取消、worker 生命周期。
 * 队列后端在 infra/queue（内存 / Redis），接口统一为异步。
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

async function enqueue(type, payload) {
  if (!handlers.has(type)) {
    throw new Error(`未知任务类型: ${type}`);
  }
  return queue.publish(type, payload);
}

async function getJob(id) {
  return queue.getJob(id);
}

async function listJobs(filter) {
  return queue.listJobs(filter);
}

async function stats() {
  return queue.stats();
}

/** 失败/已完成任务重新入队（生成新任务，保留原记录） */
async function retry(id) {
  const job = await queue.getJob(id);
  if (!job) throw new Error('任务不存在');
  if (job.status !== 'failed' && job.status !== 'completed') {
    throw new Error('仅失败或已完成的任务可重试');
  }
  return queue.publish(job.topic, job.payload);
}

/** 取消等待中的任务（执行中的任务不支持中断） */
async function cancel(id) {
  return queue.cancel(id);
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
  retry,
  cancel,
  startWorkers,
  stopWorkers,
  handlers,
};
