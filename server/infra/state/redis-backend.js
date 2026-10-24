/**
 * Redis 状态后端（可选）
 *
 * 只有同时满足以下两个条件才会启用：
 *   1. 配置了 REDIS_URL
 *   2. 安装了 redis 包（npm i redis）
 *
 * 任一不满足时 createRedisBackend 返回 null，由 index.js 降级到内存后端。
 *
 * 稳定性约束：所有 Redis 操作都带超时。Redis 抖动/不可用时快速失败，
 * 由上层（stream-registry.getOrFetch 等）降级为 404 或内存行为，避免 SSE 挂死。
 */

'use strict';

const OP_TIMEOUT_MS = 800;
const CONNECT_TIMEOUT_MS = 3000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createRedisBackend(url, { keyPrefix = 'cs:' } = {}) {
  let redis;
  try {
    redis = require('redis');
  } catch (_) {
    return null;
  }

  const client = redis.createClient({ url });
  const subscriber = client.duplicate();
  const handlers = new Map();

  const onError = (tag) => (e) => {
    console.error(`[state:redis] ${tag} 错误: ${e.message}`);
  };
  client.on('error', onError('client'));
  subscriber.on('error', onError('subscriber'));

  const ready = (async () => {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'redis connect');
    await withTimeout(subscriber.connect(), CONNECT_TIMEOUT_MS, 'redis subscriber connect');
    return true;
  })().catch((e) => {
    console.error(`[state:redis] 连接失败，降级为内存后端: ${e.message}`);
    return false;
  });

  async function ensure() {
    const ok = await ready;
    if (!ok) throw new Error('redis unavailable');
  }

  const fullKey = (key) => keyPrefix + key;

  async function get(key) {
    await ensure();
    const raw = await withTimeout(client.get(fullKey(key)), OP_TIMEOUT_MS, 'redis get');
    return raw === null ? undefined : JSON.parse(raw);
  }

  async function set(key, value, ttlMs) {
    await ensure();
    const payload = JSON.stringify(value);
    const op = ttlMs
      ? client.set(fullKey(key), payload, { PX: ttlMs })
      : client.set(fullKey(key), payload);
    await withTimeout(op, OP_TIMEOUT_MS, 'redis set');
  }

  async function del(key) {
    await ensure();
    await withTimeout(client.del(fullKey(key)), OP_TIMEOUT_MS, 'redis del');
  }

  async function publish(channel, message) {
    await ensure();
    await withTimeout(client.publish(fullKey(channel), JSON.stringify(message)), OP_TIMEOUT_MS, 'redis publish');
  }

  async function subscribe(channel, handler) {
    await ensure();
    const key = fullKey(channel);
    if (!handlers.has(key)) handlers.set(key, new Set());
    handlers.get(key).add(handler);

    if (handlers.get(key).size === 1) {
      await withTimeout(
        subscriber.subscribe(key, (raw) => {
          let message;
          try {
            message = JSON.parse(raw);
          } catch (_) {
            return;
          }
          for (const h of handlers.get(key) || []) {
            try {
              h(message);
            } catch (_) {
              /* 单个订阅者异常不影响其他订阅者 */
            }
          }
        }),
        OP_TIMEOUT_MS,
        'redis subscribe'
      );
    }

    return async () => {
      const set = handlers.get(key);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        handlers.delete(key);
        try {
          await withTimeout(subscriber.unsubscribe(key), OP_TIMEOUT_MS, 'redis unsubscribe');
        } catch (_) {
          /* 忽略取消订阅失败 */
        }
      }
    };
  }

  async function close() {
    try {
      await withTimeout(subscriber.quit(), OP_TIMEOUT_MS, 'redis subscriber quit');
    } catch (_) {
      /* 忽略 */
    }
    try {
      await withTimeout(client.quit(), OP_TIMEOUT_MS, 'redis client quit');
    } catch (_) {
      /* 忽略 */
    }
  }

  return {
    kind: 'redis',
    kv: { get, set, del },
    publish,
    subscribe,
    close,
    ready,
  };
}

module.exports = { createRedisBackend };
