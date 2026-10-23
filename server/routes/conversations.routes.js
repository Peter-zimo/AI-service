/**
 * 后台会话列表路由
 *
 * 只做：读 query → 调 chat 模块 → 返回。
 * 认证与限流在 app.js 挂载时施加。
 */

'use strict';

const express = require('express');
const chat = require('../modules/chat');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const conversations = await chat.listRecentConversations(req.query.limit);
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('获取对话列表失败:', error);
    res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

module.exports = router;
