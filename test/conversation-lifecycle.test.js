const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `conversation-lifecycle-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = dbPath;
process.env.DISABLE_DB_BACKUP = 'true';

// 会话数据访问已从 services/database 迁到 modules/chat/conversation.repo
const conversations = require('../server/modules/chat/conversation.repo');
const { CONVERSATION_STATUS } = require('../server/config/constants');
const db = require('../server/infra/db');

test.after(() => {
  // 只在模块已被加载时停定时器：直接 require 反而会触发它们启动
  for (const mod of ['../server/modules/stats', '../server/modules/chat/conversation.scheduler']) {
    if (require.cache[require.resolve(mod)]) {
      try { require(mod).stopCache ? require(mod).stopCache() : require(mod).stop(); } catch (_) { /* 忽略 */ }
    }
  }
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test('creating a new session closes the previous session for that visitor', async () => {
  await conversations.create('conv-one', 'v_1234567890_abcd', '访客');
  await conversations.create('conv-two', 'v_1234567890_abcd', '访客');

  const first = await conversations.getById('conv-one');
  const second = await conversations.getById('conv-two');

  assert.equal(first.status, CONVERSATION_STATUS.CLOSED);
  assert.equal(second.status, CONVERSATION_STATUS.ACTIVE);
});

test('idle sessions reactivate on a message and can be closed', async () => {
  await conversations.setIdle('conv-two');
  assert.equal((await conversations.getById('conv-two')).status, CONVERSATION_STATUS.IDLE);

  assert.equal(await conversations.updateLastMessage('conv-two'), true);
  assert.equal((await conversations.getById('conv-two')).status, CONVERSATION_STATUS.ACTIVE);

  assert.equal(await conversations.close('conv-two', 'test'), true);
  assert.equal((await conversations.getById('conv-two')).status, CONVERSATION_STATUS.CLOSED);
});
