/**
 * E2E 冒烟测试（独立服务 + 临时 DB，不碰真实数据）
 *
 * 覆盖：
 *   1. 从统计面板返回后仍保持登录
 *   2. 任务中心空状态不出现无限转圈
 *   3. 知识库导入走异步任务（含同一会话第二次导入），并出现在任务中心
 *   4. 知识库检索 API（Python 不可达时走 Node 降级）
 *   5. 访客页可正常加载
 *
 * 运行：npm run test:e2e
 * 依赖：系统 Chrome/Edge（可用 E2E_CHROME 覆盖路径）
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT || 3457);
const BASE = `http://127.0.0.1:${PORT}`;

const CHROME_CANDIDATES = [
  process.env.E2E_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

const Database = require('better-sqlite3');
const { chromium } = require('playwright');

let server;
let browser;
let tempDir;
let token;
let serverLogs = '';

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (e) => reject(new Error(`E2E 端口 ${port} 被占用: ${e.message}`)));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

function waitForHealth(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (server && server.exitCode !== null) {
        return reject(new Error(`E2E 服务已退出 (code ${server.exitCode})\n${serverLogs.slice(-2000)}`));
      }

      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`E2E 服务未就绪\n${serverLogs.slice(-2000)}`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function makeAdminToken() {
  const auth = require(path.join(PROJECT, 'server/middleware/auth'));
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'server/config/auth.json'), 'utf-8'));
  const admin = cfg.users.find((u) => u.username === 'admin');
  return auth.sign(
    { sub: 'admin', role: 'admin', tokenVersion: admin.tokenVersion || 0 },
    auth.getJwtSecret(),
    3600
  );
}

async function newAdminPage() {
  const page = await browser.newPage();
  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ authHeader }) => {
    localStorage.setItem('authHeader', authHeader);
    // 模拟真实旧状态：只有 token、没有 currentUser
    localStorage.removeItem('currentUser');
    localStorage.removeItem('refreshToken');
  }, { authHeader: 'Bearer ' + token });

  const statsResponse = page.waitForResponse(
    (r) => r.url().includes('/api/stats/overview') && r.status() === 200,
    { timeout: 20000 }
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await statsResponse;

  await page.waitForFunction(
    () => localStorage.getItem('currentUser') === 'admin',
    { timeout: 20000 }
  );
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('login-modal')).display === 'none',
    { timeout: 20000 }
  );
  return page;
}

async function runImport(page, question, answer, csvPath) {
  await page.click('button[onclick="openImportModal()"]');
  await page.waitForSelector('#import-modal:not(.hidden)');

  fs.writeFileSync(csvPath, `问题,答案\n${question},${answer}\n`, 'utf-8');
  await page.setInputFiles('#import-file-input', csvPath);
  await page.waitForSelector('#import-step2', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => !document.getElementById('import-btn-confirm').disabled,
    { timeout: 15000 }
  );

  await page.click('#import-btn-confirm');
  await page.waitForSelector('#import-step3', { state: 'visible', timeout: 30000 });
  const result = await page.textContent('#import-result-detail');

  // 完成后按钮语义是“关闭弹窗”
  await page.click('#import-btn-confirm');
  await page.waitForFunction(
    () => document.getElementById('import-modal').classList.contains('hidden'),
    { timeout: 5000 }
  );

  return result;
}

function countKnowledge(question) {
  const db = new Database(path.join(tempDir, 'service.db'), { readonly: true, fileMustExist: true });
  const count = db.prepare('SELECT COUNT(*) AS c FROM knowledge WHERE question = ?').get(question).c;
  db.close();
  return count;
}

test.before(async () => {
  if (!CHROME) {
    throw new Error('未找到 Chrome/Edge，请设置 E2E_CHROME 指向浏览器可执行文件');
  }
  await assertPortFree(PORT);

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));

  // 用 SQLite 在线备份做一致性副本（避免 WAL 下直接 copy 文件丢数据）
  const source = new Database(
    path.join(PROJECT, 'server/data/service.db'),
    { readonly: true, fileMustExist: true }
  );
  await source.backup(path.join(tempDir, 'service.db'));
  source.close();

  fs.copyFileSync(
    path.join(PROJECT, 'server/data/agents.json'),
    path.join(tempDir, 'agents.json')
  );

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: PROJECT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ALLOWED_ORIGINS: `http://127.0.0.1:${PORT},http://localhost:${PORT}`,
      SQLITE_DB_PATH: path.join(tempDir, 'service.db'),
      AGENTS_DATA_PATH: path.join(tempDir, 'agents.json'),
      QUALITY_AUDIT_DB_PATH: path.join(tempDir, 'quality.db'),
      BACKUP_DIR: path.join(tempDir, 'backups'),
      LOG_DIR: path.join(tempDir, 'logs'),
      UPLOAD_DIR: path.join(tempDir, 'uploads'),
      REDIS_URL: '',
      DISABLE_DB_BACKUP: 'true',
      INLINE_WORKERS: 'true',
      LANGCHAIN_SERVICE_URL: 'http://127.0.0.1:1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLogs += d; });
  server.stderr.on('data', (d) => { serverLogs += d; });

  await waitForHealth();

  token = makeAdminToken();
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
});

test.after(async () => {
  if (browser) await browser.close().catch(() => {});

  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    server.kill('SIGTERM');
    await exited;
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  try {
    // 真实库必须没有被 E2E 污染
    const real = new Database(
      path.join(PROJECT, 'server/data/service.db'),
      { readonly: true, fileMustExist: true }
    );
    const e2eRows = real
      .prepare("SELECT COUNT(*) AS c FROM knowledge WHERE question LIKE 'E2E导入测试%'")
      .get().c;
    real.close();
    assert.equal(e2eRows, 0, '真实库被 E2E 污染');
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('admin stays logged in after visiting stats and going back', async () => {
  const page = await newAdminPage();
  const unauthorized = [];
  page.on('response', (res) => {
    if (res.status() === 401) unauthorized.push(res.url());
  });

  await page.click('#nav-stats-link');
  await page.waitForURL('**/stats.html', { timeout: 20000 });
  await page.waitForSelector('#refresh-time', { timeout: 15000 });

  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tab-dashboard.active', { timeout: 20000 });
  await page.waitForFunction(
    () => localStorage.getItem('currentUser') === 'admin',
    { timeout: 20000 }
  );

  const state = await page.evaluate(() => ({
    hasAuth: !!localStorage.getItem('authHeader'),
    user: localStorage.getItem('currentUser'),
    login: getComputedStyle(document.getElementById('login-modal')).display,
  }));

  assert.equal(state.hasAuth, true);
  assert.equal(state.user, 'admin');
  assert.equal(state.login, 'none');
  assert.deepEqual(unauthorized, []);

  await page.close();
});

