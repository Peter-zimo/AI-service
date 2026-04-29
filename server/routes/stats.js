/**
 * 数据统计 API 路由
 * 
 * 提供完整的运营数据统计，包括：
 * - 概览卡片（总对话量/消息数/满意度/AI处理率）
 * - 日趋势图（近30天对话量/消息量折线）
 * - 处理方式分布（AI vs 人工 饼图）
 * - 满意度分布（星级分布）
 * - 高频问题 TOP10
 * - 客服工作量排行
 */

const express = require('express');
const router = express.Router();
const dbSvc = require('../services/database');
const XLSX = require('xlsx');

// ============ 工具函数 ============

/** 解析日期字符串为Date对象 */
function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/** 获取日期范围 */
function getDateRange(days) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

/** 格式化日期 YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

/** 计算两个日期之间的天数差（分钟） */
function diffMinutes(d1, d2) {
  return Math.round((d2 - d1) / 60000);
}

// ============ API: 总览数据 ============

router.get('/overview', (req, res) => {
  try {
    const now = new Date();
    const convs = dbSvc._conversations();
    const msgs = dbSvc._messages();
    const rts = dbSvc._ratings();

    // 今日数据
    const todayStr = fmtDate(now);
    const todayConvs = convs.filter(c => c.created_at && c.created_at.startsWith(todayStr));
    const todayMsgs = msgs.filter(m => m.created_at && m.created_at.startsWith(todayStr));
    const todayRatings = rts.filter(r => r.created_at && r.created_at.startsWith(todayStr));

    // 昨日对比
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = fmtDate(yesterday);
    const yestConvs = convs.filter(c => c.created_at && c.created_at.startsWith(yesterdayStr));

    // 本周数据（周一到今天）
    const dayOfWeek = now.getDay() || 7; // 周日=7
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - dayOfWeek + 1);
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = fmtDate(weekStart);

    // 本月数据
    const monthStartStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';

    // 总体统计
    const totalConvs = convs.length;
    const totalMsgs = msgs.length;
    const totalRatings = rts.length;

    // 活跃会话
    const activeConvs = convs.filter(c => c.status === 'active' || c.status === 'idle').length;

    // AI处理率（mode === 'ai' 的已关闭会话）
    const aiHandled = convs.filter(c => c.mode === 'ai' && c.status === 'closed').length;
    const humanHandled = convs.filter(
      c => (c.mode === 'human' || c.mode === 'queue') && c.status === 'closed'
    ).length;
    const handledTotal = aiHandled + humanHandled;
    const aiRate = handledTotal > 0 ? Math.round((aiHandled / handledTotal) * 100) : 0;

    // 平均满意度
    let avgScore = 0;
    if (rts.length > 0) {
      avgScore = Math.round((rts.reduce((s, r) => s + (r.score || 0), 0) / rts.length) * 10) / 10;
    }

    // 今日平均响应时长（估算：取第一条用户消息和第一条bot回复的时间差）
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

    res.json({
      success: true,
      data: {
        // 核心指标
        totalConversations: totalConvs,
        totalMessages: totalMsgs,
        totalRatings: totalRatings,
        activeConversations: activeConvs,
        avgSatisfaction: avgScore,
        aiHandlingRate: aiRate,

        // 今日
        today: {
          conversations: todayConvs.length,
          messages: todayMsgs.length,
          ratings: todayRatings.length,
          growth: yestConvs.length > 0 ? Math.round(((todayConvs.length - yestConvs.length) / yestConvs.length) * 100) : 0,
          avgResponseMinutes: avgResponseTime,
        },

        // 本周
        week: {
          conversations: convs.filter(c => c.created_at >= weekStartStr).length,
          messages: msgs.filter(m => m.created_at >= weekStartStr).length,
        },

        // 本月
        month: {
          conversations: convs.filter(c => c.created_at >= monthStartStr).length,
          messages: msgs.filter(m => m.created_at >= monthStartStr).length,
        },

        // 处理方式分布
        handlingDistribution: {
          ai: aiHandled,
          human: humanHandled,
        },

        updatedAt: now.toISOString(),
      }
    });
  } catch (e) {
    console.error('[统计] overview 错误:', e.message);
    res.status(500).json({ success: false, error: '获取概览数据失败' });
  }
});

