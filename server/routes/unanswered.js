/**
 * 未匹配查询路由（知识库反馈闭环）
 * 需要 BasicAuth 认证（管理后台用）
 */
const express = require('express');
const router = express.Router();
const unansweredService = require('../services/unanswered');

// 获取列表
router.get('/', (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const data = unansweredService.list(status, limit);
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    console.error('[未匹配查询] 获取列表失败:', error);
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

// 统计
router.get('/stats', (req, res) => {
  try {
    const stats = unansweredService.stats();
    res.json({ success: true, ...stats });
  } catch (error) {
    console.error('[未匹配查询] 统计失败:', error);
    res.status(500).json({ success: false, error: '统计失败' });
  }
});

// 补充答案（→ 自动添加到知识库）
router.post('/approve/:id', (req, res) => {
  try {
    const { answer, createdBy } = req.body || {};
    const result = unansweredService.approve(req.params.id, answer, createdBy || req.auth?.username);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json({ success: true, message: `已添加到知识库: ${result.question}`, data: result });
  } catch (error) {
    console.error('[未匹配查询] 补充答案失败:', error);
    res.status(500).json({ success: false, error: '操作失败' });
  }
});

// 忽略
router.post('/dismiss/:id', (req, res) => {
  try {
    const result = unansweredService.dismiss(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('[未匹配查询] 忽略失败:', error);
    res.status(500).json({ success: false, error: '操作失败' });
  }
});

module.exports = router;