test('job center empty state does not show an infinite spinner', async () => {
  const page = await newAdminPage();
  await page.click('#nav-jobs');
  await page.waitForSelector('#tab-jobs.active');
  await page.waitForFunction(
    () => document.getElementById('jobs-tbody')?.textContent.includes('暂无任务'),
    { timeout: 15000 }
  );

  const state = await page.evaluate(() => {
    const tbody = document.getElementById('jobs-tbody');
    const cell = tbody.querySelector('td');
    return {
      text: tbody.textContent,
      loadingClass: cell ? cell.classList.contains('loading') : null,
    };
  });

  assert.match(state.text, /暂无任务/);
  assert.equal(state.loadingClass, false);

  await page.close();
});

test('knowledge import runs as a job and appears in the job center', async () => {
  const page = await newAdminPage();
  await page.click('#nav-knowledge');
  await page.waitForSelector('#tab-knowledge.active');

  const stamp = Date.now();
  const unique1 = `E2E导入测试-${stamp}-1`;
  const unique2 = `E2E导入测试-${stamp}-2`;
  const csvPath = path.join(tempDir, 'e2e-import.csv');

  const first = await runImport(page, unique1, '第一次导入答案', csvPath);
  assert.match(first, /成功导入/);
  assert.equal(countKnowledge(unique1), 1);

  // 同一会话第二次导入：覆盖“成功后 onclick 被改成关闭、再次导入失效”的 bug
  const second = await runImport(page, unique2, '第二次导入答案', csvPath);
  assert.match(second, /成功导入/);
  assert.equal(countKnowledge(unique2), 1);

  await page.click('#nav-jobs');
  await page.waitForSelector('#tab-jobs.active');
  await page.waitForFunction(
    () => document.getElementById('jobs-tbody')?.textContent.includes('knowledge.import'),
    { timeout: 20000 }
  );

  await page.click('#jobs-tbody button:has-text("详情")');
  await page.waitForSelector('#job-detail-modal:not(.hidden)', { timeout: 5000 });
  const detail = await page.textContent('#job-detail-content');
  assert.match(detail, /knowledge\.import/);
  assert.match(detail, /E2E导入测试/);

  await page.close();
});

test('knowledge search API returns results via node fallback', async () => {
  const res = await fetch(BASE + '/api/knowledge/search/query?q=' + encodeURIComponent('单车坏了怎么办'), {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.results) && data.results.length > 0);
  assert.equal(data.source, 'node-fallback');
});

test('visitor page loads with chat input', async () => {
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#msg-input', { timeout: 15000 });
  assert.equal(await page.isVisible('#msg-input'), true);
  await page.close();
});
