/**
 * 统计服务（编排层）
 *
 * 负责参数收敛 + 取快照 + 调纯计算函数，不含业务算法也不含 SQL。
 */

'use strict';

const repo = require('./stats.repo');
const core = require('./metrics-core');
const ops = require('./metrics-ops');
const exporter = require('./stats.export');
const humanService = require('../../services/human');
const unansweredService = require('../../services/unanswered');

const DEFAULT_TREND_DAYS = 30;
const DEFAULT_OPS_DAYS = 7;
const MAX_DAYS = 365;
const MAX_OPS_DAYS = 90;

/** 天数收敛：非法回落默认，夹到 [1, max] */
function clampDays(raw, fallback, max = MAX_DAYS) {
  const n = parseInt(raw) || fallback;
  return Math.min(Math.max(n, 1), max);
}

// ============ 概览与趋势 ============

function getOverview() {
  return core.buildOverview(repo.snapshot());
}

function getTrend(rawDays) {
  return core.buildTrend(repo.snapshot(), clampDays(rawDays, DEFAULT_TREND_DAYS));
}

function getSatisfaction() {
  return core.buildSatisfaction(repo.snapshot());
}

function getTopQuestions(rawLimit) {
  const limit = parseInt(rawLimit) || 10;
  return core.buildTopQuestions(repo.snapshot(), limit);
}

// ============ 运营视图 ============

function getConversationPage({ page, pageSize, status, mode } = {}) {
  return ops.buildConversationPage(repo.snapshot(), {
    page: parseInt(page) || 1,
    pageSize: parseInt(pageSize) || 20,
    status,
    mode,
  });
}

function getKnowledgeHitRate(rawDays) {
  return ops.buildKnowledgeHitRate(repo.snapshot(), clampDays(rawDays, DEFAULT_TREND_DAYS));
}

function getAgentWorkload(rawDays) {
  return ops.buildAgentWorkload(repo.snapshot(), clampDays(rawDays, DEFAULT_OPS_DAYS, MAX_OPS_DAYS));
}

function getQueueStats(rawDays) {
  const days = clampDays(rawDays, DEFAULT_OPS_DAYS, MAX_OPS_DAYS);
  const currentQueueLength = humanService?.queue?.length || 0;
  return ops.buildQueueStats(repo.snapshot(), days, currentQueueLength);
}

function getUnansweredTrend(rawDays) {
  const days = clampDays(rawDays, DEFAULT_TREND_DAYS);

  const stats = unansweredService.stats();
  const trend = unansweredService.trend(days);
  const totalAll = stats.pending + stats.added + stats.dismissed;

  return {
    currentPending: stats.pending,
    totalAdded: stats.added,
    totalDismissed: stats.dismissed,
    totalAll,
    resolutionRate: totalAll > 0
      ? Math.round(((stats.added + stats.dismissed) / totalAll) * 100)
      : 0,
    dailyTrend: trend.data,
    topPending: stats.topPending,
  };
}

// ============ 导出 ============

function exportCsv(rawDays) {
  const days = Math.min(parseInt(rawDays) || DEFAULT_TREND_DAYS, MAX_DAYS);
  return exporter.buildExportCsv(repo.snapshot(), days);
}

// ============ 日报（供 /api/chat/stats 使用） ============

async function getDailySnapshot() {
  const today = (await repo.getToday()) || {
    total_conversations: 0, total_messages: 0, ai_handled: 0,
  };
  const week = await repo.getRecent(7);
  const summary = await repo.getSummary();
  return { today, week, summary };
}

module.exports = {
  getOverview,
  getTrend,
  getSatisfaction,
  getTopQuestions,
  getConversationPage,
  getKnowledgeHitRate,
  getAgentWorkload,
  getQueueStats,
  getUnansweredTrend,
  exportCsv,
  getDailySnapshot,
};
