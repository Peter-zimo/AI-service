const express = require('express');
const { toCsv } = require('../utils/csv');
const quality = require('../services/quality');

const router = express.Router();

function limit(value) {
  const parsed = Number.parseInt(value, 10);
  if (value !== undefined && (!Number.isInteger(parsed) || parsed < 1 || parsed > 500)) return null;
  return parsed || 100;
}

router.get('/runs', (req, res) => {
  const value = limit(req.query.limit);
  if (!value) return res.status(400).json({ success: false, error: 'limit must be between 1 and 500' });
  res.json({ success: true, data: quality.listRuns(value) });
});

router.get('/runs/:id/cases', (req, res) => {
  const value = limit(req.query.limit);
  if (!value) return res.status(400).json({ success: false, error: 'limit must be between 1 and 500' });
  const { failed, cause, status } = req.query;
  if (failed !== undefined && !['true', 'false'].includes(failed)) return res.status(400).json({ success: false, error: 'invalid failed filter' });
  if (cause !== undefined && !quality.CAUSES.has(cause)) return res.status(400).json({ success: false, error: 'invalid cause filter' });
  if (status !== undefined && !quality.STATUSES.has(status)) return res.status(400).json({ success: false, error: 'invalid status filter' });
  res.json({ success: true, data: quality.listCases(req.params.id, { failed, cause, status, limit: value }) });
});

router.patch('/badcases/:id', (req, res) => {
  const body = req.body || {};
  if (body.cause !== undefined && !quality.CAUSES.has(body.cause)) return res.status(400).json({ success: false, error: 'invalid cause' });
  if (body.status !== undefined && !quality.STATUSES.has(body.status)) return res.status(400).json({ success: false, error: 'invalid status' });
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000)) return res.status(400).json({ success: false, error: 'invalid note' });
  const updated = quality.updateBadcase(req.params.id, body, req.auth.username);
  if (!updated) return res.status(404).json({ success: false, error: 'Badcase not found' });
  res.json({ success: true, data: updated });
});

router.get('/runs/:id/export', (req, res) => {
  const rows = quality.listCases(req.params.id, { failed: true, limit: 500 }).map(row => ({
    caseId: row.case_id, category: row.category, query: row.query, expectedKind: row.expected_kind,
    expectedQuestion: row.expected_question, actualQuestion: row.actual_question, source: row.source,
    score: row.score, cause: row.badcase?.cause, status: row.badcase?.status, note: row.badcase?.note
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=quality-badcases-${req.params.id}.csv`);
  res.send('\uFEFF' + toCsv(rows));
});

router.get('/candidates', (req, res) => {
  const value = limit(req.query.limit);
  if (!value) return res.status(400).json({ success: false, error: 'limit must be between 1 and 500' });
  res.json({ success: true, data: quality.listCandidates(value) });
});

module.exports = router;
