/**
 * 异步任务路由
 *
 * POST /api/jobs           入队 { type, payload }
 * GET  /api/jobs           列表 ?type=&status=&limit=
 * GET  /api/jobs/stats     队列统计
 * GET  /api/jobs/:id       任务详情
 *
 * 认证与限流在 app.js 挂载时施加（仅 admin）。
 */

'use strict';

const express = require('express');
const jobs = require('../jobs');

const router = express.Router();

router.post('/', (req, res) => {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ success: false, error: '仅管理员可创建任务' });
  }

  const { type, payload } = req.body || {};
  if (!type) {
    return res.status(400).json({ success: false, error: '缺少 type' });
  }
  try {
    const jobId = jobs.enqueue(type, payload || {});
    res.json({ success: true, jobId });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.get('/stats', (req, res) => {
  res.json({ success: true, data: jobs.stats() });
});

router.get('/', (req, res) => {
  const { type, status, limit } = req.query;
  res.json({ success: true, data: jobs.listJobs({ topic: type, status, limit }) });
});

router.get('/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({ success: true, data: job });
});

module.exports = router;
