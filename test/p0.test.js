/**
 * P0 测试门：超时熔断模块 + 知识库扩充自命中
 * 运行：node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { AiTimeoutError, withTimeout, CircuitBreaker } = require('../server/utils/withTimeout');
const { AiStreamClient } = require('../server/services/stream_client');

// ============ 1. 首字节超时 ============
test('withTimeout: 响应头超时触发 abort 并抛 AiTimeoutError', async () => {
  // 模拟 AI 服务无响应：挂起直到 signal abort（真实 fetch 在 abort 时 reject AbortError）
  const neverResolve = (_url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const start = Date.now();
  await assert.rejects(
    withTimeout(neverResolve, 'http://x/api/chat/stream', {}, 200),
    (e) => e instanceof AiTimeoutError && e.phase === 'headers'
  );
  assert.ok(Date.now() - start >= 190, '应在超时后返回');
});

test('withTimeout: 正常响应不受影响', async () => {
  const okFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const res = await withTimeout(okFetch, 'http://x', {}, 5000);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

// ============ 2. 熔断器 ============
test('CircuitBreaker: 连续失败达到阈值后熔断', () => {
  const cb = new CircuitBreaker({ failures: 3, windowMs: 60000 });
  assert.equal(cb.isOpen, false);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.isOpen, false, '未达阈值不熔断');
  cb.recordFailure();
  assert.equal(cb.isOpen, true, '达到阈值熔断');
});

test('CircuitBreaker: 成功重置失败计数', () => {
  const cb = new CircuitBreaker({ failures: 3, windowMs: 60000 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  assert.equal(cb.isOpen, false, '成功应重置计数');
});

test('CircuitBreaker: reset 关闭熔断', () => {
  const cb = new CircuitBreaker({ failures: 1, windowMs: 60000 });
  cb.recordFailure();
  assert.equal(cb.isOpen, true);
  cb.reset();
  assert.equal(cb.isOpen, false);
});

// ============ 3. AiStreamClient 双段超时 ============
test('openChatStream: 首字节超时抛 AiTimeoutError(headers)', async () => {
  const hangingFetch = (_url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const client = new AiStreamClient({ fetchImpl: hangingFetch, headersTimeoutMs: 200, idleTimeoutMs: 100 });
  await assert.rejects(
    client.openChatStream({ conversationId: 'c', message: 'hi' }),
    (e) => e instanceof AiTimeoutError && e.phase === 'headers'
  );
});

test('openChatStream: 流空闲超时抛 AiTimeoutError(idle)', async () => {
  // 假 fetch：响应头正常到达，但 body reader 的 read() 挂起直到 signal abort（模拟回复中途停滞）
  const stallFetch = (_url, opts) => {
    return new Promise((resolve) => {
      const reader = {
        read: () => new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
        cancel: () => {},
      };
      resolve({ ok: true, body: { getReader: () => reader } });
    });
  };
  const client = new AiStreamClient({ fetchImpl: stallFetch, headersTimeoutMs: 5000, idleTimeoutMs: 200 });
  const { reader, resetIdle, close } = await client.openChatStream({ conversationId: 'c', message: 'hi' });
  await assert.rejects(
    (async () => {
      resetIdle(); // 启动空闲计时
      while (true) {
        await client.readChunk(reader); // 挂起，200ms 后 abort → readChunk 转 AiTimeoutError(idle)
        resetIdle();
      }
    })(),
    (e) => e instanceof AiTimeoutError && e.phase === 'idle'
  );
  close();
});

test('openChatStream: 熔断开启时调用方可通过 isBreakerOpen 跳过', async () => {
  const failingFetch = async () => { throw new Error('down'); };
  const client = new AiStreamClient({ fetchImpl: failingFetch, failures: 2, windowMs: 60000 });
  for (let i = 0; i < 2; i++) {
    try { await client.openChatStream({ conversationId: 'c', message: 'hi' }); } catch (_) {}
    client.breaker.recordFailure();
  }
  assert.equal(client.isBreakerOpen, true, '连败 2 次后熔断');
});

test('checkSensitive: 超时抛 AiTimeoutError', async () => {
  const hangingFetch = (_url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const client = new AiStreamClient({ fetchImpl: hangingFetch, sensitiveTimeoutMs: 200 });
  await assert.rejects(
    client.checkSensitive('test'),
    (e) => e instanceof AiTimeoutError && e.phase === 'headers'
  );
});
