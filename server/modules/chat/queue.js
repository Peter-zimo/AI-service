/**
 * 会话级 AI 任务串行队列（薄封装）
 *
 * 实现已下沉到 infra/state/queue-registry，本文件保持原有导出形状。
 */

'use strict';

const state = require('../../infra/state');
const { AI_TASK_TIMEOUT_MS } = require('../../infra/state/queue-registry');

function enqueue(conversationId, task) {
  return state.queues.enqueue(conversationId, task);
}

function pendingCount() {
  return state.queues.pendingCount();
}

module.exports = { enqueue, pendingCount, AI_TASK_TIMEOUT_MS };
