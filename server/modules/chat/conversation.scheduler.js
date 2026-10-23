/**
 * 会话超时检查
 *
 * 每 30 秒扫一次未关闭会话：
 *   - 空闲超过 CLOSE_TIMEOUT → 关闭
 *   - 空闲超过 IDLE_TIMEOUT → 标记 idle
 *
 * 由 chat 模块加载时自动启动（与原 services/database.js 行为一致）。
 */

'use strict';

const repo = require('./conversation.repo');
const { TIMEOUT_CONFIG, CONVERSATION_STATUS } = require('../../config/constants');

let timer = null;

async function checkTimeouts() {
  const now = Date.now();
  const rows = await repo.listOpen();

  let idleCount = 0;
  let closeCount = 0;

  for (const c of rows) {
    const lastTime = new Date(c.last_message_at || c.updated_at);
    const idleTime = now - lastTime;

    if (idleTime >= TIMEOUT_CONFIG.CLOSE_TIMEOUT) {
      await repo.close(c.id, 'timeout');
      closeCount++;
    } else if (idleTime >= TIMEOUT_CONFIG.IDLE_TIMEOUT && c.status === CONVERSATION_STATUS.ACTIVE) {
      await repo.setIdle(c.id);
      idleCount++;
    }
  }

  if (idleCount > 0 || closeCount > 0) {
    console.log(`[会话超时检查] idle: ${idleCount}, closed: ${closeCount}`);
  }
  return { idleCount, closeCount };
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    // 双引擎兼容：SQLite 同步返回、PG 异步，统一 Promise 处理
    Promise.resolve(checkTimeouts())
      .catch(e => console.error('[会话] 超时检查失败:', e.message));
  }, TIMEOUT_CONFIG.CHECK_INTERVAL);
  timer.unref();
  console.log('[会话] 超时检查定时器已启动，每30秒检查一次');
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { checkTimeouts, start, stop };
