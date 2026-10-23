/**
 * 数据统计路由
 *
 * 只做「取参 → 调 service → 返回」。计算在 modules/stats，SQL 在 stats.repo.js。
 */

'use strict';

const express = require('express');
const stats = require('../modules/stats');

const router = express.Router();

function guard(res, error, logLabel, clientMessage) {
  console.error(`${logLabel}:`, error.message);
  res.status(500).json({ success: false, error: clientMessage });
}

// ============ 概览 ============
router.get('/overview', (req, res) => {
  try {
    res.json({ success: true, data: stats.getOverview() });
  } catch (e) {
    guard(res, e, '[统计] overview 错误', '获取概览数据失败');
  }
});

// ============ 日趋势 ============
router.get('/trend', (req, res) => {
  try {
    res.json({ success: true, data: stats.getTrend(req.query.days) });
  } catch (e) {
    guard(res, e, '[统计] trend 错误', '获取趋势数据失败');
  }
});

// ============ 满意度 ============
router.get('/satisfaction', (req, res) => {
  try {
    res.json({ success: true, data: stats.getSatisfaction() });
  } catch (e) {
    guard(res, e, '[统计] satisfaction 错误', '获取满意度数据失败');
  }
});

// ============ 高频问题 ============
router.get('/top-questions', (req, res) => {
  try {
    const result = stats.getTopQuestions(req.query.limit);
    res.json({ success: true, data: result.data, total: result.total });
  } catch (e) {
    guard(res, e, '[统计] top-questions 错误', '获取高频问题失败');
  }
});

// ============ 会话列表 ============
router.get('/conversations', (req, res) => {
  try {
    const result = stats.getConversationPage({
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: req.query.status,
      mode: req.query.mode,
    });
    res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (e) {
    guard(res, e, '[统计] conversations 错误', '获取会话列表失败');
  }
});

// ============ 知识库命中率 ============
router.get('/knowledge-hit-rate', (req, res) => {
  try {
    const result = stats.getKnowledgeHitRate(req.query.days);
    res.json({ success: true, data: result.data, summary: result.summary });
  } catch (e) {
    guard(res, e, '[统计] knowledge-hit-rate 错误', '获取知识库命中率失败');
  }
});

// ============ 客服工作量 ============
router.get('/agent-workload', (req, res) => {
  try {
    const result = stats.getAgentWorkload(req.query.days);
    res.json({ success: true, data: result.data, total: result.total, period: result.period });
  } catch (e) {
    guard(res, e, '[统计] agent-workload 错误', '获取客服工作量失败');
  }
});

// ============ 排队统计 ============
router.get('/queue-stats', (req, res) => {
  try {
    res.json({ success: true, data: stats.getQueueStats(req.query.days) });
  } catch (e) {
    guard(res, e, '[统计] queue-stats 错误', '获取排队统计失败');
  }
});

// ============ 未匹配查询趋势 ============
router.get('/unanswered-trend', async (req, res) => {
  try {
    res.json({ success: true, data: await stats.getUnansweredTrend(req.query.days) });
  } catch (e) {
    guard(res, e, '[统计] unanswered-trend 错误', '获取未匹配查询趋势失败');
  }
});

// ============ 导出（CSV） ============
router.get('/export/:format', (req, res) => {
  try {
    if (req.params.format !== 'csv') {
      return res.status(400).json({ success: false, error: '不支持的格式，请使用 csv' });
    }

    const { csv, filenameDate } = stats.exportCsv(req.query.days);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=stats_${filenameDate}.csv`);
    res.send(csv);
  } catch (e) {
    console.error('导出统计失败:', e);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});

module.exports = router;
