/**
 * 知识库检索测试（P0 扩充 + P1 回归）
 * - 隔离：拷贝生产库到临时目录，不污染线上数据
 * - 前置：AI 服务(localhost:8000)运行（Node 查询向量走 /api/embed BGE 512）；
 *   未运行时跳过语义相关用例（本地/CI 无 AI 服务时降级提示）
 * 运行：npm test
 */
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 清理代理环境变量（本机 WorkBuddy 注入的 HTTP_PROXY=127.0.0.1:1088 未开启，
// Node fetch 读它会连不上本机 AI 服务 → 误判服务不可用）
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const PROD_DB = path.join(__dirname, '..', 'server', 'data', 'service.db');
const tmpDb = path.join(os.tmpdir(), `kb-test-${Date.now()}.db`);

let kb;
before(async () => {
  // 1. 拷贝临时库（隔离生产数据）
  fs.copyFileSync(PROD_DB, tmpDb);
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sync-knowledge.js')], {
    env: { ...process.env, SQLITE_DB_PATH: tmpDb },
    stdio: 'pipe',
  });
  process.env.SQLITE_DB_PATH = tmpDb;
  process.env.DISABLE_DB_BACKUP = 'true';
  // 2. 加载知识库（必须在设 env 之后 require）
  kb = require('../server/services/knowledge');
  await kb._ready;
});

const UNRELATED = ['今天股市怎么样', '你们老板叫什么', '你吃饭了吗', '推荐一部电影', '北京天气怎么样'];

// ============ P0：扩充后全量自命中 ============
test('知识库扩充：全部条目 question 自命中（>=50 条）', async () => {
  assert.ok(kb.knowledgeBase.length >= 50, `知识库应 >=50 条，实际 ${kb.knowledgeBase.length}`);
  let hit = 0;
  const miss = [];
  for (const item of kb.knowledgeBase) {
    const r = await kb.getBestMatch(item.question);
    if (r && r.question === item.question) hit++;
    else miss.push(item.question);
  }
  assert.equal(hit, kb.knowledgeBase.length, `自命中应全中，未命中: ${miss.slice(0, 6).join('; ')}`);
});

test('知识库扩充：无关问题拒绝（答非所问防护）', async () => {
  for (const q of UNRELATED) {
    const r = await kb.getBestMatch(q);
    assert.equal(r, null, `无关问题应拒绝: ${q}（实际命中 ${r && r.question}）`);
  }
});

// ============ P1：演示关键问题命中 ============
test('演示剧本关键问题命中', async () => {
  const cases = {
    '会员怎么开通': '骑行会员如何开通？',
    '怎么联系人工客服': '怎么联系人工客服？',
    '车辆没电了怎么办': '车辆没电了怎么办？',
    '押金多久到账': '押金退款多久到账？',
    '可以带人吗': '可以带人骑行吗？',
  };
  for (const [q, expectQ] of Object.entries(cases)) {
    const r = await kb.getBestMatch(q);
    assert.ok(r, `演示问题应命中: ${q}`);
    assert.equal(r.question, expectQ, `${q} 应命中「${expectQ}」实际「${r.question}」`);
  }
});

// ============ 阈值回归（不依赖 AI 服务） ============
test('检索阈值回归：legacy 弱命中拒绝', async () => {
  // "你吃饭了吗" 不应命中（legacy/FTS 弱匹配被阈值挡下）
  const r = await kb.getBestMatch('你吃饭了吗');
  // 若 AI 服务未运行走 local 128，阈值 0.5 也应拒绝
  assert.equal(r, null, '无关问题「你吃饭了吗」应被拒绝');
});

test('知识库数据完整性：keywords 均为合法 JSON', () => {
  for (const item of kb.knowledgeBase) {
    assert.ok(Array.isArray(item.keywords), `keywords 应为数组: ${item.question}`);
  }
});
