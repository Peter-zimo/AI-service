/**
 * 会话级 AI 任务串行队列
 *
 * 同一会话的 AI 处理必须串行：流式未完成时下一条消息不能抢占，
 * 否则 AI 服务侧历史里缺少 assistant 分隔，会出现「回答上一个问题」的错位。
 *
 * 同时给单任务加超时护栏：任务卡死不能把整条队列堵住。
 */

'use strict';

const AI_TASK_TIMEOUT_MS = 90 * 1000;

/** conversationId -> Promise */
const queues = new Map();

/**
 * 把任务排进该会话的队列
 * @param {string} conversationId
 * @param {Function} task 返回 Promise 的函数
 * @returns {Promise}
 */
function enqueue(conversationId, task) {
  const prev = queues.get(conversationId) || Promise.resolve();

  const guarded = async () => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AI 任务超时(${AI_TASK_TIMEOUT_MS}ms)`)),
        AI_TASK_TIMEOUT_MS
      );
      if (timer && timer.unref) timer.unref();
    });

    try {
      return await Promise.race([task(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const next = prev.then(guarded, guarded);
  queues.set(conversationId, next);

  next.finally(() => {
    if (queues.get(conversationId) === next) queues.delete(conversationId);
  });

  return next;
}

/** 当前排队中的会话数（排障用） */
function pendingCount() {
  return queues.size;
}

module.exports = { enqueue, pendingCount, AI_TASK_TIMEOUT_MS };
