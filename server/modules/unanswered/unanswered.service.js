/**
 * 未匹配查询服务（知识库反馈闭环）
 *
 * 记录 AI 没能用知识库回答的问题，运营补齐后可直接转入知识库。
 */

'use strict';

const repo = require('./unanswered.repo');

const MAX_QUERY_LENGTH = 200;

/**
 * 记录一条未匹配查询；同名 pending 记录只累加次数
 */
async function recordQuery(query) {
  if (!query || !query.trim()) return;

  const clean = query.trim().slice(0, MAX_QUERY_LENGTH);
  const existing = await repo.findPendingByQuery(clean);

  if (existing) {
    await repo.bumpCount(existing.id);
  } else {
    await repo.insert(clean);
  }
}

/**
 * @param {'pending'|'added'|'dismissed'|'all'} status
 */
async function list(status = 'pending', limit = 100) {
  return repo.listByStatus(status, limit);
}

/** 运营复核候选（按出现次数倒序） */
async function listForReview(limit = 100) {
  return repo.listForReview(limit);
}

/** 补充答案并写入知识库 */
async function approve(id, answer, createdBy) {
  if (!answer || !answer.trim()) return { success: false, error: '答案不能为空' };

  const item = await repo.getById(id);
  if (!item) return { success: false, error: '记录不存在' };

  // 懒加载：knowledge 模块加载时会启动后台 embedding 计算，
  // 顶层引入会让「只查未答列表」的场景也背上这个副作用
  const knowledgeService = require('../knowledge');
  const result = await knowledgeService.addItem(item.query, answer.trim());
  await repo.markAdded(id, answer.trim(), createdBy || 'admin');

  return { success: true, knowledgeId: result.id, question: item.query };
}

async function dismiss(id) {
  const item = await repo.getById(id);
  if (!item) return { success: false, error: '记录不存在' };

  await repo.markDismissed(id);
  return { success: true };
}

async function stats() {
  return {
    pending: await repo.countByStatus('pending'),
    added: await repo.countByStatus('added'),
    dismissed: await repo.countByStatus('dismissed'),
    topPending: await repo.topPending(10),
  };
}

/** 每日趋势（近 N 天，按日期正序） */
async function trend(days = 30) {
  const rows = await repo.dailyNew(days);
  rows.reverse();

  let cumulative = 0;
  const data = [];

  for (const row of rows) {
    cumulative += row.new_count;
    const solved = await repo.solvedOn(row.day);
    data.push({
      date: row.day,
      newCount: row.new_count,
      solved,
      pending: cumulative - (solved || 0),
      cumulative,
    });
  }

  return {
    data,
    total: data.length > 0 ? data[data.length - 1].cumulative : 0,
    latestDate: rows.length > 0 ? rows[rows.length - 1].day : null,
  };
}

module.exports = { recordQuery, list, listForReview, approve, dismiss, stats, trend };
