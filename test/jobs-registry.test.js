const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../server/jobs/registry');

async function waitFor(fn, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      const value = await fn();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('jobs registry retries a failed job', async () => {
  let calls = 0;

  registry.register('test.retry', async () => {
    calls += 1;
    if (calls <= 3) throw new Error('fail');
    return 'ok';
  });

  registry.startWorkers();

  const firstId = await registry.enqueue('test.retry', {});
  const failed = await waitFor(async () => {
    const job = await registry.getJob(firstId);
    return job && job.status === 'failed' ? job : null;
  });
  assert.equal(failed.attempts, 3);

  const secondId = await registry.retry(firstId);
  assert.notEqual(secondId, firstId);

  const completed = await waitFor(async () => {
    const job = await registry.getJob(secondId);
    return job && job.status === 'completed' ? job : null;
  });
  assert.equal(completed.result, 'ok');

  registry.stopWorkers();
});
