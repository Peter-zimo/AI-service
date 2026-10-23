/**
 * 健康检查路由（公开）
 *
 * 返回 Node 自身状态 + Python LangChain 服务可达性。
 * 契约被 test/security-boundaries.test.js 锁定：字段必须是 langchain / status / time。
 */

'use strict';

const express = require('express');
const { AI_TIMEOUT } = require('../config/constants');

const router = express.Router();

router.get('/', async (req, res) => {
  let langchain = { reachable: false, error: 'LangChain 服务连接失败' };

  try {
    const langchainClient = require('../services/langchain_client');
    const health = await Promise.race([
      langchainClient.health(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LangChain 服务超时')), AI_TIMEOUT.HEALTH_MS)),
    ]);
    langchain = { reachable: true, embedding: health.embedding };
  } catch (e) {
    langchain = { reachable: false, error: e.message };
  }

  res.json({ status: 'ok', time: new Date().toISOString(), langchain });
});

module.exports = router;
