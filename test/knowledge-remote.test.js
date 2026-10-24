const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `knowledge-remote-${process.pid}-${Date.now()}.db`);
fs.copyFileSync(path.join(__dirname, '../server/data/service.db'), dbPath);

process.env.SQLITE_DB_PATH = dbPath;
process.env.DISABLE_DB_BACKUP = 'true';
process.env.KNOWLEDGE_REMOTE_FIRST = 'true';
process.env.KNOWLEDGE_REMOTE_TIMEOUT_MS = '300';
process.env.LANGCHAIN_SERVICE_URL = 'http://127.0.0.1:1'; // 故意不可达

const knowledge = require('../server/modules/knowledge');
const db = require('../server/infra/db');

test.after(() => {
  try { db.close(); } catch (_) { /* 忽略 */ }
  fs.rmSync(dbPath, { force: true });
});

test('remote retrieval reports ok=false when python is unreachable', async () => {
  const result = await knowledge.searchRemote('单车坏了怎么办');
  assert.equal(result.ok, false);
});

test('remote best-match reports ok=false when python is unreachable', async () => {
  const result = await knowledge.getBestMatchRemote('单车坏了怎么办');
  assert.equal(result.ok, false);
});

test('local fallback still returns results', async () => {
  const results = await knowledge.search('单车坏了怎么办');
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
});
