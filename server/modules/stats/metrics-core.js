/**
 * 统计计算 · 核心指标
 *
 * 纯函数：输入快照，输出可直接返回给前端的数据结构。
 * 不碰数据库、不碰 HTTP，便于单独测试。
 */

'use strict';

const { parseDate, fmtDate, diffMinutes, lastNDates, WEEKDAY_LABELS } = require('./date-utils');

const RESOLVED_REASONS = new Set(['rated', 'manual', 'agent_ended', 'resolved']);
const MAX_HANDLE_MINUTES = 1440; // 超过 24 小时的会话视为异常数据，不参与均值

/** 平均分，保留一位小数 */
function avgScore(rows) {
  if (!rows.length) return 0;
  return Math.round((rows.reduce((s, r) => s + (r.score || 0), 0) / rows.length) * 10) / 10;
}

const startsWith = (value, prefix) => !!value && value.startsWith(prefix);

/**
 * 概览数据
 * @param {{conversations:Array, messages:Array, ratings:Array}} snapshot
 * @param {Date} [now]
 */
function buildOverview(snapshot, now = new Date()) {
  const { conversations: convs, messages: msgs, ratings: rts } = snapshot;

  const todayStr = fmtDate(now);
  const todayConvs = convs.filter(c => startsWith(c.created_at, todayStr));
  const todayMsgs = msgs.filter(m => startsWith(m.created_at, todayStr));
  const todayRatings = rts.filter(r => startsWith(r.created_at, todayStr));

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = fmtDate(yesterday);
  const yestConvs = convs.filter(c => startsWith(c.created_at, yesterdayStr));
  const yestMsgs = msgs.filter(m => startsWith(m.created_at, yesterdayStr));
  const yestRts = rts.filter(r => startsWith(r.created_at, yesterdayStr));

  const dayOfWeek = now.getDay() || 7; // 周日算第 7 天
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - dayOfWeek + 1);
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = fmtDate(weekStart);

  const monthStartStr = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-01';

  // 活跃会话
  const activeConvs = convs.filter(c => c.status === 'active' || c.status === 'idle');

  // AI / 人工处理占比
  const aiHandled = convs.filter(c => c.mode === 'ai' && c.status === 'closed').length;
  const humanHandled = convs.filter(
    c => (c.mode === 'human' || c.mode === 'queue') && c.status === 'closed'
  ).length;
  const handledTotal = aiHandled + humanHandled;
  const aiRate = handledTotal > 0 ? Math.round((aiHandled / handledTotal) * 100) : 0;

  // 会话解决率：close_reason 属于解决类，或该会话有评价
  const closedConvs = convs.filter(c => c.status === 'closed');
  const resolvedConvs = closedConvs.filter(c => {
    if (c.close_reason && RESOLVED_REASONS.has(c.close_reason)) return true;
    return rts.some(r => r.conversation_id === c.id);
  });
  const resolutionRate = closedConvs.length > 0
    ? Math.round((resolvedConvs.length / closedConvs.length) * 100)
    : 0;

  // 转人工率
  const transferRate = handledTotal > 0
    ? Math.round((humanHandled / handledTotal) * 100)
    : 0;

  // 平均处理时长 AHT
  const handleTimes = [];
  for (const c of closedConvs) {
    const start = parseDate(c.created_at);
    const end = parseDate(c.closed_at) || parseDate(c.updated_at);
    if (start && end && end > start) {
      const mins = diffMinutes(start, end);
      if (mins >= 0 && mins < MAX_HANDLE_MINUTES) handleTimes.push(mins);
    }
  }
  const avgHandleMinutes = handleTimes.length > 0
    ? Math.round(handleTimes.reduce((a, b) => a + b, 0) / handleTimes.length)
    : null;

  // 兜底率：assistant 消息中 source=fallback 的占比
  const aiMsgs = msgs.filter(m => m.role === 'assistant' && m.source);
  const fallbackMsgs = aiMsgs.filter(m => m.source === 'fallback').length;
  const fallbackRate = aiMsgs.length > 0
    ? Math.round((fallbackMsgs / aiMsgs.length) * 100)
    : 0;

  // 今日平均响应时长：每个会话里首条用户消息到首条非用户消息的间隔
  let avgResponseTime = null;
  const todayConvIds = new Set(todayConvs.map(c => c.id));
  const responseTimes = [];

  for (const convId of todayConvIds) {
    const convMsgs = msgs
      .filter(m => m.conversation_id === convId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    let firstUserTime = null;
    for (const msg of convMsgs) {
      if (!firstUserTime && msg.role === 'user') {
        firstUserTime = parseDate(msg.created_at);
      } else if (firstUserTime && msg.role !== 'user') {
        const botTime = parseDate(msg.created_at);
        if (botTime) responseTimes.push(diffMinutes(firstUserTime, botTime));
        break;
      }
    }
  }
  if (responseTimes.length > 0) {
    avgResponseTime = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
  }

  return {
    totalConversations: convs.length,
    totalMessages: msgs.length,
    totalRatings: rts.length,
    activeConversations: activeConvs.length,
    avgSatisfaction: avgScore(rts),
    aiHandlingRate: aiRate,

    today: {
      conversations: todayConvs.length,
      messages: todayMsgs.length,
      ratings: todayRatings.length,
      growth: yestConvs.length > 0
        ? Math.round(((todayConvs.length - yestConvs.length) / yestConvs.length) * 100)
        : 0,
      avgResponseMinutes: avgResponseTime,
    },

    yesterday: {
      conversations: yestConvs.length,
      messages: yestMsgs.length,
      ratings: yestRts.length,
      avgSatisfaction: avgScore(yestRts),
    },

    metrics: {
      resolutionRate,
      transferRate,
      avgHandleMinutes,
      fallbackRate,
      activeTotal: activeConvs.length,
    },

    week: {
      conversations: convs.filter(c => c.created_at >= weekStartStr).length,
      messages: msgs.filter(m => m.created_at >= weekStartStr).length,
    },

    month: {
      conversations: convs.filter(c => c.created_at >= monthStartStr).length,
      messages: msgs.filter(m => m.created_at >= monthStartStr).length,
    },

    handlingDistribution: {
      ai: aiHandled,
      human: humanHandled,
    },

    updatedAt: now.toISOString(),
  };
}

