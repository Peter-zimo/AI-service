const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `pgvector-utils-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = dbPath;
process.env.DISABLE_DB_BACKUP = 'true';

const repo = require('../server/modules/knowledge/knowledge.repo');
const db = require('../server/infra/db');

test.after(() => {
  try { db.close(); } catch (_) { /* 忽略 */ }
  fs.rmSync(dbPath, { force: true });
});

test('toPgVector pads short vectors to 1024 and preserves values', () => {
  const literal = repo.toPgVector([1, 0.5, -1]);
  const arr = JSON.parse(literal);

  assert.equal(arr.length, 1024);
  assert.deepEqual(arr.slice(0, 3), [1, 0.5, -1]);
  assert.equal(arr[1023], 0);
});

test('toPgVector returns null for empty input', () => {
  assert.equal(repo.toPgVector([]), null);
  assert.equal(repo.toPgVector(null), null);
});

test('searchByVector returns null on sqlite so callers fall back to JS cosine', async () => {
  assert.equal(await repo.searchByVector([1, 2, 3], 5), null);
});
