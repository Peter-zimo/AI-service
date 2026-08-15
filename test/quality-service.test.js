const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `quality-service-${process.pid}-${Date.now()}.db`);
const auditPath = path.join(os.tmpdir(), `quality-audit-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = dbPath;
process.env.QUALITY_AUDIT_DB_PATH = auditPath;
process.env.DISABLE_DB_BACKUP = 'true';
const db = require('../server/services/sqlite');
const quality = require('../server/services/quality');

test.after(() => {
  db.close();
  quality._db.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(auditPath, { force: true });
});

test('failed quality case creates an open Badcase with its suggested cause', () => {
  const now = new Date().toISOString();
  quality.createRun({ id: 'run-1', suiteVersion: 'v1', knowledgeHash: 'abc', startedAt: now, actor: 'cli' });
  quality.recordCase('run-1', {
    caseId: 'qv1-01', category: 'FAQ', query: '押金怎么退', expectedKind: 'knowledge',
    expectedQuestion: '押金退款多久到账？', actualQuestion: null, source: null, score: null,
    passed: false, suggestedCause: 'retrieval_threshold', error: null
  });
  const [row] = quality.listCases('run-1', { failed: true });
  assert.equal(row.badcase.status, 'open');
  assert.equal(row.badcase.cause, 'retrieval_threshold');
});

test('Badcase update rejects an unsupported lifecycle status', () => {
  assert.throws(() => quality.updateBadcase('missing', { status: 'ignored' }, 'admin'), /status/);
});

test('quality candidates expose only unanswered-query fields', () => {
  const candidates = quality.listCandidates(10);
  for (const row of candidates) {
    assert.deepEqual(Object.keys(row).sort(), ['count', 'first_seen', 'last_seen', 'query', 'status']);
  }
});
