/**
 * 消息队列入口
 *
 * 后端选择：
 *   - 配置了 REDIS_URL 且安装了 redis 包 → Redis 后端（多实例）
 *   - 否则 → 内存后端（单机/测试默认）
 */

'use strict';

const { env } = require('../../config');
const { createMemoryQueue } = require('./memory-queue');
const { createRedisQueue } = require('./redis-queue');

function createQueue() {
  const maxAttempts = env.jobs ? env.jobs.maxAttempts : undefined;
  let backend = null;

  if (env.redis && env.redis.url) {
    backend = createRedisQueue(env.redis.url, {
      keyPrefix: env.redis.keyPrefix,
      maxAttempts,
    });
    if (!backend) {
      console.warn('[queue] 配置了 REDIS_URL 但未安装 redis 包，降级为内存队列');
    }
  }

  if (!backend) backend = createMemoryQueue({ maxAttempts });

  console.log(`[queue] 队列后端: ${backend.kind}`);
  return backend;
}

module.exports = createQueue();
