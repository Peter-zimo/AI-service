/**
 * human 模块对外出口
 *
 * 结构：
 *   agent.registry.js  坐席账号与在线状态
 *   queue.js           排队队列（纯数据）
 *   sockets.js         WebSocket 连接注册表
 *   human.service.js   编排（上下线 / 分配 / 队列推进 / 广播）
 *
 * 对外导出单例，与重构前 services/human.js 的接口保持一致。
 */

'use strict';

const service = require('./human.service');
const registry = require('./agent.registry');
const queue = require('./queue');

// 启动时加载坐席（原 services/human.js 在构造时完成）
registry.load();

module.exports = service;

// 常量沿用旧导出位置
module.exports.AGENT_STATUS = registry.AGENT_STATUS;

// 测试接缝（正式代码不要用）
module.exports._test = {
  agents: registry._test.agents,
  queue: queue._test.queue,
  reset() {
    registry._test.reset();
    queue._test.reset();
  },
};
