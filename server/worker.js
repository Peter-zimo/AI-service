/**
 * 独立 worker 进程
 *
 * 生产建议：INLINE_WORKERS=false，单独运行 `node server/worker.js`，
 * 让 HTTP 进程与任务消费解耦。
 */

'use strict';

const logger = require('./infra/logger');
const jobs = require('./jobs');

jobs.startWorkers();
logger.info('[worker] 任务消费者已启动');

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info(`[worker] 收到 ${signal}，正在停止...`);
  jobs.stopWorkers();
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
