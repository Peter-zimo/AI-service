/**
 * LangChain 客户端健康契约测试
 * 使用本地 HTTP 桩服务器，不访问真实 Python 服务。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createLangchainClient } = require('../server/services/langchain_client');

/** 启动一个返回固定 JSON 的本地桩服务器 */
function startStub(responseBody) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(responseBody));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, server });
    });
  });
}

test('health forwards the Python embedding state', async () => {
  const stub = await startStub({ status: 'ok', embedding: { ready: true, dimension: 512 } });
  try {
    const client = createLangchainClient(stub.url);
    const result = await client.health();
    assert.deepEqual(result, { status: 'ok', embedding: { ready: true, dimension: 512 } });
  } finally {
    stub.server.close();
  }
});

test('health forwards a degraded embedding state', async () => {
  const stub = await startStub({ status: 'ok', embedding: { ready: false, dimension: null, error: 'model unavailable' } });
  try {
    const client = createLangchainClient(stub.url);
    const result = await client.health();
    assert.equal(result.embedding.ready, false);
    assert.equal(result.embedding.error, 'model unavailable');
  } finally {
    stub.server.close();
  }
});

test('health reports a connection error when Python is unavailable', async () => {
  const client = createLangchainClient('http://127.0.0.1:1');
  await assert.rejects(client.health(), /LangChain 服务连接失败/);
});

test('SSE stream URL and body follow the Python /api/chat/stream contract', () => {
  const client = createLangchainClient('http://localhost:8000/');
  assert.equal(client.getStreamUrl(), 'http://localhost:8000/api/chat/stream');
  assert.equal(
    client.getStreamBody('c-1', '押金怎么退'),
    JSON.stringify({ conversation_id: 'c-1', message: '押金怎么退', use_agent: false })
  );
});
