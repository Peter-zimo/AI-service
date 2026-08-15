const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `conversation-lifecycle-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = dbPath;
process.env.DISABLE_DB_BACKUP = 'true';

const db = require('../server/services/database');

test.after(() => {
  db.stopCacheRefresh();
  db._db.close();
  fs.rmSync(dbPath, { force: true });
});

test('creating a new session closes the previous session for that visitor', async () => {
  await db.conversations.create('conv-one', 'v_1234567890_abcd', '访客');
  await db.conversations.create('conv-two', 'v_1234567890_abcd', '访客');
  const first = await db.conversations.getById('conv-one');
  const second = await db.conversations.getById('conv-two');
  assert.equal(first.status, db.conversations.STATUS.CLOSED);
  assert.equal(second.status, db.conversations.STATUS.ACTIVE);
});

test('idle sessions reactivate on a message and can be closed', async () => {
  await db.conversations.setIdle('conv-two');
  assert.equal((await db.conversations.getById('conv-two')).status, db.conversations.STATUS.IDLE);
  assert.equal(await db.conversations.updateLastMessage('conv-two'), true);
  assert.equal((await db.conversations.getById('conv-two')).status, db.conversations.STATUS.ACTIVE);
  assert.equal(await db.conversations.close('conv-two', 'test'), true);
  assert.equal((await db.conversations.getById('conv-two')).status, db.conversations.STATUS.CLOSED);
});
