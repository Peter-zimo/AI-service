/**
 * Redis 状态后端（可选）
 *
 * 只有同时满足以下两个条件才会启用：
 *   1. 配置了 REDIS_URL
 *   2. 安装了 redis 包（npm i redis）
 *
 * 任一不满足时 createRedisBackend 返回 null，由 index.js 降级到内存后端。
 * 因此本模块不会成为硬依赖，也不会拖垮单机启动。
 */

'use strict';

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
    await client.connect();
    await subscriber.connect();
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
    const raw = await client.get(fullKey(key));
    return raw === null ? undefined : JSON.parse(raw);
  }

  async function set(key, value, ttlMs) {
    await ensure();
    const payload = JSON.stringify(value);
    if (ttlMs) await client.set(fullKey(key), payload, { PX: ttlMs });
    else await client.set(fullKey(key), payload);
  }

  async function del(key) {
    await ensure();
    await client.del(fullKey(key));
  }

  async function publish(channel, message) {
    await ensure();
    await client.publish(fullKey(channel), JSON.stringify(message));
  }

  async function subscribe(channel, handler) {
    await ensure();
    const key = fullKey(channel);
    if (!handlers.has(key)) handlers.set(key, new Set());
    handlers.get(key).add(handler);

    if (handlers.get(key).size === 1) {
      await subscriber.subscribe(key, (raw) => {
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
      });
    }

    return async () => {
      const set = handlers.get(key);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        handlers.delete(key);
        try {
          await subscriber.unsubscribe(key);
        } catch (_) {
          /* 忽略取消订阅失败 */
        }
      }
    };
  }

  async function close() {
    try {
      await subscriber.quit();
    } catch (_) {
      /* 忽略 */
    }
    try {
      await client.quit();
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
