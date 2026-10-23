/**
 * quality 模块对外出口
 *
 * 质量评测的审计存储（独立 quality.db）。
 * 候选问题列表来自 unanswered 模块，这里只做转出，不再直连主库。
 */

'use strict';

const repo = require('./quality.repo');
const unanswered = require('../unanswered');

/** 运营复核候选：未匹配问题里按出现次数排序 */
async function listCandidates(limit = 100) {
  return unanswered.listForReview(limit);
}

module.exports = {
  CAUSES: repo.CAUSES,
  STATUSES: repo.STATUSES,
  createRun: repo.createRun,
  recordCase: repo.recordCase,
  finishRun: repo.finishRun,
  listRuns: repo.listRuns,
  listCases: repo.listCases,
  updateBadcase: repo.updateBadcase,
  listCandidates,
  _db: repo._db,
};
