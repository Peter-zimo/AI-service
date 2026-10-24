/**
 * 内存消息队列（默认后端）
 *
 * 单机/测试环境的异步任务队列：
 *   publish(topic, payload) -> jobId
 *   consume(topic, handler, { concurrency }) -> stop()
 *   getJob(id) / listJobs(filter) / stats()
 *
 * 支持：并发消费、失败重试（指数退避）、死信（status=failed）、完成任务 1 小时 TTL。
 * 进程重启会丢失未完成任务 —— 这是内存后端的固有限制，多实例请启用 Redis 后端。
 */

'use strict';

const crypto = require('crypto');

const JOB_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

function createMemoryQueue({ maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const jobs = new Map();
  const topics = new Map();
  const consumers = new Map();
  const retryTimers = new Set();

  const now = () => Date.now();

  const sweepTimer = setInterval(() => {
    const cutoff = now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
      if (['completed', 'failed', 'cancelled'].includes(job.status) && job.updatedAt < cutoff) {
        jobs.delete(id);
      }
    }
  }, 10 * 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();

  function topicState(topic) {
    if (!topics.has(topic)) topics.set(topic, { waiting: [] });
    return topics.get(topic);
  }

  function publish(topic, payload) {
    const id = crypto.randomUUID();
    const job = {
      id,
      topic,
      payload: payload === undefined ? null : payload,
      status: 'waiting',
      attempts: 0,
      result: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    jobs.set(id, job);
    topicState(topic).waiting.push(id);
    drain(topic);
    return id;
  }

  function drain(topic) {
    const consumer = consumers.get(topic);
    if (!consumer || consumer.stopped) return;

    const state = topicState(topic);
    while (consumer.running < consumer.concurrency && state.waiting.length > 0) {
      const jobId = state.waiting.shift();
      const job = jobs.get(jobId);
      if (!job || job.status !== 'waiting') continue;
      runJob(topic, job, consumer);
    }
  }

  async function runJob(topic, job, consumer) {
    consumer.running += 1;
    job.status = 'active';
    job.attempts += 1;
    job.updatedAt = now();

    try {
      const result = await consumer.handler(job.payload, job);
      job.status = 'completed';
      job.result = result === undefined ? null : result;
      job.error = null;
      job.updatedAt = now();
    } catch (e) {
      job.error = e && e.message ? e.message : String(e);
      job.updatedAt = now();

      if (job.attempts < maxAttempts) {
        job.status = 'waiting';
        const delay = Math.min(1000 * Math.pow(2, job.attempts - 1), 10000);
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          topicState(topic).waiting.push(job.id);
          drain(topic);
        }, delay);
        retryTimers.add(timer);
      } else {
        job.status = 'failed';
      }
    } finally {
      consumer.running -= 1;
      drain(topic);
    }
  }

  function consume(topic, handler, { concurrency = 1 } = {}) {
    const consumer = {
      handler,
      concurrency: Math.max(1, Number(concurrency) || 1),
      running: 0,
      stopped: false,
    };
    consumers.set(topic, consumer);
    drain(topic);

    return () => {
      consumer.stopped = true;
      consumers.delete(topic);
    };
  }

  /** 取消等待中的任务（执行中的任务不支持中断） */
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) throw new Error('任务不存在');
    if (job.status !== 'waiting') throw new Error('仅等待中的任务可取消');

    const state = topicState(job.topic);
    const index = state.waiting.indexOf(id);
    if (index >= 0) state.waiting.splice(index, 1);

    job.status = 'cancelled';
    job.updatedAt = now();
    return job;
  }

  function getJob(id) {
    return jobs.get(id) || null;
  }

  function listJobs({ topic, status, limit = 50 } = {}) {
    return Array.from(jobs.values())
      .filter(job => (!topic || job.topic === topic) && (!status || job.status === status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
  }

  function stats() {
    const out = { waiting: 0, active: 0, completed: 0, failed: 0, cancelled: 0, total: jobs.size };
    for (const job of jobs.values()) {
      out[job.status] = (out[job.status] || 0) + 1;
    }
    return out;
  }

  async function close() {
    clearInterval(sweepTimer);
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    for (const consumer of consumers.values()) consumer.stopped = true;
    consumers.clear();
  }

  return { kind: 'memory', publish, consume, cancel, getJob, listJobs, stats, close };
}

module.exports = { createMemoryQueue, DEFAULT_MAX_ATTEMPTS, JOB_TTL_MS };
