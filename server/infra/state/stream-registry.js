/**
 * 流式会话注册表（状态层）
 *
 * 本地 Map 是热路径的唯一事实来源（同步读写，保证 SSE 低延迟）；
 * Redis 只作为「镜像」：持久化会话快照 + 发布事件，供多实例/重启恢复使用。
 *
 * 因此内存后端下行为与重构前完全一致；Redis 后端下多一层尽力而为的跨实例能力。
 */

'use strict';

const END_RETENTION_MS = 5 * 60 * 1000;
const ERROR_RETENTION_MS = 60 * 1000;
const SESSION_TTL_MS = 10 * 60 * 1000;

class StreamRegistry {
  constructor(backend, instanceId) {
    this.backend = backend;
    this.instanceId = instanceId;
    this.sessions = new Map();
  }

  channel(streamId) {
    return `stream:${streamId}`;
  }

  /** 异步镜像：失败不影响主流程 */
  mirror(fn) {
    if (this.backend.kind === 'memory') return;
    try {
      const p = fn();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* 忽略镜像异常 */
    }
  }

  snapshot(session, extra = {}) {
    return {
      conversationId: session.conversationId,
      tokens: session.tokens,
      fullContent: session.fullContent,
      ended: session.ended,
      type: session.type,
      ...extra,
    };
  }

  create(streamId, conversationId) {
    const session = {
      conversationId,
      tokens: [],
      fullContent: '',
      ended: false,
      type: null,
      callbacks: new Set(),
    };
    this.sessions.set(streamId, session);
    this.mirror(() =>
      this.backend.kv.set(`stream:${streamId}:meta`, this.snapshot(session), SESSION_TTL_MS)
    );
    return session;
  }

  get(streamId) {
    return this.sessions.get(streamId) || null;
  }

  /** 本地没有时，尝试从 Redis 恢复（重启/跨实例场景） */
  async getOrFetch(streamId) {
    const local = this.sessions.get(streamId);
    if (local) return local;
    if (this.backend.kind === 'memory') return null;

    try {
      const meta = await this.backend.kv.get(`stream:${streamId}:meta`);
      if (!meta) return null;
      const session = {
        conversationId: meta.conversationId,
        tokens: Array.isArray(meta.tokens) ? meta.tokens : [],
        fullContent: meta.fullContent || '',
        ended: !!meta.ended,
        type: meta.type || null,
        callbacks: new Set(),
      };
      this.sessions.set(streamId, session);
      return session;
    } catch (_) {
      return null;
    }
  }

  writeToken(streamId, token) {
    const session = this.sessions.get(streamId);
    if (!session) return;

    session.tokens.push(token);
    for (const cb of session.callbacks) cb({ type: 'token', data: token });

    this.mirror(() =>
      this.backend.publish(this.channel(streamId), {
        type: 'token',
        data: token,
        origin: this.instanceId,
      })
    );
    this.mirror(() =>
      this.backend.kv.set(`stream:${streamId}:meta`, this.snapshot(session), SESSION_TTL_MS)
    );
  }

  end(streamId, fullContent, type) {
    const session = this.sessions.get(streamId);
    if (!session) return;

    session.ended = true;
    session.fullContent = fullContent;
    session.type = type;
    for (const cb of session.callbacks) cb({ type: 'end', data: { fullContent, type } });

    this.mirror(() =>
      this.backend.publish(this.channel(streamId), {
        type: 'end',
        data: { fullContent, type },
        origin: this.instanceId,
      })
    );
    this.mirror(() =>
      this.backend.kv.set(`stream:${streamId}:meta`, this.snapshot(session), END_RETENTION_MS)
    );

    const timer = setTimeout(() => this.sessions.delete(streamId), END_RETENTION_MS);
    if (timer.unref) timer.unref();
  }

  error(streamId, errorMsg) {
    const session = this.sessions.get(streamId);
    if (!session) return;

    session.ended = true;
    for (const cb of session.callbacks) cb({ type: 'error', data: errorMsg });

    this.mirror(() =>
      this.backend.publish(this.channel(streamId), {
        type: 'error',
        data: errorMsg,
        origin: this.instanceId,
      })
    );

    const timer = setTimeout(() => this.sessions.delete(streamId), ERROR_RETENTION_MS);
    if (timer.unref) timer.unref();
  }

  /** 订阅本地事件（同步） */
  subscribe(streamId, callback) {
    const session = this.sessions.get(streamId);
    if (!session) return () => {};
    session.callbacks.add(callback);
    return () => session.callbacks.delete(callback);
  }

  /** 订阅 Redis 事件（跨实例），自动跳过本实例发布的消息 */
  async subscribeRemote(streamId, callback) {
    if (this.backend.kind === 'memory') return () => {};
    try {
      return await this.backend.subscribe(this.channel(streamId), (msg) => {
        if (!msg || msg.origin === this.instanceId) return;
        callback(msg);
      });
    } catch (_) {
      return () => {};
    }
  }
}

module.exports = { StreamRegistry, END_RETENTION_MS, ERROR_RETENTION_MS, SESSION_TTL_MS };
