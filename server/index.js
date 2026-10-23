/**
 * 进程入口（Process Entry）
 *
 * 只负责进程级的事：读环境变量、接管 console、启动服务、优雅退出。
 * 应用装配在 app.js，业务在 modules/。
 *
 * 启动：node server/index.js  或  npm start
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

// ============ 1. 日志接管（必须最先，后续所有 console 都走 winston） ============

const _origConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

console.log = (...args) => { _origConsole.log(...args); logger.info(args.map(String).join(' ')); };
console.warn = (...args) => { _origConsole.warn(...args); logger.warn(args.map(String).join(' ')); };
console.error = (...args) => { _origConsole.error(...args); logger.error(args.map(String).join(' ')); };

// stdout 管道断开（Ctrl+C、父进程退出、PM2 reload）时会抛 EPIPE。
// 不接住的话，写日志本身又会触发新异常，形成刷屏死循环。
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') _origConsole.error('[stdout]', err.message);
});
process.stderr.on('error', () => { /* 忽略，避免二次异常 */ });

// ============ 2. 加载 .env ============

const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
  logger.info('.env 已加载');
}

// 强制 UTF-8 输出
process.env.LANG = 'zh_CN.UTF-8';

// ============ 3. 启动 ============

const { env, validate } = require('./config');
const { createApp } = require('./app');

const { errors, warnings } = validate();
for (const w of warnings) logger.warn(`[配置] ${w}`);
if (errors.length > 0) {
  for (const e of errors) logger.error(`[配置] ${e}`);
  logger.error('[启动] 关键配置缺失，进程退出');
  process.exit(1);
}

const { server, db } = createApp();

server.listen(env.port, () => {
  logger.info(`
╔══════════════════════════════════════════════════╗
║         AI智能客服系统已启动                      ║
╠══════════════════════════════════════════════════╣
║  访客端: http://localhost:${env.port}
║  管理后台: http://localhost:${env.port}/admin.html
║  客服工作台: http://localhost:${env.port}/agent.html
╚══════════════════════════════════════════════════╝
  `);
});

// ============ 4. 异常兜底 ============

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的Promise拒绝:', {
    error: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

process.on('uncaughtException', (err) => {
  // EPIPE 属于「对端已关闭」，不影响业务，只记录不退出
  if (err.code === 'EPIPE') {
    logger.warn('忽略 EPIPE：输出管道已关闭');
    return;
  }

  logger.error('未捕获的异常:', { error: err.message, stack: err.stack });
  // 给 PM2 一个优雅退出的机会，而不是立刻 crash 循环
  setTimeout(() => process.exit(1), 1000);
});

// ============ 5. 优雅退出 ============

process.on('SIGTERM', () => {
  logger.info('收到SIGTERM，正在关闭...');
  server.close(() => {
    if (db && db.stopCacheRefresh) db.stopCacheRefresh();
    logger.info('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('收到SIGINT，正在关闭...');
  server.close(() => process.exit(0));
});
