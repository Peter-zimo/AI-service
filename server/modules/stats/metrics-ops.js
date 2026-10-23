/**
 * 统计计算 · 运营视图
 *
 * 会话列表分页、知识库命中率、客服工作量、排队时长。
 * 同样是纯函数：输入快照，输出数据结构。
 */

'use strict';

const { lastNDates, diffMinutes, parseDate } = require('./date-utils');

const MAX_WAIT_MINUTES = 1440; // 超过 24 小时的等待视为异常数据

/** 会话列表（带筛选与分页） */
function buildConversationPage(snapshot, { page = 1, pageSize = 20, status, mode } = {}) {
  const { conversations, messages, ratings } = snapshot;

  let list = [...conversations];
  if (status) list = list.filter(c => c.status === status);
  if (mode) list = list.filter(c => c.mode === mode);

  list.sort((a, b) =>
    new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

  const total = list.length;
  const start = (page - 1) * pageSize;
  const paged = list.slice(start, start + pageSize);

  const data = paged.map(conv => {
    const messageCount = messages.filter(m => m.conversation_id === conv.id).length;
    const rating = ratings.find(r => r.conversation_id === conv.id);
    return { ...conv, messageCount, rating: rating ? rating.score : null };
  });

  return {
    data,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

/** 知识库命中率（按日，统计 assistant 消息的 source 分布） */
function buildKnowledgeHitRate(snapshot, days) {
  const { messages } = snapshot;

  const data = lastNDates(days).map(({ dateStr }) => {
    const dayMsgs = messages.filter(m =>
      m.created_at && m.created_at.startsWith(dateStr) &&
      m.role === 'assistant' && m.source
    );

    const total = dayMsgs.length;
    const knowledge = dayMsgs.filter(m => m.source === 'knowledge').length;
    const ai = dayMsgs.filter(m => m.source === 'ai').length;
    const fallback = dayMsgs.filter(m => m.source === 'fallback').length;

    return {
      date: dateStr,
      total,
      knowledge,
      ai,
      fallback,
      hitRate: total > 0 ? Math.round((knowledge / total) * 100) : 0,
      aiRate: total > 0 ? Math.round((ai / total) * 100) : 0,
      fallbackRate: total > 0 ? Math.round((fallback / total) * 100) : 0,
    };
  });

  const totalAll = data.reduce((s, r) => s + r.total, 0);
  const totalKb = data.reduce((s, r) => s + r.knowledge, 0);

  return {
    data,
    summary: {
      total: totalAll,
      knowledge: totalKb,
      overallHitRate: totalAll > 0 ? Math.round((totalKb / totalAll) * 100) : 0,
      days: data.filter(r => r.total > 0).length,
    },
  };
}

/** 客服工作量排行 */
function buildAgentWorkload(snapshot, days) {
  const { conversations, messages } = snapshot;

  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - days);
  const rangeStartStr = rangeStart.toISOString();

  const humanConvs = conversations.filter(c =>
    c.mode === 'human' && c.assigned_agent && c.created_at >= rangeStartStr
  );

  const agentMap = {};

  for (const conv of humanConvs) {
    const agentId = conv.assigned_agent;
    const agentName = conv.agent_name || agentId;

    if (!agentMap[agentId]) {
      agentMap[agentId] = {
        agentId,
        agentName,
        conversations: 0,
        totalMessages: 0,
        avgResponseMinutes: 0,
        responseTimes: [],
        lastActive: null,
      };
    }

    const agent = agentMap[agentId];
    agent.conversations++;
    if (conv.last_message_at && (!agent.lastActive || conv.last_message_at > agent.lastActive)) {
      agent.lastActive = conv.last_message_at;
    }

    // 首条用户消息 → 首条客服回复
    const convMsgs = messages
      .filter(m => m.conversation_id === conv.id)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    let firstUser = null;
    for (const msg of convMsgs) {
      if (!firstUser && msg.role === 'user') {
        firstUser = new Date(msg.created_at);
      } else if (firstUser && msg.role === 'agent') {
        const responseTime = diffMinutes(firstUser, new Date(msg.created_at));
        if (responseTime >= 0 && responseTime < MAX_WAIT_MINUTES) {
          agent.responseTimes.push(responseTime);
        }
        break;
      }
    }
  }

  const agents = Object.values(agentMap).map(a => ({
    agentId: a.agentId,
    agentName: a.agentName,
    conversations: a.conversations,
    totalMessages: a.totalMessages,
    avgResponseMinutes: a.responseTimes.length > 0
      ? Math.round(a.responseTimes.reduce((s, t) => s + t, 0) / a.responseTimes.length)
      : null,
    lastActive: a.lastActive,
  }));

  agents.sort((a, b) => b.conversations - a.conversations);

  return { data: agents, total: agents.length, period: `${days}天` };
}

/** 排队等待时长统计 */
function buildQueueStats(snapshot, days, currentQueueLength) {
  const { conversations } = snapshot;

  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - days);
  const rangeStartStr = rangeStart.toISOString();

  const queueConvs = conversations.filter(c =>
    c.mode === 'human' && c.assigned_agent && c.created_at >= rangeStartStr
  );

  // 用 created_at → updated_at 近似排队时长
  const waitOf = (conv) => {
    const created = parseDate(conv.created_at);
    const updated = parseDate(conv.updated_at);
    if (!created || !updated) return null;
    const mins = diffMinutes(created, updated);
    return (mins >= 0 && mins < MAX_WAIT_MINUTES) ? mins : null;
  };

  const waitTimes = queueConvs.map(waitOf).filter(v => v !== null);

  const avgWait = waitTimes.length > 0
    ? Math.round(waitTimes.reduce((s, t) => s + t, 0) / waitTimes.length)
    : null;
  const maxWait = waitTimes.length > 0 ? Math.max(...waitTimes) : null;

  const dailyTrend = lastNDates(days).map(({ dateStr }) => {
    const dayConvs = queueConvs.filter(c => c.created_at.startsWith(dateStr));
    const dayWaits = dayConvs.map(waitOf).filter(v => v !== null);

    return {
      date: dateStr,
      conversations: dayConvs.length,
      avgWait: dayWaits.length > 0
        ? Math.round(dayWaits.reduce((s, t) => s + t, 0) / dayWaits.length)
        : 0,
      maxWait: dayWaits.length > 0 ? Math.max(...dayWaits) : 0,
    };
  });

  return {
    currentQueueLength,
    totalHandled: queueConvs.length,
    avgWaitMinutes: avgWait,
    maxWaitMinutes: maxWait,
    dailyTrend,
  };
}

module.exports = {
  buildConversationPage,
  buildKnowledgeHitRate,
  buildAgentWorkload,
  buildQueueStats,
};