// ============ API: 日趋势数据 ============

router.get('/trend', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const result = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = fmtDate(d);

      const dayConvs = dbSvc._conversations().filter(c => c.created_at && c.created_at.startsWith(dateStr));
      const dayMsgs = dbSvc._messages().filter(m => m.created_at && m.created_at.startsWith(dateStr));
      const dayRatings = dbSvc._ratings().filter(r => r.created_at && r.created_at.startsWith(dateStr));

      const dayAi = dayConvs.filter(c => c.mode === 'ai').length;
      const dayHuman = dayConvs.filter(c => c.mode === 'human' || c.mode === 'queue').length;

      let dayAvgScore = 0;
      if (dayRatings.length > 0) {
        dayAvgScore = Math.round((dayRatings.reduce((s, r) => s + (r.score || 0), 0) / dayRatings.length) * 10) / 10;
      }

      // 独立访客数
      const uniqueVisitors = new Set(dayConvs.map(c => c.visitor_id)).size;

      result.push({
        date: dateStr,
        weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
        conversations: dayConvs.length,
        messages: dayMsgs.length,
        uniqueVisitors,
        aiHandled: dayAi,
        humanHandled: dayHuman,
        avgSatisfaction: dayAvgScore,
      });
    }

    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[统计] trend 错误:', e.message);
    res.status(500).json({ success: false, error: '获取趋势数据失败' });
  }
});

// ============ API: 满意度分布 ============

router.get('/satisfaction', (req, res) => {
  try {
    // 星级分布
    const distribution = [1, 2, 3, 4, 5].map(score => ({
      score,
      count: dbSvc._ratings().filter(r => r.score === score).length,
      label: ['😞 很差', '😐 不满意', '🙂 一般', '😊 满意', '😍 非常满意'][score - 1],
    }));

    // 有评论的评价（最近20条）
    const comments = dbSvc._ratings()
      .filter(r => r.comment && r.comment.trim())
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20)
      .map(r => ({
        score: r.score,
        comment: r.comment,
        date: r.created_at,
      }));

    // 按日趋势（近14天）
    const trend = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = fmtDate(d);
      const dayRatings = dbSvc._ratings().filter(r => r.created_at && r.created_at.startsWith(dateStr));
      const avg = dayRatings.length > 0
        ? Math.round((dayRatings.reduce((s, r) => s + (r.score || 0), 0) / dayRatings.length) * 10) / 10
        : 0;
      trend.push({ date: dateStr, avgScore: avg, count: dayRatings.length });
    }

    res.json({
      success: true,
      data: {
        total: dbSvc._ratings().length,
        average: dbSvc._ratings().length > 0
          ? Math.round((dbSvc._ratings().reduce((s, r) => s + (r.score || 0), 0) / dbSvc._ratings().length) * 10) / 10
          : 0,
        distribution,
        comments,
        trend,
      }
    });
  } catch (e) {
    console.error('[统计] satisfaction 错误:', e.message);
    res.status(500).json({ success: false, error: '获取满意度数据失败' });
  }
});

// ============ API: 高频问题 TOP N ============

router.get('/top-questions', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    // 统计用户消息频率
    const questionMap = {};
    for (const msg of dbSvc._messages()) {
      if (msg.role === 'user' && msg.content) {
        const key = msg.content.trim().slice(0, 100); // 截断过长内容
        if (key.length < 2) continue;
        if (!questionMap[key]) {
          questionMap[key] = { text: key, count: 0 };
        }
        questionMap[key].count++;
      }
    }

    // 按频次排序
    const topQuestions = Object.values(questionMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((q, idx) => ({ rank: idx + 1, ...q }));

    res.json({ success: true, data: topQuestions, total: Object.keys(questionMap).length });
  } catch (e) {
    console.error('[统计] top-questions 错误:', e.message);
    res.status(500).json({ success: false, error: '获取高频问题失败' });
  }
});

// ============ API: 会话列表（带筛选） ============

