/**
 * WebSocket 连接注册表（状态层）
 *
 * 本地 Map 保存真实 ws 对象（无法序列化，也不该进 Redis）。
 * 启用 Redis 时，消息额外发布到 `ws:user:<id>` / `ws:agent:<id>` 频道，
 * 其他实例订阅后投递给本机持有的连接，从而实现跨实例路由。
 */

'use strict';

const OPEN = 1;

class SocketRegistry {
  constructor(backend, instanceId) {
    this.backend = backend;
    this.instanceId = instanceId;
    this.agentSockets = new Map();
    this.userSockets = new Map();
    this.unsubs = new Map();
  }

  channel(kind, id) {
    return `ws:${kind}:${id}`;
  }

  publish(kind, id, message) {
    if (this.backend.kind === 'memory') return;
    try {
      const p = this.backend.publish(this.channel(kind, id), {
        message,
        origin: this.instanceId,
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* 忽略发布异常 */
    }
  }

  subscribeRemote(kind, id, deliver) {
    if (this.backend.kind === 'memory') return;
    const key = `${kind}:${id}`;
    if (this.unsubs.has(key)) return;

    this.backend
      .subscribe(this.channel(kind, id), (msg) => {
        if (!msg || msg.origin === this.instanceId) return;
        deliver(msg.message);
      })
      .then((unsub) => this.unsubs.set(key, unsub))
      .catch(() => {});
  }

  unsubscribeRemote(kind, id) {
    const key = `${kind}:${id}`;
    const unsub = this.unsubs.get(key);
    if (!unsub) return;
    this.unsubs.delete(key);
    try {
      const p = unsub();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* 忽略取消订阅异常 */
    }
  }

  registerAgent(agentId, ws) {
    this.agentSockets.set(agentId, ws);
    this.subscribeRemote('agent', agentId, (message) => this.deliver(ws, message));
    console.log(`[人工客服] 客服 ${agentId} WebSocket已连接`);
  }

  registerUser(conversationId, ws) {
    this.userSockets.set(conversationId, ws);
    this.subscribeRemote('user', conversationId, (message) => this.deliver(ws, message));
    console.log(`[人工客服] 用户 ${conversationId} WebSocket已连接`);
  }

  unregisterAgent(agentId) {
    this.agentSockets.delete(agentId);
    this.unsubscribeRemote('agent', agentId);
  }

  /** 按 socket 反查并移除，返回归属供调用方做后续处理 */
  removeBySocket(ws) {
    for (const [agentId, socket] of this.agentSockets.entries()) {
      if (socket === ws) {
        this.agentSockets.delete(agentId);
        this.unsubscribeRemote('agent', agentId);
        return { agentId };
      }
    }

    for (const [conversationId, socket] of this.userSockets.entries()) {
      if (socket === ws) {
        this.userSockets.delete(conversationId);
        this.unsubscribeRemote('user', conversationId);
        return { conversationId };
      }
    }

    return {};
  }

  sendToUser(conversationId, message) {
    const local = this.deliver(this.userSockets.get(conversationId), message);
    this.publish('user', conversationId, message);
    return local;
  }

  sendToAgent(agentId, message) {
    const local = this.deliver(this.agentSockets.get(agentId), message);
    this.publish('agent', agentId, message);
    return local;
  }

  deliver(ws, message) {
    if (ws && ws.readyState === OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
}

module.exports = { SocketRegistry };
