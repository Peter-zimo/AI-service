const test = require('node:test');
const assert = require('node:assert/strict');
const { expandKnowledge } = require('../server/services/langchain_client');

test('knowledge expansion uses the internal client request path', async () => {
  let received;
  const result = await expandKnowledge('如何退款？', '请在订单页提交申请。', async (...args) => {
    received = args;
    return { success: true, data: { keywords: ['退款'] } };
  });

  assert.deepEqual(received, [
    'POST',
    '/api/kb/expand',
    { question: '如何退款？', answer: '请在订单页提交申请。' }
  ]);
  assert.deepEqual(result, { success: true, data: { keywords: ['退款'] } });
});
