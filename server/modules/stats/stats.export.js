/**
 * 统计数据导出（CSV）
 *
 * 三段式：概览 / 日趋势 / 满意度分布，用 section 列区分。
 */

'use strict';

const { toCsv } = require('../../utils/csv');
const { getDateRange, fmtDate } = require('./date-utils');

const MAX_CONVS = 5000;
const MAX_MSGS = 20000;

/**
 * @param {{conversations:Array, messages:Array, ratings:Array}} snapshot
 * @param {number} days
 * @returns {{csv: string, filenameDate: string}}
 */
function buildExportCsv(snapshot, days) {
  const range = getDateRange(days);
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 10);

  const convs = snapshot.conversations.slice(0, MAX_CONVS);
  const msgs = snapshot.messages.slice(0, MAX_MSGS);
  const rts = snapshot.ratings;

  // ---- 概览 ----
  const overviewRows = [
    { '指标': '总对话数', '数值': convs.length },
    { '指标': '总消息数', '数值': msgs.length },
    { '指标': '评价总数', '数值': rts.length },
    {
      '指标': '平均满意度',
      '数值': rts.length > 0
        ? (rts.reduce((s, r) => s + (r.score || 0), 0) / rts.length).toFixed(1) + '星'
        : '—',
    },
    { '指标': '活跃会话', '数值': convs.filter(c => c.status === 'active' || c.status === 'idle').length },
    { '指标': '已结束会话', '数值': convs.filter(c => c.status === 'closed').length },
    { '指标': 'AI处理数', '数值': convs.filter(c => c.mode === 'ai' && c.status === 'closed').length },
    {
      '指标': '人工处理数',
      '数值': convs.filter(c => (c.mode === 'human' || c.mode === 'queue') && c.status === 'closed').length,
    },
  ];

  // ---- 日趋势 ----
  const trendMap = {};
  for (let d = new Date(range.start); d <= range.end; d.setDate(d.getDate() + 1)) {
    const key = fmtDate(d);
    trendMap[key] = { 日期: key, 对话数: 0, 消息数: 0 };
  }

  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  for (const c of convs) {
    if (c.created_at && c.created_at >= startIso && c.created_at <= endIso) {
      const key = c.created_at.slice(0, 10);
      if (trendMap[key]) trendMap[key].对话数++;
    }
  }
  for (const m of msgs) {
    if (m.created_at && m.created_at >= startIso && m.created_at <= endIso) {
      const key = m.created_at.slice(0, 10);
      if (trendMap[key]) trendMap[key].消息数++;
    }
  }

  // ---- 满意度分布 ----
  const scoreMap = {};
  for (let i = 1; i <= 5; i++) scoreMap[i] = 0;
  for (const r of rts) if (r.score >= 1 && r.score <= 5) scoreMap[r.score]++;

  const ratingRows = Object.entries(scoreMap).map(([star, count]) => ({
    '星级': star + '星', '评价数': count,
  }));

  const trendRows = Object.values(trendMap).sort((a, b) => a['日期'].localeCompare(b['日期']));

  const rows = [
    ...overviewRows.map(row => ({ section: '概览', ...row })),
    ...trendRows.map(row => ({ section: '日趋势', ...row })),
    ...ratingRows.map(row => ({ section: '满意度分布', ...row })),
  ];

  return { csv: '\uFEFF' + toCsv(rows), filenameDate: nowStr };
}

module.exports = { buildExportCsv, MAX_CONVS, MAX_MSGS };
