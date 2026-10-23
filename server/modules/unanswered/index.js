/**
 * unanswered 模块对外出口
 *
 * 结构：
 *   unanswered.repo.js     数据访问（唯一写 SQL 的地方）
 *   unanswered.service.js  业务（记录 / 复核 / 转知识库 / 趋势）
 */

'use strict';

const service = require('./unanswered.service');

module.exports = {
  recordQuery: service.recordQuery,
  list: service.list,
  listForReview: service.listForReview,
  approve: service.approve,
  dismiss: service.dismiss,
  stats: service.stats,
  trend: service.trend,
};
