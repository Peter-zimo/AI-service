/**
 * stats 模块对外出口
 *
 * 结构：
 *   stats.repo.js      数据访问（快照缓存 + 日报表，唯一写 SQL 的地方）
 *   metrics-core.js    核心指标计算（纯函数）
 *   metrics-ops.js     运营视图计算（纯函数）
 *   stats.export.js    CSV 导出
 *   stats.service.js   参数收敛与编排
 *   date-utils.js      日期工具
 *
 * 外部只允许 require('../modules/stats')。
 */

'use strict';

const service = require('./stats.service');
const repo = require('./stats.repo');

module.exports = {
  // 聚合查询
  getOverview: service.getOverview,
  getTrend: service.getTrend,
  getSatisfaction: service.getSatisfaction,
  getTopQuestions: service.getTopQuestions,
  getConversationPage: service.getConversationPage,
  getKnowledgeHitRate: service.getKnowledgeHitRate,
  getAgentWorkload: service.getAgentWorkload,
  getQueueStats: service.getQueueStats,
  getUnansweredTrend: service.getUnansweredTrend,
  exportCsv: service.exportCsv,
  getDailySnapshot: service.getDailySnapshot,

  // 日报计数（供 chat 等模块调用）
  incrementConversations: repo.incrementConversations,
  incrementMessages: repo.incrementMessages,
  incrementAiHandled: repo.incrementAiHandled,

  // 生命周期（进程启动/退出时调用；缓存由模块加载时自动启动）
  stopCache: repo.stopCache,
};

// 启动快照缓存（与重构前一致：模块加载即开始 5 秒定时刷新）
repo.startCache();
