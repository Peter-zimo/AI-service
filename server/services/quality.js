const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const auditPath = process.env.QUALITY_AUDIT_DB_PATH || path.join(__dirname, '../data/quality.db');
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const db = new Database(auditPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS quality_runs (id TEXT PRIMARY KEY, suite_version TEXT NOT NULL, knowledge_hash TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, total INTEGER DEFAULT 0, passed INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, reject_passed INTEGER DEFAULT 0, actor TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS quality_cases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_id TEXT NOT NULL, category TEXT NOT NULL, query TEXT NOT NULL, expected_kind TEXT NOT NULL, expected_question TEXT, actual_question TEXT, source TEXT, score REAL, passed INTEGER NOT NULL, suggested_cause TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS quality_badcases (id TEXT PRIMARY KEY, case_row_id TEXT NOT NULL UNIQUE, cause TEXT NOT NULL, cause_source TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'open', note TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_quality_cases_run ON quality_cases(run_id);
  CREATE INDEX IF NOT EXISTS idx_quality_cases_passed ON quality_cases(passed);
  CREATE INDEX IF NOT EXISTS idx_quality_badcases_status ON quality_badcases(status);
  CREATE INDEX IF NOT EXISTS idx_quality_badcases_cause ON quality_badcases(cause);
`);

const CAUSES = new Set(['retrieval_threshold', 'retrieval_wrong_match', 'reject_failure', 'system_error', 'knowledge_gap', 'answer_inconsistent']);
const STATUSES = new Set(['open', 'triaged', 'fixed', 'verified', 'closed']);
const MAX_LIMIT = 500;

function clampLimit(value) {
  return Math.min(Math.max(Number.parseInt(value, 10) || 100, 1), MAX_LIMIT);
}

function createRun({ id = uuidv4(), suiteVersion, knowledgeHash, startedAt, actor }) {
  db.prepare(`INSERT INTO quality_runs (id, suite_version, knowledge_hash, started_at, actor)
    VALUES (?, ?, ?, ?, ?)`).run(id, suiteVersion, knowledgeHash, startedAt, actor);
  return { id, suiteVersion, knowledgeHash, startedAt, actor };
}

function recordCase(runId, result) {
  const id = uuidv4();
  db.prepare(`INSERT INTO quality_cases
    (id, run_id, case_id, category, query, expected_kind, expected_question, actual_question, source, score, passed, suggested_cause, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, runId, result.caseId, result.category, result.query, result.expectedKind,
      result.expectedQuestion || null, result.actualQuestion || null, result.source || null,
      result.score ?? null, result.passed ? 1 : 0, result.suggestedCause || null, result.error || null);
  if (!result.passed) {
    const cause = CAUSES.has(result.suggestedCause) ? result.suggestedCause : 'system_error';
    db.prepare(`INSERT INTO quality_badcases (id, case_row_id, cause, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), id, cause, new Date().toISOString(), 'system');
  }
  return { id };
}

function finishRun(runId, summary) {
  db.prepare(`UPDATE quality_runs SET finished_at = ?, total = ?, passed = ?, failed = ?, reject_passed = ? WHERE id = ?`)
    .run(summary.finishedAt, summary.total, summary.passed, summary.failed, summary.rejectPassed, runId);
}

function listRuns(limit = 50) {
  return db.prepare('SELECT * FROM quality_runs ORDER BY started_at DESC LIMIT ?').all(clampLimit(limit));
}

function listCases(runId, filters = {}) {
  const clauses = ['c.run_id = ?'];
  const params = [runId];
  if (filters.failed === true || filters.failed === 'true') clauses.push('c.passed = 0');
  if (CAUSES.has(filters.cause)) { clauses.push('b.cause = ?'); params.push(filters.cause); }
  if (STATUSES.has(filters.status)) { clauses.push('b.status = ?'); params.push(filters.status); }
  params.push(clampLimit(filters.limit));
  const rows = db.prepare(`SELECT c.*, b.id AS badcase_id, b.cause AS badcase_cause, b.cause_source,
    b.status AS badcase_status, b.note AS badcase_note, b.updated_at AS badcase_updated_at, b.updated_by AS badcase_updated_by
    FROM quality_cases c LEFT JOIN quality_badcases b ON b.case_row_id = c.id
    WHERE ${clauses.join(' AND ')} ORDER BY c.case_id LIMIT ?`).all(...params);
  return rows.map(row => ({ ...row, passed: Boolean(row.passed), badcase: row.badcase_id ? {
    id: row.badcase_id, cause: row.badcase_cause, causeSource: row.cause_source, status: row.badcase_status,
    note: row.badcase_note, updatedAt: row.badcase_updated_at, updatedBy: row.badcase_updated_by
  } : null }));
}

function updateBadcase(id, patch, actor) {
  if (patch.cause !== undefined && !CAUSES.has(patch.cause)) throw new Error('invalid cause');
  if (patch.status !== undefined && !STATUSES.has(patch.status)) throw new Error('invalid status');
  const existing = db.prepare('SELECT * FROM quality_badcases WHERE id = ?').get(id);
  if (!existing) return null;
  const note = patch.note === undefined ? existing.note : String(patch.note).trim().slice(0, 1000);
  const cause = patch.cause === undefined ? existing.cause : patch.cause;
  const status = patch.status === undefined ? existing.status : patch.status;
  db.prepare(`UPDATE quality_badcases SET cause = ?, cause_source = 'manual', status = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
    .run(cause, status, note || null, new Date().toISOString(), actor, id);
  return db.prepare('SELECT * FROM quality_badcases WHERE id = ?').get(id);
}

function listCandidates(limit = 100) {
  const sourcePath = process.env.SQLITE_DB_PATH || path.join(__dirname, '../data/service.db');
  const source = new Database(sourcePath, { readonly: true });
  try {
    return source.prepare(`SELECT query, count, first_seen, last_seen, status FROM unanswered_queries
      ORDER BY count DESC, last_seen DESC LIMIT ?`).all(clampLimit(limit));
  } finally {
    source.close();
  }
}

module.exports = { CAUSES, STATUSES, createRun, recordCase, finishRun, listRuns, listCases, updateBadcase, listCandidates, _db: db };
