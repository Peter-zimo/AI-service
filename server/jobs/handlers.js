/**
 * 内置任务处理器
 *
 * knowledge.embedding  重算知识库向量（可按 id 子集）
 * quality.evaluate     跑质量评估（黄金集）
 */

'use strict';

const registry = require('./registry');
const knowledge = require('../modules/knowledge');

registry.register('knowledge.embedding', async (payload = {}) => {
  const ids = Array.isArray(payload.ids) && payload.ids.length > 0 ? payload.ids : null;
  const result = await knowledge.recomputeEmbeddings(ids);
  return { ...result, scope: ids ? 'ids' : 'all' };
});

registry.register('knowledge.import', async (payload = {}) => {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new Error('没有可导入的数据');
  // 导入任务等待向量算完再结束，前端轮询到 completed 时知识库已可用
  return knowledge.batchAdd(items, { waitForEmbeddings: true });
});

registry.register('quality.evaluate', async (payload = {}) => {
  // 延迟 require：避免 app 启动时加载评估脚本与其数据文件
  const { runEvaluation } = require('../../scripts/run-quality-eval');
  const report = await runEvaluation({
    actor: payload.actor || 'api',
    persist: payload.persist !== false,
  });
  return {
    runId: report.runId,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
  };
});

module.exports = registry;
