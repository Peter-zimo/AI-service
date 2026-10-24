const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryQueue } = require('../server/infra/queue/memory-queue');

function waitFor(fn, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('memory queue publishes and consumes a job', async () => {
  const queue = createMemoryQueue();
  queue.consume('demo', async (payload) => ({ echo: payload.n }));

  const id = queue.publish('demo', { n: 1 });
  const job = await waitFor(() => {
    const j = queue.getJob(id);
    return j && j.status === 'completed' ? j : null;
  });

  assert.deepEqual(job.result, { echo: 1 });
  assert.equal(job.attempts, 1);
  await queue.close();
});

test('memory queue retries a failed job then succeeds', async () => {
  const queue = createMemoryQueue({ maxAttempts: 3 });
  let calls = 0;

  queue.consume('retry', async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return 'ok';
  });

  const id = queue.publish('retry', {});
  const job = await waitFor(() => {
    const j = queue.getJob(id);
    return j && j.status === 'completed' ? j : null;
  }, 8000);

  assert.equal(job.attempts, 2);
  assert.equal(job.result, 'ok');
  await queue.close();
});

test('memory queue marks a job failed after max attempts', async () => {
  const queue = createMemoryQueue({ maxAttempts: 2 });
  queue.consume('fail', async () => {
    throw new Error('always fails');
  });

  const id = queue.publish('fail', {});
  const job = await waitFor(() => {
    const j = queue.getJob(id);
    return j && j.status === 'failed' ? j : null;
  }, 8000);

  assert.equal(job.attempts, 2);
  assert.match(job.error, /always fails/);
  await queue.close();
});

test('memory queue cancels a waiting job', async () => {
  const queue = createMemoryQueue();
  const id = queue.publish('cancel-topic', {});

  const job = await queue.cancel(id);
  assert.equal(job.status, 'cancelled');
  assert.equal(queue.getJob(id).status, 'cancelled');
  assert.equal(queue.stats().cancelled, 1);

  await queue.close();
});

test('memory queue stats counts statuses', async () => {
  const queue = createMemoryQueue();
  queue.consume('stats-topic', async () => 'done');

  const id = queue.publish('stats-topic', {});
  await waitFor(() => {
    const j = queue.getJob(id);
    return j && j.status === 'completed';
  });

  const stats = queue.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.completed, 1);
  await queue.close();
});
