const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function getFreePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('production protects observability endpoints and rejects origins without an allowlist', async (t) => {
  const port = await getFreePort();
  const dbPath = path.join(os.tmpdir(), `security-boundaries-${process.pid}-${Date.now()}.db`);
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: '',
      SQLITE_DB_PATH: dbPath,
      DISABLE_DB_BACKUP: 'true',
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    if (!server.killed) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
    fs.rmSync(dbPath, { force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      health = await fetch(`${baseUrl}/api/health`);
      break;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.ok(health, 'server should start on its isolated port');
  assert.equal(health.status, 200);
  // 健康契约：Node 自身状态 + LangChain 服务状态（reachable/embedding）
  const healthBody = await health.json();
  assert.deepEqual(Object.keys(healthBody).sort(), ['langchain', 'status', 'time']);
  assert.equal(typeof healthBody.langchain.reachable, 'boolean');

  const metrics = await fetch(`${baseUrl}/api/metrics`);
  assert.equal(metrics.status, 401);

  const crossOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(crossOrigin.status, 403);
});
