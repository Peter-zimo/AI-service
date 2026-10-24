const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryBackend } = require('../server/infra/state/memory-backend');
const { StreamRegistry } = require('../server/infra/state/stream-registry');
const { QueueRegistry } = require('../server/infra/state/queue-registry');
const { SocketRegistry } = require('../server/infra/state/socket-registry');

test('memory backend stores kv and expires by ttl', async () => {
  const backend = createMemoryBackend();
  await backend.kv.set('k1', { v: 1 }, 20);
  assert.deepEqual(await backend.kv.get('k1'), { v: 1 });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await backend.kv.get('k1'), undefined);
});

test('memory backend pub/sub delivers and unsubscribes', async () => {
  const backend = createMemoryBackend();
  const received = [];
  const unsub = await backend.subscribe('ch1', (m) => received.push(m));

  await backend.publish('ch1', { a: 1 });
  assert.deepEqual(received, [{ a: 1 }]);

  unsub();
  await backend.publish('ch1', { a: 2 });
  assert.deepEqual(received, [{ a: 1 }]);
});

test('stream registry emits token then end and replays buffered tokens', () => {
  const registry = new StreamRegistry(createMemoryBackend(), 'test-instance');
  registry.create('s1', 'c1');

  const events = [];
  registry.subscribe('s1', (e) => events.push(e));

  registry.writeToken('s1', '你');
  registry.writeToken('s1', '好');
  registry.end('s1', '你好', 'knowledge');

  assert.deepEqual(events.map((e) => e.type), ['token', 'token', 'end']);
  assert.deepEqual(registry.get('s1').tokens, ['你', '好']);
  assert.equal(registry.get('s1').ended, true);
  assert.equal(registry.get('s1').type, 'knowledge');
});

test('queue serializes tasks for the same conversation', async () => {
  const queue = new QueueRegistry();
  const order = [];

  queue.enqueue('c1', async () => {
    order.push('a-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a-end');
  });
  queue.enqueue('c1', async () => {
    order.push('b');
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  assert.equal(queue.pendingCount(), 0);
});

test('socket registry delivers to an open socket and removes by socket', () => {
  const registry = new SocketRegistry(createMemoryBackend(), 'test-instance');
  const sent = [];
  const ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };

  registry.registerUser('c1', ws);
  assert.equal(registry.sendToUser('c1', { type: 'x' }), true);
  assert.deepEqual(sent, [{ type: 'x' }]);

  assert.deepEqual(registry.removeBySocket(ws), { conversationId: 'c1' });
  assert.equal(registry.sendToUser('c1', { type: 'y' }), false);
});
