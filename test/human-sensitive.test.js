/**
 * 人工客服（排队/分配/登录）与敏感词过滤服务测试
 * 两个模块都是单例，测试使用「临时替换 + 恢复」模式避免污染。
 */
const test = require('node:test');
const assert = require('node:assert');

const sensitive = require('../server/services/sensitive');
const human = require('../server/services/human');
const { AGENT_STATUS } = human;

// ============ 状态保存 / 恢复 ============
const origSensitiveWords = JSON.parse(JSON.stringify(sensitive.sensitiveWords || {}));

function setSensitiveWords(words) {
  sensitive.sensitiveWords = words;
  sensitive.buildWordSet();
}
function resetSensitive() {
  sensitive.sensitiveWords = JSON.parse(JSON.stringify(origSensitiveWords));
  sensitive.buildWordSet();
}

function freshHuman() {
  human.agents.clear();
  human.queue = [];
  return human;
}
function addAgent(id, overrides = {}) {
  const agent = {
    id, name: `客服${id}`, avatar: '👩', password: 'secret123',
    status: AGENT_STATUS.OFFLINE, currentConversation: null, totalServed: 0,
    ...overrides,
  };
  human.agents.set(id, agent);
  return agent;
}

// ============ 敏感词过滤 ============
test('sensitive detect hits the correct category', () => {
  setSensitiveWords({ political: ['反动'], fraud: ['诈骗'] });
  try {
    const r = sensitive.detect('这是一段反动内容');
    assert.equal(r.hasSensitive, true);
    assert.ok(r.words.includes('反动'));
    assert.ok(r.categories.includes('political'));
  } finally { resetSensitive(); }
});

test('sensitive detect finds multiple categories', () => {
  setSensitiveWords({ political: ['反动'], advertisement: ['加微信'] });
  try {
    const r = sensitive.detect('反动并加微信');
    assert.equal(r.hasSensitive, true);
    assert.equal(r.categories.length, 2);
    assert.ok(r.words.includes('反动'));
    assert.ok(r.words.includes('加微信'));
  } finally { resetSensitive(); }
});

test('sensitive detect does NOT false-positive business words', () => {
  setSensitiveWords({ advertisement: ['加微信', '转账'] });
  try {
    // 之前修复过：扫码/二维码/微信支付 是正常业务词，不能误杀
    const r = sensitive.detect('请扫码支付，二维码在订单页面');
    assert.equal(r.hasSensitive, false);
  } finally { resetSensitive(); }
});

test('sensitive detect handles empty and non-string input', () => {
  setSensitiveWords({ political: ['反动'] });
  try {
    assert.deepEqual(sensitive.detect(''), { hasSensitive: false, words: [], categories: [] });
    assert.deepEqual(sensitive.detect(null), { hasSensitive: false, words: [], categories: [] });
    assert.deepEqual(sensitive.detect(undefined), { hasSensitive: false, words: [], categories: [] });
  } finally { resetSensitive(); }
});

// ============ 人工客服：登录 ============
test('human login rejects wrong password', async () => {
  freshHuman(); addAgent('a1');
  const r = await human.login('a1', 'wrong-password');
  assert.equal(r.success, false);
  assert.match(r.error, /密码错误/);
});

test('human login accepts correct password', async () => {
  freshHuman(); addAgent('a1');
  const r = await human.login('a1', 'secret123');
  assert.equal(r.success, true);
  assert.equal(r.agent.id, 'a1');
});

test('human login rejects unknown agent', async () => {
  freshHuman();
  const r = await human.login('ghost', 'secret123');
  assert.equal(r.success, false);
  assert.match(r.error, /账号不存在/);
});

// ============ 人工客服：排队与分配 ============
test('human requestHuman fails when no agent online', () => {
  freshHuman(); addAgent('a1', { status: AGENT_STATUS.OFFLINE });
  const r = human.requestHuman('conv-1');
  assert.equal(r.success, false);
  assert.match(r.error, /无客服在线/);
});

test('human requestHuman assigns directly to an available agent', () => {
  freshHuman(); addAgent('a1', { status: AGENT_STATUS.ONLINE });
  const r = human.requestHuman('conv-1');
  assert.equal(r.success, true);
  assert.equal(r.inQueue, false);
  assert.equal(r.agent.id, 'a1');
  assert.equal(human.agents.get('a1').status, AGENT_STATUS.BUSY);
  assert.equal(human.agents.get('a1').currentConversation, 'conv-1');
});

test('human requestHuman queues in FIFO order when agents busy', () => {
  freshHuman(); addAgent('a1', { status: AGENT_STATUS.BUSY, currentConversation: 'c0' });
  const r1 = human.requestHuman('conv-1');
  const r2 = human.requestHuman('conv-2');
  assert.equal(r1.success, true); assert.equal(r1.inQueue, true); assert.equal(r1.position, 1);
  assert.equal(r2.success, true); assert.equal(r2.position, 2);
  assert.equal(human.queue[0].conversationId, 'conv-1');
  assert.equal(human.queue[1].conversationId, 'conv-2');
});

test('human requestHuman returns existing queue position', () => {
  freshHuman(); addAgent('a1', { status: AGENT_STATUS.BUSY, currentConversation: 'c0' });
  human.requestHuman('conv-1');
  const again = human.requestHuman('conv-1');
  assert.equal(again.success, true);
  assert.equal(again.inQueue, true);
  assert.equal(again.position, 1);
});

test('human goOffline returns current conversation to queue', () => {
  freshHuman(); addAgent('a1', { status: AGENT_STATUS.BUSY, currentConversation: 'conv-1' });
  const ok = human.goOffline('a1');
  assert.equal(ok, true);
  assert.equal(human.agents.get('a1').status, AGENT_STATUS.OFFLINE);
  assert.ok(human.queue.some(q => q.conversationId === 'conv-1'));
});

test('human cancelQueue removes the queued conversation', () => {
  freshHuman(); addAgent('a1', { status: AGENT_STATUS.BUSY, currentConversation: 'c0' });
  human.requestHuman('conv-1');
  assert.equal(human.cancelQueue('conv-1'), true);
  assert.equal(human.queue.length, 0);
  assert.equal(human.cancelQueue('conv-1'), false);
});

test('human processQueue assigns queued conversations to online agents', () => {
  freshHuman();
  addAgent('a1', { status: AGENT_STATUS.ONLINE });
  addAgent('a2', { status: AGENT_STATUS.ONLINE });
  human.requestHuman('conv-1'); // 直接分配 a1 → a1 busy
  human.requestHuman('conv-2'); // a2 直接分配 → a2 busy
  // 现在没有空闲客服了，两个都入队
  freshHuman();
  addAgent('a1', { status: AGENT_STATUS.BUSY, currentConversation: 'c0' });
  addAgent('a2', { status: AGENT_STATUS.BUSY, currentConversation: 'c1' });
  human.requestHuman('conv-x');
  human.requestHuman('conv-y');
  // 一个客服变空闲 → 触发 processQueue → 分配一个排队会话
  addAgent('a3', { status: AGENT_STATUS.ONLINE });
  human.processQueue();
  assert.equal(human.queue.length, 1);
  assert.equal(human.agents.get('a3').status, AGENT_STATUS.BUSY);
});