router.get('/conversations', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const status = req.query.status; // active/idle/closed
    const mode = req.query.mode;     // ai/human/queue

    let list = [...dbSvc._conversations()];

    // 筛选状态
    if (status) list = list.filter(c => c.status === status);
    if (mode) list = list.filter(c => c.mode === mode);

    // 排序：最近更新的在前
    list.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

    const total = list.length;
    const start = (page - 1) * pageSize;
    const paged = list.slice(start, start + pageSize);

    // 补充每条会话的消息数和评价
    const enriched = paged.map(conv => {
      const msgCount = dbSvc._messages().filter(m => m.conversation_id === conv.id).length;
      const rating = dbSvc._ratings().find(r => r.conversation_id === conv.id);
      return {
        ...conv,
        messageCount: msgCount,
        rating: rating ? rating.score : null,
      };
    });

    res.json({
      success: true,
      data: enriched,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (e) {
    console.error('[统计] conversations 错误:', e.message);
    res.status(500).json({ success: false, error: '获取会话列表失败' });
  }
});

// 导出统计数据（支持 XLSX / CSV）【P3-1安全修复：限制日期范围上限】
router.get('/export/:format', (req, res) => {
  try {
    const { format } = req.params;
    // 【P3-1安全修复】限制日期范围上限为365天
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const range = getDateRange(days);
    const now = new Date();
    const nowStr = now.toISOString().slice(0, 10);

    // 【P3-1安全修复】限制数据量
    const MAX_CONVS = 5000;
    const MAX_MSGS = 20000;
    
    const convs = dbSvc._conversations().slice(0, MAX_CONVS);
    const msgs = dbSvc._messages().slice(0, MAX_MSGS);
    const rts = dbSvc._ratings();

    // ---- 概览 ----
    const overviewRows = [{
      '指标': '总对话数', '数值': convs.length,
    }, {
      '指标': '总消息数', '数值': msgs.length,
    }, {
      '指标': '评价总数', '数值': rts.length,
    }, {
      '指标': '平均满意度',
      '数值': rts.length > 0 ? (rts.reduce((s, r) => s + (r.score || 0), 0) / rts.length).toFixed(1) + '星' : '—',
    }, {
      '指标': '活跃会话',
      '数值': convs.filter(c => c.status === 'active' || c.status === 'idle').length,
    }, {
      '指标': '已结束会话',
      '数值': convs.filter(c => c.status === 'closed').length,
    }, {
      '指标': 'AI处理数',
      '数值': convs.filter(c => c.mode === 'ai' && c.status === 'closed').length,
    }, {
      '指标': '人工处理数',
      '数值': convs.filter(c => (c.mode === 'human' || c.mode === 'queue') && c.status === 'closed').length,
    }];

    // ---- 日趋势 ----
    const trendMap = {};
    for (let d = new Date(range.start); d <= range.end; d.setDate(d.getDate() + 1)) {
      const key = fmtDate(d);
      trendMap[key] = { 日期: key, 对话数: 0, 消息数: 0 };
    }
    for (const c of convs) {
      if (c.created_at && c.created_at >= range.start.toISOString() && c.created_at <= range.end.toISOString()) {
        const key = c.created_at.slice(0, 10);
        if (trendMap[key]) trendMap[key].对话数++;
      }
    }
    for (const m of msgs) {
      if (m.created_at && m.created_at >= range.start.toISOString() && m.created_at <= range.end.toISOString()) {
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

    const wb = XLSX.utils.book_new();

    // Sheet 1: 概览
    const ws1 = XLSX.utils.json_to_sheet(overviewRows);
    ws1['!cols'] = [{ wch: 20 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws1, '概览');

    // Sheet 2: 日趋势
    const trendRows = Object.values(trendMap).sort((a, b) => a['日期'].localeCompare(b['日期']));
    const ws2 = XLSX.utils.json_to_sheet(trendRows);
    ws2['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws2, '日趋势');

    // Sheet 3: 满意度
    const ws3 = XLSX.utils.json_to_sheet(ratingRows);
    ws3['!cols'] = [{ wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws3, '满意度分布');

    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=stats_${nowStr}.xlsx`);
      return res.end(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=stats_${nowStr}.csv`);
      return res.send('\uFEFF' + XLSX.utils.sheet_to_csv(ws1));
    }

    res.status(400).json({ success: false, error: '不支持的格式，请使用 xlsx / csv' });
  } catch (error) {
    console.error('导出统计失败:', error);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});

module.exports = router;
