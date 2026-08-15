const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// This regression fails if the knowledge module removes its offline-only
// embedding seam, or if embedding computation needs an external service.
test('knowledge embedding is available locally without any network client', async () => {
  const sourceDb = path.join(__dirname, '..', 'server', 'data', 'service_init.db');
  const dbPath = path.join(os.tmpdir(), `knowledge-offline-${Date.now()}.db`);
  fs.copyFileSync(sourceDb, dbPath);
  process.env.SQLITE_DB_PATH = dbPath;
  process.env.DISABLE_DB_BACKUP = 'true';

  const knowledge = require('../server/services/knowledge');
  const vector = await knowledge._test.computeEmbedding('押金怎么退');

  assert.equal(vector.length, 128);
  assert.ok(vector.some(value => value > 0));
});
