/**
 * 内存状态后端（默认）
 *
 * 提供与 Redis 后端一致的异步接口：
 *   kv.get / kv.set / kv.del
 *   publish / subscribe
 *   close
 *
 * 单机部署、测试环境、以及 Redis 不可用时的兜底都走这里。
 */

'use strict';

function createMemoryBackend() {
  const kv = new Map();
  const channels = new Map();

  const now = () => Date.now();

  async function get(key) {
    const item = kv.get(key);
    if (!item) return undefined;
    if (item.expiresAt && item.expiresAt <= now()) {
      kv.delete(key);
      return undefined;
    }
    return item.value;
  }

  async function set(key, value, ttlMs) {
    kv.set(key, {
      value,
      expiresAt: ttlMs ? now() + ttlMs : 0,
    });
  }

  async function del(key) {
    kv.delete(key);
  }

  async function publish(channel, message) {
    const handlers = channels.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (_) {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  async function subscribe(channel, handler) {
    if (!channels.has(channel)) channels.set(channel, new Set());
    channels.get(channel).add(handler);
    return () => {
      const handlers = channels.get(channel);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0) channels.delete(channel);
    };
  }

  async function close() {
    kv.clear();
    channels.clear();
  }

  return {
    kind: 'memory',
    kv: { get, set, del },
    publish,
    subscribe,
    close,
  };
}

module.exports = { createMemoryBackend };
