/**
 * Redis 消息队列（可选后端）
 *
 * 使用 List 做队列（LPUSH / BRPOP），Job 详情存 JSON 字符串（带 1h TTL）。
 * 只有配置 REDIS_URL 且安装了 redis 包时才会启用；否则由 index.js 降级到内存队列。
 *
 * 说明：本后端用于多实例部署。当前开发机未安装 Redis，因此未经实跑验证；
 * 首次启用时请重点验证 publish/consume/重试三条路径。
 */

'use strict';

const crypto = require('crypto');

const OP_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 3000;
const JOB_TTL_SEC = 3600;
const DEFAULT_MAX_ATTEMPTS = 3;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createRedisQueue(url, { keyPrefix = 'cs:', maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  let redis;
  try {
    redis = require('redis');
  } catch (_) {
    return null;
  }

  const client = redis.createClient({ url });
  const blocker = client.duplicate();
  const stoppers = new Set();

  const onError = (tag) => (e) => console.error(`[queue:redis] ${tag} 错误: ${e.message}`);
  client.on('error', onError('client'));
  blocker.on('error', onError('blocker'));

  const ready = (async () => {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'redis queue connect');
    await withTimeout(blocker.connect(), CONNECT_TIMEOUT_MS, 'redis queue blocker connect');
    return true;
  })().catch((e) => {
    console.error(`[queue:redis] 连接失败: ${e.message}`);
    return false;
  });

  async function ensure() {
    const ok = await ready;
    if (!ok) throw new Error('redis queue unavailable');
  }

  const jobKey = (id) => `${keyPrefix}job:${id}`;
  const queueKey = (topic) => `${keyPrefix}q:${topic}`;
  const jobsIndex = `${keyPrefix}jobs`;

  async function getJob(id) {
    await ensure();
    const raw = await withTimeout(client.get(jobKey(id)), OP_TIMEOUT_MS, 'queue getJob');
    return raw ? JSON.parse(raw) : null;
  }

  async function saveJob(job) {
    await ensure();
    job.updatedAt = Date.now();
    await withTimeout(
      client.set(jobKey(job.id), JSON.stringify(job), { EX: JOB_TTL_SEC }),
      OP_TIMEOUT_MS,
      'queue saveJob'
    );
  }

  async function publish(topic, payload) {
    await ensure();
    const id = crypto.randomUUID();
    const job = {
      id,
      topic,
      payload: payload === undefined ? null : payload,
      status: 'waiting',
      attempts: 0,
      result: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveJob(job);
    await withTimeout(
      client.zAdd(jobsIndex, [{ score: job.createdAt, value: id }]),
      OP_TIMEOUT_MS,
      'queue zAdd'
    );
    await withTimeout(client.lPush(queueKey(topic), id), OP_TIMEOUT_MS, 'queue lPush');
    return id;
  }

  async function runJob(topic, id, handler) {
    const job = await getJob(id);
    if (!job || job.status === 'completed') return;

    job.status = 'active';
    job.attempts += 1;
    await saveJob(job);

    try {
      const result = await handler(job.payload, job);
      job.status = 'completed';
      job.result = result === undefined ? null : result;
      job.error = null;
      await saveJob(job);
    } catch (e) {
      job.error = e && e.message ? e.message : String(e);
      if (job.attempts < maxAttempts) {
        job.status = 'waiting';
        await saveJob(job);
        const delay = Math.min(1000 * Math.pow(2, job.attempts - 1), 10000);
        setTimeout(() => {
          client.lPush(queueKey(topic), id).catch(() => {});
        }, delay);
      } else {
        job.status = 'failed';
        await saveJob(job);
      }
    }
  }

  function consume(topic, handler, { concurrency = 1 } = {}) {
    const stopped = { value: false };
    const workers = Math.max(1, Number(concurrency) || 1);

    for (let i = 0; i < workers; i++) {
      (async () => {
        while (!stopped.value) {
          let item;
          try {
            item = await blocker.brPop(queueKey(topic), 1);
          } catch (e) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          if (!item) continue;
          try {
            await runJob(topic, item.element, handler);
          } catch (e) {
            console.error(`[queue:redis] 执行任务失败: ${e.message}`);
          }
        }
      })().catch((e) => console.error(`[queue:redis] 消费循环退出: ${e.message}`));
    }

    const stop = () => { stopped.value = true; };
    stoppers.add(stop);
    return stop;
  }

  async function listJobs({ topic, status, limit = 50 } = {}) {
    await ensure();
    const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
    const ids = await withTimeout(
      client.zRange(jobsIndex, 0, capped - 1, { REV: true }),
      OP_TIMEOUT_MS,
      'queue zRange'
    );
    if (!ids || ids.length === 0) return [];
    const raw = await withTimeout(client.mGet(ids.map(jobKey)), OP_TIMEOUT_MS, 'queue mGet');
    return raw
      .filter(Boolean)
      .map((s) => JSON.parse(s))
      .filter((job) => (!topic || job.topic === topic) && (!status || job.status === status))
      .slice(0, capped);
  }

  async function stats() {
    const jobs = await listJobs({ limit: 200 });
    const out = { waiting: 0, active: 0, completed: 0, failed: 0, total: jobs.length };
    for (const job of jobs) out[job.status] = (out[job.status] || 0) + 1;
    return out;
  }

  async function close() {
    for (const stop of stoppers) stop();
    stoppers.clear();
    try { await withTimeout(blocker.quit(), OP_TIMEOUT_MS, 'queue blocker quit'); } catch (_) { /* 忽略 */ }
    try { await withTimeout(client.quit(), OP_TIMEOUT_MS, 'queue client quit'); } catch (_) { /* 忽略 */ }
  }

  return { kind: 'redis', publish, consume, getJob, listJobs, stats, close, ready };
}

module.exports = { createRedisQueue, DEFAULT_MAX_ATTEMPTS };
