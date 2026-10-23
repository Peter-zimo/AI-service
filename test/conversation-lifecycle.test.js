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
  // 快照缓存与会话超时检查都带定时器，停掉避免进程挂住
  try { require('../server/modules/stats').stopCache(); } catch (_) { /* 未加载则忽略 */ }
  try { require('../server/modules/chat/conversation.scheduler').stop(); } catch (_) { /* 未加载则忽略 */ }
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
