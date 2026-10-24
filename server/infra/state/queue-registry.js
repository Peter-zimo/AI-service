/**
 * 会话级串行队列（状态层）
 *
 * 同一会话的 AI 处理必须串行：流式未完成时下一条消息不能抢占，
 * 否则 AI 侧历史缺少 assistant 分隔，会出现「回答上一个问题」的错位。
 *
 * 说明：在途 Promise 无法序列化到 Redis，因此队列本身仍是进程内的；
 * 多实例下的跨实例串行化需要分布式锁，属于下一阶段（P1）。
 */

'use strict';

const AI_TASK_TIMEOUT_MS = 90 * 1000;

class QueueRegistry {
  constructor() {
    this.queues = new Map();
  }

  enqueue(conversationId, task) {
    const prev = this.queues.get(conversationId) || Promise.resolve();

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
    this.queues.set(conversationId, next);

    next.finally(() => {
      if (this.queues.get(conversationId) === next) this.queues.delete(conversationId);
    });

    // 调用方通常不 await（要立刻返回 streamId），挂一个吞掉分支避免 unhandledRejection
    next.catch(() => {});

    return next;
  }

  pendingCount() {
    return this.queues.size;
  }
}

module.exports = { QueueRegistry, AI_TASK_TIMEOUT_MS };