/** 日趋势 */
function buildTrend(snapshot, days) {
  const { conversations: convs, messages: msgs, ratings: rts } = snapshot;

  return lastNDates(days).map(({ date, dateStr }) => {
    const dayConvs = convs.filter(c => startsWith(c.created_at, dateStr));
    const dayMsgs = msgs.filter(m => startsWith(m.created_at, dateStr));
    const dayRatings = rts.filter(r => startsWith(r.created_at, dateStr));

    return {
      date: dateStr,
      weekday: WEEKDAY_LABELS[date.getDay()],
      conversations: dayConvs.length,
      messages: dayMsgs.length,
      uniqueVisitors: new Set(dayConvs.map(c => c.visitor_id)).size,
      aiHandled: dayConvs.filter(c => c.mode === 'ai').length,
      humanHandled: dayConvs.filter(c => c.mode === 'human' || c.mode === 'queue').length,
      avgSatisfaction: avgScore(dayRatings),
    };
  });
}

/** 满意度分布 */
function buildSatisfaction(snapshot) {
  const { ratings: rts } = snapshot;
  const LABELS = ['😞 很差', '😐 不满意', '🙂 一般', '😊 满意', '😍 非常满意'];

  const distribution = [1, 2, 3, 4, 5].map(score => ({
    score,
    count: rts.filter(r => r.score === score).length,
    label: LABELS[score - 1],
  }));

  const comments = rts
    .filter(r => r.comment && r.comment.trim())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 20)
    .map(r => ({ score: r.score, comment: r.comment, date: r.created_at }));

  const trend = lastNDates(14).map(({ dateStr }) => {
    const dayRatings = rts.filter(r => startsWith(r.created_at, dateStr));
    return {
      date: dateStr,
      avgScore: avgScore(dayRatings),
      count: dayRatings.length,
    };
  });

  return {
    total: rts.length,
    average: avgScore(rts),
    distribution,
    comments,
    trend,
  };
}

/** 高频问题 TOP N（按用户消息原文去重计数） */
function buildTopQuestions(snapshot, limit) {
  const { messages: msgs } = snapshot;
  const map = {};

  for (const msg of msgs) {
    if (msg.role !== 'user' || !msg.content) continue;
    const key = msg.content.trim().slice(0, 100);
    if (key.length < 2) continue;
    if (!map[key]) map[key] = { text: key, count: 0 };
    map[key].count++;
  }

  const top = Object.values(map)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((q, idx) => ({ rank: idx + 1, ...q }));

  return { data: top, total: Object.keys(map).length };
}

module.exports = { buildOverview, buildTrend, buildSatisfaction, buildTopQuestions, avgScore };
