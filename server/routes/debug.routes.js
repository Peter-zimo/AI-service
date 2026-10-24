/**
 * 调试路由（仅非生产环境可用）
 *
 * 生产环境统一返回 404，避免暴露内部结构与检索细节。
 * 认证在 app.js 挂载时施加（jwtAuth）。
 */

'use strict';

const express = require('express');

const router = express.Router();

router.get('/dir', async (req, res) => {
  res.json({
    __dirname: __dirname,
    cwd: process.cwd(),
    file: __filename,
  });
});

router.get('/knowledge', async (req, res) => {
  const knowledgeService = require('../modules/knowledge');
  const testQuery = req.query.q || '工作时间';
  const remote = await knowledgeService.searchRemote(testQuery);
  const results = remote.ok ? remote.results : await knowledgeService.search(testQuery);

  res.json({
    totalItems: knowledgeService.knowledgeBase.length,
    testQuery,
    searchSource: remote.ok ? 'python' : 'node-fallback',
    searchResults: results.map(r => ({
      question: r.question,
      score: r.score,
      source: r.source || 'legacy',
    })),
  });
});

router.get('/ai-test', async (req, res) => {
  const aiService = require('../modules/ai');
  const testQuery = req.query.q || '如何扫码开锁';

  try {
    const result = await aiService.chat('test-conv', testQuery);
    res.json({
      query: testQuery,
      result: {
        type: result.type,
        answer: result.answer,
        confidence: result.confidence,
        matchQuestion: result.matchQuestion,
      },
    });
  } catch (error) {
    res.json({ query: testQuery, error: error.message });
  }
});

module.exports = router;
