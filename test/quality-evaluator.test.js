const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyResult, runEvaluation } = require('../scripts/run-quality-eval');

test('classifyResult distinguishes retrieval, reject, and system failures', () => {
  assert.equal(classifyResult({ expectedKind: 'knowledge', expectedQuestion: '退款政策' }, null).suggestedCause, 'retrieval_threshold');
  assert.equal(classifyResult({ expectedKind: 'knowledge', expectedQuestion: '退款政策' }, { question: '会员积分' }).suggestedCause, 'retrieval_wrong_match');
  assert.equal(classifyResult({ expectedKind: 'reject' }, { question: '退款政策' }).suggestedCause, 'reject_failure');
  assert.equal(classifyResult({ expectedKind: 'reject' }, null).passed, true);
});

test('quality evaluation uses supplied local matcher and evaluates all 30 cases', async () => {
  // 传 knowledge 桩，避免 runEvaluation 加载真实 knowledge 模块（真实库/备份）
  const stubKnowledge = {
    knowledgeBase: [],
    getBestMatch: async () => null,
  };

  const report = await runEvaluation({
    actor: 'test',
    persist: false,
    writeReports: false,
    knowledge: stubKnowledge,
    getBestMatch: async () => null,
  });
  assert.equal(report.total, 30);
  assert.equal(report.results.filter(row => row.expectedKind === 'reject').length, 8);
});
