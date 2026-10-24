/**
 * 异步任务路由
 *
 * POST /api/jobs              入队 { type, payload }（admin）
 * GET  /api/jobs              列表 ?type=&status=&limit=
 * GET  /api/jobs/stats        队列统计
 * GET  /api/jobs/:id          任务详情
 * POST /api/jobs/:id/retry    失败任务重新入队（admin）
 * POST /api/jobs/:id/cancel   取消等待中的任务（admin）
 */

'use strict';

const express = require('express');
const jobs = require('../jobs');

const router = express.Router();

function requireAdmin(req, res) {
  if (!req.auth || req.auth.role !== 'admin') {
    res.status(403).json({ success: false, error: '仅管理员可执行此操作' });
    return false;
  }
  return true;
}

router.post('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { type, payload } = req.body || {};
  if (!type) {
    return res.status(400).json({ success: false, error: '缺少 type' });
  }

  try {
    const jobId = await jobs.enqueue(type, payload || {});
    res.json({ success: true, jobId });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.get('/stats', async (req, res) => {
  res.json({ success: true, data: await jobs.stats() });
});

router.get('/', async (req, res) => {
  const { type, status, limit } = req.query;
  res.json({ success: true, data: await jobs.listJobs({ topic: type, status, limit }) });
});

router.post('/:id/retry', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = await jobs.retry(req.params.id);
    res.json({ success: true, jobId });
  } catch (e) {
    const code = e.message === '任务不存在' ? 404 : 409;
    res.status(code).json({ success: false, error: e.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const job = await jobs.cancel(req.params.id);
    res.json({ success: true, data: job });
  } catch (e) {
    const code = e.message === '任务不存在' ? 404 : 409;
    res.status(code).json({ success: false, error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const job = await jobs.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({ success: true, data: job });
});

module.exports = router;
