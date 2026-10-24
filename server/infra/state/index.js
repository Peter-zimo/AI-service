/**
 * 状态层入口
 *
 * 统一收口「需要跨请求/跨实例存活的状态」：
 *   streams  SSE 流式会话
 *   queues   会话级串行队列
 *   sockets  WebSocket 连接注册表
 *   kv       通用键值（后续会话历史等可直接复用）
 *
 * 后端选择：
 *   - 配置了 REDIS_URL 且安装了 redis 包 → Redis 后端
 *   - 否则 → 内存后端（单机/测试默认）
 *
 * 所有后端都是尽力而为：Redis 故障不会阻断主流程，只影响跨实例能力。
 */

'use strict';

const crypto = require('crypto');
const { env } = require('../../config');
const { createMemoryBackend } = require('./memory-backend');
const { createRedisBackend } = require('./redis-backend');
const { StreamRegistry } = require('./stream-registry');
const { QueueRegistry } = require('./queue-registry');
const { SocketRegistry } = require('./socket-registry');

const INSTANCE_ID = crypto.randomBytes(6).toString('hex');

function createState() {
  let backend = null;

  if (env.redis && env.redis.url) {
    backend = createRedisBackend(env.redis.url, { keyPrefix: env.redis.keyPrefix });
    if (!backend) {
      console.warn('[state] 配置了 REDIS_URL 但未安装 redis 包，已降级为内存后端');
    }
  }

  if (!backend) backend = createMemoryBackend();

  console.log(`[state] 状态后端: ${backend.kind}${backend.kind === 'redis' ? ` (${env.redis.url})` : '（单机/测试）'}`);

  return {
    backend,
    instanceId: INSTANCE_ID,
    streams: new StreamRegistry(backend, INSTANCE_ID),
    queues: new QueueRegistry(),
    sockets: new SocketRegistry(backend, INSTANCE_ID),
    close: () => backend.close(),
    createState,
  };
}

module.exports = createState();
